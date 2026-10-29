//! Owner-scoped live-manager lease for the Unix server runtime.
//!
//! An unclean release remains unconfirmed. The database and lock identity must
//! remain intact; older binaries do not honor these leases.
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
};

const MAGIC: &[u8; 8] = b"V4OWNL01";
const RECORD_LEN: u64 = 89;
const CLEAN: u8 = 0;
const UNKNOWN: u8 = 1;

#[derive(Debug)]
struct Root {
    original: PathBuf,
    path: PathBuf,
    device: u64,
    inode: u64,
}

#[derive(Debug)]
struct LeaseDirectory {
    path: PathBuf,
    file: File,
    device: u64,
    inode: u64,
}

impl LeaseDirectory {
    fn validate(&self, root: &Root) -> Result<(), String> {
        root.validate()?;
        let opened = self
            .file
            .metadata()
            .map_err(|_| "Ownership directory unavailable")?;
        let current =
            std::fs::symlink_metadata(&self.path).map_err(|_| "Ownership directory unavailable")?;
        if !opened.is_dir()
            || !current.is_dir()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || (opened.dev(), opened.ino()) != (self.device, self.inode)
            || (current.dev(), current.ino()) != (self.device, self.inode)
        {
            return Err("Ownership directory changed or is unsafe".into());
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(super) struct ManagerLeases {
    root: Arc<Root>,
}
#[derive(Debug)]
pub(super) struct LiveLease {
    root: Arc<Root>,
    directory: LeaseDirectory,
    key: [u8; 32],
    path: PathBuf,
    file: File,
    device: u64,
    inode: u64,
    epoch: uuid::Uuid,
}
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum OwnerState {
    Owned,
    NotProvisioned,
    Busy,
    Clean,
    Unconfirmed { epoch: uuid::Uuid },
}

impl Root {
    fn validate(&self) -> Result<(), String> {
        let metadata =
            std::fs::symlink_metadata(&self.path).map_err(|_| "Ownership root unavailable")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
            || (metadata.dev(), metadata.ino()) != (self.device, self.inode)
            || self.original.canonicalize().ok().as_deref() != Some(self.path.as_path())
        {
            return Err("Ownership root changed or is unsafe".into());
        }
        Ok(())
    }

    fn directory(&self, create: bool) -> Result<LeaseDirectory, String> {
        self.validate()?;
        let path = self.path.join("structured-owner-live");
        if create {
            match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => File::open(&self.path)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| "Cannot sync ownership directory")?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("Cannot create ownership directory".into()),
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| "Ownership directory unavailable")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Ownership directory unavailable")?;
        let directory = LeaseDirectory {
            path,
            file,
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        directory.validate(self)?;
        Ok(directory)
    }

    fn database(&self, initialize: bool) -> Result<Connection, String> {
        self.validate()?;
        let path = self.path.join("terminal.db");
        let before =
            std::fs::symlink_metadata(&path).map_err(|_| "Ownership database unavailable")?;
        if !before.is_file()
            || before.file_type().is_symlink()
            || before.uid() != unsafe { libc::geteuid() }
        {
            return Err("Ownership database is unsafe".into());
        }
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| "Ownership database unavailable")?;
        let after =
            std::fs::symlink_metadata(&path).map_err(|_| "Ownership database unavailable")?;
        if !after.is_file()
            || after.file_type().is_symlink()
            || (before.dev(), before.ino()) != (after.dev(), after.ino())
        {
            return Err("Ownership database changed".into());
        }
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|_| "Cannot verify ownership durability")?;
        let mode: String = db
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|_| "Cannot verify ownership durability")?;
        if sync < 2 || matches!(mode.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Ownership database is not durable".into());
        }
        if initialize {
            db.execute_batch("CREATE TABLE IF NOT EXISTS structured_owner_live_leases (scope BLOB PRIMARY KEY, state TEXT NOT NULL, device INTEGER, inode INTEGER); CREATE TABLE IF NOT EXISTS structured_owner_live_reviews (scope BLOB NOT NULL, epoch BLOB NOT NULL, operation BLOB NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(scope, epoch), UNIQUE(scope, operation))")
                .map_err(|_| "Cannot initialize ownership registry")?;
        }
        self.validate()?;
        Ok(db)
    }
}

fn file_is_safe(
    file: &File,
    path: &Path,
    identity: Option<(u64, u64)>,
) -> Result<(u64, u64), String> {
    let opened = file
        .metadata()
        .map_err(|_| "Cannot inspect ownership lease")?;
    let current = std::fs::symlink_metadata(path).map_err(|_| "Ownership lease unavailable")?;
    let id = (opened.dev(), opened.ino());
    if !opened.is_file()
        || !current.is_file()
        || current.file_type().is_symlink()
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.mode() & 0o077 != 0
        || opened.nlink() != 1
        || id != (current.dev(), current.ino())
        || identity.is_some_and(|expected| expected != id)
    {
        return Err("Ownership lease changed or is unsafe".into());
    }
    Ok(id)
}

fn read_marker(file: &File, key: &[u8; 32]) -> Result<(u8, uuid::Uuid), String> {
    if file
        .metadata()
        .map_err(|_| "Cannot inspect ownership lease")?
        .len()
        != RECORD_LEN
    {
        return Err("Ownership lease is invalid".into());
    }
    let mut bytes = [0u8; RECORD_LEN as usize];
    file.read_exact_at(&mut bytes, 0)
        .map_err(|_| "Cannot read ownership lease")?;
    if &bytes[..8] != MAGIC || bytes[8..40] != key[..] || !matches!(bytes[40], CLEAN | UNKNOWN) {
        return Err("Ownership lease identity or state is invalid".into());
    }
    if Sha256::digest(&bytes[..57])[..] != bytes[57..] {
        return Err("Ownership lease integrity is invalid".into());
    }
    let epoch = uuid::Uuid::from_slice(&bytes[41..57]).map_err(|_| "Invalid ownership epoch")?;
    if bytes[40] == UNKNOWN && epoch.is_nil() {
        return Err("Invalid ownership epoch".into());
    }
    Ok((bytes[40], epoch))
}

fn write_marker(file: &File, key: &[u8; 32], state: u8, epoch: uuid::Uuid) -> Result<(), String> {
    let mut marker = [0u8; RECORD_LEN as usize];
    marker[..8].copy_from_slice(MAGIC);
    marker[8..40].copy_from_slice(key);
    marker[40] = state;
    marker[41..57].copy_from_slice(epoch.as_bytes());
    let digest = Sha256::digest(&marker[..57]);
    marker[57..].copy_from_slice(&digest);
    file.write_all_at(&marker, 0)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist ownership state".into())
}

impl ManagerLeases {
    pub(super) fn new(root: &Path) -> Result<Self, String> {
        let original = if root.is_absolute() {
            root.to_owned()
        } else {
            std::env::current_dir()
                .map_err(|_| "Ownership root unavailable")?
                .join(root)
        };
        let path = original
            .canonicalize()
            .map_err(|_| "Ownership root unavailable")?;
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "Ownership root unavailable")?;
        let root = Arc::new(Root {
            original,
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        });
        root.validate()?;
        Ok(Self { root })
    }

    fn scope(&self, owner: &str) -> Result<[u8; 32], String> {
        if owner.trim().is_empty() || owner.len() > 1024 || owner.chars().any(char::is_control) {
            return Err("Invalid ownership scope".into());
        }
        self.root.validate()?;
        let mut hash = Sha256::new();
        for value in [self.root.path.as_os_str().as_bytes(), owner.as_bytes()] {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
        hash.update(self.root.device.to_be_bytes());
        hash.update(self.root.inode.to_be_bytes());
        Ok(hash.finalize().into())
    }

    fn open_existing(
        &self,
        owner: &str,
    ) -> Result<Option<([u8; 32], LeaseDirectory, PathBuf, File, (u64, u64))>, String> {
        let key = self.scope(owner)?;
        let db = self.root.database(false)?;
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='structured_owner_live_leases')", [], |row| row.get(0)
        ).map_err(|_| "Ownership registry unavailable")?;
        if !exists {
            return Ok(None);
        }
        let record: Option<(String, Option<u64>, Option<u64>)> = db
            .query_row(
                "SELECT state,device,inode FROM structured_owner_live_leases WHERE scope=?1",
                [key.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "Ownership registry unavailable")?;
        let expected = match record {
            None => return Ok(None),
            Some((state, Some(device), Some(inode))) if state == "ready" => (device, inode),
            _ => return Err("Ownership provisioning is unconfirmed".into()),
        };
        let directory = self.root.directory(false)?;
        let path = directory.path.join(format!("{}.lock", hex::encode(key)));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&path)
            .map_err(|_| "Ownership lease unavailable")?;
        file_is_safe(&file, &path, Some(expected))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Session ownership is unavailable on this server".into())
            }
            Err(_) => return Err("Cannot lock session ownership".into()),
        }
        directory.validate(&self.root)?;
        file_is_safe(&file, &path, Some(expected))?;
        Ok(Some((key, directory, path, file, expected)))
    }

    pub(super) fn inspect(&self, owner: &str) -> Result<OwnerState, String> {
        let opened = match self.open_existing(owner) {
            Ok(opened) => opened,
            Err(error) if error == "Session ownership is unavailable on this server" => {
                return Ok(OwnerState::Busy)
            }
            Err(error) => return Err(error),
        };
        let Some((key, directory, _, file, _)) = opened else {
            return Ok(OwnerState::NotProvisioned);
        };
        directory.validate(&self.root)?;
        match read_marker(&file, &key)? {
            (CLEAN, _) => Ok(OwnerState::Clean),
            (UNKNOWN, epoch) => Ok(OwnerState::Unconfirmed { epoch }),
            _ => Err("Ownership state is invalid".into()),
        }
    }

    pub(super) fn reconcile_unknown(
        &self,
        owner: &str,
        epoch: uuid::Uuid,
        operation: uuid::Uuid,
        acknowledged: bool,
    ) -> Result<(), String> {
        if !acknowledged || epoch.is_nil() || operation.is_nil() {
            return Err("Explicit acknowledgment and valid review identity are required".into());
        }
        let (key, directory, path, file, expected) = self
            .open_existing(owner)?
            .ok_or("Ownership lease unavailable")?;
        let (state, current_epoch) = read_marker(&file, &key)?;
        if current_epoch != epoch {
            return Err("Ownership review is stale".into());
        }
        let mut db = self.root.database(false)?;
        if state == CLEAN {
            let previous: Option<Vec<u8>> = db.query_row(
                "SELECT operation FROM structured_owner_live_reviews WHERE scope=?1 AND epoch=?2", params![key.as_slice(), epoch.as_bytes().as_slice()], |row| row.get(0)
            ).optional().map_err(|_| "Cannot verify ownership review")?;
            directory.validate(&self.root)?;
            file_is_safe(&file, &path, Some(expected))?;
            return if previous.as_deref() == Some(operation.as_bytes().as_slice()) {
                Ok(())
            } else {
                Err("Ownership review does not match".into())
            };
        }
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Ownership registry is busy")?;
        let previous: Option<Vec<u8>> = tx
            .query_row(
                "SELECT operation FROM structured_owner_live_reviews WHERE scope=?1 AND epoch=?2",
                params![key.as_slice(), epoch.as_bytes().as_slice()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot verify ownership review")?;
        if let Some(previous) = previous {
            if previous.as_slice() != operation.as_bytes() {
                return Err("Ownership review does not match".into());
            }
        } else {
            tx.execute("INSERT INTO structured_owner_live_reviews(scope,epoch,operation,outcome) VALUES (?1,?2,?3,'cleanup_unconfirmed')", params![key.as_slice(), epoch.as_bytes().as_slice(), operation.as_bytes().as_slice()])
                .map_err(|_| "Cannot record ownership review")?;
        }
        tx.commit().map_err(|_| "Cannot commit ownership review")?;
        directory.validate(&self.root)?;
        file_is_safe(&file, &path, Some(expected))?;
        if read_marker(&file, &key)? != (UNKNOWN, epoch) {
            return Err("Ownership review is stale".into());
        }
        write_marker(&file, &key, CLEAN, epoch)
    }

    pub(super) fn acquire(&self, owner: &str) -> Result<LiveLease, String> {
        let key = self.scope(owner)?;
        let directory = self.root.directory(true)?;
        let path = directory.path.join(format!("{}.lock", hex::encode(key)));
        let mut db = self.root.database(true)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Ownership registry is busy")?;
        let record: Option<(String, Option<u64>, Option<u64>)> = tx
            .query_row(
                "SELECT state,device,inode FROM structured_owner_live_leases WHERE scope=?1",
                [key.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "Ownership registry unavailable")?;
        let expected = match record {
            None => {
                tx.execute(
                    "INSERT INTO structured_owner_live_leases(scope,state) VALUES (?1,'pending')",
                    [key.as_slice()],
                )
                .map_err(|_| "Cannot reserve ownership lease")?;
                tx.commit()
                    .map_err(|_| "Cannot commit ownership reservation")?;
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&path)
                    .map_err(|_| "Cannot create ownership lease")?;
                write_marker(&file, &key, CLEAN, uuid::Uuid::nil())?;
                let id = file_is_safe(&file, &path, None)?;
                directory.validate(&self.root)?;
                directory
                    .file
                    .sync_all()
                    .map_err(|_| "Cannot sync ownership lease")?;
                directory.validate(&self.root)?;
                let tx = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|_| "Ownership registry is busy")?;
                let changed = tx.execute("UPDATE structured_owner_live_leases SET state='ready',device=?2,inode=?3 WHERE scope=?1 AND state='pending'", params![key.as_slice(), id.0, id.1])
                    .map_err(|_| "Cannot bind ownership lease")?;
                if changed != 1 {
                    return Err("Ownership reservation changed".into());
                }
                tx.commit().map_err(|_| "Cannot commit ownership lease")?;
                id
            }
            Some((state, Some(device), Some(inode))) if state == "ready" => {
                tx.commit().map_err(|_| "Cannot read ownership lease")?;
                (device, inode)
            }
            _ => return Err("Ownership provisioning is unconfirmed".into()),
        };
        directory.validate(&self.root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&path)
            .map_err(|_| "Ownership lease unavailable")?;
        file_is_safe(&file, &path, Some(expected))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Session ownership is unavailable on this server".into())
            }
            Err(_) => return Err("Cannot lock session ownership".into()),
        }
        file_is_safe(&file, &path, Some(expected))?;
        directory.validate(&self.root)?;
        if read_marker(&file, &key)?.0 != CLEAN {
            return Err("Previous session ownership is unconfirmed; review is required".into());
        }
        let epoch = uuid::Uuid::new_v4();
        write_marker(&file, &key, UNKNOWN, epoch)?;
        directory.validate(&self.root)?;
        file_is_safe(&file, &path, Some(expected))?;
        Ok(LiveLease {
            root: self.root.clone(),
            directory,
            key,
            path,
            file,
            device: expected.0,
            inode: expected.1,
            epoch,
        })
    }
}
impl LiveLease {
    pub(super) fn epoch(&self) -> Result<uuid::Uuid, String> {
        self.validate()?;
        Ok(self.epoch)
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        self.directory.validate(&self.root)?;
        file_is_safe(&self.file, &self.path, Some((self.device, self.inode)))?;
        if read_marker(&self.file, &self.key)? != (UNKNOWN, self.epoch) {
            return Err("Ownership state changed".into());
        }
        Ok(())
    }
    pub(super) fn release_clean(self) -> Result<(), String> {
        self.validate()?;
        write_marker(&self.file, &self.key, CLEAN, self.epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::Command,
        time::{Duration, Instant},
    };

    fn root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(root.path().join("terminal.db")).unwrap();
        root
    }

    #[test]
    fn owner_guards_exclude_same_owner_and_allow_unrelated_owners() {
        let root = root();
        let first = ManagerLeases::new(root.path()).unwrap();
        let second = ManagerLeases::new(root.path()).unwrap();
        let alice = first.acquire("alice").unwrap();
        alice.validate().unwrap();
        assert!(second.acquire("alice").is_err());
        second.acquire("bob").unwrap().release_clean().unwrap();
        alice.release_clean().unwrap();
        second.acquire("alice").unwrap().release_clean().unwrap();
    }

    #[test]
    fn unclean_drop_and_missing_previously_bound_lock_do_not_reprovision() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        let guard = manager.acquire("alice").unwrap();
        drop(guard);
        assert!(manager
            .acquire("alice")
            .unwrap_err()
            .contains("unconfirmed"));
        let directory = root.path().join("structured-owner-live");
        let entry = std::fs::read_dir(directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::remove_file(entry).unwrap();
        assert!(manager.acquire("alice").is_err());
    }

    #[test]
    fn reconciliation_is_explicit_audited_epoch_bound_and_idempotent() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        assert_eq!(
            manager.inspect("alice").unwrap(),
            OwnerState::NotProvisioned
        );
        let guard = manager.acquire("alice").unwrap();
        assert_eq!(manager.inspect("alice").unwrap(), OwnerState::Busy);
        drop(guard);
        let OwnerState::Unconfirmed { epoch } = manager.inspect("alice").unwrap() else {
            panic!("expected held ownership")
        };
        let operation = uuid::Uuid::new_v4();
        assert_eq!(manager.inspect("bob").unwrap(), OwnerState::NotProvisioned);
        assert!(manager
            .reconcile_unknown("bob", epoch, operation, true)
            .is_err());
        assert!(manager
            .reconcile_unknown("alice", epoch, operation, false)
            .is_err());
        assert!(manager
            .reconcile_unknown("alice", uuid::Uuid::new_v4(), operation, true)
            .is_err());
        manager
            .reconcile_unknown("alice", epoch, operation, true)
            .unwrap();
        manager
            .reconcile_unknown("alice", epoch, operation, true)
            .unwrap();
        assert_eq!(manager.inspect("alice").unwrap(), OwnerState::Clean);
        let db = rusqlite::Connection::open(root.path().join("terminal.db")).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM structured_owner_live_reviews",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
            1
        );
        let next = manager.acquire("alice").unwrap();
        drop(next);
        let OwnerState::Unconfirmed { epoch: later } = manager.inspect("alice").unwrap() else {
            panic!("expected a new hold")
        };
        assert_ne!(later, epoch);
        assert!(manager
            .reconcile_unknown("alice", epoch, operation, true)
            .is_err());
    }

    #[test]
    fn interrupted_review_retries_only_the_recorded_operation() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        drop(manager.acquire("alice").unwrap());
        let OwnerState::Unconfirmed { epoch } = manager.inspect("alice").unwrap() else {
            panic!("expected a hold")
        };
        let operation = uuid::Uuid::new_v4();
        let db = rusqlite::Connection::open(root.path().join("terminal.db")).unwrap();
        let scope: Vec<u8> = db
            .query_row(
                "SELECT scope FROM structured_owner_live_leases",
                [],
                |row| row.get(0),
            )
            .unwrap();
        db.execute("INSERT INTO structured_owner_live_reviews(scope,epoch,operation,outcome) VALUES (?1,?2,?3,'cleanup_unconfirmed')", params![scope, epoch.as_bytes().as_slice(), operation.as_bytes().as_slice()]).unwrap();
        assert!(manager
            .reconcile_unknown("alice", epoch, uuid::Uuid::new_v4(), true)
            .is_err());
        assert_eq!(
            manager.inspect("alice").unwrap(),
            OwnerState::Unconfirmed { epoch }
        );
        manager
            .reconcile_unknown("alice", epoch, operation, true)
            .unwrap();
        assert_eq!(manager.inspect("alice").unwrap(), OwnerState::Clean);
    }

    #[test]
    fn replacing_a_held_lock_is_detected_and_never_recreated() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        let guard = manager.acquire("alice").unwrap();
        let directory = root.path().join("structured-owner-live");
        let path = std::fs::read_dir(&directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::rename(&path, root.path().join("original.lock")).unwrap();
        std::fs::copy(root.path().join("original.lock"), &path).unwrap();
        assert!(guard.validate().is_err());
        assert!(guard.release_clean().is_err());
        assert!(manager.acquire("alice").is_err());
        assert!(manager.inspect("alice").is_err());
    }

    #[test]
    fn live_guard_rejects_lease_directory_becoming_public() {
        use std::os::unix::fs::PermissionsExt;
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        let guard = manager.acquire("alice").unwrap();
        let directory = root.path().join("structured-owner-live");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(guard.validate().is_err());
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        guard.validate().unwrap();
        guard.release_clean().unwrap();
    }

    #[test]
    fn live_guard_rejects_symlink_replacement_of_lease_directory() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        let guard = manager.acquire("alice").unwrap();
        let directory = root.path().join("structured-owner-live");
        let moved = root.path().join("moved-owner-live");
        std::fs::rename(&directory, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &directory).unwrap();
        assert!(guard.validate().is_err());
        std::fs::remove_file(&directory).unwrap();
        std::fs::rename(&moved, &directory).unwrap();
        guard.validate().unwrap();
        guard.release_clean().unwrap();
    }

    #[test]
    fn torn_marker_cannot_authorize_recovery_or_reuse_a_stale_epoch() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        drop(manager.acquire("alice").unwrap());
        let OwnerState::Unconfirmed { epoch } = manager.inspect("alice").unwrap() else {
            panic!("expected a hold")
        };
        let directory = root.path().join("structured-owner-live");
        let path = std::fs::read_dir(directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.write_all_at(&[epoch.as_bytes()[0] ^ 1], 41).unwrap();
        file.sync_all().unwrap();
        assert!(manager.inspect("alice").is_err());
        assert!(manager
            .reconcile_unknown("alice", epoch, uuid::Uuid::new_v4(), true)
            .is_err());
        assert!(manager.acquire("alice").is_err());
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn competing_process_fixture() {
        let Ok(root) = std::env::var("V4_LIVE_OWNER_ROOT") else {
            return;
        };
        let manager = ManagerLeases::new(Path::new(&root)).unwrap();
        if std::env::var("V4_LIVE_OWNER_CRASH").is_ok() {
            let _guard = manager.acquire("crashed").unwrap();
            std::process::exit(0);
        }
        assert!(manager.acquire("alice").is_err());
        manager.acquire("bob").unwrap().release_clean().unwrap();
    }

    #[test]
    fn cross_process_lock_excludes_same_owner() {
        let root = root();
        let manager = ManagerLeases::new(root.path()).unwrap();
        let guard = manager.acquire("alice").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "structured::live_ownership::tests::competing_process_fixture",
            ])
            .env("V4_LIVE_OWNER_ROOT", root.path())
            .spawn()
            .unwrap();
        let end = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < end, "lease subprocess timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        guard.release_clean().unwrap();
    }

    #[test]
    fn process_exit_leaves_unconfirmed_epoch_for_explicit_review() {
        let root = root();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "structured::live_ownership::tests::competing_process_fixture",
            ])
            .env("V4_LIVE_OWNER_ROOT", root.path())
            .env("V4_LIVE_OWNER_CRASH", "1")
            .spawn()
            .unwrap();
        let end = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < end, "lease subprocess timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        let manager = ManagerLeases::new(root.path()).unwrap();
        let OwnerState::Unconfirmed { epoch } = manager.inspect("crashed").unwrap() else {
            panic!("crash must remain unconfirmed")
        };
        assert!(manager.acquire("crashed").is_err());
        manager
            .reconcile_unknown("crashed", epoch, uuid::Uuid::new_v4(), true)
            .unwrap();
        manager.acquire("crashed").unwrap().release_clean().unwrap();
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn simultaneous_first_acquisition_fixture() {
        let Ok(root) = std::env::var("V4_LIVE_RACE_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let slot = std::env::var("V4_LIVE_RACE_SLOT").unwrap();
        let manager = ManagerLeases::new(root).unwrap();
        std::fs::write(root.join(format!("ready-{slot}")), b"ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join("go").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        match manager.acquire("race-owner") {
            Ok(guard) => {
                std::fs::write(root.join(format!("result-{slot}")), b"acquired").unwrap();
                while !root.join("release").exists() {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(10));
                }
                guard.release_clean().unwrap();
            }
            Err(_) => {
                std::fs::write(root.join(format!("result-{slot}")), b"unavailable").unwrap();
            }
        }
    }

    #[test]
    fn two_processes_racing_first_owner_acquisition_have_one_winner() {
        let root = root();
        let mut children = Vec::new();
        for slot in ["a", "b"] {
            children.push(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--ignored",
                        "--exact",
                        "structured::live_ownership::tests::simultaneous_first_acquisition_fixture",
                    ])
                    .env("V4_LIVE_RACE_ROOT", root.path())
                    .env("V4_LIVE_RACE_SLOT", slot)
                    .spawn()
                    .unwrap(),
            );
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        for slot in ["a", "b"] {
            while !root.path().join(format!("ready-{slot}")).exists() {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        std::fs::write(root.path().join("go"), b"go").unwrap();
        for slot in ["a", "b"] {
            while !root.path().join(format!("result-{slot}")).exists() {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let mut results = ["a", "b"].map(|slot| {
            std::fs::read_to_string(root.path().join(format!("result-{slot}"))).unwrap()
        });
        results.sort();
        assert_eq!(results, ["acquired", "unavailable"]);
        std::fs::write(root.path().join("release"), b"release").unwrap();
        for mut child in children {
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
