#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use terminal_v4_api::ApiState;
use terminal_v4_core::AppConfig;

const SECRET: &str = "isolated-default-logout-test-secret";
const OWNER: &str = "fixture-owner";

#[test]
#[ignore = "subprocess fixture"]
fn default_logout_marker_fixture() {
    let Some(root) = std::env::var_os("V4_DEFAULT_LOGOUT_FIXTURE") else {
        return;
    };
    let root = Path::new(&root);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _enter = runtime.enter();
    let state = ApiState::new_runtime(AppConfig {
        data_dir: root.into(),
        jwt_secret: SECRET.into(),
        ..Default::default()
    })
    .unwrap();
    std::fs::write(root.join("default-logout-ready"), b"ready").unwrap();
    state.logout_user(OWNER).unwrap();
    std::fs::write(root.join("default-logout-done"), b"done").unwrap();
}

#[test]
fn default_build_process_honors_existing_input_installation() {
    let root = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _enter = runtime.enter();
    let state = ApiState::new_runtime(AppConfig {
        data_dir: root.path().into(),
        jwt_secret: SECRET.into(),
        ..Default::default()
    })
    .unwrap();
    let db = rusqlite::Connection::open(root.path().join("terminal.db")).unwrap();
    db.execute_batch("ALTER TABLE auth_admission_identity ADD COLUMN owner_input_version INTEGER NOT NULL DEFAULT 0; CREATE TABLE owner_input_locks(owner_hash TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL); CREATE TABLE owner_input_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL, session_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL, issued_ms INTEGER NOT NULL, UNIQUE(owner_hash, operation_id)); CREATE TABLE owner_input_watermarks(owner_hash TEXT PRIMARY KEY, observed_ms INTEGER NOT NULL); UPDATE auth_admission_identity SET owner_input_version=1 WHERE id=1").unwrap();
    drop(db);
    let name = format!(
        "auth-input-{}.lock",
        hex::encode(Sha256::digest(OWNER.as_bytes()))
    );
    let guard = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.path().join(name))
        .unwrap();
    guard.lock().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "default_logout_marker_fixture", "--ignored"])
        .env("V4_DEFAULT_LOGOUT_FIXTURE", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready_path = root.path().join("default-logout-ready");
    let done_path = root.path().join("default-logout-done");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready_path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready = ready_path.exists();
    std::thread::sleep(Duration::from_millis(100));
    let completed_early = done_path.exists();
    drop(guard);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done_path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let completed_after = done_path.exists();
    let exit_deadline = Instant::now() + Duration::from_secs(2);
    while child.try_wait().unwrap().is_none() && Instant::now() < exit_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
    }
    let status = child.wait().unwrap();
    drop(state);
    assert!(
        (ready, !completed_early, completed_after, status.success()) == (true, true, true, true)
    );
}
