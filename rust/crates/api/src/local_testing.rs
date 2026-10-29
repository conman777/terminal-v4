use crate::{state::AppState, ApiError};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) const PASSWORD_MARKER: &str = "!terminal-v4-local-testing!";
pub(crate) const ACCOUNT_PREFIX: &str = "local-testing-";
pub(crate) const USERNAME_PREFIX: &str = "!local-testing:";

pub(crate) fn enabled(state: &AppState) -> bool {
    state.config().local_testing_login
        && state.config().host.is_loopback()
        && state.config().storage_database_url.is_none()
}

pub(crate) async fn mode(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"mode": if enabled(&state) { "local-testing" } else { "password" }}))
}

#[derive(Deserialize)]
pub(crate) struct UsernameInput {
    username: String,
}

pub(crate) async fn enter(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UsernameInput>,
) -> Result<Json<terminal_v4_core::AuthResult>, ApiError> {
    if !enabled(&state) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Local testing is disabled".into(),
        });
    }
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let target = url::Url::parse(&format!("http://{host}"))
        .ok()
        .filter(|url| {
            url.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            })
        });
    let same_origin = target.as_ref().is_some_and(|target| {
        headers.get(header::ORIGIN).is_none_or(|origin| {
            origin
                .to_str()
                .ok()
                .and_then(|origin| url::Url::parse(origin).ok())
                .is_some_and(|origin| {
                    origin.host_str() == target.host_str()
                        && origin.port_or_known_default() == target.port_or_known_default()
                        && origin.scheme() == target.scheme()
                })
        })
    });
    if !same_origin {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Local testing requires this app's local origin".into(),
        });
    }
    let username = input.username.trim().to_ascii_lowercase();
    if username.is_empty()
        || username.len() > 48
        || !username
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"._-".contains(&value))
    {
        return Err(ApiError::bad_request(
            "Use 1–48 letters, numbers, dots, underscores or hyphens for your username",
        ));
    }
    if crate::auth::validate_allowed_username(state.config().allowed_username.as_deref(), &username)
        .is_err()
    {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Choose the configured local username".into(),
        });
    }
    state
        .login_local_testing(&username)
        .map(Json)
        .map_err(|message| ApiError {
            status: StatusCode::CONFLICT,
            message,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    async fn login(state: &AppState, username: &str, origin: &str) -> (StatusCode, Value) {
        let response = crate::app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/local-testing")
                    .header(header::HOST, "127.0.0.1:3030")
                    .header(header::ORIGIN, origin)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"username":username}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn local_testing_accounts_are_persistent_normalized_and_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: directory.path().into(),
            local_testing_login: true,
            ..AppConfig::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let (status, first) = login(&state, "  Tester  ", "http://127.0.0.1:3030").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["user"]["username"], "tester");
        let (_, again) = login(&state, "tester", "http://127.0.0.1:3030").await;
        assert_eq!(first["user"]["id"], again["user"]["id"]);
        let (_, other) = login(&state, "another", "http://127.0.0.1:3030").await;
        assert_ne!(first["user"]["id"], other["user"]["id"]);
        assert!(first["tokens"]["refreshToken"].as_str().is_some());
        drop(state);
        let state = AppState::new(config).unwrap();
        let (_, reopened) = login(&state, "TESTER", "http://127.0.0.1:3030").await;
        assert_eq!(first["user"]["id"], reopened["user"]["id"]);
        let disabled = AppState::new(AppConfig {
            local_testing_login: false,
            ..state.config().clone()
        })
        .unwrap();
        assert!(crate::auth::authenticate_runtime_token(
            &disabled,
            first["tokens"]["accessToken"].as_str().unwrap(),
            "/api/state"
        )
        .is_err());
        let access = first["tokens"]["accessToken"].as_str().unwrap();
        let preview = crate::auth::issue_preview_token(
            &state.config().jwt_secret,
            first["user"]["id"].as_str().unwrap(),
            "tester",
        );
        assert!(
            crate::auth::authenticate_runtime_preview_token(&state, &preview, "/preview/").is_ok()
        );
        assert!(
            crate::auth::authenticate_runtime_preview_token(&disabled, &preview, "/preview/")
                .is_err()
        );
        assert!(crate::authenticate_runtime_websocket(
            &disabled,
            &HeaderMap::new(),
            Some(access),
            "/api/terminal/test/ws"
        )
        .is_err());
        assert!(crate::auth::authenticate_local_token(&disabled, access).is_err());
        assert!(disabled
            .refresh_auth(first["tokens"]["refreshToken"].as_str().unwrap())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn local_testing_never_bypasses_existing_password_accounts_or_origins() {
        let directory = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: directory.path().into(),
            local_testing_login: true,
            ..AppConfig::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let protected = state
            .create_local_user_for_test("existing", "existing-password")
            .unwrap();
        let (status, testing) = login(&state, "existing", "http://127.0.0.1:3030").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(testing["user"]["username"], "existing");
        assert_ne!(testing["user"]["id"], protected.id);
        let (_, again) = login(&state, "EXISTING", "http://127.0.0.1:3030").await;
        assert_eq!(again["user"]["id"], testing["user"]["id"]);
        let refreshed = state
            .refresh_auth(testing["tokens"]["refreshToken"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.user.username, "existing");
        assert_eq!(
            state
                .login("existing", "existing-password")
                .await
                .unwrap()
                .unwrap()
                .user
                .id,
            protected.id
        );
        let reopened = AppState::new(config.clone()).unwrap();
        assert_eq!(
            login(&reopened, "existing", "http://127.0.0.1:3030")
                .await
                .1["user"]["id"],
            testing["user"]["id"]
        );
        for origin in [
            "https://example.com",
            "http://localhost:3030",
            "http://127.0.0.1:9999",
        ] {
            assert_eq!(
                login(&state, "tester", origin).await.0,
                StatusCode::FORBIDDEN
            );
        }
        for username in ["", "../somebody", "name with spaces"] {
            assert_eq!(
                login(&state, username, "http://127.0.0.1:3030").await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let state = AppState::new(AppConfig {
            local_testing_login: false,
            ..config
        })
        .unwrap();
        assert_eq!(
            login(&state, "tester", "http://127.0.0.1:3030").await.0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn local_testing_preserves_legacy_testing_identity() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(AppConfig {
            data_dir: directory.path().into(),
            local_testing_login: true,
            ..AppConfig::default()
        })
        .unwrap();
        let legacy_id = "local-testing-legacy-fixture";
        state.lock_db().unwrap().execute(
            "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![legacy_id, "legacy", PASSWORD_MARKER, "2026-10-20T12:00:00Z", "2026-10-20T12:00:00Z"],
        ).unwrap();
        let (status, reopened) = login(&state, "LEGACY", "http://127.0.0.1:3030").await;
        assert_eq!(
            (
                status,
                reopened["user"]["id"].as_str(),
                reopened["user"]["username"].as_str()
            ),
            (StatusCode::OK, Some(legacy_id), Some("legacy"))
        );
    }
}
