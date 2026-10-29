//! Prototype for a scoped durable lease. This is not wired to session actors.
//! The caller must securely provision a persistent, non-replaceable lock file,
//! sync its directory entry, authenticate the owner, and confirm process cleanup
//! before clean release. A missing or lost file cannot establish a clean state.

use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
};

mod provision;

const MAGIC: &[u8; 8] = b"V4OWN001";
const RECORD_LEN: u64 = 41;
const CLEAN: u8 = 0;
const UNCERTAIN: u8 = 1;

#[derive(Clone)]
struct Scope {
    root: PathBuf,
    device: u64,
    inode: u64,
    owner: String,
    session: String,
    digest: [u8; 32],
}

struct LockedFile(File);
impl Drop for LockedFile {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

struct Lease {
    locked: LockedFile,
    scope: Scope,
}

impl Scope {
    fn new(root: &Path, owner: &str, session: &str) -> Result<Self, String> {
        if !root.is_absolute()
            || owner.trim().is_empty()
            || owner.len() > 256
            || owner.chars().any(char::is_control)
        {
            return Err("Invalid session ownership scope".into());
        }
        super::engine_session_id(session)?;
        let root = root
            .canonicalize()
            .map_err(|_| "Ownership root unavailable")?;
        let metadata =
            std::fs::symlink_metadata(&root).map_err(|_| "Ownership root unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Invalid ownership root".into());
        }
        let device = metadata.dev();
        let inode = metadata.ino();
        let mut hash = Sha256::new();
        for value in [
            root.as_os_str().as_bytes(),
            owner.as_bytes(),
            session.as_bytes(),
        ] {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
        hash.update(device.to_be_bytes());
        hash.update(inode.to_be_bytes());
        Ok(Self {
            root,
            device,
            inode,
            owner: owner.to_owned(),
            session: session.to_owned(),
            digest: hash.finalize().into(),
        })
    }

    fn validate_root(&self) -> Result<(), String> {
        let metadata =
            std::fs::symlink_metadata(&self.root).map_err(|_| "Ownership root unavailable")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.dev(), metadata.ino()) != (self.device, self.inode)
            || self.root.canonicalize().ok().as_ref() != Some(&self.root)
        {
            return Err("Ownership root changed".into());
        }
        Ok(())
    }
}

impl Lease {
    fn lock(file: File) -> Result<LockedFile, String> {
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership lease")?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err("Unsafe ownership lease file".into());
        }
        file.try_lock()
            .map_err(|_| "Session ownership is unavailable")?;
        Ok(LockedFile(file))
    }

    fn initialize(file: File, scope: &Scope) -> Result<(), String> {
        scope.validate_root()?;
        let mut locked = Self::lock(file)?;
        if locked
            .0
            .metadata()
            .map_err(|_| "Cannot inspect ownership lease")?
            .len()
            != 0
        {
            return Err("Ownership lease already initialized".into());
        }
        scope.validate_root()?;
        locked
            .0
            .write_all(MAGIC)
            .and_then(|_| locked.0.write_all(&scope.digest))
            .and_then(|_| locked.0.write_all(&[CLEAN]))
            .and_then(|_| locked.0.sync_all())
            .map_err(|_| "Cannot initialize ownership lease")?;
        Ok(())
    }

    fn read_state(file: &mut File, scope: &Scope) -> Result<u8, String> {
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership lease")?;
        if metadata.len() != RECORD_LEN || metadata.nlink() != 1 {
            return Err("Ownership lease is missing or invalid".into());
        }
        let mut record = [0u8; RECORD_LEN as usize];
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.read_exact(&mut record))
            .map_err(|_| "Cannot read ownership lease")?;
        if &record[..8] != MAGIC
            || record[8..40] != scope.digest
            || !matches!(record[40], CLEAN | UNCERTAIN)
        {
            return Err("Ownership lease identity or state is invalid".into());
        }
        Ok(record[40])
    }

    fn write_state(file: &mut File, state: u8) -> Result<(), String> {
        file.seek(SeekFrom::Start(40))
            .and_then(|_| file.write_all(&[state]))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist ownership lease".into())
    }

    fn acquire(file: File, scope: &Scope) -> Result<Self, String> {
        scope.validate_root()?;
        let mut locked = Self::lock(file)?;
        scope.validate_root()?;
        if Self::read_state(&mut locked.0, scope)? != CLEAN {
            return Err("Previous session ownership is unconfirmed".into());
        }
        Self::write_state(&mut locked.0, UNCERTAIN)?;
        scope.validate_root()?;
        Ok(Self {
            locked,
            scope: scope.clone(),
        })
    }

    fn release_clean(mut self) -> Result<(), String> {
        self.scope.validate_root()?;
        if Self::read_state(&mut self.locked.0, &self.scope)? != UNCERTAIN {
            return Err("Ownership lease state changed".into());
        }
        Self::write_state(&mut self.locked.0, CLEAN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::process::Command;

    const OWNER: &str = "fixture-owner";
    const SESSION: &str = "ss-0123456789abcdef0123456789abcdef";

    fn scope(root: &Path) -> Scope {
        Scope::new(root, OWNER, SESSION).unwrap()
    }
    fn create(path: &Path) -> File {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap()
    }
    fn open(path: &Path) -> File {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap()
    }

    #[test]
    fn scoped_lease_requires_explicit_clean_release_and_exact_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.lock");
        let expected = scope(root.path());
        Lease::initialize(create(&path), &expected).unwrap();
        let lease = Lease::acquire(open(&path), &expected).unwrap();
        assert!(Lease::acquire(open(&path), &expected).is_err());
        lease.release_clean().unwrap();
        let foreign = Scope::new(root.path(), "other-owner", SESSION).unwrap();
        assert!(Lease::acquire(open(&path), &foreign).is_err());
        let different_id = Scope::new(
            root.path(),
            OWNER,
            "ss-01234567-89ab-cdef-0123-456789abcdef",
        )
        .unwrap();
        assert!(Lease::acquire(open(&path), &different_id).is_err());
        let uppercase_id =
            Scope::new(root.path(), OWNER, "ss-0123456789ABCDEF0123456789ABCDEF").unwrap();
        assert!(Lease::acquire(open(&path), &uppercase_id).is_err());
        let lease = Lease::acquire(open(&path), &expected).unwrap();
        drop(lease);
        assert!(Lease::acquire(open(&path), &expected).is_err());
    }

    #[test]
    fn replaced_root_and_invalid_records_fail_closed() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("data");
        std::fs::create_dir(&root).unwrap();
        let expected = scope(&root);
        let path = parent.path().join("session.lock");
        Lease::initialize(create(&path), &expected).unwrap();
        std::fs::rename(&root, parent.path().join("old-data")).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert!(Lease::acquire(open(&path), &expected).is_err());
        let current = scope(&root);
        std::fs::write(&path, b"bad record").unwrap();
        assert!(Lease::acquire(open(&path), &current).is_err());
    }

    #[test]
    fn unlinked_lease_cannot_be_cleanly_released() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.lock");
        let expected = scope(root.path());
        Lease::initialize(create(&path), &expected).unwrap();
        let lease = Lease::acquire(open(&path), &expected).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(lease.release_clean().is_err());
    }

    #[test]
    fn permissive_lock_file_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.lock");
        let file = create(&path);
        file.set_permissions(std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(Lease::initialize(file, &scope(root.path())).is_err());
    }

    #[test]
    fn separate_processes_cannot_share_a_lease_and_crash_requires_recovery() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.lock");
        let expected = scope(root.path());
        Lease::initialize(create(&path), &expected).unwrap();
        let held = Lease::acquire(open(&path), &expected).unwrap();
        let run = |mode: &str| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "structured::ownership::tests::process_fixture",
                    "--nocapture",
                ])
                .env("V4_OWNERSHIP_FIXTURE", mode)
                .env("V4_OWNERSHIP_ROOT", root.path())
                .env("V4_OWNERSHIP_FILE", &path)
                .status()
                .unwrap()
        };
        assert!(run("expect-busy").success());
        held.release_clean().unwrap();
        assert!(run("crash").success());
        assert!(Lease::acquire(open(&path), &expected).is_err());
    }

    #[test]
    fn process_fixture() {
        let Ok(mode) = std::env::var("V4_OWNERSHIP_FIXTURE") else {
            return;
        };
        let root = PathBuf::from(std::env::var_os("V4_OWNERSHIP_ROOT").unwrap());
        let path = PathBuf::from(std::env::var_os("V4_OWNERSHIP_FILE").unwrap());
        let result = Lease::acquire(open(&path), &scope(&root));
        if mode == "expect-busy" {
            assert!(result.is_err());
            return;
        }
        let _lease = result.unwrap();
        std::process::exit(0);
    }
}
