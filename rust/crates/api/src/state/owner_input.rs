//! Per-owner ordering for revocation and supervised raw-input delivery.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const RETRY_WINDOW_MS: i64 = 15 * 60 * 1000;
const FUTURE_SKEW_MS: i64 = 5_000;
const RECEIPT_LIMIT: i64 = 10_000;

pub(super) fn installed(tx: &rusqlite::Transaction<'_>) -> Result<bool, String> {
    let has_column: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='owner_input_version')", [], |row| row.get(0)).map_err(|_| "Input admission installation unavailable")?;
    if !has_column {
        return Ok(false);
    }
    let version: i64 = tx
        .query_row(
            "SELECT owner_input_version FROM auth_admission_identity WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "Input admission installation unavailable")?;
    match version {
        0 => Ok(false),
        1 | 2 => {
            tx.prepare("SELECT owner_hash, device, inode FROM owner_input_locks LIMIT 0")
                .map_err(|_| "Input lock identity unavailable")?;
            tx.prepare("SELECT sequence, owner_hash, session_hash, session_id, operation_id, status, issued_ms FROM owner_input_receipts LIMIT 0").map_err(|_| "Input receipt storage unavailable")?;
            tx.prepare("SELECT owner_hash, observed_ms FROM owner_input_watermarks LIMIT 0")
                .map_err(|_| "Input watermark storage unavailable")?;
            Ok(true)
        }
        _ => Err("Unsupported input admission installation".into()),
    }
}

#[cfg(any(test, feature = "supervised-input-preview"))]
pub(super) fn install(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let has_column: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='owner_input_version')", [], |row| row.get(0)).map_err(|_| "Input admission installation unavailable")?;
    if !has_column {
        tx.execute_batch("ALTER TABLE auth_admission_identity ADD COLUMN owner_input_version INTEGER NOT NULL DEFAULT 0").map_err(|_| "Input admission installation unavailable")?;
    }
    if installed(tx)? {
        tx.execute("UPDATE auth_admission_identity SET owner_input_version=2 WHERE id=1 AND owner_input_version=1", []).map_err(|_| "Input admission installation unavailable")?;
        return Ok(());
    }
    tx.execute_batch("CREATE TABLE owner_input_locks(owner_hash TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL); CREATE TABLE owner_input_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL, session_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL, issued_ms INTEGER NOT NULL, UNIQUE(owner_hash, operation_id)); CREATE TABLE owner_input_watermarks(owner_hash TEXT PRIMARY KEY, observed_ms INTEGER NOT NULL)").map_err(|_| "Cannot initialize input receipt storage")?;
    tx.execute("UPDATE auth_admission_identity SET owner_input_version=2 WHERE id=1 AND owner_input_version=0", []).map_err(|_| "Input admission installation unavailable")?;
    if !installed(tx)? {
        return Err("Input admission installation unavailable".into());
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct IssuedInput {
    purpose: String,
    owner_hash: String,
    session_hash: String,
    incarnation: String,
    generation: u64,
    operation: String,
    exp: usize,
}

pub(crate) fn issue(
    secret: &str,
    owner: &str,
    session: &str,
    incarnation: &str,
    generation: u64,
    now_ms: i64,
) -> Result<(String, String), String> {
    let operation = new_operation(now_ms)?;
    let claims = IssuedInput {
        purpose: "structured-raw-input-v1".into(),
        owner_hash: hex::encode(Sha256::digest(owner.as_bytes())),
        session_hash: hex::encode(Sha256::digest(session.as_bytes())),
        incarnation: incarnation.into(),
        generation,
        operation: operation.clone(),
        exp: (now_ms.saturating_add(RETRY_WINDOW_MS) / 1000) as usize,
    };
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| "Cannot issue input request")?;
    Ok((operation, token))
}

pub(crate) fn verify_token(
    secret: &str,
    token: &str,
    owner: &str,
    session: &str,
) -> Result<(String, String, u64, i64), String> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<IssuedInput>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| "Input request token is invalid or expired")?
    .claims;
    if claims.purpose != "structured-raw-input-v1"
        || claims.owner_hash != hex::encode(Sha256::digest(owner.as_bytes()))
        || claims.session_hash != hex::encode(Sha256::digest(session.as_bytes()))
    {
        return Err("Input request token does not match this session".into());
    }
    operation_time(&claims.operation)?;
    let expiry = i64::try_from(claims.exp)
        .map_err(|_| "Input request expiry is invalid")?
        .saturating_mul(1000);
    Ok((
        claims.operation,
        claims.incarnation,
        claims.generation,
        expiry,
    ))
}

pub(crate) fn new_operation(now_ms: i64) -> Result<String, String> {
    if !(0..(1_i64 << 48)).contains(&now_ms) {
        return Err("Input clock is invalid".into());
    }
    let mut bytes = *uuid::Uuid::new_v4().as_bytes();
    let time = (now_ms as u64).to_be_bytes();
    bytes[..6].copy_from_slice(&time[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

fn operation_time(operation: &str) -> Result<i64, String> {
    let id = uuid::Uuid::parse_str(operation).map_err(|_| "Input requestId is invalid")?;
    let bytes = id.as_bytes();
    if bytes[6] >> 4 != 7 || bytes[8] & 0xc0 != 0x80 {
        return Err("Input requestId must be a time-bounded UUID".into());
    }
    let mut time = [0_u8; 8];
    time[2..].copy_from_slice(&bytes[..6]);
    Ok(u64::from_be_bytes(time) as i64)
}

pub(crate) struct OwnerInputGuard {
    file: File,
    path: PathBuf,
    owner_hash: String,
}

impl OwnerInputGuard {
    pub(super) fn has_unresolved(
        &self,
        tx: &rusqlite::Transaction<'_>,
        session: &str,
    ) -> Result<bool, String> {
        let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
        tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_input_receipts WHERE owner_hash=?1 AND session_hash=?2 AND status IN ('issued', 'uncertain', 'delivered'))", rusqlite::params![self.owner_hash, session_hash], |row| row.get(0)).map_err(|_| "Input receipt storage unavailable".into())
    }
    fn verify(&self) -> Result<(u64, u64), String> {
        let opened = self
            .file
            .metadata()
            .map_err(|_| "Owner input lock unavailable")?;
        let current =
            std::fs::symlink_metadata(&self.path).map_err(|_| "Owner input lock unavailable")?;
        if !opened.is_file()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || opened.nlink() != 1
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Owner input lock changed or is unsafe".into());
        }
        Ok((opened.dev(), opened.ino()))
    }

    pub(super) fn bind(&self, tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
        let (dev, ino) = self.verify()?;
        tx.execute("INSERT OR IGNORE INTO owner_input_locks(owner_hash, device, inode) VALUES (?1, ?2, ?3)", rusqlite::params![self.owner_hash, dev.to_string(), ino.to_string()]).map_err(|_| "Owner input identity unavailable")?;
        let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_input_locks WHERE owner_hash=?1 AND device=?2 AND inode=?3)", rusqlite::params![self.owner_hash, dev.to_string(), ino.to_string()], |row| row.get(0)).map_err(|_| "Owner input identity unavailable")?;
        if !valid {
            return Err("Owner input lock identity changed".into());
        }
        self.verify()?;
        Ok(())
    }

    pub(super) fn advance_watermark(
        &self,
        tx: &rusqlite::Transaction<'_>,
        now_ms: i64,
    ) -> Result<i64, String> {
        if now_ms < 0 {
            return Err("Input clock is invalid".into());
        }
        tx.execute("INSERT INTO owner_input_watermarks(owner_hash, observed_ms) VALUES (?1, ?2) ON CONFLICT(owner_hash) DO UPDATE SET observed_ms=MAX(observed_ms, excluded.observed_ms)", rusqlite::params![self.owner_hash, now_ms]).map_err(|_| "Input receipt storage unavailable")?;
        let effective_now: i64 = tx
            .query_row(
                "SELECT observed_ms FROM owner_input_watermarks WHERE owner_hash=?1",
                [&self.owner_hash],
                |row| row.get(0),
            )
            .map_err(|_| "Input receipt storage unavailable")?;
        let cutoff = effective_now.saturating_sub(RETRY_WINDOW_MS).max(0);
        tx.execute("DELETE FROM owner_input_receipts WHERE owner_hash=?1 AND status IN ('acknowledged', 'reviewed') AND issued_ms < ?2", rusqlite::params![self.owner_hash, cutoff]).map_err(|_| "Input receipt storage unavailable")?;
        Ok(cutoff)
    }

    fn check_window(
        &self,
        tx: &rusqlite::Transaction<'_>,
        operation: &str,
        now_ms: i64,
    ) -> Result<i64, String> {
        let issued = operation_time(operation)?;
        let cutoff = self.advance_watermark(tx, now_ms)?;
        if issued > now_ms.saturating_add(FUTURE_SKEW_MS) || issued < cutoff {
            return Err("Input requestId is outside the retry window; create a new request".into());
        }
        Ok(issued)
    }

    pub(super) fn claim(
        &self,
        tx: &rusqlite::Transaction<'_>,
        session: &str,
        operation: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let issued = self.check_window(tx, operation, now_ms)?;
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM owner_input_receipts WHERE owner_hash=?1",
                [&self.owner_hash],
                |row| row.get(0),
            )
            .map_err(|_| "Input receipt storage unavailable")?;
        if count >= RECEIPT_LIMIT {
            return Err(
                "Input receipt capacity reached; review uncertain input before continuing".into(),
            );
        }
        let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
        let held: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_input_receipts WHERE owner_hash=?1 AND session_hash=?2 AND status IN ('issued', 'uncertain', 'delivered'))", rusqlite::params![self.owner_hash, session_hash], |row| row.get(0)).map_err(|_| "Input receipt storage unavailable")?;
        if held {
            return Err("Review the pending input for this session before sending another".into());
        }
        let inserted = tx.execute("INSERT OR IGNORE INTO owner_input_receipts(owner_hash, session_hash, session_id, operation_id, status, issued_ms) VALUES (?1, ?2, ?3, ?4, 'uncertain', ?5)", rusqlite::params![self.owner_hash, session_hash, session, operation, issued]).map_err(|_| "Input receipt storage unavailable")?;
        if inserted != 1 {
            return Err(
                "Input operation already exists; inspect its receipt before retrying".into(),
            );
        }
        Ok(())
    }

    pub(super) fn reserve(
        &self,
        tx: &rusqlite::Transaction<'_>,
        session: &str,
        operation: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        self.claim(tx, session, operation, now_ms)?;
        let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
        tx.execute("UPDATE owner_input_receipts SET status='issued' WHERE owner_hash=?1 AND session_hash=?2 AND operation_id=?3 AND status='uncertain'", rusqlite::params![self.owner_hash, session_hash, operation]).map_err(|_| "Input receipt storage unavailable")?;
        Ok(())
    }

    pub(super) fn activate(
        &self,
        tx: &rusqlite::Transaction<'_>,
        session: &str,
        operation: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        self.check_window(tx, operation, now_ms)?;
        let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
        let changed = tx.execute("UPDATE owner_input_receipts SET status='uncertain' WHERE owner_hash=?1 AND session_hash=?2 AND operation_id=?3 AND status='issued'", rusqlite::params![self.owner_hash, session_hash, operation]).map_err(|_| "Input receipt storage unavailable")?;
        if changed != 1 {
            return Err(
                "Input operation is settled or already submitted; inspect its receipt".into(),
            );
        }
        Ok(())
    }

    pub(super) fn finish(
        &self,
        tx: &rusqlite::Transaction<'_>,
        session: &str,
        operation: &str,
        status: &str,
    ) -> Result<(), String> {
        if !matches!(status, "delivered" | "uncertain" | "acknowledged") {
            return Err("Invalid input receipt state".into());
        }
        let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
        let changed = tx.execute("UPDATE owner_input_receipts SET status=?1 WHERE owner_hash=?2 AND session_hash=?3 AND operation_id=?4 AND status='uncertain'", rusqlite::params![status, self.owner_hash, session_hash, operation]).map_err(|_| "Input receipt storage unavailable")?;
        if changed != 1 {
            return Err("Input receipt is unavailable".into());
        }
        Ok(())
    }

    pub(super) fn review(
        &self,
        tx: &rusqlite::Transaction<'_>,
        session: &str,
        operation: &str,
    ) -> Result<String, String> {
        let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
        let status: String = tx.query_row("UPDATE owner_input_receipts SET status=CASE status WHEN 'delivered' THEN 'acknowledged' WHEN 'issued' THEN 'reviewed' WHEN 'uncertain' THEN 'reviewed' ELSE status END WHERE owner_hash=?1 AND session_hash=?2 AND operation_id=?3 AND status IN ('issued', 'uncertain', 'delivered', 'reviewed', 'acknowledged') RETURNING status", rusqlite::params![self.owner_hash, session_hash, operation], |row| row.get(0)).map_err(|_| "Input receipt unavailable for acknowledgment or review")?;
        Ok(status)
    }
}

pub(super) fn receipts(
    connection: &rusqlite::Connection,
    owner: &str,
    session: &str,
) -> Result<Vec<(String, String)>, String> {
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_input_receipts')", [], |row| row.get(0)).map_err(|_| "Input receipt storage unavailable")?;
    if !exists {
        return Ok(Vec::new());
    }
    let owner_hash = hex::encode(Sha256::digest(owner.as_bytes()));
    let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
    let mut statement = connection.prepare("SELECT operation_id, status FROM owner_input_receipts WHERE owner_hash=?1 AND session_hash=?2 ORDER BY rowid DESC LIMIT 128").map_err(|_| "Input receipt storage unavailable")?;
    let rows = statement
        .query_map(rusqlite::params![owner_hash, session_hash], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|_| "Input receipt storage unavailable")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Input receipt storage unavailable".into())
}

pub(super) fn unresolved_receipts(
    connection: &rusqlite::Connection,
    owner: &str,
    after: i64,
) -> Result<(Vec<(String, String, String)>, Option<i64>), String> {
    if after < 0 {
        return Err("Invalid input receipt cursor".into());
    }
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_input_receipts')", [], |row| row.get(0)).map_err(|_| "Input receipt storage unavailable")?;
    if !exists {
        return Ok((Vec::new(), None));
    }
    let owner_hash = hex::encode(Sha256::digest(owner.as_bytes()));
    let mut statement = connection.prepare("SELECT sequence, session_id, operation_id, status FROM owner_input_receipts WHERE owner_hash=?1 AND sequence>?2 AND status IN ('issued', 'uncertain', 'delivered') ORDER BY sequence LIMIT 129").map_err(|_| "Input receipt storage unavailable")?;
    let rows = statement
        .query_map(rusqlite::params![owner_hash, after], |row| {
            Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|_| "Input receipt storage unavailable")?;
    let mut entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Input receipt storage unavailable")?;
    let has_more = entries.len() > 128;
    if has_more {
        entries.pop();
    }
    let next = if has_more {
        entries.last().map(|entry| entry.0)
    } else {
        None
    };
    Ok((
        entries
            .into_iter()
            .map(|(_, session, operation, status)| (session, operation, status))
            .collect(),
        next,
    ))
}

pub(super) fn acquire(
    root: &Path,
    owner: &str,
    timeout: Duration,
) -> Result<OwnerInputGuard, String> {
    let root_metadata =
        std::fs::symlink_metadata(root).map_err(|_| "Owner input root unavailable")?;
    if !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || root_metadata.uid() != unsafe { libc::geteuid() }
        || root_metadata.mode() & 0o022 != 0
    {
        return Err("Owner input root is unsafe".into());
    }
    let owner_hash = hex::encode(Sha256::digest(owner.as_bytes()));
    let path = root.join(format!("auth-input-{owner_hash}.lock"));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|_| "Owner input lock unavailable")?;
    let guard = OwnerInputGuard {
        file,
        path,
        owner_hash,
    };
    guard.verify()?;
    let start = Instant::now();
    loop {
        if guard.file.try_lock().is_ok() {
            break;
        }
        if start.elapsed() >= timeout {
            return Err("Owner input is busy".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    guard.verify()?;
    Ok(guard)
}

pub(super) fn receipt(
    connection: &rusqlite::Connection,
    owner: &str,
    session: &str,
    operation: &str,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    let owner_hash = hex::encode(Sha256::digest(owner.as_bytes()));
    let session_hash = hex::encode(Sha256::digest(session.as_bytes()));
    connection.query_row("SELECT status FROM owner_input_receipts WHERE owner_hash=?1 AND session_hash=?2 AND operation_id=?3", rusqlite::params![owner_hash, session_hash, operation], |row| row.get(0)).optional().map_err(|_| "Input receipt storage unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn test_db(connection: rusqlite::Connection) -> rusqlite::Connection {
        connection.execute_batch("CREATE TABLE IF NOT EXISTS owner_input_locks(owner_hash TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owner_input_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL, session_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL, issued_ms INTEGER NOT NULL, UNIQUE(owner_hash, operation_id)); CREATE TABLE IF NOT EXISTS owner_input_watermarks(owner_hash TEXT PRIMARY KEY, observed_ms INTEGER NOT NULL)").unwrap();
        connection
    }

    #[test]
    fn owner_lock_serializes_same_owner_without_blocking_other_owners() {
        let root = tempfile::tempdir().unwrap();
        let first = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        assert!(acquire(root.path(), "alice", Duration::from_millis(30)).is_err());
        let other = acquire(root.path(), "bob", Duration::from_millis(100)).unwrap();
        drop(first);
        assert!(acquire(root.path(), "alice", Duration::from_millis(100)).is_ok());
        drop(other);
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn process_checks_installed_lock_identity() {
        let Some(root) = std::env::var_os("V4_INPUT_IDENTITY_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let guard = acquire(root, "alice", Duration::from_secs(1)).unwrap();
        let mut db = rusqlite::Connection::open(root.join("identity.db")).unwrap();
        let tx = db.transaction().unwrap();
        let accepted = installed(&tx)
            .and_then(|active| {
                if !active {
                    return Err("Installation missing".into());
                }
                guard.bind(&tx)
            })
            .is_ok();
        tx.commit().unwrap();
        std::fs::write(
            root.join("identity-result"),
            if accepted {
                b"accepted" as &[u8]
            } else {
                b"blocked"
            },
        )
        .unwrap();
    }

    #[test]
    fn lost_identity_table_and_replaced_lock_fail_closed_across_processes() {
        let root = tempfile::tempdir().unwrap();
        let mut db = rusqlite::Connection::open(root.path().join("identity.db")).unwrap();
        db.execute_batch("CREATE TABLE auth_admission_identity(id INTEGER PRIMARY KEY); INSERT INTO auth_admission_identity(id) VALUES (1)").unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        guard.bind(&tx).unwrap();
        tx.commit().unwrap();
        std::fs::rename(&guard.path, root.path().join("old-lock")).unwrap();
        drop(guard);
        db.execute("DROP TABLE owner_input_locks", []).unwrap();
        drop(db);
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "state::owner_input::tests::process_checks_installed_lock_identity",
                "--ignored",
            ])
            .env("V4_INPUT_IDENTITY_ROOT", root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read(root.path().join("identity-result")).unwrap(),
            b"blocked"
        );
    }

    #[test]
    fn installation_migrates_only_intact_v1_identity_storage() {
        let root = tempfile::tempdir().unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_admission_identity(id INTEGER PRIMARY KEY); INSERT INTO auth_admission_identity(id) VALUES (1)").unwrap();
        let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        guard.bind(&tx).unwrap();
        tx.execute(
            "UPDATE auth_admission_identity SET owner_input_version=1 WHERE id=1",
            [],
        )
        .unwrap();
        let before: (String, String) = tx
            .query_row("SELECT device, inode FROM owner_input_locks", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        install(&tx).unwrap();
        let version: i64 = tx
            .query_row(
                "SELECT owner_input_version FROM auth_admission_identity WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let after: (String, String) = tx
            .query_row("SELECT device, inode FROM owner_input_locks", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((version, after), (2, before));
        tx.commit().unwrap();
        db.execute("DROP TABLE owner_input_locks", []).unwrap();
        db.execute(
            "UPDATE auth_admission_identity SET owner_input_version=1 WHERE id=1",
            [],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        assert!(install(&tx).is_err());
        assert!(installed(&tx).is_err());
        tx.rollback().unwrap();
    }

    #[test]
    fn replacement_lock_cannot_bind_to_existing_owner_identity() {
        let root = tempfile::tempdir().unwrap();
        let mut db = test_db(rusqlite::Connection::open_in_memory().unwrap());
        let first = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let tx = db.transaction().unwrap();
        first.bind(&tx).unwrap();
        tx.commit().unwrap();
        std::fs::rename(&first.path, root.path().join("old-lock")).unwrap();
        let replacement = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        assert!(first.verify().is_err());
        let tx = db.transaction().unwrap();
        assert!(replacement.bind(&tx).is_err());
        tx.rollback().unwrap();
    }

    #[test]
    fn prune_rejects_old_retries_despite_clock_rollback_and_future_forgery() {
        let root = tempfile::tempdir().unwrap();
        let mut db = test_db(rusqlite::Connection::open_in_memory().unwrap());
        let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let now = 1_800_000_000_000;
        let old = new_operation(now).unwrap();
        let uncertain = new_operation(now).unwrap();
        let tx = db.transaction().unwrap();
        guard.bind(&tx).unwrap();
        guard.claim(&tx, "session", &old, now).unwrap();
        guard.finish(&tx, "session", &old, "delivered").unwrap();
        assert_eq!(guard.review(&tx, "session", &old).unwrap(), "acknowledged");
        guard.claim(&tx, "session", &uncertain, now).unwrap();
        tx.commit().unwrap();
        let later = now + RETRY_WINDOW_MS + 1;
        let next = new_operation(later).unwrap();
        let tx = db.transaction().unwrap();
        guard.claim(&tx, "other-session", &next, later).unwrap();
        guard
            .finish(&tx, "other-session", &next, "delivered")
            .unwrap();
        guard.review(&tx, "other-session", &next).unwrap();
        tx.commit().unwrap();
        assert_eq!(receipt(&db, "alice", "session", &old).unwrap(), None);
        assert_eq!(
            receipt(&db, "alice", "session", &uncertain)
                .unwrap()
                .as_deref(),
            Some("uncertain")
        );
        let tx = db.transaction().unwrap();
        assert!(guard.claim(&tx, "session", &old, now).is_err());
        tx.rollback().unwrap();
        let forged = new_operation(later + FUTURE_SKEW_MS + 1).unwrap();
        let tx = db.transaction().unwrap();
        assert!(guard.claim(&tx, "session", &forged, later).is_err());
        tx.rollback().unwrap();
        let legitimate = new_operation(later).unwrap();
        let tx = db.transaction().unwrap();
        assert!(guard.claim(&tx, "session", &legitimate, later).is_err());
        guard
            .claim(&tx, "other-session", &legitimate, later)
            .unwrap();
        guard
            .finish(&tx, "other-session", &legitimate, "delivered")
            .unwrap();
        guard.review(&tx, "other-session", &legitimate).unwrap();
        assert!(guard.review(&tx, "other-session", &uncertain).is_err());
        guard.review(&tx, "session", &uncertain).unwrap();
        tx.commit().unwrap();
        let tx = db.transaction().unwrap();
        let cleanup = new_operation(later).unwrap();
        guard.claim(&tx, "session", &cleanup, later).unwrap();
        tx.commit().unwrap();
        assert_eq!(receipt(&db, "alice", "session", &uncertain).unwrap(), None);
    }

    #[test]
    fn authoritative_watermark_survives_rollback_and_keeps_unresolved_receipts() {
        let root = tempfile::tempdir().unwrap();
        let mut db = test_db(rusqlite::Connection::open_in_memory().unwrap());
        let alice = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let bob = acquire(root.path(), "bob", Duration::from_millis(100)).unwrap();
        let now = 1_800_000_000_000;
        let delivered = new_operation(now).unwrap();
        let issued = new_operation(now).unwrap();
        let tx = db.transaction().unwrap();
        alice.bind(&tx).unwrap();
        alice
            .claim(&tx, "delivered-session", &delivered, now)
            .unwrap();
        alice
            .finish(&tx, "delivered-session", &delivered, "delivered")
            .unwrap();
        alice.review(&tx, "delivered-session", &delivered).unwrap();
        alice.reserve(&tx, "pending-session", &issued, now).unwrap();
        tx.commit().unwrap();
        let later = now + RETRY_WINDOW_MS + 5;
        let tx = db.transaction().unwrap();
        assert_eq!(alice.advance_watermark(&tx, later).unwrap(), now + 5);
        tx.commit().unwrap();
        assert_eq!(
            receipt(&db, "alice", "delivered-session", &delivered).unwrap(),
            None
        );
        assert_eq!(
            receipt(&db, "alice", "pending-session", &issued)
                .unwrap()
                .as_deref(),
            Some("issued")
        );
        let tx = db.transaction().unwrap();
        assert_eq!(alice.advance_watermark(&tx, now).unwrap(), now + 5);
        assert!(alice
            .activate(&tx, "pending-session", &issued, now)
            .is_err());
        assert_eq!(
            bob.advance_watermark(&tx, now).unwrap(),
            now - RETRY_WINDOW_MS
        );
        tx.commit().unwrap();
        assert_eq!(
            receipt(&db, "alice", "pending-session", &issued)
                .unwrap()
                .as_deref(),
            Some("issued")
        );
    }

    #[test]
    fn delivered_receipt_survives_retry_window_until_explicit_acknowledgment() {
        let root = tempfile::tempdir().unwrap();
        let db_path = root.path().join("receipts.db");
        let mut db = test_db(rusqlite::Connection::open(&db_path).unwrap());
        let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let now = 1_800_000_000_000;
        let operation = new_operation(now).unwrap();
        let tx = db.transaction().unwrap();
        guard.bind(&tx).unwrap();
        guard.reserve(&tx, "session", &operation, now).unwrap();
        guard.activate(&tx, "session", &operation, now).unwrap();
        guard
            .finish(&tx, "session", &operation, "delivered")
            .unwrap();
        tx.commit().unwrap();
        let later = now + RETRY_WINDOW_MS + 1;
        let tx = db.transaction().unwrap();
        guard.advance_watermark(&tx, later).unwrap();
        tx.commit().unwrap();
        drop(db);
        let mut db = test_db(rusqlite::Connection::open(&db_path).unwrap());
        assert_eq!(
            receipt(&db, "alice", "session", &operation)
                .unwrap()
                .as_deref(),
            Some("delivered")
        );
        let tx = db.transaction().unwrap();
        assert!(guard
            .claim(&tx, "session", &new_operation(later).unwrap(), later)
            .is_err());
        assert_eq!(
            guard.review(&tx, "session", &operation).unwrap(),
            "acknowledged"
        );
        assert_eq!(
            guard.review(&tx, "session", &operation).unwrap(),
            "acknowledged"
        );
        tx.commit().unwrap();
        assert_eq!(
            receipt(&db, "alice", "session", &operation)
                .unwrap()
                .as_deref(),
            Some("acknowledged")
        );
        let tx = db.transaction().unwrap();
        guard.advance_watermark(&tx, later).unwrap();
        assert!(guard.activate(&tx, "session", &operation, now).is_err());
        tx.commit().unwrap();
        assert_eq!(receipt(&db, "alice", "session", &operation).unwrap(), None);
    }

    #[test]
    fn concurrent_duplicate_issuance_accepts_one_claim() {
        let root = tempfile::tempdir().unwrap();
        let db_path = root.path().join("claims.db");
        let now = crate::v4_agent::interaction::now_ms();
        let operation = new_operation(now).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let root = root.path().to_owned();
            let db_path = db_path.clone();
            let operation = operation.clone();
            let barrier = barrier.clone();
            tasks.push(std::thread::spawn(move || {
                barrier.wait();
                let guard = acquire(&root, "alice", Duration::from_secs(3)).unwrap();
                let mut db = test_db(rusqlite::Connection::open(db_path).unwrap());
                let tx = db.transaction().unwrap();
                guard.bind(&tx).unwrap();
                let accepted = guard.claim(&tx, "session", &operation, now).is_ok();
                tx.commit().unwrap();
                accepted
            }));
        }
        let mut results = tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>();
        results.sort();
        assert_eq!(results, vec![false, true]);
    }

    #[test]
    fn issued_tokens_are_scoped_and_cannot_be_forged() {
        let now = crate::v4_agent::interaction::now_ms();
        let (id, token) =
            issue("fixture-secret", "alice", "session", "incarnation", 9, now).unwrap();
        let (verified, incarnation, generation, _) =
            verify_token("fixture-secret", &token, "alice", "session").unwrap();
        assert_eq!(
            (verified, incarnation, generation),
            (id, "incarnation".into(), 9)
        );
        assert!(verify_token("other-secret", &token, "alice", "session").is_err());
        assert!(verify_token("fixture-secret", &token, "bob", "session").is_err());
        assert!(verify_token("fixture-secret", &token, "alice", "other-session").is_err());
    }

    #[test]
    fn unresolved_receipts_paginate_and_expired_issuance_remains_discoverable() {
        let root = tempfile::tempdir().unwrap();
        let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let mut db = test_db(rusqlite::Connection::open_in_memory().unwrap());
        let now = 1_800_000_000_000;
        let mut expected = Vec::new();
        let tx = db.transaction().unwrap();
        guard.bind(&tx).unwrap();
        for index in 0..140 {
            let session = format!("session-{index}");
            let operation = new_operation(now).unwrap();
            guard.reserve(&tx, &session, &operation, now).unwrap();
            expected.push((session, operation, "issued".to_string()));
        }
        tx.commit().unwrap();
        let later = now + RETRY_WINDOW_MS + 1;
        let tx = db.transaction().unwrap();
        guard
            .claim(&tx, "later-session", &new_operation(later).unwrap(), later)
            .unwrap();
        tx.commit().unwrap();
        let (first, next) = unresolved_receipts(&db, "alice", 0).unwrap();
        assert_eq!(first, expected[..128]);
        let (second, final_cursor) = unresolved_receipts(&db, "alice", next.unwrap()).unwrap();
        assert_eq!(&second[..12], &expected[128..]);
        assert_eq!(second.len(), 13);
        assert_eq!(final_cursor, None);
        assert_eq!(
            unresolved_receipts(&db, "other-owner", 0).unwrap(),
            (Vec::new(), None)
        );
        assert!(unresolved_receipts(&db, "alice", -1).is_err());
    }

    #[test]
    fn spawned_children_do_not_inherit_owner_lock() {
        let root = tempfile::tempdir().unwrap();
        let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
        let mut child = Command::new("/bin/sleep")
            .arg("3")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        drop(guard);
        let acquired = acquire(root.path(), "alice", Duration::from_millis(100));
        let _ = child.kill();
        let _ = child.wait();
        assert!(acquired.is_ok());
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn process_holding_owner_lock() {
        let Some(root) = std::env::var_os("V4_OWNER_INPUT_TEST_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let _guard = acquire(root, "alice", Duration::from_secs(1)).unwrap();
        std::fs::write(root.join("child-ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn owner_lock_is_cross_process_and_released_after_crash() {
        let root = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "state::owner_input::tests::process_holding_owner_lock",
                "--ignored",
            ])
            .env("V4_OWNER_INPUT_TEST_ROOT", root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.path().join("child-ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = root.path().join("child-ready").exists();
        let while_running = acquire(root.path(), "alice", Duration::from_millis(50));
        let _ = child.kill();
        let _ = child.wait();
        assert!(ready);
        assert!(while_running.is_err());
        assert!(acquire(root.path(), "alice", Duration::from_millis(100)).is_ok());
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn process_claiming_input() {
        let Some(root) = std::env::var_os("V4_INPUT_CLAIM_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let operation = std::env::var("V4_INPUT_CLAIM_ID").unwrap();
        let guard = acquire(root, "alice", Duration::from_secs(1)).unwrap();
        let mut db = test_db(rusqlite::Connection::open(root.join("claims.db")).unwrap());
        let tx = db.transaction().unwrap();
        guard.bind(&tx).unwrap();
        guard
            .claim(
                &tx,
                "session",
                &operation,
                crate::v4_agent::interaction::now_ms(),
            )
            .unwrap();
        tx.commit().unwrap();
        if std::env::var_os("V4_INPUT_SIMULATE_WRITE").is_some() {
            std::fs::write(root.join("side-effect"), b"partial").unwrap();
        }
        std::fs::write(root.join("claim-ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn crash_before_or_after_input_preserves_uncertain_claim_without_replay() {
        for after_write in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let operation = new_operation(crate::v4_agent::interaction::now_ms()).unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "state::owner_input::tests::process_claiming_input",
                    "--ignored",
                ])
                .env("V4_INPUT_CLAIM_ROOT", root.path())
                .env("V4_INPUT_CLAIM_ID", &operation)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if after_write {
                command.env("V4_INPUT_SIMULATE_WRITE", "1");
            }
            let mut child = command.spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !root.path().join("claim-ready").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let ready = root.path().join("claim-ready").exists();
            let _ = child.kill();
            let _ = child.wait();
            assert!(ready);
            assert_eq!(root.path().join("side-effect").exists(), after_write);
            let mut db =
                test_db(rusqlite::Connection::open(root.path().join("claims.db")).unwrap());
            assert_eq!(
                receipt(&db, "alice", "session", &operation)
                    .unwrap()
                    .as_deref(),
                Some("uncertain")
            );
            let guard = acquire(root.path(), "alice", Duration::from_millis(100)).unwrap();
            let tx = db.transaction().unwrap();
            guard.bind(&tx).unwrap();
            assert!(guard
                .claim(
                    &tx,
                    "session",
                    &operation,
                    crate::v4_agent::interaction::now_ms()
                )
                .is_err());
            tx.rollback().unwrap();
        }
    }
}
