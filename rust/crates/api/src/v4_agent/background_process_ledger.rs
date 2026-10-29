//! A fail-closed receipt ledger. It stores neither commands nor process output.
//! A persistent sibling guard fences reinitialization after loss of the receipt
//! directory. If both guard and directory are lost, callers must consult trusted
//! installation state and must not infer that creation is safe from absence alone.
use super::{
    BackgroundScope, BackgroundState, MAX_ACTIONS, MAX_OWNER_ACTIONS, MAX_SESSION_ACTIONS,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{fs::File, path::Path, sync::Mutex};

pub(super) const MAX_RETIRED_SESSIONS: i64 = 4096;
pub(super) const MIN_RETAINED_PER_SESSION: i64 = 8;
#[cfg(unix)]
pub(super) const LEDGER_BUSY: &str = "Background receipt ledger already in use";

pub(super) struct Ledger {
    db: Mutex<Connection>,
    _lock: File,
    _guard: File,
    #[cfg(unix)]
    db_file: File,
    #[cfg(unix)]
    quiescence_root: Option<std::path::PathBuf>,
    #[cfg(unix)]
    owner_pid: libc::pid_t,
}

#[cfg(unix)]
impl Drop for Ledger {
    fn drop(&mut self) {
        self.release_owned_locks();
    }
}

#[cfg(unix)]
pub(super) fn open_receipt_database(path: &Path, retained: &File) -> Result<Connection, String> {
    use std::os::unix::fs::MetadataExt;
    let verify = || -> Result<(), String> {
        let opened = retained
            .metadata()
            .map_err(|_| "Cannot inspect background receipt ledger")?;
        let current = std::fs::symlink_metadata(path)
            .map_err(|_| "Background receipt ledger is missing or unavailable")?;
        if !opened.is_file()
            || !current.is_file()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || opened.nlink() != 1
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Background receipt ledger identity changed or is unsafe".into());
        }
        Ok(())
    };
    verify()?;
    let db = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "Cannot open background receipt ledger")?;
    verify()?;
    Ok(db)
}

#[cfg(unix)]
impl Ledger {
    pub(super) fn release_owned_locks(&self) {
        use std::os::fd::AsRawFd;
        // Only the original owner may unlock: a forked child shares the same
        // open file descriptions and must not release the parent's lock.
        if unsafe { libc::getpid() } == self.owner_pid {
            unsafe {
                libc::flock(self._lock.as_raw_fd(), libc::LOCK_UN);
                libc::flock(self._guard.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

impl Ledger {
    #[cfg(unix)]
    pub(super) fn open(path: &Path) -> Result<Self, String> {
        Self::initialize(path, false)
    }

    #[cfg(unix)]
    pub(super) fn create(path: &Path) -> Result<Self, String> {
        Self::initialize(path, true)
    }

    #[cfg(unix)]
    fn initialize(path: &Path, created: bool) -> Result<Self, String> {
        use std::io::{Read, Seek, SeekFrom, Write};
        use std::os::unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
            io::AsRawFd,
        };
        const GUARD_READY: &[u8] = b"v4-background-ledger-v2-ready\n";
        const GUARD_PENDING: &[u8] = b"v4-background-ledger-v2-pending\n";
        if !path.is_absolute() {
            return Err("Background receipt directory must be absolute".into());
        }
        let mut guard_name = std::ffi::OsString::from(".");
        guard_name.push(
            path.file_name()
                .ok_or("Invalid background receipt directory")?,
        );
        guard_name.push(".background-guard");
        let guard_path = path.with_file_name(guard_name);
        let mut guard = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(created)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(guard_path)
            .map_err(|_| "Background receipt guard is missing or already initialized")?;
        let guard_meta = guard
            .metadata()
            .map_err(|_| "Cannot inspect background receipt guard")?;
        if !guard_meta.is_file()
            || guard_meta.uid() != unsafe { libc::geteuid() }
            || guard_meta.mode() & 0o077 != 0
            || guard_meta.nlink() != 1
        {
            return Err("Background receipt guard must be private and owned by this user".into());
        }
        if unsafe { libc::flock(guard.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(LEDGER_BUSY.into());
        }
        if created {
            guard
                .write_all(GUARD_PENDING)
                .and_then(|_| guard.sync_all())
                .map_err(|_| "Cannot initialize background receipt guard")?;
            File::open(
                path.parent()
                    .ok_or("Invalid background receipt directory")?,
            )
            .and_then(|file| file.sync_all())
            .map_err(|_| "Cannot sync background receipt guard")?;
        } else {
            if guard_meta.len() != GUARD_READY.len() as u64 {
                return Err("Background receipt guard is invalid".into());
            }
            let mut magic = vec![0; GUARD_READY.len()];
            guard
                .read_exact(&mut magic)
                .map_err(|_| "Cannot read background receipt guard")?;
            if magic != GUARD_READY {
                return Err("Background receipt guard is invalid".into());
            }
        }
        if created {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            builder
                .create(path)
                .map_err(|_| "Cannot create background receipt directory")?;
        }
        let meta = std::fs::symlink_metadata(path)
            .map_err(|_| "Cannot inspect background receipt directory")?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(
                "Background receipt directory must be private and owned by this user".into(),
            );
        }
        let file = |name: &str| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(created)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path.join(name))
        };
        let lock = file("owner.lock").map_err(|_| "Cannot open background receipt lock")?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(LEDGER_BUSY.into());
        }
        let db_path = path.join("receipts.sqlite3");
        let db_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(created)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&db_path)
            .map_err(|_| "Background receipt ledger is missing or unavailable")?;
        let db = open_receipt_database(&db_path, &db_file)?;
        db.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;")
            .map_err(|_| "Cannot initialize background receipt ledger")?;
        if created {
            db.execute_batch("CREATE TABLE receipts (key BLOB PRIMARY KEY, owner_key BLOB NOT NULL, session_key BLOB NOT NULL, state TEXT NOT NULL, code INTEGER); CREATE TABLE retired_sessions (session_key BLOB PRIMARY KEY);")
                .map_err(|_| "Cannot initialize background receipt ledger")?;
        } else {
            db.prepare("SELECT key, owner_key, session_key, state, code FROM receipts LIMIT 0")
                .map_err(|_| "Background receipt ledger is missing or invalid")?;
            db.prepare("SELECT session_key FROM retired_sessions LIMIT 0")
                .map_err(|_| "Background retirement ledger is missing or requires migration")?;
        }
        let review_tables: i64 = db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('owner_reviewed_receipts','owner_review_operations')", [], |row| row.get(0)).map_err(|_| "Cannot inspect background reviews")?;
        if review_tables == 0 {
            db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE owner_reviewed_receipts(key BLOB PRIMARY KEY,owner_key BLOB NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL); CREATE TABLE owner_review_operations(owner_key BLOB NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(owner_key,operation)); COMMIT;")
                .map_err(|_| "Cannot initialize background reviews")?;
        } else if review_tables != 2 {
            return Err("Background review ledger is incomplete".into());
        }
        db.prepare("SELECT key,owner_key,request,operation FROM owner_reviewed_receipts LIMIT 0")
            .map_err(|_| "Background review ledger is invalid")?;
        db.prepare("SELECT owner_key,request,operation,count FROM owner_review_operations LIMIT 0")
            .map_err(|_| "Background review ledger is invalid")?;
        for dir in [Some(path), path.parent()].into_iter().flatten() {
            File::open(dir)
                .and_then(|file| file.sync_all())
                .map_err(|_| "Cannot sync background receipt directory")?;
        }
        if created {
            guard
                .seek(SeekFrom::Start(0))
                .and_then(|_| guard.write_all(GUARD_READY))
                .and_then(|_| guard.set_len(GUARD_READY.len() as u64))
                .and_then(|_| guard.sync_all())
                .map_err(|_| "Cannot finalize background receipt guard")?;
        }
        Ok(Self {
            db: Mutex::new(db),
            _lock: lock,
            _guard: guard,
            db_file,
            quiescence_root: if path.file_name()
                == Some(std::ffi::OsStr::new("background-processes"))
            {
                Some(
                    path.parent()
                        .ok_or("Invalid background receipt directory")?
                        .canonicalize()
                        .map_err(|_| "Background data root unavailable")?,
                )
            } else {
                None
            },
            owner_pid: unsafe { libc::getpid() },
        })
    }

    #[cfg(unix)]
    pub(super) fn installation_binding(&self) -> Result<Option<Vec<u8>>, String> {
        self.quiescence_root
            .as_deref()
            .map(|root| {
                super::super::background_quiescence::capture_binding(
                    root,
                    Some((&self._guard, &self._lock, &self.db_file)),
                )
            })
            .transpose()
    }

    #[cfg(all(test, unix))]
    pub(super) fn validate_actor_root(&self, root: &Path) -> Result<(), String> {
        let expected = root
            .canonicalize()
            .map_err(|_| "Background data root unavailable")?;
        if self.quiescence_root.as_ref() != Some(&expected) {
            return Err("Background ledger belongs to another data root".into());
        }
        self.installation_binding()?
            .ok_or("Background ledger identity unavailable")?;
        Ok(())
    }
    #[cfg(not(unix))]
    pub(super) fn open(_path: &Path) -> Result<Self, String> {
        Err("Durable background processes are unavailable on this platform".into())
    }
    #[cfg(not(unix))]
    pub(super) fn create(_path: &Path) -> Result<Self, String> {
        Err("Durable background processes are unavailable on this platform".into())
    }
    fn hash_parts(parts: &[&str]) -> Vec<u8> {
        let mut hash = Sha256::new();
        for value in parts {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value.as_bytes());
        }
        hash.finalize().to_vec()
    }
    pub(super) fn key(scope: &BackgroundScope, action_id: &str) -> Result<Vec<u8>, String> {
        let workspace = scope.workspace.to_str().ok_or("Invalid workspace path")?;
        if let Some(incarnation) = scope.incarnation {
            if incarnation.is_nil() {
                return Err("Invalid background session identity".into());
            }
            return Ok(Self::hash_parts(&[
                "background-incarnation-v1",
                &scope.owner,
                &scope.session,
                workspace,
                &incarnation.to_string(),
                action_id,
            ]));
        }
        Ok(Self::hash_parts(&[
            scope.owner.as_str(),
            scope.session.as_str(),
            workspace,
            action_id,
        ]))
    }
    pub(super) fn has_unknown(&self, session: Option<(&str, &str)>) -> Result<bool, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        match session {
            Some((owner, session)) => db.query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE state NOT IN ('exited','cancelled','timed_out','failed_to_start') AND NOT (state='unknown' AND EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed JOIN owner_review_operations operation ON operation.owner_key=reviewed.owner_key AND operation.request=reviewed.request AND operation.operation=reviewed.operation WHERE reviewed.key=receipts.key AND reviewed.owner_key=receipts.owner_key)) AND session_key=?1)",
                params![Self::hash_parts(&[owner, session])],
                |r| r.get(0),
            ),
            None => db.query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE state NOT IN ('exited','cancelled','timed_out','failed_to_start') AND NOT (state='unknown' AND EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed JOIN owner_review_operations operation ON operation.owner_key=reviewed.owner_key AND operation.request=reviewed.request AND operation.operation=reviewed.operation WHERE reviewed.key=receipts.key AND reviewed.owner_key=receipts.owner_key)))",
                [],
                |r| r.get(0),
            ),
        }
        .map_err(|_| "Cannot check background receipts".into())
    }
    pub(super) fn has_unknown_owner(&self, owner: &str) -> Result<bool, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM receipts WHERE state NOT IN ('exited','cancelled','timed_out','failed_to_start') AND NOT (state='unknown' AND EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed JOIN owner_review_operations operation ON operation.owner_key=reviewed.owner_key AND operation.request=reviewed.request AND operation.operation=reviewed.operation WHERE reviewed.key=receipts.key AND reviewed.owner_key=receipts.owner_key)) AND owner_key=?1)",
            params![Self::hash_parts(&[owner])], |row| row.get(0),
        ).map_err(|_| "Cannot check owner background receipts".into())
    }

    #[cfg(unix)]
    pub(super) fn review_unknown_owner(
        &self,
        owner: &str,
        request: &str,
        operation: uuid::Uuid,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<usize, String> {
        if owner.trim().is_empty() || request.trim().is_empty() || operation.is_nil() {
            return Err("Invalid background review scope".into());
        }
        let mut db = self
            .db
            .try_lock()
            .map_err(|_| "Background receipt ledger is busy")?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Background review ledger unavailable")?;
        let owner_key = Self::hash_parts(&[owner]);
        let prior: Option<(String, i64)> = tx.query_row("SELECT request,count FROM owner_review_operations WHERE owner_key=?1 AND operation=?2", params![owner_key, operation.to_string()], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "Cannot inspect background review")?;
        if let Some((prior_request, count)) = prior {
            if prior_request != request || count <= 0 {
                return Err("Background review identity changed".into());
            }
            check()?;
            return usize::try_from(count).map_err(|_| "Invalid background review count".into());
        }
        check()?;
        let count = tx.execute("INSERT INTO owner_reviewed_receipts(key,owner_key,request,operation) SELECT key,owner_key,?2,?3 FROM receipts WHERE owner_key=?1 AND state='unknown' AND NOT EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed WHERE reviewed.key=receipts.key)", params![owner_key,request,operation.to_string()]).map_err(|_| "Cannot persist background review")?;
        if count == 0 {
            return Err("No unreviewed background outcomes".into());
        }
        tx.execute("INSERT INTO owner_review_operations(owner_key,request,operation,count) VALUES(?1,?2,?3,?4)", params![owner_key,request,operation.to_string(),count as i64]).map_err(|_| "Cannot persist background review")?;
        check()?;
        tx.commit()
            .map_err(|_| "Background review outcome is uncertain")?;
        Ok(count)
    }
    pub(super) fn is_retired(&self, owner: &str, session: &str) -> Result<bool, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM retired_sessions WHERE session_key=?1)",
            params![Self::hash_parts(&[owner, session])],
            |row| row.get(0),
        )
        .map_err(|_| "Cannot check retired background session".into())
    }
    /// Drops the oldest finished receipts in a scope, never one of a session's
    /// newest `MIN_RETAINED_PER_SESSION`, and never an unfinished, unknown or
    /// reviewed-unknown claim.
    fn prune_terminal(
        tx: &rusqlite::Transaction<'_>,
        condition: &str,
        key: &[u8],
        need: i64,
    ) -> Result<usize, String> {
        if need <= 0 {
            return Ok(0);
        }
        tx.execute(
            &format!(
                "DELETE FROM receipts WHERE rowid IN (SELECT r.rowid FROM receipts r WHERE {condition} AND r.state IN ('exited','cancelled','timed_out','failed_to_start') AND (SELECT COUNT(*) FROM receipts n WHERE n.session_key=r.session_key AND n.rowid>r.rowid) >= {MIN_RETAINED_PER_SESSION} ORDER BY r.rowid ASC LIMIT ?2)"
            ),
            params![key, need],
        )
        .map_err(|_| "Cannot prune finished background receipts".into())
    }
    pub(super) fn claim(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<Vec<u8>, String> {
        let key = Self::key(scope, action_id)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot claim background action")?;
        let session_key = Self::hash_parts(&[&scope.owner, &scope.session]);
        let retired: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM retired_sessions WHERE session_key=?1)",
                params![session_key],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot check retired background session")?;
        if retired {
            return Err("Background session is retired".into());
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE key=?1)",
                params![key],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot check background action")?;
        if exists {
            return Err("Action already accepted; replay rejected".into());
        }
        if scope.incarnation.is_some() {
            let mut legacy_scope = scope.clone();
            legacy_scope.incarnation = None;
            let legacy_key = Self::key(&legacy_scope, action_id)?;
            let legacy_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM receipts WHERE key=?1)",
                    params![legacy_key],
                    |row| row.get(0),
                )
                .map_err(|_| "Cannot check background action")?;
            if legacy_exists {
                return Err("Legacy action already accepted; replay rejected".into());
            }
        }
        let owner_key = Self::hash_parts(&[&scope.owner]);
        let counts = |tx: &rusqlite::Transaction<'_>| -> Result<(i64, i64, i64), String> {
            let total: i64 = tx
                .query_row("SELECT COUNT(*) FROM receipts", [], |r| r.get(0))
                .map_err(|_| "Cannot check background action capacity")?;
            let (owner_count, session_count): (i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(session_key=?2),0) FROM receipts WHERE owner_key=?1",
                    params![owner_key, session_key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| "Cannot check background action capacity")?;
            Ok((total, owner_count, session_count))
        };
        let (_, _, session_count) = counts(&tx)?;
        Self::prune_terminal(
            &tx,
            "r.session_key=?1",
            &session_key,
            session_count - MAX_SESSION_ACTIONS as i64 + 1,
        )?;
        let (_, owner_count, _) = counts(&tx)?;
        Self::prune_terminal(
            &tx,
            "r.owner_key=?1",
            &owner_key,
            owner_count - MAX_OWNER_ACTIONS as i64 + 1,
        )?;
        let (total, _, _) = counts(&tx)?;
        Self::prune_terminal(
            &tx,
            "?1 IS NOT NULL",
            &owner_key,
            total - MAX_ACTIONS as i64 + 1,
        )?;
        let (total, owner_count, session_count) = counts(&tx)?;
        if total >= MAX_ACTIONS as i64 {
            return Err("Background action receipt capacity exhausted".into());
        }
        if owner_count >= MAX_OWNER_ACTIONS as i64 || session_count >= MAX_SESSION_ACTIONS as i64 {
            return Err(
                "Background action capacity for this account or conversation is exhausted; resolve unfinished commands or delete the conversation to release it"
                    .into(),
            );
        }
        tx.execute(
            "INSERT INTO receipts(key,owner_key,session_key,state) VALUES(?1,?2,?3,'unknown')",
            params![key, owner_key, session_key],
        )
        .map_err(|_| "Cannot claim background action")?;
        tx.commit()
            .map_err(|_| "Cannot commit background action claim")?;
        Ok(key)
    }
    pub(super) fn retire_session(&self, owner: &str, session: &str) -> Result<(), String> {
        if owner.is_empty() || session.is_empty() || owner.len() > 256 || session.len() > 256 {
            return Err("Invalid background session".into());
        }
        let session_key = Self::hash_parts(&[owner, session]);
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot retire background session")?;
        let unknown: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE session_key=?1 AND state NOT IN ('exited','cancelled','timed_out','failed_to_start') AND NOT (state='unknown' AND EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed JOIN owner_review_operations operation ON operation.owner_key=reviewed.owner_key AND operation.request=reviewed.request AND operation.operation=reviewed.operation WHERE reviewed.key=receipts.key AND reviewed.owner_key=receipts.owner_key)))",
                params![session_key],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot check background outcomes")?;
        if unknown {
            return Err("Background cleanup is unconfirmed".into());
        }
        let retired: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM retired_sessions WHERE session_key=?1)",
                params![session_key],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot check retired background session")?;
        if !retired {
            let count: i64 = tx
                .query_row("SELECT COUNT(*) FROM retired_sessions", [], |r| r.get(0))
                .map_err(|_| "Cannot check retirement capacity")?;
            if count >= MAX_RETIRED_SESSIONS {
                return Err("Background retirement capacity exhausted".into());
            }
            tx.execute(
                "INSERT INTO retired_sessions(session_key) VALUES(?1)",
                params![session_key],
            )
            .map_err(|_| "Cannot retire background session")?;
        }
        tx.execute(
            "DELETE FROM receipts WHERE session_key=?1",
            params![session_key],
        )
        .map_err(|_| "Cannot release background receipts")?;
        tx.commit()
            .map_err(|_| "Cannot commit background retirement")?;
        Ok(())
    }
    pub(super) fn finish(&self, key: &[u8], state: &BackgroundState) -> Result<(), String> {
        let (name, code) = match state {
            BackgroundState::Exited { code } => ("exited", *code),
            BackgroundState::Cancelled => ("cancelled", None),
            BackgroundState::TimedOut => ("timed_out", None),
            BackgroundState::FailedToStart => ("failed_to_start", None),
            BackgroundState::CleanupUnconfirmed
            | BackgroundState::Unknown
            | BackgroundState::Running => ("unknown", None),
        };
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let updated = db
            .execute(
                "UPDATE receipts SET state=?2,code=?3 WHERE key=?1 AND state='unknown'",
                params![key, name, code],
            )
            .map_err(|_| "Cannot commit background outcome")?;
        if updated != 1 {
            return Err("Background claim is missing or already complete".into());
        }
        Ok(())
    }
    pub(super) fn read(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<BackgroundState, String> {
        let key = Self::key(scope, action_id)?;
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let receipt: Option<(String, Option<i32>)> = db
            .query_row(
                "SELECT state,code FROM receipts WHERE key=?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| "Cannot read background receipt")?;
        match receipt {
            Some((state, code)) => match state.as_str() {
                "exited" => Ok(BackgroundState::Exited { code }),
                "cancelled" => Ok(BackgroundState::Cancelled),
                "timed_out" => Ok(BackgroundState::TimedOut),
                "failed_to_start" => Ok(BackgroundState::FailedToStart),
                "unknown" => Ok(BackgroundState::Unknown),
                _ => Err("Invalid background receipt".into()),
            },
            None => Err("Background action not found".into()),
        }
    }
}
