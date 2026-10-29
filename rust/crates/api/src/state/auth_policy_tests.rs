use super::*;
use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

struct FixtureProvider(ExternalAuthUser);
#[async_trait]
impl ExternalAuthProvider for FixtureProvider {
    async fn get_user_by_identifier(
        &self,
        identifier: &str,
    ) -> Result<Option<ExternalAuthUser>, String> {
        Ok((identifier == self.0.email).then(|| self.0.clone()))
    }
    async fn get_user_by_id(&self, id: &str) -> Result<Option<ExternalAuthUser>, String> {
        Ok((id == self.0.id).then(|| self.0.clone()))
    }
}

async fn request(state: &AppState, path: &str, body: Value) -> (StatusCode, Value) {
    let response = crate::app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn username_policy_rejects_local_and_external_login_and_refresh_without_issuing_tokens() {
    for external in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-policy-key".into(),
            ..AppConfig::default()
        };
        let username = "policy-fixture";
        let password = "synthetic-password";
        let provider = external.then(|| {
            Arc::new(FixtureProvider(ExternalAuthUser {
                id: Uuid::new_v4().to_string(),
                email: "policy@example.invalid".into(),
                password_hash: bcrypt::hash(password, 4).unwrap(),
                display_name: Some(username.into()),
                created_at: iso_timestamp(),
            })) as Arc<dyn ExternalAuthProvider>
        });
        let state = AppState::new_with_external_auth(config.clone(), provider.clone()).unwrap();
        if !external {
            state
                .create_local_user_for_test(username, password)
                .unwrap();
        }
        let identifier = if external {
            "policy@example.invalid"
        } else {
            username
        };
        let (status, original) = request(
            &state,
            "/api/auth/login",
            json!({"username":identifier,"password":password}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let token = original["tokens"]["refreshToken"].as_str().unwrap();
        for allowed in [username, "another-user", "POLICY-FIXTURE"] {
            let restricted = AppState::new_with_external_auth(
                AppConfig {
                    allowed_username: Some(allowed.into()),
                    ..config.clone()
                },
                provider.clone(),
            )
            .unwrap();
            let before: i64 = restricted
                .lock_db()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM refresh_tokens", [], |r| r.get(0))
                .unwrap();
            let (login_status, login) = request(
                &restricted,
                "/api/auth/login",
                json!({"username":identifier,"password":password}),
            )
            .await;
            if allowed == username {
                assert_eq!(login_status, StatusCode::OK);
                crate::auth::authenticate_token(
                    &config.jwt_secret,
                    Some(allowed),
                    login["tokens"]["accessToken"].as_str().unwrap(),
                )
                .unwrap();
                continue;
            }
            let (refresh_status, refresh) = request(
                &restricted,
                "/api/auth/refresh",
                json!({"refreshToken":token}),
            )
            .await;
            let after: i64 = restricted
                .lock_db()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM refresh_tokens", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                (
                    login_status,
                    refresh_status,
                    login.get("tokens"),
                    refresh.get("tokens"),
                    after
                ),
                (
                    StatusCode::UNAUTHORIZED,
                    StatusCode::UNAUTHORIZED,
                    None,
                    None,
                    before
                )
            );
        }
        let allowed = AppState::new_with_external_auth(
            AppConfig {
                allowed_username: Some(username.into()),
                ..config
            },
            provider,
        )
        .unwrap();
        assert_eq!(
            request(&allowed, "/api/auth/refresh", json!({"refreshToken":token}))
                .await
                .0,
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn username_policy_checks_public_testing_name_before_account_creation_and_refresh() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        local_testing_login: true,
        allowed_username: Some("allowed".into()),
        ..AppConfig::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    assert!(state.login_local_testing("denied").is_err());
    let count: i64 = state
        .lock_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let auth = state.login_local_testing("allowed").unwrap();
    assert_eq!(auth.user.username, "allowed");
    let refreshed = state
        .refresh_auth(&auth.tokens.refresh_token)
        .await
        .unwrap()
        .unwrap();
    let denied = AppState::new(AppConfig {
        allowed_username: Some("another-user".into()),
        ..config
    })
    .unwrap();
    assert!(denied
        .refresh_auth(&refreshed.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
    assert!(denied
        .issue_auth_result_for_public_user(refreshed.user)
        .is_err());
}
