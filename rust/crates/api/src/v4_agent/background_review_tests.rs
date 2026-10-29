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
