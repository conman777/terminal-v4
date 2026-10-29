//! Test-only provisioning and identity checks for structured owner admission.

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const MARKER: &str = "structured-owner-admission.marker";
const MAGIC: &[u8; 8] = b"V4SOWN01";
const MARKER_LEN: usize = 88;

pub(super) struct OwnerRegistry {
    root: PathBuf,
    root_file: File,
    database_file: File,
    marker_file: File,
    marker: [u8; MARKER_LEN],
}

impl OwnerRegistry {
    fn root(path: &Path) -> Result<(PathBuf, File), String> {
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| "Owner registry root unavailable")?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o022 != 0
        {
            return Err("Unsafe owner registry root".into());
        }
        let root = path
            .canonicalize()
            .map_err(|_| "Owner registry root unavailable")?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&root)
            .map_err(|_| "Owner registry root unavailable")?;
        Self::same_directory(&root, &file)?;
        Ok((root, file))
    }

    fn same_directory(path: &Path, file: &File) -> Result<(), String> {
        let opened = file
            .metadata()
            .map_err(|_| "Owner registry root unavailable")?;
        let current =
            std::fs::symlink_metadata(path).map_err(|_| "Owner registry root unavailable")?;
        if !opened.is_dir()
            || !current.is_dir()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o022 != 0
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Owner registry root changed or is unsafe".into());
        }
        Ok(())
    }

    fn open_file(path: &Path, private: bool) -> Result<File, String> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| "Owner registry file unavailable")?;
        Self::same_file(path, &file, private)?;
        Ok(file)
    }

    fn same_file(path: &Path, file: &File, private: bool) -> Result<(), String> {
        let opened = file
            .metadata()
            .map_err(|_| "Owner registry file unavailable")?;
        let current =
            std::fs::symlink_metadata(path).map_err(|_| "Owner registry file unavailable")?;
        if !opened.is_file()
            || !current.is_file()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.nlink() != 1
            || (private && opened.mode() & 0o077 != 0)
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Owner registry file changed or is unsafe".into());
        }
        Ok(())
    }

    fn identity(root: &File, db: &File, id: Uuid) -> Result<[u8; MARKER_LEN], String> {
        let root = root
            .metadata()
            .map_err(|_| "Owner registry root unavailable")?;
        let db = db
            .metadata()
            .map_err(|_| "Owner registry database unavailable")?;
        let mut bytes = [0; MARKER_LEN];
        bytes[..8].copy_from_slice(MAGIC);
        bytes[8..24].copy_from_slice(id.as_bytes());
        for (index, value) in [root.dev(), root.ino(), db.dev(), db.ino()]
            .into_iter()
            .enumerate()
        {
            bytes[24 + 8 * index..32 + 8 * index].copy_from_slice(&value.to_be_bytes());
        }
        let digest = Sha256::digest(&bytes[..56]);
        bytes[56..].copy_from_slice(&digest);
        Ok(bytes)
    }

    fn create(path: &Path) -> Result<Self, String> {
        let (root, root_file) = Self::root(path)?;
        let database_file = Self::open_file(&root.join("terminal.db"), false)?;
        let marker = Self::identity(&root_file, &database_file, Uuid::new_v4())?;
        let marker_path = root.join(MARKER);
        let mut marker_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&marker_path)
            .map_err(|_| "Owner registry already exists or cannot be provisioned")?;
        marker_file
            .write_all(&marker)
            .and_then(|_| marker_file.sync_all())
            .map_err(|_| "Cannot persist owner registry identity")?;
        root_file
            .sync_all()
            .map_err(|_| "Cannot persist owner registry directory")?;
        drop(marker_file);
        let marker_file = Self::open_file(&marker_path, true)?;
        let registry = Self {
            root,
            root_file,
            database_file,
            marker_file,
            marker,
        };
        registry.validate_identity()?;
        let mut db = registry.database()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot provision owner registry")?;
        tx.execute_batch("CREATE TABLE structured_owner_installation(id INTEGER PRIMARY KEY CHECK(id=1), identity BLOB NOT NULL); CREATE TABLE structured_owner_holds(owner TEXT PRIMARY KEY, request TEXT NOT NULL);").map_err(|_| "Cannot provision owner registry")?;
        tx.execute(
            "INSERT INTO structured_owner_installation(id,identity) VALUES(1,?1)",
            params![&registry.marker[..]],
        )
        .map_err(|_| "Cannot provision owner registry")?;
        registry.validate_identity()?;
        tx.commit()
            .map_err(|_| "Cannot commit owner registry provisioning")?;
        registry.validate_connection(&db)?;
        Ok(registry)
    }

    fn open(path: &Path) -> Result<Self, String> {
        let (root, root_file) = Self::root(path)?;
        let database_file = Self::open_file(&root.join("terminal.db"), false)?;
        let mut marker_file = Self::open_file(&root.join(MARKER), true)?;
        let mut marker = [0; MARKER_LEN];
        marker_file
            .read_exact(&mut marker)
            .map_err(|_| "Owner registry marker is invalid")?;
        let mut extra = [0; 1];
        if marker_file
            .read(&mut extra)
            .map_err(|_| "Owner registry marker is invalid")?
            != 0
        {
            return Err("Owner registry marker is invalid".into());
        }
        let id =
            Uuid::from_slice(&marker[8..24]).map_err(|_| "Owner registry marker is invalid")?;
        if marker != Self::identity(&root_file, &database_file, id)? {
            return Err("Owner registry identity changed".into());
        }
        let registry = Self {
            root,
            root_file,
            database_file,
            marker_file,
            marker,
        };
        let db = registry.database()?;
        registry.validate_connection(&db)?;
        Ok(registry)
    }

    fn validate_identity(&self) -> Result<(), String> {
        Self::same_directory(&self.root, &self.root_file)?;
        Self::same_file(&self.root.join("terminal.db"), &self.database_file, false)?;
        Self::same_file(&self.root.join(MARKER), &self.marker_file, true)?;
        if self
            .marker_file
            .metadata()
            .map_err(|_| "Owner registry marker unavailable")?
            .len()
            != MARKER_LEN as u64
        {
            return Err("Owner registry marker changed".into());
        }
        let mut bytes = [0; MARKER_LEN];
        self.marker_file
            .read_exact_at(&mut bytes, 0)
            .map_err(|_| "Owner registry marker unavailable")?;
        if bytes != self.marker {
            return Err("Owner registry marker changed".into());
        }
        Self::same_file(&self.root.join(MARKER), &self.marker_file, true)?;
        Ok(())
    }

    fn database(&self) -> Result<Connection, String> {
        self.validate_identity()?;
        let db = Connection::open_with_flags(
            self.root.join("terminal.db"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|_| "Owner registry database unavailable")?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|_| "Owner registry database unavailable")?;
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|_| "Owner registry database unavailable")?;
        let journal: String = db
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|_| "Owner registry database unavailable")?;
        if sync < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Owner registry database is not durable".into());
        }
        self.validate_identity()?;
        Ok(db)
    }

    fn validate_connection(&self, db: &Connection) -> Result<(), String> {
        self.validate_identity()?;
        let path = db.path().ok_or("Owner registry database unavailable")?;
        if Path::new(path) != self.root.join("terminal.db") {
            return Err("Owner registry database mismatch".into());
        }
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|_| "Owner registry database unavailable")?;
        let journal: String = db
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|_| "Owner registry database unavailable")?;
        if sync < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Owner registry database is not durable".into());
        }
        let marker: Vec<u8> = db
            .query_row(
                "SELECT identity FROM structured_owner_installation WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "Owner registry installation is unavailable")?;
        if marker.as_slice() != self.marker {
            return Err("Owner registry installation changed".into());
        }
        db.prepare("SELECT owner,request FROM structured_owner_holds LIMIT 0")
            .map_err(|_| "Owner registry holds are unavailable")?;
        db.prepare("SELECT user_id,generation FROM auth_generations LIMIT 0")
            .map_err(|_| "Owner registry authorization is unavailable")?;
        self.validate_identity()
    }
}

#[cfg(test)]
mod tests {
    use super::OwnerRegistry;
    use rusqlite::Connection;
    use std::os::unix::fs::symlink;

    fn fixture() -> (tempfile::TempDir, Connection) {
        let root = tempfile::tempdir().unwrap();
        let db = Connection::open(root.path().join("terminal.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE auth_generations(user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
        )
        .unwrap();
        (root, db)
    }

    #[test]
    fn explicit_provision_and_reopen_preserve_holds() {
        let (root, db) = fixture();
        let registry = OwnerRegistry::create(root.path()).unwrap();
        registry.validate_connection(&db).unwrap();
        db.execute(
            "INSERT INTO structured_owner_holds VALUES('alice','request')",
            [],
        )
        .unwrap();
        drop(registry);
        let reopened = OwnerRegistry::open(root.path()).unwrap();
        reopened.validate_connection(&db).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT request FROM structured_owner_holds WHERE owner='alice'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "request"
        );
        assert!(OwnerRegistry::create(root.path()).is_err());
    }

    #[test]
    fn missing_marker_or_table_never_provisions_again() {
        let (root, db) = fixture();
        let registry = OwnerRegistry::create(root.path()).unwrap();
        db.execute("DROP TABLE structured_owner_holds", []).unwrap();
        assert!(registry.validate_connection(&db).is_err());
        assert!(OwnerRegistry::open(root.path()).is_err());
        assert!(OwnerRegistry::create(root.path()).is_err());
        assert!(db.prepare("SELECT * FROM structured_owner_holds").is_err());
        std::fs::remove_file(root.path().join("structured-owner-admission.marker")).unwrap();
        assert!(OwnerRegistry::open(root.path()).is_err());
    }

    #[test]
    fn replaced_database_and_symlink_marker_are_rejected() {
        let (root, db) = fixture();
        let registry = OwnerRegistry::create(root.path()).unwrap();
        let db_path = root.path().join("terminal.db");
        std::fs::rename(&db_path, root.path().join("original.db")).unwrap();
        std::fs::copy(root.path().join("original.db"), &db_path).unwrap();
        assert!(registry.validate_connection(&db).is_err());
        assert!(OwnerRegistry::open(root.path()).is_err());
        let marker = root.path().join("structured-owner-admission.marker");
        std::fs::rename(&marker, root.path().join("original.marker")).unwrap();
        symlink(root.path().join("original.marker"), &marker).unwrap();
        assert!(OwnerRegistry::open(root.path()).is_err());
    }

    #[test]
    fn incomplete_or_foreign_installation_fails_closed() {
        let (root, db) = fixture();
        let other = tempfile::tempdir().unwrap();
        let registry = OwnerRegistry::create(root.path()).unwrap();
        assert!(registry
            .validate_connection(&Connection::open_in_memory().unwrap())
            .is_err());
        assert!(registry
            .validate_connection(&Connection::open(other.path().join("terminal.db")).unwrap())
            .is_err());
        db.execute("DELETE FROM structured_owner_installation", [])
            .unwrap();
        assert!(registry.validate_connection(&db).is_err());
        assert!(OwnerRegistry::open(root.path()).is_err());
        assert!(OwnerRegistry::create(root.path()).is_err());
    }

    #[test]
    fn competing_provisioners_have_exactly_one_winner() {
        let (root, _db) = fixture();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let results = std::thread::scope(|scope| {
            let first_barrier = barrier.clone();
            let path = root.path();
            let first = scope.spawn(move || {
                first_barrier.wait();
                OwnerRegistry::create(path).is_ok()
            });
            let second = scope.spawn(move || {
                barrier.wait();
                OwnerRegistry::create(path).is_ok()
            });
            (first.join().unwrap(), second.join().unwrap())
        });
        assert!(matches!(results, (true, false) | (false, true)));
        assert!(OwnerRegistry::open(root.path()).is_ok());
    }

    #[test]
    fn damaged_marker_is_not_recreated() {
        let (root, _db) = fixture();
        let registry = OwnerRegistry::create(root.path()).unwrap();
        std::fs::write(
            root.path().join("structured-owner-admission.marker"),
            b"incomplete",
        )
        .unwrap();
        assert!(registry.validate_identity().is_err());
        assert!(OwnerRegistry::open(root.path()).is_err());
        assert!(OwnerRegistry::create(root.path()).is_err());
    }

    #[test]
    fn unsafe_sqlite_durability_is_rejected_for_each_connection() {
        let (root, db) = fixture();
        let registry = OwnerRegistry::create(root.path()).unwrap();
        db.execute_batch("PRAGMA synchronous=OFF").unwrap();
        assert!(registry.validate_connection(&db).is_err());
        db.execute_batch("PRAGMA synchronous=FULL").unwrap();
        assert!(registry.validate_connection(&db).is_ok());
    }
}
