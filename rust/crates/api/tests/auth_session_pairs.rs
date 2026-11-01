#![cfg(unix)]

//! HTTP-level protocol test for session-bound credential pairs and the
//! no-forced-sign-out migration of legacy credentials.

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use terminal_v4_api::{app, ApiState};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;

const PASSWORD: &str = "integration-password";

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:3020")
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
    )
}

fn setup(cutover: bool) -> (tempfile::TempDir, ApiState, Router) {
    let data = tempfile::tempdir().unwrap();
    let state = ApiState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "auth-session-pairs-integration".into(),
        ..Default::default()
    })
    .unwrap();
    let db = Connection::open(data.path().join("terminal.db")).unwrap();
    db.execute(
        "INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
        params![
            "pairs-owner",
            "pairs",
            bcrypt::hash(PASSWORD, 4).unwrap(),
            "2026-01-01T00:00:00Z"
        ],
    )
    .unwrap();
    drop(db);
    state.set_auth_session_cutover(cutover);
    let router = app(state.clone());
    (data, state, router)
}

async fn login(router: &Router, binding: bool) -> Value {
    let (status, body) = call(
        router,
        "POST",
        "/api/auth/login",
        None,
        json!({"username":"pairs","password":PASSWORD,"pairBinding":binding}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body
}

async fn me(router: &Router, pair: &Value) -> StatusCode {
    call(
        router,
        "GET",
        "/api/auth/me",
        pair["tokens"]["accessToken"].as_str(),
        json!({}),
    )
    .await
    .0
}

fn refresh_body(pair: &Value, include_access: bool, binding: bool) -> Value {
    let mut body = json!({"refreshToken": pair["tokens"]["refreshToken"], "pairBinding": binding});
    if include_access {
        body["accessToken"] = pair["tokens"]["accessToken"].clone();
    }
    body
}

#[tokio::test]
async fn session_pair_protocol_over_http() {
    let (_data, _state, router) = setup(true);

    let legacy_tab = login(&router, false).await;
    assert!(legacy_tab.get("session").is_none());
    assert_eq!(me(&router, &legacy_tab).await, StatusCode::OK);

    let first = login(&router, true).await;
    assert_eq!(first["session"]["pairSeq"], 1);
    assert_eq!(first["session"]["pairBinding"], true);
    assert_eq!(me(&router, &first).await, StatusCode::OK);

    // The cutover stops legacy access tokens, but the legacy refresh token still migrates.
    assert_eq!(me(&router, &legacy_tab).await, StatusCode::UNAUTHORIZED);
    let (status, migrated) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&legacy_tab, false, false),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(migrated["session"]["pairSeq"], 1);
    assert_eq!(me(&router, &migrated).await, StatusCode::OK);
    let (status, replay) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&legacy_tab, false, false),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(replay["code"], "refresh_token_spent");

    // A bound session refuses a refresh without, or with a foreign, access token.
    let (status, body) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&first, false, false),
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::PRECONDITION_REQUIRED, Some("pair_required"))
    );
    let mut mixed = refresh_body(&first, true, false);
    mixed["accessToken"] = migrated["tokens"]["accessToken"].clone();
    let (status, body) = call(&router, "POST", "/api/auth/refresh", None, mixed).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("pair_mismatch"))
    );

    // The correct pair rotates; the old refresh token is spent.
    let (status, second) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&first, true, false),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["session"]["pairSeq"], 2);
    let (status, body) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&first, true, false),
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("refresh_token_spent"))
    );

    // Logout revokes the whole current pair; a refresh racing behind it publishes nothing.
    let (status, _) = call(
        &router,
        "POST",
        "/api/auth/logout",
        second["tokens"]["accessToken"].as_str(),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me(&router, &second).await, StatusCode::UNAUTHORIZED);
    let (status, body) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&second, true, false),
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("invalid_refresh_token"))
    );
    // Other sessions are unaffected by that session's logout.
    assert_eq!(me(&router, &migrated).await, StatusCode::OK);
}

#[tokio::test]
async fn without_cutover_nothing_changes_for_legacy_clients() {
    let (_data, _state, router) = setup(false);
    let tab = login(&router, true).await;
    assert!(tab.get("session").is_none());
    let (status, refreshed) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&tab, true, true),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(refreshed.get("session").is_none());
    assert_eq!(me(&router, &refreshed).await, StatusCode::OK);
}

#[tokio::test]
async fn disabling_cutover_after_activation_makes_the_forced_relogin_explicit() {
    let (_data, state, router) = setup(true);
    let bound = login(&router, true).await;
    state.set_auth_session_cutover(false);
    let (status, body) = call(
        &router,
        "POST",
        "/api/auth/login",
        None,
        json!({"username":"pairs","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
    assert!(body["error"].as_str().unwrap().contains("upgraded client"));
    // Existing sessions keep refreshing while cutover is disabled.
    let (status, _) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&bound, true, false),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

async fn pairing_code(router: &Router, pair: &Value) -> String {
    let (status, body) = call(
        router,
        "POST",
        "/api/environments/pairing-code",
        pair["tokens"]["accessToken"].as_str(),
        json!({"label":"fixture-client"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["code"].as_str().unwrap().to_owned()
}

async fn exchange(router: &Router, code: &str) -> (StatusCode, Value) {
    call(
        router,
        "POST",
        "/api/environments/exchange",
        None,
        json!({ "code": code }),
    )
    .await
}

async fn grant_is_valid(router: &Router, credential: &str) -> bool {
    call(
        router,
        "GET",
        "/api/environments/check",
        Some(credential),
        json!({}),
    )
    .await
    .0 == StatusCode::OK
}

#[tokio::test]
async fn paired_grants_and_codes_end_with_the_session_that_issued_them() {
    let (_data, _state, router) = setup(true);
    let session = login(&router, true).await;
    let other = login(&router, true).await;

    let exchanged_code = pairing_code(&router, &session).await;
    let (status, grant) = exchange(&router, &exchanged_code).await;
    assert_eq!(status, StatusCode::OK, "{grant}");
    let credential = grant["credential"].as_str().unwrap().to_owned();
    assert!(grant_is_valid(&router, &credential).await);
    let unused_code = pairing_code(&router, &session).await;
    let other_code = pairing_code(&router, &other).await;
    let (_, other_grant) = exchange(&router, &other_code).await;
    let other_credential = other_grant["credential"].as_str().unwrap().to_owned();

    let (status, _) = call(
        &router,
        "POST",
        "/api/auth/logout",
        session["tokens"]["accessToken"].as_str(),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert!(!grant_is_valid(&router, &credential).await);
    assert_eq!(
        exchange(&router, &unused_code).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert!(grant_is_valid(&router, &other_credential).await);
}

#[tokio::test]
async fn without_cutover_paired_grants_ignore_the_session_lifecycle() {
    let (_data, _state, router) = setup(false);
    let session = login(&router, false).await;
    let code = pairing_code(&router, &session).await;
    let (_, grant) = exchange(&router, &code).await;
    let credential = grant["credential"].as_str().unwrap().to_owned();
    let (status, _) = call(
        &router,
        "POST",
        "/api/auth/logout",
        session["tokens"]["accessToken"].as_str(),
        json!({}),
    )
    .await;
    assert!(status.is_success());
    assert!(grant_is_valid(&router, &credential).await);
}

#[tokio::test]
async fn refresh_request_id_recovers_a_lost_response_over_http() {
    let (_data, _state, router) = setup(true);
    let first = login(&router, true).await;
    let mut body = refresh_body(&first, true, false);
    body["requestId"] = json!("abcdefabcdefabcdefabcdefabcdefab");
    let (status, lost) = call(&router, "POST", "/api/auth/refresh", None, body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, again) = call(&router, "POST", "/api/auth/refresh", None, body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        again["tokens"]["refreshToken"],
        lost["tokens"]["refreshToken"]
    );
    assert_eq!(me(&router, &again).await, StatusCode::OK);
    let (status, spent) = call(
        &router,
        "POST",
        "/api/auth/refresh",
        None,
        refresh_body(&first, true, false),
    )
    .await;
    assert_eq!(
        (status, spent["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("refresh_token_spent"))
    );
}
