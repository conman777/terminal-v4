//! Experimental descriptor-relative enrollment journal, not connected to the
//! structured runtime. The expected inode and the verified durable history
//! generation must come from an independently trusted lifecycle boundary.

use super::Store;
use crate::structured::ownership::{Lease, Scope, MAGIC as LEASE_MAGIC, UNCERTAIN};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::CString,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

mod anchor;
mod existing;

const MAGIC: &[u8; 8] = b"V4ENR001";
const HEADER_SIZE: usize = 48;
const ENTRY_SIZE: usize = 81;
const MAX_ENTRIES: usize = 4096;
const NAME: &str = "enrollment.registry";

#[derive(Clone, Copy, Eq, PartialEq, Debug)]
struct Identity {
    device: u64,
    inode: u64,
}
#[derive(Clone, Copy, Eq, PartialEq, Debug)]
struct Enrollment {
    scope: [u8; 32],
    generation: [u8; 16],
}

#[derive(Clone, Copy)]
struct EnrollmentState {
    generation: [u8; 16],
    committed: bool,
    lease: Option<Identity>,
}

struct Root {
    root: PathBuf,
    root_file: File,
    directory: File,
    anchor: Option<anchor::Marker>,
}

impl Root {
    fn create(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "Cannot resolve ownership root")?;
        let root_file = Store::open_directory(&root)?;
        Store::check_directory(&root, &root_file, false)?;
        let name = CString::new("structured-ownership").unwrap();
        if unsafe { libc::mkdirat(root_file.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err("Cannot create ownership directory".into());
        }
        root_file
            .sync_all()
            .map_err(|_| "Cannot sync ownership root")?;
        let opened = Self::open(&root)?;
        let before = root_file
            .metadata()
            .map_err(|_| "Cannot inspect ownership root")?;
        let after = opened
            .root_file
            .metadata()
            .map_err(|_| "Cannot inspect ownership root")?;
        if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
            return Err("Ownership root changed".into());
        }
        Ok(opened)
    }

    fn open(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "Cannot resolve ownership root")?;
        let root_file = Store::open_directory(&root)?;
        let directory = Store::open_child(
            &root_file,
            "structured-ownership",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        let opened = Self {
            root,
            root_file,
            directory,
            anchor: None,
        };
        opened.validate()?;
        Ok(opened)
    }

    fn validate(&self) -> Result<(), String> {
        if self.root.canonicalize().ok().as_ref() != Some(&self.root) {
            return Err("Ownership root changed".into());
        }
        Store::check_directory(&self.root, &self.root_file, false)?;
        Store::check_directory(
            &self.root.join("structured-ownership"),
            &self.directory,
            true,
        )?;
        if let Some(anchor) = &self.anchor {
            anchor.verify(self)?;
        }
        Ok(())
    }

    fn check_file(&self, path: &Path, file: &File) -> Result<(), String> {
        self.validate()?;
        let opened = file
            .metadata()
            .map_err(|_| "Cannot inspect enrollment journal")?;
        let current =
            std::fs::symlink_metadata(path).map_err(|_| "Enrollment journal unavailable")?;
        if !opened.is_file()
            || !current.is_file()
            || current.file_type().is_symlink()
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || opened.nlink() != 1
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Enrollment journal changed".into());
        }
        Ok(())
    }
}

struct Journal {
    store: Arc<Root>,
    file: Mutex<File>,
    identity: Identity,
}

struct BoundLease {
    journal: Arc<Journal>,
    scope: Scope,
    generation: [u8; 16],
    identity: Identity,
    lease: Lease,
}

impl BoundLease {
    fn release_after_cleanup(self) -> Result<(), String> {
        let path = self.journal.lease_path(&self.scope);
        self.journal.store.check_file(&path, &self.lease.locked.0)?;
        let identity = self.journal.bound_identity(&self.scope, self.generation)?;
        if identity != self.identity {
            return Err("Ownership binding changed".into());
        }
        self.lease.release_clean()
    }
}

impl Journal {
    fn create(store: &Arc<Root>) -> Result<(Arc<Self>, Identity), String> {
        store.validate()?;
        let mut file = Store::open_child(
            &store.directory,
            NAME,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        file.try_lock().map_err(|_| "Enrollment journal busy")?;
        store.check_file(&store.root.join("structured-ownership").join(NAME), &file)?;
        file.write_all(&Self::header(0))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot initialize enrollment journal")?;
        store
            .directory
            .sync_all()
            .map_err(|_| "Cannot sync enrollment directory")?;
        store.check_file(&store.root.join("structured-ownership").join(NAME), &file)?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect enrollment journal")?;
        let identity = Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        file.unlock()
            .map_err(|_| "Cannot unlock enrollment journal")?;
        Ok((
            Arc::new(Self {
                store: Arc::clone(store),
                file: Mutex::new(file),
                identity,
            }),
            identity,
        ))
    }

    fn open(store: &Arc<Root>, identity: Identity) -> Result<Arc<Self>, String> {
        store.validate()?;
        let file = Store::open_child(&store.directory, NAME, libc::O_RDWR, 0)?;
        let journal = Arc::new(Self {
            store: Arc::clone(store),
            file: Mutex::new(file),
            identity,
        });
        journal.with_entries(|_, _| Ok(()))?;
        Ok(journal)
    }

    fn validate_scope(&self, scope: &Scope, generation: [u8; 16]) -> Result<(), String> {
        self.store.validate()?;
        scope.validate_root()?;
        if scope.root != self.store.root || generation == [0; 16] {
            return Err("Invalid enrollment scope or generation".into());
        }
        Ok(())
    }

    fn with_entries<T>(
        &self,
        operation: impl FnOnce(&mut File, &HashMap<[u8; 32], EnrollmentState>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| "Enrollment journal unavailable")?;
        file.try_lock().map_err(|_| "Enrollment journal busy")?;
        let result = (|| {
            let path = self.store.root.join("structured-ownership").join(NAME);
            self.store.check_file(&path, &file)?;
            let metadata = file
                .metadata()
                .map_err(|_| "Cannot inspect enrollment journal")?;
            if (metadata.dev(), metadata.ino()) != (self.identity.device, self.identity.inode)
                || metadata.len() > (HEADER_SIZE + ENTRY_SIZE * MAX_ENTRIES) as u64
            {
                return Err("Enrollment journal identity or size invalid".into());
            }
            let mut bytes = Vec::new();
            file.seek(SeekFrom::Start(0))
                .and_then(|_| {
                    (&mut *file)
                        .take((HEADER_SIZE + ENTRY_SIZE * MAX_ENTRIES + 1) as u64)
                        .read_to_end(&mut bytes)
                })
                .map_err(|_| "Cannot read enrollment journal")?;
            if bytes.len() < HEADER_SIZE
                || &bytes[..MAGIC.len()] != MAGIC
                || bytes.len() > HEADER_SIZE + ENTRY_SIZE * MAX_ENTRIES
                || Sha256::digest(&bytes[..16])[..] != bytes[16..HEADER_SIZE]
            {
                return Err("Invalid enrollment journal".into());
            }
            let declared = u64::from_be_bytes(bytes[8..16].try_into().unwrap());
            if declared > MAX_ENTRIES as u64
                || bytes.len() != HEADER_SIZE + declared as usize * ENTRY_SIZE
            {
                return Err("Incomplete enrollment journal".into());
            }
            if let Some(anchor) = &self.store.anchor {
                if anchor.count(&self.store)? != declared {
                    return Err("Ownership anchor sequence mismatch".into());
                }
            }
            let mut entries = HashMap::new();
            for record in bytes[HEADER_SIZE..].chunks_exact(ENTRY_SIZE) {
                if Sha256::digest(&record[..49])[..] != record[49..] {
                    return Err("Invalid enrollment record checksum".into());
                }
                let scope: [u8; 32] = record[1..33].try_into().unwrap();
                let payload: [u8; 16] = record[33..49].try_into().unwrap();
                if payload == [0; 16] {
                    return Err("Invalid enrollment generation".into());
                }
                match record[0] {
                    1 if !entries.contains_key(&scope) => {
                        entries.insert(
                            scope,
                            EnrollmentState {
                                generation: payload,
                                committed: false,
                                lease: None,
                            },
                        );
                    }
                    2 if entries.get(&scope).is_some_and(|state: &EnrollmentState| {
                        state.generation == payload && !state.committed
                    }) =>
                    {
                        entries.get_mut(&scope).unwrap().committed = true;
                    }
                    3 if entries
                        .get(&scope)
                        .is_some_and(|state| state.committed && state.lease.is_none()) =>
                    {
                        entries.get_mut(&scope).unwrap().lease = Some(Identity {
                            device: u64::from_be_bytes(payload[..8].try_into().unwrap()),
                            inode: u64::from_be_bytes(payload[8..].try_into().unwrap()),
                        });
                    }
                    _ => return Err("Invalid enrollment sequence".into()),
                }
            }
            let value = operation(&mut file, &entries)?;
            self.store.check_file(&path, &file)?;
            Ok(value)
        })();
        file.unlock()
            .map_err(|_| "Cannot unlock enrollment journal")?;
        result
    }

    fn header(count: u64) -> [u8; HEADER_SIZE] {
        let mut header = [0u8; HEADER_SIZE];
        header[..MAGIC.len()].copy_from_slice(MAGIC);
        header[8..16].copy_from_slice(&count.to_be_bytes());
        let checksum = Sha256::digest(&header[..16]);
        header[16..].copy_from_slice(&checksum);
        header
    }

    fn append(
        &self,
        file: &mut File,
        kind: u8,
        scope: [u8; 32],
        generation: [u8; 16],
    ) -> Result<(), String> {
        let length = file
            .metadata()
            .map_err(|_| "Cannot inspect enrollment journal")?
            .len();
        if length < HEADER_SIZE as u64
            || length >= (HEADER_SIZE + ENTRY_SIZE * MAX_ENTRIES) as u64
            || (length - HEADER_SIZE as u64) % ENTRY_SIZE as u64 != 0
        {
            return Err("Enrollment journal is full".into());
        }
        let count = (length - HEADER_SIZE as u64) / ENTRY_SIZE as u64;
        let mut record = [0u8; ENTRY_SIZE];
        record[0] = kind;
        record[1..33].copy_from_slice(&scope);
        record[33..49].copy_from_slice(&generation);
        let checksum = Sha256::digest(&record[..49]);
        record[49..].copy_from_slice(&checksum);
        if let Some(anchor) = &self.store.anchor {
            anchor.advance(&self.store, count)?;
        }
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(&Self::header(count + 1)))
            .and_then(|_| file.sync_all())
            .and_then(|_| file.seek(SeekFrom::End(0)))
            .and_then(|_| file.write_all(&record))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist enrollment".into())
    }

    fn reserve(&self, scope: &Scope, generation: [u8; 16]) -> Result<(), String> {
        self.validate_scope(scope, generation)?;
        self.with_entries(|file, entries| {
            if entries.contains_key(&scope.digest) {
                return Err("Session already enrolled or reserved".into());
            }
            let length = usize::try_from(
                file.metadata()
                    .map_err(|_| "Cannot inspect enrollment journal")?
                    .len(),
            )
            .map_err(|_| "Invalid enrollment journal size")?;
            let body = length
                .checked_sub(HEADER_SIZE)
                .ok_or("Invalid enrollment journal size")?;
            if body % ENTRY_SIZE != 0 || body / ENTRY_SIZE > MAX_ENTRIES {
                return Err("Invalid enrollment journal size".into());
            }
            let used = body / ENTRY_SIZE;
            let outstanding: usize = entries
                .values()
                .map(|entry| {
                    if !entry.committed {
                        2
                    } else if entry.lease.is_none() {
                        1
                    } else {
                        0
                    }
                })
                .sum();
            if MAX_ENTRIES - used < outstanding + 3 {
                return Err("Enrollment journal is full".into());
            }
            self.append(file, 1, scope.digest, generation)
        })
    }

    fn commit(
        &self,
        scope: &Scope,
        generation: [u8; 16],
        verify: impl FnOnce(Enrollment) -> bool,
    ) -> Result<(), String> {
        self.validate_scope(scope, generation)?;
        self.with_entries(|file, entries| {
            let Some(state) = entries.get(&scope.digest) else {
                return Err("Enrollment reservation mismatch".into());
            };
            if state.generation != generation {
                return Err("Enrollment reservation mismatch".into());
            }
            if !verify(Enrollment {
                scope: scope.digest,
                generation,
            }) {
                return Err("Durable session history not confirmed".into());
            }
            if state.committed {
                return Ok(());
            }
            self.append(file, 2, scope.digest, generation)
        })
    }

    fn contains(&self, scope: &Scope, generation: [u8; 16]) -> Result<bool, String> {
        self.validate_scope(scope, generation)?;
        self.with_entries(|_, entries| {
            Ok(entries
                .get(&scope.digest)
                .is_some_and(|state| state.generation == generation && state.committed))
        })
    }

    fn commit_history(&self, scope: &Scope, generation: [u8; 16]) -> Result<(), String> {
        self.commit(scope, generation, |_| {
            self.verify_history(scope, generation).is_ok()
        })
    }

    fn lease_path(&self, scope: &Scope) -> PathBuf {
        self.store
            .root
            .join("structured-ownership")
            .join(format!("{}.lease", hex::encode(scope.digest)))
    }

    fn bound_identity(&self, scope: &Scope, generation: [u8; 16]) -> Result<Identity, String> {
        self.validate_scope(scope, generation)?;
        self.with_entries(|_, entries| {
            let state = entries
                .get(&scope.digest)
                .ok_or("Session enrollment missing")?;
            if state.generation != generation || !state.committed {
                return Err("Session enrollment mismatch".into());
            }
            state
                .lease
                .ok_or("Session ownership binding missing".into())
        })
    }

    fn bind_lease(
        self: &Arc<Self>,
        scope: &Scope,
        generation: [u8; 16],
    ) -> Result<BoundLease, String> {
        self.validate_scope(scope, generation)?;
        self.with_entries(|_, entries| {
            let state = entries
                .get(&scope.digest)
                .ok_or("Session enrollment missing")?;
            if state.generation != generation || !state.committed || state.lease.is_some() {
                return Err("Session ownership cannot be bound".into());
            }
            Ok(())
        })?;
        self.verify_history(scope, generation)?;
        let path = self.lease_path(scope);
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Invalid lease name")?;
        let file = Store::open_child(
            &self.store.directory,
            name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let mut locked = Lease::lock(file)?;
        self.store.check_file(&path, &locked.0)?;
        locked
            .0
            .write_all(LEASE_MAGIC)
            .and_then(|_| locked.0.write_all(&scope.digest))
            .and_then(|_| locked.0.write_all(&[UNCERTAIN]))
            .and_then(|_| locked.0.sync_all())
            .map_err(|_| "Cannot persist session ownership")?;
        self.store
            .directory
            .sync_all()
            .map_err(|_| "Cannot sync ownership directory")?;
        self.store.check_file(&path, &locked.0)?;
        let metadata = locked
            .0
            .metadata()
            .map_err(|_| "Cannot inspect session ownership")?;
        let identity = Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        let mut payload = [0u8; 16];
        payload[..8].copy_from_slice(&identity.device.to_be_bytes());
        payload[8..].copy_from_slice(&identity.inode.to_be_bytes());
        if payload == [0; 16] {
            return Err("Invalid ownership inode".into());
        }
        self.with_entries(|file, entries| {
            let state = entries
                .get(&scope.digest)
                .ok_or("Session enrollment missing")?;
            if state.generation != generation || !state.committed || state.lease.is_some() {
                return Err("Session ownership cannot be bound".into());
            }
            self.store.check_file(&path, &locked.0)?;
            self.verify_history(scope, generation)?;
            self.append(file, 3, scope.digest, payload)
        })?;
        Ok(BoundLease {
            journal: Arc::clone(self),
            scope: scope.clone(),
            generation,
            identity,
            lease: Lease {
                locked,
                scope: scope.clone(),
            },
        })
    }

    fn acquire_lease(
        self: &Arc<Self>,
        scope: &Scope,
        generation: [u8; 16],
    ) -> Result<BoundLease, String> {
        let identity = self.bound_identity(scope, generation)?;
        let path = self.lease_path(scope);
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Invalid lease name")?;
        let file = Store::open_child(&self.store.directory, name, libc::O_RDWR, 0)?;
        self.store.check_file(&path, &file)?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect session ownership")?;
        if (metadata.dev(), metadata.ino()) != (identity.device, identity.inode) {
            return Err("Session ownership inode changed".into());
        }
        let lease = Lease::acquire(file, scope)?;
        self.store.check_file(&path, &lease.locked.0)?;
        self.with_entries(|_, entries| {
            let state = entries
                .get(&scope.digest)
                .ok_or("Session enrollment missing")?;
            if state.generation != generation || !state.committed || state.lease != Some(identity) {
                return Err("Session ownership binding changed".into());
            }
            self.verify_history(scope, generation)
        })?;
        Ok(BoundLease {
            journal: Arc::clone(self),
            scope: scope.clone(),
            generation,
            identity,
            lease,
        })
    }

    fn verify_history(&self, scope: &Scope, generation: [u8; 16]) -> Result<(), String> {
        self.validate_scope(scope, generation)?;
        let root_path = &self.store.root;
        let sessions_path = root_path.join("structured-sessions");
        let sessions = Store::open_child(
            &self.store.root_file,
            "structured-sessions",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        Store::check_directory(&sessions_path, &sessions, false)?;
        let owner_name = hex::encode(Sha256::digest(scope.owner.as_bytes()));
        let owner_path = sessions_path.join(&owner_name);
        let owner = Store::open_child(
            &sessions,
            &owner_name,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        Store::check_directory(&owner_path, &owner, true)?;
        let file_name = format!("{}.json", scope.session);
        let file_path = owner_path.join(&file_name);
        let file = Store::open_child(&owner, &file_name, libc::O_RDONLY, 0)?;
        let before = file
            .metadata()
            .map_err(|_| "Cannot inspect session history")?;
        let check_file = || -> Result<(), String> {
            let current =
                std::fs::symlink_metadata(&file_path).map_err(|_| "Session history unavailable")?;
            if !before.is_file()
                || !current.is_file()
                || current.file_type().is_symlink()
                || before.uid() != unsafe { libc::geteuid() }
                || before.mode() & 0o077 != 0
                || current.uid() != unsafe { libc::geteuid() }
                || current.mode() & 0o077 != 0
                || before.nlink() != 1
                || current.nlink() != 1
                || (before.dev(), before.ino()) != (current.dev(), current.ino())
            {
                return Err("Session history identity is unsafe".into());
            }
            Ok(())
        };
        check_file()?;
        if before.len() > crate::structured::MAX_STRUCTURED_FILE_BYTES as u64 {
            return Err("Session history exceeds its limit".into());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(crate::structured::MAX_STRUCTURED_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read session history")?;
        let stored = crate::structured::storage::decode(&bytes)?;
        if stored.owner_id != scope.owner
            || stored.snapshot.id != scope.session
            || stored.session_incarnation
                != Some(crate::structured::SessionIncarnation(
                    uuid::Uuid::from_bytes(generation),
                ))
        {
            return Err("Session history binding mismatch".into());
        }
        file.sync_all().map_err(|_| "Cannot sync session history")?;
        owner
            .sync_all()
            .map_err(|_| "Cannot sync session directory")?;
        sessions
            .sync_all()
            .map_err(|_| "Cannot sync structured directory")?;
        self.store
            .root_file
            .sync_all()
            .map_err(|_| "Cannot sync data root")?;
        let after = file
            .metadata()
            .map_err(|_| "Cannot inspect session history")?;
        if (
            before.dev(),
            before.ino(),
            before.len(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.dev(),
            after.ino(),
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ) {
            return Err("Session history changed during verification".into());
        }
        self.store.validate()?;
        Store::check_directory(&sessions_path, &sessions, false)?;
        Store::check_directory(&owner_path, &owner, true)?;
        check_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, process::Command};

    const OWNER: &str = "test-owner";
    const SESSION: &str = "ss-0123456789abcdef0123456789abcdef";
    const GENERATION: [u8; 16] = [23; 16];

    fn scope(root: &std::path::Path) -> Scope {
        Scope::new(root, OWNER, SESSION).unwrap()
    }

    #[tokio::test]
    async fn enrollment_verifies_real_owner_bound_history_and_incarnation() {
        use crate::structured::{storage, StructuredSessionManager};
        let root = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                OWNER,
                root.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let history_path =
            crate::structured::structured_session_path(&manager.inner.config, OWNER, &session.id);
        let original = std::fs::read(&history_path).unwrap();
        let stored = storage::decode(&original).unwrap();
        let generation = *stored.session_incarnation.unwrap().0.as_bytes();
        let scope = Scope::new(root.path(), OWNER, &session.id).unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, generation).unwrap();
        let mut checkpoint: serde_json::Value = serde_json::from_slice(&original).unwrap();
        checkpoint
            .as_object_mut()
            .unwrap()
            .remove("sessionIncarnation");
        let mut missing = serde_json::to_vec(&checkpoint).unwrap();
        missing.push(b'\n');
        std::fs::write(&history_path, missing).unwrap();
        assert!(journal.commit_history(&scope, generation).is_err());
        std::fs::write(&history_path, &original).unwrap();
        assert!(journal.commit_history(&scope, [9; 16]).is_err());
        let relocated = root.path().join("relocated-history");
        std::fs::rename(&history_path, &relocated).unwrap();
        std::os::unix::fs::symlink(&relocated, &history_path).unwrap();
        assert!(journal.commit_history(&scope, generation).is_err());
        std::fs::remove_file(&history_path).unwrap();
        std::fs::rename(&relocated, &history_path).unwrap();

        let wrong_id = "ss-ffffffffffffffffffffffffffffffff";
        let wrong_path =
            crate::structured::structured_session_path(&manager.inner.config, OWNER, wrong_id);
        std::fs::copy(&history_path, &wrong_path).unwrap();
        let wrong_scope = Scope::new(root.path(), OWNER, wrong_id).unwrap();
        journal.reserve(&wrong_scope, generation).unwrap();
        assert!(journal.commit_history(&wrong_scope, generation).is_err());

        let foreign = "other-owner";
        let foreign_path =
            crate::structured::structured_session_path(&manager.inner.config, foreign, &session.id);
        std::fs::create_dir_all(foreign_path.parent().unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            foreign_path.parent().unwrap(),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::copy(&history_path, &foreign_path).unwrap();
        let foreign_scope = Scope::new(root.path(), foreign, &session.id).unwrap();
        journal.reserve(&foreign_scope, generation).unwrap();
        assert!(journal.commit_history(&foreign_scope, generation).is_err());

        journal.commit_history(&scope, generation).unwrap();
        assert!(Journal::open(&store, identity)
            .unwrap()
            .contains(&scope, generation)
            .unwrap());
    }

    #[tokio::test]
    async fn child_process_commits_actual_history_and_restart_observes_it() {
        use crate::structured::{storage, StructuredSessionManager};
        let root = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                OWNER,
                root.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let path =
            crate::structured::structured_session_path(&manager.inner.config, OWNER, &session.id);
        let generation = *storage::decode(&std::fs::read(path).unwrap())
            .unwrap()
            .session_incarnation
            .unwrap()
            .0
            .as_bytes();
        let scope = Scope::new(root.path(), OWNER, &session.id).unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, generation).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::enrollment::tests::history_process_fixture",
                "--nocapture",
            ])
            .env("V4_ENROLL_HISTORY_ROOT", root.path())
            .env("V4_ENROLL_HISTORY_SESSION", &session.id)
            .env("V4_ENROLL_HISTORY_GENERATION", hex::encode(generation))
            .env("V4_ENROLL_HISTORY_DEVICE", identity.device.to_string())
            .env("V4_ENROLL_HISTORY_INODE", identity.inode.to_string())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(Journal::open(&store, identity)
            .unwrap()
            .contains(&scope, generation)
            .unwrap());
    }

    #[tokio::test]
    async fn bound_lease_rejects_replacement_and_requires_clean_release() {
        use crate::structured::{storage, StructuredSessionManager};
        let root = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                OWNER,
                root.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let path =
            crate::structured::structured_session_path(&manager.inner.config, OWNER, &session.id);
        let generation = *storage::decode(&std::fs::read(path).unwrap())
            .unwrap()
            .session_incarnation
            .unwrap()
            .0
            .as_bytes();
        let scope = Scope::new(root.path(), OWNER, &session.id).unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, generation).unwrap();
        journal.commit_history(&scope, generation).unwrap();
        let guard = journal.bind_lease(&scope, generation).unwrap();
        assert!(Journal::open(&store, identity)
            .unwrap()
            .acquire_lease(&scope, generation)
            .is_err());
        tokio::spawn(async move { guard.release_after_cleanup() })
            .await
            .unwrap()
            .unwrap();
        let reopened = Journal::open(&store, identity).unwrap();
        reopened
            .acquire_lease(&scope, generation)
            .unwrap()
            .release_after_cleanup()
            .unwrap();
        let lease_path = root
            .path()
            .join("structured-ownership")
            .join(format!("{}.lease", hex::encode(scope.digest)));
        let bytes = std::fs::read(&lease_path).unwrap();
        std::fs::rename(&lease_path, root.path().join("old-lease")).unwrap();
        let mut replacement = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&lease_path)
            .unwrap();
        replacement.write_all(&bytes).unwrap();
        assert!(reopened.acquire_lease(&scope, generation).is_err());
    }

    #[tokio::test]
    async fn bound_lease_blocks_another_process_and_crash_prevents_takeover() {
        use crate::structured::{storage, StructuredSessionManager};
        let root = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                OWNER,
                root.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let path =
            crate::structured::structured_session_path(&manager.inner.config, OWNER, &session.id);
        let generation = *storage::decode(&std::fs::read(path).unwrap())
            .unwrap()
            .session_incarnation
            .unwrap()
            .0
            .as_bytes();
        let scope = Scope::new(root.path(), OWNER, &session.id).unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, generation).unwrap();
        journal.commit_history(&scope, generation).unwrap();
        let guard = journal.bind_lease(&scope, generation).unwrap();
        let child = |mode: &str| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "structured::ownership::provision::enrollment::tests::lease_process_fixture",
                    "--nocapture",
                ])
                .env("V4_BOUND_ROOT", root.path())
                .env("V4_BOUND_SESSION", &session.id)
                .env("V4_BOUND_GENERATION", hex::encode(generation))
                .env("V4_BOUND_DEVICE", identity.device.to_string())
                .env("V4_BOUND_INODE", identity.inode.to_string())
                .env("V4_BOUND_MODE", mode)
                .status()
                .unwrap()
        };
        assert!(child("busy").success());
        guard.release_after_cleanup().unwrap();
        assert!(child("crash").success());
        assert!(Journal::open(&store, identity)
            .unwrap()
            .acquire_lease(&scope, generation)
            .is_err());
    }

    #[test]
    fn lease_process_fixture() {
        let Some(root) = std::env::var_os("V4_BOUND_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let session = std::env::var("V4_BOUND_SESSION").unwrap();
        let generation: [u8; 16] = hex::decode(std::env::var("V4_BOUND_GENERATION").unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let identity = Identity {
            device: std::env::var("V4_BOUND_DEVICE").unwrap().parse().unwrap(),
            inode: std::env::var("V4_BOUND_INODE").unwrap().parse().unwrap(),
        };
        let store = Arc::new(Root::open(&root).unwrap());
        let journal = Journal::open(&store, identity).unwrap();
        let scope = Scope::new(&root, OWNER, &session).unwrap();
        let result = journal.acquire_lease(&scope, generation);
        if std::env::var("V4_BOUND_MODE").unwrap() == "busy" {
            assert!(result.is_err());
            return;
        }
        let _lease = result.unwrap();
        std::process::exit(0);
    }

    #[test]
    fn history_process_fixture() {
        let Some(root) = std::env::var_os("V4_ENROLL_HISTORY_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let session = std::env::var("V4_ENROLL_HISTORY_SESSION").unwrap();
        let generation: [u8; 16] =
            hex::decode(std::env::var("V4_ENROLL_HISTORY_GENERATION").unwrap())
                .unwrap()
                .try_into()
                .unwrap();
        let identity = Identity {
            device: std::env::var("V4_ENROLL_HISTORY_DEVICE")
                .unwrap()
                .parse()
                .unwrap(),
            inode: std::env::var("V4_ENROLL_HISTORY_INODE")
                .unwrap()
                .parse()
                .unwrap(),
        };
        let store = Arc::new(Root::open(&root).unwrap());
        Journal::open(&store, identity)
            .unwrap()
            .commit_history(&Scope::new(&root, OWNER, &session).unwrap(), generation)
            .unwrap();
        std::process::exit(0);
    }

    #[test]
    fn enrollment_requires_matching_verified_durable_history() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let scope = scope(root.path());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, GENERATION).unwrap();
        assert!(!journal.contains(&scope, GENERATION).unwrap());
        assert!(journal.commit(&scope, GENERATION, |_| false).is_err());
        assert!(journal.commit(&scope, [4; 16], |_| true).is_err());
        let history_path = root.path().join("history");
        let mut history = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&history_path)
            .unwrap();
        history.write_all(&GENERATION).unwrap();
        history.sync_all().unwrap();
        std::fs::File::open(root.path())
            .unwrap()
            .sync_all()
            .unwrap();
        journal
            .commit(&scope, GENERATION, |entry| {
                std::fs::read(&history_path).unwrap() == entry.generation
            })
            .unwrap();
        let reopened = Journal::open(&store, identity).unwrap();
        assert!(reopened.contains(&scope, GENERATION).unwrap());
        let journal_path = root.path().join("structured-ownership/enrollment.registry");
        let length = std::fs::metadata(&journal_path).unwrap().len();
        reopened
            .commit(&scope, GENERATION, |entry| {
                std::fs::read(&history_path).unwrap() == entry.generation
            })
            .unwrap();
        assert_eq!(std::fs::metadata(&journal_path).unwrap().len(), length);
        assert!(!reopened.contains(&scope, [4; 16]).unwrap());
        assert!(reopened.reserve(&scope, GENERATION).is_err());
    }

    #[test]
    fn replaced_and_torn_journal_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let scope = scope(root.path());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, GENERATION).unwrap();
        let path = root.path().join("structured-ownership/enrollment.registry");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"torn")
            .unwrap();
        assert!(journal.contains(&scope, GENERATION).is_err());
        assert!(Journal::open(&store, identity).is_err());
        std::fs::rename(&path, root.path().join("old-registry")).unwrap();
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        assert!(Journal::open(&store, identity).is_err());
    }

    #[test]
    fn checksum_detects_a_modified_complete_record() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let scope = scope(root.path());
        let (journal, _) = Journal::create(&store).unwrap();
        journal.reserve(&scope, GENERATION).unwrap();
        let path = root.path().join("structured-ownership/enrollment.registry");
        let mut file = OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start((HEADER_SIZE + 1) as u64))
            .unwrap();
        file.write_all(&[0x55]).unwrap();
        assert!(journal.contains(&scope, GENERATION).is_err());
    }

    #[test]
    fn truncating_a_whole_record_does_not_allow_reenrollment() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let scope = scope(root.path());
        let (journal, _) = Journal::create(&store).unwrap();
        journal.reserve(&scope, GENERATION).unwrap();
        let path = root.path().join("structured-ownership/enrollment.registry");
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_len(file.metadata().unwrap().len() - ENTRY_SIZE as u64)
            .unwrap();
        assert!(journal.reserve(&scope, GENERATION).is_err());
    }

    #[test]
    fn capacity_remains_available_to_commit_all_reserved_sessions() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let scope = scope(root.path());
        let (journal, _) = Journal::create(&store).unwrap();
        let mut records = Vec::new();
        for index in 0..MAX_ENTRIES / 2 {
            let mut record = [0u8; ENTRY_SIZE];
            record[0] = 1;
            record[1..9].copy_from_slice(&(index as u64).to_be_bytes());
            record[33..49].copy_from_slice(&GENERATION);
            let checksum = Sha256::digest(&record[..49]);
            record[49..].copy_from_slice(&checksum);
            records.extend_from_slice(&record);
        }
        let path = root.path().join("structured-ownership/enrollment.registry");
        let mut file = OpenOptions::new().write(true).open(path).unwrap();
        file.write_all(&Journal::header((MAX_ENTRIES / 2) as u64))
            .unwrap();
        file.write_all(&records).unwrap();
        assert!(journal.reserve(&scope, GENERATION).is_err());
        let mut first = scope.clone();
        first.digest = [0; 32];
        journal.commit(&first, GENERATION, |_| true).unwrap();
    }

    #[test]
    fn durable_history_verification_holds_the_journal_lock() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let scope = scope(root.path());
        let (journal, identity) = Journal::create(&store).unwrap();
        journal.reserve(&scope, GENERATION).unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        std::thread::scope(|threads| {
            let journal_ref = &journal;
            let scope_ref = &scope;
            let committing = threads.spawn(move || {
                journal_ref.commit(scope_ref, GENERATION, |_| {
                    entered_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    true
                })
            });
            entered_rx.recv().unwrap();
            assert!(Journal::open(&store, identity).is_err());
            finish_tx.send(()).unwrap();
            committing.join().unwrap().unwrap();
        });
        assert!(Journal::open(&store, identity)
            .unwrap()
            .contains(&scope, GENERATION)
            .unwrap());
    }

    #[test]
    fn child_exit_after_reservation_does_not_allow_reenrollment() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Root::create(root.path()).unwrap());
        let (_journal, identity) = Journal::create(&store).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::enrollment::tests::process_fixture",
                "--nocapture",
            ])
            .env("V4_ENROLLMENT_ROOT", root.path())
            .env("V4_ENROLLMENT_DEVICE", identity.device.to_string())
            .env("V4_ENROLLMENT_INODE", identity.inode.to_string())
            .status()
            .unwrap();
        assert!(status.success());
        let journal = Journal::open(&store, identity).unwrap();
        assert!(!journal.contains(&scope(root.path()), GENERATION).unwrap());
        assert!(journal.reserve(&scope(root.path()), GENERATION).is_err());
    }

    #[test]
    fn process_fixture() {
        let Some(root) = std::env::var_os("V4_ENROLLMENT_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let store = Arc::new(Root::open(&root).unwrap());
        let identity = Identity {
            device: std::env::var("V4_ENROLLMENT_DEVICE")
                .unwrap()
                .parse()
                .unwrap(),
            inode: std::env::var("V4_ENROLLMENT_INODE")
                .unwrap()
                .parse()
                .unwrap(),
        };
        Journal::open(&store, identity)
            .unwrap()
            .reserve(&scope(&root), GENERATION)
            .unwrap();
        std::process::exit(0);
    }
}
