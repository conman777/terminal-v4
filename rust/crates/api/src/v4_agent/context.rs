//! Local saved text/metadata projection. This module never resolves provider secrets or hydrates images.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) message: String,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
}
impl Failure {
    fn unavailable(message: &str) -> Self {
        Self {
            message: message.into(),
            provider: None,
            model: None,
        }
    }
    fn target(session: &super::Session) -> Self {
        Self{message:"The selected target differs from the saved conversation target; restore the saved selection before compacting".into(),provider:Some(session.provider.clone()),model:Some(session.model.clone())}
    }
}
fn existing_head(data: &Path, owner: &str, workspace: &Path, id: &str) -> Result<bool, Failure> {
    let normalized = crate::session_search::normalize_workspace_path(&workspace.to_string_lossy());
    let parts = [
        "v4-agent-history".to_string(),
        hex::encode(Sha256::digest(owner.as_bytes())),
        hex::encode(Sha256::digest(normalized.as_bytes())),
    ];
    let mut path = PathBuf::from(data);
    let root = std::fs::symlink_metadata(&path)
        .map_err(|_| Failure::unavailable("Saved history storage is unavailable"))?;
    if !root.is_dir() || root.file_type().is_symlink() {
        return Err(Failure::unavailable("Saved history storage is unsafe"));
    }
    for part in parts {
        path.push(part);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(Failure::unavailable("Saved history storage is unsafe"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(Failure::unavailable("Saved history storage is unavailable")),
        }
    }
    if std::fs::symlink_metadata(path.join(format!("{id}.deleted"))).is_ok() {
        return Err(Failure::unavailable("The saved conversation was deleted"));
    }
    match std::fs::symlink_metadata(path.join(format!("{id}.json"))) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > 2_000_000 =>
        {
            Err(Failure::unavailable(
                "Saved history is unsafe or exceeds its limit",
            ))
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Failure::unavailable("Saved history is unavailable")),
    }
}
fn validate_target(
    session: &super::Session,
    provider: &str,
    model: &str,
    reasoning: Option<&str>,
) -> Result<String, Failure> {
    if session.model.trim().is_empty()
        || session.model.len() > 200
        || session.model.chars().any(char::is_control)
    {
        return Err(Failure::unavailable(
            "Saved target metadata is invalid; review the conversation before compacting",
        ));
    }
    if session.provider != provider || session.model != model {
        return Err(Failure::target(session));
    }
    let transport = super::session_transport(session)
        .map_err(|_| Failure::unavailable("Saved protocol is unavailable"))?;
    if super::selected_transport(provider, model).ok().as_deref() != Some(transport.as_str()) {
        return Err(Failure::target(session));
    }
    super::resolve_selection(provider, Some(model), reasoning).map_err(|_| {
        Failure::unavailable("The selected reasoning setting is unavailable for the saved target")
    })?;
    Ok(transport)
}
pub(crate) fn target_revision(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
    provider: &str,
    model: &str,
    reasoning: Option<&str>,
) -> Result<String, String> {
    let session = super::load(data, owner, workspace, id)?;
    validate_target(&session, provider, model, reasoning).map_err(|failure| failure.message)?;
    if !session
        .messages
        .iter()
        .any(|message| message.role == "user")
        || session.history.is_empty()
    {
        return Err("Compaction needs an existing saved conversation".into());
    }
    Ok(super::session_fingerprint(&session))
}
#[derive(Default)]
pub(crate) struct ContextOptions<'a> {
    pub(crate) reasoning: Option<&'a str>,
    pub(crate) background_delegation: bool,
}

pub(crate) fn sample(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
    provider: &str,
    model: &str,
    options: ContextOptions<'_>,
) -> Result<Value, Failure> {
    let reasoning = options.reasoning;
    let workspace = workspace
        .canonicalize()
        .map_err(|_| Failure::unavailable("Workspace is unavailable"))?;
    if owner.is_empty()
        || owner.len() > 512
        || owner.chars().any(char::is_control)
        || uuid::Uuid::parse_str(id).is_err()
    {
        return Err(Failure::unavailable("Saved conversation scope is invalid"));
    }
    if !existing_head(data, owner, &workspace, id)? {
        return Ok(
            json!({"saved":false,"provider":provider,"model":model,"usage":null,"conversationRevision":null,"canCompact":false}),
        );
    }
    let session = super::load(data, owner, &workspace, id)
        .map_err(|_| Failure::unavailable("Saved context could not be read safely"))?;
    let transport = validate_target(&session, provider, model, reasoning)?;
    if !session
        .messages
        .iter()
        .any(|message| message.role == "user")
        || session.history.is_empty()
    {
        return Ok(
            json!({"saved":false,"provider":session.provider,"model":session.model,"usage":null,"conversationRevision":null,"canCompact":false}),
        );
    }
    let revision = super::session_fingerprint(&session);
    let system = super::workspace_context(data, owner, &workspace).map_err(|_| {
        Failure::unavailable("Account or workspace instructions could not be read safely")
    })?;
    let mut tools = super::local_tool_definitions(super::ToolPolicy::Standard, data, owner)
        .map_err(|_| Failure::unavailable("Integration declaration metadata is unavailable; review settings before refreshing context"))?;
    if let Some(tool) =
        super::background_delegation_declaration(&session.provider, options.background_delegation)
    {
        tools.push(tool);
    }
    let usage =
        super::compaction::measure_transport(&transport, &session, &system, &tools, reasoning)
            .map_err(|_| Failure::unavailable("Saved text context could not be measured safely"))?;
    let eligible = super::compaction::can_compact(&session, &transport)
        .map_err(|_| Failure::unavailable("Saved context has an incomplete protocol boundary"))?;
    Ok(
        json!({"saved":true,"provider":session.provider,"model":session.model,"usage":usage,"conversationRevision":revision,"canCompact":eligible}),
    )
}

#[cfg(test)]
pub(crate) fn seed(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
    provider: &str,
    model: &str,
) -> String {
    let workspace = workspace.canonicalize().unwrap();
    let mut session = super::new_session(provider, model, &workspace);
    session.id = id.into();
    session.messages = vec![
        super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "First prompt".into(),
        },
        super::Message {
            attachments: Vec::new(),
            role: "assistant".into(),
            text: "First answer".into(),
        },
        super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "Second prompt".into(),
        },
    ];
    session.history = vec![
        serde_json::json!({"role":"user","content":"First prompt"}),
        serde_json::json!({"role":"assistant","content":"First answer"}),
        serde_json::json!({"role":"user","content":"Second prompt"}),
    ];
    super::save(data, owner, &mut session).unwrap();
    let revision = super::session_fingerprint(&session);
    assert_eq!(
        super::conversation_revision(data, owner, &workspace, id).unwrap(),
        revision
    );
    revision
}

#[cfg(test)]
pub(crate) fn corrupt_saved_model(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
    model: &str,
) {
    let workspace = workspace.canonicalize().unwrap();
    let mut session = super::load(data, owner, &workspace, id).unwrap();
    session.model = model.into();
    super::save(data, owner, &mut session).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn structured_projection_includes_available_background_delegation_and_matches_usage() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        seed(
            data.path(),
            "owner",
            &root,
            &id,
            "deepseek",
            "deepseek-chat",
        );
        let mut session = super::super::load(data.path(), "owner", &root, &id).unwrap();
        let system = super::super::workspace_context(data.path(), "owner", &root).unwrap();
        let mut tools = super::super::local_tool_definitions(
            super::super::ToolPolicy::Standard,
            data.path(),
            "owner",
        )
        .unwrap();
        tools.push(super::super::background_delegation_declaration("deepseek", true).unwrap());
        super::super::compaction::note_usage_v2(
            &mut session,
            &json!({"usage":{"prompt_tokens":123}}),
            &system,
            "openai-chat",
            &tools,
            None,
        );
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let enabled = sample(
            data.path(),
            "owner",
            &root,
            &id,
            "deepseek",
            "deepseek-chat",
            ContextOptions {
                reasoning: None,
                background_delegation: true,
            },
        )
        .unwrap();
        let disabled = sample(
            data.path(),
            "owner",
            &root,
            &id,
            "deepseek",
            "deepseek-chat",
            ContextOptions {
                reasoning: None,
                background_delegation: false,
            },
        )
        .unwrap();
        let expected = super::super::protocol::request(
            "deepseek",
            "openai-chat",
            "deepseek-chat",
            &system,
            &session.history,
            &tools,
            None,
        );
        assert_eq!(
            enabled["usage"]["requestBytes"],
            serde_json::to_vec(&expected).unwrap().len()
        );
        assert_eq!(enabled["usage"]["lastRequest"]["inputTokens"], 123);
        assert_eq!(disabled["usage"]["lastRequest"], Value::Null);
        assert!(
            disabled["usage"]["requestBytes"].as_u64().unwrap()
                < enabled["usage"]["requestBytes"].as_u64().unwrap()
        );
    }
    #[test]
    fn saved_projection_matches_text_metadata_request_and_never_hydrates_images() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        seed(
            data.path(),
            "owner",
            workspace.path(),
            &id,
            "deepseek",
            "deepseek-chat",
        );
        let mut session = super::super::load(
            data.path(),
            "owner",
            &workspace.path().canonicalize().unwrap(),
            &id,
        )
        .unwrap();
        session.history.push(serde_json::json!({"role":"user","content":[{"type":"v4_image","artifactId":"0".repeat(64),"mimeType":"image/png"}]}));
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let projection = sample(
            data.path(),
            "owner",
            workspace.path(),
            &id,
            "deepseek",
            "deepseek-chat",
            ContextOptions::default(),
        )
        .unwrap();
        let system =
            super::super::workspace_context(data.path(), "owner", workspace.path()).unwrap();
        let tools = super::super::tool_definitions(
            super::super::ToolPolicy::Standard,
            data.path(),
            "owner",
        )
        .unwrap();
        for name in [
            "create_schedule",
            "list_schedules",
            "manage_schedule",
            "ask_user",
            "todo_list",
        ] {
            assert!(
                tools.iter().any(|tool| tool["name"] == name),
                "missing {name}"
            );
        }
        let expected = super::super::protocol::request(
            "deepseek",
            "openai-chat",
            "deepseek-chat",
            &system,
            &session.history,
            &tools,
            None,
        );
        assert_eq!(
            projection["usage"]["requestBytes"],
            serde_json::json!(serde_json::to_vec(&expected).unwrap().len())
        );
        assert_eq!(
            projection["usage"]["measurementScope"],
            "saved_text_and_metadata"
        );
        assert_eq!(
            projection["conversationRevision"],
            super::super::session_fingerprint(&session)
        );
    }
    #[test]
    fn saved_projection_rejects_a_different_selected_target_before_credentials() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        seed(
            data.path(),
            "owner",
            workspace.path(),
            &id,
            "deepseek",
            "deepseek-chat",
        );
        assert!(sample(
            data.path(),
            "owner",
            workspace.path(),
            &id,
            "deepseek",
            "deepseek-reasoner",
            ContextOptions::default()
        )
        .is_err());
        assert!(!data.path().join("terminal.db").exists());
    }
    #[test]
    fn invalid_saved_target_metadata_is_not_exported_through_mismatch_failure() {
        for model in [
            "PRIVATE-INVALID-TARGET".repeat(20),
            "PRIVATE\nMODEL".into(),
            "PRIVATE\u{7f}MODEL".into(),
        ] {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            seed(
                data.path(),
                "owner",
                workspace.path(),
                &id,
                "deepseek",
                "deepseek-chat",
            );
            corrupt_saved_model(data.path(), "owner", workspace.path(), &id, &model);
            let failure = sample(
                data.path(),
                "owner",
                workspace.path(),
                &id,
                "deepseek",
                "deepseek-chat",
                ContextOptions::default(),
            )
            .unwrap_err();
            assert!(
                failure.model.is_none(),
                "invalid saved model must not be copied into public target metadata"
            );
            assert!(failure.message.len() < 500);
            assert!(!failure.message.contains("PRIVATE"));
            assert!(!data.path().join("agent-mcp").exists());
        }
    }
}
