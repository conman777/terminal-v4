use super::{checked_storage_path, fingerprint};
use crate::session_search::normalize_workspace_path;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(super) const FILE_LIMIT: u64 = 8_000_000;
pub(super) const SCAN_BYTES: u64 = 80_000_000;
pub(super) const SCAN_FILES: usize = 50;
const SOURCE_FILES: usize = 2_000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Source {
    V4,
    Terminal,
    Structured,
    Imported,
}
impl Source {
    pub(super) fn parse(name: &str) -> Result<Self, String> {
        match name {
            "v4" => Ok(Self::V4),
            "terminal" => Ok(Self::Terminal),
            "structured" => Ok(Self::Structured),
            "imported" => Ok(Self::Imported),
            _ => Err("Unknown app history source".into()),
        }
    }
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::V4 => "v4",
            Self::Terminal => "terminal",
            Self::Structured => "structured",
            Self::Imported => "imported",
        }
    }
    fn limit(self) -> u64 {
        match self {
            Self::V4 => 2_000_000,
            Self::Imported => 800_000,
            Self::Structured => crate::structured::MAX_STRUCTURED_FILE_BYTES as u64,
            _ => FILE_LIMIT,
        }
    }
    fn valid_id(self, id: &str) -> bool {
        match self {
            Self::V4 => uuid::Uuid::parse_str(id).is_ok(),
            Self::Imported => id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            _ => {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            }
        }
    }
}

pub(super) struct Transcript {
    pub id: String,
    pub source: Source,
    pub provider: String,
    pub model: String,
    pub workspace: String,
    pub title: String,
    pub updated_at: String,
    pub messages: Vec<super::super::Message>,
    pub fingerprint: String,
    pub truncated: bool,
    pub read_bytes: u64,
}

pub(super) struct Candidate {
    pub path: PathBuf,
    pub source: Source,
    pub bytes: u64,
    modified: SystemTime,
}

pub(super) fn candidate_at(path: PathBuf, source: Source, bytes: u64) -> Candidate {
    Candidate {
        path,
        source,
        bytes,
        modified: SystemTime::UNIX_EPOCH,
    }
}

fn exact_legacy_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn hashed_root(data: &Path, owner: &str, namespace: &str) -> PathBuf {
    data.join(namespace)
        .join(hex::encode(Sha256::digest(owner.as_bytes())))
}

fn workspace_key(workspace: &str) -> String {
    hex::encode(Sha256::digest(
        normalize_workspace_path(workspace).as_bytes(),
    ))
}

fn owned_directory(
    data: &Path,
    owner: &str,
    workspace: &str,
    source: Source,
) -> Result<PathBuf, String> {
    match source {
        Source::V4 => {
            Ok(hashed_root(data, owner, "v4-agent-history").join(workspace_key(workspace)))
        }
        Source::Imported => {
            Ok(hashed_root(data, owner, "native-history").join(workspace_key(workspace)))
        }
        Source::Structured => Ok(hashed_root(data, owner, "structured-sessions")),
        Source::Terminal => {
            if !exact_legacy_owner(owner) {
                return Err(
                    "Legacy app history cannot safely resolve this account identifier".into(),
                );
            }
            let directory = data.join("users").join(owner).join("sessions");
            if directory.exists()
                && !crate::structured::legacy_history_owner_is_unique(data, owner)?
            {
                return Err("Legacy app history ownership is ambiguous; explicit account migration is required".into());
            }
            Ok(directory)
        }
    }
}

enum EntryVisit {
    Skip,
    Read,
    Stop,
}
struct DiscoveryWindow {
    skip: usize,
    left: usize,
    more: bool,
    omitted: usize,
}
impl DiscoveryWindow {
    fn visit(&mut self) -> EntryVisit {
        if self.skip > 0 {
            self.skip -= 1;
            return EntryVisit::Skip;
        }
        if self.left == 0 {
            self.more = true;
            return EntryVisit::Stop;
        }
        self.left -= 1;
        EntryVisit::Read
    }
}

fn collect_files(
    data: &Path,
    directory: &Path,
    source: Source,
    result: &mut Vec<Candidate>,
    window: &mut DiscoveryWindow,
) {
    if checked_storage_path(data, directory).is_err() {
        window.omitted += 1;
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        match window.visit() {
            EntryVisit::Skip => continue,
            EntryVisit::Stop => break,
            EntryVisit::Read => {}
        }
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if !source.valid_id(id) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > source.limit()
        {
            window.omitted += 1;
            continue;
        }
        result.push(Candidate {
            path,
            source,
            bytes: metadata.len(),
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
    }
}

pub(super) fn candidates(
    data: &Path,
    owner: &str,
    workspace: &Path,
    all_workspaces: bool,
    entry_offset: usize,
) -> (Vec<Candidate>, bool, usize, Vec<String>) {
    let mut result = Vec::new();
    let mut more = false;
    let mut omitted = 0;
    let mut warnings = Vec::new();
    for source in [
        Source::V4,
        Source::Terminal,
        Source::Structured,
        Source::Imported,
    ] {
        let mut window = DiscoveryWindow {
            skip: entry_offset,
            left: SOURCE_FILES,
            more: false,
            omitted: 0,
        };
        if all_workspaces && matches!(source, Source::V4 | Source::Imported) {
            let directory = hashed_root(
                data,
                owner,
                if source == Source::V4 {
                    "v4-agent-history"
                } else {
                    "native-history"
                },
            );
            if checked_storage_path(data, &directory).is_err() {
                warnings.push(format!("Skipped unsafe {} history storage", source.name()));
                continue;
            }
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if matches!(window.visit(), EntryVisit::Stop) {
                    break;
                }
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    continue;
                }
                if !entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                {
                    window.omitted += 1;
                    continue;
                }
                collect_files(data, &entry.path(), source, &mut result, &mut window);
                if window.more {
                    break;
                }
            }
        } else {
            match owned_directory(data, owner, &workspace.to_string_lossy(), source) {
                Ok(directory) => collect_files(data, &directory, source, &mut result, &mut window),
                Err(error) => warnings.push(error),
            }
        }
        if source == Source::Structured
            && exact_legacy_owner(owner)
            && !window.more
            && crate::structured::legacy_history_owner_is_unique(data, owner).unwrap_or(false)
        {
            collect_files(
                data,
                &data.join("users").join(owner).join("structured"),
                source,
                &mut result,
                &mut window,
            );
        }
        more |= window.more;
        omitted += window.omitted;
    }
    result.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.source.name().cmp(right.source.name()))
            .then_with(|| left.path.cmp(&right.path))
    });
    (result, more, omitted, warnings)
}

fn value_text(value: &Value, name: &str) -> Result<String, String> {
    value[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Invalid app history {name}"))
}

fn visible_messages(values: &[Value], text_key: &str) -> Vec<super::super::Message> {
    values
        .iter()
        .take(50_000)
        .filter_map(|message| {
            let role = message["role"].as_str()?;
            if !["user", "assistant", "system"].contains(&role) {
                return None;
            }
            Some(super::super::Message {
                attachments: Vec::new(),
                role: role.into(),
                text: message[text_key].as_str()?.into(),
            })
        })
        .collect()
}

fn terminal_messages(history: &[Value]) -> Vec<super::super::Message> {
    let body = history
        .iter()
        .take(50_000)
        .filter_map(|event| event["text"].as_str())
        .collect::<String>();
    let clean = crate::session_search::safe_history_text(&body);
    let mut messages = Vec::new();
    let mut text = String::new();
    let mut characters = 0;
    for line in clean.lines() {
        if !text.is_empty() {
            text.push('\n');
            characters += 1;
        }
        text.push_str(line);
        characters += line.chars().count();
        if characters >= 8_000 {
            messages.push(super::super::Message {
                attachments: Vec::new(),
                role: "terminal".into(),
                text: std::mem::take(&mut text),
            });
            characters = 0;
        }
    }
    if !text.is_empty() {
        messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "terminal".into(),
            text,
        });
    }
    messages
}

pub(super) fn read_candidate(data: &Path, candidate: &Candidate) -> Result<Transcript, String> {
    read_candidate_with_budget(data, candidate, SCAN_BYTES)
}

pub(super) fn read_candidate_with_budget(
    data: &Path,
    candidate: &Candidate,
    budget: u64,
) -> Result<Transcript, String> {
    checked_storage_path(data, &candidate.path)?;
    if candidate.source == Source::V4 {
        let (session, read_bytes, revision) =
            super::super::session_store::visible_from_path(data, &candidate.path, budget as usize)?;
        let title = session
            .messages
            .iter()
            .find(|message| message.role == "user")
            .map(|message| message.text.chars().take(100).collect::<String>())
            .unwrap_or_default();
        return Ok(Transcript {
            id: session.id,
            source: Source::V4,
            provider: session.provider.chars().take(128).collect(),
            model: session.model.chars().take(200).collect(),
            workspace: session.workspace,
            title,
            updated_at: session.updated_at.chars().take(64).collect(),
            messages: session.messages,
            fingerprint: revision,
            truncated: false,
            read_bytes: read_bytes as u64,
        });
    }
    let metadata = std::fs::symlink_metadata(&candidate.path)
        .map_err(|_| "App conversation is unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > candidate.source.limit()
    {
        return Err("App conversation exceeds its read limit or is not a regular file".into());
    }
    let file =
        std::fs::File::open(&candidate.path).map_err(|_| "App conversation is unavailable")?;
    let mut content = Vec::new();
    file.take(candidate.source.limit() + 1)
        .read_to_end(&mut content)
        .map_err(|_| "App conversation cannot be read")?;
    if content.len() as u64 > candidate.source.limit() {
        return Err("App conversation exceeds its read limit".into());
    }
    let read_bytes = content.len() as u64;
    if read_bytes > budget {
        return Err("App conversation exceeds remaining scan budget".into());
    }
    let owned_structured = candidate.source == Source::Structured
        && candidate
            .path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("structured-sessions");
    let legacy_value: Result<Value, _> = serde_json::from_slice(&content);
    let mut value: Value = if owned_structured
        && !legacy_value
            .as_ref()
            .is_ok_and(|value| value["version"] == 1)
    {
        serde_json::to_value(crate::structured::storage::decode(&content)?)
            .map_err(|error| error.to_string())?
    } else {
        legacy_value
            .map_err(|_| "Saved app conversation is invalid; retry after active writes complete")?
    };
    let id = candidate
        .path
        .file_stem()
        .and_then(|id| id.to_str())
        .ok_or("Invalid app history identifier")?
        .to_owned();
    if candidate.source == Source::Structured && value["snapshot"].is_object() {
        let owner = value["ownerId"]
            .as_str()
            .ok_or("Structured owner binding is invalid")?;
        if !matches!(value["version"].as_u64(), Some(1 | 2))
            || owner.is_empty()
            || owner.len() > 512
            || owner.chars().any(char::is_control)
            || candidate
                .path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some(hex::encode(Sha256::digest(owner.as_bytes())).as_str())
            || candidate
                .path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some("structured-sessions")
        {
            return Err("Structured owner binding is invalid".into());
        }
        value = value["snapshot"].take();
    } else if candidate.source == Source::Structured
        && candidate
            .path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("structured-sessions")
    {
        return Err("Structured owner envelope is missing".into());
    }
    if matches!(candidate.source, Source::Terminal | Source::Structured)
        && candidate
            .path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("structured-sessions")
    {
        let owner = candidate
            .path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .ok_or("Legacy app history owner is invalid")?;
        if !exact_legacy_owner(owner)
            || candidate
                .path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some("users")
            || !crate::structured::legacy_history_owner_is_unique(data, owner)?
        {
            return Err("Legacy app history ownership is ambiguous".into());
        }
    }
    let explicit_updated = value["updatedAt"]
        .as_str()
        .or_else(|| value["updated_at"].as_str())
        .map(str::to_owned);
    let (workspace, provider, model, title, messages, truncated, revision) = match candidate.source
    {
        Source::V4 => return Err("V4 history must use its scoped store reader".into()),
        Source::Terminal => {
            if value_text(&value, "id")? != id {
                return Err("Terminal conversation identity is invalid".into());
            }
            let workspace = value["thread"]["projectPath"]
                .as_str()
                .filter(|path| !path.is_empty())
                .or_else(|| value["cwd"].as_str())
                .ok_or("Terminal workspace is unavailable")?
                .to_owned();
            let history = value["history"]
                .as_array()
                .ok_or("Terminal history is invalid")?;
            let messages = terminal_messages(history);
            (
                workspace,
                value["shell"].as_str().unwrap_or("terminal").to_owned(),
                String::new(),
                value["title"].as_str().unwrap_or("Terminal").to_owned(),
                messages,
                history.len() > 50_000,
                fingerprint(&String::from_utf8_lossy(&content)),
            )
        }
        Source::Structured => {
            if value_text(&value, "id")? != id {
                return Err("Structured conversation identity is invalid".into());
            }
            let workspace = value["thread"]["projectPath"]
                .as_str()
                .filter(|path| !path.is_empty())
                .or_else(|| value["cwd"].as_str())
                .ok_or("Structured workspace is unavailable")?
                .to_owned();
            let events = value["events"]
                .as_array()
                .ok_or("Structured history is invalid")?;
            let mut messages = Vec::new();
            let mut accepted_ids = std::collections::HashSet::new();
            for event in events.iter().take(50_000) {
                if event["type"] == "user_message_accepted" {
                    if let Some(content) = event["content"].as_str() {
                        if let Some(id) = event["messageId"].as_str() {
                            accepted_ids.insert(id.to_owned());
                        }
                        messages.push(super::super::Message {
                            attachments: Vec::new(),
                            role: "user".into(),
                            text: content.into(),
                        });
                    }
                } else if event["type"] == "message_completed" {
                    if event["role"] == "user"
                        && event["messageId"]
                            .as_str()
                            .is_some_and(|id| accepted_ids.contains(id))
                    {
                        continue;
                    }
                    messages.extend(visible_messages(std::slice::from_ref(event), "content"));
                } else if event["type"] == "tool_completed" {
                    if let Some(result) = event["result"].as_str() {
                        messages.push(super::super::Message {
                            attachments: Vec::new(),
                            role: "tool".into(),
                            text: format!(
                                "Tool {} ({}): {result}",
                                event["toolName"].as_str().unwrap_or("unknown"),
                                if event["isError"] == true {
                                    "failed"
                                } else {
                                    "completed"
                                }
                            ),
                        });
                    }
                }
            }
            (
                workspace,
                value["provider"]
                    .as_str()
                    .unwrap_or("structured")
                    .to_owned(),
                value["model"].as_str().unwrap_or("").to_owned(),
                value["title"]
                    .as_str()
                    .unwrap_or("Structured conversation")
                    .to_owned(),
                messages,
                events.len() > 50_000,
                fingerprint(&String::from_utf8_lossy(&content)),
            )
        }
        Source::Imported => {
            if value_text(&value, "sourceId")? != id {
                return Err("Imported conversation identity is invalid".into());
            }
            let values = value["messages"]
                .as_array()
                .ok_or("Imported history is invalid")?;
            (
                value_text(&value, "workspacePath")?,
                value["provider"].as_str().unwrap_or("imported").to_owned(),
                String::new(),
                value["title"]
                    .as_str()
                    .unwrap_or("Imported conversation")
                    .to_owned(),
                visible_messages(values, "text"),
                value["truncated"].as_bool().unwrap_or(false) || values.len() > 50_000,
                fingerprint(&String::from_utf8_lossy(&content)),
            )
        }
    };
    if !Path::new(&workspace).is_absolute()
        || workspace.len() > 2048
        || workspace.chars().any(char::is_control)
    {
        return Err("Saved conversation workspace is invalid".into());
    }
    if matches!(candidate.source, Source::V4 | Source::Imported)
        && candidate
            .path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some(workspace_key(&workspace).as_str())
    {
        return Err("Saved conversation workspace scope is invalid".into());
    }
    let updated_at = explicit_updated.unwrap_or_else(|| {
        time::OffsetDateTime::from(metadata.modified().unwrap_or(candidate.modified))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default()
    });
    Ok(Transcript {
        id,
        source: candidate.source,
        workspace,
        provider: provider.chars().take(128).collect(),
        model: model.chars().take(200).collect(),
        title: title.chars().take(100).collect(),
        messages,
        updated_at: updated_at.chars().take(64).collect(),
        fingerprint: revision,
        truncated,
        read_bytes,
    })
}

pub(super) fn load(
    data: &Path,
    owner: &str,
    workspace: &str,
    source: Source,
    id: &str,
) -> Result<Transcript, String> {
    if !source.valid_id(id) {
        return Err("Invalid app history identifier".into());
    }
    let directory = owned_directory(data, owner, workspace, source)?;
    let mut path = directory.join(format!("{id}.json"));
    if source == Source::Structured
        && exact_legacy_owner(owner)
        && crate::structured::legacy_history_owner_is_unique(data, owner).unwrap_or(false)
        && std::fs::symlink_metadata(&path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        path = data
            .join("users")
            .join(owner)
            .join("structured")
            .join(format!("{id}.json"));
    }
    let candidate = Candidate {
        path,
        source,
        bytes: 0,
        modified: SystemTime::UNIX_EPOCH,
    };
    let transcript = read_candidate(data, &candidate)?;
    if normalize_workspace_path(&transcript.workspace) != normalize_workspace_path(workspace) {
        return Err("Conversation is unavailable for this account and workspace".into());
    }
    Ok(transcript)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn discovery_pages_make_records_beyond_two_thousand_reachable() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let directory = owned_directory(
            data.path(),
            "owner",
            workspace.to_str().unwrap(),
            Source::V4,
        )
        .unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        for index in 1..=2_001 {
            std::fs::write(
                directory.join(format!("{}.json", uuid::Uuid::from_u128(index))),
                "",
            )
            .unwrap();
        }
        let (first, more, _, _) = candidates(data.path(), "owner", &workspace, false, 0);
        assert!(more);
        assert_eq!(first.len(), 2_000);
        let selected: std::collections::HashSet<_> = first
            .iter()
            .map(|candidate| candidate.path.clone())
            .collect();
        let omitted = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| !selected.contains(path))
            .unwrap();
        let mut session = crate::v4_agent::new_session("openai-api", "fixture", &workspace);
        session.id = omitted.file_stem().unwrap().to_str().unwrap().to_owned();
        session.messages.push(crate::v4_agent::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "unique paged fixture".into(),
        });
        std::fs::write(omitted, serde_json::to_vec(&session).unwrap()).unwrap();
        let page = super::super::recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"unique paged fixture","candidatePage":1}),
        )
        .unwrap();
        assert_eq!(page["sessions"][0]["sessionId"], session.id);
        assert_eq!(page["candidatePage"], 1);
        assert_eq!(page["nextCandidatePage"], Value::Null);
        let account = super::super::recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"unique paged fixture","scope":"account","candidatePage":1}),
        )
        .unwrap();
        assert_eq!(account["sessions"][0]["sessionId"], session.id);
    }
    #[test]
    fn canonical_structured_journals_recall_accepted_users_and_completed_evidence_with_owner_binding(
    ) {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let owner = "owner_with_unicode_λ";
        let id = "ss-00000000-0000-4000-8000-000000000099";
        let directory = hashed_root(data.path(), owner, "structured-sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{id}.json"));
        let mut envelope = serde_json::json!({"version":1,"ownerId":owner,"snapshot":{"id":id,"title":"Canonical fixture","cwd":workspace,"provider":"deepseek","events":[{"type":"user_message_accepted","messageId":"user1","content":"needle accepted user"},{"type":"message_completed","messageId":"user1","role":"user","content":"needle accepted user"},{"type":"tool_completed","toolName":"read_file","result":"needle completed evidence","isError":false},{"type":"raw_provider_event","payload":{"reasoning_content":"PRIVATE-THOUGHT"}},{"type":"message_delta","role":"assistant","content":"incomplete excluded"},{"type":"message_completed","role":"assistant","content":"needle completed answer"}]}});
        std::fs::write(&path, envelope.to_string()).unwrap();
        let recall = super::super::recall(
            data.path(),
            owner,
            &workspace,
            &serde_json::json!({"query":"needle accepted"}),
        )
        .unwrap();
        assert_eq!(recall["sessions"][0]["sessionId"], id);
        let transcript = load(
            data.path(),
            owner,
            workspace.to_str().unwrap(),
            Source::Structured,
            id,
        )
        .unwrap();
        assert_eq!(transcript.messages.len(), 3);
        assert_eq!(transcript.messages[0].role, "user");
        assert_eq!(transcript.messages[1].role, "tool");
        assert!(!serde_json::to_string(&transcript.messages)
            .unwrap()
            .contains("PRIVATE-THOUGHT"));
        assert!(load(
            data.path(),
            "other",
            workspace.to_str().unwrap(),
            Source::Structured,
            id
        )
        .is_err());
        envelope["ownerId"] = serde_json::json!("other");
        std::fs::write(&path, envelope.to_string()).unwrap();
        assert!(load(
            data.path(),
            owner,
            workspace.to_str().unwrap(),
            Source::Structured,
            id
        )
        .is_err());
    }
    #[test]
    fn structured_v2_tail_recalls_completed_content_and_rejects_copied_foreign_owner() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let owner = "v2_owner_λ";
        let other = "other_v2_owner";
        let id = "ss-00000000-0000-4000-8000-000000000098";
        let directory = hashed_root(data.path(), owner, "structured-sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{id}.json"));
        let checkpoint = json!({"version":2,"ownerId":owner,"snapshot":{
            "id":id,"title":"Appended fixture","cwd":workspace,"provider":"deepseek",
            "createdAt":"2026-10-20T12:00:00Z","updatedAt":"2026-10-20T12:00:00Z","status":"idle","events":[]
        }});
        std::fs::write(&path, format!("{checkpoint}\n")).unwrap();
        let initial = load(
            data.path(),
            owner,
            workspace.to_str().unwrap(),
            Source::Structured,
            id,
        )
        .unwrap();
        assert!(initial.messages.is_empty());
        let events = [
            json!({"type":"user_message_accepted","seq":1,"ts":1,"requestId":"request1","turnId":"turn1","messageId":"user1","content":"Appended request fixture"}),
            json!({"type":"message_delta","seq":2,"ts":2,"turnId":"turn1","role":"assistant","content":"Incomplete excluded"}),
            json!({"type":"raw_provider_event","seq":3,"ts":3,"provider":"deepseek","data":{"reasoning_content":"PRIVATE-THOUGHT"}}),
            json!({"type":"message_completed","seq":4,"ts":4,"turnId":"turn1","role":"assistant","content":"needle appended completed answer 🐈"}),
            json!({"type":"turn_completed","seq":5,"ts":5,"turnId":"turn1","status":"completed"}),
        ];
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        for event in events {
            writeln!(
                file,
                "{}",
                json!({"updatedAt":"2026-10-20T12:00:05Z","event":event})
            )
            .unwrap();
        }
        drop(file);

        let transcript = load(
            data.path(),
            owner,
            workspace.to_str().unwrap(),
            Source::Structured,
            id,
        )
        .unwrap();
        assert_eq!(
            transcript
                .messages
                .iter()
                .map(|message| (message.role.as_str(), message.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "Appended request fixture"),
                ("assistant", "needle appended completed answer 🐈")
            ],
        );
        assert_eq!(transcript.updated_at, "2026-10-20T12:00:05Z");
        assert_ne!(transcript.fingerprint, initial.fingerprint);
        let recall = super::super::recall(
            data.path(),
            owner,
            &workspace,
            &json!({"query":"appended completed answer"}),
        )
        .unwrap();
        assert_eq!(
            (
                recall["sessions"][0]["sessionId"].clone(),
                recall["sessions"][0]["anchor"].clone()
            ),
            (json!(id), json!(2))
        );
        assert!(recall["sessions"][0]["excerpt"]
            .as_str()
            .unwrap()
            .contains("needle appended completed answer"));

        let other_directory = hashed_root(data.path(), other, "structured-sessions");
        std::fs::create_dir_all(&other_directory).unwrap();
        std::fs::copy(&path, other_directory.join(format!("{id}.json"))).unwrap();
        assert_eq!(
            load(
                data.path(),
                other,
                workspace.to_str().unwrap(),
                Source::Structured,
                id
            )
            .err()
            .unwrap(),
            "Structured owner binding is invalid",
        );
        let foreign = super::super::recall(
            data.path(),
            other,
            &workspace,
            &json!({"query":"appended completed answer"}),
        )
        .unwrap();
        assert_eq!(foreign["sessions"], json!([]));
    }
    #[test]
    fn ambiguous_legacy_account_aliases_are_not_recalled() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('owner'),('ow_ner');",
        )
        .unwrap();
        let path = data.path().join("users/owner/structured/ss-fixture.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path,serde_json::json!({"id":"ss-fixture","cwd":workspace,"provider":"claude","events":[{"type":"message_completed","role":"user","content":"ambiguous private fixture"}]}).to_string()).unwrap();
        assert!(load(
            data.path(),
            "owner",
            workspace.to_str().unwrap(),
            Source::Structured,
            "ss-fixture"
        )
        .is_err());
    }
}
