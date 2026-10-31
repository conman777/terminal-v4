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
const COMMANDS_EVER_ENABLED: &str = "commands_ever_enabled";
pub(super) const RETIREMENT_CAPACITY_MESSAGE: &str = "Background retirement capacity exhausted: this data directory already holds the maximum number of retired-conversation records. The conversation was not changed; an operator must free capacity (see docs/development/BACKGROUND_PROCESS_LIFECYCLE.md) before deleting more conversations";
pub(super) const MIN_RETAINED_PER_SESSION: i64 = 8;
const MAX_PENDING_PAGE: usize = 64;
const INPUT_GUARD_V2: &[u8] = b"v4-background-ledger-v2-ready\n";
const INPUT_GUARD_V3: &[u8] = b"v4-background-ledger-v3-ready\n";
const MAX_INPUT_RECEIPTS: i64 = 32768;
const MAX_OWNER_INPUT_RECEIPTS: i64 = 4096;
const MAX_SESSION_INPUT_RECEIPTS: i64 = 1024;
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
    instance_id: uuid::Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum InputReceiptState {
    Uncertain,
    Delivered,
    NotWritten,
}

#[derive(Debug)]
pub(super) struct InputClaim {
    key: Vec<u8>,
    instance_id: uuid::Uuid,
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
        let mut input_guard_v3 = false;
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
            if magic == INPUT_GUARD_V3 {
                input_guard_v3 = true;
            } else if magic != GUARD_READY {
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
        let action_column: Option<String> = db
            .query_row(
                "SELECT type FROM pragma_table_info('receipts') WHERE name='action_id'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect background receipt index")?;
        match action_column.as_deref() {
            None => {
                db.execute("ALTER TABLE receipts ADD COLUMN action_id TEXT", [])
                    .map_err(|_| "Cannot upgrade background receipt index")?;
            }
            Some(kind) if kind.eq_ignore_ascii_case("TEXT") => {}
            Some(_) => return Err("Background receipt index is invalid".into()),
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
        if input_guard_v3 {
            db.prepare("SELECT key,owner_key,session_key,action_key,state FROM background_input_receipts LIMIT 0")
                .map_err(|_| "Background input receipt ledger is missing or invalid")?;
        }
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS launched_processes(key BLOB PRIMARY KEY, session_key BLOB NOT NULL, owner TEXT NOT NULL, session TEXT NOT NULL, workspace TEXT NOT NULL, incarnation TEXT, action_id TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, started_sec INTEGER, started_usec INTEGER);
             CREATE TABLE IF NOT EXISTS ledger_flags(name TEXT PRIMARY KEY);
             CREATE TABLE IF NOT EXISTS recovery_outcomes(key BLOB PRIMARY KEY, session_key BLOB NOT NULL, outcome TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS pending_completions(seq INTEGER PRIMARY KEY AUTOINCREMENT, key BLOB NOT NULL UNIQUE, session_key BLOB NOT NULL, owner TEXT NOT NULL, session TEXT NOT NULL, workspace TEXT NOT NULL, incarnation TEXT, action_id TEXT NOT NULL, state TEXT NOT NULL, code INTEGER);",
        )
        .map_err(|_| "Cannot initialize background recovery tables")?;
        db.execute_batch(&format!("INSERT OR IGNORE INTO ledger_flags(name) SELECT '{COMMANDS_EVER_ENABLED}' WHERE EXISTS(SELECT 1 FROM receipts) OR EXISTS(SELECT 1 FROM launched_processes) OR EXISTS(SELECT 1 FROM retired_sessions);"))
            .map_err(|_| "Cannot migrate background command marker")?;
        db.execute_batch(
            "UPDATE receipts SET action_id = COALESCE(
                (SELECT action_id FROM launched_processes WHERE launched_processes.key=receipts.key AND incarnation IS NOT NULL AND length(action_id)=64 AND action_id NOT GLOB '*[^0-9a-f]*'),
                (SELECT action_id FROM pending_completions WHERE pending_completions.key=receipts.key AND incarnation IS NOT NULL AND length(action_id)=64 AND action_id NOT GLOB '*[^0-9a-f]*')
             ) WHERE action_id IS NULL AND (
                EXISTS (SELECT 1 FROM launched_processes WHERE launched_processes.key=receipts.key AND incarnation IS NOT NULL AND length(action_id)=64 AND action_id NOT GLOB '*[^0-9a-f]*') OR
                EXISTS (SELECT 1 FROM pending_completions WHERE pending_completions.key=receipts.key AND incarnation IS NOT NULL AND length(action_id)=64 AND action_id NOT GLOB '*[^0-9a-f]*')
             );",
        )
        .map_err(|_| "Cannot recover background receipt index")?;
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
            instance_id: uuid::Uuid::new_v4(),
        })
    }

    #[cfg(unix)]
    pub(super) fn data_root(&self) -> Option<&Path> {
        self.quiescence_root.as_deref()
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

    #[cfg(unix)]
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
    fn listable_action_id(action_id: &str) -> bool {
        action_id.len() == 64
            && action_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }

    #[cfg(unix)]
    fn input_guard_version(&self) -> Result<bool, String> {
        use std::os::unix::fs::FileExt;
        if self
            ._guard
            .metadata()
            .map_err(|_| "Background guard unavailable")?
            .len()
            != INPUT_GUARD_V2.len() as u64
        {
            return Err("Background input guard is invalid".into());
        }
        let mut magic = vec![0; INPUT_GUARD_V2.len()];
        self._guard
            .read_exact_at(&mut magic, 0)
            .map_err(|_| "Background guard unavailable")?;
        match magic.as_slice() {
            INPUT_GUARD_V2 => Ok(false),
            INPUT_GUARD_V3 => Ok(true),
            _ => Err("Background input guard is invalid".into()),
        }
    }

    #[cfg(unix)]
    fn ensure_input_table(&self, db: &mut Connection) -> Result<(), String> {
        use std::os::unix::fs::FileExt;
        if !self.input_guard_version()? {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "Cannot initialize input receipts")?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS background_input_receipts(key BLOB PRIMARY KEY, owner_key BLOB NOT NULL, session_key BLOB NOT NULL, action_key BLOB NOT NULL, state TEXT NOT NULL); CREATE INDEX IF NOT EXISTS background_input_receipts_owner ON background_input_receipts(owner_key,session_key);")
                .map_err(|_| "Cannot initialize input receipts")?;
            tx.prepare("SELECT key,owner_key,session_key,action_key,state FROM background_input_receipts LIMIT 0")
                .map_err(|_| "Background input receipts are invalid")?;
            tx.commit()
                .map_err(|_| "Cannot commit input receipt initialization")?;
            self._guard
                .write_all_at(INPUT_GUARD_V3, 0)
                .and_then(|_| self._guard.sync_all())
                .map_err(|_| "Cannot commit background input guard")?;
        }
        db.prepare("SELECT key,owner_key,session_key,action_key,state FROM background_input_receipts LIMIT 0")
            .map_err(|_| "Background input receipt ledger is missing or invalid")?;
        Ok(())
    }

    #[cfg(unix)]
    fn input_key(scope: &BackgroundScope, operation_id: &str) -> Result<Vec<u8>, String> {
        if scope.incarnation.is_none_or(|id| id.is_nil()) || !Self::listable_action_id(operation_id)
        {
            return Err("Invalid background input identity".into());
        }
        let workspace = scope.workspace.to_str().ok_or("Invalid workspace path")?;
        Ok(Self::hash_parts(&[
            "background-input-v1",
            &scope.owner,
            &scope.session,
            workspace,
            &scope.incarnation.unwrap().to_string(),
            operation_id,
        ]))
    }

    /// Commit the operation identity before any input is sent. A reused ID is
    /// rejected even if its command or payload has changed.
    #[cfg(unix)]
    pub(super) fn claim_input(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
        operation_id: &str,
    ) -> Result<InputClaim, String> {
        if !Self::listable_action_id(action_id)
            || scope.owner.is_empty()
            || scope.session.is_empty()
        {
            return Err("Invalid background input scope".into());
        }
        let key = Self::input_key(scope, operation_id)?;
        let action_key = Self::key(scope, action_id)?;
        let owner_key = Self::hash_parts(&[&scope.owner]);
        let session_key = Self::hash_parts(&[&scope.owner, &scope.session]);
        let mut db = self
            .db
            .try_lock()
            .map_err(|_| "Background receipt ledger is busy")?;
        let eligible: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM receipts WHERE key=?1 AND owner_key=?2 AND session_key=?3 AND state='unknown') AND NOT EXISTS(SELECT 1 FROM retired_sessions WHERE session_key=?3)", params![action_key, owner_key, session_key], |row| row.get(0)).map_err(|_| "Cannot check background action")?;
        if !eligible {
            return Err("Background action is unavailable".into());
        }
        self.ensure_input_table(&mut db)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot claim background input")?;
        let retired: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM retired_sessions WHERE session_key=?1)",
                params![session_key],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot check background session")?;
        if retired {
            return Err("Background session is retired".into());
        }
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM receipts WHERE key=?1 AND owner_key=?2 AND session_key=?3 AND state='unknown')", params![action_key, owner_key, session_key], |row| row.get(0)).map_err(|_| "Cannot check background action")?;
        if !active {
            return Err("Background action is unavailable".into());
        }
        let duplicate: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM background_input_receipts WHERE key=?1)",
                params![key],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot check background input")?;
        if duplicate {
            return Err("Background input already claimed; replay rejected".into());
        }
        let (total, owner_count, session_count): (i64, i64, i64) = tx.query_row("SELECT COUNT(*), COALESCE(SUM(owner_key=?1),0), COALESCE(SUM(session_key=?2),0) FROM background_input_receipts", params![owner_key, session_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|_| "Cannot check input capacity")?;
        if total >= MAX_INPUT_RECEIPTS
            || owner_count >= MAX_OWNER_INPUT_RECEIPTS
            || session_count >= MAX_SESSION_INPUT_RECEIPTS
        {
            return Err("Background input receipt capacity exhausted".into());
        }
        tx.execute("INSERT INTO background_input_receipts(key,owner_key,session_key,action_key,state) VALUES(?1,?2,?3,?4,'uncertain')", params![key, owner_key, session_key, action_key]).map_err(|_| "Cannot claim background input")?;
        tx.commit()
            .map_err(|_| "Background input claim outcome is uncertain")?;
        Ok(InputClaim {
            key,
            instance_id: self.instance_id,
        })
    }

    #[cfg(unix)]
    pub(super) fn finish_input(
        &self,
        claim: InputClaim,
        state: InputReceiptState,
    ) -> Result<(), String> {
        if claim.instance_id != self.instance_id {
            return Err("Background input claim belongs to another ledger instance".into());
        }
        let value = match state {
            InputReceiptState::Delivered => "delivered",
            InputReceiptState::NotWritten => "not_written",
            InputReceiptState::Uncertain => return Err("Cannot confirm an uncertain input".into()),
        };
        let db = self
            .db
            .try_lock()
            .map_err(|_| "Background receipt ledger is busy")?;
        if !self.input_guard_version()? {
            return Err("Background input receipt ledger is unavailable".into());
        }
        let changed = db
            .execute(
                "UPDATE background_input_receipts SET state=?2 WHERE key=?1 AND state='uncertain'",
                params![claim.key, value],
            )
            .map_err(|_| "Background input outcome is uncertain")?;
        if changed != 1 {
            return Err("Background input claim is missing or already resolved".into());
        }
        Ok(())
    }

    #[cfg(unix)]
    #[allow(dead_code)]
    pub(super) fn input_state(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
        operation_id: &str,
    ) -> Result<InputReceiptState, String> {
        let key = Self::input_key(scope, operation_id)?;
        let action_key = Self::key(scope, action_id)?;
        let db = self
            .db
            .try_lock()
            .map_err(|_| "Background receipt ledger is busy")?;
        if !self.input_guard_version()? {
            return Err("Background input receipt ledger is unavailable".into());
        }
        let state: String = db
            .query_row(
                "SELECT state FROM background_input_receipts WHERE key=?1 AND action_key=?2",
                params![key, action_key],
                |row| row.get(0),
            )
            .map_err(|_| "Background input receipt is unavailable")?;
        match state.as_str() {
            "uncertain" => Ok(InputReceiptState::Uncertain),
            "delivered" => Ok(InputReceiptState::Delivered),
            "not_written" => Ok(InputReceiptState::NotWritten),
            _ => Err("Background input receipt is invalid".into()),
        }
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
        tx.execute_batch("DELETE FROM pending_completions WHERE key NOT IN (SELECT key FROM receipts); DELETE FROM recovery_outcomes WHERE key NOT IN (SELECT key FROM receipts);")
            .map_err(|_| "Cannot prune background completions")?;
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
            "INSERT OR IGNORE INTO ledger_flags(name) VALUES(?1)",
            params![COMMANDS_EVER_ENABLED],
        )
        .map_err(|_| "Cannot claim background action")?;
        tx.execute(
            "INSERT INTO receipts(key,owner_key,session_key,state,action_id) VALUES(?1,?2,?3,'unknown',?4)",
            params![key, owner_key, session_key, (scope.incarnation.is_some() && Self::listable_action_id(action_id)).then_some(action_id)],
        )
        .map_err(|_| "Cannot claim background action")?;
        tx.commit()
            .map_err(|_| "Cannot commit background action claim")?;
        Ok(key)
    }
    pub(super) fn mark_commands_enabled(&self) -> Result<(), String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        db.execute(
            "INSERT OR IGNORE INTO ledger_flags(name) VALUES(?1)",
            params![COMMANDS_EVER_ENABLED],
        )
        .map_err(|_| "Cannot persist background command marker")?;
        Ok(())
    }
    fn needs_tombstone(tx: &rusqlite::Connection, session_key: &[u8]) -> Result<bool, String> {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM ledger_flags WHERE name=?2) OR EXISTS(SELECT 1 FROM receipts WHERE session_key=?1) OR EXISTS(SELECT 1 FROM launched_processes WHERE session_key=?1)",
            params![session_key, COMMANDS_EVER_ENABLED],
            |r| r.get(0),
        )
        .map_err(|_| "Cannot check background retirement need".into())
    }
    /// Whether retiring would need a new tombstone slot, failing when none is
    /// free. `reserved` counts slots already promised to in-flight deletions.
    pub(super) fn can_retire(
        &self,
        owner: &str,
        session: &str,
        reserved: i64,
    ) -> Result<bool, String> {
        if owner.is_empty() || session.is_empty() || owner.len() > 256 || session.len() > 256 {
            return Err("Invalid background session".into());
        }
        let session_key = Self::hash_parts(&[owner, session]);
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let retired: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM retired_sessions WHERE session_key=?1)",
                params![session_key],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot check retired background session")?;
        if retired {
            return Ok(false);
        }
        if !Self::needs_tombstone(&db, &session_key)? {
            return Ok(false);
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM retired_sessions", [], |r| r.get(0))
            .map_err(|_| "Cannot check retirement capacity")?;
        if count.saturating_add(reserved) >= MAX_RETIRED_SESSIONS {
            return Err(RETIREMENT_CAPACITY_MESSAGE.into());
        }
        Ok(true)
    }
    /// Returns whether the session is tombstoned (and so needs the
    /// cross-process fence tombstone too).
    pub(super) fn retire_session(&self, owner: &str, session: &str) -> Result<bool, String> {
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
        let tombstoned = retired || Self::needs_tombstone(&tx, &session_key)?;
        if !retired && tombstoned {
            let count: i64 = tx
                .query_row("SELECT COUNT(*) FROM retired_sessions", [], |r| r.get(0))
                .map_err(|_| "Cannot check retirement capacity")?;
            if count >= MAX_RETIRED_SESSIONS {
                return Err(RETIREMENT_CAPACITY_MESSAGE.into());
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
        #[cfg(unix)]
        {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_input_receipts')", [], |row| row.get(0)).map_err(|_| "Cannot check background input receipts")?;
            if self.input_guard_version()? && !exists {
                return Err("Background input receipt ledger is missing or invalid".into());
            }
            if exists {
                tx.execute(
                    "DELETE FROM background_input_receipts WHERE session_key=?1",
                    params![session_key],
                )
                .map_err(|_| "Cannot release background input receipts")?;
            }
        }
        for table in [
            "pending_completions",
            "recovery_outcomes",
            "launched_processes",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE session_key=?1"),
                params![session_key],
            )
            .map_err(|_| "Cannot release background receipts")?;
        }
        tx.commit()
            .map_err(|_| "Cannot commit background retirement")?;
        Ok(tombstoned)
    }
    pub(super) fn finish(&self, key: &[u8], state: &BackgroundState) -> Result<(), String> {
        let (name, code) = Self::state_columns(state);
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
    /// Commits the terminal outcome and, in the same transaction, the pending
    /// completion marker for a launched process.
    pub(super) fn finish_launched(
        &self,
        key: &[u8],
        state: &BackgroundState,
        recovery: Option<&str>,
    ) -> Result<(), String> {
        let (name, code) = Self::state_columns(state);
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot commit background outcome")?;
        let updated = tx
            .execute(
                "UPDATE receipts SET state=?2,code=?3 WHERE key=?1 AND state='unknown'",
                params![key, name, code],
            )
            .map_err(|_| "Cannot commit background outcome")?;
        if updated != 1 {
            return Err("Background claim is missing or already complete".into());
        }
        tx.execute(
            "INSERT OR IGNORE INTO pending_completions(key,session_key,owner,session,workspace,incarnation,action_id,state,code) SELECT key,session_key,owner,session,workspace,incarnation,action_id,?2,?3 FROM launched_processes WHERE key=?1",
            params![key, name, code],
        )
        .map_err(|_| "Cannot persist background completion")?;
        if let Some(outcome) = recovery {
            tx.execute(
                "INSERT OR REPLACE INTO recovery_outcomes(key,session_key,outcome) SELECT key,session_key,?2 FROM launched_processes WHERE key=?1",
                params![key, outcome],
            )
            .map_err(|_| "Cannot persist background recovery outcome")?;
        }
        tx.execute("DELETE FROM launched_processes WHERE key=?1", params![key])
            .map_err(|_| "Cannot clear background process identity")?;
        tx.commit()
            .map_err(|_| "Cannot commit background outcome".into())
    }
    pub(super) fn record_launch(
        &self,
        key: &[u8],
        scope: &BackgroundScope,
        action_id: &str,
        pid: i32,
        pgid: i32,
        started: Option<(i64, i64)>,
    ) -> Result<(), String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let workspace = scope.workspace.to_str().ok_or("Invalid workspace path")?;
        db.execute(
            "INSERT INTO launched_processes(key,session_key,owner,session,workspace,incarnation,action_id,pid,pgid,started_sec,started_usec) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE EXISTS(SELECT 1 FROM receipts WHERE key=?1 AND state='unknown')",
            params![
                key,
                Self::hash_parts(&[&scope.owner, &scope.session]),
                scope.owner,
                scope.session,
                workspace,
                scope.incarnation.map(|value| value.to_string()),
                action_id,
                pid,
                pgid,
                started.map(|value| value.0),
                started.map(|value| value.1),
            ],
        )
        .map_err(|_| "Cannot record background process identity")?;
        Ok(())
    }
    /// Unreviewed unknown receipts with their recorded process identity;
    /// the identity is `None` when no start time could be captured.
    #[allow(clippy::type_complexity)]
    pub(super) fn recovery_candidates(
        &self,
    ) -> Result<Vec<(Vec<u8>, Option<(i32, i32, Option<(i64, i64)>)>)>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let mut query = db
            .prepare(
                "SELECT r.key,l.pid,l.pgid,l.started_sec,l.started_usec FROM receipts r LEFT JOIN launched_processes l ON l.key=r.key WHERE r.state='unknown' AND NOT EXISTS (SELECT 1 FROM owner_reviewed_receipts reviewed WHERE reviewed.key=r.key) ORDER BY r.rowid LIMIT 4096",
            )
            .map_err(|_| "Cannot inspect background recovery")?;
        let rows = query
            .query_map([], |row| {
                let pid: Option<i32> = row.get(1)?;
                let pgid: Option<i32> = row.get(2)?;
                let sec: Option<i64> = row.get(3)?;
                let usec: Option<i64> = row.get(4)?;
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    pid.zip(pgid).map(|(pid, pgid)| (pid, pgid, sec.zip(usec))),
                ))
            })
            .map_err(|_| "Cannot inspect background recovery")?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot inspect background recovery".into())
    }
    pub(super) fn note_recovery(&self, key: &[u8], outcome: &str) -> Result<(), String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        db.execute(
            "INSERT OR REPLACE INTO recovery_outcomes(key,session_key,outcome) SELECT key,session_key,?2 FROM receipts WHERE key=?1",
            params![key, outcome],
        )
        .map_err(|_| "Cannot persist background recovery outcome")?;
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn recovery_outcome(&self, key: &[u8]) -> Result<Option<String>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        db.query_row(
            "SELECT outcome FROM recovery_outcomes WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot read background recovery outcome".into())
    }
    pub(super) fn pending_completions(
        &self,
        limit: usize,
    ) -> Result<Vec<(i64, super::BackgroundCompletion)>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        Self::read_pending(&db, limit)
    }
    fn read_pending(
        db: &Connection,
        limit: usize,
    ) -> Result<Vec<(i64, super::BackgroundCompletion)>, String> {
        let mut query = db
            .prepare("SELECT seq,owner,session,workspace,incarnation,action_id,state,code FROM pending_completions ORDER BY seq LIMIT ?1")
            .map_err(|_| "Cannot inspect background completions")?;
        let rows = query
            .query_map([limit.min(MAX_PENDING_PAGE) as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<i32>>(7)?,
                ))
            })
            .map_err(|_| "Cannot inspect background completions")?;
        let mut completions = Vec::new();
        for row in rows {
            let (seq, owner, session, workspace, incarnation, action_id, state, code) =
                row.map_err(|_| "Cannot inspect background completions")?;
            completions.push((
                seq,
                super::BackgroundCompletion {
                    scope: BackgroundScope {
                        owner,
                        session,
                        workspace: workspace.into(),
                        incarnation: incarnation
                            .map(|value| uuid::Uuid::parse_str(&value))
                            .transpose()
                            .map_err(|_| "Invalid background completion")?,
                    },
                    action_id,
                    state: Self::state_from(&state, code)?,
                },
            ));
        }
        Ok(completions)
    }
    /// Removes the marker; true for exactly one caller per marker.
    pub(super) fn acknowledge_completion(&self, seq: i64) -> Result<bool, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        db.execute("DELETE FROM pending_completions WHERE seq=?1", params![seq])
            .map(|removed| removed == 1)
            .map_err(|_| "Cannot acknowledge background completion".into())
    }
    /// Atomically reads and removes up to `limit` markers in order.
    pub(super) fn drain_completions(
        &self,
        limit: usize,
    ) -> Result<Vec<super::BackgroundCompletion>, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background receipt ledger unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot drain background completions")?;
        let taken = Self::read_pending(&tx, limit)?;
        if let Some((last, _)) = taken.last() {
            tx.execute(
                "DELETE FROM pending_completions WHERE seq<=?1",
                params![last],
            )
            .map_err(|_| "Cannot drain background completions")?;
        }
        tx.commit()
            .map_err(|_| "Cannot drain background completions")?;
        Ok(taken
            .into_iter()
            .map(|(_, completion)| completion)
            .collect())
    }
    pub(super) fn read(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<BackgroundState, String> {
        self.read_inner(scope, action_id, false)
    }

    #[cfg(unix)]
    pub(super) fn try_read(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<BackgroundState, String> {
        self.read_inner(scope, action_id, true)
    }

    fn read_inner(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
        fail_fast: bool,
    ) -> Result<BackgroundState, String> {
        let key = Self::key(scope, action_id)?;
        let db = if fail_fast {
            self.db
                .try_lock()
                .map_err(|_| "Background receipt ledger is busy")?
        } else {
            self.db
                .lock()
                .map_err(|_| "Background receipt ledger unavailable")?
        };
        let receipt: Option<(String, Option<i32>)> = db
            .query_row(
                "SELECT state,code FROM receipts WHERE key=?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| "Cannot read background receipt")?;
        match receipt {
            Some((state, code)) => Self::state_from(&state, code),
            None => Err("Background action not found".into()),
        }
    }
    /// Action IDs are recoverable only for claims written with the scoped index.
    /// Verify every stored ID against the complete scope before returning it.
    #[cfg(unix)]
    pub(super) fn list(
        &self,
        scope: &BackgroundScope,
    ) -> Result<Vec<(String, BackgroundState)>, String> {
        if scope
            .incarnation
            .is_none_or(|incarnation| incarnation.is_nil())
        {
            return Err("Background session identity is required".into());
        }
        let db = self
            .db
            .try_lock()
            .map_err(|_| "Background receipt ledger is busy")?;
        let mut statement = db.prepare("SELECT key,action_id,state,code FROM receipts WHERE owner_key=?1 AND session_key=?2 AND action_id IS NOT NULL ORDER BY rowid DESC LIMIT ?3")
            .map_err(|_| "Cannot read background receipt index")?;
        let rows = statement
            .query_map(
                params![
                    Self::hash_parts(&[&scope.owner]),
                    Self::hash_parts(&[&scope.owner, &scope.session]),
                    MAX_SESSION_ACTIONS as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i32>>(3)?,
                    ))
                },
            )
            .map_err(|_| "Cannot read background receipt index")?;
        let mut results = Vec::new();
        for row in rows {
            let (key, action_id, state, code) =
                row.map_err(|_| "Invalid background receipt index")?;
            if !Self::listable_action_id(&action_id) {
                return Err("Invalid background receipt index".into());
            }
            if Self::key(scope, &action_id)? != key {
                continue;
            }
            results.push((action_id, Self::state_from(&state, code)?));
        }
        Ok(results)
    }
    fn state_from(state: &str, code: Option<i32>) -> Result<BackgroundState, String> {
        match state {
            "exited" => Ok(BackgroundState::Exited { code }),
            "cancelled" => Ok(BackgroundState::Cancelled),
            "timed_out" => Ok(BackgroundState::TimedOut),
            "failed_to_start" => Ok(BackgroundState::FailedToStart),
            "unknown" => Ok(BackgroundState::Unknown),
            _ => Err("Invalid background receipt".into()),
        }
    }
    fn state_columns(state: &BackgroundState) -> (&'static str, Option<i32>) {
        match state {
            BackgroundState::Exited { code } => ("exited", *code),
            BackgroundState::Cancelled => ("cancelled", None),
            BackgroundState::TimedOut => ("timed_out", None),
            BackgroundState::FailedToStart => ("failed_to_start", None),
            BackgroundState::CleanupUnconfirmed
            | BackgroundState::Unknown
            | BackgroundState::Running => ("unknown", None),
        }
    }
}
