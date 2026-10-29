//! Durable preparation only; this module never authorizes history changes.

use super::{ExistingInventory, Record};
use crate::structured::ownership::provision::{
    enrollment::{EnrollmentState, Journal, ENTRY_SIZE, HEADER_SIZE, MAX_ENTRIES},
    Store,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    os::unix::ffi::OsStrExt,
    path::Path,
    sync::Arc,
};
use uuid::Uuid;

const MAX_INTENT_BYTES: usize = 2_000_000;
const MAX_INTENTS: usize = 128;

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    root: [u8; 32],
    owner: [u8; 32],
    operation: Uuid,
    directories: Vec<(u64, u64)>,
    records: Vec<Record>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum State {
    Absent,
    Prepared,
    Changed,
    Held,
}

#[derive(PartialEq, Eq)]
enum Boundary {
    AfterFile,
    AfterIndex,
    AfterCommit,
}

pub(super) fn prepare(
    journal: &Arc<Journal>,
    owner: &str,
    operation: Uuid,
    reviewed: &ExistingInventory,
) -> Result<State, String> {
    prepare_with_hook(journal, owner, operation, reviewed, |_| {})
}

fn prepare_with_hook(
    journal: &Arc<Journal>,
    owner: &str,
    operation: Uuid,
    reviewed: &ExistingInventory,
    mut hook: impl FnMut(Boundary),
) -> Result<State, String> {
    validate_scope(journal, owner, operation)?;
    if reviewed.root != journal.store.root || reviewed.owner != owner {
        return Err("Migration review belongs to another scope".into());
    }
    let manifest = manifest(reviewed, operation);
    let payload = serde_json::to_vec(&manifest).map_err(|_| "Cannot encode migration intent")?;
    if payload.len() > MAX_INTENT_BYTES {
        return Err("Migration intent exceeds its limit".into());
    }
    let index = index_key(&journal.store.root, owner, operation);
    let binding = binding_key(index);
    let (first, second) = payload_binding(&payload).ok_or("Invalid migration review digest")?;
    let name = file_name(index);
    journal.with_entries(|file, entries| {
        let stored = match read_payload(journal, &name) {
            Ok(stored) => stored,
            Err(_) => return Ok(State::Held),
        };
        let index_exists = entries.contains_key(&index);
        let binding_exists = entries.contains_key(&binding);
        if let Some(stored) = stored {
            if stored != payload
                || !valid_binding(entries, index, first)
                || !valid_binding(entries, binding, second)
            {
                return Ok(State::Held);
            }
            return Ok(if reviewed.revalidate().is_ok() {
                State::Prepared
            } else {
                State::Changed
            });
        }
        if index_exists || binding_exists {
            return Ok(State::Held);
        }
        if reviewed.revalidate().is_err() {
            return Ok(State::Changed);
        }
        reserve_capacity(journal, file, entries)?;
        journal.append(file, 1, index, first)?;
        hook(Boundary::AfterIndex);
        write_payload(journal, &name, &payload)?;
        hook(Boundary::AfterFile);
        if reviewed.revalidate().is_err() {
            return Ok(State::Held);
        }
        journal.append(file, 1, binding, second)?;
        hook(Boundary::AfterCommit);
        if read_payload(journal, &name).ok().flatten().as_deref() != Some(payload.as_slice()) {
            return Ok(State::Held);
        }
        Ok(if reviewed.revalidate().is_ok() {
            State::Prepared
        } else {
            State::Changed
        })
    })
}

pub(super) fn inspect(
    journal: &Arc<Journal>,
    owner: &str,
    operation: Uuid,
) -> Result<State, String> {
    validate_scope(journal, owner, operation)?;
    let index = index_key(&journal.store.root, owner, operation);
    let name = file_name(index);
    journal.with_entries(|_, entries| {
        let payload = match read_payload(journal, &name) {
            Ok(Some(payload)) => payload,
            Ok(None)
                if !entries.contains_key(&index) && !entries.contains_key(&binding_key(index)) =>
            {
                return Ok(State::Absent)
            }
            _ => return Ok(State::Held),
        };
        let stored: Manifest = match serde_json::from_slice(&payload) {
            Ok(stored) => stored,
            Err(_) => return Ok(State::Held),
        };
        let Some((first, second)) = payload_binding(&payload) else {
            return Ok(State::Held);
        };
        if stored.version != 1
            || stored.root != root_key(&journal.store.root)
            || stored.owner != owner_key(owner)
            || stored.operation != operation
            || serde_json::to_vec(&stored).ok().as_deref() != Some(payload.as_slice())
            || !valid_binding(entries, index, first)
            || !valid_binding(entries, binding_key(index), second)
        {
            return Ok(State::Held);
        }
        let current = match ExistingInventory::scan(&journal.store.root, owner) {
            Ok(current) => current,
            Err(_) => return Ok(State::Held),
        };
        Ok(if manifest(&current, operation) == stored {
            State::Prepared
        } else {
            State::Changed
        })
    })
}

/// Resume a partially recorded intent only from the same independently reviewed
/// inventory. This does not authorize migration or establish quiescence.
pub(super) fn repair(
    journal: &Arc<Journal>,
    owner: &str,
    operation: Uuid,
    reviewed: &ExistingInventory,
) -> Result<State, String> {
    repair_with_hook(journal, owner, operation, reviewed, |_| {})
}

fn repair_with_hook(
    journal: &Arc<Journal>,
    owner: &str,
    operation: Uuid,
    reviewed: &ExistingInventory,
    mut hook: impl FnMut(Boundary),
) -> Result<State, String> {
    validate_scope(journal, owner, operation)?;
    if reviewed.root != journal.store.root || reviewed.owner != owner {
        return Err("Migration review belongs to another scope".into());
    }
    let payload = serde_json::to_vec(&manifest(reviewed, operation))
        .map_err(|_| "Cannot encode migration intent")?;
    if payload.len() > MAX_INTENT_BYTES {
        return Err("Migration intent exceeds its limit".into());
    }
    let index = index_key(&journal.store.root, owner, operation);
    let binding = binding_key(index);
    let (first, second) = payload_binding(&payload).ok_or("Invalid migration review digest")?;
    let name = file_name(index);
    journal.with_entries(|file, entries| {
        let stored = match read_payload(journal, &name) {
            Ok(stored) => stored,
            Err(_) => return Ok(State::Held),
        };
        let index_exists = entries.contains_key(&index);
        let binding_exists = entries.contains_key(&binding);
        if !index_exists && !binding_exists && stored.is_none() {
            return Ok(State::Absent);
        }
        if !valid_binding(entries, index, first)
            || stored.as_ref().is_some_and(|value| value != &payload)
        {
            return Ok(State::Held);
        }
        if binding_exists {
            if !valid_binding(entries, binding, second) || stored.is_none() {
                return Ok(State::Held);
            }
            return Ok(if reviewed.revalidate().is_ok() {
                State::Prepared
            } else {
                State::Changed
            });
        }
        if reviewed.revalidate().is_err() {
            return Ok(State::Changed);
        }
        if stored.is_none() {
            write_payload(journal, &name, &payload)?;
            hook(Boundary::AfterFile);
        }
        if read_payload(journal, &name).ok().flatten().as_deref() != Some(payload.as_slice())
            || reviewed.revalidate().is_err()
        {
            return Ok(State::Held);
        }
        journal.append(file, 1, binding, second)?;
        hook(Boundary::AfterCommit);
        if read_payload(journal, &name).ok().flatten().as_deref() != Some(payload.as_slice()) {
            return Ok(State::Held);
        }
        Ok(if reviewed.revalidate().is_ok() {
            State::Prepared
        } else {
            State::Changed
        })
    })
}

fn validate_scope(journal: &Journal, owner: &str, operation: Uuid) -> Result<(), String> {
    if journal.store.anchor.is_none()
        || owner.trim().is_empty()
        || owner.len() > 256
        || owner.chars().any(char::is_control)
        || operation.is_nil()
    {
        return Err("Invalid migration intent scope".into());
    }
    journal.store.validate()
}

fn manifest(inventory: &ExistingInventory, operation: Uuid) -> Manifest {
    Manifest {
        version: 1,
        root: root_key(&inventory.root),
        owner: owner_key(&inventory.owner),
        operation,
        directories: inventory.directories.clone(),
        records: inventory.records.clone(),
    }
}

fn hash_fields(domain: &[u8], fields: &[&[u8]]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(domain);
    for field in fields {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field);
    }
    hash.finalize().into()
}

fn root_key(root: &Path) -> [u8; 32] {
    hash_fields(b"V4 migration root v1", &[root.as_os_str().as_bytes()])
}

fn owner_key(owner: &str) -> [u8; 32] {
    hash_fields(b"V4 migration owner v1", &[owner.as_bytes()])
}

fn index_key(root: &Path, owner: &str, operation: Uuid) -> [u8; 32] {
    hash_fields(
        b"V4 migration operation v1",
        &[&root_key(root), &owner_key(owner), operation.as_bytes()],
    )
}

fn binding_key(index: [u8; 32]) -> [u8; 32] {
    hash_fields(b"V4 migration review v1", &[&index])
}

fn payload_binding(payload: &[u8]) -> Option<([u8; 16], [u8; 16])> {
    let digest = hash_fields(b"V4 migration reviewed inventory v1", &[payload]);
    let first = digest[..16].try_into().ok()?;
    let second = digest[16..].try_into().ok()?;
    (first != [0; 16] && second != [0; 16]).then_some((first, second))
}

fn file_name(index: [u8; 32]) -> String {
    format!("{}.migration", hex::encode(index))
}

fn valid_binding(
    entries: &HashMap<[u8; 32], EnrollmentState>,
    key: [u8; 32],
    expected: [u8; 16],
) -> bool {
    entries.get(&key).is_some_and(|state| {
        state.generation == expected && !state.committed && state.lease.is_none()
    })
}

fn reserve_capacity(
    journal: &Journal,
    file: &fs::File,
    entries: &HashMap<[u8; 32], EnrollmentState>,
) -> Result<(), String> {
    let length = usize::try_from(
        file.metadata()
            .map_err(|_| "Cannot inspect migration storage")?
            .len(),
    )
    .map_err(|_| "Invalid migration storage size")?;
    let body = length
        .checked_sub(HEADER_SIZE)
        .ok_or("Invalid migration storage size")?;
    if body % ENTRY_SIZE != 0 || body / ENTRY_SIZE > MAX_ENTRIES {
        return Err("Invalid migration storage size".into());
    }
    let outstanding: usize = entries
        .values()
        .map(|state| {
            if !state.committed {
                2
            } else if state.lease.is_none() {
                1
            } else {
                0
            }
        })
        .sum();
    if MAX_ENTRIES - body / ENTRY_SIZE < outstanding + 6 {
        return Err("Migration storage capacity reached".into());
    }
    let mut count = 0;
    for (index, entry) in fs::read_dir(journal.store.root.join("structured-ownership"))
        .map_err(|_| "Cannot inspect migration storage")?
        .enumerate()
    {
        if index >= MAX_ENTRIES * 2 {
            return Err("Migration storage capacity reached".into());
        }
        let entry = entry.map_err(|_| "Cannot inspect migration storage")?;
        if entry.file_name().to_string_lossy().ends_with(".migration") {
            count += 1;
        }
        if count >= MAX_INTENTS {
            return Err("Migration storage capacity reached".into());
        }
    }
    Ok(())
}

fn read_payload(journal: &Journal, name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = journal.store.root.join("structured-ownership").join(name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Migration intent unavailable".into()),
        Ok(_) => {}
    }
    let file = Store::open_child(&journal.store.directory, name, libc::O_RDONLY, 0)?;
    journal.store.check_file(&path, &file)?;
    let before = file
        .metadata()
        .map_err(|_| "Cannot inspect migration intent")?;
    if before.len() > MAX_INTENT_BYTES as u64 {
        return Err("Migration intent exceeds its limit".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_INTENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read migration intent")?;
    let after = file
        .metadata()
        .map_err(|_| "Cannot inspect migration intent")?;
    if bytes.len() > MAX_INTENT_BYTES
        || ExistingInventory::change_stamp(&before) != ExistingInventory::change_stamp(&after)
    {
        return Err("Migration intent changed during read".into());
    }
    journal.store.check_file(&path, &file)?;
    Ok(Some(bytes))
}

fn write_payload(journal: &Journal, name: &str, payload: &[u8]) -> Result<(), String> {
    let path = journal.store.root.join("structured-ownership").join(name);
    let mut file = Store::open_child(
        &journal.store.directory,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    journal.store.check_file(&path, &file)?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist migration intent")?;
    journal
        .store
        .directory
        .sync_all()
        .map_err(|_| "Cannot sync migration intent")?;
    journal.store.check_file(&path, &file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structured::ownership::provision::enrollment::anchor::AnchoredRoot;
    use crate::structured::{storage, StructuredSessionManager};
    use std::fs;

    const OWNER: &str = "migration-owner";

    async fn fixture(root: &std::path::Path) -> (AnchoredRoot, StructuredSessionManager, String) {
        let anchored = AnchoredRoot::bootstrap(root).unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.into(),
            ..Default::default()
        });
        let session = manager
            .create_session(OWNER, root.to_str().unwrap(), Some("claude"), None, None)
            .await
            .unwrap();
        (anchored, manager, session.id)
    }

    fn journal(root: &AnchoredRoot) -> Arc<Journal> {
        Journal::open(&root.root, root.journal).unwrap()
    }

    #[tokio::test]
    async fn intent_binds_reviewed_inventory_and_detects_changed_history_and_owner() {
        let temp = tempfile::tempdir().unwrap();
        let (anchored, manager, id) = fixture(temp.path()).await;
        let history = crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
        let original = fs::read(&history).unwrap();
        let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        let operation = Uuid::new_v4();
        let journal = journal(&anchored);
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Absent);
        assert_eq!(
            prepare(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Prepared
        );
        assert_eq!(
            prepare(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Prepared
        );
        assert_eq!(
            inspect(&journal, "different-owner", operation).unwrap(),
            State::Absent
        );
        assert_eq!(fs::read(&history).unwrap(), original);

        let mut changed = storage::decode(&original).unwrap();
        changed.snapshot.title = "Changed after review".into();
        fs::write(
            &history,
            storage::encode_checkpoint(OWNER, &changed.snapshot, changed.session_incarnation)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Changed);
        let changed_review = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        assert_eq!(
            prepare(&journal, OWNER, operation, &changed_review).unwrap(),
            State::Held
        );
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Changed);
    }

    #[tokio::test]
    async fn stale_review_creates_no_intent_or_history_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (anchored, manager, id) = fixture(temp.path()).await;
        let history = crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
        let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        let mut changed = storage::decode(&fs::read(&history).unwrap()).unwrap();
        changed.snapshot.title = "Changed before intent".into();
        let bytes =
            storage::encode_checkpoint(OWNER, &changed.snapshot, changed.session_incarnation)
                .unwrap();
        fs::write(&history, &bytes).unwrap();
        let operation = Uuid::new_v4();
        let journal = journal(&anchored);
        assert_eq!(
            prepare(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Changed
        );
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Absent);
        assert_eq!(fs::read(&history).unwrap(), bytes);
    }

    #[tokio::test]
    async fn unanchored_storage_cannot_prepare_or_inspect_an_intent() {
        let temp = tempfile::tempdir().unwrap();
        let root = Arc::new(
            crate::structured::ownership::provision::enrollment::Root::create(temp.path()).unwrap(),
        );
        let (journal, _) = Journal::create(&root).unwrap();
        let manager = StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: temp.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                OWNER,
                temp.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let history =
            crate::structured::structured_session_path(&manager.inner.config, OWNER, &session.id);
        let original = fs::read(&history).unwrap();
        let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        let operation = Uuid::new_v4();
        assert!(prepare(&journal, OWNER, operation, &reviewed).is_err());
        assert!(inspect(&journal, OWNER, operation).is_err());
        assert_eq!(fs::read(&history).unwrap(), original);
        assert_eq!(
            fs::read_dir(temp.path().join("structured-ownership"))
                .unwrap()
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn intent_remains_prepared_after_process_exit_without_touching_history() {
        let temp = tempfile::tempdir().unwrap();
        let (anchored, manager, id) = fixture(temp.path()).await;
        let history = crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
        let original = fs::read(&history).unwrap();
        let operation = Uuid::new_v4();
        let status = std::process::Command::new(std::env::current_exe().unwrap()).args([
            "--exact", "structured::ownership::provision::enrollment::existing::intent::tests::crash_fixture", "--nocapture"
        ]).env("V4_MIGRATION_INTENT_ROOT", temp.path()).env("V4_MIGRATION_INTENT_OPERATION", operation.to_string()).env("V4_MIGRATION_INTENT_PHASE", "after_commit").status().unwrap();
        assert!(status.success());
        let reopened = AnchoredRoot::open(temp.path()).unwrap();
        assert_eq!(
            inspect(&journal(&reopened), OWNER, operation).unwrap(),
            State::Prepared
        );
        assert_eq!(fs::read(&history).unwrap(), original);
        drop(anchored);
    }

    #[tokio::test]
    async fn missing_tampered_or_symlinked_intent_is_held_instead_of_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let (anchored, manager, id) = fixture(temp.path()).await;
        let history = crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
        let original = fs::read(&history).unwrap();
        let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        let operation = Uuid::new_v4();
        let journal = journal(&anchored);
        assert_eq!(
            prepare(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Prepared
        );
        let intent = temp
            .path()
            .join("structured-ownership")
            .join(file_name(index_key(&journal.store.root, OWNER, operation)));
        let saved = fs::read(&intent).unwrap();
        fs::write(&intent, b"{}").unwrap();
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
        assert_eq!(
            prepare(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Held
        );
        fs::write(&intent, &saved).unwrap();
        assert_eq!(
            inspect(&journal, OWNER, operation).unwrap(),
            State::Prepared
        );
        fs::remove_file(&intent).unwrap();
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
        assert_eq!(
            prepare(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Held
        );
        let target = temp.path().join("foreign-intent");
        fs::write(&target, saved).unwrap();
        std::os::unix::fs::symlink(&target, &intent).unwrap();
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
        assert_eq!(fs::read(&history).unwrap(), original);
    }

    #[tokio::test]
    async fn interrupted_partial_intent_remains_held_and_cannot_be_replaced() {
        for phase in ["after_file", "after_index"] {
            let temp = tempfile::tempdir().unwrap();
            let (_anchored, manager, id) = fixture(temp.path()).await;
            let history =
                crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
            let original = fs::read(&history).unwrap();
            let operation = Uuid::new_v4();
            let status = std::process::Command::new(std::env::current_exe().unwrap()).args([
                "--exact", "structured::ownership::provision::enrollment::existing::intent::tests::crash_fixture", "--nocapture"
            ]).env("V4_MIGRATION_INTENT_ROOT", temp.path()).env("V4_MIGRATION_INTENT_OPERATION", operation.to_string()).env("V4_MIGRATION_INTENT_PHASE", phase).status().unwrap();
            assert!(status.success());
            let reopened = AnchoredRoot::open(temp.path()).unwrap();
            let journal = journal(&reopened);
            assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
            let intent = temp
                .path()
                .join("structured-ownership")
                .join(file_name(index_key(&journal.store.root, OWNER, operation)));
            if phase == "after_file" {
                fs::remove_file(&intent).unwrap();
                assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
            } else {
                assert!(!intent.exists());
            }
            let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
            assert_eq!(
                prepare(&journal, OWNER, operation, &reviewed).unwrap(),
                State::Held
            );
            assert_eq!(fs::read(&history).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn explicit_repair_completes_only_the_same_review_after_an_interrupted_write() {
        for phase in ["after_index", "after_file"] {
            let temp = tempfile::tempdir().unwrap();
            let (_anchored, manager, id) = fixture(temp.path()).await;
            let history =
                crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
            let original = fs::read(&history).unwrap();
            let operation = Uuid::new_v4();
            let status = std::process::Command::new(std::env::current_exe().unwrap()).args([
                "--exact", "structured::ownership::provision::enrollment::existing::intent::tests::crash_fixture", "--nocapture"
            ]).env("V4_MIGRATION_INTENT_ROOT", temp.path()).env("V4_MIGRATION_INTENT_OPERATION", operation.to_string()).env("V4_MIGRATION_INTENT_PHASE", phase).status().unwrap();
            assert!(status.success());
            let reopened = AnchoredRoot::open(temp.path()).unwrap();
            let journal = journal(&reopened);
            let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
            assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
            assert_eq!(
                repair(&journal, OWNER, operation, &reviewed).unwrap(),
                State::Prepared
            );
            assert_eq!(
                repair(&journal, OWNER, operation, &reviewed).unwrap(),
                State::Prepared
            );
            assert_eq!(
                inspect(&journal, OWNER, operation).unwrap(),
                State::Prepared
            );
            assert_eq!(fs::read(&history).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn explicit_repair_refuses_changed_review_and_modified_intent() {
        for altered in ["history", "intent"] {
            let temp = tempfile::tempdir().unwrap();
            let (_anchored, manager, id) = fixture(temp.path()).await;
            let history =
                crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
            let operation = Uuid::new_v4();
            let status = std::process::Command::new(std::env::current_exe().unwrap()).args([
                "--exact", "structured::ownership::provision::enrollment::existing::intent::tests::crash_fixture", "--nocapture"
            ]).env("V4_MIGRATION_INTENT_ROOT", temp.path()).env("V4_MIGRATION_INTENT_OPERATION", operation.to_string()).env("V4_MIGRATION_INTENT_PHASE", "after_file").status().unwrap();
            assert!(status.success());
            let reopened = AnchoredRoot::open(temp.path()).unwrap();
            let journal = journal(&reopened);
            if altered == "history" {
                let mut saved = storage::decode(&fs::read(&history).unwrap()).unwrap();
                saved.snapshot.title = "Different review".into();
                fs::write(
                    &history,
                    storage::encode_checkpoint(OWNER, &saved.snapshot, saved.session_incarnation)
                        .unwrap(),
                )
                .unwrap();
            } else {
                let path = temp
                    .path()
                    .join("structured-ownership")
                    .join(file_name(index_key(&journal.store.root, OWNER, operation)));
                fs::write(path, b"tampered").unwrap();
            }
            let before = fs::read(&history).unwrap();
            let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
            assert_eq!(
                repair(&journal, OWNER, operation, &reviewed).unwrap(),
                State::Held
            );
            assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
            assert_eq!(fs::read(&history).unwrap(), before);
        }
    }

    #[tokio::test]
    async fn orphaned_binding_is_held_instead_of_absent() {
        let temp = tempfile::tempdir().unwrap();
        let (anchored, _manager, _) = fixture(temp.path()).await;
        let journal = journal(&anchored);
        let operation = Uuid::new_v4();
        let index = index_key(&journal.store.root, OWNER, operation);
        journal
            .with_entries(|file, _| journal.append(file, 1, binding_key(index), [1; 16]))
            .unwrap();
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Held);
        let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        assert_eq!(
            repair(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Held
        );
    }

    #[tokio::test]
    async fn repair_does_not_create_an_unstarted_operation_or_accept_another_owner() {
        let temp = tempfile::tempdir().unwrap();
        let (anchored, manager, id) = fixture(temp.path()).await;
        let path = crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
        let before = fs::read(&path).unwrap();
        let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
        let operation = Uuid::new_v4();
        let journal = journal(&anchored);
        assert_eq!(
            repair(&journal, OWNER, operation, &reviewed).unwrap(),
            State::Absent
        );
        assert!(repair(&journal, "foreign-owner", operation, &reviewed).is_err());
        assert_eq!(inspect(&journal, OWNER, operation).unwrap(), State::Absent);
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[tokio::test]
    async fn repair_can_be_resumed_after_another_process_exits_during_repair() {
        for phase in ["repair_after_file", "repair_after_commit"] {
            let temp = tempfile::tempdir().unwrap();
            let (_anchored, manager, id) = fixture(temp.path()).await;
            let history =
                crate::structured::structured_session_path(&manager.inner.config, OWNER, &id);
            let original = fs::read(&history).unwrap();
            let operation = Uuid::new_v4();
            let run = |phase: &str| {
                std::process::Command::new(std::env::current_exe().unwrap()).args([
                "--exact", "structured::ownership::provision::enrollment::existing::intent::tests::crash_fixture", "--nocapture"
            ]).env("V4_MIGRATION_INTENT_ROOT", temp.path()).env("V4_MIGRATION_INTENT_OPERATION", operation.to_string()).env("V4_MIGRATION_INTENT_PHASE", phase).status().unwrap()
            };
            assert!(run("after_index").success());
            assert!(run(phase).success());
            let reopened = AnchoredRoot::open(temp.path()).unwrap();
            let journal = journal(&reopened);
            let reviewed = ExistingInventory::scan(temp.path(), OWNER).unwrap();
            assert_eq!(
                inspect(&journal, OWNER, operation).unwrap(),
                if phase == "repair_after_file" {
                    State::Held
                } else {
                    State::Prepared
                }
            );
            assert_eq!(
                repair(&journal, OWNER, operation, &reviewed).unwrap(),
                State::Prepared
            );
            assert_eq!(
                inspect(&journal, OWNER, operation).unwrap(),
                State::Prepared
            );
            assert_eq!(fs::read(&history).unwrap(), original);
        }
    }

    #[test]
    fn crash_fixture() {
        let Some(root) = std::env::var_os("V4_MIGRATION_INTENT_ROOT") else {
            return;
        };
        let operation =
            Uuid::parse_str(&std::env::var("V4_MIGRATION_INTENT_OPERATION").unwrap()).unwrap();
        let anchored = AnchoredRoot::open(std::path::Path::new(&root)).unwrap();
        let reviewed = ExistingInventory::scan(std::path::Path::new(&root), OWNER).unwrap();
        let phase = std::env::var("V4_MIGRATION_INTENT_PHASE").unwrap();
        let selected = match phase.as_str() {
            "after_file" | "repair_after_file" => Boundary::AfterFile,
            "after_index" => Boundary::AfterIndex,
            "after_commit" | "repair_after_commit" => Boundary::AfterCommit,
            _ => panic!("Invalid fixture phase"),
        };
        let exit_at = |boundary| {
            if boundary == selected {
                std::process::exit(0);
            }
        };
        if phase.starts_with("repair_") {
            repair_with_hook(&journal(&anchored), OWNER, operation, &reviewed, exit_at).unwrap();
        } else {
            prepare_with_hook(&journal(&anchored), OWNER, operation, &reviewed, exit_at).unwrap();
        }
        std::process::exit(0);
    }
}
