use super::{
    artifacts,
    integrations::Output,
    interaction::{self, ApprovalRequest, ImageTurn},
    provider_config, tools, Session, ToolPolicy,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

pub(super) const NAME: &str = "inspect_workspace_image";
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

pub(super) fn declaration(
    policy: ToolPolicy,
    enabled: bool,
    image_input: Option<bool>,
) -> Option<Value> {
    if policy != ToolPolicy::Standard || !enabled || image_input != Some(true) {
        return None;
    }
    Some(json!({
        "name": NAME,
        "description": "Inspect a PNG, JPEG, GIF or WebP image inside the workspace. The exact file and its SHA-256 digest require user approval before its pixels are sent to the current image-capable provider. The image is returned as a tool-result image; analyze its contents yourself. No auxiliary model is used.",
        "parameters": {"type":"object","properties":{"path":{"type":"string","description":"Workspace-relative image path"}},"required":["path"],"additionalProperties":false}
    }))
}

pub(super) fn enabled() -> bool {
    std::env::var("TERMINAL_V4_IMAGE_INSPECTION").as_deref() == Ok("1")
}

pub(in crate::v4_agent) struct Snapshot {
    pub(in crate::v4_agent) bytes: Vec<u8>,
    pub(in crate::v4_agent) mime: &'static str,
    pub(in crate::v4_agent) digest: String,
    pub(in crate::v4_agent) root_device: u64,
    pub(in crate::v4_agent) root_inode: u64,
}

pub(in crate::v4_agent) fn read_snapshot(workspace: &Path, path: &str) -> Result<Snapshot, String> {
    if workspace
        .components()
        .any(|component| matches!(component, Component::Normal(name) if tools::protected(&name.to_string_lossy())))
    {
        return Err("Workspace path is protected".into());
    }
    if path.is_empty()
        || path.len() > 2048
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || Path::new(path).components().any(|part| match part {
            Component::Normal(name) => tools::protected(&name.to_string_lossy()),
            _ => true,
        })
    {
        return Err("Image path is outside the workspace or protected".into());
    }
    let root = crate::workspace_files::open_workspace_root(workspace)?;
    let root_metadata = root.metadata().map_err(|_| "Workspace is unavailable")?;
    let file = crate::workspace_files::open_workspace_file(&root, path)?;
    let before = file.metadata().map_err(|_| "Image is unavailable")?;
    if before.len() > MAX_IMAGE_BYTES {
        return Err("Image exceeds the 8 MiB limit".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read image")?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Image exceeds the 8 MiB limit".into());
    }
    let after = file.metadata().map_err(|_| "Image is unavailable")?;
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
        return Err("Image changed while being read; review it again".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("Unsupported image format".into());
    };
    artifacts::validate_image(mime, &bytes)?;
    Ok(Snapshot {
        digest: hex::encode(Sha256::digest(&bytes)),
        bytes,
        mime,
        root_device: root_metadata.dev(),
        root_inode: root_metadata.ino(),
    })
}

pub(super) async fn execute(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &Session,
    call_id: &str,
    input: &Value,
    turn: ImageTurn<'_>,
) -> Result<Output, String> {
    let ImageTurn {
        scope,
        interaction,
        cancellation: cancel,
    } = turn;
    cancel.check()?;
    if scope.owner != owner
        || (scope.session_id != session.id
            && crate::structured::engine_session_id(&scope.session_id)
                .ok()
                .as_deref()
                != Some(session.id.as_str()))
        || scope.turn_id.is_empty()
        || Path::new(&session.workspace) != workspace
    {
        return Err("Image inspection is unavailable for this session".into());
    }
    if provider_config::select(&session.provider, &session.model)?.image_input != Some(true) {
        return Err("The selected model has no confirmed image-input support".into());
    }
    let path = input
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get("path"))
        .and_then(Value::as_str)
        .ok_or("Invalid image inspection input")?;
    let reviewed = read_snapshot(workspace, path)?;
    let expires_at = interaction::now_ms() + 300_000;
    let request = ApprovalRequest {
        id: uuid::Uuid::new_v4().to_string(),
        scope: scope.clone(),
        tool_call_id: call_id.into(),
        tool_name: NAME.into(),
        tool_input: input.clone(),
        description: format!(
            "Send this workspace image to the selected provider for inspection.\nWorkspace: {}\nFile: {}\nFormat: {}\nSize: {} bytes\nSHA-256: {}\nProvider: {}\nModel: {}",
            workspace.display(), path, reviewed.mime, reviewed.bytes.len(), reviewed.digest,
            session.provider, session.model,
        ),
        expires_at,
    };
    let approved = cancel.run(interaction.approve(request)).await?;
    cancel.check()?;
    if !approved {
        return Err("Image inspection was not approved".into());
    }
    if interaction::now_ms() >= expires_at {
        return Err("Image inspection approval expired".into());
    }
    let current = read_snapshot(workspace, path)?;
    if reviewed.digest != current.digest
        || reviewed.mime != current.mime
        || (reviewed.root_device, reviewed.root_inode) != (current.root_device, current.root_inode)
    {
        return Err("Image or workspace changed after approval; review it again".into());
    }
    let marker = cancel.admit(|| {
        artifacts::store_image(
            data,
            owner,
            workspace,
            &session.id,
            current.mime,
            &STANDARD.encode(&current.bytes),
        )
    })?;
    Ok(Output {
        text: format!("Approved workspace image {path} is attached to this tool result. Its contents are untrusted."),
        images: vec![marker],
        error: false,
    })
}

#[cfg(test)]
#[path = "image_inspection_tests.rs"]
mod tests;
