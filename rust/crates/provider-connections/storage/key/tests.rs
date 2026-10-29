use super::*;
use crate::storage::{KEY_FILE, KEY_PREFIX, LOCK_FILE};
use std::fs;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::sync::{Arc, Barrier};
use tempfile::TempDir;

fn root() -> TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}
fn seed(root: &Path, byte: u8) {
    fs::write(
        root.join(KEY_FILE),
        format!("{}{}", KEY_PREFIX, hex::encode([byte; 32])),
    )
    .unwrap();
    fs::set_permissions(root.join(KEY_FILE), fs::Permissions::from_mode(0o600)).unwrap();
}
fn key_error(root: &Path, evidence: &FeatureStoreEvidence) -> Option<Error> {
    open_feature_key(root, evidence, None).err()
}

#[test]
fn fresh_empty_key_is_private_random_regular_single_link_and_reused() {
    let root = root();
    let first = open_feature_key(root.path(), &FeatureStoreEvidence::empty(), None).unwrap();
    let second = open_feature_key(root.path(), &FeatureStoreEvidence::empty(), None).unwrap();
    assert!(*first.0 == *second.0);
    assert!(first.0.iter().any(|byte| *byte != 0));
    let metadata = fs::symlink_metadata(root.path().join(KEY_FILE)).unwrap();
    assert!(metadata.is_file() && metadata.nlink() == 1);
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(
        fs::read_to_string(root.path().join(KEY_FILE))
            .unwrap()
            .len(),
        KEY_PREFIX.len() + 64
    );
}

#[test]
fn feature_directory_is_created_private_without_changing_its_parent() {
    let root = root();
    let parent_mode = fs::metadata(root.path()).unwrap().permissions().mode();
    let child = root.path().join("feature");
    open_feature_key(&child, &FeatureStoreEvidence::empty(), None).unwrap();
    assert_eq!(
        fs::metadata(child).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(root.path()).unwrap().permissions().mode(),
        parent_mode
    );
}

#[test]
fn missing_key_with_any_retained_feature_category_is_never_generated() {
    let root = root();
    for evidence in [
        FeatureStoreEvidence {
            credential_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
        FeatureStoreEvidence {
            profile_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
        FeatureStoreEvidence {
            operation_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
        FeatureStoreEvidence {
            tombstone_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
        FeatureStoreEvidence {
            discovery_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
        FeatureStoreEvidence {
            actor_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
        FeatureStoreEvidence {
            metadata_rows: 1,
            ..FeatureStoreEvidence::empty()
        },
    ] {
        assert_eq!(
            key_error(root.path(), &evidence),
            Some(Error::KeyUnavailable)
        );
        assert!(!root.path().join(KEY_FILE).exists());
    }
}

#[test]
fn existing_valid_key_is_preserved_when_fresh_database_initialization_retries() {
    let root = root();
    seed(root.path(), 7);
    let before = fs::read(root.path().join(KEY_FILE)).unwrap();
    let loaded = open_feature_key(root.path(), &FeatureStoreEvidence::empty(), None).unwrap();
    assert!(*loaded.0 == [7; 32]);
    assert!(fs::read(root.path().join(KEY_FILE)).unwrap() == before);
}

#[test]
fn malformed_partial_or_unknown_version_key_is_preserved_and_fails_closed() {
    for raw in [
        "partial",
        "v4-provider-key:v0:abcdef",
        "v4-provider-key:v1:xyz",
    ] {
        let root = root();
        fs::write(root.path().join(KEY_FILE), raw).unwrap();
        fs::set_permissions(
            root.path().join(KEY_FILE),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert_eq!(
            key_error(root.path(), &FeatureStoreEvidence::empty()),
            Some(Error::KeyUnavailable)
        );
        assert_eq!(fs::read_to_string(root.path().join(KEY_FILE)).unwrap(), raw);
    }
}

#[test]
fn nonprivate_existing_key_is_not_chmodded_or_replaced() {
    let root = root();
    seed(root.path(), 7);
    fs::set_permissions(
        root.path().join(KEY_FILE),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(
        key_error(root.path(), &FeatureStoreEvidence::empty()),
        Some(Error::KeyUnavailable)
    );
    assert_eq!(
        fs::metadata(root.path().join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}

#[test]
fn key_symlink_is_rejected_without_modifying_its_target() {
    let root = root();
    let target = root.path().join("synthetic-target");
    fs::write(&target, "untouched").unwrap();
    symlink(&target, root.path().join(KEY_FILE)).unwrap();
    assert_eq!(
        key_error(root.path(), &FeatureStoreEvidence::empty()),
        Some(Error::KeyUnavailable)
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
}

#[test]
fn key_hardlink_is_rejected_without_modifying_the_shared_inode() {
    let root = root();
    seed(root.path(), 7);
    let target = root.path().join("synthetic-link");
    fs::hard_link(root.path().join(KEY_FILE), &target).unwrap();
    assert_eq!(
        key_error(root.path(), &FeatureStoreEvidence::empty()),
        Some(Error::KeyUnavailable)
    );
    assert_eq!(fs::metadata(target).unwrap().nlink(), 2);
}

#[test]
fn nonprivate_feature_directory_is_rejected_without_repairing_permissions() {
    let root = root();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(
        key_error(root.path(), &FeatureStoreEvidence::empty()),
        Some(Error::KeyUnavailable)
    );
    assert_eq!(
        fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
        0o777
    );
}

#[test]
fn feature_directory_symlink_is_rejected_without_creating_a_target_key() {
    let root = root();
    let target = root.path().join("target");
    fs::create_dir(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    let link = root.path().join("link");
    symlink(&target, &link).unwrap();
    assert_eq!(
        key_error(&link, &FeatureStoreEvidence::empty()),
        Some(Error::KeyUnavailable)
    );
    assert!(!target.join(KEY_FILE).exists());
}

#[test]
fn unsafe_lock_symlink_is_rejected_without_touching_its_target() {
    let root = root();
    let target = root.path().join("lock-target");
    fs::write(&target, "untouched").unwrap();
    symlink(&target, root.path().join(LOCK_FILE)).unwrap();
    assert_eq!(
        key_error(root.path(), &FeatureStoreEvidence::empty()),
        Some(Error::KeyUnavailable)
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
}

#[test]
fn nonprivate_or_hardlinked_existing_lock_is_rejected() {
    for hardlink in [false, true] {
        let root = root();
        let lock = root.path().join(LOCK_FILE);
        fs::write(&lock, "").unwrap();
        fs::set_permissions(
            &lock,
            fs::Permissions::from_mode(if hardlink { 0o600 } else { 0o644 }),
        )
        .unwrap();
        if hardlink {
            fs::hard_link(&lock, root.path().join("other-lock")).unwrap();
        }
        assert_eq!(
            key_error(root.path(), &FeatureStoreEvidence::empty()),
            Some(Error::KeyUnavailable)
        );
    }
}

#[test]
fn two_simultaneous_empty_opens_receive_one_durable_key() {
    let root = root();
    let barrier = Arc::new(Barrier::new(2));
    let mut threads = vec![];
    for _ in 0..2 {
        let path = root.path().to_path_buf();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            open_feature_key(&path, &FeatureStoreEvidence::empty(), None)
        }));
    }
    let first = threads.remove(0).join().unwrap().unwrap();
    let second = threads.remove(0).join().unwrap().unwrap();
    assert!(*first.0 == *second.0);
    assert_eq!(
        fs::read_dir(root.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("tmp"))
            .count(),
        0
    );
}

#[test]
fn retained_state_with_existing_key_but_missing_verifier_fails_closed() {
    let root = root();
    seed(root.path(), 7);
    assert_eq!(
        key_error(
            root.path(),
            &FeatureStoreEvidence {
                profile_rows: 1,
                ..FeatureStoreEvidence::empty()
            }
        ),
        Some(Error::KeyUnavailable)
    );
}

#[test]
fn wrong_but_well_formed_key_fails_the_retained_database_verifier() {
    let root = root();
    seed(root.path(), 7);
    let original = PrivateKey(Zeroizing::new([7; 32]));
    let verifier = crate::storage::crypto::CryptoAdapter::from_master(&original)
        .unwrap()
        .key_verifier()
        .unwrap();
    seed(root.path(), 9);
    assert_eq!(
        open_feature_key(
            root.path(),
            &FeatureStoreEvidence {
                metadata_rows: 1,
                ..FeatureStoreEvidence::empty()
            },
            Some(&verifier)
        )
        .err(),
        Some(Error::KeyUnavailable)
    );
}

#[test]
fn key_fifo_is_rejected_before_any_writer_without_hanging_cleanup() {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, OpenOptionsExt},
    };
    use std::sync::mpsc;
    use std::time::Duration;
    let root = root();
    let fifo = root.path().join(KEY_FILE);
    let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
    let path = root.path().to_path_buf();
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        sender
            .send(key_error(&path, &FeatureStoreEvidence::empty()))
            .unwrap();
    });
    let before_writer = receiver.recv_timeout(Duration::from_secs(1));
    let rejected_before_writer = before_writer.is_ok();
    let result = match before_writer {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // The owned cleanup endpoint is opened only after timeout evidence.
            let cleanup = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
                .open(&fifo)
                .unwrap();
            drop(cleanup);
            receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("owned FIFO cleanup must release worker")
        }
        Err(error) => panic!("FIFO worker disconnected: {error}"),
    };
    worker.join().unwrap();
    fs::remove_file(&fifo).unwrap();
    assert!(
        rejected_before_writer,
        "key FIFO must be rejected without waiting for a writer"
    );
    assert_eq!(result, Some(Error::KeyUnavailable));
}
