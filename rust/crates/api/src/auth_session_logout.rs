use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionLogoutRequest {
    owner: String,
    session: String,
    operation: String,
    incarnation: String,
    logout_capability: String,
}

#[allow(dead_code)]
pub(crate) fn routes(state: AppState) -> Router {
    Router::new()
        .route("/api/auth/session-logout", post(revoke))
        .route("/api/auth/session-logout/receipt", post(receipt))
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::map_response(no_store))
        .with_state(state)
}

async fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn revoke(
    State(state): State<AppState>,
    Json(request): Json<SessionLogoutRequest>,
) -> Response {
    dispatch(state, request, true).await
}

async fn receipt(
    State(state): State<AppState>,
    Json(request): Json<SessionLogoutRequest>,
) -> Response {
    dispatch(state, request, false).await
}

async fn dispatch(state: AppState, request: SessionLogoutRequest, revoke: bool) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let SessionLogoutRequest {
            owner,
            session,
            operation,
            incarnation,
            logout_capability,
        } = request;
        if revoke {
            state
                .revoke_session_with_receipt(
                    &owner,
                    &session,
                    &logout_capability,
                    &operation,
                    &incarnation,
                )
                .map(Some)
        } else {
            state.lookup_session_logout_receipt(
                &owner,
                &session,
                &logout_capability,
                &operation,
                &incarnation,
            )
        }
    })
    .await;
    let (status, body): (StatusCode, Value) = match result {
        Ok(Ok(Some(receipt))) => (StatusCode::OK, receipt),
        Ok(Ok(None)) => (StatusCode::ACCEPTED, json!({"status":"unconfirmed"})),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"status":"unconfirmed"}),
        ),
    };
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{header, HeaderMap, Request, StatusCode},
        Router,
    };
    use serde_json::{json, Value};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;
    use uuid::Uuid;

    async fn request(router: &Router, path: &str, body: &Value) -> (StatusCode, HeaderMap, Value) {
        let response = router
            .clone()
            .oneshot(
                Request::post(path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        (status, headers, serde_json::from_slice(&bytes).unwrap())
    }

    fn config(data: &std::path::Path) -> AppConfig {
        AppConfig {
            data_dir: data.into(),
            jwt_secret: "receipt-http-synthetic".into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn lost_response_can_be_recovered_and_exact_retry_is_idempotent() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(config(data.path())).unwrap();
        let user = state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let old = state.issue_auth_session_for_test(user.clone()).unwrap();
        let fresh = state.issue_auth_session_for_test(user.clone()).unwrap();
        let session = old.session.as_ref().unwrap();
        let operation = Uuid::new_v4().to_string();
        let incarnation = Uuid::new_v4().to_string();
        let body = json!({"owner":user.id,"session":session.id,"operation":operation,"incarnation":incarnation,"logoutCapability":session.logout_capability.as_ref().unwrap()});
        let app = routes(state.clone());
        let (status, _, absent) = request(&app, "/api/auth/session-logout/receipt", &body).await;
        assert_eq!(
            (status, absent),
            (StatusCode::ACCEPTED, json!({"status":"unconfirmed"}))
        );
        assert!(crate::auth::authenticate_local_token(&state, &old.tokens.access_token).is_ok());
        let (status, headers, _) = request(&app, "/api/auth/session-logout", &body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert!(crate::auth::authenticate_local_token(&state, &old.tokens.access_token).is_err());
        assert!(crate::auth::authenticate_local_token(&state, &fresh.tokens.access_token).is_ok());
        assert!(state
            .refresh_auth(&old.tokens.refresh_token)
            .await
            .unwrap()
            .is_none());
        let reopened = crate::state::AppState::new(config(data.path())).unwrap();
        let recovery = routes(reopened.clone());
        let (status, headers, receipt) =
            request(&recovery, "/api/auth/session-logout/receipt", &body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(
            receipt,
            json!({"owner":user.id,"session":session.id,"operation":operation,"incarnation":incarnation,"status":"revoked"})
        );
        assert!(!receipt
            .to_string()
            .contains(session.logout_capability.as_ref().unwrap()));
        assert_eq!(
            request(&recovery, "/api/auth/session-logout", &body)
                .await
                .2,
            receipt
        );
        assert!(reopened
            .refresh_auth(&fresh.tokens.refresh_token)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn wrong_capability_or_scope_cannot_revoke_or_read_a_receipt() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(config(data.path())).unwrap();
        let user = state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let other = state
            .create_local_user_for_test("other", "fixture-password")
            .unwrap();
        let first = state.issue_auth_session_for_test(user.clone()).unwrap();
        let second = state.issue_auth_session_for_test(user.clone()).unwrap();
        let session = first.session.as_ref().unwrap();
        let body = json!({"owner":user.id,"session":session.id,"operation":Uuid::new_v4().to_string(),"incarnation":Uuid::new_v4().to_string(),"logoutCapability":session.logout_capability.as_ref().unwrap()});
        let mut wrong_capability = body.clone();
        wrong_capability["logoutCapability"] = json!("0".repeat(64));
        let mut wrong_owner = body.clone();
        wrong_owner["owner"] = json!(other.id);
        let mut wrong_session = body.clone();
        wrong_session["session"] = json!(second.session.as_ref().unwrap().id);
        let app = routes(state.clone());
        for bad in [&wrong_capability, &wrong_owner, &wrong_session] {
            let (status, _, result) = request(&app, "/api/auth/session-logout", bad).await;
            assert_eq!(
                (status, result),
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"status":"unconfirmed"})
                )
            );
            assert!(
                crate::auth::authenticate_local_token(&state, &first.tokens.access_token).is_ok()
            );
        }
        assert_eq!(
            request(&app, "/api/auth/session-logout", &body).await.0,
            StatusCode::OK
        );
        for bad in [&wrong_capability, &wrong_owner, &wrong_session] {
            assert_eq!(
                request(&app, "/api/auth/session-logout/receipt", bad)
                    .await
                    .0,
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        let mut conflicting = body.clone();
        conflicting["incarnation"] = json!(Uuid::new_v4().to_string());
        assert_eq!(
            request(&app, "/api/auth/session-logout", &conflicting)
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(crate::auth::authenticate_local_token(&state, &second.tokens.access_token).is_ok());
    }

    #[tokio::test]
    async fn identical_simultaneous_requests_return_the_same_receipt() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(config(data.path())).unwrap();
        let user = state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state.issue_auth_session_for_test(user.clone()).unwrap();
        let session = login.session.as_ref().unwrap();
        let body = json!({"owner":user.id,"session":session.id,"operation":Uuid::new_v4().to_string(),"incarnation":Uuid::new_v4().to_string(),"logoutCapability":session.logout_capability.as_ref().unwrap()});
        let app = routes(state.clone());
        let (first, second) = tokio::join!(
            request(&app, "/api/auth/session-logout", &body),
            request(&app, "/api/auth/session-logout", &body)
        );
        assert_eq!(first.0, StatusCode::OK);
        assert_eq!(second.0, StatusCode::OK);
        assert_eq!(first.2, second.2);
        assert!(state
            .refresh_auth(&login.tokens.refresh_token)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn invalid_owners_do_not_create_per_owner_lock_files() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(config(data.path())).unwrap();
        let owner_files = || {
            std::fs::read_dir(data.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("auth-input-") && name.ends_with(".lock"))
                .collect::<std::collections::BTreeSet<_>>()
        };
        let before = owner_files();
        let app = routes(state);
        for _ in 0..16 {
            let body = json!({"owner":Uuid::new_v4().to_string(),"session":Uuid::new_v4().to_string(),"operation":Uuid::new_v4().to_string(),"incarnation":Uuid::new_v4().to_string(),"logoutCapability":"0".repeat(64)});
            assert_eq!(
                request(&app, "/api/auth/session-logout", &body).await.0,
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        assert_eq!(owner_files(), before);
    }

    #[tokio::test]
    async fn route_rejects_non_json_and_oversized_requests_without_caching() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(config(data.path())).unwrap();
        let app = routes(state);
        for (content_type, body, expected) in [
            (
                "text/plain",
                "{}".to_owned(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "application/json",
                json!({"value":"x".repeat(9000)}).to_string(),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::post("/api/auth/session-logout")
                        .header(header::CONTENT_TYPE, content_type)
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "no-store"
            );
        }
    }

    #[tokio::test]
    async fn production_router_does_not_mount_session_logout() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(config(data.path())).unwrap();
        let user = state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state.issue_auth_session_for_test(user.clone()).unwrap();
        let session = login.session.as_ref().unwrap();
        let body = json!({
            "owner": user.id,
            "session": session.id,
            "operation": Uuid::new_v4().to_string(),
            "incarnation": Uuid::new_v4().to_string(),
            "logoutCapability": session.logout_capability.as_ref().unwrap(),
        });
        for path in [
            "/api/auth/session-logout",
            "/api/auth/session-logout/receipt",
        ] {
            let response = crate::app(state.clone())
                .oneshot(
                    Request::post(path)
                        .header(header::CONTENT_TYPE, "application/json")
                        .header(
                            header::AUTHORIZATION,
                            format!("Bearer {}", login.tokens.access_token),
                        )
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(!response.status().is_success());
            assert!(
                crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_ok()
            );
        }
    }
}
