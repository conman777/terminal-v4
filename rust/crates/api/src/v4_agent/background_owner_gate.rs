//! Owner admission and revocation records shared by cooperating server processes.
//! The application must provision this table once in an intact, durable database;
//! reopening never recreates a missing table or clears a hold.
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
#[cfg(unix)]
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use std::{sync::Mutex, time::Duration};

pub(crate) struct OwnerGate {
    db: Mutex<Connection>,
    #[cfg(unix)]
    identity: Option<DatabaseIdentity>,
}
const MAX_OWNER_HOLDS: i64 = 4096;

pub(crate) fn hold_logout_if_installed_with_request(
    tx: &Transaction<'_>,
    owner: &str,
    request: &str,
) -> Result<(), String> {
    validate(owner, request)?;
    let installed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')",
        [],
        |row| row.get(0),
    ).map_err(|_| "Cannot inspect background installation")?;
    if !installed {
        let database = tx
            .path()
            .filter(|path| !path.is_empty())
            .ok_or("Background installation location is unavailable")?;
        let root = std::path::Path::new(database)
            .parent()
            .filter(|path| path.is_absolute())
            .ok_or("Background installation location is unavailable")?;
        for path in [
            root.join("background-processes"),
            root.join(".background-processes.background-guard"),
        ] {
            match std::fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => {
                    return Err(
                        "Background installation marker is missing; owner cleanup is unconfirmed"
                            .into(),
                    )
                }
                Err(_) => return Err("Cannot inspect background installation location".into()),
            }
        }
        return Ok(());
    }
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM background_ledger_installation WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot inspect background installation")?;
    if state.as_deref() != Some("ready") {
        return Err("Background installation is incomplete; owner cleanup is unconfirmed".into());
    }
    let updated = tx
        .execute(
            "UPDATE background_owner_holds SET request=?2,state='held' WHERE owner=?1 AND request<>?2",
            params![owner, request],
        )
        .map_err(|_| "Cannot renew background owner hold")?;
    if updated != 0 {
        clear_quiescence_if_present(tx, owner)?;
    }
    if updated == 0 {
        OwnerGate::hold_in_transaction(tx, owner, request)?;
    }
    Ok(())
}

pub(crate) fn hold_logout_if_installed(tx: &Transaction<'_>, owner: &str) -> Result<(), String> {
    hold_logout_if_installed_with_request(tx, owner, &uuid::Uuid::new_v4().to_string())
}

#[cfg(unix)]
struct DatabaseIdentity {
    path: PathBuf,
    file: File,
}

#[cfg(unix)]
impl DatabaseIdentity {
    fn capture(db: &Connection) -> Option<Self> {
        let path = Path::new(db.path().filter(|path| !path.is_empty())?);
        if std::fs::symlink_metadata(path)
            .ok()?
            .file_type()
            .is_symlink()
        {
            return None;
        }
        let path = path.canonicalize().ok()?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .ok()?;
        let identity = Self { path, file };
        identity.validate(db).ok()?;
        Some(identity)
    }

    fn validate(&self, db: &Connection) -> Result<(), String> {
        let path = db
            .path()
            .filter(|path| !path.is_empty())
            .ok_or("Background control database unavailable")?;
        let current = std::fs::symlink_metadata(Path::new(path))
            .map_err(|_| "Background control database unavailable")?;
        let retained = self
            .file
            .metadata()
            .map_err(|_| "Background control database unavailable")?;
        if current.file_type().is_symlink()
            || !current.is_file()
            || !retained.is_file()
            || retained.nlink() != 1
            || retained.uid() != unsafe { libc::geteuid() }
            || (current.dev(), current.ino()) != (retained.dev(), retained.ino())
            || Path::new(path).canonicalize().ok().as_ref() != Some(&self.path)
        {
            return Err("Background control database changed".into());
        }
        Ok(())
    }
}

fn validate(owner: &str, request: &str) -> Result<(), String> {
    if owner.trim().is_empty()
        || owner.len() > 256
        || owner.chars().any(char::is_control)
        || request.trim().is_empty()
        || request.len() > 128
        || request.chars().any(char::is_control)
    {
        return Err("Invalid background owner revocation".into());
    }
    Ok(())
}

fn clear_quiescence_if_present(tx: &Transaction<'_>, owner: &str) -> Result<(), String> {
    let installed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_owner_quiescence')",
        [], |row| row.get(0),
    ).map_err(|_| "Cannot inspect background quiescence receipts")?;
    if installed {
        tx.execute(
            "DELETE FROM background_owner_quiescence WHERE owner=?1",
            [owner],
        )
        .map_err(|_| "Cannot clear background quiescence receipt")?;
    }
    Ok(())
}

impl OwnerGate {
    #[cfg(all(test, unix))]
    pub(crate) fn validate_actor_root(&self, root: &Path) -> Result<(), String> {
        let expected = root
            .canonicalize()
            .map_err(|_| "Background data root unavailable")?
            .join("terminal.db")
            .canonicalize()
            .map_err(|_| "Background control database unavailable")?;
        let db = self
            .db
            .try_lock()
            .map_err(|_| "Background owner control is busy")?;
        let identity = self
            .identity
            .as_ref()
            .ok_or("Background control database identity unavailable")?;
        if identity.path != expected {
            return Err("Background owner control belongs to another data root".into());
        }
        identity.validate(&db)
    }

    pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
        db.execute_batch("CREATE TABLE background_owner_holds (owner TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','acknowledged'))); CREATE TABLE background_owner_quiescence (owner TEXT PRIMARY KEY, request TEXT NOT NULL, ledger_binding BLOB NOT NULL)")
            .map_err(|_| "Cannot initialize background owner holds".into())
    }

    pub(crate) fn open(db: Connection) -> Result<Self, String> {
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|_| "Background owner control unavailable")?;
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|_| "Background owner control unavailable")?;
        let journal: String = db
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|_| "Background owner control unavailable")?;
        if sync < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Background owner control requires durable SQLite settings".into());
        }
        db.prepare("SELECT owner,request,state FROM background_owner_holds LIMIT 0")
            .map_err(|_| "Background owner control is missing or invalid")?;
        Ok(Self {
            #[cfg(unix)]
            identity: DatabaseIdentity::capture(&db),
            db: Mutex::new(db),
        })
    }

    pub(crate) fn hold(&self, owner: &str, request: &str) -> Result<(), String> {
        validate(owner, request)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Background owner control unavailable")?;
        Self::hold_in_transaction(&tx, owner, request)?;
        tx.commit()
            .map_err(|_| "Cannot persist background owner hold".into())
    }

    pub(crate) fn hold_in_transaction(
        tx: &Transaction<'_>,
        owner: &str,
        request: &str,
    ) -> Result<(), String> {
        validate(owner, request)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT request FROM background_owner_holds WHERE owner=?1",
                [owner],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect background owner hold")?;
        match existing {
            Some(value) if value != request => {
                return Err("Background owner already has a different hold".into())
            }
            Some(_) => {}
            None => {
                let count: i64 = tx
                    .query_row("SELECT COUNT(*) FROM background_owner_holds", [], |row| {
                        row.get(0)
                    })
                    .map_err(|_| "Cannot inspect background owner holds")?;
                if count >= MAX_OWNER_HOLDS {
                    return Err("Background owner hold capacity reached".into());
                }
                clear_quiescence_if_present(tx, owner)?;
                tx.execute(
                    "INSERT INTO background_owner_holds(owner,request,state) VALUES(?1,?2,'held')",
                    params![owner, request],
                )
                .map_err(|_| "Cannot hold background owner")?;
            }
        }
        Ok(())
    }

    pub(crate) fn status(&self, owner: &str, request: &str) -> Result<String, String> {
        validate(owner, request)?;
        let db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        db.query_row(
            "SELECT state FROM background_owner_holds WHERE owner=?1 AND request=?2",
            params![owner, request],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot inspect background owner hold")?
        .filter(|state: &String| state == "held" || state == "acknowledged")
        .ok_or_else(|| "Background owner hold is missing or invalid".into())
    }

    #[cfg(unix)]
    pub(super) fn validate_review_transaction(
        &self,
        tx: &Transaction<'_>,
        owner: &str,
        request: &str,
    ) -> Result<(), String> {
        validate(owner, request)?;
        self.identity
            .as_ref()
            .ok_or("Background control database identity unavailable")?
            .validate(tx)?;
        let matching: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM background_owner_holds b JOIN structured_owner_holds s ON s.owner=b.owner AND s.request=b.request JOIN background_ledger_installation i ON i.id=1 AND i.state='ready' WHERE b.owner=?1 AND b.request=?2 AND b.state IN ('held','acknowledged'))", params![owner,request], |row| row.get(0)).map_err(|_| "Cannot inspect background review hold")?;
        if !matching {
            return Err("Background review hold changed".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn with_review_hold<T>(
        &self,
        owner: &str,
        request: &str,
        review: impl FnOnce(&dyn Fn() -> Result<(), String>) -> Result<T, String>,
    ) -> Result<T, String> {
        validate(owner, request)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Background owner control unavailable")?;
        let check = || {
            let matching: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM background_owner_holds b JOIN structured_owner_holds s ON s.owner=b.owner AND s.request=b.request WHERE b.owner=?1 AND b.request=?2 AND b.state='held')", params![owner,request], |row| row.get(0)).map_err(|_| "Cannot inspect background review hold")?;
            if !matching {
                return Err("Background review hold changed".into());
            }
            Ok(())
        };
        check()?;
        let result = review(&check)?;
        check()?;
        tx.commit()
            .map_err(|_| "Background review hold outcome is uncertain")?;
        Ok(result)
    }

    pub(super) fn ensure_open(&self, owner: &str) -> Result<(), String> {
        validate(owner, "admission")?;
        let db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let held: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM background_owner_holds WHERE owner=?1)",
                [owner],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect background owner hold")?;
        if held {
            Err("Background actions are held for this owner".into())
        } else {
            Ok(())
        }
    }

    pub(super) fn pending(&self) -> Result<Vec<(String, String)>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let mut query = db.prepare("SELECT owner,request FROM background_owner_holds WHERE state='held' ORDER BY owner LIMIT 4096").map_err(|_| "Cannot inspect background owner holds")?;
        let values = query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| "Cannot inspect background owner holds")?;
        values
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot inspect background owner holds".into())
    }

    pub(super) fn acknowledge(&self, owner: &str, request: &str) -> Result<(), String> {
        validate(owner, request)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Background owner control unavailable")?;
        let updated = tx.execute("UPDATE background_owner_holds SET state='acknowledged' WHERE owner=?1 AND request=?2 AND state IN ('held','acknowledged')", params![owner,request]).map_err(|_| "Cannot acknowledge background owner cleanup")?;
        if updated != 1 {
            return Err("Background owner hold changed".into());
        }
        clear_quiescence_if_present(&tx, owner)?;
        tx.commit()
            .map_err(|_| "Cannot acknowledge background owner cleanup".into())
    }

    pub(super) fn acknowledge_quiescence(
        &self,
        owner: &str,
        request: &str,
        ledger_binding: &[u8],
    ) -> Result<(), String> {
        validate(owner, request)?;
        if ledger_binding.len() != 32 {
            return Err("Invalid background ledger binding".into());
        }
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Background owner control unavailable")?;
        let updated = tx.execute(
            "UPDATE background_owner_holds SET state='acknowledged' WHERE owner=?1 AND request=?2 AND state IN ('held','acknowledged')",
            params![owner, request],
        ).map_err(|_| "Cannot acknowledge background owner cleanup")?;
        if updated != 1 {
            return Err("Background owner hold changed".into());
        }
        tx.execute(
            "INSERT INTO background_owner_quiescence(owner,request,ledger_binding) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET request=excluded.request,ledger_binding=excluded.ledger_binding",
            params![owner, request, ledger_binding],
        ).map_err(|_| "Background quiescence receipts unavailable")?;
        tx.commit()
            .map_err(|_| "Cannot commit background owner cleanup".into())
    }

    pub(crate) fn release(&self, owner: &str, request: &str) -> Result<(), String> {
        validate(owner, request)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Background owner control unavailable")?;
        let coordinated: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='structured_owner_holds')", [], |row| row.get(0)).map_err(|_| "Cannot inspect owner cleanup hold")?;
        if coordinated {
            let held: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
                    [owner],
                    |row| row.get(0),
                )
                .map_err(|_| "Cannot inspect owner cleanup hold")?;
            if held {
                return Err("Coordinated owner cleanup must release this hold".into());
            }
        }
        let updated = tx.execute(
            "DELETE FROM background_owner_holds WHERE owner=?1 AND request=?2 AND state='acknowledged'",
            params![owner, request],
        ).map_err(|_| "Cannot release background owner hold")?;
        if updated != 1 {
            return Err("Background owner hold is missing or cleanup is unconfirmed".into());
        }
        clear_quiescence_if_present(&tx, owner)?;
        tx.commit()
            .map_err(|_| "Cannot release background owner hold".into())
    }

    #[cfg(test)]
    pub(crate) fn release_in_transaction(
        &self,
        tx: &Transaction<'_>,
        owner: &str,
        request: &str,
    ) -> Result<(), String> {
        validate(owner, request)?;
        self.identity
            .as_ref()
            .ok_or("Background control database identity unavailable")?
            .validate(tx)?;
        let removed = tx.execute(
            "DELETE FROM background_owner_holds WHERE owner=?1 AND request=?2 AND state='acknowledged'",
            params![owner, request],
        ).map_err(|_| "Cannot release background owner hold")?;
        if removed != 1 {
            return Err("Background owner hold is missing or cleanup is unconfirmed".into());
        }
        clear_quiescence_if_present(tx, owner)?;
        Ok(())
    }

    // The IMMEDIATE transaction keeps the shared write lock through spawn. If
    // its commit fails after spawn the caller must retain and stop the child.
    pub(super) fn admit<T>(
        &self,
        owner: &str,
        launch: impl FnOnce() -> Result<T, String>,
    ) -> Result<(T, bool), String> {
        self.admit_checked(owner, None, launch)
    }

    pub(crate) fn admit_generation<T>(
        &self,
        owner: &str,
        generation: i64,
        launch: impl FnOnce() -> Result<T, String>,
    ) -> Result<(T, bool), String> {
        if generation < 0 {
            return Err("Invalid background authorization generation".into());
        }
        self.admit_checked(owner, Some(generation), launch)
    }

    fn admit_checked<T>(
        &self,
        owner: &str,
        generation: Option<i64>,
        launch: impl FnOnce() -> Result<T, String>,
    ) -> Result<(T, bool), String> {
        validate(owner, "admission")?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "Background owner control unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Background owner control unavailable")?;
        let held: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM background_owner_holds WHERE owner=?1)",
                [owner],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect background owner hold")?;
        if held {
            return Err("Background actions are held for this owner".into());
        }
        if let Some(generation) = generation {
            let current: i64 = tx.query_row(
                "SELECT COALESCE((SELECT generation FROM auth_generations WHERE user_id=?1), 0)",
                [owner],
                |row| row.get(0),
            ).map_err(|_| "Cannot inspect background authorization generation")?;
            if generation != current {
                return Err("Background authorization has been revoked".into());
            }
        }
        let child = launch()?;
        let confirmed = tx.commit().is_ok();
        Ok((child, confirmed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        sync::{Arc, Barrier},
        thread,
    };

    #[test]
    fn logout_rejects_missing_installation_marker_when_ledger_directory_exists() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Connection::open(root.path().join("terminal.db")).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(hold_logout_if_installed(&tx, "owner").is_ok());
        tx.rollback().unwrap();

        std::fs::create_dir(root.path().join("background-processes")).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(hold_logout_if_installed(&tx, "owner").is_err());
        tx.rollback().unwrap();
    }

    #[test]
    fn logout_rejects_orphaned_background_guard_without_installation_marker() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Connection::open(root.path().join("terminal.db")).unwrap();
        std::fs::write(
            root.path().join(".background-processes.background-guard"),
            b"retained",
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        assert!(hold_logout_if_installed(&tx, "owner").is_err());
    }

    #[test]
    fn logout_rejects_a_missing_marker_when_ledger_location_is_ambiguous() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(hold_logout_if_installed(&tx, "owner").is_err());
        tx.rollback().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn logout_rejects_an_unreadable_ledger_location() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let mut db = Connection::open(root.path().join("terminal.db")).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = hold_logout_if_installed(&tx, "owner");
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        tx.rollback().unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn logout_hold_and_auth_generation_commit_together_and_fence_stale_admission() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let mut connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
        OwnerGate::initialize(&connection).unwrap();
        let gate = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        let old_generation = 0;

        {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            OwnerGate::hold_in_transaction(&tx, "alice", "logout-1").unwrap();
            tx.execute(
                "INSERT INTO auth_generations (user_id, generation) VALUES ('alice', 1)",
                [],
            )
            .unwrap();
        }
        assert!(gate.ensure_open("alice").is_ok());
        assert!(gate
            .admit_generation("alice", old_generation, || Ok(()))
            .is_ok());

        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        OwnerGate::hold_in_transaction(&tx, "alice", "logout-1").unwrap();
        tx.execute(
            "INSERT INTO auth_generations (user_id, generation) VALUES ('alice', 1)",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(gate
            .admit_generation("alice", old_generation, || -> Result<(), String> {
                panic!("revoked request launched")
            })
            .is_err());
        assert!(gate
            .admit_generation("alice", 1, || -> Result<(), String> {
                panic!("held owner launched")
            })
            .is_err());
        assert!(gate.release("alice", "logout-1").is_err());
        gate.acknowledge("alice", "logout-1").unwrap();
        assert!(gate.release("alice", "different-logout").is_err());
        gate.release("alice", "logout-1").unwrap();
        assert!(gate
            .admit_generation("alice", old_generation, || -> Result<(), String> {
                panic!("stale request launched")
            })
            .is_err());
        assert!(gate.admit_generation("alice", 1, || Ok(())).is_ok());
        assert!(gate.admit_generation("bob", 0, || Ok(())).is_ok());
    }

    #[test]
    #[ignore = "invoked by the cross-process logout admission test"]
    fn logout_generation_process_fixture() {
        let path = std::env::var_os("V4_TEST_OWNER_GATE_DB").unwrap();
        let ready = std::env::var_os("V4_TEST_OWNER_GATE_READY").unwrap();
        let mut db = Connection::open(path).unwrap();
        db.busy_timeout(Duration::from_secs(10)).unwrap();
        std::fs::write(ready, b"ready").unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        OwnerGate::hold_in_transaction(&tx, "owner", "logout-process").unwrap();
        tx.execute(
            "INSERT INTO auth_generations (user_id, generation) VALUES ('owner', 1)",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn cross_process_logout_waits_for_admission_and_invalidates_the_previous_generation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let ready = root.path().join("ready");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
        OwnerGate::initialize(&db).unwrap();
        let gate = OwnerGate::open(db).unwrap();
        let ((started, prematurely_finished, mut child), committed) = gate
            .admit_generation("owner", 0, || {
                let mut child = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "v4_agent::background_owner_gate::tests::logout_generation_process_fixture",
                        "--ignored",
                    ])
                    .env("V4_TEST_OWNER_GATE_DB", &path)
                    .env("V4_TEST_OWNER_GATE_READY", &ready)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while !ready.exists() && std::time::Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                let started = ready.exists();
                thread::sleep(Duration::from_millis(150));
                let prematurely_finished = child.try_wait().unwrap().is_some();
                Ok((started, prematurely_finished, child))
            })
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert!(
            committed
                && started
                && !prematurely_finished
                && status.is_some_and(|status| status.success())
        );
        assert_eq!(gate.status("owner", "logout-process").unwrap(), "held");
        gate.acknowledge("owner", "logout-process").unwrap();
        gate.release("owner", "logout-process").unwrap();
        assert!(gate.admit_generation("owner", 0, || Ok(())).is_err());
        assert!(gate.admit_generation("owner", 1, || Ok(())).is_ok());
    }

    #[test]
    fn stalled_launch_blocks_other_owner_authorization_transactions_until_release() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
        )
        .unwrap();
        OwnerGate::initialize(&db).unwrap();
        let gate = Arc::new(OwnerGate::open(db).unwrap());
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let launch = {
            let gate = gate.clone();
            let entered = entered.clone();
            let release = release.clone();
            thread::spawn(move || {
                gate.admit_generation("owner", 0, || {
                    entered.wait();
                    release.wait();
                    Ok(())
                })
            })
        };
        entered.wait();
        let mut other = Connection::open(&path).unwrap();
        other.busy_timeout(Duration::from_millis(150)).unwrap();
        let blocked = match other.transaction_with_behavior(TransactionBehavior::Immediate) {
            Err(rusqlite::Error::SqliteFailure(error, _)) => {
                error.code == rusqlite::ErrorCode::DatabaseBusy
            }
            _ => false,
        };
        release.wait();
        let outcome = launch.join().unwrap();
        let resumed = other
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .is_ok();
        assert!(blocked && outcome.is_ok() && resumed);
    }

    #[test]
    fn hold_serializes_with_admission_and_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let connection = Connection::open(&path).unwrap();
        OwnerGate::initialize(&connection).unwrap();
        let first = Arc::new(OwnerGate::open(connection).unwrap());
        let second = Arc::new(OwnerGate::open(Connection::open(&path).unwrap()).unwrap());
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let task = {
            let first = first.clone();
            let entered = entered.clone();
            let release = release.clone();
            thread::spawn(move || {
                first.admit("owner", || {
                    entered.wait();
                    release.wait();
                    Ok(())
                })
            })
        };
        entered.wait();
        let (signal, received) = std::sync::mpsc::channel();
        let holding = thread::spawn(move || {
            let result = second.hold("owner", "hold-1");
            signal.send(result).unwrap();
        });
        assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
        release.wait();
        assert_eq!(task.join().unwrap().unwrap(), ((), true));
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        holding.join().unwrap();
        assert!(first.admit("owner", || Ok(())).is_err());
        assert_eq!(first.status("owner", "hold-1").unwrap(), "held");
        drop(first);
        let reopened = OwnerGate::open(Connection::open(&path).unwrap()).unwrap();
        assert_eq!(reopened.status("owner", "hold-1").unwrap(), "held");
        assert!(reopened.admit("owner", || Ok(())).is_err());
        assert!(reopened.admit("another-owner", || Ok(())).is_ok());
    }

    #[test]
    #[ignore = "invoked by the cross-process owner-hold test"]
    fn owner_hold_process_fixture() {
        let db = std::env::var_os("V4_TEST_OWNER_GATE_DB").expect("fixture database");
        let ready = std::env::var_os("V4_TEST_OWNER_GATE_READY").expect("fixture signal");
        let gate = OwnerGate::open(Connection::open(db).unwrap()).unwrap();
        std::fs::write(ready, b"ready").unwrap();
        gate.hold("owner", "process-hold").unwrap();
    }

    #[test]
    fn another_process_cannot_hold_until_launch_admission_finishes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let ready = root.path().join("ready");
        let db = Connection::open(&path).unwrap();
        OwnerGate::initialize(&db).unwrap();
        let gate = Arc::new(OwnerGate::open(db).unwrap());
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let thread = {
            let gate = gate.clone();
            let entered = entered.clone();
            let release = release.clone();
            thread::spawn(move || {
                gate.admit("owner", || {
                    entered.wait();
                    release.wait();
                    Ok(())
                })
            })
        };
        entered.wait();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "v4_agent::background_owner_gate::tests::owner_hold_process_fixture",
                "--ignored",
            ])
            .env("V4_TEST_OWNER_GATE_DB", &path)
            .env("V4_TEST_OWNER_GATE_READY", &ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !ready.exists() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let started = ready.exists();
        thread::sleep(Duration::from_millis(150));
        let prematurely_finished = child.try_wait().unwrap().is_some();
        release.wait();
        assert!(thread.join().unwrap().unwrap().1);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert!(started && !prematurely_finished && status.is_some_and(|status| status.success()));
        assert_eq!(gate.status("owner", "process-hold").unwrap(), "held");
        assert!(gate.admit("owner", || Ok(())).is_err());
    }
}
