//! Durable quiescence evidence for background owners across server processes.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

fn open_checked(path: &Path, directory: bool, private: bool) -> Result<File, String> {
    let flags = libc::O_NOFOLLOW | libc::O_CLOEXEC | if directory { libc::O_DIRECTORY } else { 0 };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|_| "Background ledger identity is unavailable")?;
    let opened = file
        .metadata()
        .map_err(|_| "Background ledger identity is unavailable")?;
    let current =
        std::fs::symlink_metadata(path).map_err(|_| "Background ledger identity is unavailable")?;
    if current.file_type().is_symlink()
        || opened.uid() != unsafe { libc::geteuid() }
        || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        || (directory && (!opened.is_dir() || !current.is_dir()))
        || (!directory && (!opened.is_file() || !current.is_file() || opened.nlink() != 1))
        || (private && opened.mode() & 0o077 != 0)
        || (directory && !private && opened.mode() & 0o022 != 0)
    {
        return Err("Background ledger identity changed or is unsafe".into());
    }
    Ok(file)
}

fn ledger_files(root: &Path) -> Result<(PathBuf, Vec<File>), String> {
    let canonical = root
        .canonicalize()
        .map_err(|_| "Background data root unavailable")?;
    if canonical != root {
        return Err("Background data root changed".into());
    }
    let ledger = root.join("background-processes");
    let files = vec![
        open_checked(root, true, false)?,
        open_checked(&ledger, true, true)?,
        open_checked(
            &root.join(".background-processes.background-guard"),
            false,
            true,
        )?,
        open_checked(&ledger.join("owner.lock"), false, true)?,
        open_checked(&ledger.join("receipts.sqlite3"), false, true)?,
    ];
    const READY: &[u8] = b"v4-background-ledger-v2-ready\n";
    let guard = &files[2];
    if guard
        .metadata()
        .map_err(|_| "Background ledger guard unavailable")?
        .len()
        != READY.len() as u64
    {
        return Err("Background ledger guard is invalid".into());
    }
    let mut contents = vec![0; READY.len()];
    guard
        .read_exact_at(&mut contents, 0)
        .map_err(|_| "Background ledger guard unavailable")?;
    if contents != READY {
        return Err("Background ledger guard is invalid".into());
    }
    Ok((ledger.join("receipts.sqlite3"), files))
}

pub(crate) fn capture_binding(
    root: &Path,
    owned: Option<(&File, &File, &File)>,
) -> Result<Vec<u8>, String> {
    let (_, files) = ledger_files(root)?;
    if let Some((guard, lock, database)) = owned {
        for (actual, expected) in files[2..].iter().zip([guard, lock, database]) {
            let actual = actual
                .metadata()
                .map_err(|_| "Background ledger identity unavailable")?;
            let expected = expected
                .metadata()
                .map_err(|_| "Background ledger identity unavailable")?;
            if (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
                return Err("Background ledger identity changed".into());
            }
        }
    }
    let mut digest = Sha256::new();
    digest.update(b"terminal-v4/background-quiescence/v1");
    for file in files {
        let meta = file
            .metadata()
            .map_err(|_| "Background ledger identity unavailable")?;
        digest.update(meta.dev().to_be_bytes());
        digest.update(meta.ino().to_be_bytes());
    }
    Ok(digest.finalize().to_vec())
}

fn owner_key(owner: &str) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update((owner.len() as u64).to_be_bytes());
    hash.update(owner.as_bytes());
    hash.finalize().to_vec()
}

fn reject_sidecars(path: &Path) -> Result<(), String> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        match std::fs::symlink_metadata(PathBuf::from(sidecar)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("Background ledger recovery is unconfirmed".into()),
        }
    }
    Ok(())
}

pub(crate) fn release_in_transaction(
    tx: &Transaction<'_>,
    data_root: &Path,
    owner: &str,
    request: &str,
) -> Result<(), String> {
    if owner.trim().is_empty()
        || owner.len() > 256
        || owner.chars().any(char::is_control)
        || request.trim().is_empty()
        || request.len() > 128
        || request.chars().any(char::is_control)
    {
        return Err("Invalid background cleanup scope".into());
    }
    let auth_path = tx
        .path()
        .filter(|path| !path.is_empty())
        .ok_or("Background authorization database unavailable")?;
    let auth_path = Path::new(auth_path)
        .canonicalize()
        .map_err(|_| "Background authorization database unavailable")?;
    if auth_path.parent() != Some(data_root) {
        return Err("Background authorization scope changed".into());
    }
    let binding: Option<Vec<u8>> = tx.query_row(
        "SELECT q.ledger_binding FROM background_owner_quiescence q JOIN background_owner_holds h ON h.owner=q.owner AND h.request=q.request WHERE q.owner=?1 AND q.request=?2 AND h.state='acknowledged'",
        params![owner, request], |row| row.get(0),
    ).optional().map_err(|_| "Background quiescence receipt unavailable")?;
    let binding = binding.ok_or("Background cleanup is unconfirmed")?;
    if capture_binding(data_root, None)? != binding {
        return Err("Background ledger identity changed".into());
    }
    let (path, _files) = ledger_files(data_root)?;
    reject_sidecars(&path)?;
    let ledger = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "Background ledger unavailable")?;
    ledger
        .busy_timeout(Duration::ZERO)
        .map_err(|_| "Background ledger unavailable")?;
    let journal: String = ledger
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| "Background ledger unavailable")?;
    if !journal.eq_ignore_ascii_case("delete") {
        return Err("Background ledger recovery is unconfirmed".into());
    }
    let unknown: bool = ledger.query_row(
        "SELECT EXISTS(SELECT 1 FROM receipts WHERE state NOT IN ('exited','cancelled','timed_out','failed_to_start') AND NOT (state='unknown' AND EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed JOIN owner_review_operations operation ON operation.owner_key=reviewed.owner_key AND operation.request=reviewed.request AND operation.operation=reviewed.operation WHERE reviewed.key=receipts.key AND reviewed.owner_key=receipts.owner_key)) AND owner_key=?1)",
        params![owner_key(owner)], |row| row.get(0),
    ).map_err(|_| "Background ledger unavailable")?;
    if unknown || capture_binding(data_root, None)? != binding {
        return Err("Background cleanup is unconfirmed".into());
    }
    let mut reviews = ledger.prepare("SELECT DISTINCT reviewed.request,reviewed.operation,operation.count FROM receipts JOIN owner_reviewed_receipts reviewed ON reviewed.key=receipts.key AND reviewed.owner_key=receipts.owner_key JOIN owner_review_operations operation ON operation.owner_key=reviewed.owner_key AND operation.request=reviewed.request AND operation.operation=reviewed.operation WHERE receipts.owner_key=?1 AND receipts.state='unknown'")
        .map_err(|_| "Background review audit is unavailable")?;
    let rows = reviews
        .query_map(params![owner_key(owner)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| "Background review audit is unavailable")?;
    for row in rows {
        let (review_request, operation, count) =
            row.map_err(|_| "Background review audit is unavailable")?;
        let audited: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_background_reviews WHERE owner=?1 AND request=?2 AND operation=?3 AND count=?4 AND ledger_binding=?5)", params![owner,review_request,operation,count,binding], |row| row.get(0)).map_err(|_| "Background review audit is unavailable")?;
        if !audited {
            return Err("Background user review is unconfirmed".into());
        }
    }
    reject_sidecars(&path)?;
    tx.execute_batch("SAVEPOINT v4_background_release")
        .map_err(|_| "Cannot begin background cleanup release")?;
    let release = || -> Result<(), String> {
        let receipt_removed = tx
            .execute(
                "DELETE FROM background_owner_quiescence WHERE owner=?1 AND request=?2",
                params![owner, request],
            )
            .map_err(|_| "Cannot release background quiescence receipt")?;
        if receipt_removed != 1 {
            return Err("Background cleanup scope changed".into());
        }
        let removed = tx.execute(
            "DELETE FROM background_owner_holds WHERE owner=?1 AND request=?2 AND state='acknowledged'",
            params![owner, request],
        ).map_err(|_| "Cannot release background cleanup hold")?;
        if removed != 1 {
            return Err("Background cleanup scope changed".into());
        }
        Ok(())
    };
    if let Err(error) = release() {
        tx.execute_batch("ROLLBACK TO v4_background_release; RELEASE v4_background_release")
            .map_err(|_| "Background cleanup rollback is unconfirmed")?;
        return Err(error);
    }
    tx.execute_batch("RELEASE v4_background_release")
        .map_err(|_| "Background cleanup release is unconfirmed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v4_agent::background_process::{bootstrap, owner_gate::OwnerGate};
    use rusqlite::Connection;

    #[tokio::test]
    async fn confirmed_cleanup_can_be_released_after_manager_exit() {
        let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = data.path().canonicalize().unwrap();
        let database = root.join("terminal.db");
        let mut db = Connection::open(&database).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
        )
        .unwrap();
        let manager = bootstrap::open_or_provision(&root, &mut db).unwrap();
        let gate = OwnerGate::open(Connection::open(&database).unwrap()).unwrap();
        gate.hold("owner", "request").unwrap();
        assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
        assert_eq!(gate.status("owner", "request").unwrap(), "acknowledged");
        manager.shutdown().await.unwrap();
        drop(manager);
        let tx = db.transaction().unwrap();
        release_in_transaction(&tx, &root, "owner", "request").unwrap();
        tx.rollback().unwrap();
        assert_eq!(gate.status("owner", "request").unwrap(), "acknowledged");
        db.execute_batch("CREATE TRIGGER fail_hold_release BEFORE DELETE ON background_owner_holds BEGIN SELECT RAISE(FAIL, 'fixture failure'); END;").unwrap();
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.commit().unwrap();
        assert_eq!(gate.status("owner", "request").unwrap(), "acknowledged");
        let receipts: i64 = db.query_row("SELECT COUNT(*) FROM background_owner_quiescence WHERE owner='owner' AND request='request'", [], |row| row.get(0)).unwrap();
        assert_eq!(receipts, 1);
        db.execute_batch("DROP TRIGGER fail_hold_release").unwrap();
        let tx = db.transaction().unwrap();
        release_in_transaction(&tx, &root, "owner", "request").unwrap();
        tx.commit().unwrap();
        assert!(gate.status("owner", "request").is_err());
        let binding = capture_binding(&root, None).unwrap();
        db.execute("INSERT INTO background_owner_quiescence(owner,request,ledger_binding) VALUES('owner','request',?1)", params![binding]).unwrap();
        gate.hold("owner", "request").unwrap();
        gate.acknowledge("owner", "request").unwrap();
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();
    }

    #[tokio::test]
    async fn stale_request_changed_identity_and_unknown_receipt_keep_the_hold() {
        let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = data.path().canonicalize().unwrap();
        let database = root.join("terminal.db");
        let mut db = Connection::open(&database).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
        )
        .unwrap();
        let manager = bootstrap::open_or_provision(&root, &mut db).unwrap();
        let gate = OwnerGate::open(Connection::open(&database).unwrap()).unwrap();
        gate.hold("owner", "request").unwrap();
        assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
        manager.shutdown().await.unwrap();
        drop(manager);

        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "other-request").is_err());
        tx.rollback().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute(
            "UPDATE background_owner_holds SET request='renewed',state='held' WHERE owner='owner'",
            [],
        )
        .unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();

        let ledger_path = root.join("background-processes/receipts.sqlite3");
        let ledger = Connection::open(&ledger_path).unwrap();
        ledger.execute("INSERT INTO receipts(key,owner_key,session_key,state,code) VALUES(?1,?2,?3,'unknown',NULL)", params![b"claim".as_slice(), owner_key("owner"), b"session".as_slice()]).unwrap();
        drop(ledger);
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();
        let ledger = Connection::open(&ledger_path).unwrap();
        ledger
            .execute("DELETE FROM receipts WHERE key=?1", [b"claim".as_slice()])
            .unwrap();
        drop(ledger);

        let journal = root.join("background-processes/receipts.sqlite3-journal");
        std::fs::write(&journal, b"pending recovery").unwrap();
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();
        std::fs::remove_file(journal).unwrap();

        let guard = root.join(".background-processes.background-guard");
        std::fs::write(&guard, b"corrupt").unwrap();
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();
        std::fs::write(&guard, b"v4-background-ledger-v2-ready\n").unwrap();
        std::fs::rename(&guard, root.join("old.guard")).unwrap();
        use std::io::Write;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&guard)
            .unwrap()
            .write_all(b"v4-background-ledger-v2-ready\n")
            .unwrap();
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();
        assert_eq!(gate.status("owner", "request").unwrap(), "acknowledged");
    }

    #[tokio::test]
    #[ignore = "invoked by the isolated manager-crash test"]
    async fn remote_manager_fixture() {
        use crate::v4_agent::background_process::{BackgroundRequest, BackgroundScope};
        let Some(root) = std::env::var_os("V4_BACKGROUND_QUIESCENCE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let mut db = Connection::open(root.join("terminal.db")).unwrap();
        let manager = bootstrap::open_or_provision(&root, &mut db).unwrap();
        let request = BackgroundRequest {
            scope: BackgroundScope {
                owner: "owner".into(),
                session: "session".into(),
                workspace: root.clone(),
                incarnation: None,
            },
            authorization_generation: Some(0),
            action_id: "remote-action".into(),
            command: "sleep 60".into(),
            timeout: Duration::from_secs(120),
        };
        manager
            .start(request.clone(), Some(&request))
            .await
            .unwrap();
        std::fs::write(root.join("remote-started"), b"started").unwrap();
        let gate = OwnerGate::open(Connection::open(root.join("terminal.db")).unwrap()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while gate.status("owner", "request").is_err() {
            assert!(std::time::Instant::now() < deadline, "hold not observed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
        std::fs::write(root.join("remote-acknowledged"), b"acknowledged").unwrap();
        std::future::pending::<()>().await;
    }

    #[tokio::test]
    async fn acknowledged_remote_manager_crash_preserves_quiescence_proof() {
        let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = data.path().canonicalize().unwrap();
        let database = root.join("terminal.db");
        let mut db = Connection::open(&database).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
        )
        .unwrap();
        let manager = bootstrap::open_or_provision(&root, &mut db).unwrap();
        manager.shutdown().await.unwrap();
        drop(manager);
        let gate = OwnerGate::open(Connection::open(&database).unwrap()).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "v4_agent::background_quiescence::tests::remote_manager_fixture",
                "--ignored",
            ])
            .env("V4_BACKGROUND_QUIESCENCE_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        for marker in ["remote-started", "remote-acknowledged"] {
            if marker == "remote-acknowledged" {
                gate.hold("owner", "request").unwrap();
            }
            while !root.join(marker).exists() {
                if std::time::Instant::now() >= deadline || child.try_wait().unwrap().is_some() {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("remote manager failed before {marker}");
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let tx = db.transaction().unwrap();
        release_in_transaction(&tx, &root, "owner", "request").unwrap();
        tx.commit().unwrap();
        assert!(gate.status("owner", "request").is_err());
    }

    #[tokio::test]
    async fn crash_before_acknowledgment_never_authorizes_release() {
        let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = data.path().canonicalize().unwrap();
        let database = root.join("terminal.db");
        let mut db = Connection::open(&database).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
        )
        .unwrap();
        let manager = bootstrap::open_or_provision(&root, &mut db).unwrap();
        manager.shutdown().await.unwrap();
        drop(manager);
        let gate = OwnerGate::open(Connection::open(&database).unwrap()).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "v4_agent::background_quiescence::tests::remote_manager_fixture",
                "--ignored",
            ])
            .env("V4_BACKGROUND_QUIESCENCE_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !root.join("remote-started").exists() {
            if std::time::Instant::now() >= deadline || child.try_wait().unwrap().is_some() {
                let _ = child.kill();
                let _ = child.wait();
                panic!("remote manager failed before launch");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        child.kill().unwrap();
        child.wait().unwrap();
        gate.hold("owner", "request").unwrap();
        let tx = db.transaction().unwrap();
        assert!(release_in_transaction(&tx, &root, "owner", "request").is_err());
        tx.rollback().unwrap();
        assert_eq!(gate.status("owner", "request").unwrap(), "held");
    }
}
