use super::*;
use async_trait::async_trait;
use tokio::sync::Semaphore;

#[cfg(unix)]
async fn vault_requests_after_revocation(cutover: bool) {
    use axum::{
        body::Body,
        extract::Request,
        http::{header, StatusCode},
        middleware::{self, Next},
        routing::{delete, get},
        Router,
    };
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tower::ServiceExt;

    for (method, path) in [
        ("GET", "/api/vault"),
        ("GET", "/api/vault/modern/reveal"),
        ("GET", "/api/vault/legacy/reveal"),
        ("POST", "/api/vault"),
        ("DELETE", "/api/vault/modern"),
        ("GET", "/api/agent/auth"),
        ("GET", "/api/agent/catalog"),
        ("PUT", "/api/agent/auth/openai-api/api-key"),
        ("DELETE", "/api/agent/auth/openai-api/api-key"),
    ] {
        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "vault-revocation-fixture".into(),
            ..Default::default()
        };
        let first = AppState::new(config.clone()).unwrap();
        let other = AppState::new(config).unwrap();
        first
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let old = first
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let user = AuthenticatedUser {
            user_id: old.user.id.clone(),
            username: old.user.username.clone(),
        };
        let cipher = crate::vault::VaultCipher::load(data.path()).unwrap();
        let modern = cipher.encrypt("synthetic modern secret").unwrap();
        let legacy = crate::vault::encrypt_secret(
            "synthetic legacy secret",
            "dev-vault-key-change-in-production",
        )
        .unwrap()
        .replacen("enc:v2:", "enc:v1:", 1);
        first
            .add_vault_key(&user, "modern", "modern", &modern, "2020-01-01")
            .unwrap();
        first
            .add_vault_key(&user, "legacy", "legacy", &legacy, "2020-01-02")
            .unwrap();
        first
            .add_vault_key(
                &user,
                "provider",
                "terminal-v4:provider:openai-api",
                &modern,
                "2020-01-03",
            )
            .unwrap();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let barrier = {
            let entered = entered.clone();
            let release = release.clone();
            middleware::from_fn(move |request: Request, next: Next| {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    next.run(request).await
                }
            })
        };
        let router = Router::new()
            .route(
                "/api/vault",
                get(crate::list_vault_keys).post(crate::add_vault_key),
            )
            .route("/api/vault/{id}/reveal", get(crate::reveal_vault_key))
            .route("/api/vault/{id}", delete(crate::delete_vault_key))
            .merge(crate::agent_catalog::routes())
            .route_layer(barrier)
            .route_layer(middleware::from_fn_with_state(
                first.clone(),
                crate::auth::require_auth,
            ))
            .with_state(first);
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", old.tokens.access_token),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(match method {
                "POST" => r#"{"keyName":"new","keyValue":"synthetic"}"#,
                "PUT" => r#"{"apiKey":"synthetic-replacement"}"#,
                _ => "",
            }))
            .unwrap();
        let delayed = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let fresh = if cutover {
            other
                .issue_auth_result_for_public_user_protocol(old.user.clone(), 1)
                .unwrap()
        } else {
            other.logout_user(&old.user.id).unwrap();
            other
                .login("fixture", "fixture-password")
                .await
                .unwrap()
                .unwrap()
        };
        release.notify_one();
        let response = tokio::time::timeout(Duration::from_secs(5), delayed)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
        let entries = other.list_vault_keys(&user).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(
            other
                .get_vault_key(&user, "provider")
                .unwrap()
                .unwrap()
                .key_value,
            modern
        );
        assert_eq!(
            other
                .get_vault_key(&user, "modern")
                .unwrap()
                .unwrap()
                .key_value,
            modern
        );
        assert_eq!(
            other
                .get_vault_key(&user, "legacy")
                .unwrap()
                .unwrap()
                .key_value,
            legacy
        );
        let fresh_request = Request::builder()
            .method(method)
            .uri(path)
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", fresh.tokens.access_token),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(match method {
                "POST" => r#"{"keyName":"new","keyValue":"synthetic"}"#,
                "PUT" => r#"{"apiKey":"synthetic-replacement"}"#,
                _ => "",
            }))
            .unwrap();
        let fresh_response = crate::app(other).oneshot(fresh_request).await.unwrap();
        assert_eq!(
            fresh_response.status(),
            if method == "DELETE" {
                StatusCode::NO_CONTENT
            } else {
                StatusCode::OK
            },
            "fresh {method} {path}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn vault_requests_admitted_before_logout_cannot_read_or_write_afterward() {
    vault_requests_after_revocation(false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn vault_requests_admitted_before_cutover_cannot_read_or_write_afterward() {
    vault_requests_after_revocation(true).await;
}

#[cfg(unix)]
#[tokio::test]
async fn paired_provider_reads_work_and_reject_revocation_after_authentication() {
    use axum::{
        body::Body,
        extract::Request,
        http::{header, StatusCode},
        middleware::{self, Next},
    };
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tower::ServiceExt;
    for path in ["/api/agent/auth", "/api/agent/catalog"] {
        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let other = AppState::new(config).unwrap();
        let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let request = || {
            Request::builder()
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            crate::app(state.clone())
                .oneshot(request())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let barrier = {
            let entered = entered.clone();
            let release = release.clone();
            middleware::from_fn(move |req: Request, next: Next| {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    next.run(req).await
                }
            })
        };
        let router = crate::agent_catalog::routes()
            .route_layer(barrier)
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let delayed_request = request();
        let delayed = tokio::spawn(async move { router.oneshot(delayed_request).await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        other
            .lock_db()
            .unwrap()
            .execute(
                "DELETE FROM paired_grants WHERE id=?1",
                rusqlite::params![grant],
            )
            .unwrap();
        release.notify_one();
        let response = tokio::time::timeout(Duration::from_secs(5), delayed)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[cfg(unix)]
#[test]
fn vault_busy_error_does_not_change_other_owner_review_errors() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let identity = AuthenticatedUser {
        user_id: user.id.clone(),
        username: user.username,
    };
    let authority = crate::auth::LocalAuthority::for_test(
        &user.id,
        0,
        crate::v4_agent::interaction::now_ms() + 60_000,
    );
    state
        .lock_db()
        .unwrap()
        .busy_timeout(std::time::Duration::from_millis(10))
        .unwrap();
    let blocking = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    blocking.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(
        state
            .with_owner_review(&user.id, &authority, |_, _| Ok(()))
            .unwrap_err(),
        "Authentication admission unavailable"
    );
    assert_eq!(
        state
            .with_authorized_vault(&identity, &authority, |_| Ok(()))
            .unwrap_err(),
        crate::vault_admission::BUSY
    );
    blocking.execute_batch("ROLLBACK").unwrap();
}

#[cfg(unix)]
async fn settings_requests_after_revocation(cutover: bool) {
    use axum::{
        body::Body,
        extract::Request,
        http::{header, StatusCode},
        middleware::{self, Next},
        routing::get,
        Router,
    };
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tower::ServiceExt;

    for method in ["GET", "PATCH"] {
        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "settings-cutover-fixture".into(),
            ..Default::default()
        };
        let first = AppState::new(config.clone()).unwrap();
        let other = AppState::new(config).unwrap();
        first
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let old = first
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let barrier = {
            let entered = entered.clone();
            let release = release.clone();
            middleware::from_fn(move |request: Request, next: Next| {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    next.run(request).await
                }
            })
        };
        let router = Router::new()
            .route(
                "/api/settings",
                get(crate::get_settings).patch(crate::update_settings),
            )
            .route_layer(barrier)
            .route_layer(middleware::from_fn_with_state(
                first.clone(),
                crate::auth::require_auth,
            ))
            .with_state(first);
        let request = Request::builder()
            .method(method)
            .uri("/api/settings")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", old.tokens.access_token),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(if method == "PATCH" {
                r#"{"theme":"light"}"#
            } else {
                ""
            }))
            .unwrap();
        let delayed = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let fresh = if cutover {
            other
                .issue_auth_result_for_public_user_protocol(old.user.clone(), 1)
                .unwrap()
        } else {
            other.logout_user(&old.user.id).unwrap();
            other
                .login("fixture", "fixture-password")
                .await
                .unwrap()
                .unwrap()
        };
        release.notify_one();
        let response = tokio::time::timeout(Duration::from_secs(5), delayed)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} must reject the stale authority"
        );
        let user = AuthenticatedUser {
            user_id: old.user.id.clone(),
            username: old.user.username.clone(),
        };
        assert_eq!(other.get_settings(&user).unwrap().theme, "dark");
        let fresh_request = Request::builder()
            .method(method)
            .uri("/api/settings")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", fresh.tokens.access_token),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(if method == "PATCH" {
                r#"{"theme":"light"}"#
            } else {
                ""
            }))
            .unwrap();
        assert_eq!(
            crate::app(other.clone())
                .oneshot(fresh_request)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            other.get_settings(&user).unwrap().theme,
            if method == "PATCH" { "light" } else { "dark" }
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn settings_requests_admitted_before_cutover_cannot_read_or_write_afterward() {
    settings_requests_after_revocation(true).await;
}

#[cfg(unix)]
#[tokio::test]
async fn settings_requests_admitted_before_logout_cannot_read_or_write_afterward() {
    settings_requests_after_revocation(false).await;
}

#[tokio::test]
async fn settings_routes_reject_missing_foreign_and_expired_authority() {
    use axum::{body::Body, http::StatusCode, routing::get, Extension, Router};
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let identity = AuthenticatedUser {
        user_id: user.id.clone(),
        username: user.username.clone(),
    };
    let expired = crate::auth::LocalAuthority::for_test(
        &user.id,
        0,
        crate::v4_agent::interaction::now_ms() - 1,
    );
    let foreign = crate::auth::LocalAuthority::for_test(
        "another-owner",
        0,
        crate::v4_agent::interaction::now_ms() + 60_000,
    );
    for authority in [None, Some(expired), Some(foreign)] {
        for method in ["GET", "PATCH"] {
            let router = Router::new()
                .route(
                    "/api/settings",
                    get(crate::get_settings).patch(crate::update_settings),
                )
                .with_state(state.clone())
                .layer(Extension(identity.clone()));
            let router = if let Some(authority) = authority.clone() {
                router.layer(Extension(authority))
            } else {
                router
            };
            let request = axum::http::Request::builder()
                .method(method)
                .uri("/api/settings")
                .header("content-type", "application/json")
                .body(Body::from(if method == "PATCH" {
                    r#"{"theme":"light"}"#
                } else {
                    ""
                }))
                .unwrap();
            assert_eq!(
                router.oneshot(request).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    assert_eq!(state.get_settings(&identity).unwrap().theme, "dark");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_transaction_rolls_back_if_authority_expires_before_commit() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let identity = AuthenticatedUser {
        user_id: user.id.clone(),
        username: user.username,
    };
    let expires = crate::v4_agent::interaction::now_ms() + 2000;
    let authority = crate::auth::LocalAuthority::for_test(&user.id, 0, expires);
    let patch = SettingsPatch::from_value(serde_json::json!({"theme":"light"})).unwrap();
    let applied = std::cell::Cell::new(false);
    let result = state.with_owner_review(&user.id, &authority, |tx, check| {
        AppState::update_settings_in_transaction(tx, &identity, &patch)?;
        applied.set(true);
        std::thread::sleep(std::time::Duration::from_millis(
            expires.saturating_sub(crate::v4_agent::interaction::now_ms()) as u64 + 25,
        ));
        check()
    });
    assert!(applied.get());
    assert!(result.is_err());
    assert_eq!(state.get_settings(&identity).unwrap().theme, "dark");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_update_admitted_first_finishes_before_protocol_cutover() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "settings-order-fixture".into(),
        ..Default::default()
    };
    let first = AppState::new(config.clone()).unwrap();
    let other = AppState::new(config).unwrap();
    first
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = first
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&first, &old.tokens.access_token).unwrap();
    let patch = SettingsPatch::from_value(serde_json::json!({"theme":"light"})).unwrap();
    let (entered, entered_rx) = tokio::sync::oneshot::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let writer = tokio::task::spawn_blocking(move || {
        first.with_owner_review(&user.user_id, &authority, |tx, check| {
            AppState::update_settings_in_transaction(tx, &user, &patch)?;
            entered.send(()).map_err(|_| "Test stopped")?;
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "Test stopped")?;
            check()
        })
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(other
        .inner
        .auth_admission
        .get()
        .unwrap()
        .try_acquire()
        .is_err());
    let user = old.user.clone();
    let transition_state = other.clone();
    let (attempted, attempted_rx) = tokio::sync::oneshot::channel();
    let mut transition = tokio::task::spawn_blocking(move || {
        let _ = attempted.send(());
        transition_state.issue_auth_result_for_public_user_protocol(user, 1)
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), attempted_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut transition)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    writer.await.unwrap().unwrap();
    let fresh = transition.await.unwrap().unwrap();
    assert!(crate::auth::authenticate_local_token(&other, &fresh.tokens.access_token).is_ok());
    let identity = AuthenticatedUser {
        user_id: old.user.id,
        username: old.user.username,
    };
    assert_eq!(other.get_settings(&identity).unwrap().theme, "light");
}

#[cfg(unix)]
#[tokio::test]
async fn protocol_cutover_atomically_revokes_old_authority_and_issues_usable_credentials() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "protocol-cutover-fixture".into(),
        ..Default::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let other = AppState::new(config).unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (_, authority) =
        crate::auth::authenticate_local_with_authority(&state, &old.tokens.access_token).unwrap();
    let upgraded = state
        .issue_auth_result_for_public_user_protocol(old.user.clone(), 1)
        .unwrap();
    assert!(crate::auth::authenticate_local_token(&other, &old.tokens.access_token).is_err());
    assert!(other
        .refresh_auth(&old.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
    assert!(!other
        .logout_user_authorized(&old.user.id, &authority)
        .unwrap());
    let admitted = std::cell::Cell::new(false);
    let result = other.accept_with_local_authority(&old.user.id, &authority, |_| {
        admitted.set(true);
        Ok::<(), String>(())
    });
    assert!(result.is_err());
    assert!(!admitted.get());
    assert!(crate::auth::authenticate_local_token(&other, &upgraded.tokens.access_token).is_ok());
    let old_writer_access = crate::auth::issue_access_token_for_generation(
        &state.config().jwt_secret,
        &old.user.id,
        &old.user.username,
        1,
    );
    let old_writer_refresh =
        AppState::insert_refresh_token(&state.lock_db().unwrap(), &old.user.id, 0).unwrap();
    assert!(other
        .refresh_auth(&old_writer_refresh)
        .await
        .unwrap()
        .is_none());
    for (token, expected) in [
        (&old_writer_access, StatusCode::UNAUTHORIZED),
        (&upgraded.tokens.access_token, StatusCode::OK),
    ] {
        let response = crate::app(other.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/auth/me")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let later = other
        .issue_auth_result_for_public_user_protocol(old.user.clone(), 1)
        .unwrap();
    assert!(crate::auth::authenticate_local_token(&other, &upgraded.tokens.access_token).is_ok());
    assert!(other
        .refresh_auth(&later.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn protocol_cutover_rolls_back_if_upgraded_issuance_fails() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "protocol-rollback-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    state.lock_db().unwrap().execute_batch("CREATE TRIGGER fixture_fail_upgrade BEFORE INSERT ON refresh_tokens WHEN NEW.auth_protocol=1 BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert!(state
        .issue_auth_result_for_public_user_protocol(old.user.clone(), 1)
        .is_err());
    let stored: (i64, i64, i64, i64) = state.lock_db().unwrap().query_row("SELECT auth_protocol_min, (SELECT COALESCE((SELECT generation FROM auth_generations WHERE user_id=?1),0)), (SELECT activated_count FROM auth_protocol_account_integrity WHERE id=1), (SELECT count(*) FROM refresh_tokens WHERE user_id=?1) FROM users WHERE id=?1", params![old.user.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
    assert_eq!(stored, (0, 0, 0, 1));
    assert!(crate::auth::authenticate_local_token(&state, &old.tokens.access_token).is_ok());
    assert!(state
        .refresh_auth(&old.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn missing_protocol_integrity_trigger_blocks_authentication_and_refresh() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "protocol-integrity-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    state
        .lock_db()
        .unwrap()
        .execute_batch("DROP TRIGGER auth_protocol_account_activate")
        .unwrap();
    assert!(crate::auth::authenticate_local_token(&state, &old.tokens.access_token).is_err());
    assert!(state.refresh_auth(&old.tokens.refresh_token).await.is_err());
}

#[tokio::test]
async fn account_protocol_blocks_legacy_issuance_and_preserves_upgraded_refresh() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "protocol-refresh-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let legacy = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let upgraded = state
        .issue_auth_result_for_public_user_protocol(legacy.user.clone(), 1)
        .unwrap();
    assert!(state.login("fixture", "fixture-password").await.is_err());
    assert!(state
        .refresh_auth(&legacy.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
    let rotated = state
        .refresh_auth(&upgraded.tokens.refresh_token)
        .await
        .unwrap()
        .unwrap();
    let claims = jsonwebtoken::decode::<serde_json::Value>(
        &rotated.tokens.access_token,
        &jsonwebtoken::DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    )
    .unwrap()
    .claims;
    assert_eq!(claims["auth_protocol"], 1);
    assert_eq!(claims["session_id"], upgraded.session.as_ref().unwrap().id);
    assert!(state
        .refresh_auth(&rotated.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn upgraded_logout_from_older_login_preserves_newer_same_account_session() {
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
    };
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "session-scoped-logout-fixture".into(),
        ..Default::default()
    };
    let first = AppState::new(config.clone()).unwrap();
    let second = AppState::new(config).unwrap();
    let user = first
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = first
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let (_, old_authority) =
        crate::auth::authenticate_local_with_authority(&first, &old.tokens.access_token).unwrap();
    let fresh = second
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let old_session = old.session.as_ref().unwrap();
    let fresh_session = fresh.session.as_ref().unwrap();
    assert_ne!(old_session.id, fresh_session.id);
    assert_eq!(old_session.logout_capability.as_ref().unwrap().len(), 64);
    let old_preview =
        crate::auth::preview_token_for_access(&first, &old.tokens.access_token).unwrap();
    let old_resource =
        crate::preview::auth_urls::resource_token(&first, &old_preview, "/preview/fixture")
            .unwrap();
    let rotated = second
        .refresh_auth(&fresh.tokens.refresh_token)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rotated.session.as_ref().unwrap().id, fresh_session.id);
    assert!(rotated
        .session
        .as_ref()
        .unwrap()
        .logout_capability
        .is_none());
    let response = crate::app(first.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", old.tokens.access_token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
    assert!(crate::auth::authenticate_local_token(&second, &old.tokens.access_token).is_err());
    assert!(crate::auth::authenticate_local_token(&second, &fresh.tokens.access_token).is_ok());
    assert!(
        crate::auth::authenticate_runtime_preview_token(&second, &old_preview, "/preview/")
            .is_err()
    );
    assert!(crate::preview::auth_urls::authenticate_resource_token(
        &second,
        &old_resource,
        "GET",
        "/preview/fixture"
    )
    .is_err());
    assert!(second
        .with_owner_review(&user.id, &old_authority, |_, _| Ok(()))
        .is_err());
    let (_, fresh_authority) =
        crate::auth::authenticate_local_with_authority(&second, &rotated.tokens.access_token)
            .unwrap();
    assert!(second
        .with_owner_review(&user.id, &fresh_authority, |_, _| Ok(()))
        .is_ok());
    assert!(second
        .refresh_auth(&old.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
    assert!(second
        .refresh_auth(&rotated.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgraded_logout_rechecks_expiry_after_waiting_for_owner_marker() {
    use std::time::Duration;
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "session-expiry-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let mut claims = jsonwebtoken::decode::<serde_json::Value>(
        &login.tokens.access_token,
        &jsonwebtoken::DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    )
    .unwrap()
    .claims;
    let expiry = (crate::v4_agent::interaction::now_ms() / 1000) + 2;
    claims["exp"] = serde_json::json!(expiry);
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config().jwt_secret.as_bytes()),
    )
    .unwrap();
    let (_, authority) = crate::auth::authenticate_local_with_authority(&state, &token).unwrap();
    let (entered, release) = state.pause_logout_marker_for_test();
    let owner = user.id.clone();
    let task = tokio::task::spawn_blocking({
        let state = state.clone();
        move || state.logout_user_authorized(&owner, &authority)
    });
    tokio::task::spawn_blocking(move || entered.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    let remaining = (expiry * 1000).saturating_sub(crate::v4_agent::interaction::now_ms()) as u64;
    tokio::time::sleep(Duration::from_millis(remaining + 50)).await;
    release.send(()).unwrap();
    assert!(!task.await.unwrap().unwrap());
    assert!(state
        .refresh_auth(&login.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn session_logout_receipt_is_owner_bound_durable_and_idempotent() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "session-receipt-fixture".into(),
        ..Default::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let fresh = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let old_session = old.session.as_ref().unwrap();
    let fresh_session = fresh.session.as_ref().unwrap();
    let capability = old_session.logout_capability.as_ref().unwrap();
    let operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    assert!(state
        .lookup_session_logout_receipt(
            &user.id,
            &old_session.id,
            capability,
            &operation,
            &incarnation
        )
        .unwrap()
        .is_none());
    assert!(state
        .revoke_session_with_receipt(
            &user.id,
            &old_session.id,
            &"0".repeat(64),
            &operation,
            &incarnation
        )
        .is_err());
    assert!(state
        .revoke_session_with_receipt(
            "foreign-owner",
            &old_session.id,
            capability,
            &operation,
            &incarnation
        )
        .is_err());
    assert!(crate::auth::authenticate_local_token(&state, &old.tokens.access_token).is_ok());
    let receipt = state
        .revoke_session_with_receipt(
            &user.id,
            &old_session.id,
            capability,
            &operation,
            &incarnation,
        )
        .unwrap();
    assert_eq!(receipt["owner"], user.id);
    assert_eq!(receipt["session"], old_session.id);
    assert_eq!(receipt["operation"], operation);
    assert_eq!(receipt["incarnation"], incarnation);
    assert_eq!(receipt["status"], "revoked");
    assert!(!receipt.to_string().contains(capability));
    let reopened = AppState::new(config).unwrap();
    assert_eq!(
        reopened
            .lookup_session_logout_receipt(
                &user.id,
                &old_session.id,
                capability,
                &operation,
                &incarnation
            )
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        reopened
            .revoke_session_with_receipt(
                &user.id,
                &old_session.id,
                capability,
                &operation,
                &incarnation
            )
            .unwrap(),
        receipt
    );
    assert!(reopened
        .revoke_session_with_receipt(
            &user.id,
            &old_session.id,
            capability,
            &operation,
            &Uuid::new_v4().to_string()
        )
        .is_err());
    assert!(reopened
        .revoke_session_with_receipt(
            &user.id,
            &fresh_session.id,
            fresh_session.logout_capability.as_ref().unwrap(),
            &operation,
            &incarnation
        )
        .is_err());
    assert!(crate::auth::authenticate_local_token(&reopened, &old.tokens.access_token).is_err());
    assert!(crate::auth::authenticate_local_token(&reopened, &fresh.tokens.access_token).is_ok());
    assert!(reopened
        .refresh_auth(&fresh.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn session_logout_receipt_failure_does_not_revoke_session() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "receipt-rollback-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let session = login.session.as_ref().unwrap();
    let operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    state.lock_db().unwrap().execute_batch("CREATE TRIGGER fail_session_receipt BEFORE INSERT ON auth_session_logout_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;").unwrap();
    assert!(state
        .revoke_session_with_receipt(
            &user.id,
            &session.id,
            session.logout_capability.as_ref().unwrap(),
            &operation,
            &incarnation
        )
        .is_err());
    assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_ok());
    assert!(state
        .refresh_auth(&login.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
    assert!(state
        .lookup_session_logout_receipt(
            &user.id,
            &session.id,
            session.logout_capability.as_ref().unwrap(),
            &operation,
            &incarnation
        )
        .unwrap()
        .is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn receipt_recovers_session_previously_revoked_by_logout_or_generation_change() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "already-revoked-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let first = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let (_, authority) =
        crate::auth::authenticate_local_with_authority(&state, &first.tokens.access_token).unwrap();
    let second = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    assert!(state.logout_user_authorized(&user.id, &authority).unwrap());
    let first_session = first.session.as_ref().unwrap();
    let first_receipt = state
        .revoke_session_with_receipt(
            &user.id,
            &first_session.id,
            first_session.logout_capability.as_ref().unwrap(),
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert_eq!(first_receipt["status"], "revoked");
    assert!(crate::auth::authenticate_local_token(&state, &second.tokens.access_token).is_ok());
    state.logout_user(&user.id).unwrap();
    let second_session = second.session.as_ref().unwrap();
    let second_receipt = state
        .revoke_session_with_receipt(
            &user.id,
            &second_session.id,
            second_session.logout_capability.as_ref().unwrap(),
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert_eq!(second_receipt["status"], "revoked");
    assert!(crate::auth::authenticate_local_token(&state, &second.tokens.access_token).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_session_logout_retries_commit_one_receipt() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "receipt-race-fixture".into(),
        ..Default::default()
    };
    let first = AppState::new(config.clone()).unwrap();
    let second = AppState::new(config).unwrap();
    let user = first
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = first
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let session = login.session.unwrap();
    let operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = [first.clone(), second]
        .into_iter()
        .map(|state| {
            let barrier = barrier.clone();
            let owner = user.id.clone();
            let session = session.clone();
            let operation = operation.clone();
            let incarnation = incarnation.clone();
            std::thread::spawn(move || {
                barrier.wait();
                state.revoke_session_with_receipt(
                    &owner,
                    &session.id,
                    session.logout_capability.as_ref().unwrap(),
                    &operation,
                    &incarnation,
                )
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap().unwrap())
        .collect();
    assert_eq!(results[0], results[1]);
    assert_eq!(
        first
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM auth_session_logout_receipts",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(first
        .refresh_auth(&login.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_http_input_rechecks_a_revoked_session_after_request_admission() {
    use axum::{
        body::Body,
        extract::Request,
        http::{header, StatusCode},
        middleware::{self, Next},
        routing::post,
        Router,
    };
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tower::ServiceExt;

    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "terminal-input-revocation-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state.issue_auth_session_for_test(user.clone()).unwrap();
    let (_, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let terminal = state
        .terminal_manager()
        .create_session(
            &user.id,
            crate::terminal::TerminalCreateOptions {
                cwd: Some(data.path().to_string_lossy().into_owned()),
                cols: None,
                rows: None,
                title: None,
                shell: Some("/bin/sh".into()),
                sandbox_mode: None,
                sandbox_workspace_root: None,
                initial_command: None,
            },
        )
        .await
        .unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let barrier = {
        let entered = entered.clone();
        let release = release.clone();
        middleware::from_fn(move |request: Request, next: Next| {
            let entered = entered.clone();
            let release = release.clone();
            async move {
                entered.notify_one();
                release.notified().await;
                next.run(request).await
            }
        })
    };
    let router = Router::new()
        .route(
            "/api/terminal/{id}/input",
            post(crate::write_terminal_input),
        )
        .route_layer(barrier)
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_auth,
        ))
        .with_state(state.clone());
    let marker = data.path().join("unexpected-input");
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/terminal/{}/input", terminal.id))
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", login.tokens.access_token),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({"command": format!("printf sent > '{}'\n", marker.display())})
                .to_string(),
        ))
        .unwrap();
    let pending = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    assert!(state.logout_user_authorized(&user.id, &authority).unwrap());
    release.notify_one();
    let response = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    state
        .terminal_manager()
        .close(&user.id, &terminal.id)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(!marker.exists(), "revoked request wrote to the terminal");
}

#[cfg(unix)]
#[tokio::test]
async fn revoked_upgraded_session_cannot_admit_terminal_input() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "input-session-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state.enable_supervised_input_for_test();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let fresh = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let (_, old_authority) =
        crate::auth::authenticate_local_with_authority(&state, &old.tokens.access_token).unwrap();
    let (_, fresh_authority) =
        crate::auth::authenticate_local_with_authority(&state, &fresh.tokens.access_token).unwrap();
    assert!(state
        .logout_user_authorized(&user.id, &old_authority)
        .unwrap());
    {
        let guard = state.acquire_input_guard(&user.id).unwrap();
        assert!(state
            .prepare_legacy_input_guard(&user.id, Some(&old_authority), &guard, "fixture-session")
            .is_err());
        assert!(state
            .validate_native_owner_guard(&user.id, &old_authority, &guard)
            .is_err());
        assert!(state
            .prepare_legacy_input_guard(&user.id, Some(&fresh_authority), &guard, "fixture-session")
            .is_ok());
        assert!(state
            .validate_native_owner_guard(&user.id, &fresh_authority, &guard)
            .is_ok());
    }
    assert!(state.input_watermark(&user.id, &old_authority).is_err());
    assert!(state.input_watermark(&user.id, &fresh_authority).is_ok());
    let admission = state.local_admission().unwrap();
    assert!(admission
        .accept::<(), String>(&user.id, &old_authority, |_| Ok(()))
        .is_err());
    assert!(admission
        .accept::<(), String>(&user.id, &fresh_authority, |_| Ok(()))
        .unwrap()
        .0
        .is_ok());
    let session_id = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    assert!(state
        .issue_input_operation(&user.id, &old_authority, &session_id, &incarnation, 1)
        .is_err());
    assert!(state
        .issue_input_operation(&user.id, &fresh_authority, &session_id, &incarnation, 1)
        .is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn queued_session_authority_is_revoked_without_affecting_new_login() {
    use crate::followup_queue::{IdleBoundary, Mutation, QueueOperation, QueueScope, QueueStore};
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "queue-auth-session-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let fresh = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let (_, old_authority) =
        crate::auth::authenticate_local_with_authority(&state, &old.tokens.access_token).unwrap();
    let (_, fresh_authority) =
        crate::auth::authenticate_local_with_authority(&state, &fresh.tokens.access_token).unwrap();
    crate::vault::VaultCipher::load(data.path()).unwrap();
    let scope = QueueScope::new(
        &user.id,
        workspace.path(),
        "ss-00000000000000000000000000000001",
    )
    .unwrap();
    let store = QueueStore::new(data.path(), Uuid::new_v4());
    let incarnation = Uuid::new_v4();
    let admission = state.local_admission().unwrap();
    let (result, committed) = admission
        .accept(&user.id, &old_authority, |check| {
            store.mutate_authorized_checked(
                &scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "queued investigation".into(),
                        run_when_idle: true,
                    },
                },
                &old_authority,
                check,
            )
        })
        .unwrap();
    assert!(committed);
    let revision = result.unwrap().queue_revision;
    let reservation = store
        .reserve_next(&scope, revision, IdleBoundary { turn_epoch: 1 })
        .unwrap()
        .unwrap();
    let proof = store
        .verify_reservation_authority(&scope, incarnation, &reservation)
        .unwrap()
        .unwrap();
    let restored = crate::auth::LocalAuthority::from_verified_queue(proof).unwrap();
    assert_eq!(
        restored.session_id(),
        old.session.as_ref().map(|session| session.id.as_str())
    );
    assert!(state
        .logout_user_authorized(&user.id, &old_authority)
        .unwrap());
    assert!(admission
        .accept::<(), String>(&user.id, &restored, |_| Ok(()))
        .is_err());
    assert!(admission
        .accept::<(), String>(&user.id, &fresh_authority, |_| Ok(()))
        .unwrap()
        .0
        .is_ok());
}

#[cfg(unix)]
#[test]
fn legacy_queue_publication_is_ordered_against_authentication_upgrade() {
    use std::time::Duration;
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "legacy-queue-cutover-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let admission = state.local_admission().unwrap();
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let owner = user.id.clone();
    let publication = std::thread::spawn(move || {
        admission.accept_legacy_queue(&owner, |check| {
            check()?;
            entered.send(()).unwrap();
            wait_release
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "publication test timed out".to_string())?;
            check()?;
            Ok::<_, String>("published")
        })
    });
    wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let (finished, wait_finished) = std::sync::mpsc::channel();
    let upgrade_state = state.clone();
    let upgrade_user = user.clone();
    let upgrade = std::thread::spawn(move || {
        let result = upgrade_state.issue_auth_result_for_public_user_protocol(upgrade_user, 1);
        finished.send(()).unwrap();
        result
    });
    assert!(matches!(
        wait_finished.recv_timeout(Duration::from_millis(100)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ));
    release.send(()).unwrap();
    assert_eq!(
        publication.join().unwrap().unwrap(),
        (Ok("published"), true)
    );
    upgrade.join().unwrap().unwrap();
    let admission = state.local_admission().unwrap();
    assert!(admission
        .accept_legacy_queue::<(), String>(&user.id, |_| panic!("stale queued work was published"))
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn signed_out_upgraded_session_cannot_approve_agent_actions() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "approval-session-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let fresh = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let (_, old_authority) =
        crate::auth::authenticate_local_with_authority(&state, &old.tokens.access_token).unwrap();
    let (_, fresh_authority) =
        crate::auth::authenticate_local_with_authority(&state, &fresh.tokens.access_token).unwrap();
    assert!(state
        .logout_user_authorized(&user.id, &old_authority)
        .unwrap());
    {
        let guard = state.acquire_input_guard(&user.id).unwrap();
        let context = crate::structured::PairedDecisionContext::local_for_test(
            state.clone(),
            user.id.clone(),
            guard,
            old_authority,
        );
        assert!(context.check_for_test().is_err());
    }
    let guard = state.acquire_input_guard(&user.id).unwrap();
    let context = crate::structured::PairedDecisionContext::local_for_test(
        state,
        user.id,
        guard,
        fresh_authority,
    );
    assert!(context.check_for_test().is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn session_logout_receipt_accepts_non_uuid_external_owner_id() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "external-owner-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let owner = "external-user-fixture";
    state.upsert_external_auth_mirror_user(owner).unwrap();
    let user = terminal_v4_core::UserPublic {
        id: owner.into(),
        username: "fixture".into(),
        created_at: iso_timestamp(),
    };
    let login = state
        .issue_auth_result_for_public_user_protocol(user, 1)
        .unwrap();
    let session = login.session.as_ref().unwrap();
    assert!(state
        .revoke_session_with_receipt(
            owner,
            &session.id,
            session.logout_capability.as_ref().unwrap(),
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string()
        )
        .is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn lost_session_logout_receipt_is_not_treated_as_a_new_operation() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "receipt-loss-fixture".into(),
        ..Default::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let session = login.session.as_ref().unwrap();
    let capability = session.logout_capability.as_ref().unwrap();
    let operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    state
        .revoke_session_with_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .unwrap();
    state
        .lock_db()
        .unwrap()
        .execute(
            "DELETE FROM auth_session_logout_receipts WHERE operation=?",
            [&operation],
        )
        .unwrap();
    let reopened = AppState::new(config.clone()).unwrap();
    assert!(reopened
        .lookup_session_logout_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .is_err());
    assert!(reopened
        .revoke_session_with_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .is_err());
    reopened
        .lock_db()
        .unwrap()
        .execute_batch("DROP TABLE auth_session_logout_receipts")
        .unwrap();
    let reopened_again = AppState::new(config).unwrap();
    assert!(reopened_again
        .lookup_session_logout_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn session_logout_receipts_have_a_fail_closed_limit() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "receipt-limit-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let session = login.session.as_ref().unwrap();
    let capability = session.logout_capability.as_ref().unwrap();
    let first_operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    let first = state
        .revoke_session_with_receipt(
            &user.id,
            &session.id,
            capability,
            &first_operation,
            &incarnation,
        )
        .unwrap();
    for _ in 1..64 {
        state
            .revoke_session_with_receipt(
                &user.id,
                &session.id,
                capability,
                &Uuid::new_v4().to_string(),
                &incarnation,
            )
            .unwrap();
    }
    assert!(state
        .revoke_session_with_receipt(
            &user.id,
            &session.id,
            capability,
            &Uuid::new_v4().to_string(),
            &incarnation
        )
        .is_err());
    assert_eq!(
        state
            .revoke_session_with_receipt(
                &user.id,
                &session.id,
                capability,
                &first_operation,
                &incarnation
            )
            .unwrap(),
        first
    );
}

#[cfg(unix)]
#[tokio::test]
async fn receipt_count_write_failure_rolls_back_revocation_and_receipt() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "receipt-count-rollback-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let session = login.session.as_ref().unwrap();
    let capability = session.logout_capability.as_ref().unwrap();
    let operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    state.lock_db().unwrap().execute_batch("CREATE TRIGGER fail_receipt_count BEFORE UPDATE OF receipt_count ON auth_sessions BEGIN SELECT RAISE(ABORT, 'count failure'); END;").unwrap();
    assert!(state
        .revoke_session_with_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .is_err());
    assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_ok());
    assert!(state
        .lookup_session_logout_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .unwrap()
        .is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn legacy_session_with_existing_receipts_fails_closed_after_count_migration() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "receipt-migration-fixture".into(),
        ..Default::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .issue_auth_result_for_public_user_protocol(user.clone(), 1)
        .unwrap();
    let session = login.session.as_ref().unwrap();
    let capability = session.logout_capability.as_ref().unwrap();
    let operation = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    state
        .revoke_session_with_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .unwrap();
    state
        .lock_db()
        .unwrap()
        .execute_batch("ALTER TABLE auth_sessions DROP COLUMN receipt_count")
        .unwrap();
    let reopened = AppState::new(config).unwrap();
    assert!(reopened
        .lookup_session_logout_receipt(&user.id, &session.id, capability, &operation, &incarnation)
        .is_err());
}

#[tokio::test]
async fn delayed_logout_cannot_revoke_a_new_login() {
    use axum::extract::{Extension, State};

    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "delayed-logout-fixture".into(),
        ..AppConfig::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let other = AppState::new(config).unwrap();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let first = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (stale_user, stale_authority) =
        crate::auth::authenticate_local_with_authority(&state, &first.tokens.access_token).unwrap();

    state.logout_user(&first.user.id).unwrap();
    let fresh = other
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let result = crate::logout(
        State(other.clone()),
        Extension(stale_user),
        Some(Extension(stale_authority)),
    )
    .await;
    assert!(
        matches!(result, Err(ref error) if error.status == axum::http::StatusCode::UNAUTHORIZED)
    );
    assert!(crate::auth::authenticate_local_token(&other, &fresh.tokens.access_token).is_ok());
    assert!(other
        .refresh_auth(&fresh.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn admitted_logout_rechecks_authority_after_another_server_signs_in() {
    use axum::{
        body::Body,
        extract::Request,
        http::{header, StatusCode},
        middleware::{self, Next},
        routing::post,
        Router,
    };
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tower::ServiceExt;

    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "admitted-logout-fixture".into(),
        ..AppConfig::default()
    };
    let first = AppState::new(config.clone()).unwrap();
    let second = AppState::new(config).unwrap();
    first
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let old = first
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let barrier = {
        let entered = entered.clone();
        let release = release.clone();
        middleware::from_fn(move |request: Request, next: Next| {
            let entered = entered.clone();
            let release = release.clone();
            async move {
                entered.notify_one();
                release.notified().await;
                next.run(request).await
            }
        })
    };
    let router = Router::new()
        .route("/api/auth/logout", post(crate::logout))
        .route_layer(barrier)
        .route_layer(middleware::from_fn_with_state(
            first.clone(),
            crate::auth::require_auth,
        ))
        .with_state(first);
    let request = Request::builder()
        .method("POST")
        .uri("/api/auth/logout")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", old.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    let delayed = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    #[cfg(unix)]
    {
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "state::refresh_tests::logout_process_fixture",
                "--ignored",
            ])
            .env("V4_TEST_LOGOUT_DATA", data.path())
            .env("V4_TEST_LOGOUT_OWNER", &old.user.id)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(20), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
    }
    #[cfg(not(unix))]
    second.logout_user(&old.user.id).unwrap();
    let fresh = second
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    release.notify_one();
    let response = tokio::time::timeout(Duration::from_secs(5), delayed)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
    assert!(crate::auth::authenticate_local_token(&second, &fresh.tokens.access_token).is_ok());
    assert!(second
        .refresh_auth(&fresh.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn logout_rejects_missing_foreign_or_expired_authority_without_revocation() {
    use axum::extract::{Extension, State};

    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "invalid-logout-fixture".into(),
        ..AppConfig::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let login = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let now = crate::v4_agent::interaction::now_ms();
    let cases = [
        None,
        Some(Extension(crate::auth::LocalAuthority::for_test(
            "other-owner",
            0,
            now + 60_000,
        ))),
        Some(Extension(crate::auth::LocalAuthority::for_test(
            &user.user_id,
            0,
            now - 1,
        ))),
    ];
    for authority in cases {
        let result = crate::logout(State(state.clone()), Extension(user.clone()), authority).await;
        assert!(
            matches!(result, Err(ref error) if error.status == axum::http::StatusCode::UNAUTHORIZED)
        );
        assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_ok());
    }
    assert!(state
        .refresh_auth(&login.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[test]
#[ignore = "invoked by the cross-process logout test"]
fn logout_process_fixture() {
    let data = std::env::var_os("V4_TEST_LOGOUT_DATA").unwrap();
    let owner = std::env::var("V4_TEST_LOGOUT_OWNER").unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    })
    .unwrap();
    state.logout_user(&owner).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_from_another_process_fences_the_owner_manager() {
    use crate::v4_agent::background_process::{bootstrap, owner_gate::OwnerGate};
    use std::{process::Stdio, time::Duration};

    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let login = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = {
        let mut db = state.lock_db().unwrap();
        bootstrap::open_or_provision(data.path(), &mut db).unwrap()
    };
    let gate = OwnerGate::open(Connection::open(data.path().join("terminal.db")).unwrap()).unwrap();
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "state::refresh_tests::logout_process_fixture",
            "--ignored",
        ])
        .env("V4_TEST_LOGOUT_DATA", data.path())
        .env("V4_TEST_LOGOUT_OWNER", &login.user.id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(20), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_err());
    assert!(gate.admit_generation(&login.user.id, 0, || Ok(())).is_err());
    let request: String = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM background_owner_holds WHERE owner=?1 AND state='held'",
            [&login.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
    gate.release(&login.user.id, &request).unwrap();
    assert!(gate.admit_generation(&login.user.id, 0, || Ok(())).is_err());
    assert!(gate.admit_generation(&login.user.id, 1, || Ok(())).is_ok());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_http_reports_success_or_control_failure_without_partial_revocation() {
    use crate::v4_agent::background_process::{bootstrap, owner_gate::OwnerGate};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    };
    let owner = AppState::new(config.clone()).unwrap();
    owner
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let login = owner
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = {
        let mut db = owner.lock_db().unwrap();
        bootstrap::open_or_provision(data.path(), &mut db).unwrap()
    };
    let remote = AppState::new(config).unwrap();
    let response = crate::app(remote)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(
                    "Authorization",
                    format!("Bearer {}", login.tokens.access_token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(crate::auth::authenticate_local_token(&owner, &login.tokens.access_token).is_err());
    let gate = OwnerGate::open(Connection::open(data.path().join("terminal.db")).unwrap()).unwrap();
    assert!(gate.admit_generation(&login.user.id, 0, || Ok(())).is_err());
    let request: String = owner
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM background_owner_holds WHERE owner=?1 AND state='held'",
            [&login.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
    gate.release(&login.user.id, &request).unwrap();
    let fresh = owner
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    owner
        .lock_db()
        .unwrap()
        .execute("DROP TABLE background_owner_holds", [])
        .unwrap();
    let failed = crate::app(owner.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(
                    "Authorization",
                    format!("Bearer {}", fresh.tokens.access_token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(crate::auth::authenticate_local_token(&owner, &fresh.tokens.access_token).is_ok());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_publishes_and_renews_background_holds_across_servers_atomically() {
    use crate::v4_agent::background_process::{bootstrap, owner_gate::OwnerGate};

    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    };
    let first = AppState::new(config.clone()).unwrap();
    first
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let login = first
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = {
        let mut db = first.lock_db().unwrap();
        bootstrap::open_or_provision(data.path(), &mut db).unwrap()
    };
    let second = AppState::new(config).unwrap();
    let gate = OwnerGate::open(Connection::open(data.path().join("terminal.db")).unwrap()).unwrap();
    second.logout_user(&login.user.id).unwrap();
    assert!(crate::auth::authenticate_local_token(&first, &login.tokens.access_token).is_err());
    let read_hold = || -> (String, String) {
        first
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT request,state FROM background_owner_holds WHERE owner=?1",
                [&login.user.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    };
    let (first_request, state) = read_hold();
    assert_eq!(state, "held");
    assert!(gate.admit_generation(&login.user.id, 0, || Ok(())).is_err());
    assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
    assert_eq!(read_hold().1, "acknowledged");
    first.logout_user(&login.user.id).unwrap();
    let (second_request, state) = read_hold();
    assert_ne!(first_request, second_request);
    assert_eq!(state, "held");
    assert!(gate.release(&login.user.id, &first_request).is_err());
    assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
    gate.release(&login.user.id, &second_request).unwrap();
    assert!(gate.admit_generation(&login.user.id, 0, || Ok(())).is_err());
    assert!(gate.admit_generation(&login.user.id, 2, || Ok(())).is_ok());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_fails_closed_when_installed_background_control_is_missing() {
    use crate::v4_agent::background_process::bootstrap;
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let login = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = {
        let mut db = state.lock_db().unwrap();
        bootstrap::open_or_provision(data.path(), &mut db).unwrap()
    };
    state
        .lock_db()
        .unwrap()
        .execute("DROP TABLE background_owner_holds", [])
        .unwrap();
    assert!(state.logout_user(&login.user.id).is_err());
    assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_ok());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn failed_logout_rolls_back_the_background_hold_and_token_revocation() {
    use crate::v4_agent::background_process::bootstrap;

    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let login = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = {
        let mut db = state.lock_db().unwrap();
        bootstrap::open_or_provision(data.path(), &mut db).unwrap()
    };
    state.lock_db().unwrap().execute_batch("CREATE TRIGGER reject_logout_generation BEFORE INSERT ON auth_generations BEGIN SELECT RAISE(FAIL, 'fixture failure'); END").unwrap();
    assert!(state.logout_user(&login.user.id).is_err());
    assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_ok());
    let count: i64 = state
        .lock_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM background_owner_holds", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn logout_revokes_owner_access_and_preview_tokens_across_servers_without_affecting_other_owners(
) {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    };
    let first = AppState::new(config.clone()).unwrap();
    first
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    first
        .create_local_user_for_test("bob", "fixture-password")
        .unwrap();
    let alice = first
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let alice_second = first
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let bob = first
        .login("bob", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let preview =
        crate::auth::preview_token_for_access(&first, &alice.tokens.access_token).unwrap();
    let resource =
        crate::preview::auth_urls::resource_token(&first, &preview, "/preview/fixture").unwrap();
    let second = AppState::new(config.clone()).unwrap();
    assert!(crate::auth::authenticate_local_token(&second, &alice.tokens.access_token).is_ok());
    assert!(crate::auth::authenticate_runtime_preview_token(
        &second,
        &preview,
        "/api/preview/session"
    )
    .is_ok());
    assert!(crate::preview::auth_urls::authenticate_resource_token(
        &second,
        &resource,
        "GET",
        "/preview/fixture"
    )
    .is_ok());

    first.logout_user(&alice.user.id).unwrap();
    for token in [
        &alice.tokens.access_token,
        &alice_second.tokens.access_token,
    ] {
        assert!(crate::auth::authenticate_local_token(&second, token).is_err());
    }
    assert!(crate::auth::authenticate_runtime_preview_token(
        &second,
        &preview,
        "/api/preview/session"
    )
    .is_err());
    assert!(crate::auth::preview_token_for_access(&second, &alice.tokens.access_token).is_err());
    assert!(crate::preview::auth_urls::authenticate_resource_token(
        &second,
        &resource,
        "GET",
        "/preview/fixture"
    )
    .is_err());
    assert!(
        crate::preview::auth_urls::resource_token(&second, &resource, "/preview/fixture").is_none()
    );
    assert!(second
        .refresh_auth(&alice.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
    assert!(crate::auth::authenticate_local_token(&second, &bob.tokens.access_token).is_ok());
    let fresh = second
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    assert!(crate::auth::authenticate_local_token(&first, &fresh.tokens.access_token).is_ok());
    let fresh_preview =
        crate::auth::preview_token_for_access(&first, &fresh.tokens.access_token).unwrap();
    assert!(crate::auth::authenticate_runtime_preview_token(
        &second,
        &fresh_preview,
        "/api/preview/session"
    )
    .is_ok());
    assert!(crate::auth::authenticate_local_token(&first, &alice.tokens.access_token).is_err());
}

#[tokio::test]
async fn failed_logout_does_not_advance_access_generation_or_consume_refresh() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-revocation-test".into(),
        ..AppConfig::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let alice = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    state.lock_db().unwrap().execute_batch("CREATE TRIGGER reject_logout BEFORE DELETE ON refresh_tokens BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END;").unwrap();
    assert!(state.logout_user(&alice.user.id).is_err());
    assert!(crate::auth::authenticate_local_token(&state, &alice.tokens.access_token).is_ok());
    state
        .lock_db()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_logout;")
        .unwrap();
    assert!(state
        .refresh_auth(&alice.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

struct PausedExternalAuth {
    user: ExternalAuthUser,
    entered: Semaphore,
    resume: Semaphore,
}

#[async_trait]
impl ExternalAuthProvider for PausedExternalAuth {
    async fn get_user_by_identifier(&self, _: &str) -> Result<Option<ExternalAuthUser>, String> {
        Ok(Some(self.user.clone()))
    }

    async fn get_user_by_id(&self, _: &str) -> Result<Option<ExternalAuthUser>, String> {
        self.entered.add_permits(1);
        self.resume.acquire().await.unwrap().forget();
        Ok(Some(self.user.clone()))
    }
}

fn external_state() -> (
    tempfile::TempDir,
    AppState,
    Arc<PausedExternalAuth>,
    AuthResult,
) {
    let data = tempfile::tempdir().unwrap();
    let provider = Arc::new(PausedExternalAuth {
        user: ExternalAuthUser {
            id: Uuid::new_v4().to_string(),
            email: "synthetic@example.invalid".into(),
            password_hash: "unused".into(),
            display_name: Some("synthetic".into()),
            created_at: iso_timestamp(),
        },
        entered: Semaphore::new(0),
        resume: Semaphore::new(0),
    });
    let state = AppState::new_with_external_auth(
        AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "refresh-test-secret".into(),
            ..AppConfig::default()
        },
        Some(provider.clone()),
    )
    .unwrap();
    state
        .upsert_external_auth_mirror_user(&provider.user.id)
        .unwrap();
    let auth = state
        .issue_auth_result_for_external_user(provider.user.clone())
        .unwrap();
    (data, state, provider, auth)
}

#[tokio::test]
async fn concurrent_refresh_consumes_external_token_only_once() {
    let (_data, state, provider, auth) = external_state();
    let mut requests = Vec::new();
    for _ in 0..2 {
        let state = state.clone();
        let token = auth.tokens.refresh_token.clone();
        requests.push(tokio::spawn(async move {
            state.refresh_auth(&token).await.unwrap()
        }));
    }
    provider.entered.acquire_many(2).await.unwrap().forget();
    provider.resume.add_permits(2);
    let mut successful = Vec::new();
    for request in requests {
        if let Some(auth) = request.await.unwrap() {
            successful.push(auth);
        }
    }
    assert_eq!(
        successful.len(),
        1,
        "a refresh token must have one consumer"
    );
    assert!(state
        .refresh_auth(&auth.tokens.refresh_token)
        .await
        .unwrap()
        .is_none());
    let count: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM refresh_tokens WHERE user_id = ?",
            params![auth.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "only the winning replacement token is persisted");
    provider.resume.add_permits(1);
    assert!(state
        .refresh_auth(&successful[0].tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn logout_during_external_refresh_does_not_restore_a_session() {
    let (_data, state, provider, auth) = external_state();
    let request_state = state.clone();
    let request = tokio::spawn(async move {
        request_state
            .refresh_auth(&auth.tokens.refresh_token)
            .await
            .unwrap()
    });
    provider.entered.acquire().await.unwrap().forget();
    state.logout_user(&provider.user.id).unwrap();
    provider.resume.add_permits(1);
    assert!(
        request.await.unwrap().is_none(),
        "logout must win against an in-flight refresh"
    );
    let count: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM refresh_tokens WHERE user_id = ?",
            params![provider.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn failed_replacement_insert_preserves_original_refresh_token() {
    let (_data, state, provider, auth) = external_state();
    state
        .lock_db()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_replacement BEFORE INSERT ON refresh_tokens
         BEGIN SELECT RAISE(FAIL, 'synthetic insertion failure'); END;",
        )
        .unwrap();
    provider.resume.add_permits(1);
    assert!(state
        .refresh_auth(&auth.tokens.refresh_token)
        .await
        .is_err());
    state
        .lock_db()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_replacement;")
        .unwrap();
    provider.resume.add_permits(1);
    assert!(state
        .refresh_auth(&auth.tokens.refresh_token)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn expiration_during_external_refresh_is_rechecked_before_rotation() {
    let (_data, state, provider, auth) = external_state();
    let request_state = state.clone();
    let request = tokio::spawn(async move {
        request_state
            .refresh_auth(&auth.tokens.refresh_token)
            .await
            .unwrap()
    });
    provider.entered.acquire().await.unwrap().forget();
    state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE refresh_tokens SET expires_at = ? WHERE user_id = ?",
            params!["2000-01-01T00:00:00Z", provider.user.id],
        )
        .unwrap();
    provider.resume.add_permits(1);
    assert!(request.await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_local_refresh_has_one_winner_and_password_change_revokes_it() {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new_with_external_auth(
        AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "local-refresh-test-secret".into(),
            ..AppConfig::default()
        },
        None,
    )
    .unwrap();
    let user = state
        .create_local_user_for_test("synthetic-local", "previous-password")
        .unwrap();
    let auth = state
        .issue_auth_result_for_public_user(user.clone())
        .unwrap();
    let consumers = 16;
    let barrier = Arc::new(tokio::sync::Barrier::new(consumers));
    let mut requests = Vec::new();
    for _ in 0..consumers {
        let state = state.clone();
        let token = auth.tokens.refresh_token.clone();
        let barrier = barrier.clone();
        requests.push(tokio::spawn(async move {
            barrier.wait().await;
            state.refresh_auth(&token).await.unwrap()
        }));
    }
    let mut replacements = Vec::new();
    for request in requests {
        if let Some(auth) = request.await.unwrap() {
            replacements.push(auth.tokens.refresh_token);
        }
    }
    assert_eq!(replacements.len(), 1);
    let authenticated = AuthenticatedUser {
        user_id: user.id,
        username: user.username,
    };
    assert_eq!(
        state
            .change_password(&authenticated, "previous-password", "replacement-password")
            .unwrap(),
        ChangePasswordResult::Changed
    );
    assert!(state
        .refresh_auth(&replacements[0])
        .await
        .unwrap()
        .is_none());
}
