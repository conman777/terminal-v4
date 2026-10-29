use super::*;
use std::io::{Read, Write};

pub(super) const MAX_LEDGER_RECORDS: usize = 4096;
const KEPT_LEDGER_RECORDS: usize = 2048;
const MAX_LEDGER_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct SessionLease {
    #[cfg(unix)]
    _file: fs::File,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IntentRecord {
    pub request_id: String,
    pub message_id: String,
    pub text_sha256: String,
}

pub(super) fn text_digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn private_dir(config: &AppConfig, kind: &str, user_id: &str) -> Result<PathBuf, String> {
    let user = structured_user_dir(config, user_id)
        .file_name()
        .ok_or("Invalid structured owner directory")?
        .to_owned();
    let root = config.data_dir.join(kind);
    let directory = root.join(user);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for path in [&config.data_dir, &root, &directory] {
        if fs::symlink_metadata(path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Structured request directories must not be symlinked".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(directory)
}

pub(super) fn session_file(
    config: &AppConfig,
    kind: &str,
    user_id: &str,
    id: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let name = sanitize_identifier(id);
    if name.is_empty() {
        return Err("Invalid structured session ID".into());
    }
    Ok(private_dir(config, kind, user_id)?.join(format!("{name}.{extension}")))
}

fn open_private(path: &Path, append: bool) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true).create(true);
    if append {
        options.append(true);
    } else {
        options.write(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|error| error.to_string())
}

#[cfg(unix)]
pub(super) fn acquire_lease(
    config: &AppConfig,
    user_id: &str,
    id: &str,
) -> Result<SessionLease, String> {
    let path = session_file(config, "structured-session-leases", user_id, id, "lock")?;
    let file = open_private(&path, false)?;
    match file.try_lock() {
        Ok(()) => Ok(SessionLease { _file: file }),
        Err(fs::TryLockError::WouldBlock) => {
            Err("Session is being changed by another manager; try again".into())
        }
        Err(fs::TryLockError::Error(error)) => Err(error.to_string()),
    }
}

#[cfg(not(unix))]
pub(super) fn acquire_lease(
    _config: &AppConfig,
    _user_id: &str,
    _id: &str,
) -> Result<SessionLease, String> {
    Ok(SessionLease {})
}

pub(super) fn events_ahead_of(
    config: &AppConfig,
    user_id: &str,
    id: &str,
    memory: &[StructuredSessionEvent],
) -> Result<Option<Vec<StructuredSessionEvent>>, String> {
    let stored = storage::read_for_recovery(config, user_id, id)?;
    if stored.owner_id != user_id {
        return Err("Structured session owner does not match its stored identity".into());
    }
    let disk = stored.snapshot.events;
    Ok((next_session_seq(&disk)? > next_session_seq(memory)?).then_some(disk))
}

fn committed_length(path: &Path) -> Result<u64, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    Ok(bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |end| end as u64 + 1))
}

fn read_records(path: &Path) -> Result<Vec<IntentRecord>, String> {
    let mut file = match fs::OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_LEDGER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_LEDGER_BYTES {
        return Err("Native request ledger exceeds its size limit".into());
    }
    let committed = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(&bytes[..0], |end| &bytes[..=end]);
    committed
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_slice(line)
                .map_err(|_| "Native request ledger contains an invalid record".to_string())
        })
        .collect()
}

pub(super) fn find_intent(
    config: &AppConfig,
    user_id: &str,
    id: &str,
    request_id: &str,
) -> Result<Option<IntentRecord>, String> {
    let path = session_file(config, "structured-native-requests", user_id, id, "jsonl")?;
    Ok(read_records(&path)?
        .into_iter()
        .rev()
        .find(|record| record.request_id == request_id))
}

pub(super) fn record_intent(
    config: &AppConfig,
    user_id: &str,
    id: &str,
    record: &IntentRecord,
) -> Result<(), String> {
    let path = session_file(config, "structured-native-requests", user_id, id, "jsonl")?;
    let existing = read_records(&path)?;
    if existing.len() >= MAX_LEDGER_RECORDS {
        let kept = &existing[existing.len() - KEPT_LEDGER_RECORDS..];
        let mut payload = Vec::new();
        for kept in kept {
            serde_json::to_writer(&mut payload, kept).map_err(|error| error.to_string())?;
            payload.push(b'\n');
        }
        let directory = path.parent().ok_or("Invalid ledger path")?;
        let mut staged =
            tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
        staged
            .write_all(&payload)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|error| error.to_string())?;
        staged.persist(&path).map_err(|error| error.to_string())?;
    }
    let created = !path.exists();
    let mut file = open_private(&path, true)?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let committed = committed_length(&path)?;
    if committed < length {
        file.set_len(committed).map_err(|error| error.to_string())?;
    }
    let mut line = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    line.push(b'\n');
    file.write_all(&line)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    if created {
        if let Some(parent) = path.parent() {
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(unix))]
    let _ = created;
    Ok(())
}

pub(super) fn accepted_receipt(
    events: &[StructuredSessionEvent],
    intent: &IntentRecord,
) -> Option<StructuredReceipt> {
    events.iter().find_map(|event| match event {
        StructuredSessionEvent::MessageCompleted {
            seq,
            message_id: Some(message_id),
            role,
            ..
        } if role == "user" && message_id == &intent.message_id => Some(StructuredReceipt {
            status: "accepted".into(),
            request_id: Some(intent.request_id.clone()),
            turn_id: None,
            message_id: Some(message_id.clone()),
            accepted_seq: Some(*seq),
            input: None,
        }),
        _ => None,
    })
}
