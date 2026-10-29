//! Test-only bootstrap marker. Bootstrap requires an externally confirmed clean
//! installation with all other versions stopped; opening never creates state.

use super::{Identity, Journal, Root, Store};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{Arc, Mutex},
};

const NAME: &str = "structured-ownership.anchor";
const MAGIC: &[u8; 8] = b"V4ANC001";
const SIZE: usize = 96;

pub(super) struct Marker {
    file: Mutex<File>,
    file_identity: Identity,
    prefix: [u8; 56],
    journal: Identity,
}

impl Marker {
    fn create(root: &Root, journal: Identity) -> Result<Self, String> {
        root.validate()?;
        let mut file = Store::open_child(
            &root.root_file,
            NAME,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        file.try_lock()
            .map_err(|_| "Ownership anchor unavailable")?;
        let root_meta = root
            .root_file
            .metadata()
            .map_err(|_| "Cannot inspect ownership root")?;
        let dir_meta = root
            .directory
            .metadata()
            .map_err(|_| "Cannot inspect ownership directory")?;
        let mut bytes = [0u8; SIZE];
        bytes[..8].copy_from_slice(MAGIC);
        for (index, value) in [
            root_meta.dev(),
            root_meta.ino(),
            dir_meta.dev(),
            dir_meta.ino(),
            journal.device,
            journal.inode,
        ]
        .into_iter()
        .enumerate()
        {
            bytes[8 + index * 8..16 + index * 8].copy_from_slice(&value.to_be_bytes());
        }
        let digest = Sha256::digest(&bytes[..64]);
        bytes[64..].copy_from_slice(&digest);
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist ownership anchor")?;
        root.root_file
            .sync_all()
            .map_err(|_| "Cannot sync ownership root")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership anchor")?;
        let file_identity = Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        file.unlock()
            .map_err(|_| "Cannot unlock ownership anchor")?;
        let marker = Self {
            file: Mutex::new(file),
            file_identity,
            prefix: bytes[..56].try_into().unwrap(),
            journal,
        };
        marker.verify(root)?;
        Ok(marker)
    }

    fn open(root: &Root) -> Result<Self, String> {
        let mut file = Store::open_child(&root.root_file, NAME, libc::O_RDWR, 0)?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership anchor")?;
        if metadata.len() != SIZE as u64 {
            return Err("Invalid ownership anchor".into());
        }
        let mut bytes = [0u8; SIZE];
        file.read_exact(&mut bytes)
            .map_err(|_| "Cannot read ownership anchor")?;
        if &bytes[..8] != MAGIC || Sha256::digest(&bytes[..64])[..] != bytes[64..] {
            return Err("Invalid ownership anchor".into());
        }
        let journal = Identity {
            device: u64::from_be_bytes(bytes[40..48].try_into().unwrap()),
            inode: u64::from_be_bytes(bytes[48..56].try_into().unwrap()),
        };
        let file_identity = Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        let marker = Self {
            file: Mutex::new(file),
            file_identity,
            prefix: bytes[..56].try_into().unwrap(),
            journal,
        };
        marker.verify(root)?;
        Ok(marker)
    }

    pub(super) fn verify(&self, root: &Root) -> Result<(), String> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| "Ownership anchor unavailable")?;
        self.read_checked(root, &mut file).map(|_| ())
    }

    pub(super) fn count(&self, root: &Root) -> Result<u64, String> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| "Ownership anchor unavailable")?;
        let bytes = self.read_checked(root, &mut file)?;
        Ok(u64::from_be_bytes(bytes[56..64].try_into().unwrap()))
    }

    pub(super) fn advance(&self, root: &Root, expected: u64) -> Result<(), String> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| "Ownership anchor unavailable")?;
        let mut bytes = self.read_checked(root, &mut file)?;
        if u64::from_be_bytes(bytes[56..64].try_into().unwrap()) != expected {
            return Err("Ownership anchor sequence mismatch".into());
        }
        let next = expected
            .checked_add(1)
            .ok_or("Ownership anchor sequence exhausted")?;
        bytes[56..64].copy_from_slice(&next.to_be_bytes());
        let digest = Sha256::digest(&bytes[..64]);
        bytes[64..].copy_from_slice(&digest);
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(&bytes))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist ownership anchor sequence".into())
    }

    fn read_checked(&self, root: &Root, file: &mut File) -> Result<[u8; SIZE], String> {
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect ownership anchor")?;
        let path = std::fs::symlink_metadata(root.root.join(NAME))
            .map_err(|_| "Ownership anchor missing")?;
        if !metadata.is_file()
            || !path.is_file()
            || path.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || path.uid() != unsafe { libc::geteuid() }
            || path.mode() & 0o077 != 0
            || metadata.nlink() != 1
            || path.nlink() != 1
            || metadata.len() != SIZE as u64
            || (metadata.dev(), metadata.ino())
                != (self.file_identity.device, self.file_identity.inode)
            || (metadata.dev(), metadata.ino()) != (path.dev(), path.ino())
        {
            return Err("Ownership anchor changed".into());
        }
        let mut bytes = [0u8; SIZE];
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|_| "Cannot read ownership anchor")?;
        if bytes[..56] != self.prefix || Sha256::digest(&bytes[..64])[..] != bytes[64..] {
            return Err("Ownership anchor changed".into());
        }
        let root_meta = root
            .root_file
            .metadata()
            .map_err(|_| "Cannot inspect ownership root")?;
        let dir_meta = root
            .directory
            .metadata()
            .map_err(|_| "Cannot inspect ownership directory")?;
        let expected = [
            root_meta.dev(),
            root_meta.ino(),
            dir_meta.dev(),
            dir_meta.ino(),
            self.journal.device,
            self.journal.inode,
        ];
        for (index, value) in expected.into_iter().enumerate() {
            if bytes[8 + index * 8..16 + index * 8] != value.to_be_bytes() {
                return Err("Ownership anchor identity changed".into());
            }
        }
        Ok(bytes)
    }
}

pub(super) struct AnchoredRoot {
    pub(super) root: Arc<Root>,
    pub(super) journal: Identity,
}

impl AnchoredRoot {
    pub(super) fn bootstrap(path: &Path) -> Result<Self, String> {
        if std::fs::read_dir(path)
            .map_err(|_| "Cannot inspect installation")?
            .next()
            .transpose()
            .map_err(|_| "Cannot inspect installation")?
            .is_some()
        {
            return Err("Ownership bootstrap requires an empty data directory".into());
        }
        let mut root = Arc::new(Root::create(path)?);
        let (journal, identity) = Journal::create(&root)?;
        drop(journal);
        let marker = Marker::create(&root, identity)?;
        Arc::get_mut(&mut root)
            .ok_or("Ownership root is shared")?
            .anchor = Some(marker);
        root.validate()?;
        drop(Journal::open(&root, identity)?);
        Ok(Self {
            root,
            journal: identity,
        })
    }

    pub(super) fn open(path: &Path) -> Result<Self, String> {
        let mut root = Root::open(path)?;
        let marker = Marker::open(&root)?;
        let identity = marker.journal;
        root.anchor = Some(marker);
        root.validate()?;
        let root = Arc::new(root);
        drop(Journal::open(&root, identity)?);
        Ok(Self {
            root,
            journal: identity,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structured::ownership::provision::enrollment::Journal;
    use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, process::Command};

    #[test]
    fn missing_anchor_or_replaced_journal_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let anchored = AnchoredRoot::bootstrap(root.path()).unwrap();
        let reopened = AnchoredRoot::open(root.path()).unwrap();
        assert_eq!(anchored.journal, reopened.journal);
        Journal::open(&reopened.root, reopened.journal).unwrap();
        let journal = root.path().join("structured-ownership/enrollment.registry");
        let content = std::fs::read(&journal).unwrap();
        std::fs::rename(&journal, root.path().join("original-journal")).unwrap();
        let mut replacement = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&journal)
            .unwrap();
        replacement.write_all(&content).unwrap();
        assert!(AnchoredRoot::open(root.path()).is_err());
        std::fs::remove_file(root.path().join("structured-ownership.anchor")).unwrap();
        assert!(AnchoredRoot::open(root.path()).is_err());
        assert!(AnchoredRoot::bootstrap(root.path()).is_err());
    }

    #[test]
    fn bootstrap_rejects_existing_data() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("structured-sessions")).unwrap();
        assert!(AnchoredRoot::bootstrap(root.path()).is_err());
    }

    #[test]
    fn replacing_marker_invalidates_an_already_open_journal() {
        let root = tempfile::tempdir().unwrap();
        let anchored = AnchoredRoot::bootstrap(root.path()).unwrap();
        let journal = Journal::open(&anchored.root, anchored.journal).unwrap();
        let marker = root.path().join(NAME);
        let bytes = std::fs::read(&marker).unwrap();
        std::fs::rename(&marker, root.path().join("old-marker")).unwrap();
        let mut replacement = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&marker)
            .unwrap();
        replacement.write_all(&bytes).unwrap();
        assert!(journal.with_entries(|_, _| Ok(())).is_err());
    }

    #[test]
    fn anchor_rejects_a_valid_older_journal_prefix_on_the_same_inode() {
        let root = tempfile::tempdir().unwrap();
        let anchored = AnchoredRoot::bootstrap(root.path()).unwrap();
        let journal = Journal::open(&anchored.root, anchored.journal).unwrap();
        let scope = crate::structured::ownership::Scope::new(
            root.path(),
            "owner",
            "ss-0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        journal.reserve(&scope, [1; 16]).unwrap();
        let path = root.path().join("structured-ownership/enrollment.registry");
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .unwrap();
        file.write_all(&Journal::header(0)).unwrap();
        file.sync_all().unwrap();
        assert!(AnchoredRoot::open(root.path()).is_err());
    }

    #[test]
    fn crash_after_marker_advance_fails_closed_on_restart() {
        let root = tempfile::tempdir().unwrap();
        AnchoredRoot::bootstrap(root.path()).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "structured::ownership::provision::enrollment::anchor::tests::advance_process_fixture", "--nocapture"])
            .env("V4_ANCHORED_ADVANCE_ROOT", root.path()).status().unwrap();
        assert!(status.success());
        assert!(AnchoredRoot::open(root.path()).is_err());
    }

    #[test]
    fn advance_process_fixture() {
        let Some(root) = std::env::var_os("V4_ANCHORED_ADVANCE_ROOT") else {
            return;
        };
        let anchored = AnchoredRoot::open(Path::new(&root)).unwrap();
        let journal = Journal::open(&anchored.root, anchored.journal).unwrap();
        let file = journal.file.lock().unwrap();
        file.try_lock().unwrap();
        anchored
            .root
            .anchor
            .as_ref()
            .unwrap()
            .advance(&anchored.root, 0)
            .unwrap();
        std::process::exit(0);
    }

    #[tokio::test]
    async fn anchored_session_lease_blocks_another_process_and_unclean_restart() {
        use crate::structured::{storage, StructuredSessionManager};
        let root = tempfile::tempdir().unwrap();
        let anchored = AnchoredRoot::bootstrap(root.path()).unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                "owner",
                root.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let history =
            crate::structured::structured_session_path(&manager.inner.config, "owner", &session.id);
        let generation = *storage::decode(&std::fs::read(history).unwrap())
            .unwrap()
            .session_incarnation
            .unwrap()
            .0
            .as_bytes();
        let scope =
            crate::structured::ownership::Scope::new(root.path(), "owner", &session.id).unwrap();
        let journal = Journal::open(&anchored.root, anchored.journal).unwrap();
        journal.reserve(&scope, generation).unwrap();
        journal.commit_history(&scope, generation).unwrap();
        let guard = journal.bind_lease(&scope, generation).unwrap();
        let child = |mode: &str| {
            Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "structured::ownership::provision::enrollment::anchor::tests::lease_process_fixture", "--nocapture"])
            .env("V4_ANCHORED_LEASE_ROOT", root.path())
            .env("V4_ANCHORED_LEASE_SESSION", &session.id)
            .env("V4_ANCHORED_LEASE_GENERATION", hex::encode(generation))
            .env("V4_ANCHORED_LEASE_MODE", mode).status().unwrap()
        };
        assert!(child("busy").success());
        guard.release_after_cleanup().unwrap();
        assert!(child("crash").success());
        let restarted = AnchoredRoot::open(root.path()).unwrap();
        assert!(Journal::open(&restarted.root, restarted.journal)
            .unwrap()
            .acquire_lease(&scope, generation)
            .is_err());
    }

    #[test]
    fn lease_process_fixture() {
        let Some(root) = std::env::var_os("V4_ANCHORED_LEASE_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let session = std::env::var("V4_ANCHORED_LEASE_SESSION").unwrap();
        let generation: [u8; 16] =
            hex::decode(std::env::var("V4_ANCHORED_LEASE_GENERATION").unwrap())
                .unwrap()
                .try_into()
                .unwrap();
        let anchored = AnchoredRoot::open(&root).unwrap();
        let journal = Journal::open(&anchored.root, anchored.journal).unwrap();
        let scope = crate::structured::ownership::Scope::new(&root, "owner", &session).unwrap();
        let result = journal.acquire_lease(&scope, generation);
        if std::env::var("V4_ANCHORED_LEASE_MODE").unwrap() == "busy" {
            assert!(result.is_err());
            return;
        }
        let _guard = result.unwrap();
        std::process::exit(0);
    }

    #[test]
    fn separate_process_can_reopen_durable_anchor() {
        let root = tempfile::tempdir().unwrap();
        let anchored = AnchoredRoot::bootstrap(root.path()).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::enrollment::anchor::tests::process_fixture",
                "--nocapture",
            ])
            .env("V4_ANCHORED_ROOT", root.path())
            .env("V4_ANCHORED_DEVICE", anchored.journal.device.to_string())
            .env("V4_ANCHORED_INODE", anchored.journal.inode.to_string())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn process_fixture() {
        let Some(root) = std::env::var_os("V4_ANCHORED_ROOT") else {
            return;
        };
        let anchored = AnchoredRoot::open(Path::new(&root)).unwrap();
        assert_eq!(
            anchored.journal.device,
            std::env::var("V4_ANCHORED_DEVICE")
                .unwrap()
                .parse::<u64>()
                .unwrap()
        );
        assert_eq!(
            anchored.journal.inode,
            std::env::var("V4_ANCHORED_INODE")
                .unwrap()
                .parse::<u64>()
                .unwrap()
        );
    }
}
