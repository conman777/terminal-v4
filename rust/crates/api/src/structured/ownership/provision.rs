//! Test-only provisioning. Creating a lease is permitted only for an
//! authenticated, durably registered new session; a missing file is not proof
//! that a previous lease never existed.

use super::{Lease, Scope, CLEAN, MAGIC, UNCERTAIN};
use rusqlite::{params, Connection, OpenFlags};
use std::{
    ffi::CString,
    fs::{File, OpenOptions},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

mod enrollment;

struct Store {
    root: PathBuf,
    root_file: File,
    directory: File,
    registry_file: File,
    registry: Arc<Mutex<Connection>>,
}
struct Guard {
    store: Store,
    path: PathBuf,
    lease: Lease,
}

impl Store {
    fn open_child(directory: &File, name: &str, flags: i32, mode: u32) -> Result<File, String> {
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err("Invalid ownership entry name".into());
        }
        let name = CString::new(name).map_err(|_| "Invalid ownership entry name")?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                mode as libc::c_uint,
            )
        };
        if descriptor < 0 {
            return Err("Cannot open ownership entry".into());
        }
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn create(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "Cannot resolve ownership root")?;
        let root_file = Self::open_directory(&root)?;
        Self::check_directory(&root, &root_file, false)?;
        let name = CString::new("structured-ownership").unwrap();
        if unsafe { libc::mkdirat(root_file.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err("Cannot create ownership directory".into());
        }
        root_file
            .sync_all()
            .map_err(|_| "Cannot sync ownership root")?;
        let dir = root.join("structured-ownership");
        let path = dir.join("registry.sqlite3");
        let dir_file = Self::open_child(
            &root_file,
            "structured-ownership",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        let file = Self::open_child(
            &dir_file,
            "registry.sqlite3",
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        file.sync_all()
            .map_err(|_| "Cannot sync ownership registry")?;
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| "Cannot open ownership registry")?;
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE leases(scope BLOB PRIMARY KEY, status TEXT NOT NULL, identity TEXT); PRAGMA user_version=1;")
            .map_err(|_| "Cannot initialize ownership registry")?;
        dir_file
            .sync_all()
            .map_err(|_| "Cannot sync ownership directory")?;
        Self::open(&root)
    }

    fn open(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "Cannot resolve ownership root")?;
        let root_file = Self::open_directory(&root)?;
        let directory = Self::open_child(
            &root_file,
            "structured-ownership",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        let path = root.join("structured-ownership").join("registry.sqlite3");
        let registry_file = Self::open_child(&directory, "registry.sqlite3", libc::O_RDWR, 0)?;
        let registry = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| "Cannot open ownership registry")?;
        registry
            .execute_batch("PRAGMA synchronous=FULL;")
            .map_err(|_| "Cannot configure ownership registry")?;
        let version: i64 = registry
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| "Cannot read ownership registry")?;
        let integrity: String = registry
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|_| "Cannot read ownership registry")?;
        if version != 1 || integrity != "ok" {
            return Err("Invalid ownership registry".into());
        }
        let store = Self {
            root,
            root_file,
            directory,
            registry_file,
            registry: Arc::new(Mutex::new(registry)),
        };
        store.validate()?;
        store.check_registry()?;
        Ok(store)
    }

    fn open_directory(path: &Path) -> Result<File, String> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| "Cannot open ownership directory".into())
    }

    fn check_directory(path: &Path, file: &File, private: bool) -> Result<(), String> {
        let opened = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership directory")?;
        let current =
            std::fs::symlink_metadata(path).map_err(|_| "Ownership directory unavailable")?;
        let forbidden = if private { 0o077 } else { 0o022 };
        if !opened.is_dir()
            || !current.is_dir()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & forbidden != 0
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Unsafe ownership directory".into());
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), String> {
        if self.root.canonicalize().ok().as_ref() != Some(&self.root) {
            return Err("Ownership root changed".into());
        }
        Self::check_directory(&self.root, &self.root_file, false)?;
        Self::check_directory(
            &self.root.join("structured-ownership"),
            &self.directory,
            true,
        )
    }

    fn path(&self, scope: &Scope) -> Result<PathBuf, String> {
        self.validate()?;
        scope.validate_root()?;
        if scope.root != self.root {
            return Err("Ownership root mismatch".into());
        }
        let name: String = scope
            .digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(self.root.join("structured-ownership").join(name))
    }

    fn check_file(&self, path: &Path, file: &File) -> Result<(), String> {
        self.validate()?;
        let opened = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership file")?;
        let current = std::fs::symlink_metadata(path).map_err(|_| "Ownership file unavailable")?;
        if !opened.is_file()
            || !current.is_file()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || opened.nlink() != 1
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Ownership file changed".into());
        }
        Ok(())
    }

    fn check_registry(&self) -> Result<(), String> {
        self.check_file(
            &self.root.join("structured-ownership/registry.sqlite3"),
            &self.registry_file,
        )
    }

    fn provision(&self, scope: &Scope) -> Result<(), String> {
        let path = self.path(scope)?;
        self.check_registry()?;
        self.registry
            .lock()
            .map_err(|_| "Ownership registry unavailable")?
            .execute(
                "INSERT INTO leases(scope,status) VALUES (?1,'pending')",
                params![&scope.digest[..]],
            )
            .map_err(|_| "Ownership scope already exists or cannot be reserved")?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Invalid ownership entry name")?;
        let file = Self::open_child(
            &self.directory,
            name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let mut locked = Lease::lock(file)?;
        self.check_file(&path, &locked.0)?;
        locked
            .0
            .write_all(MAGIC)
            .and_then(|_| locked.0.write_all(&scope.digest))
            .and_then(|_| locked.0.write_all(&[UNCERTAIN]))
            .and_then(|_| locked.0.sync_all())
            .map_err(|_| "Cannot persist ownership file")?;
        self.directory
            .sync_all()
            .map_err(|_| "Cannot sync ownership directory")?;
        self.check_file(&path, &locked.0)?;
        scope.validate_root()?;
        Lease::write_state(&mut locked.0, CLEAN)?;
        let metadata = locked
            .0
            .metadata()
            .map_err(|_| "Cannot inspect ownership file")?;
        let identity = format!("{:016x}:{:016x}", metadata.dev(), metadata.ino());
        self.check_registry()?;
        let updated = self
            .registry
            .lock()
            .map_err(|_| "Ownership registry unavailable")?
            .execute(
                "UPDATE leases SET status='ready',identity=?2 WHERE scope=?1 AND status='pending'",
                params![&scope.digest[..], identity],
            )
            .map_err(|_| "Cannot commit ownership scope")?;
        if updated != 1 {
            return Err("Ownership scope changed".into());
        }
        Ok(())
    }

    fn acquire(&self, scope: &Scope) -> Result<Guard, String> {
        let path = self.path(scope)?;
        self.check_registry()?;
        let identity: String = self
            .registry
            .lock()
            .map_err(|_| "Ownership registry unavailable")?
            .query_row(
                "SELECT identity FROM leases WHERE scope=?1 AND status='ready'",
                params![&scope.digest[..]],
                |row| row.get(0),
            )
            .map_err(|_| "Ownership scope missing or unconfirmed")?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Invalid ownership entry name")?;
        let file = Self::open_child(&self.directory, name, libc::O_RDWR, 0)?;
        self.check_file(&path, &file)?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership file")?;
        if identity != format!("{:016x}:{:016x}", metadata.dev(), metadata.ino()) {
            return Err("Ownership file identity changed".into());
        }
        let lease = Lease::acquire(file, scope)?;
        self.check_file(&path, &lease.locked.0)?;
        Ok(Guard {
            store: Store {
                root: self.root.clone(),
                root_file: self
                    .root_file
                    .try_clone()
                    .map_err(|_| "Cannot retain root")?,
                directory: self
                    .directory
                    .try_clone()
                    .map_err(|_| "Cannot retain directory")?,
                registry_file: self
                    .registry_file
                    .try_clone()
                    .map_err(|_| "Cannot retain ownership registry")?,
                registry: self.registry.clone(),
            },
            path,
            lease,
        })
    }
}

impl Guard {
    fn release_clean(self) -> Result<(), String> {
        self.store.check_registry()?;
        self.store.check_file(&self.path, &self.lease.locked.0)?;
        self.lease.release_clean()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::process::Command;

    const OWNER: &str = "fixture-owner";
    const SESSION: &str = "ss-0123456789abcdef0123456789abcdef";

    fn scope(root: &Path) -> Scope {
        Scope::new(root, OWNER, SESSION).unwrap()
    }

    #[test]
    fn provisioning_does_not_recreate_missing_or_invalid_existing_lease() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let scope = scope(root.path());
        store.provision(&scope).unwrap();
        assert!(store.provision(&scope).is_err());
        store.acquire(&scope).unwrap().release_clean().unwrap();
        let path = store.path(&scope).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(store.acquire(&scope).is_err());
        assert!(store.provision(&scope).is_err());
        let reopened = Store::open(root.path()).unwrap();
        assert!(reopened.provision(&scope).is_err());
        symlink(root.path(), &path).unwrap();
        assert!(store.acquire(&scope).is_err());
    }

    #[test]
    fn replacing_lock_while_held_cannot_release_a_clean_record() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let scope = scope(root.path());
        store.provision(&scope).unwrap();
        let guard = store.acquire(&scope).unwrap();
        let path = store.path(&scope).unwrap();
        std::fs::rename(&path, root.path().join("moved-lock")).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        assert!(guard.release_clean().is_err());
    }

    #[test]
    fn registry_rejects_byte_identical_replacement_of_clean_lease() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let scope = scope(root.path());
        store.provision(&scope).unwrap();
        let path = store.path(&scope).unwrap();
        let original = std::fs::read(&path).unwrap();
        std::fs::rename(&path, root.path().join("old-lease")).unwrap();
        let mut replacement = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        replacement.write_all(&original).unwrap();
        assert!(store.acquire(&scope).is_err());
    }

    #[test]
    fn existing_store_refuses_missing_or_symlinked_directory() {
        let root = tempfile::tempdir().unwrap();
        assert!(Store::open(root.path()).is_err());
        symlink(root.path(), root.path().join("structured-ownership")).unwrap();
        assert!(Store::open(root.path()).is_err());
    }

    #[test]
    fn relative_open_cannot_be_redirected_by_directory_replacement() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let directory = root.path().join("structured-ownership");
        let original = root.path().join("renamed-directory");
        std::fs::rename(&directory, &original).unwrap();
        std::fs::create_dir(&directory).unwrap();
        let _file = Store::open_child(
            &store.directory,
            "probe",
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .unwrap();
        assert!(original.join("probe").is_file());
        assert!(!directory.join("probe").exists());
    }

    #[test]
    fn abrupt_process_exit_keeps_existing_lease_uncertain() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let scope = scope(root.path());
        store.provision(&scope).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::tests::process_fixture",
                "--nocapture",
            ])
            .env("V4_PROVISION_ROOT", root.path())
            .env("V4_PROVISION_MODE", "crash")
            .status()
            .unwrap();
        assert!(status.success());
        assert!(Store::open(root.path()).unwrap().acquire(&scope).is_err());
    }

    #[test]
    fn interrupted_reservation_cannot_be_reprovisioned_after_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::tests::process_fixture",
                "--nocapture",
            ])
            .env("V4_PROVISION_ROOT", root.path())
            .env("V4_PROVISION_MODE", "pending")
            .status()
            .unwrap();
        assert!(status.success());
        let scope = scope(root.path());
        assert!(store.provision(&scope).is_err());
        let reopened = Store::open(root.path()).unwrap();
        assert!(reopened.acquire(&scope).is_err());
        assert!(reopened.provision(&scope).is_err());
    }

    #[test]
    fn another_process_cannot_take_an_active_provisioned_lease() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::create(root.path()).unwrap();
        let scope = scope(root.path());
        store.provision(&scope).unwrap();
        let guard = store.acquire(&scope).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::tests::process_fixture",
                "--nocapture",
            ])
            .env("V4_PROVISION_ROOT", root.path())
            .env("V4_PROVISION_MODE", "busy")
            .status()
            .unwrap();
        assert!(status.success());
        guard.release_clean().unwrap();
        store.acquire(&scope).unwrap().release_clean().unwrap();
    }

    #[test]
    fn process_fixture() {
        let Some(root) = std::env::var_os("V4_PROVISION_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let store = Store::open(&root).unwrap();
        let scope = scope(&root);
        let mode = std::env::var("V4_PROVISION_MODE").unwrap();
        if mode == "pending" {
            store
                .registry
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO leases(scope,status) VALUES (?1,'pending')",
                    params![&scope.digest[..]],
                )
                .unwrap();
            std::process::exit(0);
        }
        let result = store.acquire(&scope);
        if mode == "busy" {
            assert!(result.is_err());
            return;
        }
        let _guard = result.unwrap();
        std::process::exit(0);
    }
}
