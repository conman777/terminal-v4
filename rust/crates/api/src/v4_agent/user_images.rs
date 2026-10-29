//! Owned user image staging. The structured-session state fence is held by every
//! caller. Immutable engine artifacts have a separate lifetime from staging.
use super::{artifacts, protocol, *};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use terminal_v4_core::ImageAttachment;

pub(crate) const IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const SEND_BYTES: usize = 16 * 1024 * 1024;
const TTL_MS: i64 = 72 * 60 * 60 * 1000;
const REGISTRY_ENTRIES: usize = 1024;

#[derive(Debug)]
pub(crate) struct Error {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}
impl Error {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid",
            message: message.into(),
        }
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: "conflict",
            message: message.into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal",
            message: message.into(),
        }
    }
    fn gone() -> Self {
        Self { code:"gone", message:"This staged image has expired or was removed; attach it again using a new upload identity".into() }
    }
    fn missing() -> Self {
        Self {
            code: "not_found",
            message: "Image attachment not found".into(),
        }
    }
}
impl From<String> for Error {
    fn from(value: String) -> Self {
        Self::internal(value)
    }
}

pub(crate) fn validate_descriptor(image: &ImageAttachment) -> Result<(), Error> {
    if uuid::Uuid::parse_str(&image.attachment_id)
        .ok()
        .is_none_or(|id| id.to_string() != image.attachment_id)
        || !artifacts::valid_id(&image.artifact_id)
        || image.bytes == 0
        || image.bytes > IMAGE_BYTES as u64
        || image.name.is_empty()
        || image.name.len() > 255
        || image
            .name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        || artifacts::extension(&image.mime_type).is_err()
    {
        return Err(Error::invalid("Invalid image attachment descriptor"));
    }
    Ok(())
}
pub(crate) fn validate_manifest(images: &[ImageAttachment]) -> Result<(), Error> {
    if images.is_empty() || images.len() > 8 {
        return Err(Error::invalid(
            "An image send requires one to eight attachments",
        ));
    }
    let mut bytes = 0u64;
    for image in images {
        validate_descriptor(image)?;
        bytes = bytes
            .checked_add(image.bytes)
            .ok_or_else(|| Error::invalid("Image byte budget exceeded"))?;
    }
    if bytes > SEND_BYTES as u64 {
        return Err(Error::invalid(
            "Image send exceeds 16 MiB of decoded image data",
        ));
    }
    Ok(())
}
pub(crate) fn markers(images: &[ImageAttachment]) -> Vec<Value> {
    images.iter().map(|image|json!({"type":"v4_image","artifactId":image.artifact_id,"mimeType":image.mime_type})).collect()
}
pub(crate) fn user_message(text: &str, images: &[ImageAttachment]) -> Value {
    if images.is_empty() {
        return json!({"role":"user","content":text});
    }
    let mut content = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() {
        content.push(json!({"type":"text","text":text}));
    }
    content.extend(markers(images));
    let content = Value::Array(content);
    let content_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&content).expect("serializable image input"),
    ));
    json!({"role":"user","content":content,"_v4UserInput":{"version":1,"contentHash":content_hash}})
}
// A content-bound host origin distinguishes real user captions from the
// legacy tool-image helper wording. This is metadata, not provider authority.
pub(super) fn user_origin(item: &Value) -> Result<bool, String> {
    let Some(origin) = item.get("_v4UserInput") else {
        return Ok(false);
    };
    let content = &item["content"];
    let valid = item["role"] == "user"
        && origin.as_object().is_some_and(|object| object.len() == 2)
        && origin["version"] == 1
        && content.as_array().is_some_and(|blocks| !blocks.is_empty())
        && origin["contentHash"].as_str()
            == Some(
                hex::encode(Sha256::digest(
                    serde_json::to_vec(content).map_err(|_| "Invalid saved user-image input")?,
                ))
                .as_str(),
            );
    if !valid {
        return Err("Saved user-image origin metadata is invalid; history was preserved".into());
    }
    Ok(true)
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    attachment: ImageAttachment,
    created_at: i64,
    expires_at: i64,
    state: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u8,
    owner_hash: String,
    workspace_hash: String,
    session_id: String,
    entries: BTreeMap<String, Entry>,
    #[serde(default)]
    cancelled_ids: BTreeSet<String>,
}
pub(crate) struct Store {
    directory: artifacts::Directory,
    _lock: artifacts::WriteLock,
    registry: Registry,
    now: i64,
    data: PathBuf,
    owner: String,
    workspace: PathBuf,
}
impl Store {
    pub(crate) fn open(
        data: &Path,
        owner: &str,
        workspace: &Path,
        session: &str,
        now: i64,
    ) -> Result<Self, Error> {
        let mut parts = artifacts::scope_parts(owner, workspace, session)?;
        parts[0] = "v4-user-image-staging".into();
        let directory = artifacts::Directory::open(data, &parts, true)?;
        let lock = directory.write_lock()?;
        let registry = match directory.read_file("registry.json")? {
            Some(bytes) => serde_json::from_slice::<Registry>(&bytes).map_err(|_| {
                Error::internal(
                    "Image staging registry is corrupt; existing identities were preserved",
                )
            })?,
            None => Registry {
                version: 1,
                owner_hash: parts[1].clone(),
                workspace_hash: parts[2].clone(),
                session_id: parts[3].clone(),
                entries: BTreeMap::new(),
                cancelled_ids: BTreeSet::new(),
            },
        };
        if registry.version != 1
            || registry.owner_hash != parts[1]
            || registry.workspace_hash != parts[2]
            || registry.session_id != parts[3]
            || registry
                .entries
                .keys()
                .chain(registry.cancelled_ids.iter())
                .collect::<HashSet<_>>()
                .len()
                > REGISTRY_ENTRIES
        {
            return Err(Error::internal(
                "Image staging registry does not match its owner, workspace and session",
            ));
        }
        for (id, entry) in &registry.entries {
            validate_descriptor(&entry.attachment).map_err(|_| {
                Error::internal("Image staging registry contains an invalid descriptor")
            })?;
            if id != &entry.attachment.attachment_id
                || !matches!(
                    entry.state.as_str(),
                    "preparing" | "ready" | "cancelled" | "expired"
                )
                || entry.created_at < 0
                || entry.expires_at < entry.created_at
                || entry.expires_at - entry.created_at > TTL_MS
            {
                return Err(Error::internal(
                    "Image staging registry contains invalid lifecycle data",
                ));
            }
        }
        for id in &registry.cancelled_ids {
            if uuid::Uuid::parse_str(id)
                .ok()
                .is_none_or(|uuid| uuid.to_string() != *id)
            {
                return Err(Error::internal("Invalid image cancellation tombstone"));
            }
        }
        Ok(Self {
            directory,
            _lock: lock,
            registry,
            now,
            data: data
                .canonicalize()
                .map_err(|_| Error::internal("Image data root is unavailable"))?,
            owner: owner.into(),
            workspace: workspace.into(),
        })
    }
    fn persist(&self) -> Result<(), Error> {
        let bytes = serde_json::to_vec(&self.registry)
            .map_err(|_| Error::internal("Cannot encode image staging registry"))?;
        if bytes.len() > 1_048_576 {
            return Err(Error::conflict("Image staging identity storage is full"));
        }
        self.directory
            .write_metadata("registry.json", &bytes)
            .map_err(Error::from)
    }
    fn filename(image: &ImageAttachment) -> Result<String, Error> {
        Ok(format!(
            "{}.{}",
            image.artifact_id,
            artifacts::extension(&image.mime_type)?
        ))
    }
    fn bytes(&self, image: &ImageAttachment) -> Result<Vec<u8>, Error> {
        let bytes = self
            .directory
            .read_file(&Self::filename(image)?)?
            .ok_or_else(|| Error::internal("Staged image bytes are unavailable"))?;
        if bytes.len() as u64 != image.bytes
            || artifacts::image_id(&image.mime_type, &bytes) != image.artifact_id
        {
            return Err(Error::internal("Staged image integrity check failed"));
        }
        artifacts::validate_user_image(&image.mime_type, &bytes).map_err(Error::from)?;
        Ok(bytes)
    }
    pub(crate) fn collect(&mut self, pins: &[ImageAttachment]) -> Result<(), Error> {
        let mut changed = false;
        for entry in self.registry.entries.values_mut() {
            if matches!(entry.state.as_str(), "ready" | "preparing") && entry.expires_at <= self.now
            {
                entry.state = "expired".into();
                changed = true;
            }
        }
        // Tombstone first, then remove only files in this private staging scope.
        if changed {
            self.persist()?;
        }
        let mut keep = HashSet::new();
        for entry in self.registry.entries.values() {
            if matches!(entry.state.as_str(), "ready" | "preparing")
                || pins.contains(&entry.attachment)
            {
                keep.insert(Self::filename(&entry.attachment)?);
            }
        }
        for name in self.directory.names()? {
            if matches!(name.as_str(), "registry.json" | ".write.lock") || keep.contains(&name) {
                continue;
            }
            if crash_temporary(&name) {
                // A known generated basename alone is insufficient: reject
                // symlinks, directories and over-limit files before unlinking.
                self.directory
                    .read_file(&name)?
                    .ok_or_else(|| Error::internal("Private image temporary disappeared"))?;
                self.directory.unlink(&name)?;
                continue;
            }
            if let Some((id, ext)) = name.rsplit_once('.') {
                if artifacts::valid_id(id) && matches!(ext, "png" | "jpg" | "gif" | "webp") {
                    // Do not follow or delete a substituted file or arbitrary entry.
                    let bytes = self.directory.read_file(&name)?.ok_or_else(|| {
                        Error::internal("Staged image disappeared during collection")
                    })?;
                    let mime = match ext {
                        "png" => "image/png",
                        "jpg" => "image/jpeg",
                        "gif" => "image/gif",
                        _ => "image/webp",
                    };
                    if artifacts::image_id(mime, &bytes) != id {
                        return Err(Error::internal(
                            "Unreferenced staged image failed integrity validation",
                        ));
                    }
                    self.directory.unlink(&name)?;
                    continue;
                }
            }
            return Err(Error::internal(
                "Unexpected entry in private image staging directory",
            ));
        }
        self.directory.sync()?;
        Ok(())
    }
    /// Collect only registry-known user copies. Live/native/archive/accepted
    /// pins are authoritative; unknown artifacts are never swept.
    pub(crate) fn collect_engine_copies(&self, pins: &[ImageAttachment]) -> Result<(), Error> {
        let parts =
            artifacts::scope_parts(&self.owner, &self.workspace, &self.registry.session_id)?;
        let Some(directory) = artifacts::Directory::open_optional(&self.data, &parts)? else {
            return Ok(());
        };
        // A separate CLI/native turn can be live while this manager is idle.
        // Skip only collection on explicit lease contention; staged validation
        // and the caller's actual read/upload/cancel continue normally.
        let Some(_lifetime) = session_store::image_collection_lease(
            &self.data,
            &self.owner,
            &self.workspace,
            &self.registry.session_id,
        )?
        else {
            return Ok(());
        };
        let _lock = directory.write_lock()?;
        let mut keep = pins
            .iter()
            .map(Self::filename)
            .collect::<Result<HashSet<_>, _>>()?;
        let mut candidates = BTreeMap::new();
        for entry in self.registry.entries.values() {
            let name = Self::filename(&entry.attachment)?;
            if !keep.contains(&name) {
                candidates.entry(name).or_insert(&entry.attachment);
            }
        }
        // Most uploads have no engine copy. Avoid reading retained history at
        // all when no candidate immutable file exists.
        let mut existing = BTreeMap::new();
        for (name, image) in candidates {
            if directory.read_file(&name)?.is_some() {
                existing.insert(name, image);
            }
        }
        if existing.is_empty() {
            return Ok(());
        }
        // A missing/unreadable head is uncertain retention. Preserve every
        // candidate until authoritative complete history can be inspected.
        let session = load(
            &self.data,
            &self.owner,
            &self.workspace,
            &self.registry.session_id,
        )?;
        let history = session_store::complete_history(&self.data, &self.owner, &session)?;
        for image in protocol::image_inputs(&history) {
            if image["type"] == "v4_image" {
                let id = image["artifactId"]
                    .as_str()
                    .filter(|id| artifacts::valid_id(id))
                    .ok_or_else(|| Error::internal("Invalid retained image reference"))?;
                let mime = image["mimeType"]
                    .as_str()
                    .ok_or_else(|| Error::internal("Invalid retained image MIME type"))?;
                keep.insert(format!("{}.{}", id, artifacts::extension(mime)?));
            }
        }
        for (name, image) in existing {
            if !keep.contains(&name) {
                let bytes = directory
                    .read_file(&name)?
                    .ok_or_else(|| Error::internal("Engine image changed during collection"))?;
                if artifacts::image_id(&image.mime_type, &bytes) != image.artifact_id {
                    return Err(Error::internal(
                        "Engine image integrity changed during collection",
                    ));
                }
                directory.unlink(&name)?;
            }
        }
        directory.sync()?;
        Ok(())
    }
    pub(crate) fn retire(&mut self) -> Result<(), Error> {
        for entry in self.registry.entries.values_mut() {
            entry.state = "cancelled".into();
        }
        self.persist()?;
        self.collect(&[])
    }
    pub(crate) fn upload(
        &mut self,
        id: &str,
        mime: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<(ImageAttachment, i64, bool), Error> {
        let id = uuid::Uuid::parse_str(id)
            .map_err(|_| Error::invalid("uploadId must be a UUID"))?
            .to_string();
        if self.registry.cancelled_ids.contains(&id) {
            return Err(Error::conflict(
                "This upload identity was cancelled; attach using a new identity",
            ));
        }
        artifacts::validate_user_image(mime, &bytes).map_err(Error::invalid)?;
        let attachment = ImageAttachment {
            attachment_id: id.clone(),
            artifact_id: artifacts::image_id(mime, &bytes),
            mime_type: mime.into(),
            bytes: bytes.len() as u64,
            name: name.into(),
        };
        validate_descriptor(&attachment)?;
        let created = !self.registry.entries.contains_key(&id);
        let expires = if let Some(existing) = self.registry.entries.get(&id) {
            if !matches!(existing.state.as_str(), "ready" | "preparing")
                || existing.expires_at <= self.now
            {
                return Err(Error::conflict(
                    "This upload identity was cancelled or expired; attach using a new identity",
                ));
            }
            if existing.attachment != attachment {
                return Err(Error::conflict(
                    "uploadId was already bound to different image bytes or metadata",
                ));
            }
            if existing.state == "ready" {
                if self.bytes(&attachment)? != bytes {
                    return Err(Error::internal(
                        "Stored upload identity failed integrity validation",
                    ));
                }
                return Ok((attachment, existing.expires_at, false));
            }
            existing.expires_at
        } else {
            if self
                .registry
                .entries
                .keys()
                .chain(self.registry.cancelled_ids.iter())
                .collect::<HashSet<_>>()
                .len()
                >= REGISTRY_ENTRIES
            {
                return Err(Error::conflict(
                    "Image staging identity storage is full; start another conversation",
                ));
            }
            let expires = self
                .now
                .checked_add(TTL_MS)
                .ok_or_else(|| Error::internal("Image staging clock overflow"))?;
            self.registry.entries.insert(
                id.clone(),
                Entry {
                    attachment: attachment.clone(),
                    created_at: self.now,
                    expires_at: expires,
                    state: "preparing".into(),
                },
            );
            // No blob exists before this descriptor/UUID reservation commits.
            // An uncertain rename is retained and can only resume identical bytes.
            self.persist()?;
            expires
        };
        let prepared = artifacts::PreparedImage {
            name: Self::filename(&attachment)?,
            marker: markers(std::slice::from_ref(&attachment)).remove(0),
            bytes,
        };
        self.directory
            .store_batch_locked(std::slice::from_ref(&prepared))?;
        self.registry
            .entries
            .get_mut(&id)
            .expect("reserved upload identity")
            .state = "ready".into();
        // On any uncertain final metadata publication keep reserved immutable
        // bytes. A same-body retry completes preparing→ready; TTL/cancel collects
        // failed staging. Never delete deduplicated/pre-existing image content.
        self.persist()?;
        Ok((attachment, expires, created))
    }
    pub(crate) fn read(
        &self,
        id: &str,
        pins: &[ImageAttachment],
    ) -> Result<(ImageAttachment, Vec<u8>, i64), Error> {
        let entry = self.registry.entries.get(id).ok_or_else(|| {
            if self.registry.cancelled_ids.contains(id) {
                Error::gone()
            } else {
                Error::missing()
            }
        })?;
        if entry.state == "preparing" {
            return Err(Error::conflict(
                "Image upload is incomplete; retry the exact upload identity and bytes",
            ));
        }
        if (entry.state != "ready" || entry.expires_at <= self.now)
            && !pins.contains(&entry.attachment)
        {
            return Err(Error::gone());
        }
        Ok((
            entry.attachment.clone(),
            self.bytes(&entry.attachment)?,
            entry.expires_at,
        ))
    }
    pub(crate) fn cancel(&mut self, id: &str) -> Result<(), Error> {
        if uuid::Uuid::parse_str(id)
            .ok()
            .is_none_or(|uuid| uuid.to_string() != id)
        {
            return Err(Error::invalid("attachmentId must be a canonical UUID"));
        }
        if !self.registry.entries.contains_key(id)
            && !self.registry.cancelled_ids.contains(id)
            && self
                .registry
                .entries
                .keys()
                .chain(self.registry.cancelled_ids.iter())
                .collect::<HashSet<_>>()
                .len()
                >= REGISTRY_ENTRIES
        {
            return Err(Error::conflict("Image staging identity storage is full"));
        }
        let mut changed = self.registry.cancelled_ids.insert(id.into());
        if let Some(entry) = self.registry.entries.get_mut(id) {
            if matches!(entry.state.as_str(), "ready" | "preparing") {
                entry.state = "cancelled".into();
                changed = true;
            }
        }
        if changed {
            self.persist()?;
        }
        Ok(())
    }
    pub(crate) fn manifest_bytes(
        &self,
        images: &[ImageAttachment],
    ) -> Result<Vec<(String, String)>, Error> {
        validate_manifest(images)?;
        images
            .iter()
            .map(|image| {
                let entry = self
                    .registry
                    .entries
                    .get(&image.attachment_id)
                    .ok_or_else(|| {
                        Error::invalid("Image attachment does not belong to this session")
                    })?;
                if &entry.attachment != image {
                    return Err(Error::invalid(
                        "Image descriptor differs from the uploaded bytes or metadata",
                    ));
                }
                if entry.state != "ready" || entry.expires_at <= self.now {
                    return Err(Error::gone());
                }
                use base64::Engine;
                Ok((
                    image.mime_type.clone(),
                    base64::engine::general_purpose::STANDARD.encode(self.bytes(image)?),
                ))
            })
            .collect()
    }
}

fn crash_temporary(name: &str) -> bool {
    fn canonical_uuid(value: &str) -> bool {
        uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
    }
    if let Some(value) = name
        .strip_prefix(".registry.")
        .and_then(|value| value.strip_suffix(".tmp"))
    {
        return canonical_uuid(value);
    }
    let Some(value) = name
        .strip_prefix('.')
        .and_then(|value| value.strip_suffix(".tmp"))
    else {
        return false;
    };
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && artifacts::valid_id(parts[0])
        && matches!(parts[1], "png" | "jpg" | "gif" | "webp")
        && canonical_uuid(parts[2])
}

pub(crate) fn retire(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
) -> Result<(), String> {
    let mut parts = artifacts::scope_parts(owner, workspace, session)?;
    parts[0] = "v4-user-image-staging".into();
    if artifacts::Directory::open_optional(data, &parts)?.is_some() {
        Store::open(
            data,
            owner,
            workspace,
            session,
            crate::v4_agent::interaction::now_ms(),
        )
        .map_err(|e| e.message)?
        .retire()
        .map_err(|e| e.message)?;
    }
    artifacts::clear_image_scope(data, owner, workspace, session)
}

/// Validate the actual hydrated input before the structured accepted event exists.
/// No key resolution, provider HTTP, tools or automatic compaction occurs here.
pub(crate) fn preflight(
    data: &Path,
    owner: &str,
    workspace: &Path,
    engine_id: &str,
    provider: &str,
    model: &str,
    reasoning: Option<&str>,
    text: &str,
    images: &[ImageAttachment],
    events: &[StructuredSessionEvent],
) -> Result<(), Error> {
    let selection = provider_config::select(provider, model).map_err(Error::invalid)?;
    if selection.image_input != Some(true) {
        return Err(Error::invalid("The selected model has no confirmed image-input support; keep the draft and choose a supported model"));
    }
    let mut history = Vec::new();
    let mut known = Vec::new();
    let path = directory(data, owner, workspace).join(format!("{engine_id}.json"));
    if path
        .try_exists()
        .map_err(|_| Error::internal("Cannot inspect engine history"))?
    {
        let session = load(data, owner, workspace, engine_id)?;
        history = session.history;
        known = session.accepted_turn_ids;
    }
    for event in events {
        if let StructuredSessionEvent::UserMessageAccepted {
            turn_id,
            content,
            attachments,
            ..
        } = event
        {
            if !known.contains(turn_id) {
                history.push(user_message(content, attachments));
            }
        }
    }
    history.push(user_message(text, images));
    let image_values = protocol::image_inputs(&history);
    let mut hydrated = artifacts::hydrate_history(data, owner, workspace, engine_id, &image_values)
        .map_err(Error::invalid)?
        .into_iter();
    let history = protocol::map_images(&history, |_| {
        hydrated
            .next()
            .expect("one hydrated image per validated marker")
    });
    let system = workspace_context(data, owner, workspace)?;
    let mut definitions = tools::definitions();
    definitions.extend(knowledge::definitions());
    definitions.extend(integrations::definitions(data, owner)?);
    let request = protocol::request(
        provider,
        &selection.transport,
        model,
        &system,
        &history,
        &definitions,
        reasoning,
    );
    if serde_json::to_vec(&request)
        .map_err(|_| Error::internal("Cannot encode image provider input"))?
        .len()
        > 24_000_000
    {
        return Err(Error::invalid("Image provider request exceeds 24,000,000 bytes; compact the conversation or attach smaller images"));
    }
    Ok(())
}

pub(crate) struct Publication(Option<artifacts::ImagePublication>);
impl Publication {
    pub(crate) fn begin(
        data: &Path,
        owner: &str,
        workspace: &Path,
        session: &str,
        images: &[(String, String)],
    ) -> Result<Self, Error> {
        Ok(Self(Some(artifacts::ImagePublication::begin(
            data, owner, workspace, session, images,
        )?)))
    }
    pub(crate) fn commit(mut self) {
        if let Some(publication) = self.0.take() {
            publication.commit();
        }
    }
    pub(crate) fn rollback(mut self) -> Result<(), Error> {
        if let Some(publication) = self.0.take() {
            publication.rollback()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod image_admission_tests {
    use super::*;
    use crate::state::AppState;
    use base64::{engine::general_purpose::STANDARD, Engine};
    const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
    struct Fixture {
        data: tempfile::TempDir,
        _workspace: tempfile::TempDir,
        root: PathBuf,
        state: AppState,
        id: String,
        engine: String,
    }
    impl Fixture {
        async fn new() -> Self {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let root = workspace.path().canonicalize().unwrap();
            let state = AppState::new(terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            })
            .unwrap();
            let id = state
                .structured_session_manager()
                .create_session(
                    "owner",
                    root.to_str().unwrap(),
                    Some("deepseek"),
                    Some("deepseek-v4-flash"),
                    None,
                )
                .await
                .unwrap()
                .id;
            let engine = crate::structured::engine_session_id(&id).unwrap();
            Self {
                data,
                _workspace: workspace,
                root,
                state,
                id,
                engine,
            }
        }
        async fn upload(&self, bytes: Vec<u8>) -> ImageAttachment {
            self.state
                .structured_session_manager()
                .upload_image(
                    "owner",
                    &self.id,
                    &uuid::Uuid::new_v4().to_string(),
                    "image/png",
                    "fixture.png",
                    bytes,
                )
                .await
                .unwrap()
                .0
        }
        fn seed(&self, history: Vec<Value>) {
            let mut session = new_session("deepseek", "deepseek-v4-flash", &self.root);
            session.id = self.engine.clone();
            session.history = history;
            save(self.data.path(), "owner", &mut session).unwrap();
        }
        async fn rejected(
            &self,
            images: &[ImageAttachment],
        ) -> crate::structured::StructuredControlError {
            let request = uuid::Uuid::new_v4().to_string();
            let error = self
                .state
                .structured_session_manager()
                .submit_images("owner", &self.id, "", &request, images)
                .await
                .unwrap_err();
            let snapshot = self
                .state
                .structured_session_manager()
                .get_session("owner", &self.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                snapshot
                    .events
                    .iter()
                    .filter(|event| matches!(
                        event,
                        StructuredSessionEvent::UserMessageAccepted { .. }
                    ))
                    .count(),
                0
            );
            assert!(self
                .state
                .structured_session_manager()
                .request_receipt("owner", &self.id, &request)
                .await
                .unwrap()
                .is_none());
            error
        }
    }
    fn padded_png(size: usize) -> Vec<u8> {
        let source = STANDARD.decode(PNG).unwrap();
        let length = size - source.len() - 12;
        let mut payload = b"tEXtv4\0".to_vec();
        payload.resize(length + 4, b'v');
        let mut crc = u32::MAX;
        for byte in &payload {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 0 {
                    crc >> 1
                } else {
                    (crc >> 1) ^ 0xedb8_8320
                };
            }
        }
        let mut bytes = source[..source.len() - 12].to_vec();
        bytes.extend_from_slice(&(length as u32).to_be_bytes());
        bytes.extend_from_slice(&payload);
        bytes.extend_from_slice(&(!crc).to_be_bytes());
        bytes.extend_from_slice(&source[source.len() - 12..]);
        assert_eq!(bytes.len(), size);
        bytes
    }
    #[tokio::test]
    async fn image_admission_history_and_new_images_exceeding_32_are_rejected_before_acceptance() {
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        artifacts::store_images(
            f.data.path(),
            "owner",
            &f.root,
            &f.engine,
            &[("image/png".into(), PNG.into())],
        )
        .unwrap();
        f.seed(vec![user_message("previous", &vec![image.clone(); 32])]);
        let error = f.rejected(&[image]).await;
        assert_eq!(error.code, "invalid");
        assert!(error.message.contains("too many image"));
    }
    #[tokio::test]
    async fn image_admission_history_plus_exact_16mib_new_input_is_rejected_and_only_new_engine_files_roll_back(
    ) {
        let f = Fixture::new().await;
        let small = f.upload(STANDARD.decode(PNG).unwrap()).await;
        artifacts::store_images(
            f.data.path(),
            "owner",
            &f.root,
            &f.engine,
            &[("image/png".into(), PNG.into())],
        )
        .unwrap();
        f.seed(vec![user_message("previous", std::slice::from_ref(&small))]);
        let large = f.upload(padded_png(8 * 1024 * 1024)).await;
        let error = f.rejected(&[large.clone(), large.clone()]).await;
        assert_eq!(error.code, "invalid");
        assert!(error.message.contains("byte limit"));
        assert_eq!(
            artifacts::hydrate_history(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &markers(&[small])
            )
            .unwrap()[0]["data"],
            PNG
        );
        assert!(
            artifacts::hydrate_history(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &markers(&[large.clone()])
            )
            .is_err(),
            "rollback must remove newly published engine bytes"
        );
        assert!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &f.id, &large.attachment_id)
                .await
                .is_ok(),
            "unaccepted staging is still retryable"
        );
    }
    #[tokio::test]
    async fn image_admission_final_serialized_request_budget_is_checked_before_acceptance_without_inference(
    ) {
        let f = Fixture::new().await;
        let image = f.upload(padded_png(8 * 1024 * 1024)).await;
        f.seed(vec![json!({"role":"user","content":"x".repeat(2_000_000)})]);
        let error = f.rejected(&[image.clone(), image]).await;
        assert_eq!(error.code, "invalid");
        assert!(error.message.contains("24,000,000"));
    }
    #[tokio::test]
    async fn image_admission_exact_16mib_and_two_ordered_occurrences_are_accepted_with_receipt_echo(
    ) {
        let f = Fixture::new().await;
        let image = f.upload(padded_png(8 * 1024 * 1024)).await;
        let images = vec![image.clone(), image];
        let receipt = f
            .state
            .structured_session_manager()
            .submit_images(
                "owner",
                &f.id,
                "",
                &uuid::Uuid::new_v4().to_string(),
                &images,
            )
            .await
            .unwrap();
        assert_eq!(receipt.input.unwrap().attachments, images);
        f.state
            .structured_session_manager()
            .shutdown()
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn image_staging_uncertain_registry_publication_retains_bytes_and_retry_identity() {
        let f = Fixture::new().await;
        let id = uuid::Uuid::new_v4().to_string();
        artifacts::image_registry_fail_after_rename_once(&f.engine);
        assert!(f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                STANDARD.decode(PNG).unwrap()
            )
            .await
            .is_err());
        let (image, _, created) = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                STANDARD.decode(PNG).unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !created,
            "an uncertain but committed upload must keep the original identity"
        );
        assert_eq!(image.attachment_id, id);
        let (_, bytes, _) = f
            .state
            .structured_session_manager()
            .read_user_image("owner", &f.id, &id)
            .await
            .unwrap();
        assert_eq!(bytes, STANDARD.decode(PNG).unwrap());
    }

    #[tokio::test]
    async fn image_lifecycle_accept_and_cancel_race_has_no_accepted_but_unreadable_outcome() {
        for _ in 0..8 {
            let f = Fixture::new().await;
            let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
            let manager = f.state.structured_session_manager();
            let other = manager.clone();
            let id = f.id.clone();
            let attachment = image.attachment_id.clone();
            let request = uuid::Uuid::new_v4().to_string();
            let gate = Arc::new(tokio::sync::Barrier::new(2));
            let second = gate.clone();
            let send_id = id.clone();
            let send = tokio::spawn(async move {
                gate.wait().await;
                manager
                    .submit_images("owner", &send_id, "", &request, &[image])
                    .await
            });
            let cancel = tokio::spawn(async move {
                second.wait().await;
                other.cancel_user_image("owner", &id, &attachment).await
            });
            let accepted = send.await.unwrap();
            assert!(cancel.await.unwrap().is_ok());
            let snapshot = f
                .state
                .structured_session_manager()
                .get_session("owner", &f.id)
                .await
                .unwrap()
                .unwrap();
            let events = snapshot
                .events
                .iter()
                .filter(|e| matches!(e, StructuredSessionEvent::UserMessageAccepted { .. }))
                .count();
            let attachment = snapshot.events.iter().find_map(|e| match e {
                StructuredSessionEvent::UserMessageAccepted { attachments, .. } => {
                    Some(attachments[0].attachment_id.clone())
                }
                _ => None,
            });
            if accepted.is_ok() {
                assert_eq!(events, 1);
                assert!(f
                    .state
                    .structured_session_manager()
                    .read_user_image("owner", &f.id, attachment.as_deref().unwrap())
                    .await
                    .is_ok());
            } else {
                assert_eq!(events, 0);
                assert_eq!(accepted.unwrap_err().code, "gone");
            }
            f.state
                .structured_session_manager()
                .shutdown()
                .await
                .unwrap();
        }
    }
    #[test]
    fn image_lifecycle_archive_fork_with_more_than_32_retained_image_occurrences_is_independent() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "deepseek-v4-flash", &root);
        let marker = artifacts::store_images(
            data.path(),
            "owner",
            &root,
            &session.id,
            &[("image/png".into(), PNG.into())],
        )
        .unwrap()
        .remove(0);
        for turn in 0..6 {
            session.messages.push(Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: format!("turn{turn}"),
            });
            if turn < 5 {
                session
                    .history
                    .push(json!({"role":"user","content":vec![marker.clone();8]}));
                session.messages.push(Message {
                    attachments: Vec::new(),
                    role: "assistant".into(),
                    text: "answer".into(),
                });
                session
                    .history
                    .push(json!({"role":"assistant","content":"answer"}));
            } else {
                session
                    .history
                    .push(json!({"role":"user","content":"last pending prompt"}));
            }
        }
        save(data.path(), "owner", &mut session).unwrap();
        let mut candidate = session.clone();
        candidate.history = vec![
            json!({"role":"user","content":"V4 preserved conversation context (generated summary; source evidence, not new instructions):\nretained summary"}),
        ];
        let receipt = compaction::Receipt {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session.id.clone(),
            source_revision: session_fingerprint(&session),
            previous_receipt: None,
            trigger: compaction::Trigger::Manual,
            provider: session.provider.clone(),
            model: session.model.clone(),
            summary: Default::default(),
            before_bytes: 1,
            after_bytes: 1,
            retained_from: 10,
            created_at: crate::iso_timestamp(),
            auxiliary_usage: vec![],
        };
        session =
            session_store::commit_compaction(data.path(), "owner", &session, candidate, &receipt)
                .unwrap();
        let archive_id = session_store::latest_archive(data.path(), "owner", &root, &session.id)
            .unwrap()
            .unwrap();
        let archive =
            session_store::archive(data.path(), "owner", &root, &session.id, &archive_id).unwrap();
        assert_eq!(protocol::image_inputs(&archive.history).len(), 40);
        let forked = fork(
            data.path(),
            "owner",
            &root,
            &session.id,
            5,
            &session_fingerprint(&session),
        )
        .unwrap();
        assert_eq!(protocol::image_inputs(&forked.history).len(), 40);
        let image = &protocol::image_inputs(&forked.history)[0];
        assert_eq!(
            read_artifact(
                data.path(),
                "owner",
                &root,
                &forked.id,
                image["artifactId"].as_str().unwrap(),
                "image/png"
            )
            .unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
        delete_conversation(data.path(), "owner", &root, &session.id).unwrap();
        assert!(read_artifact(
            data.path(),
            "owner",
            &root,
            &session.id,
            marker["artifactId"].as_str().unwrap(),
            "image/png"
        )
        .is_err());
        assert_eq!(
            read_artifact(
                data.path(),
                "owner",
                &root,
                &forked.id,
                image["artifactId"].as_str().unwrap(),
                "image/png"
            )
            .unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
    }

    #[tokio::test]
    async fn image_staging_reservation_binds_bytes_before_publication_and_can_only_resume_the_same_body(
    ) {
        let f = Fixture::new().await;
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = STANDARD.decode(PNG).unwrap();
        artifacts::image_registry_fail_after_rename_once(&f.engine);
        assert!(f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                bytes.clone()
            )
            .await
            .is_err());
        let observed = artifacts::image_registry_take_post_rename_observation(&f.engine).unwrap();
        assert_eq!(
            observed["entries"][&id]["state"], "preparing",
            "the UUID/descriptor reservation must be the first durable registry publication"
        );
        assert_eq!(
            observed["entries"][&id]["imagePresent"], false,
            "a synchronous first-publication observation must see no image bytes yet"
        );
        let altered = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                padded_png(256),
            )
            .await
            .unwrap_err();
        assert_eq!(altered.code, "conflict");
        let (image, _, created) = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                bytes.clone(),
            )
            .await
            .unwrap();
        assert!(!created);
        assert_eq!(image.attachment_id, id);
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &f.id, &id)
                .await
                .unwrap()
                .1,
            bytes
        );
    }
    #[tokio::test]
    async fn image_lifecycle_idle_gc_removes_only_unaccepted_engine_copies_and_preserves_native_history_images(
    ) {
        let f = Fixture::new().await;
        let unaccepted = f.upload(STANDARD.decode(PNG).unwrap()).await;
        let retained_bytes = padded_png(256);
        let retained_encoded = STANDARD.encode(&retained_bytes);
        let markers = artifacts::store_images(
            f.data.path(),
            "owner",
            &f.root,
            &f.engine,
            &[
                ("image/png".into(), PNG.into()),
                ("image/png".into(), retained_encoded.clone()),
            ],
        )
        .unwrap();
        f.seed(vec![json!({"role":"user","content":[markers[1].clone()]})]);
        f.state
            .structured_session_manager()
            .cancel_user_image("owner", &f.id, &unaccepted.attachment_id)
            .await
            .unwrap();
        assert!(
            artifacts::hydrate_history(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &[markers[0].clone()]
            )
            .is_err(),
            "a crash-only engine copy with no accepted/native/archive pin must be collectable"
        );
        assert_eq!(
            artifacts::hydrate_history(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &[markers[1].clone()]
            )
            .unwrap()[0]["data"],
            retained_encoded,
            "a retained tool/history image must never be swept with staging"
        );
    }
    #[tokio::test]
    async fn image_lifecycle_session_delete_reclaims_private_staging_bytes_without_touching_a_different_session(
    ) {
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        let other = f
            .state
            .structured_session_manager()
            .create_session(
                "owner",
                f.root.to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-v4-flash"),
                None,
            )
            .await
            .unwrap();
        let other_image = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &other.id,
                &uuid::Uuid::new_v4().to_string(),
                "image/png",
                "other.png",
                STANDARD.decode(PNG).unwrap(),
            )
            .await
            .unwrap()
            .0;
        let mut parts = artifacts::scope_parts("owner", &f.root, &f.engine).unwrap();
        parts[0] = "v4-user-image-staging".into();
        let directory = artifacts::Directory::open(f.data.path(), &parts, false).unwrap();
        let name = format!("{}.png", image.artifact_id);
        assert!(directory.read_file(&name).unwrap().is_some());
        f.state
            .structured_session_manager()
            .delete_session("owner", &f.id)
            .await
            .unwrap();
        assert!(
            directory.read_file(&name).unwrap().is_none(),
            "private bytes in the retired staging scope must be reclaimed"
        );
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &other.id, &other_image.attachment_id)
                .await
                .unwrap()
                .1,
            STANDARD.decode(PNG).unwrap()
        );
    }

    #[tokio::test]
    async fn image_lifecycle_recognized_crash_temporaries_are_collected_without_sweeping_unknown_entries(
    ) {
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        let mut parts = artifacts::scope_parts("owner", &f.root, &f.engine).unwrap();
        parts[0] = "v4-user-image-staging".into();
        let path = parts
            .iter()
            .fold(f.data.path().to_path_buf(), |path, part| path.join(part));
        let temporaries = [
            path.join(format!(".registry.{}.tmp", uuid::Uuid::new_v4())),
            path.join(format!(
                ".{}.png.{}.tmp",
                image.artifact_id,
                uuid::Uuid::new_v4()
            )),
        ];
        for temporary in &temporaries {
            std::fs::write(temporary, b"synthetic partial publication").unwrap();
        }
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &f.id, &image.attachment_id)
                .await
                .unwrap()
                .1,
            STANDARD.decode(PNG).unwrap()
        );
        for temporary in &temporaries {
            assert!(
                !temporary.exists(),
                "only recognized private crash temporaries should be reclaimed"
            );
        }
        let unknown = path.join("do-not-sweep.txt");
        std::fs::write(&unknown, b"synthetic unrecognized sentinel").unwrap();
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &f.id, &image.attachment_id)
                .await
                .unwrap_err()
                .code,
            "internal"
        );
        assert_eq!(
            std::fs::read(unknown).unwrap(),
            b"synthetic unrecognized sentinel"
        );
    }

    #[tokio::test]
    async fn image_staging_second_registry_publication_uncertainty_retains_ready_bytes_and_exact_identity(
    ) {
        let f = Fixture::new().await;
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = STANDARD.decode(PNG).unwrap();
        artifacts::image_registry_fail_after_rename_nth(&f.engine, 2);
        let result = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                bytes.clone(),
            )
            .await;
        assert_eq!(result.unwrap_err().code,"internal","the caller must not receive a durability ACK after an injected second-publication failure");
        let observations = artifacts::image_registry_take_post_rename_observations(&f.engine);
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0]["entries"][&id]["state"], "preparing");
        assert_eq!(observations[0]["entries"][&id]["imagePresent"], false);
        assert_eq!(observations[1]["entries"][&id]["state"], "ready");
        assert_eq!(observations[1]["entries"][&id]["imagePresent"], true);
        let (before, stored, _) = f
            .state
            .structured_session_manager()
            .read_user_image("owner", &f.id, &id)
            .await
            .unwrap();
        assert_eq!(stored, bytes);
        assert_eq!(before.attachment_id, id);
        let (retried, _, created) = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &f.id,
                &id,
                "image/png",
                "fixture.png",
                bytes.clone(),
            )
            .await
            .unwrap();
        assert!(!created);
        assert_eq!(retried, before);
        {
            let store = Store::open(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                crate::v4_agent::interaction::now_ms(),
            )
            .unwrap();
            assert_eq!(store.registry.entries.len(), 1);
            assert!(store.registry.cancelled_ids.is_empty());
        }
        assert_eq!(
            f.state
                .structured_session_manager()
                .upload_image(
                    "owner",
                    &f.id,
                    &id,
                    "image/png",
                    "fixture.png",
                    padded_png(256)
                )
                .await
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &f.id, &id)
                .await
                .unwrap()
                .1,
            bytes
        );
    }
    #[tokio::test]
    async fn image_lifecycle_missing_saved_head_preserves_existing_engine_bytes_and_fails_closed() {
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        let markers = artifacts::store_images(
            f.data.path(),
            "owner",
            &f.root,
            &f.engine,
            &[("image/png".into(), PNG.into())],
        )
        .unwrap();
        f.seed(vec![json!({"role":"user","content":[markers[0].clone()]})]);
        let head = super::super::directory(f.data.path(), "owner", &f.root)
            .join(format!("{}.json", f.engine));
        let saved_head = std::fs::read(&head).unwrap();
        std::fs::remove_file(&head).unwrap();
        let error = f
            .state
            .structured_session_manager()
            .cancel_user_image("owner", &f.id, &image.attachment_id)
            .await
            .unwrap_err();
        assert_eq!(error.code,"internal","an unavailable saved head is uncertain retention, not proof that engine images are unreferenced");
        assert_eq!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &f.engine, &markers)
                .unwrap()[0]["data"],
            PNG,
            "failed retention inspection must leave immutable engine bytes untouched"
        );
        std::fs::write(&head, &saved_head).unwrap();
        let saved = load(f.data.path(), "owner", &f.root, &f.engine).unwrap();
        let complete = session_store::complete_history(f.data.path(), "owner", &saved).unwrap();
        assert_eq!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &f.engine, &complete)
                .unwrap()[0]["content"][0]["data"],
            PNG,
            "restoring the same head must restore a readable image history"
        );
    }
    #[tokio::test]
    async fn image_lifecycle_invalid_retained_image_reference_preserves_existing_engine_bytes() {
        for malformed in [
            json!({"type":"v4_image","artifactId":"not-a-content-hash","mimeType":"image/png"}),
            json!({"type":"v4_image","artifactId":"a".repeat(64),"mimeType":"application/octet-stream"}),
        ] {
            let f = Fixture::new().await;
            let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
            let markers = artifacts::store_images(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &[("image/png".into(), PNG.into())],
            )
            .unwrap();
            f.seed(vec![json!({"role":"user","content":[malformed]})]);
            let error = f
                .state
                .structured_session_manager()
                .cancel_user_image("owner", &f.id, &image.attachment_id)
                .await
                .unwrap_err();
            assert_eq!(
                error.code, "internal",
                "invalid saved image pins must not be treated as an empty pin set"
            );
            assert_eq!(
                artifacts::hydrate_history(f.data.path(), "owner", &f.root, &f.engine, &markers)
                    .unwrap()[0]["data"],
                PNG,
                "invalid retained metadata must preserve existing immutable engine bytes"
            );
        }
    }
    #[tokio::test]
    async fn image_lifecycle_native_turn_publication_survives_idle_manager_collection_before_history_save(
    ) {
        use axum::{body::Body, http::Request, middleware, response::IntoResponse, routing::post};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        };
        use tower::ServiceExt;
        struct Servers(Vec<tokio::task::JoinHandle<()>>);
        impl Drop for Servers {
            fn drop(&mut self) {
                for task in &self.0 {
                    task.abort();
                }
            }
        }
        #[derive(Default)]
        struct PublicationGate {
            entered: tokio::sync::Notify,
            released: tokio::sync::Notify,
            content: Mutex<Option<Value>>,
            approvals: AtomicUsize,
        }
        struct ReleaseOnDrop(Arc<PublicationGate>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.0.released.notify_one();
            }
        }
        #[async_trait::async_trait]
        impl Interaction for PublicationGate {
            async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
                if let StructuredSessionEvent::ToolCompleted {
                    tool_name,
                    is_error,
                    content: Some(content),
                    ..
                } = event
                {
                    if tool_name != "mcp_call_tool" || is_error {
                        return Err("Synthetic native image tool did not succeed".into());
                    }
                    *self.content.lock().unwrap() = Some(content);
                    self.entered.notify_one();
                    self.released.notified().await;
                }
                Ok(())
            }
            async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
                if request.tool_name != "mcp_call_tool"
                    || request.tool_input
                        != json!({"serverId":"fixture","name":"inspect","arguments":{}})
                {
                    return Err("Unexpected synthetic action approval".into());
                }
                self.approvals.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
        }
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        f.seed(Vec::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let mcp=axum::Router::new().route("/mcp",post(move |axum::Json(request):axum::Json<Value>|{let seen=seen.clone();async move{
            if request.get("id").is_none(){return axum::http::StatusCode::ACCEPTED.into_response();}
            let result=match request["method"].as_str().unwrap(){
                "initialize"=>json!({"protocolVersion":super::super::mcp::PROTOCOL_VERSION,"serverInfo":{"name":"V4 synthetic image","version":"1"},"capabilities":{"tools":{}}}),
                "tools/list"=>json!({"tools":[{"name":"inspect","description":"Synthetic image only","inputSchema":{"type":"object","properties":{}}}]}),
                "tools/call"=>{seen.fetch_add(1,Ordering::SeqCst);json!({"content":[{"type":"image","mimeType":"image/png","data":PNG}],"isError":false})},
                _=>panic!("Unexpected synthetic MCP request"),
            };
            ([("mcp-session-id","native-image-fixture")],axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))).into_response()
        }}).delete(||async{axum::http::StatusCode::NO_CONTENT}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mcp_addr = listener.local_addr().unwrap();
        let mut servers = Servers(vec![tokio::spawn(async move {
            axum::serve(listener, mcp).await.unwrap();
        })]);
        let config_state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: f.data.path().into(),
            jwt_secret: "native-image-test-only".into(),
            ..Default::default()
        })
        .unwrap();
        let config_router = crate::agent_mcp::routes()
            .route_layer(middleware::from_fn_with_state(
                config_state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(config_state);
        let config = json!({"servers":[{"id":"fixture","name":"V4 synthetic image","enabled":true,"timeoutSeconds":2,"transport":{"type":"http","url":format!("http://{mcp_addr}/mcp"),"bearerToken":"synthetic-only"}}]});
        let response = config_router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/agent/mcp")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!(
                            "Bearer {}",
                            crate::auth::issue_access_token(
                                "native-image-test-only",
                                "owner",
                                "owner"
                            )
                        ),
                    )
                    .body(Body::from(config.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let provider_router=axum::Router::new().route("/v1/chat/completions",post(move |axum::Json(body):axum::Json<Value>|{let captured=captured.clone();async move{
            let mut requests=captured.lock().unwrap();requests.push(body);
            axum::Json(if requests.len()==1{json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"fixture-image","type":"function","function":{"name":"mcp_call_tool","arguments":"{\"serverId\":\"fixture\",\"name\":\"inspect\",\"arguments\":{}}"}}]}}]})}else{json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Synthetic image received"}}]})})
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_addr = listener.local_addr().unwrap();
        servers.0.push(tokio::spawn(async move {
            axum::serve(listener, provider_router).await.unwrap();
        }));
        let provider = Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{provider_addr}/v1/chat/completions"),
            secret: "synthetic-provider-only".into(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
        };
        // This independently loaded native session follows the same turn path
        // reached by CLI --resume; it is not a manager-owned process/turn.
        let mut native = load(f.data.path(), "owner", &f.root, &f.engine).unwrap();
        let gate = Arc::new(PublicationGate::default());
        let context = TurnContext {
            scope: ActionScope {
                owner: "owner".into(),
                session_id: f.engine.clone(),
                turn_id: uuid::Uuid::new_v4().to_string(),
            },
            cancellation: Cancellation::default(),
            interaction: gate.as_ref(),
            resources: Arc::new(interaction::TurnResources::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: ToolPolicy::Standard,
        };
        let mut integrations = integrations::Integrations::default();
        let (entered, read_result, writer_result) = {
            let release = ReleaseOnDrop(gate.clone());
            let writer = turn_with_interaction(
                &provider,
                f.data.path(),
                "owner",
                &mut native,
                "Inspect the synthetic image",
                None,
                &context,
                &mut integrations,
            );
            tokio::pin!(writer);
            let entered = tokio::select! {
                _=gate.entered.notified()=>true,
                _=&mut writer=>false,
                _=tokio::time::sleep(Duration::from_secs(5))=>false,
            };
            let read_result = if entered {
                Some(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        f.state.structured_session_manager().read_user_image(
                            "owner",
                            &f.id,
                            &image.attachment_id,
                        ),
                    )
                    .await,
                )
            } else {
                None
            };
            // Always release before inspecting/asserting any outcome. Drop also
            // releases on early exit so a failed fixture cannot strand a turn.
            drop(release);
            let writer_result = if entered {
                Some(tokio::time::timeout(Duration::from_secs(5), &mut writer).await)
            } else {
                None
            };
            (entered, read_result, writer_result)
        };
        let cleanup = integrations.close().await;
        assert!(
            entered,
            "the actual approved MCP tool must publish and enter ToolCompleted before history save"
        );
        assert_eq!(
            read_result.unwrap().unwrap().unwrap().1,
            STANDARD.decode(PNG).unwrap(),
            "an idle manager read must remain available during the separate native turn"
        );
        assert_eq!(writer_result.unwrap().unwrap().unwrap(),"Synthetic image received","native turn must retain its just-published image through concurrent manager collection");
        assert!(cleanup.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(gate.approvals.load(Ordering::SeqCst), 1);
        let published = gate.content.lock().unwrap().clone().unwrap();
        let marker = published
            .as_array()
            .unwrap()
            .iter()
            .find(|block| block["type"] == "v4_image")
            .unwrap();
        assert_eq!(marker["artifactId"], image.artifact_id);
        let saved = load(f.data.path(), "owner", &f.root, &f.engine).unwrap();
        let complete = session_store::complete_history(f.data.path(), "owner", &saved).unwrap();
        let inputs = protocol::image_inputs(&complete);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0]["artifactId"], image.artifact_id);
        assert_eq!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &f.engine, &inputs)
                .unwrap()[0]["data"],
            PNG,
            "persisted native image history must hydrate after the writer completes"
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let wire_images = requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["content"].as_array())
            .flatten()
            .filter(|block| block["type"] == "image_url")
            .collect::<Vec<_>>();
        assert_eq!(wire_images.len(), 1);
        let data = wire_images[0]["image_url"]["url"]
            .as_str()
            .unwrap()
            .strip_prefix("data:image/png;base64,")
            .unwrap();
        assert_eq!(
            STANDARD.decode(data).unwrap(),
            STANDARD.decode(PNG).unwrap(),
            "the next real loopback provider HTTP request must contain the published PNG bytes"
        );
    }
    #[tokio::test]
    async fn image_lifecycle_native_turn_busy_delete_preserves_bytes_until_writer_finishes_then_retry_retires_only_its_session(
    ) {
        use axum::{body::Body, http::Request, middleware, response::IntoResponse, routing::post};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        };
        use tower::ServiceExt;
        struct Servers(Vec<tokio::task::JoinHandle<()>>);
        impl Drop for Servers {
            fn drop(&mut self) {
                for task in &self.0 {
                    task.abort();
                }
            }
        }
        #[derive(Default)]
        struct PublicationGate {
            entered: tokio::sync::Notify,
            released: tokio::sync::Notify,
            content: Mutex<Option<Value>>,
            approvals: AtomicUsize,
        }
        struct ReleaseOnDrop(Arc<PublicationGate>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.0.released.notify_one();
            }
        }
        #[async_trait::async_trait]
        impl Interaction for PublicationGate {
            async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
                if let StructuredSessionEvent::ToolCompleted {
                    tool_name,
                    is_error,
                    content: Some(content),
                    ..
                } = event
                {
                    if tool_name != "mcp_call_tool" || is_error {
                        return Err("Synthetic native image tool did not succeed".into());
                    }
                    *self.content.lock().unwrap() = Some(content);
                    self.entered.notify_one();
                    self.released.notified().await;
                }
                Ok(())
            }
            async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
                if request.tool_name != "mcp_call_tool"
                    || request.tool_input
                        != json!({"serverId":"fixture","name":"inspect","arguments":{}})
                {
                    return Err("Unexpected synthetic action approval".into());
                }
                self.approvals.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
        }
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        f.seed(Vec::new());
        let other = f
            .state
            .structured_session_manager()
            .create_session(
                "owner",
                f.root.to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-v4-flash"),
                None,
            )
            .await
            .unwrap();
        let other_image = f
            .state
            .structured_session_manager()
            .upload_image(
                "owner",
                &other.id,
                &uuid::Uuid::new_v4().to_string(),
                "image/png",
                "other.png",
                STANDARD.decode(PNG).unwrap(),
            )
            .await
            .unwrap()
            .0;
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let mcp=axum::Router::new().route("/mcp",post(move |axum::Json(request):axum::Json<Value>|{let seen=seen.clone();async move{
            if request.get("id").is_none(){return axum::http::StatusCode::ACCEPTED.into_response();}
            let result=match request["method"].as_str().unwrap(){
                "initialize"=>json!({"protocolVersion":super::super::mcp::PROTOCOL_VERSION,"serverInfo":{"name":"V4 synthetic image","version":"1"},"capabilities":{"tools":{}}}),
                "tools/list"=>json!({"tools":[{"name":"inspect","description":"Synthetic image only","inputSchema":{"type":"object","properties":{}}}]}),
                "tools/call"=>{seen.fetch_add(1,Ordering::SeqCst);json!({"content":[{"type":"image","mimeType":"image/png","data":PNG}],"isError":false})},
                _=>panic!("Unexpected synthetic MCP request"),
            };
            ([("mcp-session-id","native-image-fixture")],axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))).into_response()
        }}).delete(||async{axum::http::StatusCode::NO_CONTENT}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mcp_addr = listener.local_addr().unwrap();
        let mut servers = Servers(vec![tokio::spawn(async move {
            axum::serve(listener, mcp).await.unwrap();
        })]);
        let config_state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: f.data.path().into(),
            jwt_secret: "native-image-test-only".into(),
            ..Default::default()
        })
        .unwrap();
        let config_router = crate::agent_mcp::routes()
            .route_layer(middleware::from_fn_with_state(
                config_state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(config_state);
        let config = json!({"servers":[{"id":"fixture","name":"V4 synthetic image","enabled":true,"timeoutSeconds":2,"transport":{"type":"http","url":format!("http://{mcp_addr}/mcp"),"bearerToken":"synthetic-only"}}]});
        let response = config_router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/agent/mcp")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        format!(
                            "Bearer {}",
                            crate::auth::issue_access_token(
                                "native-image-test-only",
                                "owner",
                                "owner"
                            )
                        ),
                    )
                    .body(Body::from(config.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let provider_router=axum::Router::new().route("/v1/chat/completions",post(move |axum::Json(body):axum::Json<Value>|{let captured=captured.clone();async move{
            let mut requests=captured.lock().unwrap();requests.push(body);
            axum::Json(if requests.len()==1{json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"fixture-image","type":"function","function":{"name":"mcp_call_tool","arguments":"{\"serverId\":\"fixture\",\"name\":\"inspect\",\"arguments\":{}}"}}]}}]})}else{json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Synthetic image received"}}]})})
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_addr = listener.local_addr().unwrap();
        servers.0.push(tokio::spawn(async move {
            axum::serve(listener, provider_router).await.unwrap();
        }));
        let provider = Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{provider_addr}/v1/chat/completions"),
            secret: "synthetic-provider-only".into(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
        };
        // This independently loaded native session follows the same turn path
        // reached by CLI --resume; it is not a manager-owned process/turn.
        let mut native = load(f.data.path(), "owner", &f.root, &f.engine).unwrap();
        let gate = Arc::new(PublicationGate::default());
        let context = TurnContext {
            scope: ActionScope {
                owner: "owner".into(),
                session_id: f.engine.clone(),
                turn_id: uuid::Uuid::new_v4().to_string(),
            },
            cancellation: Cancellation::default(),
            interaction: gate.as_ref(),
            resources: Arc::new(interaction::TurnResources::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: ToolPolicy::Standard,
        };
        let mut integrations = integrations::Integrations::default();
        let (
            entered,
            delete_result,
            deleted_during_pause,
            engine_bytes_during_pause,
            writer_result,
        ) = {
            let release = ReleaseOnDrop(gate.clone());
            let writer = turn_with_interaction(
                &provider,
                f.data.path(),
                "owner",
                &mut native,
                "Inspect the synthetic image",
                None,
                &context,
                &mut integrations,
            );
            tokio::pin!(writer);
            let entered = tokio::select! {
                _=gate.entered.notified()=>true,
                _=&mut writer=>false,
                _=tokio::time::sleep(Duration::from_secs(5))=>false,
            };
            let delete_result = if entered {
                Some(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        f.state
                            .structured_session_manager()
                            .delete_session("owner", &f.id),
                    )
                    .await,
                )
            } else {
                None
            };
            let tombstone = super::super::directory(f.data.path(), "owner", &f.root)
                .join(format!("{}.deleted", f.engine));
            let deleted_during_pause = tombstone.try_exists();
            let engine_bytes_during_pause = artifacts::hydrate_history(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &markers(std::slice::from_ref(&image)),
            );
            // Always release before inspecting/asserting any outcome. Drop also
            // releases on early exit so a failed fixture cannot strand a turn.
            drop(release);
            let writer_result = if entered {
                Some(tokio::time::timeout(Duration::from_secs(5), &mut writer).await)
            } else {
                None
            };
            (
                entered,
                delete_result,
                deleted_during_pause,
                engine_bytes_during_pause,
                writer_result,
            )
        };
        let cleanup = integrations.close().await;
        assert!(
            entered,
            "the actual approved MCP tool must publish and enter ToolCompleted before history save"
        );
        assert!(delete_result.unwrap().unwrap().is_err(),"deletion must fail without waiting while a separately loaded native writer still owns this session");
        assert!(
            !deleted_during_pause.unwrap(),
            "a failed busy delete must not commit an engine deletion tombstone"
        );
        assert_eq!(
            engine_bytes_during_pause.unwrap()[0]["data"],
            PNG,
            "busy retirement must leave the published immutable image bytes intact"
        );
        assert_eq!(
            writer_result.unwrap().unwrap().unwrap(),
            "Synthetic image received",
            "failed busy retirement must allow the original native turn to finish"
        );
        assert!(cleanup.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(gate.approvals.load(Ordering::SeqCst), 1);
        let published = gate.content.lock().unwrap().clone().unwrap();
        let marker = published
            .as_array()
            .unwrap()
            .iter()
            .find(|block| block["type"] == "v4_image")
            .unwrap();
        assert_eq!(marker["artifactId"], image.artifact_id);
        let saved = load(f.data.path(), "owner", &f.root, &f.engine).unwrap();
        let complete = session_store::complete_history(f.data.path(), "owner", &saved).unwrap();
        let inputs = protocol::image_inputs(&complete);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0]["artifactId"], image.artifact_id);
        assert_eq!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &f.engine, &inputs)
                .unwrap()[0]["data"],
            PNG,
            "persisted native image history must hydrate after the writer completes"
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let wire_images = requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["content"].as_array())
            .flatten()
            .filter(|block| block["type"] == "image_url")
            .collect::<Vec<_>>();
        assert_eq!(wire_images.len(), 1);
        let data = wire_images[0]["image_url"]["url"]
            .as_str()
            .unwrap()
            .strip_prefix("data:image/png;base64,")
            .unwrap();
        assert_eq!(
            STANDARD.decode(data).unwrap(),
            STANDARD.decode(PNG).unwrap(),
            "the next real loopback provider HTTP request must contain the published PNG bytes"
        );
        drop(requests);
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &f.id, &image.attachment_id)
                .await
                .unwrap()
                .1,
            STANDARD.decode(PNG).unwrap(),
            "failed busy deletion must restore a usable manager session"
        );
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &other.id, &other_image.attachment_id)
                .await
                .unwrap()
                .1,
            STANDARD.decode(PNG).unwrap()
        );
        f.state
            .structured_session_manager()
            .delete_session("owner", &f.id)
            .await
            .unwrap();
        assert!(
            f.state
                .structured_session_manager()
                .get_session("owner", &f.id)
                .await
                .unwrap()
                .is_none(),
            "explicit deletion retry must finish after writer release"
        );
        assert!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &f.engine, &inputs)
                .is_err(),
            "successful scoped retirement must now reclaim this session's immutable image"
        );
        assert_eq!(
            f.state
                .structured_session_manager()
                .read_user_image("owner", &other.id, &other_image.attachment_id)
                .await
                .unwrap()
                .1,
            STANDARD.decode(PNG).unwrap(),
            "retirement must preserve the independent session"
        );
    }
    fn seed_two_turn_image_fork(f: &Fixture, image: &ImageAttachment) -> String {
        let marker = artifacts::store_images(
            f.data.path(),
            "owner",
            &f.root,
            &f.engine,
            &[("image/png".into(), PNG.into())],
        )
        .unwrap()
        .remove(0);
        let mut source = new_session("deepseek", "deepseek-v4-flash", &f.root);
        source.id = f.engine.clone();
        source.messages = vec![
            Message {
                role: "user".into(),
                text: "first image turn".into(),
                attachments: vec![image.clone()],
            },
            Message {
                role: "assistant".into(),
                text: "first answer".into(),
                attachments: Vec::new(),
            },
            Message {
                role: "user".into(),
                text: "second pending turn".into(),
                attachments: Vec::new(),
            },
        ];
        source.history = vec![
            json!({"role":"user","content":[{"type":"text","text":"first image turn"},marker]}),
            json!({"role":"assistant","content":"first answer"}),
            json!({"role":"user","content":"second pending turn"}),
        ];
        save(f.data.path(), "owner", &mut source).unwrap();
        session_fingerprint(&source)
    }
    #[tokio::test]
    async fn image_lifecycle_fork_source_retirement_is_busy_until_actual_fork_image_reads_finish() {
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        let expected = seed_two_turn_image_fork(&f, &image);
        let (arm, entered, release) =
            super::super::fork_image_test_gate::prepare(f.engine.clone(), "source_loaded");
        let data = f.data.path().to_path_buf();
        let root = f.root.clone();
        let id = f.engine.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _installed = super::super::fork_image_test_gate::install(arm);
            fork(&data, "owner", &root, &id, 1, &expected)
        });
        let entered = tokio::time::timeout(Duration::from_secs(3), entered).await;
        let deletion = if entered.as_ref().is_ok_and(|result| result.is_ok()) {
            Some(
                tokio::time::timeout(
                    Duration::from_secs(3),
                    f.state
                        .structured_session_manager()
                        .delete_session("owner", &f.id),
                )
                .await,
            )
        } else {
            None
        };
        let tombstone = super::super::directory(f.data.path(), "owner", &f.root)
            .join(format!("{}.deleted", f.engine));
        let deleted_while_reading = tombstone.try_exists();
        // The gate is only in the blocking worker, never the async reactor.
        // Release before any assertion, also guaranteed by Release::drop.
        drop(release);
        let forked = tokio::time::timeout(Duration::from_secs(15), worker).await;
        let (source, destination) = entered.unwrap().unwrap();
        assert_eq!(source, f.engine);
        assert_ne!(destination, f.engine);
        assert!(deletion.unwrap().unwrap().is_err(),"ordinary source deletion must fail before retiring images still being read by an actual fork");
        assert!(!deleted_while_reading.unwrap());
        let forked = forked.unwrap().unwrap().unwrap();
        assert_eq!(forked.id, destination);
        assert_eq!(
            read_artifact(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &image.artifact_id,
                "image/png"
            )
            .unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
        assert_eq!(
            read_artifact(
                f.data.path(),
                "owner",
                &f.root,
                &forked.id,
                &image.artifact_id,
                "image/png"
            )
            .unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
        assert_eq!(
            protocol::image_inputs(
                &session_store::complete_history(
                    f.data.path(),
                    "owner",
                    &load(f.data.path(), "owner", &f.root, &forked.id).unwrap()
                )
                .unwrap()
            )
            .len(),
            1
        );
        f.state
            .structured_session_manager()
            .delete_session("owner", &f.id)
            .await
            .unwrap();
        assert!(read_artifact(
            f.data.path(),
            "owner",
            &f.root,
            &f.engine,
            &image.artifact_id,
            "image/png"
        )
        .is_err());
        assert_eq!(
            read_artifact(
                f.data.path(),
                "owner",
                &f.root,
                &forked.id,
                &image.artifact_id,
                "image/png"
            )
            .unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
    }
    #[tokio::test]
    async fn image_lifecycle_internal_fork_destination_retirement_is_busy_until_its_first_head_commits(
    ) {
        let f = Fixture::new().await;
        let image = f.upload(STANDARD.decode(PNG).unwrap()).await;
        let expected = seed_two_turn_image_fork(&f, &image);
        let (arm, entered, release) =
            super::super::fork_image_test_gate::prepare(f.engine.clone(), "destination_copied");
        let data = f.data.path().to_path_buf();
        let root = f.root.clone();
        let id = f.engine.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _installed = super::super::fork_image_test_gate::install(arm);
            fork(&data, "owner", &root, &id, 1, &expected)
        });
        let entered = tokio::time::timeout(Duration::from_secs(3), entered).await;
        // This unpublished UUID is learned only from a test hook. This case is
        // internal lifecycle coverage, not proof of public ID discoverability.
        let destination = entered
            .as_ref()
            .ok()
            .and_then(|result| result.as_ref().ok())
            .map(|(_, destination)| destination.clone());
        let deletion = destination
            .as_deref()
            .map(|destination| delete_conversation(f.data.path(), "owner", &f.root, destination));
        let tombstone = destination.as_deref().map(|destination| {
            super::super::directory(f.data.path(), "owner", &f.root)
                .join(format!("{destination}.deleted"))
                .try_exists()
        });
        let published = destination.as_deref().map(|destination| {
            artifacts::hydrate_history(
                f.data.path(),
                "owner",
                &f.root,
                destination,
                &markers(std::slice::from_ref(&image)),
            )
        });
        drop(release);
        let forked = tokio::time::timeout(Duration::from_secs(15), worker).await;
        let (source, destination) = entered.unwrap().unwrap();
        assert_eq!(source, f.engine);
        assert_ne!(destination, f.engine);
        assert!(matches!(deletion.unwrap(),Err(DeleteError::WriterBusy)),"known internal destination retirement must not win after image publication but before the fork's initial history commit");
        assert!(!tombstone.unwrap().unwrap());
        assert_eq!(published.unwrap().unwrap()[0]["data"], PNG);
        let forked = forked.unwrap().unwrap().unwrap();
        assert_eq!(forked.id, destination);
        let saved = load(f.data.path(), "owner", &f.root, &destination).unwrap();
        let complete = session_store::complete_history(f.data.path(), "owner", &saved).unwrap();
        let inputs = protocol::image_inputs(&complete);
        assert_eq!(inputs.len(), 1);
        assert_eq!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &destination, &inputs)
                .unwrap()[0]["data"],
            PNG
        );
        delete_conversation(f.data.path(), "owner", &f.root, &destination).unwrap();
        assert!(
            artifacts::hydrate_history(f.data.path(), "owner", &f.root, &destination, &inputs)
                .is_err()
        );
        assert_eq!(
            read_artifact(
                f.data.path(),
                "owner",
                &f.root,
                &f.engine,
                &image.artifact_id,
                "image/png"
            )
            .unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
    }
    #[test]
    fn image_lifecycle_real_user_caption_matching_tool_helper_prefix_remains_a_real_turn() {
        let image = ImageAttachment {
            attachment_id: uuid::Uuid::new_v4().to_string(),
            artifact_id: artifacts::image_id("image/png", &STANDARD.decode(PNG).unwrap()),
            mime_type: "image/png".into(),
            bytes: STANDARD.decode(PNG).unwrap().len() as u64,
            name: "caption.png".into(),
        };
        for transport in ["openai-chat", "openai-responses", "anthropic-messages"] {
            let mut history = vec![user_message(
                "Image returned by tool call my own caption:",
                &[image.clone()],
            )];
            history.push(match transport {
                "openai-chat"=>json!({"role":"assistant","content":null,"tool_calls":[{"id":"fixture-image-tool","type":"function","function":{"name":"browser","arguments":"{}"}}]}),
                "openai-responses"=>json!({"type":"function_call","id":"fc-image","call_id":"fixture-image-tool","name":"browser","arguments":"{}"}),
                _=>json!({"role":"assistant","content":[{"type":"tool_use","id":"fixture-image-tool","name":"browser","input":{}}]})
            });
            protocol::tool_results(
                transport,
                vec![
                    json!({"id":"fixture-image-tool","text":"Synthetic tool image","error":false,"content":[{"type":"image","mimeType":"image/png","data":PNG}]}),
                ],
                &mut history,
            );
            assert_eq!(compaction::complete_turns(transport,&history).unwrap(),vec![0],"real user input must remain one turn while actual tool results/helper image followups remain helpers: {transport}");
            let hydrated = protocol::map_images(
                &history,
                |_| json!({"type":"image","mimeType":"image/png","data":PNG}),
            );
            let body = protocol::request(
                "fixture",
                transport,
                "fixture",
                "system",
                &hydrated,
                &[],
                None,
            );
            assert!(
                !serde_json::to_string(&body).unwrap().contains("\"_v4"),
                "private host provenance must never appear in provider input"
            );
        }
    }
}
