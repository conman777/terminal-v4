use super::*;
use async_trait::async_trait;
use tokio::sync::Semaphore;

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
