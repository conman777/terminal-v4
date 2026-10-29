use super::*;
use std::io::Read;
use std::io::Write;

#[derive(Clone)]
pub(super) struct Cursor {
    content_hash: Sha256,
    revision: Option<FileRevision>,
    pub file_len: u64,
    pub event_bytes: usize,
    pub event_count: usize,
    pub tail_records: usize,
    pub tail_bytes: usize,
    pub recovery_required: bool,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileRevision {
    modified: std::time::SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
}

fn file_revision(metadata: &fs::Metadata) -> Option<FileRevision> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Some(FileRevision {
        modified: metadata.modified().ok()?,
        #[cfg(unix)]
        changed: (metadata.ctime(), metadata.ctime_nsec()),
    })
}

impl Cursor {
    pub fn checkpoint(
        metadata: &fs::Metadata,
        snapshot: &StructuredSessionSnapshot,
        payload: &[u8],
    ) -> Result<Self, String> {
        let event_bytes = serde_json::to_vec(&snapshot.events)
            .map_err(|error| error.to_string())?
            .len()
            - 2;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            content_hash: Sha256::new_with_prefix(payload),
            revision: file_revision(metadata),
            file_len: metadata.len(),
            event_bytes,
            event_count: snapshot.events.len(),
            tail_records: 0,
            tail_bytes: 0,
            recovery_required: false,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint<'a> {
    version: u8,
    owner_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_incarnation: Option<SessionIncarnation>,
    snapshot: &'a StructuredSessionSnapshot,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub event: StructuredSessionEvent,
}

pub(super) fn encode_checkpoint(
    owner: &str,
    snapshot: &StructuredSessionSnapshot,
    session_incarnation: Option<SessionIncarnation>,
) -> Result<Vec<u8>, String> {
    let mut payload = serde_json::to_vec(&Checkpoint {
        version: 2,
        owner_id: owner,
        session_incarnation,
        snapshot,
    })
    .map_err(|error| error.to_string())?;
    if payload.len() > MAX_STRUCTURED_BYTES || snapshot.events.len() > MAX_STRUCTURED_EVENTS {
        return Err("Structured conversation storage is full".into());
    }
    payload.push(b'\n');
    Ok(payload)
}

pub(crate) fn decode(bytes: &[u8]) -> Result<StoredStructuredSession, String> {
    if bytes.len() > MAX_STRUCTURED_FILE_BYTES {
        return Err("Structured history exceeds its file limit".into());
    }
    if let Ok(stored) = serde_json::from_slice::<StoredStructuredSession>(bytes) {
        if stored.version == 1 {
            validate(&stored)?;
            return Ok(stored);
        }
    }
    let boundary = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or("Structured history checkpoint is incomplete")?;
    let mut stored: StoredStructuredSession = serde_json::from_slice(&bytes[..boundary])
        .map_err(|_| "Structured history checkpoint is invalid")?;
    if stored.version != 2 {
        return Err("Structured history version is unsupported".into());
    }
    let tail = &bytes[boundary + 1..];
    // A record is committed only with its newline. A torn final append is never replayed.
    let mut lines = tail.split(|byte| *byte == b'\n');
    let mut current = lines.next().unwrap_or_default();
    for next in lines {
        let record: Record = serde_json::from_slice(current)
            .map_err(|_| "Structured history contains an invalid committed record")?;
        if record.event.seq() != next_session_seq(&stored.snapshot.events)? {
            return Err("Structured history record sequence is invalid".into());
        }
        if stored.snapshot.events.len() >= MAX_STRUCTURED_EVENTS {
            return Err("Structured history exceeds its event limit".into());
        }
        let barrier = matches!(
            stored.snapshot.status.as_deref(),
            Some("cleanup_required" | "reconciliation_required")
        );
        if let Some(status) = record.status {
            stored.snapshot.status = Some(status);
        } else if !barrier {
            if let Some(status) = event_status(&record.event) {
                stored.snapshot.status = Some(status.into());
            }
        }
        stored.snapshot.events.push(record.event);
        stored.snapshot.updated_at = record.updated_at;
        touch_structured_thread(stored.snapshot.thread.as_mut(), &stored.snapshot.updated_at);
        current = next;
    }
    validate(&stored)?;
    Ok(stored)
}

fn validate(stored: &StoredStructuredSession) -> Result<(), String> {
    if stored.snapshot.events.len() > MAX_STRUCTURED_EVENTS
        || serde_json::to_vec(stored)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_STRUCTURED_BYTES
    {
        return Err("Structured conversation storage is full".into());
    }
    Ok(())
}

fn open_existing(config: &AppConfig, owner: &str, id: &str) -> Result<fs::File, String> {
    let directory = structured_user_dir(config, owner);
    for path in [
        &config.data_dir,
        &config.data_dir.join("structured-sessions"),
        &directory,
    ] {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Structured history directories must not be symlinked".into());
        }
    }
    let path = structured_session_path(config, owner, id);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Structured history must be an existing regular file".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    Ok(file)
}

pub(super) fn read_for_recovery(
    config: &AppConfig,
    owner: &str,
    id: &str,
) -> Result<StoredStructuredSession, String> {
    let file = open_existing(config, owner, id)?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_STRUCTURED_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("Structured history changed during recovery".into());
    }
    decode(&bytes)
}

pub(super) fn open_committed(
    config: &AppConfig,
    owner: &str,
    id: &str,
    cursor: &Cursor,
) -> Result<fs::File, String> {
    let file = open_existing(config, owner, id)?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.dev() != cursor.device
            || metadata.ino() != cursor.inode
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("Structured history file identity changed".into());
        }
    }
    if !metadata.is_file() || metadata.len() != cursor.file_len {
        return Err("Structured history changed outside its writer; reload before retrying".into());
    }
    if cursor.revision.is_none() || file_revision(&metadata) != cursor.revision {
        verify_checkpoint_for_rewrite(config, owner, id, cursor)?;
        let after = file.metadata().map_err(|error| error.to_string())?;
        let current = fs::symlink_metadata(structured_session_path(config, owner, id))
            .map_err(|error| error.to_string())?;
        if !current.is_file()
            || current.file_type().is_symlink()
            || after.len() != cursor.file_len
            || file_revision(&after) != file_revision(&metadata)
            || file_revision(&current) != file_revision(&after)
        {
            return Err("Structured history changed during validation".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if after.dev() != cursor.device
                || after.ino() != cursor.inode
                || current.dev() != after.dev()
                || current.ino() != after.ino()
                || after.permissions().mode() & 0o077 != 0
                || current.permissions().mode() & 0o077 != 0
            {
                return Err("Structured history file identity changed during validation".into());
            }
        }
    }
    Ok(file)
}

pub(super) fn verify_checkpoint_for_rewrite(
    config: &AppConfig,
    owner: &str,
    id: &str,
    cursor: &Cursor,
) -> Result<(), String> {
    let mut file = open_existing(config, owner, id)?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if !before.is_file() || before.len() != cursor.file_len {
        return Err("Structured history changed outside its writer; reload before retrying".into());
    }
    let mut hash = Sha256::new();
    let mut reader = (&mut file).take(cursor.file_len.saturating_add(1));
    let mut buffer = [0u8; 8192];
    let mut read = 0u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        read += count as u64;
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|error| error.to_string())?;
    let path = structured_session_path(config, owner, id);
    let current = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || after.dev() != current.dev()
            || after.ino() != current.ino()
        {
            return Err("Structured history file identity changed during validation".into());
        }
        if before.permissions().mode() & 0o077 != 0
            || after.permissions().mode() & 0o077 != 0
            || current.permissions().mode() & 0o077 != 0
        {
            return Err("Structured history file permissions are not private".into());
        }
    }
    if !current.is_file()
        || current.file_type().is_symlink()
        || read != cursor.file_len
        || before.len() != after.len()
        || file_revision(&before) != file_revision(&after)
        || file_revision(&current) != file_revision(&after)
        || hash.finalize() != cursor.content_hash.clone().finalize()
    {
        return Err("Structured history changed outside its writer; reload before retrying".into());
    }
    Ok(())
}

pub(super) fn append(
    config: &AppConfig,
    owner: &str,
    id: &str,
    cursor: &Cursor,
    record: &Record,
    event_bytes: usize,
    before_publish: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<Cursor, String> {
    let mut file = open_committed(config, owner, id, cursor)?;
    let mut payload = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    payload.push(b'\n');
    if cursor.file_len + payload.len() as u64 > MAX_STRUCTURED_FILE_BYTES as u64 {
        return Err("Structured history journal is full".into());
    }
    if let Some(check) = before_publish {
        check()?;
    }
    if let Err(error) = file.write_all(&payload).and_then(|_| file.sync_all()) {
        return match file.set_len(cursor.file_len).and_then(|_| file.sync_all()) {
            Ok(()) => Err(error.to_string()),
            Err(rollback) => Err(format!(
                "Structured history requires recovery: {error}; rollback: {rollback}"
            )),
        };
    }
    let mut next = cursor.clone();
    next.content_hash.update(&payload);
    next.revision = file
        .metadata()
        .ok()
        .and_then(|metadata| file_revision(&metadata));
    next.file_len += payload.len() as u64;
    next.event_bytes += event_bytes + usize::from(cursor.event_count > 0);
    next.event_count += 1;
    next.tail_records += 1;
    next.tail_bytes += payload.len();
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> StructuredSessionSnapshot {
        StructuredSessionSnapshot {
            id: format!("ss-{}", Uuid::new_v4()),
            title: "Saved conversation".into(),
            cwd: std::env::temp_dir().to_string_lossy().into(),
            provider: "claude".into(),
            runtime: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            model: None,
            status: Some("idle".into()),
            created_at: "2026-10-20T12:00:00Z".into(),
            updated_at: "2026-10-20T12:00:00Z".into(),
            thread: None,
            events: vec![],
        }
    }

    fn event(seq: i64) -> StructuredSessionEvent {
        StructuredSessionEvent::MessageDelta {
            ts: seq,
            seq,
            message_id: None,
            turn_id: None,
            role: "assistant".into(),
            content: "Saved Unicode: 🐈\nquoted \"text\"".into(),
        }
    }

    fn header(version: u8) -> Vec<u8> {
        serde_json::to_vec(&StoredStructuredSession {
            version,
            owner_id: "owner".into(),
            session_incarnation: None,
            snapshot: snapshot(),
        })
        .unwrap()
    }

    fn record(seq: i64) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "updatedAt":"2026-10-20T12:00:01Z", "event":event(seq)
        }))
        .unwrap()
    }

    #[test]
    fn reads_complete_pretty_printed_v1_snapshots() {
        let stored: Value = serde_json::from_slice(&header(1)).unwrap();
        let bytes = serde_json::to_vec_pretty(&stored).unwrap();
        let recovered = decode(&bytes).unwrap();
        assert_eq!(
            (recovered.owner_id.as_str(), recovered.snapshot.events),
            ("owner", vec![])
        );
    }

    #[test]
    fn reads_complete_journal_records_and_ignores_only_unterminated_tail() {
        let mut bytes = header(2);
        bytes.push(b'\n');
        bytes.extend(record(1));
        bytes.push(b'\n');
        bytes.extend_from_slice(b"{\"event\":");
        let recovered = decode(&bytes).unwrap();
        assert_eq!(
            (recovered.snapshot.events, recovered.snapshot.updated_at),
            (vec![event(1)], "2026-10-20T12:00:01Z".into())
        );
    }

    #[test]
    fn rejects_complete_corruption_sequence_gaps_and_uncommitted_header() {
        let mut base = header(2);
        assert!(decode(&base).is_err());
        base.push(b'\n');
        for tail in [b"invalid\n".to_vec(), [record(2), vec![b'\n']].concat()] {
            assert!(decode(&[base.clone(), tail].concat()).is_err());
        }
    }

    #[test]
    fn checkpoint_and_neutral_tail_preserve_cleanup_barriers() {
        for status in ["cleanup_required", "reconciliation_required"] {
            let mut snapshot = snapshot();
            snapshot.status = Some(status.into());
            let mut bytes = encode_checkpoint("owner", &snapshot, None).unwrap();
            assert_eq!(
                decode(&bytes).unwrap().snapshot.status.as_deref(),
                Some(status)
            );
            bytes.extend(record(1));
            bytes.push(b'\n');
            assert_eq!(
                decode(&bytes).unwrap().snapshot.status.as_deref(),
                Some(status)
            );
        }
    }

    fn manager(data: &Path) -> StructuredSessionManager {
        StructuredSessionManager::new(AppConfig {
            data_dir: data.into(),
            ..Default::default()
        })
    }

    async fn session(manager: &StructuredSessionManager) -> StructuredSessionSnapshot {
        manager
            .create_session(
                "owner",
                std::env::temp_dir().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap()
    }

    fn checkpoint_value(path: &Path) -> Value {
        let bytes = fs::read(path).unwrap();
        serde_json::from_slice(bytes.split(|byte| *byte == b'\n').next().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn creating_a_reserved_checkpoint_never_overwrites_an_existing_session() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let existing = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &existing.id);
        let original = fs::read(&path).unwrap();
        let mut candidate = existing.clone();
        candidate.title = "Different synthetic task".into();
        assert!(manager
            .persist_new_snapshot(
                "owner",
                &candidate,
                Some(SessionIncarnation(Uuid::new_v4()))
            )
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        manager
            .record_event("owner", &existing.id, event(1))
            .await
            .unwrap();
        assert_eq!(
            decode(&fs::read(&path).unwrap()).unwrap().snapshot.events,
            vec![event(1)]
        );

        candidate.id = format!("ss-{}", Uuid::new_v4().simple());
        manager
            .persist_new_snapshot(
                "owner",
                &candidate,
                Some(SessionIncarnation(Uuid::new_v4())),
            )
            .unwrap();
        let created = structured_session_path(&manager.inner.config, "owner", &candidate.id);
        assert_eq!(
            decode(&fs::read(&created).unwrap()).unwrap().snapshot,
            candidate
        );
        let saved = fs::read(&created).unwrap();
        drop(manager);
        let restarted = self::manager(data.path());
        candidate.title = "Replacement after restart".into();
        assert!(restarted
            .persist_new_snapshot(
                "owner",
                &candidate,
                Some(SessionIncarnation(Uuid::new_v4()))
            )
            .is_err());
        assert_eq!(fs::read(created).unwrap(), saved);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "invoked by the cross-process checkpoint creation test"]
    fn reserved_checkpoint_process_fixture() {
        use std::time::{Duration, Instant};
        let root = PathBuf::from(std::env::var_os("V4_CREATE_CHECKPOINT_ROOT").unwrap());
        let worker = std::env::var("V4_CREATE_CHECKPOINT_WORKER").unwrap();
        let mut candidate = snapshot();
        candidate.id = std::env::var("V4_CREATE_CHECKPOINT_ID").unwrap();
        candidate.title = format!("Synthetic task {worker}");
        fs::write(root.join(format!("ready-{worker}")), b"ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join("start").exists() {
            assert!(Instant::now() < deadline, "creation race did not start");
            std::thread::sleep(Duration::from_millis(5));
        }
        let manager = manager(&root.join("data"));
        let outcome = if manager
            .persist_new_snapshot(
                "owner",
                &candidate,
                Some(SessionIncarnation(Uuid::new_v4())),
            )
            .is_ok()
        {
            "created"
        } else {
            "rejected"
        };
        fs::write(root.join(format!("result-{worker}")), outcome).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cross_process_reserved_checkpoint_creation_has_one_winner() {
        use std::time::{Duration, Instant};
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        let id = format!("ss-{}", Uuid::new_v4().simple());
        let executable = std::env::current_exe().unwrap();
        let mut children: Vec<_> = (1..=4)
            .map(|worker| {
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "structured::storage::tests::reserved_checkpoint_process_fixture",
                        "--ignored",
                    ])
                    .env("V4_CREATE_CHECKPOINT_ROOT", root.path())
                    .env("V4_CREATE_CHECKPOINT_WORKER", worker.to_string())
                    .env("V4_CREATE_CHECKPOINT_ID", &id)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !(1..=4).all(|worker| root.path().join(format!("ready-{worker}")).exists()) {
            if Instant::now() >= deadline {
                for child in &mut children {
                    let _ = child.kill();
                }
                panic!("checkpoint race writers did not start");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(root.path().join("start"), b"start").unwrap();
        for child in &mut children {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    panic!("checkpoint race writer did not finish");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let outcomes: Vec<_> = (1..=4)
            .map(|worker| fs::read_to_string(root.path().join(format!("result-{worker}"))).unwrap())
            .collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| *outcome == "created")
                .count(),
            1
        );
        let winner = outcomes
            .iter()
            .position(|outcome| outcome == "created")
            .unwrap()
            + 1;
        let manager = manager(&root.path().join("data"));
        let path = structured_session_path(&manager.inner.config, "owner", &id);
        let stored = decode(&fs::read(path).unwrap()).unwrap();
        assert_eq!(stored.owner_id, "owner");
        assert_eq!(stored.snapshot.title, format!("Synthetic task {winner}"));
    }

    #[tokio::test]
    async fn stale_actor_cannot_replace_another_managers_checkpoint() {
        let data = tempfile::tempdir().unwrap();
        let first = manager(data.path());
        let created = session(&first).await;
        let second = manager(data.path());
        second
            .rename_session("owner", &created.id, "Second manager")
            .await
            .unwrap();

        let path = structured_session_path(&first.inner.config, "owner", &created.id);
        let saved = fs::read(&path).unwrap();
        let error = first
            .rename_session("owner", &created.id, "Stale manager")
            .await
            .unwrap_err();

        assert!(error.contains("Structured history"), "{error}");
        assert_eq!(fs::read(path).unwrap(), saved);
        assert_eq!(
            first
                .get_session("owner", &created.id)
                .await
                .unwrap()
                .unwrap()
                .title,
            created.title
        );
    }

    #[tokio::test]
    async fn stale_actor_cannot_recreate_a_removed_checkpoint() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        fs::remove_file(&path).unwrap();

        assert!(manager
            .rename_session("owner", &created.id, "Stale manager")
            .await
            .is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn identical_replaced_journal_allows_a_checkpoint_rewrite() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        manager
            .record_event("owner", &created.id, event(1))
            .await
            .unwrap();
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }

        manager
            .rename_session("owner", &created.id, "Restored")
            .await
            .unwrap();
        let restored = decode(&fs::read(path).unwrap()).unwrap().snapshot;
        assert_eq!(
            (restored.title.as_str(), restored.events),
            ("Restored", vec![event(1)])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn identical_replacement_with_insecure_permissions_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        let bytes = fs::read(&path).unwrap();
        let replacement = tempfile::NamedTempFile::new_in(path.parent().unwrap()).unwrap();
        fs::write(replacement.path(), &bytes).unwrap();
        fs::set_permissions(replacement.path(), fs::Permissions::from_mode(0o644)).unwrap();
        replacement.persist(&path).unwrap();

        assert!(manager
            .rename_session("owner", &created.id, "Unsafe")
            .await
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        manager
            .rename_session("owner", &created.id, "Safe")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn same_length_replaced_checkpoint_with_changed_content_is_rejected() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        manager
            .rename_session("owner", &created.id, "aa")
            .await
            .unwrap();
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        let mut bytes = fs::read(&path).unwrap();
        let needle = b"\"title\":\"aa\"";
        let offset = bytes
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap();
        bytes[offset..offset + needle.len()].copy_from_slice(b"\"title\":\"zz\"");
        let replacement = tempfile::NamedTempFile::new_in(path.parent().unwrap()).unwrap();
        fs::write(replacement.path(), &bytes).unwrap();
        replacement.persist(&path).unwrap();

        assert!(manager
            .rename_session("owner", &created.id, "New")
            .await
            .is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[tokio::test]
    async fn same_length_in_place_checkpoint_change_is_not_overwritten() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        manager
            .rename_session("owner", &created.id, "aa")
            .await
            .unwrap();
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        let mut bytes = fs::read(&path).unwrap();
        let needle = b"\"title\":\"aa\"";
        let offset = bytes
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap();
        bytes[offset..offset + needle.len()].copy_from_slice(b"\"title\":\"zz\"");
        fs::write(&path, &bytes).unwrap();

        assert!(manager
            .rename_session("owner", &created.id, "New")
            .await
            .is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[tokio::test]
    async fn append_does_not_extend_a_same_length_in_place_modified_history() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        manager
            .rename_session("owner", &created.id, "aa")
            .await
            .unwrap();
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        let mut bytes = fs::read(&path).unwrap();
        let needle = b"\"title\":\"aa\"";
        let offset = bytes
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap();
        bytes[offset..offset + needle.len()].copy_from_slice(b"\"title\":\"zz\"");
        fs::write(&path, &bytes).unwrap();

        assert!(manager
            .record_event("owner", &created.id, event(1))
            .await
            .is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn append_accepts_unchanged_history_after_a_private_permission_change() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let created = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &created.id);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        manager
            .record_event("owner", &created.id, event(1))
            .await
            .unwrap();
        assert_eq!(
            decode(&fs::read(path).unwrap()).unwrap().snapshot.events,
            vec![event(1)]
        );
    }

    #[tokio::test]
    async fn new_session_incarnation_survives_renames_reopen_and_event_appends() {
        #[derive(serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PreviousCheckpoint {
            version: u8,
            owner_id: String,
            snapshot: Value,
        }

        let data = tempfile::tempdir().unwrap();
        let first = manager(data.path());
        let created = session(&first).await;
        let other = session(&first).await;
        let path = structured_session_path(&first.inner.config, "owner", &created.id);
        let other_path = structured_session_path(&first.inner.config, "owner", &other.id);
        let original = checkpoint_value(&path)["sessionIncarnation"]
            .as_str()
            .unwrap()
            .to_owned();
        let previous: PreviousCheckpoint = serde_json::from_value(checkpoint_value(&path)).unwrap();
        assert!(serde_json::to_value(previous)
            .unwrap()
            .get("sessionIncarnation")
            .is_none());
        assert!(Uuid::parse_str(&original).is_ok());
        assert_ne!(
            checkpoint_value(&other_path)["sessionIncarnation"]
                .as_str()
                .unwrap(),
            original
        );
        assert!(serde_json::to_value(&created)
            .unwrap()
            .get("sessionIncarnation")
            .is_none());
        first
            .record_event("owner", &created.id, event(1))
            .await
            .unwrap();
        first
            .rename_session("owner", &created.id, "Renamed")
            .await
            .unwrap();
        assert_eq!(checkpoint_value(&path)["sessionIncarnation"], original);
        let restored = manager(data.path());
        restored
            .get_session("owner", &created.id)
            .await
            .unwrap()
            .unwrap();
        restored
            .record_event("owner", &created.id, event(2))
            .await
            .unwrap();
        assert_eq!(checkpoint_value(&path)["sessionIncarnation"], original);
        assert_eq!(
            decode(&fs::read(path).unwrap()).unwrap().snapshot.events,
            vec![event(1), event(2)]
        );
    }

    #[tokio::test]
    async fn legacy_checkpoint_without_incarnation_is_not_silently_assigned_one() {
        let data = tempfile::tempdir().unwrap();
        let first = manager(data.path());
        let created = session(&first).await;
        let path = structured_session_path(&first.inner.config, "owner", &created.id);
        let mut legacy = checkpoint_value(&path);
        legacy.as_object_mut().unwrap().remove("sessionIncarnation");
        legacy["version"] = Value::from(1);
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let restored = manager(data.path());
        restored
            .get_session("owner", &created.id)
            .await
            .unwrap()
            .unwrap();
        restored
            .rename_session("owner", &created.id, "Legacy preserved")
            .await
            .unwrap();
        assert!(checkpoint_value(&path).get("sessionIncarnation").is_none());
    }

    #[tokio::test]
    async fn appends_without_rewriting_history_and_metadata_checkpoint_resets_writer() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let session = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &session.id);
        let checkpoint = fs::read(&path).unwrap();
        manager
            .record_event("owner", &session.id, event(1))
            .await
            .unwrap();
        let first_append = fs::read(&path).unwrap();
        assert!(first_append.starts_with(&checkpoint));
        manager
            .rename_session("owner", &session.id, "Renamed without losing history")
            .await
            .unwrap();
        let renamed = fs::read(&path).unwrap();
        manager
            .record_event("owner", &session.id, event(2))
            .await
            .unwrap();
        let final_bytes = fs::read(&path).unwrap();
        assert!(final_bytes.starts_with(&renamed));
        let stored = decode(&final_bytes).unwrap();
        assert_eq!(
            (stored.snapshot.title, stored.snapshot.events),
            (
                "Renamed without losing history".into(),
                vec![event(1), event(2)]
            )
        );
    }

    #[tokio::test]
    async fn restart_recovers_committed_events_repairs_torn_tail_and_accepts_next_sequence() {
        let data = tempfile::tempdir().unwrap();
        let first = manager(data.path());
        let session = session(&first).await;
        let path = structured_session_path(&first.inner.config, "owner", &session.id);
        for seq in 1..=2 {
            first
                .record_event("owner", &session.id, event(seq))
                .await
                .unwrap();
        }
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"event\":\"torn")
            .unwrap();
        let restored = manager(data.path());
        let snapshot = restored
            .get_session("owner", &session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.events, vec![event(1), event(2)]);
        restored
            .record_event("owner", &session.id, event(3))
            .await
            .unwrap();
        assert_eq!(
            decode(&fs::read(&path).unwrap()).unwrap().snapshot.events,
            vec![event(1), event(2), event(3)]
        );
    }

    #[tokio::test]
    async fn recovery_refuses_missing_or_changed_session_incarnation() {
        for replacement in [None, Some(Uuid::new_v4().to_string())] {
            let data = tempfile::tempdir().unwrap();
            let manager = manager(data.path());
            let session = session(&manager).await;
            let path = structured_session_path(&manager.inner.config, "owner", &session.id);
            let mut checkpoint = checkpoint_value(&path);
            match replacement {
                Some(ref id) => checkpoint["sessionIncarnation"] = Value::String(id.clone()),
                None => {
                    checkpoint
                        .as_object_mut()
                        .unwrap()
                        .remove("sessionIncarnation");
                }
            }
            let mut bytes = serde_json::to_vec(&checkpoint).unwrap();
            bytes.push(b'\n');
            fs::write(&path, &bytes).unwrap();
            manager
                .storage_cursors()
                .get_mut(&path)
                .unwrap()
                .recovery_required = true;
            let (_, mut live) = manager.subscribe("owner", &session.id).await.unwrap();

            assert!(manager
                .record_event("owner", &session.id, event(1))
                .await
                .is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(manager
                .get_session("owner", &session.id)
                .await
                .unwrap()
                .unwrap()
                .events
                .is_empty());
            assert!(matches!(
                live.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
        }
    }

    #[tokio::test]
    async fn recovery_accepts_the_same_session_incarnation() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let session = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &session.id);
        let original = checkpoint_value(&path)["sessionIncarnation"].clone();
        manager
            .storage_cursors()
            .get_mut(&path)
            .unwrap()
            .recovery_required = true;
        manager
            .record_event("owner", &session.id, event(1))
            .await
            .unwrap();
        assert_eq!(checkpoint_value(&path)["sessionIncarnation"], original);
        assert_eq!(
            decode(&fs::read(path).unwrap()).unwrap().snapshot.events,
            vec![event(1)]
        );
    }

    #[tokio::test]
    async fn recovery_accepts_unchanged_legacy_session_without_incarnation() {
        let data = tempfile::tempdir().unwrap();
        let first = manager(data.path());
        let session = session(&first).await;
        let path = structured_session_path(&first.inner.config, "owner", &session.id);
        let mut checkpoint = checkpoint_value(&path);
        checkpoint
            .as_object_mut()
            .unwrap()
            .remove("sessionIncarnation");
        let mut bytes = serde_json::to_vec(&checkpoint).unwrap();
        bytes.push(b'\n');
        fs::write(&path, bytes).unwrap();
        drop(first);
        let restored = manager(data.path());
        restored
            .get_session("owner", &session.id)
            .await
            .unwrap()
            .unwrap();
        restored
            .storage_cursors()
            .get_mut(&path)
            .unwrap()
            .recovery_required = true;
        restored
            .record_event("owner", &session.id, event(1))
            .await
            .unwrap();
        assert!(checkpoint_value(&path).get("sessionIncarnation").is_none());
        assert_eq!(
            decode(&fs::read(path).unwrap()).unwrap().snapshot.events,
            vec![event(1)]
        );
    }

    #[tokio::test]
    async fn compacts_bounded_journal_without_losing_or_duplicating_events() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let session = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &session.id);
        let incarnation = checkpoint_value(&path)["sessionIncarnation"].clone();
        let mut expected = Vec::new();
        for seq in 1..=80 {
            let mut next = event(seq);
            if let StructuredSessionEvent::MessageDelta { content, .. } = &mut next {
                *content = "🐈\n\"".repeat(2048);
            }
            manager
                .record_event("owner", &session.id, next.clone())
                .await
                .unwrap();
            expected.push(next);
        }
        let bytes = fs::read(structured_session_path(
            &manager.inner.config,
            "owner",
            &session.id,
        ))
        .unwrap();
        let first_line = bytes.split(|byte| *byte == b'\n').next().unwrap();
        let checkpoint: StoredStructuredSession = serde_json::from_slice(first_line).unwrap();
        assert!(
            !checkpoint.snapshot.events.is_empty(),
            "workload must cross a real compaction boundary"
        );
        assert_eq!(decode(&bytes).unwrap().snapshot.events, expected);
        assert_eq!(checkpoint_value(&path)["sessionIncarnation"], incarnation);
    }

    #[tokio::test]
    async fn failed_append_never_recreates_deleted_file_or_broadcasts_unsaved_event() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let session = session(&manager).await;
        let path = structured_session_path(&manager.inner.config, "owner", &session.id);
        let (_, mut live) = manager.subscribe("owner", &session.id).await.unwrap();
        fs::remove_file(&path).unwrap();
        assert!(manager
            .record_event("owner", &session.id, event(1))
            .await
            .is_err());
        assert!(!path.exists());
        assert_eq!(
            manager
                .get_session("owner", &session.id)
                .await
                .unwrap()
                .unwrap()
                .events,
            vec![]
        );
        assert!(matches!(
            live.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn compaction_refuses_a_deleted_or_replaced_checkpoint() {
        for replace in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let manager = manager(data.path());
            let session = session(&manager).await;
            let path = structured_session_path(&manager.inner.config, "owner", &session.id);
            let checkpoint = fs::read(&path).unwrap();
            fs::remove_file(&path).unwrap();
            if replace {
                fs::write(&path, &checkpoint).unwrap();
            }
            let (_, mut live) = manager.subscribe("owner", &session.id).await.unwrap();
            let mut large = event(1);
            if let StructuredSessionEvent::MessageDelta { content, .. } = &mut large {
                *content = "x".repeat(1_048_576);
            }
            assert!(manager
                .record_event("owner", &session.id, large)
                .await
                .is_err());
            assert_eq!(
                manager
                    .get_session("owner", &session.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .events,
                vec![]
            );
            assert!(matches!(
                live.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
            if replace {
                assert_eq!(fs::read(path).unwrap(), checkpoint);
            } else {
                assert!(!path.exists());
            }
        }
    }

    #[tokio::test]
    async fn inventory_has_ordered_status_metadata_without_transcript_payloads() {
        let data = tempfile::tempdir().unwrap();
        let manager = manager(data.path());
        let session = session(&manager).await;
        manager
            .record_event("owner", &session.id, event(1))
            .await
            .unwrap();
        let owned = manager
            .owned_session("owner", &session.id)
            .await
            .unwrap()
            .unwrap();
        owned.state.lock().await.retiring = true;
        let inventory =
            serde_json::to_value(manager.list_inventory("owner").await.unwrap()).unwrap();
        assert_eq!(
            (
                inventory[0]["status"].as_str(),
                inventory[0]["statusSeq"].as_i64(),
                inventory[0]["latestSeq"].as_i64(),
                inventory[0].get("events")
            ),
            (Some("cleanup_required"), Some(1), Some(1), None)
        );
        assert!(manager.list_inventory("other").await.unwrap().is_empty());
        assert_eq!(
            manager
                .get_session("owner", &session.id)
                .await
                .unwrap()
                .unwrap()
                .events,
            vec![event(1)]
        );
    }
}
