use super::*;
use crate::v4_agent::interaction::Cancellation;
use owner_gate::OwnerGate;
use rusqlite::Connection;
use std::{
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::{mpsc, Arc},
    time::Instant,
};

fn scope(root: &Path, owner: &str, session: &str) -> BackgroundScope {
    BackgroundScope {
        owner: owner.into(),
        session: session.into(),
        workspace: root.canonicalize().unwrap(),
        incarnation: None,
    }
}

fn pid_file_request(
    root: &Path,
    owner: &str,
    session: &str,
    action: &str,
    generation: Option<i64>,
) -> BackgroundRequest {
    BackgroundRequest {
        scope: scope(root, owner, session),
        authorization_generation: generation,
        action_id: action.into(),
        command: format!("printf '%s' $$ > {action}.pid; exec sleep 30"),
        timeout: Duration::from_secs(40),
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn gone(pid: i32) -> bool {
    tokio::time::timeout(Duration::from_secs(5), async {
        while alive(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok()
}

fn provisioned(root: &Path) -> (BackgroundProcesses, std::path::PathBuf) {
    let path = root.join("app.sqlite");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
    (bootstrap::open_or_provision(root, &mut db).unwrap(), path)
}

fn plain(root: &Path) -> BackgroundProcesses {
    BackgroundProcesses::create(&root.canonicalize().unwrap().join("background-processes")).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_launch_does_not_delay_stop_or_unrelated_authorization_and_is_revoked() {
    let root = tempfile::tempdir().unwrap();
    let (manager, db_path) = provisioned(root.path());
    let manager = Arc::new(manager);
    let request = pid_file_request(root.path(), "owner", "session", "stalled", Some(0));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let spawned = Arc::new(std::sync::atomic::AtomicI32::new(0));
    let launch = tokio::spawn({
        let manager = manager.clone();
        let spawned = spawned.clone();
        let request = request.clone();
        async move {
            manager
                .start_for_actor(
                    request.clone(),
                    &request,
                    &Cancellation::default(),
                    i64::MAX,
                    move |command| {
                        entered_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(Duration::from_secs(20))
                            .map_err(|_| "test launch was never released".to_string())?;
                        let child = command
                            .spawn()
                            .map_err(|_| "Cannot start background process".to_string())?;
                        spawned.store(
                            child.id().unwrap() as i32,
                            std::sync::atomic::Ordering::SeqCst,
                        );
                        Ok(child)
                    },
                )
                .await
        }
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();

    let started = Instant::now();
    let stop = OwnerGate::open(Connection::open(&db_path).unwrap()).unwrap();
    stop.hold("owner", "local-stop").unwrap();
    stop.hold("unrelated", "stop-two").unwrap();
    manager
        .ensure_authorized(&scope(root.path(), "third", "s"), Some(0))
        .unwrap();
    let mut app = Connection::open(&db_path).unwrap();
    app.busy_timeout(Duration::from_millis(250)).unwrap();
    let tx = app
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.commit().unwrap();
    let elapsed = started.elapsed();

    release_tx.send(()).unwrap();
    let outcome = launch.await.unwrap();
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    assert!(outcome.unwrap_err().contains("changed during launch"));
    let pid = spawned.load(std::sync::atomic::Ordering::SeqCst);
    assert!(pid > 1);
    assert!(gone(pid).await);
    let snapshot = manager
        .wait(
            &request.scope,
            "stalled",
            Duration::from_secs(5),
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.state, BackgroundState::Cancelled);
    assert!(manager
        .start(
            pid_file_request(root.path(), "third", "s", "later", Some(0)),
            Some(&pid_file_request(
                root.path(),
                "third",
                "s",
                "later",
                Some(0)
            )),
        )
        .await
        .is_ok());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn launch_exceeding_its_budget_is_stopped_instead_of_confirmed() {
    let root = tempfile::tempdir().unwrap();
    let (manager, _) = provisioned(root.path());
    manager.set_launch_budget_for_test(Duration::from_millis(50));
    let spawned = std::sync::atomic::AtomicI32::new(0);
    let spawned = &spawned;
    let request = pid_file_request(root.path(), "owner", "session", "slow", Some(0));
    let result = manager
        .start_for_actor(
            request.clone(),
            &request,
            &Cancellation::default(),
            i64::MAX,
            |command| {
                std::thread::sleep(Duration::from_millis(400));
                let child = command
                    .spawn()
                    .map_err(|_| "Cannot start background process".to_string())?;
                spawned.store(
                    child.id().unwrap() as i32,
                    std::sync::atomic::Ordering::SeqCst,
                );
                Ok(child)
            },
        )
        .await;
    assert!(result.unwrap_err().contains("changed during launch"));
    let pid = spawned.load(std::sync::atomic::Ordering::SeqCst);
    assert!(pid > 1);
    assert!(gone(pid).await);
    manager.shutdown().await.unwrap();
}

#[test]
#[ignore = "invoked by the cross-process session fence test"]
fn session_fence_holder_fixture() {
    let data = std::env::var_os("V4_TEST_FENCE_DATA").unwrap();
    let ready = std::env::var_os("V4_TEST_FENCE_READY").unwrap();
    let release = std::env::var_os("V4_TEST_FENCE_RELEASE").unwrap();
    let _lease = session_fence::acquire_launch(Path::new(&data), "owner", "session").unwrap();
    std::fs::write(ready, b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !Path::new(&release).exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "invoked by the cross-process session fence test"]
fn session_fence_retire_fixture() {
    let data = std::env::var_os("V4_TEST_FENCE_DATA").unwrap();
    session_fence::retire(Path::new(&data), "owner", "session").unwrap();
}

fn fixture(name: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            &format!("v4_agent::background_process::hardening_tests::{name}"),
            "--ignored",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[tokio::test]
async fn another_process_launching_blocks_retirement_and_a_retired_session_blocks_stale_launches() {
    let root = tempfile::tempdir().unwrap();
    let manager = plain(root.path());
    let ready = root.path().join("ready");
    let release = root.path().join("release");
    let mut holder = fixture("session_fence_holder_fixture")
        .env("V4_TEST_FENCE_DATA", root.path())
        .env("V4_TEST_FENCE_READY", &ready)
        .env("V4_TEST_FENCE_RELEASE", &release)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ready.exists());
    let busy_retire = session_fence::retire(root.path(), "owner", "session");
    let request = pid_file_request(root.path(), "owner", "session", "blocked", None);
    let busy_launch = manager.start(request.clone(), Some(&request)).await;
    std::fs::write(&release, b"go").unwrap();
    assert!(holder.wait().unwrap().success());
    assert!(busy_retire.unwrap_err().contains("retry"));
    assert!(busy_launch.unwrap_err().contains("retry"));
    assert!(!root.path().join("blocked.pid").exists());

    assert!(fixture("session_fence_retire_fixture")
        .env("V4_TEST_FENCE_DATA", root.path())
        .status()
        .unwrap()
        .success());
    let stale = pid_file_request(root.path(), "owner", "session", "stale", None);
    let result = manager.start(stale.clone(), Some(&stale)).await;
    assert!(result.unwrap_err().contains("retired"));
    assert!(!root.path().join("stale.pid").exists());
    assert!(session_fence::acquire_launch(root.path(), "owner", "session").is_err());
    let sibling = pid_file_request(root.path(), "owner", "other-session", "sibling", None);
    manager
        .start(sibling.clone(), Some(&sibling))
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn retiring_a_session_persists_the_fence_tombstone() {
    let root = tempfile::tempdir().unwrap();
    let manager = plain(root.path());
    assert!(!session_fence::is_retired(root.path(), "owner", "session").unwrap());
    manager.retire_session("owner", "session").await.unwrap();
    assert!(session_fence::is_retired(root.path(), "owner", "session").unwrap());
    manager.shutdown().await.unwrap();
}

fn spawn_group(command: &str) -> std::process::Child {
    Command::new("/bin/sh")
        .args(["-c", command])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn claim_and_record(
    manager: &BackgroundProcesses,
    root: &Path,
    action: &str,
    child: Option<(&std::process::Child, Option<(i64, i64)>)>,
) -> Vec<u8> {
    let scope = scope(root, "owner", "session");
    let key = manager.ledger.claim(&scope, action).unwrap();
    if let Some((child, started)) = child {
        let identity = recovery::capture(child.id()).unwrap();
        manager
            .ledger
            .record_launch(
                &key,
                &scope,
                action,
                identity.pid,
                identity.pgid,
                started.or(Some(identity.started)),
            )
            .unwrap();
    }
    key
}

#[test]
#[ignore = "invoked by the crash recovery test"]
fn crashing_host_fixture() {
    let data = std::env::var_os("V4_TEST_CRASH_DATA").unwrap();
    let pid_file = std::env::var_os("V4_TEST_CRASH_PID").unwrap();
    let manager = plain(Path::new(&data));
    let child = spawn_group("exec /bin/sleep 300");
    claim_and_record(&manager, Path::new(&data), "crashed", Some((&child, None)));
    std::fs::write(pid_file, child.id().to_string()).unwrap();
    std::process::abort();
}

#[tokio::test]
async fn recovery_kills_only_a_matching_process_left_by_a_crashed_host() {
    let root = tempfile::tempdir().unwrap();
    let pid_file = root.path().join("sleeper.pid");
    let status = fixture("crashing_host_fixture")
        .env("V4_TEST_CRASH_DATA", root.path())
        .env("V4_TEST_CRASH_PID", &pid_file)
        .status()
        .unwrap();
    assert!(!status.success());
    let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
    assert!(alive(pid));

    let manager = BackgroundProcesses::open(
        &root
            .path()
            .canonicalize()
            .unwrap()
            .join("background-processes"),
    )
    .unwrap();
    let request = pid_file_request(root.path(), "owner", "session", "blocked-by-recovery", None);
    assert!(manager
        .start(request.clone(), Some(&request))
        .await
        .is_err());

    let report = manager.recover_unconfirmed().await.unwrap();
    assert_eq!(
        report,
        RecoveryReport {
            killed: 1,
            already_stopped: 0,
            unresolved: 0
        }
    );
    assert!(gone(pid).await);
    let crashed = scope(root.path(), "owner", "session");
    let key = Ledger::key(&crashed, "crashed").unwrap();
    assert_eq!(
        manager.ledger.read(&crashed, "crashed").unwrap(),
        BackgroundState::Cancelled
    );
    assert_eq!(
        manager.ledger.recovery_outcome(&key).unwrap().as_deref(),
        Some("killed")
    );
    let pending = manager.drain_pending_completions().unwrap();
    assert_eq!(
        pending,
        vec![BackgroundCompletion {
            scope: crashed,
            action_id: "crashed".into(),
            state: BackgroundState::Cancelled,
        }]
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn recovery_leaves_mismatched_missing_and_orphaned_identities_for_review() {
    let root = tempfile::tempdir().unwrap();
    let manager = plain(root.path());

    let mut reused = spawn_group("exec /bin/sleep 300");
    let real = recovery::capture(reused.id()).unwrap();
    let mismatched = claim_and_record(
        &manager,
        root.path(),
        "reused",
        Some((&reused, Some((real.started.0 - 1, real.started.1)))),
    );
    let unrecorded = claim_and_record(&manager, root.path(), "unrecorded", None);

    let background_pid = root.path().join("background.pid");
    let mut survivor_leader = spawn_group(&format!(
        "/bin/sleep 300 & echo $! > {}.tmp; mv {}.tmp {}; exec /bin/sleep 300",
        background_pid.display(),
        background_pid.display(),
        background_pid.display()
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !background_pid.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(background_pid.exists());
    let orphaned = claim_and_record(
        &manager,
        root.path(),
        "orphaned",
        Some((&survivor_leader, None)),
    );
    let group = recovery::capture(survivor_leader.id()).unwrap().pgid;
    unsafe { libc::kill(survivor_leader.id() as i32, libc::SIGKILL) };
    survivor_leader.wait().unwrap();

    let mut finished = spawn_group("exec /bin/sleep 0.3");
    let stopped = claim_and_record(&manager, root.path(), "stopped", Some((&finished, None)));
    finished.wait().unwrap();

    let report = manager.recover_unconfirmed().await.unwrap();
    let still_there = alive(reused.id() as i32);
    let survivors = unsafe { libc::kill(-group, 0) } == 0;
    unsafe { libc::kill(-group, libc::SIGKILL) };
    reused.kill().unwrap();
    reused.wait().unwrap();

    assert_eq!(
        report,
        RecoveryReport {
            killed: 0,
            already_stopped: 1,
            unresolved: 3
        }
    );
    assert!(still_there && survivors);
    let outcome = |key: &[u8]| manager.ledger.recovery_outcome(key).unwrap();
    assert_eq!(outcome(&mismatched).as_deref(), Some("identity_mismatch"));
    assert_eq!(outcome(&unrecorded).as_deref(), Some("no_identity"));
    assert_eq!(outcome(&orphaned).as_deref(), Some("unverifiable"));
    assert_eq!(outcome(&stopped).as_deref(), Some("group_empty"));
    for action in ["reused", "unrecorded", "orphaned"] {
        assert_eq!(
            manager
                .ledger
                .read(&scope(root.path(), "owner", "session"), action)
                .unwrap(),
            BackgroundState::Unknown
        );
    }
    assert_eq!(
        manager
            .ledger
            .read(&scope(root.path(), "owner", "session"), "stopped")
            .unwrap(),
        BackgroundState::Cancelled
    );
    assert!(manager.session_has_outstanding("owner", "session").unwrap());
}

#[tokio::test]
async fn completions_persist_with_the_outcome_and_drain_exactly_once_across_threads() {
    let root = tempfile::tempdir().unwrap();
    let manager = plain(root.path());
    let total = 6;
    for index in 0..total {
        let mut request =
            pid_file_request(root.path(), "owner", "session", &format!("c{index}"), None);
        request.command = format!("exit {index}");
        manager
            .start(request.clone(), Some(&request))
            .await
            .unwrap();
        manager
            .wait(
                &request.scope,
                &request.action_id,
                Duration::from_secs(10),
                &Cancellation::default(),
            )
            .await
            .unwrap();
    }
    manager.shutdown().await.unwrap();
    drop(manager);

    let reopened = Arc::new(
        BackgroundProcesses::open(
            &root
                .path()
                .canonicalize()
                .unwrap()
                .join("background-processes"),
        )
        .unwrap(),
    );
    let peeked = reopened.pending_completions().unwrap();
    assert_eq!(peeked.len(), total);
    let first = peeked[0].0;
    assert!(reopened.acknowledge_completion(first).unwrap());
    assert!(!reopened.acknowledge_completion(first).unwrap());

    let workers: Vec<_> = (0..4)
        .map(|_| {
            let manager = reopened.clone();
            std::thread::spawn(move || {
                let mut seen = Vec::new();
                loop {
                    let batch = manager.drain_pending_completions().unwrap();
                    if batch.is_empty() {
                        return seen;
                    }
                    seen.extend(batch);
                }
            })
        })
        .collect();
    let mut codes: Vec<_> = workers
        .into_iter()
        .flat_map(|worker| worker.join().unwrap())
        .map(|completion| match completion.state {
            BackgroundState::Exited { code } => code.unwrap(),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    codes.sort();
    assert_eq!(codes, (1..total as i32).collect::<Vec<_>>());
    assert!(reopened.pending_completions().unwrap().is_empty());
}
