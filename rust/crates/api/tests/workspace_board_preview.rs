#![cfg(all(unix, feature = "workspace-board-preview"))]

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use terminal_v4_api::{app, ApiState};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;

struct Account {
    token: String,
    workspace: std::path::PathBuf,
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:3020")
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn account(app: &Router, data: &std::path::Path, name: &str) -> Account {
    let (status, login) = call(
        app,
        "POST",
        "/api/auth/local-testing",
        None,
        json!({"username": name}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let user = login["user"]["id"].as_str().unwrap();
    let workspace = data
        .join("workspace-git")
        .join(&hex::encode(Sha256::digest(user.as_bytes()))[..32]);
    std::fs::create_dir_all(&workspace).unwrap();
    Account {
        token: login["tokens"]["accessToken"].as_str().unwrap().into(),
        workspace: std::fs::canonicalize(workspace).unwrap(),
    }
}

fn setup() -> (tempfile::TempDir, Router) {
    let data = tempfile::tempdir().unwrap();
    let state = ApiState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "board-preview-test-secret".into(),
        local_testing_login: true,
        ..Default::default()
    })
    .unwrap();
    (data, app(state))
}

#[tokio::test]
async fn board_requires_authentication() {
    let (_data, app) = setup();
    let (status, _) = call(
        &app,
        "GET",
        "/api/workspace/board?path=/tmp",
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_is_idempotent_and_listed_once() {
    let (data, app) = setup();
    let a = account(&app, data.path(), "board-a").await;
    let path = a.workspace.to_str().unwrap();
    let body = json!({"path": path, "operationId": uuid::Uuid::new_v4(), "title": "Ship"});
    let first = call(
        &app,
        "POST",
        "/api/workspace/board",
        Some(&a.token),
        body.clone(),
    )
    .await;
    let retry = call(
        &app,
        "POST",
        "/api/workspace/board",
        Some(&a.token),
        body.clone(),
    )
    .await;
    assert_eq!((first.0, &first.1), (StatusCode::OK, &retry.1));
    let uri = format!("/api/workspace/board?path={}", path.replace('/', "%2F"));
    let (status, listed) = call(&app, "GET", &uri, Some(&a.token), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["items"], json!([first.1]));
    let changed = json!({"path": path, "operationId": body["operationId"], "title": "Different"});
    let (status, _) = call(
        &app,
        "POST",
        "/api/workspace/board",
        Some(&a.token),
        changed,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn another_owner_cannot_read_or_change_items_or_use_the_workspace() {
    let (data, app) = setup();
    let a = account(&app, data.path(), "board-a").await;
    let b = account(&app, data.path(), "board-b").await;
    let path = a.workspace.to_str().unwrap();
    let (_, item) = call(
        &app,
        "POST",
        "/api/workspace/board",
        Some(&a.token),
        json!({"path": path, "operationId": uuid::Uuid::new_v4(), "title": "Private"}),
    )
    .await;
    let uri = format!("/api/workspace/board?path={}", path.replace('/', "%2F"));
    assert_eq!(
        call(&app, "GET", &uri, Some(&b.token), Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    let patch = json!({"path": path, "operationId": uuid::Uuid::new_v4(), "expectedRevision": 1, "title": "Hijack"});
    let item_uri = format!("/api/workspace/board/{}", item["id"].as_str().unwrap());
    assert_eq!(
        call(&app, "PATCH", &item_uri, Some(&b.token), patch)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let own = b.workspace.to_str().unwrap();
    let patch = json!({"path": own, "operationId": uuid::Uuid::new_v4(), "expectedRevision": 1, "title": "Hijack"});
    assert_eq!(
        call(&app, "PATCH", &item_uri, Some(&b.token), patch)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn stale_revisions_unknown_fields_and_oversized_bodies_are_refused() {
    let (data, app) = setup();
    let a = account(&app, data.path(), "board-a").await;
    let path = a.workspace.to_str().unwrap();
    let (_, item) = call(
        &app,
        "POST",
        "/api/workspace/board",
        Some(&a.token),
        json!({"path": path, "operationId": uuid::Uuid::new_v4(), "title": "T"}),
    )
    .await;
    let uri = format!("/api/workspace/board/{}", item["id"].as_str().unwrap());
    let ok = json!({"path": path, "operationId": uuid::Uuid::new_v4(), "expectedRevision": 1, "status": "done"});
    assert_eq!(
        call(&app, "PATCH", &uri, Some(&a.token), ok).await.0,
        StatusCode::OK
    );
    let stale = json!({"path": path, "operationId": uuid::Uuid::new_v4(), "expectedRevision": 1, "title": "x"});
    assert_eq!(
        call(&app, "PATCH", &uri, Some(&a.token), stale).await.0,
        StatusCode::CONFLICT
    );
    let unknown = json!({"path": path, "operationId": uuid::Uuid::new_v4(), "expectedRevision": 2, "owner": "x", "title": "x"});
    assert_eq!(
        call(&app, "PATCH", &uri, Some(&a.token), unknown).await.0,
        StatusCode::BAD_REQUEST
    );
    let huge = json!({"path": path, "operationId": uuid::Uuid::new_v4(), "title": "T", "description": "x".repeat(50_000)});
    assert_eq!(
        call(&app, "POST", "/api/workspace/board", Some(&a.token), huge)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn logout_revokes_board_access_but_keeps_the_items_for_the_next_session() {
    let (data, app) = setup();
    let a = account(&app, data.path(), "board-a").await;
    let path = a.workspace.to_str().unwrap();
    call(
        &app,
        "POST",
        "/api/workspace/board",
        Some(&a.token),
        json!({"path": path, "operationId": uuid::Uuid::new_v4(), "title": "Keep"}),
    )
    .await;
    let (status, _) = call(&app, "POST", "/api/auth/logout", Some(&a.token), json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let uri = format!("/api/workspace/board?path={}", path.replace('/', "%2F"));
    assert_eq!(
        call(&app, "GET", &uri, Some(&a.token), Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    let again = account(&app, data.path(), "board-a").await;
    let (status, listed) = call(&app, "GET", &uri, Some(&again.token), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
}
