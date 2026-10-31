//! Shared credential-admission fence. All cooperating servers must retain the
//! same marker, lock file, and SQLite installation record.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

const LOCK: &str = "auth-admission.lock";
const MARKER: &str = "auth-admission.identity";
const PENDING: &str = "auth-admission.initializing";
const TEMP: &str = "auth-admission.initializing.tmp";
const MAGIC: &[u8; 8] = b"V4AUTH01";
const LEN: usize = 88;

pub(super) struct AuthAdmission {
    root: PathBuf,
    root_file: File,
    database: File,
    lock_file: File,
    marker_file: File,
    marker: [u8; LEN],
}

fn same(path: &Path, file: &File, directory: bool, private: bool) -> Result<(), String> {
    same_with_link_limit(path, file, directory, private, 1)
}

fn same_with_link_limit(
    path: &Path,
    file: &File,
    directory: bool,
    private: bool,
    max_links: u64,
) -> Result<(), String> {
    let opened = file
        .metadata()
        .map_err(|_| "Authentication identity unavailable")?;
    let current =
        std::fs::symlink_metadata(path).map_err(|_| "Authentication identity unavailable")?;
    if current.file_type().is_symlink()
        || opened.uid() != unsafe { libc::geteuid() }
        || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        || (directory && (!opened.is_dir() || !current.is_dir() || opened.mode() & 0o022 != 0))
        || (!directory
            && (!opened.is_file()
                || !current.is_file()
                || opened.nlink() == 0
                || opened.nlink() > max_links
                || (private && opened.mode() & 0o077 != 0)))
    {
        return Err("Authentication identity changed or is unsafe".into());
    }
    Ok(())
}

fn open_file(path: &Path, write: bool) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "Authentication identity unavailable".into())
}

fn exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Authentication admission marker unavailable".into()),
    }
}

pub(super) fn open_database(root: &Path) -> Result<File, String> {
    let path = root.join("terminal.db");
    match std::fs::symlink_metadata(&path) {
        Ok(_) => return open_file(&path, true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Authentication database unavailable".into()),
    }
    for name in [LOCK, MARKER, PENDING, TEMP] {
        if exists(&root.join(name))? {
            if exists(&path)? {
                return open_file(&path, true);
            }
            return Err("Authentication database is missing from an existing installation".into());
        }
    }
    match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
    {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open_file(&path, true),
        Err(_) => Err("Authentication database unavailable".into()),
    }
}

fn read_marker(
    path: &Path,
    root: &File,
    lock_file: &File,
    allow_two_links: bool,
) -> Result<(File, [u8; LEN]), String> {
    let mut file = open_file(path, false)?;
    let limit = if allow_two_links { 2 } else { 1 };
    same_with_link_limit(path, &file, false, true, limit)?;
    let mut value = [0; LEN];
    file.read_exact(&mut value)
        .map_err(|_| "Authentication admission marker is invalid")?;
    let mut extra = [0; 1];
    if file
        .read(&mut extra)
        .map_err(|_| "Authentication admission marker is invalid")?
        != 0
    {
        return Err("Authentication admission marker is invalid".into());
    }
    let id = Uuid::from_slice(&value[8..24])
        .map_err(|_| "Authentication admission marker is invalid")?;
    if value != marker(root, lock_file, id)? {
        return Err("Authentication admission identity changed".into());
    }
    same_with_link_limit(path, &file, false, true, limit)?;
    Ok((file, value))
}

fn lock(file: &File) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => return Err("Authentication admission is busy".into()),
        }
    }
}

fn marker(root: &File, lock: &File, id: Uuid) -> Result<[u8; LEN], String> {
    let root = root
        .metadata()
        .map_err(|_| "Authentication identity unavailable")?;
    let lock = lock
        .metadata()
        .map_err(|_| "Authentication identity unavailable")?;
    let mut value = [0; LEN];
    value[..8].copy_from_slice(MAGIC);
    value[8..24].copy_from_slice(id.as_bytes());
    for (index, number) in [root.dev(), root.ino(), lock.dev(), lock.ino()]
        .into_iter()
        .enumerate()
    {
        value[24 + index * 8..32 + index * 8].copy_from_slice(&number.to_be_bytes());
    }
    let digest = Sha256::digest(&value[..56]);
    value[56..].copy_from_slice(&digest);
    Ok(value)
}

impl AuthAdmission {
    pub(super) fn bind(path: &Path, database: File, db: &mut Connection) -> Result<Self, String> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Authentication root unavailable")?;
        if metadata.file_type().is_symlink() {
            return Err("Unsafe authentication root".into());
        }
        let root = path
            .canonicalize()
            .map_err(|_| "Authentication root unavailable")?;
        let root_file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&root)
            .map_err(|_| "Authentication root unavailable")?;
        same(&root, &root_file, true, false)?;
        same(&root.join("terminal.db"), &database, false, false)?;
        let lock_path = root.join(LOCK);
        let marker_path = root.join(MARKER);
        let pending_path = root.join(PENDING);
        let temp_path = root.join(TEMP);
        if (exists(&marker_path)? || exists(&pending_path)? || exists(&temp_path)?)
            && !exists(&lock_path)?
        {
            return Err("Authentication admission lock is missing".into());
        }
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&lock_path)
            .map_err(|_| "Authentication admission lock unavailable")?;
        same(&lock_path, &lock_file, false, true)?;
        lock(&lock_file)?;
        same(&lock_path, &lock_file, false, true)?;
        same(&root.join("terminal.db"), &database, false, false)?;
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(|_| "Authentication database unavailable")?;
        let journal: String = db
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .map_err(|_| "Authentication database unavailable")?;
        if sync < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Authentication database is not durable".into());
        }
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_admission_identity')", [], |r| r.get(0)).map_err(|_| "Authentication admission record unavailable")?;
        let finalized = self::exists(&marker_path)?;
        let mut pending = self::exists(&pending_path)?;
        let mut temporary = self::exists(&temp_path)?;
        if (finalized && (pending || temporary || !exists)) || (!finalized && !pending && exists) {
            return Err("Authentication admission installation is incomplete".into());
        }
        if !finalized && !pending && !temporary {
            let value = marker(&root_file, &lock_file, Uuid::new_v4())?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temp_path)
                .map_err(|_| "Cannot initialize authentication admission")?;
            file.write_all(&value)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Cannot persist authentication admission")?;
            root_file
                .sync_all()
                .map_err(|_| "Cannot persist authentication directory")?;
            temporary = true;
        }
        if !finalized && !pending && temporary {
            read_marker(&temp_path, &root_file, &lock_file, false)?;
            std::fs::hard_link(&temp_path, &pending_path)
                .map_err(|_| "Cannot publish authentication admission intent")?;
            root_file
                .sync_all()
                .map_err(|_| "Cannot persist authentication directory")?;
            pending = true;
        }
        if pending {
            let (pending_file, value) = read_marker(&pending_path, &root_file, &lock_file, true)?;
            if exists {
                let record: Option<Vec<u8>> = db
                    .query_row(
                        "SELECT identity FROM auth_admission_identity WHERE id=1",
                        [],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| "Authentication admission record unavailable")?;
                if record.as_deref() != Some(&value[..]) {
                    return Err("Authentication admission record changed".into());
                }
            }
            let pending_meta = pending_file
                .metadata()
                .map_err(|_| "Authentication admission marker unavailable")?;
            match (pending_meta.nlink(), self::exists(&temp_path)?) {
                (1, false) => {}
                (2, true) => {
                    let (temp_file, temp_value) =
                        read_marker(&temp_path, &root_file, &lock_file, true)?;
                    let temp_meta = temp_file
                        .metadata()
                        .map_err(|_| "Authentication admission marker unavailable")?;
                    if temp_value != value
                        || (temp_meta.dev(), temp_meta.ino())
                            != (pending_meta.dev(), pending_meta.ino())
                        || temp_meta.nlink() != 2
                    {
                        return Err("Authentication admission temporary link changed".into());
                    }
                    std::fs::remove_file(&temp_path)
                        .map_err(|_| "Cannot remove authentication admission temporary link")?;
                    root_file
                        .sync_all()
                        .map_err(|_| "Cannot persist authentication directory")?;
                    same(&pending_path, &pending_file, false, true)?;
                }
                _ => return Err("Authentication admission temporary link is unconfirmed".into()),
            }
            if !exists {
                let tx = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|_| "Cannot initialize authentication admission")?;
                tx.execute_batch("CREATE TABLE auth_admission_identity(id INTEGER PRIMARY KEY CHECK(id=1), identity BLOB NOT NULL)").map_err(|_| "Cannot initialize authentication admission")?;
                tx.execute(
                    "INSERT INTO auth_admission_identity VALUES(1,?1)",
                    params![&value[..]],
                )
                .map_err(|_| "Cannot initialize authentication admission")?;
                tx.commit()
                    .map_err(|_| "Cannot commit authentication admission")?;
            }
            if self::exists(&marker_path)? {
                return Err("Authentication admission marker changed".into());
            }
            std::fs::rename(&pending_path, &marker_path)
                .map_err(|_| "Cannot finalize authentication admission")?;
            root_file
                .sync_all()
                .map_err(|_| "Cannot persist authentication directory")?;
        }
        let (marker_file, value) = read_marker(&marker_path, &root_file, &lock_file, false)?;
        let result = Self {
            root,
            root_file,
            database,
            lock_file,
            marker_file,
            marker: value,
        };
        result.validate(db)?;
        result
            .lock_file
            .unlock()
            .map_err(|_| "Cannot release authentication admission")?;
        Ok(result)
    }

    pub(super) fn acquire(&self) -> Result<File, String> {
        let file = open_file(&self.root.join(LOCK), true)?;
        same(&self.root.join(LOCK), &self.lock_file, false, true)?;
        same(&self.root.join(LOCK), &file, false, true)?;
        lock(&file)?;
        same(&self.root.join(LOCK), &self.lock_file, false, true)?;
        same(&self.root.join(LOCK), &file, false, true)?;
        Ok(file)
    }

    pub(super) fn try_acquire(&self) -> Result<File, String> {
        let file = open_file(&self.root.join(LOCK), true)?;
        same(&self.root.join(LOCK), &self.lock_file, false, true)?;
        same(&self.root.join(LOCK), &file, false, true)?;
        file.try_lock()
            .map_err(|_| "Authentication admission is busy".to_string())?;
        same(&self.root.join(LOCK), &self.lock_file, false, true)?;
        same(&self.root.join(LOCK), &file, false, true)?;
        Ok(file)
    }

    pub(super) fn validate(&self, db: &Connection) -> Result<(), String> {
        same(&self.root, &self.root_file, true, false)?;
        same(&self.root.join("terminal.db"), &self.database, false, false)?;
        same(&self.root.join(LOCK), &self.lock_file, false, true)?;
        same(&self.root.join(MARKER), &self.marker_file, false, true)?;
        let mut actual = [0; LEN];
        if self
            .marker_file
            .metadata()
            .map_err(|_| "Authentication marker unavailable")?
            .len()
            != LEN as u64
        {
            return Err("Authentication marker changed".into());
        }
        self.marker_file
            .read_exact_at(&mut actual, 0)
            .map_err(|_| "Authentication marker unavailable")?;
        if actual != self.marker {
            return Err("Authentication marker changed".into());
        }
        let path = db.path().ok_or("Authentication database unavailable")?;
        if Path::new(path).canonicalize().ok().as_deref()
            != Some(self.root.join("terminal.db").as_path())
        {
            return Err("Authentication database changed".into());
        }
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(|_| "Authentication database unavailable")?;
        let journal: String = db
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .map_err(|_| "Authentication database unavailable")?;
        if sync < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Authentication database is not durable".into());
        }
        let identity: Option<Vec<u8>> = db
            .query_row(
                "SELECT identity FROM auth_admission_identity WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "Authentication admission record unavailable")?;
        if identity.as_deref() != Some(&self.marker[..]) {
            return Err("Authentication admission record changed".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use terminal_v4_core::AppConfig;

    fn config(path: &Path) -> AppConfig {
        AppConfig {
            data_dir: path.into(),
            jwt_secret: "auth-fence-fixture".into(),
            ..Default::default()
        }
    }

    #[test]
    fn missing_marker_or_table_is_never_silently_recreated() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        state
            .lock_db()
            .unwrap()
            .execute("DROP TABLE auth_admission_identity", [])
            .unwrap();
        assert!(state.logout_user("owner").is_err());
        assert!(AppState::new(config(root.path())).is_err());
        assert!(state
            .lock_db()
            .unwrap()
            .prepare("SELECT * FROM auth_admission_identity")
            .is_err());
        std::fs::remove_file(root.path().join(MARKER)).unwrap();
        assert!(state.logout_user("owner").is_err());
    }

    #[test]
    fn replacing_lock_file_does_not_create_a_second_admission_domain() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        std::fs::rename(root.path().join(LOCK), root.path().join("old.lock")).unwrap();
        let _replacement = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.path().join(LOCK))
            .unwrap();
        assert!(state.logout_user("owner").is_err());
        assert!(AppState::new(config(root.path())).is_err());
    }

    #[test]
    fn interrupted_installation_and_unsafe_durability_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        state
            .lock_db()
            .unwrap()
            .execute_batch("PRAGMA synchronous=OFF")
            .unwrap();
        assert!(state.logout_user("owner").is_err());
        state
            .lock_db()
            .unwrap()
            .execute_batch("PRAGMA synchronous=FULL")
            .unwrap();
        assert!(state.logout_user("owner").is_ok());
        std::fs::write(root.path().join(MARKER), b"partial").unwrap();
        assert!(state.logout_user("owner").is_err());
        assert!(AppState::new(config(root.path())).is_err());
    }

    #[test]
    fn reopen_preserves_revocation_and_installation_identity() {
        let root = tempfile::tempdir().unwrap();
        let first = AppState::new(config(root.path())).unwrap();
        first.logout_user("owner").unwrap();
        drop(first);
        let reopened = AppState::new(config(root.path())).unwrap();
        assert!(reopened.validate_auth_generation("owner", 0).is_err());
        assert!(reopened.validate_auth_generation("owner", 1).is_ok());
        assert!(reopened.logout_user("owner").is_ok());
    }

    #[test]
    fn legacy_database_migrates_without_changing_existing_users_or_revocations() {
        let root = tempfile::tempdir().unwrap();
        let db = Connection::open(root.path().join("terminal.db")).unwrap();
        db.execute_batch("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO users VALUES('legacy-owner','legacy','hash','created','updated'); CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL); INSERT INTO auth_generations VALUES('legacy-owner',3);").unwrap();
        drop(db);
        let state = AppState::new(config(root.path())).unwrap();
        assert!(state.validate_auth_generation("legacy-owner", 3).is_ok());
        let user: (String, String) = state
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT username,password_hash FROM users WHERE id='legacy-owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(user, ("legacy".into(), "hash".into()));
        assert!(root.path().join(MARKER).is_file());
        assert!(root.path().join(LOCK).is_file());
    }

    #[test]
    fn concurrent_initialization_uses_one_shared_identity() {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let results = std::thread::scope(|scope| {
            let path = root.path();
            let left_barrier = barrier.clone();
            let left = scope.spawn(move || {
                left_barrier.wait();
                AppState::new(config(path))
            });
            let right = scope.spawn(move || {
                barrier.wait();
                AppState::new(config(path))
            });
            (left.join().unwrap(), right.join().unwrap())
        });
        let (first, second) = (results.0.unwrap(), results.1.unwrap());
        first.logout_user("owner").unwrap();
        assert!(second.validate_auth_generation("owner", 0).is_err());
        assert!(second.validate_auth_generation("owner", 1).is_ok());
    }

    #[test]
    fn resumes_complete_pending_marker_before_or_after_sqlite_commit() {
        for committed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let state = AppState::new(config(root.path())).unwrap();
            if !committed {
                state
                    .lock_db()
                    .unwrap()
                    .execute("DROP TABLE auth_admission_identity", [])
                    .unwrap();
            }
            std::fs::rename(
                root.path().join(MARKER),
                root.path().join("auth-admission.initializing"),
            )
            .unwrap();
            drop(state);
            let reopened = AppState::new(config(root.path())).unwrap();
            assert!(reopened.logout_user("owner").is_ok());
            assert!(root.path().join(MARKER).is_file());
            assert!(!root.path().join("auth-admission.initializing").exists());
        }
    }

    #[test]
    fn rejects_torn_or_conflicting_pending_installation() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        let pending = root.path().join("auth-admission.initializing");
        std::fs::write(&pending, b"torn").unwrap();
        assert!(AppState::new(config(root.path())).is_err());
        std::fs::remove_file(root.path().join(MARKER)).unwrap();
        state
            .lock_db()
            .unwrap()
            .execute("DROP TABLE auth_admission_identity", [])
            .unwrap();
        assert!(AppState::new(config(root.path())).is_err());
        assert_eq!(std::fs::read(pending).unwrap(), b"torn");
    }

    #[test]
    fn recovers_the_owned_temporary_hard_link_at_both_commit_boundaries() {
        for committed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let state = AppState::new(config(root.path())).unwrap();
            if !committed {
                state
                    .lock_db()
                    .unwrap()
                    .execute("DROP TABLE auth_admission_identity", [])
                    .unwrap();
            }
            let pending = root.path().join(PENDING);
            let temp = root.path().join("auth-admission.initializing.tmp");
            std::fs::rename(root.path().join(MARKER), &pending).unwrap();
            std::fs::hard_link(&pending, &temp).unwrap();
            drop(state);
            let recovered = AppState::new(config(root.path())).unwrap();
            assert!(recovered.logout_user("owner").is_ok());
            assert!(!pending.exists());
            assert!(!temp.exists());
        }
    }

    #[test]
    fn resumes_a_complete_temporary_marker_before_link_publication() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        state
            .lock_db()
            .unwrap()
            .execute("DROP TABLE auth_admission_identity", [])
            .unwrap();
        let temp = root.path().join(TEMP);
        std::fs::rename(root.path().join(MARKER), &temp).unwrap();
        drop(state);
        let recovered = AppState::new(config(root.path())).unwrap();
        assert!(recovered.logout_user("owner").is_ok());
        assert!(!temp.exists());
        assert!(root.path().join(MARKER).is_file());
    }

    #[test]
    fn torn_temporary_marker_is_not_deleted_or_reused() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        state
            .lock_db()
            .unwrap()
            .execute("DROP TABLE auth_admission_identity", [])
            .unwrap();
        let temp = root.path().join(TEMP);
        std::fs::rename(root.path().join(MARKER), &temp).unwrap();
        std::fs::write(&temp, b"torn").unwrap();
        drop(state);
        assert!(AppState::new(config(root.path())).is_err());
        assert_eq!(std::fs::read(temp).unwrap(), b"torn");
    }

    #[test]
    fn rejects_an_unknown_extra_hard_link_without_deleting_it() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        let pending = root.path().join(PENDING);
        let unknown = root.path().join("unknown-link");
        std::fs::rename(root.path().join(MARKER), &pending).unwrap();
        std::fs::hard_link(&pending, &unknown).unwrap();
        drop(state);
        assert!(AppState::new(config(root.path())).is_err());
        assert!(pending.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn rejected_substituted_database_is_not_mutated_by_schema_initialization() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        drop(state);
        std::fs::rename(
            root.path().join("terminal.db"),
            root.path().join("original.db"),
        )
        .unwrap();
        let replacement = Connection::open(root.path().join("terminal.db")).unwrap();
        replacement.execute_batch("CREATE TABLE auth_admission_identity(id INTEGER PRIMARY KEY, identity BLOB NOT NULL); INSERT INTO auth_admission_identity VALUES(1,X'010203'); CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES('unchanged')").unwrap();
        let before: Vec<String> = replacement
            .prepare("SELECT name FROM sqlite_master ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(replacement);
        assert!(AppState::new(config(root.path())).is_err());
        let replacement = Connection::open(root.path().join("terminal.db")).unwrap();
        let after: Vec<String> = replacement
            .prepare("SELECT name FROM sqlite_master ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(after, before);
        assert_eq!(
            replacement
                .query_row("SELECT value FROM sentinel", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn missing_existing_auth_database_is_not_recreated() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        drop(state);
        let db = root.path().join("terminal.db");
        std::fs::rename(&db, root.path().join("saved.db")).unwrap();
        assert!(AppState::new(config(root.path())).is_err());
        assert!(!db.exists());
    }

    #[tokio::test]
    async fn restoring_only_an_older_database_can_revive_a_revoked_token() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let db = root.path().join("terminal.db");
        let backup = root.path().join("before-logout.db");
        std::fs::copy(&db, &backup).unwrap();
        state.logout_user(&login.user.id).unwrap();
        assert!(crate::auth::authenticate_local_token(&state, &login.tokens.access_token).is_err());
        drop(state);
        std::fs::rename(&db, root.path().join("after-logout.db")).unwrap();
        std::fs::copy(backup, &db).unwrap();
        let restored = AppState::new(config(root.path())).unwrap();
        assert!(
            crate::auth::authenticate_local_token(&restored, &login.tokens.access_token).is_ok()
        );
    }

    #[test]
    fn queue_handle_enforces_owner_hold_and_does_not_retain_app_state() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(config(root.path())).unwrap();
        let weak = std::sync::Arc::downgrade(&state.inner);
        let handle = state.local_admission().unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        assert_eq!(
            handle
                .accept("owner", &authority, |check| {
                    check()?;
                    Ok::<_, String>(())
                })
                .unwrap(),
            (Ok(()), true)
        );
        state.lock_db().unwrap().execute_batch("CREATE TABLE background_ledger_installation(id INTEGER PRIMARY KEY, state TEXT NOT NULL); INSERT INTO background_ledger_installation VALUES(1,'ready'); CREATE TABLE background_owner_holds(owner TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL); INSERT INTO background_owner_holds VALUES('owner','logout','held')").unwrap();
        assert!(handle
            .accept("owner", &authority, |_| Ok::<_, String>(()))
            .is_err());
        state
            .lock_db()
            .unwrap()
            .execute("DELETE FROM background_owner_holds", [])
            .unwrap();
        assert!(handle
            .accept("owner", &authority, |check| {
                check()?;
                Ok::<_, String>(())
            })
            .is_ok());
        drop(state);
        assert!(weak.upgrade().is_none());
        assert!(handle
            .accept("owner", &authority, |check| {
                check()?;
                Ok::<_, String>(())
            })
            .is_ok());
    }
}
