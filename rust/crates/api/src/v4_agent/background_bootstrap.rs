//! Provisioning boundary for the background receipt ledger.
use super::BackgroundProcesses;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::path::Path;

#[cfg(unix)]
pub(crate) struct SessionBoundary {
    files: Vec<std::fs::File>,
    pid: u32,
}

#[cfg(unix)]
impl SessionBoundary {
    pub(crate) fn try_session(data: &Path, owner: &str, session: &str) -> Result<Self, String> {
        if owner.is_empty()
            || session.is_empty()
            || owner.len() > 256
            || session.len() > 256
            || owner.chars().any(char::is_control)
            || session.chars().any(char::is_control)
        {
            return Err("Invalid background session boundary".into());
        }
        let root = Self::root(data)?;
        let global = Self::lock(
            &root.join(".background-session-boundary.lock"),
            libc::LOCK_SH,
        )?;
        let stripe = format!(
            ".background-session-boundary.{:04x}.lock",
            session_stripe(owner, session)
        );
        let session = Self::lock(&root.join(stripe), libc::LOCK_EX)?;
        Ok(Self {
            files: vec![global, session],
            pid: std::process::id(),
        })
    }

    pub(crate) fn try_acquire(data: &Path) -> Result<Self, String> {
        let root = Self::root(data)?;
        let global = Self::lock(
            &root.join(".background-session-boundary.lock"),
            libc::LOCK_EX,
        )?;
        Ok(Self {
            files: vec![global],
            pid: std::process::id(),
        })
    }

    fn root(data: &Path) -> Result<std::path::PathBuf, String> {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::symlink_metadata(data)
            .map_err(|_| "Background session boundary is unavailable")?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o022 != 0
        {
            return Err("Background session boundary root is unsafe".into());
        }
        data.canonicalize()
            .map_err(|_| "Background session boundary is unavailable".into())
    }

    fn lock(path: &Path, mode: libc::c_int) -> Result<std::fs::File, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| "Background session boundary is unavailable")?;
        let retained = file
            .metadata()
            .map_err(|_| "Background session boundary is unavailable")?;
        if !retained.is_file()
            || retained.uid() != unsafe { libc::geteuid() }
            || retained.nlink() != 1
            || retained.mode() & 0o022 != 0
        {
            return Err("Background session boundary is unsafe".into());
        }
        if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } != 0 {
            return Err("Background provisioning or session deletion is in progress; retry".into());
        }
        let current = std::fs::symlink_metadata(path)
            .map_err(|_| "Background session boundary is unavailable")?;
        if current.file_type().is_symlink()
            || (retained.dev(), retained.ino()) != (current.dev(), current.ino())
        {
            return Err("Background session boundary changed".into());
        }
        Ok(file)
    }
}

#[cfg(unix)]
pub(super) fn session_stripe(owner: &str, session: &str) -> u16 {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update((owner.len() as u64).to_be_bytes());
    hash.update(owner.as_bytes());
    hash.update((session.len() as u64).to_be_bytes());
    hash.update(session.as_bytes());
    let digest = hash.finalize();
    u16::from_be_bytes([digest[0], digest[1]])
}

#[cfg(unix)]
impl Drop for SessionBoundary {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        if self.pid == std::process::id() {
            for file in &self.files {
                unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            }
        }
    }
}

#[cfg(unix)]
pub(crate) enum ExistingInstallation {
    Absent,
    Busy,
    Available(BackgroundProcesses),
}

/// Inspect only an existing installation. The caller must retain the validated
/// auth-database admission fence; absence here is not a release receipt.
#[cfg(unix)]
pub(crate) fn open_existing(data: &Path, db: &Connection) -> Result<ExistingInstallation, String> {
    use super::owner_gate::OwnerGate;
    use std::os::unix::fs::MetadataExt;
    use std::sync::Arc;

    let meta =
        std::fs::symlink_metadata(data).map_err(|_| "Background data directory unavailable")?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o022 != 0
    {
        return Err("Background data directory is unsafe".into());
    }
    let root = data
        .canonicalize()
        .map_err(|_| "Background data directory unavailable")?;
    let path = db
        .path()
        .filter(|path| !path.is_empty())
        .ok_or("Background installation requires an on-disk database")?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Background installation database unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
    {
        return Err("Background installation database is unsafe".into());
    }
    let path = Path::new(path)
        .canonicalize()
        .map_err(|_| "Background installation database unavailable")?;
    if path.parent() != Some(root.as_path()) {
        return Err("Background installation database is outside the data directory".into());
    }
    let synchronous: i64 = db
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(|_| "Background installation database unavailable")?;
    let journal: String = db
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| "Background installation database unavailable")?;
    if synchronous < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
        return Err("Background installation requires durable SQLite settings".into());
    }
    let installed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |row| row.get(0))
        .map_err(|_| "Background installation record unavailable")?;
    if !installed {
        for candidate in [
            root.join("background-processes"),
            root.join(".background-processes.background-guard"),
        ] {
            match std::fs::symlink_metadata(candidate) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => {
                    return Err(
                        "Background installation marker is missing; cleanup is unconfirmed".into(),
                    )
                }
            }
        }
        return Ok(ExistingInstallation::Absent);
    }
    let state: Option<String> = db
        .query_row(
            "SELECT state FROM background_ledger_installation WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Background installation record unavailable")?;
    if state.as_deref() != Some("ready") {
        return Err("Background installation is incomplete; cleanup is unconfirmed".into());
    }
    db.prepare("SELECT owner,request,state FROM background_owner_holds LIMIT 0")
        .map_err(|_| "Background owner control is missing or invalid")?;
    db.prepare("SELECT owner,request,ledger_binding FROM background_owner_quiescence LIMIT 0")
        .map_err(|_| "Background quiescence receipts are missing or invalid")?;
    let gate_db = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "Background owner control unavailable")?;
    let current = std::fs::symlink_metadata(&path)
        .map_err(|_| "Background installation database unavailable")?;
    if current.file_type().is_symlink()
        || (metadata.dev(), metadata.ino()) != (current.dev(), current.ino())
    {
        return Err("Background installation database changed".into());
    }
    let gate = Arc::new(OwnerGate::open(gate_db)?);
    match BackgroundProcesses::open_controlled(&root.join("background-processes"), gate) {
        Ok(manager) => Ok(ExistingInstallation::Available(manager)),
        Err(error) if error == super::ledger::LEDGER_BUSY => Ok(ExistingInstallation::Busy),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
pub(crate) fn open_or_provision(
    data: &Path,
    db: &mut Connection,
) -> Result<BackgroundProcesses, String> {
    use super::owner_gate::OwnerGate;
    use std::os::unix::fs::MetadataExt;
    use std::sync::Arc;
    let _session_boundary = SessionBoundary::try_acquire(data)?;
    #[cfg(test)]
    if let Some(ready) = std::env::var_os("V4_TEST_BACKGROUND_PROVISION_READY") {
        let release = std::env::var_os("V4_TEST_BACKGROUND_PROVISION_RELEASE")
            .ok_or("Missing test release path")?;
        std::fs::write(ready, b"ready").map_err(|_| "Cannot signal test provisioning")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !Path::new(&release).exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !Path::new(&release).exists() {
            return Err("Test provisioning timed out".into());
        }
    }
    let meta =
        std::fs::symlink_metadata(data).map_err(|_| "Background data directory unavailable")?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o022 != 0
    {
        return Err("Background data directory is unsafe".into());
    }
    let root = std::fs::canonicalize(data).map_err(|_| "Background data directory unavailable")?;
    let db_path = db
        .path()
        .filter(|path| !path.is_empty())
        .ok_or("Background installation requires an on-disk database")?;
    let db_meta = std::fs::symlink_metadata(db_path)
        .map_err(|_| "Background installation database unavailable")?;
    if !db_meta.is_file()
        || db_meta.file_type().is_symlink()
        || db_meta.uid() != unsafe { libc::geteuid() }
    {
        return Err("Background installation database is unsafe".into());
    }
    let db_path = std::fs::canonicalize(db_path)
        .map_err(|_| "Background installation database unavailable")?;
    if db_path.parent() != Some(root.as_path()) {
        return Err("Background installation database is outside the data directory".into());
    }
    let synchronous: i64 = db
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(|_| "Background installation database unavailable")?;
    let journal: String = db
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| "Background installation database unavailable")?;
    if synchronous < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
        return Err("Background installation requires durable SQLite settings".into());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "Background installation is busy")?;
    let installed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |r| r.get(0))
        .map_err(|_| "Background installation record unavailable")?;
    if !installed {
        tx.execute_batch("CREATE TABLE background_ledger_installation (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)")
            .map_err(|_| "Background installation database unavailable")?;
    }
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM background_ledger_installation WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Background installation record unavailable")?;
    let create = match state.as_deref() {
        None if !installed => {
            OwnerGate::initialize(&tx)?;
            inherit_structured_holds(&tx)?;
            tx.execute(
                "INSERT INTO background_ledger_installation(id,state) VALUES(1,'initializing')",
                [],
            )
            .map_err(|_| "Cannot reserve background installation")?;
            true
        }
        Some("ready") => false,
        _ => return Err("Background installation is incomplete; review required".into()),
    };
    tx.commit()
        .map_err(|_| "Cannot commit background installation")?;
    let gate_db =
        Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| "Background owner control unavailable")?;
    let gate = Arc::new(OwnerGate::open(gate_db)?);
    let path = root.join("background-processes");
    if !create {
        return BackgroundProcesses::open_controlled(&path, gate);
    }
    let manager = BackgroundProcesses::create_controlled(&path, gate)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "Background installation is busy")?;
    if tx.execute("UPDATE background_ledger_installation SET state='ready' WHERE id=1 AND state='initializing'", []).map_err(|_| "Cannot finalize background installation")? != 1 {
        return Err("Background installation record changed".into());
    }
    tx.commit()
        .map_err(|_| "Cannot finalize background installation")?;
    Ok(manager)
}

#[cfg(unix)]
fn inherit_structured_holds(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    use super::owner_gate::OwnerGate;
    let has_identity: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_admission_identity')", [], |r| r.get(0))
        .map_err(|_| "Cannot inspect owner cleanup installation")?;
    let has_version: bool = if has_identity {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='structured_cleanup_version')", [], |r| r.get(0))
            .map_err(|_| "Cannot inspect owner cleanup installation")?
    } else {
        false
    };
    let version: i64 = if has_version {
        tx.query_row(
            "SELECT structured_cleanup_version FROM auth_admission_identity WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "Owner cleanup installation is unavailable")?
    } else {
        0
    };
    if version == 0 {
        let existing: i64 = tx.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('structured_owner_holds','structured_owner_cleanup_receipts','structured_owner_delegation_receipts','structured_owner_cleanup_issues','structured_owner_background_reviews','structured_owner_delegation_reviews')", [], |r| r.get(0))
            .map_err(|_| "Cannot inspect owner cleanup installation")?;
        return if existing == 0 {
            Ok(())
        } else {
            Err("Owner cleanup installation is incomplete".into())
        };
    }
    if version != 1 && version != 2 && version != 3 && version != 4 {
        return Err("Unsupported owner cleanup installation".into());
    }
    tx.prepare("SELECT owner,request,lease_epoch FROM structured_owner_cleanup_receipts LIMIT 0")
        .map_err(|_| "Owner cleanup receipts are unavailable")?;
    tx.prepare("SELECT owner,request,supervisor_instance,outbox_identity FROM structured_owner_delegation_receipts LIMIT 0")
        .map_err(|_| "Owner delegation receipts are unavailable")?;
    if version >= 2 {
        tx.prepare(
            "SELECT owner,request,resource,code FROM structured_owner_cleanup_issues LIMIT 0",
        )
        .map_err(|_| "Owner cleanup issues are unavailable")?;
    }
    if version >= 3 {
        tx.prepare("SELECT owner,request,operation,count,ledger_binding FROM structured_owner_background_reviews LIMIT 0")
            .map_err(|_| "Background review audit is unavailable")?;
    }
    if version == 4 {
        tx.prepare("SELECT owner,request,operation,child_operation,task,child_session,outbox_identity FROM structured_owner_delegation_reviews LIMIT 0")
            .map_err(|_| "Delegation review audit is unavailable")?;
    }
    let mut query = tx
        .prepare("SELECT owner,request FROM structured_owner_holds ORDER BY owner LIMIT 4097")
        .map_err(|_| "Owner cleanup holds are unavailable")?;
    let rows = query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| "Cannot inspect owner cleanup holds")?;
    let mut count = 0;
    for row in rows {
        let (owner, request) = row.map_err(|_| "Invalid owner cleanup hold")?;
        count += 1;
        if count > 4096 || uuid::Uuid::parse_str(&request).is_err() {
            return Err("Invalid owner cleanup hold".into());
        }
        OwnerGate::hold_in_transaction(tx, &owner, &request)?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn open_or_provision(
    _data: &Path,
    _db: &mut Connection,
) -> Result<BackgroundProcesses, String> {
    Err("Background processes are unavailable on this platform".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn stalled_session_deletion_does_not_block_another_owner_but_excludes_provisioning() {
        let data = tempfile::tempdir().unwrap();
        let held = SessionBoundary::try_session(data.path(), "alice", "session-a").unwrap();
        assert!(SessionBoundary::try_session(data.path(), "alice", "session-a").is_err());
        assert!(SessionBoundary::try_session(data.path(), "bob", "session-b").is_ok());
        assert!(SessionBoundary::try_acquire(data.path()).is_err());
        drop(held);
        assert!(SessionBoundary::try_acquire(data.path()).is_ok());
    }

    #[test]
    fn stripe_collisions_fail_closed_with_retryable_error() {
        let data = tempfile::tempdir().unwrap();
        let mut seen = std::collections::HashMap::new();
        let mut collision = None;
        for index in 0..=65536 {
            let session = format!("session-{index}");
            let stripe = session_stripe("owner", &session);
            if let Some(previous) = seen.insert(stripe, session.clone()) {
                collision = Some((previous, session));
                break;
            }
        }
        let (first, second) = collision.expect("65537 distinct sessions must share a stripe");
        let _held = SessionBoundary::try_session(data.path(), "owner", &first).unwrap();
        let error = SessionBoundary::try_session(data.path(), "owner", &second)
            .err()
            .unwrap();
        assert!(error.contains("retry"));
    }

    #[test]
    fn provisioning_does_not_begin_while_session_deletion_holds_the_boundary() {
        let data = tempfile::tempdir().unwrap();
        let mut db = Connection::open(data.path().join("app.sqlite")).unwrap();
        structured_installation(&db);
        let boundary = SessionBoundary::try_acquire(data.path()).unwrap();
        assert!(open_or_provision(data.path(), &mut db).is_err());
        let installed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |row| row.get(0)).unwrap();
        assert!(!installed);
        drop(boundary);
        drop(open_or_provision(data.path(), &mut db).unwrap());
    }

    #[test]
    fn boundary_rejects_a_symlinked_lock_file() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            data.path().join(".background-session-boundary.lock"),
        )
        .unwrap();
        assert!(SessionBoundary::try_acquire(data.path()).is_err());
    }

    fn structured_installation(db: &Connection) {
        db.execute_batch("CREATE TABLE auth_admission_identity(id INTEGER PRIMARY KEY, structured_cleanup_version INTEGER NOT NULL); INSERT INTO auth_admission_identity VALUES(1,1); CREATE TABLE structured_owner_holds(owner TEXT PRIMARY KEY,request TEXT NOT NULL); CREATE TABLE structured_owner_cleanup_receipts(owner TEXT PRIMARY KEY,request TEXT NOT NULL,lease_epoch TEXT NOT NULL); CREATE TABLE structured_owner_delegation_receipts(owner TEXT PRIMARY KEY,request TEXT NOT NULL,supervisor_instance TEXT NOT NULL,outbox_identity TEXT NOT NULL); CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY,generation INTEGER NOT NULL)").unwrap();
    }

    #[tokio::test]
    async fn provisioning_inherits_existing_logout_and_releases_only_exact_receipt() {
        use super::super::owner_gate::OwnerGate;
        let data = tempfile::tempdir().unwrap();
        let root = data.path().canonicalize().unwrap();
        let path = root.join("app.sqlite");
        let mut db = Connection::open(&path).unwrap();
        structured_installation(&db);
        let request = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO structured_owner_holds VALUES('owner',?1)",
            [&request],
        )
        .unwrap();
        let manager = open_or_provision(&root, &mut db).unwrap();
        let gate = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        assert!(gate.admit_generation("owner", 0, || Ok(())).is_err());
        assert!(gate.admit_generation("other", 0, || Ok(())).is_ok());
        assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
        let tx = db.transaction().unwrap();
        assert!(
            crate::v4_agent::background_quiescence::release_in_transaction(
                &tx, &root, "owner", "wrong"
            )
            .is_err()
        );
        crate::v4_agent::background_quiescence::release_in_transaction(
            &tx, &root, "owner", &request,
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(gate.admit_generation("owner", 0, || Ok(())).is_ok());
        manager.shutdown().await.unwrap();
    }

    #[test]
    fn provisioning_rejects_missing_or_malformed_structured_installation() {
        for malformed in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let mut db = Connection::open(data.path().join("app.sqlite")).unwrap();
            structured_installation(&db);
            if malformed {
                db.execute(
                    "INSERT INTO structured_owner_holds VALUES('owner','invalid-uuid')",
                    [],
                )
                .unwrap();
            } else {
                db.execute("DROP TABLE structured_owner_holds", []).unwrap();
            }
            assert!(open_or_provision(data.path(), &mut db).is_err());
            assert!(!data.path().join("background-processes").exists());
            assert!(!db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='background_ledger_installation')", [], |r| r.get::<_, bool>(0)).unwrap());
        }
    }

    #[test]
    fn provisioning_checks_newer_cleanup_schema_before_inheriting_holds() {
        for version in [2, 3, 4] {
            for complete in [false, true] {
                let data = tempfile::tempdir().unwrap();
                let mut db = Connection::open(data.path().join("app.sqlite")).unwrap();
                structured_installation(&db);
                db.execute(
                    "UPDATE auth_admission_identity SET structured_cleanup_version=?1",
                    [version],
                )
                .unwrap();
                let request = uuid::Uuid::new_v4().to_string();
                db.execute(
                    "INSERT INTO structured_owner_holds VALUES('owner',?1)",
                    [&request],
                )
                .unwrap();
                if complete {
                    db.execute("CREATE TABLE structured_owner_cleanup_issues(owner TEXT NOT NULL,request TEXT NOT NULL,resource TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(owner,request,resource))", []).unwrap();
                    if version >= 3 {
                        db.execute("CREATE TABLE structured_owner_background_reviews(owner TEXT NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL,count INTEGER NOT NULL,ledger_binding BLOB NOT NULL,PRIMARY KEY(owner,operation))", []).unwrap();
                    }
                    if version == 4 {
                        db.execute("CREATE TABLE structured_owner_delegation_reviews(owner TEXT NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL,child_operation TEXT NOT NULL,task TEXT NOT NULL,child_session TEXT NOT NULL,outbox_identity TEXT NOT NULL,PRIMARY KEY(owner,operation),UNIQUE(owner,request,child_operation))", []).unwrap();
                    }
                }
                let result = open_or_provision(data.path(), &mut db);
                assert_eq!(result.is_ok(), complete);
                if let Ok(manager) = result {
                    let inherited: String = db
                        .query_row(
                            "SELECT request FROM background_owner_holds WHERE owner='owner'",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap();
                    assert_eq!(inherited, request);
                    drop(manager);
                }
            }
        }
    }

    #[test]
    fn provisioning_rejects_unrecognized_or_unmarked_cleanup_state() {
        for unknown_version in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let mut db = Connection::open(data.path().join("app.sqlite")).unwrap();
            structured_installation(&db);
            let version = if unknown_version { 3 } else { 0 };
            db.execute(
                "UPDATE auth_admission_identity SET structured_cleanup_version=?1",
                [version],
            )
            .unwrap();
            assert!(open_or_provision(data.path(), &mut db).is_err());
            assert!(!data.path().join("background-processes").exists());
        }
    }

    #[test]
    fn logout_after_provisioning_records_same_request_in_both_gates() {
        let data = tempfile::tempdir().unwrap();
        let mut db = Connection::open(data.path().join("app.sqlite")).unwrap();
        structured_installation(&db);
        let manager = open_or_provision(data.path(), &mut db).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let tx = db.transaction().unwrap();
        super::super::owner_gate::hold_logout_if_installed_with_request(&tx, "owner", &request)
            .unwrap();
        tx.execute(
            "INSERT INTO structured_owner_holds VALUES('owner',?1)",
            [&request],
        )
        .unwrap();
        tx.commit().unwrap();
        let row: (String, String) = db.query_row("SELECT s.request,b.request FROM structured_owner_holds s JOIN background_owner_holds b ON s.owner=b.owner WHERE s.owner='owner'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(row, (request.clone(), request));
        drop(manager);
    }

    #[test]
    fn provisioning_waits_for_concurrent_logout_and_inherits_its_hold() {
        use std::sync::mpsc;
        use std::time::Duration;
        let data = tempfile::tempdir().unwrap();
        let root = data.path().canonicalize().unwrap();
        let path = root.join("app.sqlite");
        let mut db = Connection::open(&path).unwrap();
        structured_installation(&db);
        let request = uuid::Uuid::new_v4().to_string();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        super::super::owner_gate::hold_logout_if_installed_with_request(&tx, "owner", &request)
            .unwrap();
        tx.execute(
            "INSERT INTO structured_owner_holds VALUES('owner',?1)",
            [&request],
        )
        .unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let join = std::thread::spawn(move || {
            let mut db = Connection::open(path).unwrap();
            db.busy_timeout(Duration::from_secs(5)).unwrap();
            started_tx.send(()).unwrap();
            let result = open_or_provision(&root, &mut db);
            done_tx.send(result.map(drop)).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        tx.commit().unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        join.join().unwrap();
        let inherited: String = db
            .query_row(
                "SELECT request FROM background_owner_holds WHERE owner='owner'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(inherited, request);
    }

    #[test]
    fn existing_open_does_not_provision_or_hide_incomplete_installation() {
        let root = tempfile::tempdir().unwrap();
        let db = Connection::open(root.path().join("terminal.db")).unwrap();
        assert!(matches!(
            open_existing(root.path(), &db).unwrap(),
            ExistingInstallation::Absent
        ));
        assert!(!root.path().join("background-processes").exists());
        assert!(!root
            .path()
            .join(".background-processes.background-guard")
            .exists());
        assert!(!db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='background_ledger_installation')", [], |row| row.get::<_, bool>(0)).unwrap());
        std::fs::write(
            root.path().join(".background-processes.background-guard"),
            b"fixture",
        )
        .unwrap();
        assert!(open_existing(root.path(), &db).is_err());
        assert!(!root.path().join("background-processes").exists());
    }

    #[test]
    fn existing_receipt_open_never_recreates_or_uses_replaced_file() {
        use std::os::unix::fs::OpenOptionsExt;
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("receipt.sqlite3");
        let original = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(super::super::ledger::open_receipt_database(&path, &original).is_err());
        assert!(!path.exists());
        std::fs::write(&path, b"replacement").unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();
        assert!(super::super::ledger::open_receipt_database(&path, &original).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    }

    #[tokio::test]
    async fn existing_open_reports_busy_then_takes_over_and_acknowledges() {
        use super::super::owner_gate::OwnerGate;
        use std::sync::Arc;
        let data = tempfile::tempdir().unwrap();
        let root = data.path().canonicalize().unwrap();
        let path = root.join("terminal.db");
        let mut db = Connection::open(&path).unwrap();
        let first = open_or_provision(&root, &mut db).unwrap();
        let gate = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        gate.hold("owner", "request").unwrap();
        let second_db = Connection::open(&path).unwrap();
        assert!(matches!(
            open_existing(&root, &second_db).unwrap(),
            ExistingInstallation::Busy
        ));
        drop(first);
        let ExistingInstallation::Available(second) = open_existing(&root, &second_db).unwrap()
        else {
            panic!("expected takeover")
        };
        let second = Arc::new(second);
        assert!(!second.owner_cleanup_unconfirmed("owner").unwrap());
        assert_eq!(second.service_owner_holds().await.unwrap(), 1);
        let tx = db.transaction().unwrap();
        crate::v4_agent::background_quiescence::release_in_transaction(
            &tx, &root, "owner", "request",
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(gate.status("owner", "request").is_err());
        second.shutdown().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "invoked by the subprocess takeover test"]
    async fn existing_open_remote_fixture() {
        let Some(root) = std::env::var_os("V4_BACKGROUND_EXISTING_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let db = Connection::open(root.join("terminal.db")).unwrap();
        let ExistingInstallation::Available(manager) = open_existing(&root, &db).unwrap() else {
            panic!("expected existing manager")
        };
        std::fs::write(root.join("remote-ready"), b"ready").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while !root.join("remote-release").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn existing_open_takes_over_after_a_remote_process_exits() {
        use super::super::owner_gate::OwnerGate;
        use std::time::{Duration, Instant};
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = data.path().canonicalize().unwrap();
        let path = root.join("terminal.db");
        let mut db = Connection::open(&path).unwrap();
        let initial = open_or_provision(&root, &mut db).unwrap();
        initial.shutdown().await.unwrap();
        drop(initial);
        let gate = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        gate.hold("owner", "request").unwrap();
        let mut child = ChildGuard(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "v4_agent::background_process::bootstrap::tests::existing_open_remote_fixture",
                    "--ignored",
                ])
                .env("V4_BACKGROUND_EXISTING_ROOT", &root)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("remote-ready").exists() {
            assert!(
                Instant::now() < deadline && child.0.try_wait().unwrap().is_none(),
                "remote manager did not acquire the ledger"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(matches!(
            open_existing(&root, &db).unwrap(),
            ExistingInstallation::Busy
        ));
        std::fs::write(root.join("remote-release"), b"release").unwrap();
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "remote manager did not release the ledger"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let ExistingInstallation::Available(manager) = open_existing(&root, &db).unwrap() else {
            panic!("expected takeover")
        };
        assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
        let tx = db.transaction().unwrap();
        crate::v4_agent::background_quiescence::release_in_transaction(
            &tx, &root, "owner", "request",
        )
        .unwrap();
        tx.commit().unwrap();
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn existing_open_keeps_unknown_owner_receipt_unconfirmed() {
        use super::super::{owner_gate::OwnerGate, BackgroundScope};
        let data = tempfile::tempdir().unwrap();
        let root = data.path().canonicalize().unwrap();
        let path = root.join("terminal.db");
        let mut db = Connection::open(&path).unwrap();
        let first = open_or_provision(&root, &mut db).unwrap();
        let scope = BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: root.clone(),
            incarnation: None,
        };
        first.ledger.claim(&scope, "unknown-action").unwrap();
        let gate = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        gate.hold("owner", "request").unwrap();
        gate.hold("other", "other-request").unwrap();
        drop(first);
        let ExistingInstallation::Available(second) = open_existing(&root, &db).unwrap() else {
            panic!("expected takeover")
        };
        assert!(second.owner_cleanup_unconfirmed("owner").unwrap());
        assert!(!second.owner_cleanup_unconfirmed("other").unwrap());
        assert!(second.service_owner_holds().await.is_err());
        assert_eq!(gate.status("owner", "request").unwrap(), "held");
        assert_eq!(
            gate.status("other", "other-request").unwrap(),
            "acknowledged"
        );
        assert!(second.shutdown().await.is_err());
    }

    #[test]
    fn provisioning_rejects_in_memory_or_foreign_authorization_databases() {
        let data = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let mut memory = Connection::open_in_memory().unwrap();
        let mut foreign_db = Connection::open(foreign.path().join("app.sqlite")).unwrap();
        assert!(open_or_provision(data.path(), &mut memory).is_err());
        assert!(open_or_provision(data.path(), &mut foreign_db).is_err());
        assert!(!data.path().join("background-processes").exists());
    }

    #[tokio::test]
    async fn provisioned_manager_obeys_shared_owner_holds_and_never_recreates_them() {
        use super::super::{owner_gate::OwnerGate, BackgroundRequest, BackgroundScope};
        use std::time::Duration;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
        let manager = open_or_provision(root.path(), &mut db).unwrap();
        let remote = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        remote.hold("owner", "logout").unwrap();
        let request = BackgroundRequest {
            scope: BackgroundScope {
                owner: "owner".into(),
                session: "session".into(),
                workspace: root.path().canonicalize().unwrap(),
                incarnation: None,
            },
            authorization_generation: Some(0),
            action_id: "held".into(),
            command: "printf launched > marker".into(),
            timeout: Duration::from_secs(5),
        };
        let result = manager.start(request.clone(), Some(&request)).await;
        manager.shutdown().await.unwrap();
        assert!(result.is_err());
        assert!(!root.path().join("marker").exists());
        drop(manager);
        db.execute("DROP TABLE background_owner_holds", []).unwrap();
        assert!(open_or_provision(root.path(), &mut db).is_err());
        assert!(db.prepare("SELECT * FROM background_owner_holds").is_err());
    }

    #[test]
    fn marked_ledger_opens_after_restart_and_never_recreates_missing_state() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Connection::open(root.path().join("app.sqlite")).unwrap();
        let manager = open_or_provision(root.path(), &mut db).unwrap();
        drop(manager);
        let manager = open_or_provision(root.path(), &mut db).unwrap();
        drop(manager);
        let path = root.path().join("background-processes");
        std::fs::rename(&path, root.path().join("retained-ledger")).unwrap();
        assert!(open_or_provision(root.path(), &mut db).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn concurrent_owner_is_not_reinitialized_and_incomplete_provision_stays_held() {
        let root = tempfile::tempdir().unwrap();
        let mut first = Connection::open(root.path().join("app.sqlite")).unwrap();
        let mut second = Connection::open(root.path().join("app.sqlite")).unwrap();
        let manager = open_or_provision(root.path(), &mut first).unwrap();
        assert!(open_or_provision(root.path(), &mut second).is_err());
        drop(manager);
        first
            .execute(
                "UPDATE background_ledger_installation SET state='initializing'",
                [],
            )
            .unwrap();
        assert!(open_or_provision(root.path(), &mut second).is_err());
    }
}
