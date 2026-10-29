mod search;
mod store;
mod sync;
#[cfg(test)]
mod tests;

pub(crate) use search::{SearchOutcome, SearchRequest};

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub(crate) struct Limits {
    pub max_doc_text_bytes: usize,
    pub max_total_text_bytes: u64,
    pub max_manifest_entries: usize,
    pub sync_max_docs: usize,
    pub max_catchup_rounds: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_doc_text_bytes: 2_000_000,
            max_total_text_bytes: 256_000_000,
            max_manifest_entries: 50_000,
            sync_max_docs: 64,
            max_catchup_rounds: 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManifestEntry {
    pub key: String,
    pub source: String,
    pub id: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ns: i128,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Manifest {
    pub entries: Vec<ManifestEntry>,
    pub truncated: bool,
    pub omitted: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IndexedMessage {
    pub anchor: usize,
    pub role: String,
    pub text: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct IndexedDoc {
    pub workspace: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub updated_at: String,
    pub fingerprint: String,
    pub messages: Vec<IndexedMessage>,
    pub source_truncated: bool,
}

pub(crate) trait Sources {
    fn manifest(&self) -> Result<Manifest, String>;
    fn read(&self, entry: &ManifestEntry) -> Result<IndexedDoc, String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangeKind {
    Create,
    Update,
    Delete,
}

impl ChangeKind {
    fn name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Freshness {
    Complete { generation: i64, skipped: usize },
    Incomplete(String),
}

pub(crate) struct RecallIndex {
    dir: PathBuf,
    owner: String,
    limits: Limits,
}

pub(crate) fn enabled(data: &Path) -> bool {
    std::env::var("TERMINAL_V4_RECALL_INDEX").is_ok_and(|value| value == "1" || value == "true")
        || std::fs::symlink_metadata(data.join("recall-index").join("ENABLED"))
            .is_ok_and(|metadata| metadata.is_file())
}

pub(crate) fn file_stat(path: &Path) -> Option<(u64, i128)> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().ok()?;
    let nanos = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => after.as_nanos() as i128,
        Err(before) => -(before.duration().as_nanos() as i128),
    };
    Some((metadata.len(), nanos))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

impl RecallIndex {
    pub(crate) fn open(data: &Path, owner: &str, limits: Limits) -> Result<Self, String> {
        if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
            return Err("Invalid account".into());
        }
        let root = data.join("recall-index");
        let dir = root.join(hex::encode(Sha256::digest(owner.as_bytes())));
        for path in [data, root.as_path(), dir.as_path()] {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("Symlinked recall index storage is not allowed".into())
                }
                Ok(metadata) if !metadata.is_dir() => {
                    return Err("Recall index storage is not a directory".into())
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(path)
                        .or_else(|error| {
                            if error.kind() == std::io::ErrorKind::AlreadyExists {
                                Ok(())
                            } else {
                                Err(error)
                            }
                        })
                        .map_err(|_| "Unable to create recall index storage")?;
                }
                Err(_) => return Err("Recall index storage is unavailable".into()),
            }
        }
        let index = Self {
            dir,
            owner: owner.to_owned(),
            limits,
        };
        index.connect()?;
        Ok(index)
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join("index.sqlite")
    }
}

pub(crate) fn redact_messages(
    messages: &[(String, String)],
    redact: impl Fn(&str) -> String,
) -> Vec<IndexedMessage> {
    use regex_lite::Regex;
    use std::sync::OnceLock;
    static BEGIN: OnceLock<Regex> = OnceLock::new();
    static END: OnceLock<Regex> = OnceLock::new();
    static COMPLETE: OnceLock<Regex> = OnceLock::new();
    let begin = BEGIN
        .get_or_init(|| Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----").unwrap());
    let end =
        END.get_or_init(|| Regex::new(r"-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----").unwrap());
    let complete = COMPLETE.get_or_init(|| {
        Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----").unwrap()
    });
    let mut inside_key = false;
    messages
        .iter()
        .enumerate()
        .map(|(index, (role, raw))| {
            let text = if inside_key {
                if end.is_match(raw) {
                    inside_key = false;
                }
                None
            } else {
                let remainder = complete.replace_all(raw, "");
                if begin.is_match(&remainder) {
                    inside_key = true;
                }
                let clean = redact(raw);
                (!clean.trim().is_empty()).then_some(clean)
            };
            IndexedMessage {
                anchor: index + 1,
                role: role.clone(),
                text,
            }
        })
        .collect()
}
