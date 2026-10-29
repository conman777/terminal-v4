use super::*;
use std::time::Duration;

fn action(root: &std::path::Path, id: &str, command: &str) -> BackgroundRequest {
    BackgroundRequest {
        scope: BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: root.canonicalize().unwrap(),
            incarnation: None,
        },
        authorization_generation: Some(0),
        action_id: id.into(),
        command: command.into(),
        timeout: Duration::from_secs(10),
    }
}

async fn settled(manager: &BackgroundProcesses, request: &BackgroundRequest) -> BackgroundState {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = manager
                .snapshot(&request.scope, &request.action_id)
                .await
                .unwrap()
                .state;
            if state != BackgroundState::Running {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process did not finish")
}

#[cfg(unix)]
async fn provisioned(root: &std::path::Path) -> (crate::state::AppState, Arc<BackgroundProcesses>) {
    let app = crate::state::AppState::new(terminal_v4_core::AppConfig {
        data_dir: root.to_path_buf(),
        ..Default::default()
    })
    .unwrap();
    app.provision_owner_cleanup().unwrap();
    let manager = {
        let mut db = app.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(root, &mut db).unwrap())
    };
    (app, manager)
}

#[cfg(unix)]
fn authority(generation: i64, expires: i64) -> crate::auth::LocalAuthority {
    crate::auth::LocalAuthority::for_test("owner", generation, expires)
}

#[cfg(unix)]
fn future() -> i64 {
    super::super::interaction::now_ms() + 60_000
}

#[cfg(unix)]
async fn standalone(
    manager: &Arc<BackgroundProcesses>,
    app: &crate::state::AppState,
    authority: crate::auth::LocalAuthority,
    operation: uuid::Uuid,
    acknowledged: bool,
) -> Result<usize, String> {
    let (manager, app) = (manager.clone(), app.clone());
    tokio::task::spawn_blocking(move || {
        manager.review_unknown_owner_standalone(&app, "owner", &authority, operation, acknowledged)
    })
    .await
    .unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn standalone_review_unblocks_a_crash_unknown_claim_without_replaying_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (app, first) = provisioned(&root).await;
    let crashed = action(&root, "crashed", "touch replayed");
    first
        .ledger
        .claim(&crashed.scope, &crashed.action_id)
        .unwrap();
    drop(first);
    let manager = {
        let mut db = app.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(&root, &mut db).unwrap())
    };
    let fresh = action(&root, "fresh", "exit 0");
    assert!(manager.start(fresh.clone(), Some(&fresh)).await.is_err());
    assert!(manager.session_has_outstanding("owner", "session").unwrap());

    let operation = uuid::Uuid::new_v4();
    assert!(
        standalone(&manager, &app, authority(1, future()), operation, true)
            .await
            .is_err()
    );
    assert!(standalone(&manager, &app, authority(0, 0), operation, true)
        .await
        .is_err());
    assert!(
        standalone(&manager, &app, authority(0, future()), operation, false)
            .await
            .is_err()
    );
    assert!(manager.ledger.has_unknown_owner("owner").unwrap());

    assert_eq!(
        standalone(&manager, &app, authority(0, future()), operation, true)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        standalone(&manager, &app, authority(0, future()), operation, true)
            .await
            .unwrap(),
        1,
        "a retried review is idempotent"
    );
    assert!(!manager.session_has_outstanding("owner", "session").unwrap());
    assert_eq!(
        manager
            .ledger
            .read(&crashed.scope, &crashed.action_id)
            .unwrap(),
        BackgroundState::Unknown
    );
    assert!(manager
        .ledger
        .claim(&crashed.scope, &crashed.action_id)
        .is_err());
    manager.start(fresh.clone(), Some(&fresh)).await.unwrap();
    assert_eq!(
        settled(&manager, &fresh).await,
        BackgroundState::Exited { code: Some(0) }
    );
    assert!(!root.join("replayed").exists());
    let audits: i64 = app
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM structured_owner_background_reviews WHERE owner='owner' AND count=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audits, 1);
    manager.shutdown().await.unwrap();
    drop(manager);
    let mut db = app.lock_db().unwrap();
    let reopened = bootstrap::open_or_provision(&root, &mut db).unwrap();
    assert!(!reopened.ledger.has_unknown_owner("owner").unwrap());
    assert_eq!(
        reopened
            .ledger
            .read(&crashed.scope, &crashed.action_id)
            .unwrap(),
        BackgroundState::Unknown
    );
}

#[cfg(unix)]
#[tokio::test]
async fn standalone_review_is_refused_while_a_cleanup_hold_exists() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (app, manager) = provisioned(&root).await;
    let unknown = action(&root, "unknown", "exit 0");
    manager
        .ledger
        .claim(&unknown.scope, &unknown.action_id)
        .unwrap();
    app.logout_user("owner").unwrap();
    assert!(standalone(
        &manager,
        &app,
        authority(1, future()),
        uuid::Uuid::new_v4(),
        true
    )
    .await
    .is_err());
    assert!(manager.ledger.has_unknown_owner("owner").unwrap());
    manager.shutdown().await.ok();
}

#[cfg(unix)]
#[tokio::test]
async fn standalone_review_cannot_attest_while_a_tracked_process_is_running() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (app, manager) = provisioned(&root).await;
    let running = action(&root, "running", "sleep 30");
    manager
        .start(running.clone(), Some(&running))
        .await
        .unwrap();
    let mut late = running.clone();
    late.action_id = "late".into();
    manager.ledger.claim(&late.scope, &late.action_id).unwrap();
    assert!(standalone(
        &manager,
        &app,
        authority(0, future()),
        uuid::Uuid::new_v4(),
        true
    )
    .await
    .is_err());
    assert!(manager.session_has_outstanding("owner", "session").unwrap());
    manager
        .cancel(&running.scope, &running.action_id)
        .await
        .unwrap();
    assert_eq!(
        settled(&manager, &running).await,
        BackgroundState::Cancelled
    );
    manager.shutdown().await.ok();
}

#[cfg(unix)]
#[tokio::test]
async fn settlement_query_tracks_a_running_command_until_its_outcome_commits() {
    let temp = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&temp.path().canonicalize().unwrap().join("ledger")).unwrap();
    let running = action(temp.path(), "settle", "sleep 30");
    assert!(!manager.session_has_outstanding("owner", "session").unwrap());
    manager
        .start(running.clone(), Some(&running))
        .await
        .unwrap();
    assert!(manager.session_has_outstanding("owner", "session").unwrap());
    assert!(!manager
        .session_has_outstanding("owner", "elsewhere")
        .unwrap());
    assert!(!manager
        .session_has_outstanding("another", "session")
        .unwrap());
    manager
        .cancel(&running.scope, &running.action_id)
        .await
        .unwrap();
    assert_eq!(
        settled(&manager, &running).await,
        BackgroundState::Cancelled
    );
    assert!(!manager.session_has_outstanding("owner", "session").unwrap());
    assert!(manager.session_has_outstanding("", "session").is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn completion_is_delivered_once_after_the_ledger_commits_and_carries_no_output() {
    let temp = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&temp.path().canonicalize().unwrap().join("ledger")).unwrap();
    let mut events = manager.subscribe_completions();
    let command = action(temp.path(), "done", "printf secret-output; exit 3");
    manager
        .start(command.clone(), Some(&command))
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        event,
        BackgroundCompletion {
            scope: command.scope.clone(),
            action_id: "done".into(),
            state: BackgroundState::Exited { code: Some(3) },
        }
    );
    assert_eq!(
        manager.ledger.read(&command.scope, "done").unwrap(),
        BackgroundState::Exited { code: Some(3) }
    );
    assert!(!format!("{event:?}").contains("secret-output"));
    assert!(events.try_recv().is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn completion_for_a_cancelled_command_reports_cancellation() {
    let temp = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&temp.path().canonicalize().unwrap().join("ledger")).unwrap();
    let mut events = manager.subscribe_completions();
    let command = action(temp.path(), "stop", "sleep 30");
    manager
        .start(command.clone(), Some(&command))
        .await
        .unwrap();
    manager.cancel(&command.scope, "stop").await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.state, BackgroundState::Cancelled);
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[test]
fn finished_receipts_are_pruned_oldest_first_but_unfinished_ones_never_are() {
    let temp = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&temp.path().canonicalize().unwrap().join("ledger")).unwrap();
    let base = action(temp.path(), "unused", "exit 0").scope;
    for index in 0..MAX_SESSION_ACTIONS {
        let key = manager.ledger.claim(&base, &format!("a-{index}")).unwrap();
        manager
            .ledger
            .finish(&key, &BackgroundState::Exited { code: Some(0) })
            .unwrap();
    }
    manager.ledger.claim(&base, "a-new").unwrap();
    assert!(manager.ledger.read(&base, "a-0").is_err());
    assert_eq!(
        manager
            .ledger
            .read(&base, &format!("a-{}", MAX_SESSION_ACTIONS - 1))
            .unwrap(),
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        manager.ledger.read(&base, "a-new").unwrap(),
        BackgroundState::Unknown
    );

    let mut pinned = base.clone();
    pinned.session = "pinned".into();
    for index in 0..MAX_SESSION_ACTIONS - 2 {
        manager
            .ledger
            .claim(&pinned, &format!("u-{index}"))
            .unwrap();
    }
    for index in 0..2 {
        let key = manager
            .ledger
            .claim(&pinned, &format!("t-{index}"))
            .unwrap();
        manager
            .ledger
            .finish(&key, &BackgroundState::Cancelled)
            .unwrap();
    }
    let refused = manager.ledger.claim(&pinned, "p-new").unwrap_err();
    assert!(refused.contains("capacity"), "{refused}");
    assert_eq!(
        manager.ledger.read(&pinned, "u-0").unwrap(),
        BackgroundState::Unknown
    );
    assert_eq!(
        manager.ledger.read(&pinned, "t-0").unwrap(),
        BackgroundState::Cancelled
    );
}

#[cfg(unix)]
#[test]
fn pruning_keeps_a_newest_window_per_session_and_other_sessions_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&temp.path().canonicalize().unwrap().join("ledger")).unwrap();
    let base = action(temp.path(), "unused", "exit 0").scope;
    let mut other = base.clone();
    other.session = "other".into();
    for index in 0..4 {
        let key = manager.ledger.claim(&other, &format!("o-{index}")).unwrap();
        manager
            .ledger
            .finish(&key, &BackgroundState::TimedOut)
            .unwrap();
    }
    for index in 0..MAX_SESSION_ACTIONS {
        let key = manager.ledger.claim(&base, &format!("a-{index}")).unwrap();
        manager
            .ledger
            .finish(&key, &BackgroundState::Exited { code: Some(0) })
            .unwrap();
    }
    for index in 0..20 {
        manager.ledger.claim(&base, &format!("n-{index}")).unwrap();
    }
    for index in 0..4 {
        assert_eq!(
            manager.ledger.read(&other, &format!("o-{index}")).unwrap(),
            BackgroundState::TimedOut
        );
    }
    let retained: Vec<usize> = (0..MAX_SESSION_ACTIONS)
        .filter(|index| manager.ledger.read(&base, &format!("a-{index}")).is_ok())
        .collect();
    assert_eq!(retained, (20..MAX_SESSION_ACTIONS).collect::<Vec<_>>());
    let exhausted = (0..MAX_SESSION_ACTIONS)
        .find(|index| manager.ledger.claim(&base, &format!("m-{index}")).is_err());
    assert_eq!(exhausted, Some(MAX_SESSION_ACTIONS - 20));
}

#[cfg(unix)]
mod standalone_review_routes {
    use super::*;
    use axum::{body::Body, http::Request, Extension};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const URL: &str = "/api/structured/background-review";

    fn router(
        app: &crate::state::AppState,
        authority: Option<crate::auth::LocalAuthority>,
    ) -> axum::Router {
        let router = crate::structured::ownership_recovery::routes().layer(Extension(
            crate::auth::AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            },
        ));
        match authority {
            Some(value) => router.layer(Extension(value)),
            None => router,
        }
        .with_state(app.clone())
    }

    async fn post(
        app: &crate::state::AppState,
        authority: Option<crate::auth::LocalAuthority>,
        body: serde_json::Value,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let response = router(app, authority)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(URL)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    async fn unknown(app: &crate::state::AppState) -> (bool, axum::http::StatusCode) {
        let response = router(app, None)
            .oneshot(Request::builder().uri(URL).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        (value["unknown"].as_bool().unwrap_or(false), status)
    }

    async fn bound_with_unknown(
        root: &std::path::Path,
    ) -> (crate::state::AppState, Arc<BackgroundProcesses>) {
        let (app, first) = provisioned(root).await;
        let crashed = action(root, "crashed", "touch replayed");
        first
            .ledger
            .claim(&crashed.scope, &crashed.action_id)
            .unwrap();
        drop(first);
        let manager = {
            let mut db = app.lock_db().unwrap();
            Arc::new(bootstrap::open_or_provision(root, &mut db).unwrap())
        };
        app.structured_session_manager()
            .bind_background_processes(manager.clone())
            .unwrap();
        (app, manager)
    }

    #[tokio::test]
    async fn route_reports_unknown_and_reviews_idempotently() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (app, manager) = bound_with_unknown(&root).await;
        assert_eq!(unknown(&app).await, (true, axum::http::StatusCode::OK));
        let operation = uuid::Uuid::new_v4();
        let body = serde_json::json!({"operationId":operation,"acknowledged":true});
        let expected =
            serde_json::json!({"status":"reviewed","operationId":operation,"reviewedCount":1});
        assert_eq!(
            post(&app, Some(authority(0, future())), body.clone()).await,
            (axum::http::StatusCode::OK, expected.clone())
        );
        assert_eq!(
            post(&app, Some(authority(0, future())), body).await,
            (axum::http::StatusCode::OK, expected)
        );
        assert_eq!(unknown(&app).await, (false, axum::http::StatusCode::OK));
        assert!(!root.join("replayed").exists());
        manager.shutdown().await.ok();
    }

    #[tokio::test]
    async fn cleanup_status_reports_unknown_commands_for_the_standalone_entry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (app, manager) = bound_with_unknown(&root).await;
        app.structured_session_manager()
            .bind_live_ownership()
            .unwrap();
        app.structured_session_manager()
            .bind_owner_cleanup(app.provision_owner_cleanup().unwrap())
            .unwrap();
        let fetch = || async {
            let response = router(&app, None)
                .oneshot(
                    Request::builder()
                        .uri("/api/structured/owner-cleanup")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };
        let before = fetch().await;
        assert_eq!(
            (before["state"].clone(), before["backgroundUnknown"].clone()),
            ("complete".into(), true.into())
        );
        post(
            &app,
            Some(authority(0, future())),
            serde_json::json!({"operationId":uuid::Uuid::new_v4(),"acknowledged":true}),
        )
        .await;
        assert_eq!(fetch().await["backgroundUnknown"], false);
        manager.shutdown().await.ok();
    }

    #[tokio::test]
    async fn route_refuses_bad_requests_and_stale_credentials_without_attesting() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (app, manager) = bound_with_unknown(&root).await;
        let operation = uuid::Uuid::new_v4();
        let body = |acknowledged: bool, operation: uuid::Uuid| serde_json::json!({"operationId":operation,"acknowledged":acknowledged});
        let fresh = || Some(authority(0, future()));
        assert_eq!(
            post(&app, fresh(), body(false, operation)).await.0,
            axum::http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(&app, fresh(), body(true, uuid::Uuid::nil())).await.0,
            axum::http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(
                &app,
                fresh(),
                serde_json::json!({"operationId":operation,"acknowledged":true,"extra":1})
            )
            .await
            .0,
            axum::http::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            post(&app, None, body(true, operation)).await.0,
            axum::http::StatusCode::FORBIDDEN
        );
        assert_eq!(
            post(&app, Some(authority(1, future())), body(true, operation))
                .await
                .0,
            axum::http::StatusCode::CONFLICT
        );
        assert_eq!(
            post(&app, Some(authority(0, 0)), body(true, operation))
                .await
                .0,
            axum::http::StatusCode::CONFLICT
        );
        assert!(manager.ledger.has_unknown_owner("owner").unwrap());
        manager.shutdown().await.ok();
    }

    #[tokio::test]
    async fn route_refuses_while_a_process_runs_and_when_commands_are_not_enabled() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (app, manager) = provisioned(&root).await;
        app.structured_session_manager()
            .bind_background_processes(manager.clone())
            .unwrap();
        let running = action(&root, "running", "sleep 30");
        manager
            .start(running.clone(), Some(&running))
            .await
            .unwrap();
        let mut late = running.clone();
        late.action_id = "late".into();
        manager.ledger.claim(&late.scope, &late.action_id).unwrap();
        let body = serde_json::json!({"operationId":uuid::Uuid::new_v4(),"acknowledged":true});
        let refused = post(&app, Some(authority(0, future())), body.clone()).await;
        assert_eq!(refused.0, axum::http::StatusCode::CONFLICT);
        assert!(manager.ledger.has_unknown_owner("owner").unwrap());
        manager
            .cancel(&running.scope, &running.action_id)
            .await
            .ok();
        manager.shutdown().await.ok();

        let other = tempfile::tempdir().unwrap();
        let unbound = crate::state::AppState::new(terminal_v4_core::AppConfig {
            data_dir: other.path().canonicalize().unwrap(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(unknown(&unbound).await.1, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(
            post(&unbound, Some(authority(0, future())), body).await.0,
            axum::http::StatusCode::NOT_FOUND
        );
    }
}

#[cfg(unix)]
mod startup_provisioning {
    use terminal_v4_core::AppConfig;

    async fn runtime(config: &AppConfig) -> crate::state::AppState {
        for _ in 0..100 {
            if let Ok(state) = crate::state::AppState::new_runtime(config.clone()) {
                return state;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("runtime did not start");
    }

    fn config(root: &std::path::Path) -> AppConfig {
        AppConfig {
            data_dir: root.to_path_buf(),
            ..Default::default()
        }
    }

    fn ledger_identity(root: &std::path::Path) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(root.join("background-processes/receipts.sqlite3")).unwrap();
        (meta.dev(), meta.ino())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_install_provisions_and_restart_reopens_the_same_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let first = runtime(&config(&root)).await;
        let manager = first.structured_session_manager();
        assert!(manager.background_processes_for_test().is_some());
        let identity = ledger_identity(&root);
        manager.shutdown().await.unwrap();
        drop(manager);
        drop(first);

        let second = runtime(&config(&root)).await;
        let manager = second.structured_session_manager();
        assert!(manager.background_processes_for_test().is_some());
        assert_eq!(ledger_identity(&root), identity);
        manager.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interrupted_or_lost_installation_leaves_the_feature_unavailable_not_the_server_down() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let first = runtime(&config(&root)).await;
        let manager = first.structured_session_manager();
        let database = first.lock_db().unwrap().path().unwrap().to_string();
        manager.shutdown().await.unwrap();
        drop(manager);
        drop(first);
        rusqlite::Connection::open(&database)
            .unwrap()
            .execute(
                "UPDATE background_ledger_installation SET state='initializing' WHERE id=1",
                [],
            )
            .unwrap();
        let identity = ledger_identity(&root);

        let interrupted = runtime(&config(&root)).await;
        let manager = interrupted.structured_session_manager();
        assert!(manager.background_processes_for_test().is_none());
        assert_eq!(ledger_identity(&root), identity);
        manager.shutdown().await.ok();
        drop(manager);
        drop(interrupted);

        rusqlite::Connection::open(&database)
            .unwrap()
            .execute(
                "UPDATE background_ledger_installation SET state='ready' WHERE id=1",
                [],
            )
            .unwrap();
        std::fs::remove_dir_all(root.join("background-processes")).unwrap();
        let lost = runtime(&config(&root)).await;
        let manager = lost.structured_session_manager();
        assert!(manager.background_processes_for_test().is_none());
        assert!(!root.join("background-processes").exists());
        manager.shutdown().await.ok();
    }
}
