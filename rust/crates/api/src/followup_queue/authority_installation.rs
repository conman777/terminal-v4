use super::{
    canonical_authority_root, corrupt, digest, unavailable, validate_envelope, Envelope, Limits,
    QueueError, QueueScope, SCHEMA_VERSION,
};
use crate::vault::VaultCipher;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MARKER: &str = "queue-authority.installation";
const KEY: &str = "queue-authority.key";
const MAX_ENTRIES: usize = 32_768;
const MAX_SCAN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// The first installation holds the queue and authorization locks while it scans; slow
/// storage must not be able to delay logout or other queue work past this budget.
const SCAN_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);

fn marker_value(data: &Path, id: Uuid) -> Result<String, QueueError> {
    serde_json::to_string(&serde_json::json!({"version":2, "dataRoot":canonical_authority_root(data)?, "installationId":id}))
        .map_err(|_| unavailable("Cannot encode queue authority installation"))
}

fn marker(data: &Path) -> Result<Option<String>, QueueError> {
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    let file = match options.open(data.join(MARKER)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(unavailable(
                "Queue authority installation marker is unsafe or unavailable",
            ))
        }
    };
    let metadata = file
        .metadata()
        .map_err(|_| unavailable("Cannot inspect queue authority marker"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 || metadata.len() > 8192 {
        return Err(corrupt("Queue authority installation marker is invalid"));
    }
    let mut content = String::new();
    file.take(8193)
        .read_to_string(&mut content)
        .map_err(|_| corrupt("Queue authority installation marker is invalid"))?;
    if !content.starts_with("enc:v2:") || content.len() > 8192 {
        return Err(corrupt("Queue authority installation marker is invalid"));
    }
    Ok(Some(content))
}

fn check_marker(cipher: &VaultCipher, data: &Path, value: &str) -> Result<Uuid, QueueError> {
    let decoded = cipher.decrypt_with_write_key(value).map_err(|_| {
        unavailable(
            "Queue authority key changed or is unavailable; preserve the installation for recovery",
        )
    })?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Marker {
        version: u8,
        data_root: String,
        installation_id: Uuid,
    }
    let decoded: Marker = serde_json::from_str(&decoded)
        .map_err(|_| corrupt("Queue authority installation marker is invalid"))?;
    if decoded.version != 2
        || decoded.installation_id.is_nil()
        || decoded.data_root != canonical_authority_root(data)?
    {
        return Err(corrupt(
            "Queue authority installation does not match this data directory",
        ));
    }
    Ok(decoded.installation_id)
}

fn existing_key(data: &Path) -> Result<Option<VaultCipher>, QueueError> {
    let path = data.join(KEY);
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable("Queue authority key is unsafe or unavailable")),
    };
    let before = file
        .metadata()
        .map_err(|_| unavailable("Cannot inspect queue authority key"))?;
    if !before.is_file() || before.permissions().mode() & 0o077 != 0 || before.len() != 64 {
        return Err(corrupt("Queue authority key is invalid"));
    }
    let mut key = String::new();
    file.take(65)
        .read_to_string(&mut key)
        .map_err(|_| corrupt("Queue authority key is invalid"))?;
    let after =
        std::fs::symlink_metadata(&path).map_err(|_| unavailable("Queue authority key changed"))?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || after.permissions().mode() & 0o077 != 0
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(corrupt("Queue authority key changed during read"));
    }
    VaultCipher::from_queue_installation_key(key)
        .map(Some)
        .map_err(|_| corrupt("Queue authority key is invalid"))
}

fn create_key(
    data: &Path,
    check: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<VaultCipher, QueueError> {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let key = hex::encode(bytes);
    let mut temporary = tempfile::NamedTempFile::new_in(data)
        .map_err(|_| unavailable("Cannot prepare queue authority key"))?;
    temporary
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| unavailable("Cannot protect queue authority key"))?;
    temporary
        .write_all(key.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| unavailable("Cannot write queue authority key"))?;
    if let Some(check) = check {
        check().map_err(|error| super::conflict(&error))?;
    }
    match temporary.persist_noclobber(data.join(KEY)) {
        Ok(_) => {}
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(unavailable(
                "Queue authority key appeared during initialization; retry",
            ))
        }
        Err(_) => return Err(unavailable("Cannot publish queue authority key")),
    }
    // The marker may only become durable after the key it names. Otherwise a crash could
    // leave a marker whose key is gone, and no queue work could ever be recovered.
    if super::sync_directory(data).is_err() {
        discard_unused_key(data);
        return Err(unavailable(
            "Queue authority key could not be synchronized; nothing was installed, retry",
        ));
    }
    VaultCipher::from_queue_installation_key(key).map_err(|_| {
        discard_unused_key(data);
        corrupt("Queue authority key is invalid")
    })
}

/// Called only with the queue root lock held, for a key this call created and whose marker
/// was never published. No proof can exist for such a key, so removing it loses nothing.
fn discard_unused_key(data: &Path) {
    if matches!(marker(data), Ok(None)) {
        let _ = std::fs::remove_file(data.join(KEY));
        let _ = super::sync_directory(data);
    }
}

pub(super) struct QueueCipher {
    dedicated: Option<VaultCipher>,
    legacy: Option<VaultCipher>,
}
impl QueueCipher {
    pub(super) fn encrypt(&self, value: &str) -> Result<String, String> {
        let ciphertext = self
            .dedicated
            .as_ref()
            .ok_or("Queue authority key is unavailable")?
            .encrypt(value)?;
        Ok(format!("queue:v1:{ciphertext}"))
    }
    pub(super) fn decrypt(&self, value: &str) -> Result<String, String> {
        if let Some(ciphertext) = value.strip_prefix("queue:v1:") {
            return self
                .dedicated
                .as_ref()
                .ok_or_else(|| "Queue authority key is unavailable".to_string())?
                .decrypt_with_write_key(ciphertext);
        }
        if self.dedicated.is_some() {
            return Err("Legacy queued message needs local reauthorization".into());
        }
        self.legacy
            .as_ref()
            .ok_or_else(|| "Legacy queue authority key is unavailable".to_string())?
            .decrypt(value)
    }
}

fn private_directory(path: &Path) -> Result<(), QueueError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| unavailable("Cannot inspect existing queue directory"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(corrupt("Existing queue directory is unsafe"));
    }
    Ok(())
}

fn hash_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What the first-installation scan learned about queue files it could not trust.
#[derive(Debug, Default, PartialEq, Eq)]
struct ScanReport {
    /// Damaged queue files, directories or stray entries below an owner. Each stays preserved
    /// and unreadable, so only that owner's queue is held; installation does not depend on them.
    damaged: usize,
}

/// Outcome for one entry below an owner/workspace directory.
enum QueueFile {
    Clean,
    Damaged,
}

fn queue_file(
    path: &Path,
    name: &str,
    owner_hash: Option<&str>,
    workspace_hash: Option<&str>,
    bytes: &mut u64,
) -> Result<QueueFile, QueueError> {
    let Some(session) = name
        .strip_suffix(".json")
        .and_then(|value| value.strip_prefix("ss-"))
    else {
        return Ok(QueueFile::Damaged);
    };
    if uuid::Uuid::parse_str(session).is_err() {
        return Ok(QueueFile::Damaged);
    }
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    let Ok(file) = options.open(path) else {
        return Ok(QueueFile::Damaged);
    };
    let Ok(metadata) = file.metadata() else {
        return Ok(QueueFile::Damaged);
    };
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > MAX_FILE_BYTES
    {
        return Ok(QueueFile::Damaged);
    }
    *bytes = bytes
        .checked_add(metadata.len())
        .ok_or_else(|| unavailable("Queue authority scan limit exceeded"))?;
    if *bytes > MAX_SCAN_BYTES {
        return Err(unavailable(
            "Queue authority scan limit exceeded; preserve existing data for recovery",
        ));
    }
    let mut content = Vec::new();
    if file
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut content)
        .is_err()
        || content.len() as u64 > MAX_FILE_BYTES
    {
        return Ok(QueueFile::Damaged);
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&content) else {
        return Ok(QueueFile::Damaged);
    };
    // A claim made by any readable file, even one this version cannot otherwise
    // validate, proves that a previous installation existed.
    if value
        .get("queueAuthorityInstallation")
        .is_some_and(|claim| !claim.is_null())
    {
        return Err(unavailable(
            "Queue authority installation marker is missing; preserve existing data for recovery",
        ));
    }
    let Ok(envelope) = serde_json::from_value::<Envelope>(value) else {
        return Ok(QueueFile::Damaged);
    };
    if envelope.schema_version != SCHEMA_VERSION
        || envelope.parent_session_id != format!("ss-{session}")
        || owner_hash != Some(digest(envelope.owner.as_bytes()).as_str())
        || workspace_hash != Some(digest(envelope.workspace.as_bytes()).as_str())
        || !Path::new(&envelope.workspace).is_absolute()
    {
        return Ok(QueueFile::Damaged);
    }
    let scope = QueueScope {
        owner: envelope.owner.clone(),
        workspace: PathBuf::from(&envelope.workspace),
        parent_session_id: envelope.parent_session_id.clone(),
    };
    if validate_envelope(&envelope, &scope, Limits::default()).is_err() {
        return Ok(QueueFile::Damaged);
    }
    for proof in envelope.authority_proofs.values() {
        let well_formed = proof.strip_prefix("enc:v2:").is_some_and(|rest| {
            rest.split_once(':').is_some_and(|(nonce, ciphertext)| {
                nonce.len() == 24
                    && ciphertext.len() >= 32
                    && ciphertext.len() % 2 == 0
                    && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && ciphertext.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        });
        if !well_formed {
            return Ok(QueueFile::Damaged);
        }
    }
    Ok(QueueFile::Clean)
}

/// Looks for evidence that this data directory was installed before (a queue that names an
/// installation) and bounds the amount of work. Damage that belongs to one queue is counted,
/// not fatal: it can neither authorize anything nor hide in a way that lets old proofs verify,
/// because every proof is later checked against this installation's own key and identity.
fn scan_existing(data: &Path, budget: std::time::Duration) -> Result<ScanReport, QueueError> {
    let started = std::time::Instant::now();
    let mut report = ScanReport::default();
    let base = data.join("followup-queues");
    match std::fs::symlink_metadata(&base) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(_) => return Err(unavailable("Cannot inspect existing queues")),
        Ok(_) => private_directory(&base)?,
    }
    let mut stack: Vec<(PathBuf, u8, Option<String>, Option<String>)> = vec![(base, 0, None, None)];
    let mut entries = 0usize;
    let mut bytes = 0u64;
    while let Some((directory, depth, owner_hash, workspace_hash)) = stack.pop() {
        let attributable = depth > 0;
        let listing = match std::fs::read_dir(&directory) {
            Ok(listing) => listing,
            Err(_) if attributable => {
                report.damaged += 1;
                continue;
            }
            Err(_) => return Err(unavailable("Cannot read existing queue directory")),
        };
        for entry in listing {
            entries = entries
                .checked_add(1)
                .ok_or_else(|| unavailable("Queue authority scan limit exceeded"))?;
            if entries > MAX_ENTRIES {
                return Err(unavailable(
                    "Queue authority scan limit exceeded; preserve existing data for recovery",
                ));
            }
            if started.elapsed() >= budget {
                return Err(unavailable(
                    "Queue authority scan took too long; nothing was installed, retry",
                ));
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) if attributable => {
                    report.damaged += 1;
                    break;
                }
                Err(_) => return Err(unavailable("Cannot read existing queue directory")),
            };
            let Ok(name) = entry.file_name().into_string() else {
                if attributable {
                    report.damaged += 1;
                    continue;
                }
                return Err(corrupt("Existing queue path is invalid"));
            };
            if depth < 2 {
                if !hash_name(&name) {
                    if attributable {
                        report.damaged += 1;
                        continue;
                    }
                    return Err(corrupt(
                        "Existing queue directory contains an unknown entry",
                    ));
                }
                if private_directory(&entry.path()).is_err() {
                    report.damaged += 1;
                    continue;
                }
                let next_owner = if depth == 0 {
                    Some(name.clone())
                } else {
                    owner_hash.clone()
                };
                let next_workspace = if depth == 1 {
                    Some(name)
                } else {
                    workspace_hash.clone()
                };
                stack.push((entry.path(), depth + 1, next_owner, next_workspace));
                continue;
            }
            if let QueueFile::Damaged = queue_file(
                &entry.path(),
                &name,
                owner_hash.as_deref(),
                workspace_hash.as_deref(),
                &mut bytes,
            )? {
                report.damaged += 1;
            }
        }
    }
    Ok(report)
}

fn revalidate(check: Option<&dyn Fn() -> Result<(), String>>) -> Result<(), QueueError> {
    match check {
        Some(check) => check().map_err(|error| super::conflict(&error)),
        None => Ok(()),
    }
}

/// Publishes the installation marker for `dedicated`, whose key was just created
/// (`created`) or was found without a marker (an interrupted earlier initialization).
fn publish_marker(
    data: &Path,
    dedicated: &VaultCipher,
    check: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<Uuid, QueueError> {
    let mut id = Uuid::new_v4();
    let encoded = dedicated
        .encrypt(&marker_value(data, id)?)
        .map_err(|_| unavailable("Cannot encode queue authority marker"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(data)
        .map_err(|_| unavailable("Cannot prepare queue authority marker"))?;
    temporary
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| unavailable("Cannot protect queue authority marker"))?;
    temporary
        .write_all(encoded.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| unavailable("Cannot write queue authority marker"))?;
    revalidate(check)?;
    match temporary.persist_noclobber(data.join(MARKER)) {
        Ok(_) => {}
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            let value =
                marker(data)?.ok_or_else(|| unavailable("Queue authority marker disappeared"))?;
            id = check_marker(dedicated, data, &value)?;
        }
        Err(_) => return Err(unavailable("Cannot publish queue authority marker")),
    }
    // Once published the installation is kept even if its synchronization cannot be confirmed:
    // the next call finds the marker and the (already synchronized) key together.
    super::sync_directory(data).map_err(|_| {
        unavailable(
            "Queue authority installation could not be synchronized; it was kept, retry to confirm",
        )
    })?;
    Ok(id)
}

/// Caller holds the queue store's cross-process root lock throughout initialization.
///
/// Cancellation (`check` failing) at any point before the marker is published leaves the data
/// directory as it was found: a key created by this call is removed, a key found without a
/// marker (an earlier interrupted initialization, which can have signed nothing) is kept.
pub(super) fn load_for_write(
    data: &Path,
    check: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<(QueueCipher, Uuid), QueueError> {
    if let Some(value) = marker(data)? {
        let dedicated = existing_key(data)?.ok_or_else(|| {
            unavailable(
                "Queue authority key is unavailable; preserve the installation for recovery",
            )
        })?;
        let id = check_marker(&dedicated, data, &value)?;
        return Ok((
            QueueCipher {
                dedicated: Some(dedicated),
                legacy: None,
            },
            id,
        ));
    }
    revalidate(check)?;
    let report = scan_existing(data, SCAN_BUDGET)?;
    // The scan reads every queue file; slow storage may have outlasted the credential.
    revalidate(check)?;
    let (dedicated, created) = match existing_key(data)? {
        Some(cipher) => (cipher, false),
        None => (create_key(data, check)?, true),
    };
    let id = match publish_marker(data, &dedicated, check) {
        Ok(id) => id,
        Err(error) => {
            if created {
                discard_unused_key(data);
            }
            return Err(error);
        }
    };
    if report.damaged > 0 {
        tracing::warn!(
            damaged = report.damaged,
            "Queue authority installed; damaged queue entries stay preserved and held"
        );
    }
    Ok((
        QueueCipher {
            dedicated: Some(dedicated),
            legacy: None,
        },
        id,
    ))
}

pub(super) fn load_for_read(
    data: &Path,
    installation: Option<Uuid>,
) -> Result<QueueCipher, QueueError> {
    if let Some(expected) = installation {
        let value = marker(data)?
            .ok_or_else(|| unavailable("Queue authority installation marker is unavailable"))?;
        let dedicated =
            existing_key(data)?.ok_or_else(|| unavailable("Queue authority key is unavailable"))?;
        if check_marker(&dedicated, data, &value)? != expected {
            return Err(corrupt("Queue authority installation changed"));
        }
        Ok(QueueCipher {
            dedicated: Some(dedicated),
            legacy: None,
        })
    } else {
        Err(unavailable(
            "Legacy queued message needs local reauthorization",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::{fault, now_ms, DispatchOutcome, IdleBoundary};
    use super::super::{Mutation, QueueError, QueueOperation, QueueScope, QueueStore};
    use super::*;
    use std::cell::Cell;

    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    struct Fixture {
        data: tempfile::TempDir,
        workspace: tempfile::TempDir,
        store: QueueStore,
    }

    impl Fixture {
        fn new() -> Self {
            let data = tempfile::tempdir().unwrap();
            Self {
                store: QueueStore::new(data.path(), id(1)),
                data,
                workspace: tempfile::tempdir().unwrap(),
            }
        }
        fn scope(&self, owner: &str, session: u128) -> QueueScope {
            QueueScope::new(owner, self.workspace.path(), &format!("ss-{session:032x}")).unwrap()
        }
        fn key(&self) -> PathBuf {
            self.data.path().join(KEY)
        }
        fn marker(&self) -> PathBuf {
            self.data.path().join(MARKER)
        }
        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = std::fs::read_dir(self.data.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .filter(|name| name != "followup-queues")
                .collect();
            names.sort();
            names
        }
        fn installed(&self) -> Vec<String> {
            let mut names = vec![KEY.to_string(), MARKER.to_string()];
            names.sort();
            names
        }
    }

    fn enqueue(operation: u128, item: u128, revision: u64) -> Mutation {
        Mutation {
            operation_id: id(operation),
            expected_queue_revision: revision,
            operation: QueueOperation::Enqueue {
                item_id: id(item),
                text: format!("message {item}"),
                run_when_idle: false,
            },
        }
    }

    fn authority(owner: &str) -> crate::auth::LocalAuthority {
        crate::auth::LocalAuthority::for_test(owner, 0, now_ms() + 60_000)
    }

    fn authorized(fixture: &Fixture, scope: &QueueScope, operation: u128, item: u128) {
        fixture
            .store
            .mutate_authorized(
                scope,
                id(77),
                enqueue(operation, item, 0),
                &authority(&scope.owner),
            )
            .unwrap();
    }

    fn dispatch_is_authorized(fixture: &Fixture, scope: &QueueScope, revision: u64) -> bool {
        fixture
            .store
            .mutate(
                scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: revision,
                    operation: QueueOperation::Resume,
                },
            )
            .unwrap();
        let reservation = fixture
            .store
            .reserve_next(scope, revision + 1, IdleBoundary { turn_epoch: 1 })
            .unwrap()
            .unwrap();
        fixture
            .store
            .verify_reservation_authority(scope, id(77), &reservation)
            .map(|verified| verified.is_some())
            .unwrap_or(false)
    }

    fn private_file(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// Legacy preview proofs were sealed with the shared vault key, not the dedicated one.
    fn legacy_proof(plaintext: &str) -> String {
        VaultCipher::from_queue_installation_key("ab".repeat(32))
            .unwrap()
            .encrypt(plaintext)
            .unwrap()
    }

    #[test]
    fn damage_that_belongs_to_one_owner_does_not_block_installation_for_another() {
        type Damage = fn(&Path);
        let cases: [(&str, Damage); 6] = [
            ("malformed JSON", |queue| private_file(queue, b"{malformed")),
            ("unsafe permissions", |queue| {
                std::fs::set_permissions(queue, std::fs::Permissions::from_mode(0o644)).unwrap()
            }),
            ("oversized file", |queue| {
                let file = std::fs::OpenOptions::new().write(true).open(queue).unwrap();
                file.set_len(MAX_FILE_BYTES + 1).unwrap();
            }),
            ("unknown field", |queue| {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(queue).unwrap()).unwrap();
                value["fromANewerVersion"] = true.into();
                private_file(queue, value.to_string().as_bytes());
            }),
            ("malformed legacy proof", |queue| {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(queue).unwrap()).unwrap();
                value["queueIdentity"] = id(12).to_string().into();
                value["authorityProofs"] =
                    serde_json::json!({ id(11).to_string(): "enc:v2:00:00" });
                private_file(queue, value.to_string().as_bytes());
            }),
            ("interrupted commit leftover", |queue| {
                private_file(&queue.with_file_name(".tmpInterrupted"), b"partial")
            }),
        ];
        for (name, damage) in cases {
            let fixture = Fixture::new();
            let damaged = fixture.scope("owner-A", 2);
            fixture.store.mutate(&damaged, enqueue(10, 11, 0)).unwrap();
            let queue = fixture.store.path(&damaged).unwrap();
            damage(&queue);
            let before = std::fs::read(&queue).unwrap();
            let other = fixture.scope("owner-B", 3);

            authorized(&fixture, &other, 20, 21);

            assert_eq!(fixture.names(), fixture.installed(), "{name}");
            assert_eq!(std::fs::read(&queue).unwrap(), before, "{name}");
            let revision = fixture.store.inspect(&other).unwrap().unwrap().revision;
            assert!(dispatch_is_authorized(&fixture, &other, revision), "{name}");
        }
    }

    #[test]
    fn a_damaged_queue_stays_preserved_and_unusable_for_its_own_owner() {
        let fixture = Fixture::new();
        let damaged = fixture.scope("owner-A", 2);
        fixture.store.mutate(&damaged, enqueue(10, 11, 0)).unwrap();
        let queue = fixture.store.path(&damaged).unwrap();
        private_file(&queue, b"{malformed");
        authorized(&fixture, &fixture.scope("owner-B", 3), 20, 21);

        assert!(matches!(
            fixture.store.inspect(&damaged),
            Err(QueueError::Corrupt(_))
        ));
        assert!(matches!(
            fixture.store.mutate_authorized(
                &damaged,
                id(77),
                enqueue(12, 13, 1),
                &authority("owner-A")
            ),
            Err(QueueError::Corrupt(_))
        ));
        assert_eq!(std::fs::read(&queue).unwrap(), b"{malformed");
    }

    #[test]
    fn an_overlong_scan_installs_nothing_and_can_be_retried() {
        let fixture = Fixture::new();
        fixture
            .store
            .mutate(&fixture.scope("owner-A", 2), enqueue(10, 11, 0))
            .unwrap();
        let error = scan_existing(fixture.data.path(), std::time::Duration::ZERO).unwrap_err();
        assert!(matches!(error, QueueError::Unavailable(_)), "{error:?}");
        assert_eq!(fixture.names(), Vec::<String>::new());
        assert_eq!(
            scan_existing(fixture.data.path(), SCAN_BUDGET).unwrap(),
            ScanReport { damaged: 0 }
        );
    }

    #[test]
    fn a_queue_naming_an_installation_blocks_replacement_even_if_otherwise_unreadable() {
        let fixture = Fixture::new();
        let old = fixture.scope("owner-A", 2);
        fixture.store.mutate(&old, enqueue(10, 11, 0)).unwrap();
        let queue = fixture.store.path(&old).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&queue).unwrap()).unwrap();
        value["fromANewerVersion"] = true.into();
        value["queueAuthorityInstallation"] = id(5).to_string().into();
        private_file(&queue, value.to_string().as_bytes());
        let before = std::fs::read(&queue).unwrap();

        assert!(matches!(
            fixture.store.mutate_authorized(
                &fixture.scope("owner-B", 3),
                id(77),
                enqueue(20, 21, 0),
                &authority("owner-B")
            ),
            Err(QueueError::Unavailable(_))
        ));

        assert_eq!(fixture.names(), Vec::<String>::new());
        assert_eq!(std::fs::read(&queue).unwrap(), before);
    }

    #[test]
    fn cancelling_initialization_at_any_revalidation_leaves_the_directory_as_found() {
        let counted = Cell::new(0usize);
        let counting = || {
            counted.set(counted.get() + 1);
            Ok(())
        };
        let probe = Fixture::new();
        load_for_write(probe.data.path(), Some(&counting)).unwrap();
        let revalidations = counted.get();
        assert!(revalidations >= 4, "{revalidations}");

        for cancelled_at in 0..revalidations {
            let fixture = Fixture::new();
            let calls = Cell::new(0usize);
            let cancelling = || {
                let call = calls.get();
                calls.set(call + 1);
                if call == cancelled_at {
                    Err("Credential revoked".to_owned())
                } else {
                    Ok(())
                }
            };
            let error = load_for_write(fixture.data.path(), Some(&cancelling))
                .err()
                .unwrap();
            assert_eq!(
                (cancelled_at, error),
                (
                    cancelled_at,
                    QueueError::Conflict("Credential revoked".into())
                )
            );
            assert_eq!(fixture.names(), Vec::<String>::new(), "call {cancelled_at}");

            load_for_write(fixture.data.path(), None).unwrap();
            assert_eq!(fixture.names(), fixture.installed());
        }
    }

    #[test]
    fn a_key_left_without_a_marker_by_an_interrupted_install_is_reused_not_replaced() {
        let fixture = Fixture::new();
        let orphan = "cd".repeat(32);
        private_file(&fixture.key(), orphan.as_bytes());

        // The orphan key is found, so the checks are: start, after the scan, before the marker.
        let calls = Cell::new(0usize);
        let cancelling = || {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                Err("Credential revoked".to_owned())
            } else {
                Ok(())
            }
        };
        assert!(load_for_write(fixture.data.path(), Some(&cancelling)).is_err());
        assert_eq!(calls.get(), 3);
        assert_eq!(std::fs::read(fixture.key()).unwrap(), orphan.as_bytes());
        assert!(!fixture.marker().exists());

        load_for_write(fixture.data.path(), None).unwrap();
        assert_eq!(std::fs::read(fixture.key()).unwrap(), orphan.as_bytes());
        assert_eq!(fixture.names(), fixture.installed());
    }

    #[test]
    fn unconfirmed_key_synchronization_installs_nothing_and_can_be_retried() {
        let fixture = Fixture::new();
        fault::fail_directory_sync_after(0);
        let error = load_for_write(fixture.data.path(), None).err().unwrap();
        fault::clear();
        assert!(matches!(error, QueueError::Unavailable(_)), "{error:?}");
        assert_eq!(fixture.names(), Vec::<String>::new());

        load_for_write(fixture.data.path(), None).unwrap();
        assert_eq!(fixture.names(), fixture.installed());
    }

    #[test]
    fn unconfirmed_marker_synchronization_keeps_one_installation_that_a_retry_confirms() {
        let fixture = Fixture::new();
        fault::fail_directory_sync_after(1);
        let error = load_for_write(fixture.data.path(), None).err().unwrap();
        fault::clear();
        assert!(matches!(error, QueueError::Unavailable(_)), "{error:?}");
        assert_eq!(fixture.names(), fixture.installed());
        let key = std::fs::read(fixture.key()).unwrap();
        let marker = std::fs::read(fixture.marker()).unwrap();

        let (_, installation) = load_for_write(fixture.data.path(), None).unwrap();
        assert_eq!(std::fs::read(fixture.key()).unwrap(), key);
        assert_eq!(std::fs::read(fixture.marker()).unwrap(), marker);
        let cipher = existing_key(fixture.data.path()).unwrap().unwrap();
        assert_eq!(
            check_marker(
                &cipher,
                fixture.data.path(),
                std::str::from_utf8(&marker).unwrap()
            )
            .unwrap(),
            installation
        );
    }

    #[test]
    fn an_unconfirmed_queue_commit_is_recovered_by_retrying_the_same_operation() {
        let fixture = Fixture::new();
        authorized(&fixture, &fixture.scope("owner-A", 2), 10, 11);
        let scope = fixture.scope("owner-B", 3);
        fixture.store.load(&scope).unwrap();
        let mutation = enqueue(20, 21, 0);

        fault::fail_directory_sync_after(0);
        let error = fixture
            .store
            .mutate_authorized(&scope, id(77), mutation.clone(), &authority("owner-B"))
            .unwrap_err();
        fault::clear();
        assert!(matches!(error, QueueError::Unavailable(_)), "{error:?}");

        let published = fixture.store.inspect(&scope).unwrap().unwrap();
        assert_eq!(published.items.len(), 1);
        let receipt = fixture
            .store
            .mutate_authorized(&scope, id(77), mutation, &authority("owner-B"))
            .unwrap();
        let recovered = fixture.store.inspect(&scope).unwrap().unwrap();
        assert_eq!(
            (
                receipt.queue_revision,
                recovered.items.len(),
                recovered.revision
            ),
            (published.revision, 1, published.revision)
        );
        assert!(dispatch_is_authorized(&fixture, &scope, published.revision));
    }

    #[test]
    fn a_lost_or_replaced_key_is_never_recreated_over_an_existing_installation() {
        let fixture = Fixture::new();
        let scope = fixture.scope("owner-A", 2);
        authorized(&fixture, &scope, 10, 11);
        let marker = std::fs::read(fixture.marker()).unwrap();
        let queue = std::fs::read(fixture.store.path(&scope).unwrap()).unwrap();
        let key = std::fs::read(fixture.key()).unwrap();
        let attempt = |fixture: &Fixture| {
            fixture.store.mutate_authorized(
                &scope,
                id(77),
                enqueue(12, 13, 1),
                &authority("owner-A"),
            )
        };

        std::fs::remove_file(fixture.key()).unwrap();
        assert!(matches!(attempt(&fixture), Err(QueueError::Unavailable(_))));
        assert_eq!(fixture.names(), vec![MARKER.to_string()]);
        assert_eq!(
            std::fs::read(fixture.store.path(&scope).unwrap()).unwrap(),
            queue
        );

        let other = "ef".repeat(32);
        private_file(&fixture.key(), other.as_bytes());
        assert!(matches!(attempt(&fixture), Err(QueueError::Unavailable(_))));
        assert_eq!(std::fs::read(fixture.key()).unwrap(), other.as_bytes());

        private_file(&fixture.key(), &key);
        attempt(&fixture).unwrap();
        assert_eq!(std::fs::read(fixture.marker()).unwrap(), marker);
    }

    #[test]
    fn legacy_proofs_never_become_trusted_by_any_prefix_or_installation_claim() {
        let fixture = Fixture::new();
        let legacy_scope = fixture.scope("owner-A", 2);
        fixture
            .store
            .mutate(&legacy_scope, enqueue(10, 11, 0))
            .unwrap();
        let queue_path = fixture.store.path(&legacy_scope).unwrap();
        let mut envelope = fixture
            .store
            .read(&queue_path, &legacy_scope)
            .unwrap()
            .unwrap();
        let item = envelope.queue.items[0].clone();
        let claims = super::super::AuthorityClaims {
            version: 1,
            owner: legacy_scope.owner.clone(),
            data_root: canonical_authority_root(fixture.data.path()).unwrap(),
            workspace: legacy_scope.workspace.to_str().unwrap().into(),
            parent_session_id: legacy_scope.parent_session_id.clone(),
            session_incarnation: id(77),
            queue_identity: id(12),
            item_id: item.item_id,
            input_request_id: item.input_request_id,
            text_digest: digest(item.text.as_bytes()),
            generation: 0,
            expires_at_ms: now_ms() + 60_000,
            auth_protocol: None,
            auth_session_id: None,
            paired_grant: None,
        };
        let proof = legacy_proof(&serde_json::to_string(&claims).unwrap());
        envelope.queue_identity = Some(id(12));
        envelope
            .authority_proofs
            .insert(item.item_id, proof.clone());
        fixture
            .store
            .commit(&queue_path, &envelope, &legacy_scope)
            .unwrap();

        authorized(&fixture, &fixture.scope("owner-B", 3), 20, 21);
        let installation = {
            let cipher = existing_key(fixture.data.path()).unwrap().unwrap();
            let marker = std::fs::read_to_string(fixture.marker()).unwrap();
            check_marker(&cipher, fixture.data.path(), &marker).unwrap()
        };

        let forms = [
            ("as stored", proof.clone(), None),
            (
                "claiming the installation",
                proof.clone(),
                Some(installation),
            ),
            (
                "wrapped as a queue proof",
                format!("queue:v1:{proof}"),
                Some(installation),
            ),
        ];
        for (name, proof, claimed) in forms {
            let mut forged = fixture
                .store
                .read(&queue_path, &legacy_scope)
                .unwrap()
                .unwrap();
            forged.queue_authority_installation = claimed;
            forged.authority_proofs.insert(item.item_id, proof);
            fixture
                .store
                .commit(&queue_path, &forged, &legacy_scope)
                .unwrap();
            let held = fixture.store.inspect(&legacy_scope).unwrap().unwrap();
            fixture
                .store
                .mutate(
                    &legacy_scope,
                    Mutation {
                        operation_id: Uuid::new_v4(),
                        expected_queue_revision: held.revision,
                        operation: QueueOperation::Resume,
                    },
                )
                .unwrap();
            let current = fixture.store.inspect(&legacy_scope).unwrap().unwrap();
            let reservation = fixture
                .store
                .reserve_next(
                    &legacy_scope,
                    current.revision,
                    IdleBoundary { turn_epoch: 1 },
                )
                .unwrap()
                .unwrap();
            assert!(
                fixture
                    .store
                    .verify_reservation_authority(&legacy_scope, id(77), &reservation)
                    .is_err(),
                "{name}"
            );
            fixture
                .store
                .reconcile_dispatch(
                    &legacy_scope,
                    item.item_id,
                    item.input_request_id,
                    DispatchOutcome::DefinitelyAbsent,
                )
                .unwrap();
        }
    }
}
