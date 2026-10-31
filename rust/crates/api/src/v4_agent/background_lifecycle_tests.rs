use super::*;
use crate::structured::{
    SpawnedStructuredProcess, StructuredProcessController, StructuredProvider,
    StructuredSessionManager, StructuredSpawnOptions,
};
use crate::v4_agent::interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction};
use async_trait::async_trait;
use serde_json::json;
use std::{path::Path, sync::Arc, time::Duration};
use terminal_v4_core::AppConfig;
use terminal_v4_core::StructuredSessionEvent;

#[test]
#[ignore = "invoked by the cross-process provisioning/deletion test"]
fn background_boundary_process_fixture() {
    let data = std::env::var_os("V4_TEST_BOUNDARY_DATA").unwrap();
    let ready = std::env::var_os("V4_TEST_BOUNDARY_READY").unwrap();
    let release = std::env::var_os("V4_TEST_BOUNDARY_RELEASE").unwrap();
    let _boundary = match (
        std::env::var("V4_TEST_BOUNDARY_OWNER"),
        std::env::var("V4_TEST_BOUNDARY_SESSION"),
    ) {
        (Ok(owner), Ok(session)) => {
            bootstrap::SessionBoundary::try_session(Path::new(&data), &owner, &session).unwrap()
        }
        _ => bootstrap::SessionBoundary::try_acquire(Path::new(&data)).unwrap(),
    };
    std::fs::write(ready, b"ready").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !Path::new(&release).exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(Path::new(&release).exists());
}

#[tokio::test]
async fn stalled_remote_deletion_does_not_block_an_unrelated_owner() {
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    let alice = manager
        .create_session(
            "alice",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let bob = loop {
        let candidate = manager
            .create_session(
                "bob",
                root.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        if bootstrap::session_stripe("alice", &alice.id)
            != bootstrap::session_stripe("bob", &candidate.id)
        {
            break candidate;
        }
        manager.delete_session("bob", &candidate.id).await.unwrap();
    };
    let ready = root.path().join("ready");
    let release = root.path().join("release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "v4_agent::background_process::lifecycle_tests::background_boundary_process_fixture",
            "--ignored",
        ])
        .env("V4_TEST_BOUNDARY_DATA", &data)
        .env("V4_TEST_BOUNDARY_OWNER", "alice")
        .env("V4_TEST_BOUNDARY_SESSION", &alice.id)
        .env("V4_TEST_BOUNDARY_READY", &ready)
        .env("V4_TEST_BOUNDARY_RELEASE", &release)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = ready.exists();
    let bob_result = if started {
        manager.delete_session("bob", &bob.id).await
    } else {
        Err("fixture did not start".into())
    };
    let alice_result = if started {
        manager.delete_session("alice", &alice.id).await
    } else {
        Err("fixture did not start".into())
    };
    std::fs::write(&release, b"release").unwrap();
    let exited = tokio::task::spawn_blocking(move || child.wait())
        .await
        .unwrap()
        .unwrap()
        .success();
    assert!(started && exited);
    bob_result.unwrap();
    assert!(alice_result.is_err());
    manager.delete_session("alice", &alice.id).await.unwrap();
    manager.shutdown().await.unwrap();
}

#[test]
#[ignore = "invoked by the cross-process first-provisioning test"]
fn background_provisioning_process_fixture() {
    let data = std::env::var_os("V4_TEST_BOUNDARY_DATA").unwrap();
    let mut db = rusqlite::Connection::open(Path::new(&data).join("terminal.db")).unwrap();
    drop(bootstrap::open_or_provision(Path::new(&data), &mut db).unwrap());
}

#[tokio::test]
async fn first_provisioning_in_another_process_fences_session_deletion_until_it_finishes() {
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.clone(),
        jwt_secret: "provision-fence".into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let ready = root.path().join("provision-ready");
    let release = root.path().join("provision-release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "v4_agent::background_process::lifecycle_tests::background_provisioning_process_fixture", "--ignored"])
        .env("V4_TEST_BOUNDARY_DATA", &data)
        .env("V4_TEST_BACKGROUND_PROVISION_READY", &ready)
        .env("V4_TEST_BACKGROUND_PROVISION_RELEASE", &release)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = ready.exists();
    let result = if started {
        manager.delete_session("owner", &session.id).await
    } else {
        Err("fixture did not start".into())
    };
    std::fs::write(&release, b"release").unwrap();
    let exited = tokio::task::spawn_blocking(move || child.wait())
        .await
        .unwrap()
        .unwrap()
        .success();
    assert!(started && exited);
    assert!(
        result.is_err(),
        "deletion passed an in-flight first provisioning"
    );
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_some());
    manager.delete_session("owner", &session.id).await.unwrap();
    manager.shutdown().await.unwrap();
}

#[test]
fn boundary_is_released_if_its_owning_process_crashes() {
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let ready = root.path().join("ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "v4_agent::background_process::lifecycle_tests::background_boundary_process_fixture",
            "--ignored",
        ])
        .env("V4_TEST_BOUNDARY_DATA", root.path())
        .env("V4_TEST_BOUNDARY_READY", &ready)
        .env(
            "V4_TEST_BOUNDARY_RELEASE",
            root.path().join("never-released"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let started = ready.exists();
    let held = bootstrap::SessionBoundary::try_acquire(root.path()).is_err();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(started && held);
    assert!(bootstrap::SessionBoundary::try_acquire(root.path()).is_ok());
}

#[tokio::test]
async fn deletion_fails_closed_while_another_process_holds_the_provisioning_boundary() {
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let config = AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    };
    let state = crate::state::AppState::new_runtime(config).unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let ready = root.path().join("ready");
    let release = root.path().join("release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "v4_agent::background_process::lifecycle_tests::background_boundary_process_fixture",
            "--ignored",
        ])
        .env("V4_TEST_BOUNDARY_DATA", &data)
        .env("V4_TEST_BOUNDARY_READY", &ready)
        .env("V4_TEST_BOUNDARY_RELEASE", &release)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = ready.exists();
    let result = if started {
        manager.delete_session("owner", &session.id).await
    } else {
        Err("fixture did not start".into())
    };
    std::fs::write(&release, b"release").unwrap();
    let exited = tokio::task::spawn_blocking(move || child.wait())
        .await
        .unwrap()
        .unwrap()
        .success();
    assert!(started && exited);
    assert!(
        result.is_err(),
        "deletion passed a live provisioning boundary"
    );
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_some());
    manager.delete_session("owner", &session.id).await.unwrap();
    manager.shutdown().await.unwrap();
}

fn request(root: &Path, owner: &str, session: &str, action: &str) -> BackgroundRequest {
    BackgroundRequest {
        interactive: false,
        scope: BackgroundScope {
            owner: owner.into(),
            session: session.into(),
            workspace: root.canonicalize().unwrap(),
            incarnation: None,
        },
        authorization_generation: None,
        action_id: action.into(),
        command: "printf '%s' $$ > child.pid; exec sleep 30".into(),
        timeout: Duration::from_secs(40),
    }
}

async fn child_pid(root: &Path) -> i32 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(root.join("child.pid")) {
                if let Ok(pid) = text.parse() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("child did not start")
}

async fn exited(pid: i32) -> bool {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if unsafe { libc::kill(pid, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn runtime_reopens_existing_background_manager_and_deletion_reaps_owned_process() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let config = AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    };
    let setup = crate::state::AppState::new(config.clone()).unwrap();
    let cleanup = setup.provision_owner_cleanup().unwrap();
    let background = {
        let mut db = setup.lock_db().unwrap();
        bootstrap::open_or_provision(&data, &mut db).unwrap()
    };
    background.shutdown().await.unwrap();
    drop(background);
    drop(cleanup);
    drop(setup);

    let state = crate::state::AppState::new_runtime(config).unwrap();
    let manager = state.structured_session_manager();
    let Some(background) = manager.background_processes_for_test() else {
        manager.shutdown().await.unwrap();
        panic!("runtime did not retain its existing background installation");
    };
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let mut action = request(root.path(), "owner", &session.id, "runtime-delete");
    action.authorization_generation = Some(0);
    background
        .start(action.clone(), Some(&action))
        .await
        .unwrap();
    let pid = child_pid(root.path()).await;
    manager.delete_session("owner", &session.id).await.unwrap();
    assert!(
        exited(pid).await,
        "owned background process survived deletion"
    );
    assert!(background.ensure_session_open(&action.scope).await.is_err());
    assert!(
        session_fence::is_retired(&data.canonicalize().unwrap(), "owner", &session.id).unwrap()
    );
    let stale = request(root.path(), "owner", &session.id, "after-delete");
    assert!(background.start(stale.clone(), Some(&stale)).await.is_err());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn runtime_startup_recovers_a_group_left_by_a_crashed_host_and_leaves_mismatches_unknown() {
    use std::os::unix::process::CommandExt;
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let config = AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    };
    let setup = crate::state::AppState::new(config.clone()).unwrap();
    let cleanup = setup.provision_owner_cleanup().unwrap();
    let background = {
        let mut db = setup.lock_db().unwrap();
        bootstrap::open_or_provision(&data, &mut db).unwrap()
    };
    let spawn = || {
        std::process::Command::new("/bin/sh")
            .args(["-c", "exec /bin/sleep 300"])
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    };
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: None,
    };
    let matching = spawn();
    let mismatched = spawn();
    let matching_pid = matching.id() as i32;
    let mismatched_pid = mismatched.id() as i32;
    for (action, child, skew) in [("matching", &matching, 0), ("mismatched", &mismatched, 1)] {
        let key = background.ledger.claim(&scope, action).unwrap();
        let identity = recovery::capture(child.id()).unwrap();
        background
            .ledger
            .record_launch(
                &key,
                &scope,
                action,
                identity.pid,
                identity.pgid,
                Some((identity.started.0 + skew, identity.started.1)),
            )
            .unwrap();
    }
    drop(background);
    drop(cleanup);
    drop(setup);
    let reapers = [matching, mismatched].map(|mut child| std::thread::spawn(move || child.wait()));

    let state = crate::state::AppState::new_runtime(config).unwrap();
    let manager = state.structured_session_manager();
    let background = manager.background_processes_for_test().unwrap();
    assert!(
        exited(matching_pid).await,
        "matching group survived startup"
    );
    assert!(unsafe { libc::kill(mismatched_pid, 0) } == 0);
    assert_eq!(
        background.ledger.read(&scope, "matching").unwrap(),
        BackgroundState::Cancelled
    );
    assert_eq!(
        background.ledger.read(&scope, "mismatched").unwrap(),
        BackgroundState::Unknown
    );
    assert!(background
        .session_has_outstanding("owner", "session")
        .unwrap());
    unsafe { libc::kill(-mismatched_pid, libc::SIGKILL) };
    for reaper in reapers {
        let _ = reaper.join();
    }
    let _ = manager.shutdown().await;
}

#[tokio::test]
async fn runtime_retains_session_when_background_ledger_is_owned_elsewhere() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let config = AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    };
    let setup = crate::state::AppState::new(config.clone()).unwrap();
    let cleanup = setup.provision_owner_cleanup().unwrap();
    let background = {
        let mut db = setup.lock_db().unwrap();
        bootstrap::open_or_provision(&data, &mut db).unwrap()
    };
    let state = crate::state::AppState::new_runtime(config).unwrap();
    let manager = state.structured_session_manager();
    assert!(manager.background_processes_for_test().is_none());
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    assert!(manager.delete_session("owner", &session.id).await.is_err());
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_some());
    background.shutdown().await.unwrap();
    drop(background);
    manager.delete_session("owner", &session.id).await.unwrap();
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_none());
    manager.shutdown().await.unwrap();
    drop(cleanup);
    drop(setup);
}

#[tokio::test]
async fn retained_background_manager_handles_review_without_reopening_its_ledger() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let root = tempfile::tempdir().unwrap();
    let data = root.path().canonicalize().unwrap();
    let app = crate::state::AppState::new(AppConfig {
        data_dir: data.clone(),
        jwt_secret: "retained-background-review".into(),
        ..Default::default()
    })
    .unwrap();
    let manager = app.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    manager
        .bind_owner_cleanup(app.provision_owner_cleanup().unwrap())
        .unwrap();
    app.create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    let alice = app
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let background = {
        let mut db = app.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(&data, &mut db).unwrap())
    };
    let action = request(&data, &alice.user.id, "review-session", "unknown");
    background
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    app.logout_user(&alice.user.id).unwrap();
    assert!(background.shutdown().await.is_err());
    let hold: String = app
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM structured_owner_holds WHERE owner=?1",
            [&alice.user.id],
            |row| row.get(0),
        )
        .unwrap();
    let renewed = app
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let operation = uuid::Uuid::new_v4();
    let response = crate::app(app.clone()).oneshot(
        Request::builder().method("POST").uri("/api/structured/owner-cleanup/background-review")
            .header("authorization", format!("Bearer {}", renewed.tokens.access_token))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({"requestId":hold,"operationId":operation,"acknowledged":true}).to_string())).unwrap()
    ).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(!background.ledger.has_unknown_owner(&alice.user.id).unwrap());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn writer_busy_deletion_keeps_background_session_usable_until_retry() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    });
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap();
    let engine_id = crate::structured::engine_session_id(&session.id).unwrap();
    let writer = super::super::session_store::image_writer_lease(
        &data,
        "owner",
        &root.path().canonicalize().unwrap(),
        &engine_id,
    )
    .unwrap();
    let action = request(root.path(), "owner", &session.id, "retry-after-writer");
    assert!(manager
        .delete_session("owner", &session.id)
        .await
        .unwrap_err()
        .contains("live native writer"));
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_some());
    assert!(
        background.ensure_session_open(&action.scope).await.is_ok(),
        "a precommit deletion failure must not permanently retire the background session"
    );
    drop(writer);
    manager.delete_session("owner", &session.id).await.unwrap();
    assert!(background.ensure_session_open(&action.scope).await.is_err());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn deletion_reaps_owned_background_and_retires_its_session() {
    let root = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let req = request(root.path(), "owner", &session.id, "one");
    background.start(req.clone(), Some(&req)).await.unwrap();
    let pid = child_pid(root.path()).await;

    manager.interrupt("owner", &session.id).await.unwrap();
    let running_after_turn_stop = matches!(
        background
            .snapshot(&req.scope, &req.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Running
    );
    manager.delete_session("other", &session.id).await.unwrap();
    let running_after_foreign_delete = matches!(
        background
            .snapshot(&req.scope, &req.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Running
    );
    let deletion = manager.delete_session("owner", &session.id).await;
    let stopped_by_deletion = exited(pid).await;
    let admission_closed = background.ensure_session_open(&req.scope).await.is_err();
    let _ = background.shutdown().await;

    assert!(running_after_turn_stop);
    assert!(running_after_foreign_delete);
    assert!(deletion.is_ok());
    assert!(stopped_by_deletion);
    assert!(admission_closed);
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn deletion_keeps_session_when_background_outcome_is_unknown() {
    let root = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let req = request(root.path(), "owner", &session.id, "unknown");
    background.ledger.claim(&req.scope, &req.action_id).unwrap();

    let deletion = manager.delete_session("owner", &session.id).await;
    let retained = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .is_some();
    assert!(deletion.is_err());
    assert!(retained);
    assert!(background.shutdown().await.is_err());
}

#[tokio::test]
async fn deletion_does_not_stop_another_owners_background_process() {
    let root = tempfile::tempdir().unwrap();
    let first_root = root.path().join("first");
    let second_root = root.path().join("second");
    std::fs::create_dir_all(&first_root).unwrap();
    std::fs::create_dir_all(&second_root).unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let first = manager
        .create_session(
            "owner-a",
            first_root.to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let second = manager
        .create_session(
            "owner-b",
            second_root.to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let first_request = request(&first_root, "owner-a", &first.id, "one");
    let second_request = request(&second_root, "owner-b", &second.id, "two");
    background
        .start(first_request.clone(), Some(&first_request))
        .await
        .unwrap();
    background
        .start(second_request.clone(), Some(&second_request))
        .await
        .unwrap();
    let first_pid = child_pid(&first_root).await;
    let second_pid = child_pid(&second_root).await;
    let deletion = manager.delete_session("owner-a", &first.id).await;
    let first_stopped = exited(first_pid).await;
    let second_running = matches!(
        background
            .snapshot(&second_request.scope, &second_request.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Running
    );
    let _ = background.shutdown().await;
    let second_stopped = exited(second_pid).await;

    assert!(deletion.is_ok());
    assert!(first_stopped);
    assert!(second_running);
    assert!(second_stopped);
    assert!(manager
        .get_session("owner-b", &second.id)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn deletion_rejects_late_background_approval() {
    struct HeldApproval {
        ready: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for HeldApproval {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.ready.lock().unwrap().take().unwrap().send(()).unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }

    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            workspace.to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: session.id.clone(),
        turn_id: "turn".into(),
    };
    let (ready, observed) = tokio::sync::oneshot::channel();
    let reviewer = HeldApproval {
        ready: std::sync::Mutex::new(Some(ready)),
        release: tokio::sync::Notify::new(),
    };
    let input = json!({"command":"printf unexpected > marker", "timeoutSeconds": 5});
    let cancellation = Cancellation::default();
    let authority = crate::auth::LocalAuthority::for_test(&scope.owner, 0, i64::MAX);
    let action = tool::execute_direct(
        &background,
        &scope,
        &workspace,
        "late",
        "background_start",
        &input,
        &reviewer,
        &cancellation,
        Some(&authority),
    );
    tokio::pin!(action);
    tokio::select! {
        _ = &mut action => panic!("approval unexpectedly completed"),
        observed = observed => observed.unwrap(),
    }
    manager.delete_session("owner", &session.id).await.unwrap();
    reviewer.release.notify_one();
    assert!(action.await.is_err());
    assert!(!workspace.join("marker").exists());
    background.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_reports_unknown_background_outcome() {
    let root = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let req = request(root.path(), "owner", &session.id, "unknown");
    background.ledger.claim(&req.scope, &req.action_id).unwrap();
    assert!(manager.shutdown().await.is_err());
}

#[tokio::test]
async fn shutdown_reaps_background_processes() {
    let root = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let req = request(root.path(), "owner", &session.id, "one");
    background.start(req.clone(), Some(&req)).await.unwrap();
    let pid = child_pid(root.path()).await;
    let shutdown = manager.shutdown().await;
    let stopped_by_shutdown = exited(pid).await;
    let admission_closed = background.ensure_session_open(&req.scope).await.is_err();
    let _ = background.shutdown().await;

    assert!(shutdown.is_ok());
    assert!(stopped_by_shutdown);
    assert!(admission_closed);
}

#[tokio::test]
async fn shutdown_stops_background_while_an_agent_stop_is_pending() {
    struct StalledProvider {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        sender:
            std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<StructuredSessionEvent>>>,
    }
    #[async_trait]
    impl StructuredProcessController for StalledProvider {
        async fn send_input(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn send_approval(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), String> {
            self.kill().await
        }
        async fn kill(&self) -> Result<(), String> {
            self.entered.notify_one();
            self.release.notified().await;
            self.sender.lock().unwrap().take();
            Ok(())
        }
    }
    struct Provider(Arc<StalledProvider>);
    impl StructuredProvider for Provider {
        fn provider_id(&self) -> &'static str {
            "claude"
        }
        fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
            let (sender, events) = tokio::sync::mpsc::unbounded_channel();
            *self.0.sender.lock().unwrap() = Some(sender);
            Ok(SpawnedStructuredProcess {
                controller: self.0.clone(),
                events,
            })
        }
    }

    let root = tempfile::tempdir().unwrap();
    let stalled = Arc::new(StalledProvider {
        entered: Default::default(),
        release: Default::default(),
        sender: Default::default(),
    });
    let manager = StructuredSessionManager::new_with_providers(
        AppConfig {
            data_dir: root.path().join("data"),
            ..Default::default()
        },
        vec![Arc::new(Provider(stalled.clone()))],
    );
    let session = manager
        .create_session(
            "owner",
            root.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let background = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let req = request(root.path(), "owner", &session.id, "one");
    background.start(req.clone(), Some(&req)).await.unwrap();
    let pid = child_pid(root.path()).await;
    manager
        .send_message("owner", &session.id, "begin synthetic turn")
        .await
        .unwrap();
    let shutdown_manager = manager.clone();
    let shutdown = tokio::spawn(async move { shutdown_manager.shutdown().await });
    tokio::time::timeout(Duration::from_secs(5), stalled.entered.notified())
        .await
        .unwrap();
    let stopped_while_agent_pending = exited(pid).await;
    stalled.release.notify_one();
    let result = shutdown.await.unwrap();
    let _ = background.shutdown().await;

    assert!(result.is_ok());
    assert!(stopped_while_agent_pending);
}
