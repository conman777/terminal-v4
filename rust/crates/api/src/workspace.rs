use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) const KNOWLEDGE_RECORD_BYTES: usize = 2_000_000;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceProfile {
    pub memory: String,
    pub skills: Vec<WorkspaceSkill>,
    pub default_agent: String,
    pub selection: Option<WorkspaceSelection>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillActivation {
    #[default]
    AlwaysOn,
    OnDemand,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSkill {
    pub id: uuid::Uuid,
    pub name: String,
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<SkillActivation>,
    #[serde(
        default,
        rename = "supportFiles",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub support_files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSelection {
    pub model: String,
    pub reasoning: String,
}

#[derive(Deserialize)]
struct WorkspaceQuery {
    path: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace/profile", axum::routing::get(load).put(save))
        .route(
            "/api/account/knowledge",
            axum::routing::get(load_account).put(save_account),
        )
}

pub(crate) fn profile_path(
    data_dir: &std::path::Path,
    user_id: &str,
    path: &str,
) -> Result<std::path::PathBuf, ApiError> {
    use sha2::{Digest, Sha256};
    if path.is_empty() || path.len() > 2048 || !std::path::Path::new(path).is_absolute() {
        return Err(ApiError::bad_request(
            "An absolute workspace directory is required",
        ));
    }
    let workspace = std::fs::canonicalize(path)
        .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
    if !workspace.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    let mut key = workspace.to_string_lossy().into_owned();
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    let owner = hex::encode(Sha256::digest(user_id.as_bytes()));
    let project = hex::encode(Sha256::digest(key.as_bytes()));
    Ok(data_dir
        .join("workspace-profiles")
        .join(owner)
        .join(format!("{project}.json")))
}

pub(crate) fn account_profile_path(data_dir: &std::path::Path, owner: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    data_dir.join("account-knowledge").join(format!(
        "{}.json",
        hex::encode(Sha256::digest(owner.as_bytes()))
    ))
}

pub(crate) fn validate_support_path(path: &str) -> Result<(), ApiError> {
    use std::path::{Component, Path};
    if path.is_empty()
        || path.len() > 512
        || path.contains(['\\', ':'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "Skill support files require bounded relative paths",
        ));
    }
    for part in Path::new(path).components() {
        let Component::Normal(name) = part else {
            return Err(ApiError::bad_request(
                "Skill support paths cannot traverse directories",
            ));
        };
        let name = name.to_string_lossy().to_lowercase();
        if name.starts_with('.')
            || name == "skill.md"
            || name.ends_with(".mbox")
            || name.ends_with(".eml")
            || name.ends_with(".pst")
            || name.ends_with(".ost")
            || [
                "auth.json",
                "credentials.json",
                "terminal.db",
                "vault.key",
                "id_rsa",
                "id_ed25519",
            ]
            .contains(&name.as_str())
        {
            return Err(ApiError::bad_request(
                "Protected files cannot be skill support files",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_support_files(files: &BTreeMap<String, String>) -> Result<(), ApiError> {
    if files.len() > 20 || files.values().map(String::len).sum::<usize>() > 128_000 {
        return Err(ApiError::bad_request(
            "A skill package supports up to 20 files and 128000 bytes",
        ));
    }
    let mut normalized_paths = std::collections::HashSet::new();
    for (path, content) in files {
        validate_support_path(path)?;
        if !normalized_paths.insert(path.to_lowercase()) {
            return Err(ApiError::bad_request(
                "Skill support paths must be unique without case differences",
            ));
        }
        if content.len() > 64_000
            || content
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(ApiError::bad_request(
                "Each skill support file is limited to 64000 UTF-8 bytes of text",
            ));
        }
        if files.keys().any(|other| {
            other != path
                && other
                    .to_lowercase()
                    .starts_with(&format!("{}/", path.to_lowercase()))
        }) {
            return Err(ApiError::bad_request(
                "A skill support path cannot be both a file and a directory",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_profile(profile: &WorkspaceProfile) -> Result<(), ApiError> {
    use std::collections::HashSet;
    if profile.memory.chars().count() > 6000 || profile.skills.len() > 20 {
        return Err(ApiError::bad_request(
            "Workspace knowledge is limited to 6000 characters and 20 skills",
        ));
    }
    let valid_default_agent = profile.default_agent.len() <= 64
        && profile
            .default_agent
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    #[cfg(unix)]
    let valid_default_agent = valid_default_agent
        || crate::v4_agent::profile::Binding::parse(&profile.default_agent).is_some();
    if !valid_default_agent {
        return Err(ApiError::bad_request("Invalid default agent"));
    }
    if let Some(selection) = &profile.selection {
        if profile.default_agent.is_empty()
            || profile.default_agent == "cli"
            || selection.model.trim().is_empty()
            || selection.model.chars().count() > 200
            || selection.model.chars().any(char::is_control)
            || ![
                "", "none", "minimal", "low", "medium", "high", "xhigh", "max",
            ]
            .contains(&selection.reasoning.as_str())
        {
            return Err(ApiError::bad_request(
                "Invalid model or reasoning selection",
            ));
        }
    }
    let mut ids = HashSet::new();
    let mut total = profile.memory.chars().count();
    let mut support_bytes = 0usize;
    for skill in &profile.skills {
        validate_support_files(&skill.support_files)?;
        support_bytes += skill.support_files.values().map(String::len).sum::<usize>();
        if !ids.insert(skill.id)
            || skill.name.trim().is_empty()
            || skill.name.chars().count() > 80
            || skill.instructions.trim().is_empty()
            || skill.instructions.chars().count() > 6000
        {
            return Err(ApiError::bad_request("Skills require unique IDs, a name up to 80 characters, and instructions up to 6000 characters"));
        }
        total += skill.name.chars().count() + skill.instructions.chars().count();
    }
    if support_bytes > 256_000 {
        return Err(ApiError::bad_request(
            "Saved skill support files are limited to 256000 bytes in total",
        ));
    }
    if total > 50_000 {
        return Err(ApiError::bad_request(
            "Workspace context is limited to 50000 characters in total",
        ));
    }
    Ok(())
}

pub(crate) static PROFILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_record_writer(path: &std::path::Path) -> Result<std::fs::File, ApiError> {
    let root = path
        .ancestors()
        .find(|part| {
            part.file_name()
                .is_some_and(|name| name == "workspace-profiles" || name == "account-knowledge")
        })
        .and_then(std::path::Path::parent)
        .or_else(|| path.parent())
        .ok_or_else(|| ApiError::internal("Invalid knowledge storage"))?;
    std::fs::create_dir_all(root)
        .map_err(|_| ApiError::internal("Unable to prepare knowledge writer lock"))?;
    let lock_path = root.join(".knowledge-writers.lock");
    if std::fs::symlink_metadata(&lock_path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(ApiError::internal(
            "Knowledge writer lock must be a regular file",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(lock_path)
        .map_err(|_| ApiError::internal("Knowledge writer lock is unavailable"))?;
    if !file
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Err(ApiError::internal(
            "Knowledge writer lock must be a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if !file.metadata().is_ok_and(|metadata| metadata.nlink() == 1) {
            return Err(ApiError::internal(
                "Knowledge writer lock cannot have shared links",
            ));
        }
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| ApiError::internal("Cannot protect knowledge writer lock"))?;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(ApiError {
                    status: axum::http::StatusCode::CONFLICT,
                    message: "Knowledge storage is busy in another process; retry the change"
                        .into(),
                })
            }
            Err(_) => {
                return Err(ApiError::internal(
                    "Knowledge writer lock could not be acquired",
                ))
            }
        }
    }
}

pub(crate) fn mutate_workspace_record<R>(
    data_dir: &std::path::Path,
    user_id: &str,
    workspace_path: &str,
    operation: impl FnOnce(&mut WorkspaceProfile, &mut serde_json::Value) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Workspace storage is unavailable"))?;
    let path = profile_path(data_dir, user_id, workspace_path)?;
    let _writer = lock_record_writer(&path)?;
    let (mut profile, mut metadata) = read_record(&path)?;
    let original = (profile.clone(), metadata.clone());
    let result = operation(&mut profile, &mut metadata)?;
    validate_profile(&profile)?;
    if !metadata.is_object() {
        return Err(ApiError::bad_request(
            "Workspace metadata must be an object",
        ));
    }
    if original != (profile.clone(), metadata.clone()) {
        write_record(&path, &profile, &metadata)?;
    }
    Ok(result)
}

pub(crate) fn mutate_account_record<R>(
    data_dir: &std::path::Path,
    owner: &str,
    operation: impl FnOnce(&mut WorkspaceProfile, &mut serde_json::Value) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Account knowledge storage is unavailable"))?;
    let path = account_profile_path(data_dir, owner);
    let _writer = lock_record_writer(&path)?;
    let (mut profile, mut metadata) = read_record(&path)?;
    let original = (profile.clone(), metadata.clone());
    let result = operation(&mut profile, &mut metadata)?;
    validate_profile(&profile)?;
    if !metadata.is_object() {
        return Err(ApiError::bad_request(
            "Knowledge metadata must be an object",
        ));
    }
    if original != (profile.clone(), metadata.clone()) {
        write_record(&path, &profile, &metadata)?;
    }
    Ok(result)
}

fn validate_record_path(path: &std::path::Path) -> Result<(), ApiError> {
    let ancestors: Vec<_> = path.ancestors().collect();
    let count = ancestors
        .iter()
        .position(|part| {
            part.file_name()
                .is_some_and(|name| name == "workspace-profiles" || name == "account-knowledge")
        })
        .map(|index| index + 1)
        .unwrap_or(2);
    for part in ancestors.into_iter().take(count) {
        match std::fs::symlink_metadata(part) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApiError::internal(
                    "Symlinked knowledge storage is not allowed",
                ))
            }
            Ok(metadata) if part == path && !metadata.is_file() => {
                return Err(ApiError::internal(
                    "Knowledge storage must be a regular file",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(ApiError::internal("Knowledge storage is unavailable")),
        }
        if part
            .file_name()
            .is_some_and(|name| name == "workspace-profiles" || name == "account-knowledge")
        {
            break;
        }
    }
    Ok(())
}

fn read_record(path: &std::path::Path) -> Result<(WorkspaceProfile, serde_json::Value), ApiError> {
    validate_record_path(path)?;
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((WorkspaceProfile::default(), serde_json::json!({})));
        }
        Err(_) => return Err(ApiError::internal("Unable to read saved workspace")),
    };
    let mut content = Vec::new();
    file.take(KNOWLEDGE_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut content)
        .map_err(|_| ApiError::internal("Unable to read saved workspace"))?;
    if content.len() > KNOWLEDGE_RECORD_BYTES {
        return Err(ApiError::internal(
            "Saved workspace exceeds the storage limit",
        ));
    }
    let mut document: serde_json::Value = serde_json::from_slice(&content)
        .map_err(|_| ApiError::internal("Saved workspace is invalid"))?;
    let fields = document
        .as_object_mut()
        .ok_or_else(|| ApiError::internal("Saved workspace is invalid"))?;
    let metadata = fields
        .remove("workspaceMetadata")
        .unwrap_or_else(|| serde_json::json!({}));
    if !metadata.is_object() {
        return Err(ApiError::internal("Saved workspace metadata is invalid"));
    }
    let profile: WorkspaceProfile = serde_json::from_value(document)
        .map_err(|_| ApiError::internal("Saved workspace is invalid"))?;
    validate_profile(&profile).map_err(|_| ApiError::internal("Saved workspace is invalid"))?;
    Ok((profile, metadata))
}

pub(crate) fn read_profile(path: &std::path::Path) -> Result<WorkspaceProfile, ApiError> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Workspace storage is unavailable"))?;
    read_record(path).map(|(profile, _)| profile)
}

pub(crate) fn write_profile(
    path: &std::path::Path,
    profile: &WorkspaceProfile,
) -> Result<(), ApiError> {
    let _guard = PROFILE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Workspace storage is unavailable"))?;
    validate_profile(profile)?;
    let _writer = lock_record_writer(path)?;
    let (existing, metadata) = read_record(path)?;
    for skill in &profile.skills {
        if skill.activation.is_none()
            && existing.skills.iter().any(|saved| {
                saved.id == skill.id && saved.activation == Some(SkillActivation::OnDemand)
            })
        {
            return Err(ApiError {
                status: axum::http::StatusCode::CONFLICT,
                message: "Skill activation is missing; reload the profile before saving".into(),
            });
        }
    }
    write_record(path, profile, &metadata)
}

fn write_record(
    path: &std::path::Path,
    profile: &WorkspaceProfile,
    metadata: &serde_json::Value,
) -> Result<(), ApiError> {
    use std::io::Write;
    validate_record_path(path)?;
    let mut document = serde_json::to_value(profile)
        .map_err(|_| ApiError::internal("Unable to save workspace"))?;
    document["workspaceMetadata"] = metadata.clone();
    let content = serde_json::to_vec(&document)
        .map_err(|_| ApiError::internal("Unable to save workspace"))?;
    if content.len() > KNOWLEDGE_RECORD_BYTES {
        return Err(ApiError::bad_request(
            "Workspace storage is limited to 2000000 bytes",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("Invalid workspace storage"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| ApiError::internal("Unable to create workspace storage"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| ApiError::internal("Unable to create workspace file"))?;
    file.write_all(&content)
        .map_err(|_| ApiError::internal("Unable to save workspace"))?;
    file.flush()
        .map_err(|_| ApiError::internal("Unable to save workspace"))?;
    file.as_file()
        .sync_all()
        .map_err(|_| ApiError::internal("Unable to flush workspace"))?;
    file.persist(path)
        .map_err(|_| ApiError::internal("Unable to replace saved workspace"))?;
    Ok(())
}

type ProfileResponse = (
    [(axum::http::header::HeaderName, &'static str); 1],
    Json<WorkspaceProfile>,
);

async fn load(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<ProfileResponse, ApiError> {
    let data_dir = state.config().data_dir.clone();
    let profile = tokio::task::spawn_blocking(move || {
        let path = profile_path(&data_dir, &user.user_id, &query.path)?;
        read_profile(&path)
    })
    .await
    .map_err(|_| ApiError::internal("Unable to load workspace"))??;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(profile),
    ))
}

async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
    Json(profile): Json<WorkspaceProfile>,
) -> Result<ProfileResponse, ApiError> {
    validate_profile(&profile)?;
    let data_dir = state.config().data_dir.clone();
    let profile = tokio::task::spawn_blocking(move || {
        let path = profile_path(&data_dir, &user.user_id, &query.path)?;
        write_profile(&path, &profile)?;
        Ok::<_, ApiError>(profile)
    })
    .await
    .map_err(|_| ApiError::internal("Unable to save workspace"))??;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(profile),
    ))
}

async fn load_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<ProfileResponse, ApiError> {
    let data_dir = state.config().data_dir.clone();
    let profile = tokio::task::spawn_blocking(move || {
        read_profile(&account_profile_path(&data_dir, &user.user_id))
    })
    .await
    .map_err(|_| ApiError::internal("Unable to load account knowledge"))??;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(profile),
    ))
}

async fn save_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(profile): Json<WorkspaceProfile>,
) -> Result<ProfileResponse, ApiError> {
    validate_profile(&profile)?;
    let data_dir = state.config().data_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        write_profile(&account_profile_path(&data_dir, &user.user_id), &profile)?;
        Ok::<_, ApiError>(profile)
    })
    .await
    .map_err(|_| ApiError::internal("Unable to save account knowledge"))??;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(result),
    ))
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn canonical_saved_provider_defaults_persist_and_malformed_bindings_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("profile.json");
        for transport in ["chat", "responses"] {
            let provider = format!("v4-profile:{transport}:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002");
            let profile = WorkspaceProfile {
                default_agent: provider.clone(),
                selection: Some(WorkspaceSelection {
                    model: "fixture-model".into(),
                    reasoning: String::new(),
                }),
                ..Default::default()
            };
            write_profile(&path, &profile).unwrap();
            assert_eq!(read_profile(&path).unwrap(), profile);
            for invalid in [
                format!("{provider}:extra"),
                provider.replace(transport, "invalid"),
                provider.replace(
                    "00000000-0000-4000-8000-000000000001",
                    "00000000-0000-0000-0000-000000000000",
                ),
                provider.to_uppercase(),
                format!(" {provider}"),
            ] {
                let invalid_profile = WorkspaceProfile {
                    default_agent: invalid.clone(),
                    ..Default::default()
                };
                assert!(
                    validate_profile(&invalid_profile).is_err(),
                    "accepted {invalid}"
                );
            }
        }
        for legacy in ["", "claude", "codex", "custom-agent_1"] {
            assert!(validate_profile(&WorkspaceProfile {
                default_agent: legacy.into(),
                ..Default::default()
            })
            .is_ok());
        }
    }

    #[test]
    fn skill_packages_accept_support_files_and_refuse_escape_or_credential_paths() {
        let mut value = serde_json::json!({"skills":[{"id":"00000000-0000-4000-8000-000000000001","name":"Review","instructions":"Inspect changes.","supportFiles":{"scripts/check.py":"print(42)","references/guide.md":"Use synthetic fixtures."}}]});
        let profile: WorkspaceProfile = serde_json::from_value(value.clone()).unwrap();
        assert!(validate_profile(&profile).is_ok());
        for path in [
            "../escape",
            "/absolute",
            "scripts/../../escape",
            ".env",
            "credentials.json",
            "mail.mbox",
            "scripts/linked\\escape",
        ] {
            value["skills"][0]["supportFiles"] = serde_json::json!({path:"sensitive"});
            let profile: WorkspaceProfile = serde_json::from_value(value.clone()).unwrap();
            assert!(validate_profile(&profile).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn support_packages_reject_case_collisions_control_characters_and_ambiguous_segments() {
        for files in [
            BTreeMap::from([
                ("References".into(), "File".into()),
                ("references/check.md".into(), "Nested".into()),
            ]),
            BTreeMap::from([("script.py".into(), "bad\u{1}".into())]),
            BTreeMap::from([("references//guide.md".into(), "Guide".into())]),
        ] {
            assert!(validate_support_files(&files).is_err());
        }
    }

    #[test]
    fn workspace_profile_rejects_duplicate_skill_ids_and_empty_content() {
        let skill = WorkspaceSkill {
            id: uuid::Uuid::nil(),
            name: "Review".into(),
            instructions: "Check async boundaries.".into(),
            activation: None,
            support_files: Default::default(),
        };
        let duplicate = WorkspaceProfile {
            skills: vec![skill.clone(), skill.clone()],
            ..Default::default()
        };
        let empty = WorkspaceProfile {
            skills: vec![WorkspaceSkill {
                instructions: " ".into(),
                ..skill
            }],
            ..Default::default()
        };
        assert_eq!(
            [
                validate_profile(&duplicate).is_err(),
                validate_profile(&empty).is_err()
            ],
            [true, true]
        );
    }

    #[test]
    fn workspace_profile_rejects_model_selections_without_an_agent_and_command_fields() {
        let profile = WorkspaceProfile {
            selection: Some(WorkspaceSelection {
                model: "sonnet".into(),
                reasoning: "high".into(),
            }),
            ..Default::default()
        };
        assert!(validate_profile(&profile).is_err());
        let unsafe_selection = r#"{"defaultAgent":"claude","selection":{"model":"sonnet","reasoning":"high","launchCommand":"arbitrary command"}}"#;
        assert!(serde_json::from_str::<WorkspaceProfile>(unsafe_selection).is_err());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    fn legacy_defaults_and_saves_cannot_silently_downgrade_on_demand() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let legacy: WorkspaceProfile = serde_json::from_value(serde_json::json!({"memory":"Keep", "skills":[{"id":uuid::Uuid::new_v4(),"name":"Review","instructions":"Check","supportFiles":{"refs/a.md":"Keep"}}]})).unwrap();
        assert_eq!(
            legacy.skills[0].activation.unwrap_or_default(),
            SkillActivation::AlwaysOn
        );
        for path in [
            account_profile_path(data.path(), "owner"),
            profile_path(data.path(), "owner", &workspace.path().to_string_lossy()).unwrap(),
        ] {
            write_profile(&path, &legacy).unwrap();
            let mut opted_in = read_profile(&path).unwrap();
            opted_in.skills[0].activation = Some(SkillActivation::OnDemand);
            write_profile(&path, &opted_in).unwrap();
            assert_eq!(read_profile(&path).unwrap(), opted_in);
            assert_eq!(
                write_profile(&path, &legacy).unwrap_err().status,
                axum::http::StatusCode::CONFLICT
            );
            assert_eq!(read_profile(&path).unwrap(), opted_in);
            opted_in.skills[0].activation = Some(SkillActivation::AlwaysOn);
            write_profile(&path, &opted_in).unwrap();
            assert_eq!(read_profile(&path).unwrap(), opted_in);
        }
        assert_eq!(
            read_profile(&account_profile_path(data.path(), "other")).unwrap(),
            WorkspaceProfile::default()
        );
        assert_eq!(
            read_profile(
                &profile_path(data.path(), "other", &workspace.path().to_string_lossy()).unwrap()
            )
            .unwrap(),
            WorkspaceProfile::default()
        );
    }
    #[test]
    fn workspace_profile_atomic_update_keeps_the_latest_valid_data() {
        let directory = tempfile::tempdir().unwrap();
        let path = profile_path(
            directory.path(),
            "owner",
            directory.path().to_str().unwrap(),
        )
        .unwrap();
        let first = WorkspaceProfile {
            memory: "Initial note".into(),
            ..Default::default()
        };
        let next = WorkspaceProfile {
            memory: "Updated note".into(),
            ..Default::default()
        };
        write_profile(&path, &first).unwrap();
        write_profile(&path, &next).unwrap();
        assert_eq!(read_profile(&path).unwrap(), next);
    }

    #[test]
    fn workspace_profile_corrupt_storage_is_an_error_and_is_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("profile.json");
        let corrupt = "invalid saved data";
        std::fs::write(&path, corrupt).unwrap();
        assert!(read_profile(&path).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), corrupt);
    }

    #[test]
    fn workspace_profile_directory_aliases_share_a_key_and_relative_paths_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let direct = directory.path().to_str().unwrap();
        let alias = directory.path().join(".").to_string_lossy().into_owned();
        assert_eq!(
            profile_path(directory.path(), "owner", direct).unwrap(),
            profile_path(directory.path(), "owner", &alias).unwrap()
        );
        assert!(profile_path(directory.path(), "owner", "../project").is_err());
    }
}

#[cfg(test)]
mod record_tests {
    use super::*;

    #[test]
    fn metadata_and_profile_are_atomic_and_manual_edits_preserve_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().to_str().unwrap();
        mutate_workspace_record(directory.path(), "owner", workspace, |profile, metadata| {
            profile.memory = "reviewed note".into();
            metadata["receipt"] = serde_json::json!({"id": "accepted"});
            Ok(())
        })
        .unwrap();
        let path = profile_path(directory.path(), "owner", workspace).unwrap();
        write_profile(
            &path,
            &WorkspaceProfile {
                memory: "manual edit".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let result =
            mutate_workspace_record(directory.path(), "owner", workspace, |profile, metadata| {
                Ok((profile.memory.clone(), metadata.clone()))
            })
            .unwrap();
        assert_eq!(
            result,
            (
                "manual edit".into(),
                serde_json::json!({"receipt": {"id": "accepted"}})
            )
        );
        let before = std::fs::read(&path).unwrap();
        let rejected =
            mutate_workspace_record(directory.path(), "owner", workspace, |profile, metadata| {
                profile.memory = "discarded".into();
                metadata["receipt"] = serde_json::Value::Null;
                Err::<(), _>(ApiError::bad_request("rejected"))
            });
        assert!(rejected.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    #[ignore = "invoked by the synthetic multi-process writer regression"]
    fn cross_process_writer_fixture() {
        let Some(root) = std::env::var_os("V4_KNOWLEDGE_PROCESS_FIXTURE") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let worker = std::env::var("V4_KNOWLEDGE_PROCESS_WORKER").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("start").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture start timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        for index in 0..12 {
            mutate_workspace_record(
                &root.join("data"),
                "process-fixture-owner",
                root.join("workspace").to_str().unwrap(),
                |profile, metadata| {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    profile.memory.push_str(&format!("{worker}:{index}\n"));
                    let entries = metadata
                        .as_object_mut()
                        .unwrap()
                        .entry("processReceipts")
                        .or_insert_with(|| serde_json::json!([]));
                    entries
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!([worker, index]));
                    Ok(())
                },
            )
            .unwrap();
        }
    }

    #[test]
    fn independent_process_mutations_preserve_every_profile_change_and_receipt() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("workspace")).unwrap();
        let executable = std::env::current_exe().unwrap();
        let mut children: Vec<_> = (0..3)
            .map(|worker| {
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "workspace::record_tests::cross_process_writer_fixture",
                        "--ignored",
                    ])
                    .env("V4_KNOWLEDGE_PROCESS_FIXTURE", directory.path())
                    .env("V4_KNOWLEDGE_PROCESS_WORKER", worker.to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect();
        std::fs::write(directory.path().join("start"), "").unwrap();
        for child in &mut children {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "fixture child failed");
                    break;
                }
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    panic!("fixture child timed out");
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        let (profile, metadata) = mutate_workspace_record(
            &directory.path().join("data"),
            "process-fixture-owner",
            directory.path().join("workspace").to_str().unwrap(),
            |profile, metadata| Ok((profile.clone(), metadata.clone())),
        )
        .unwrap();
        let actual: std::collections::BTreeSet<_> =
            profile.memory.lines().map(str::to_owned).collect();
        let expected: std::collections::BTreeSet<_> = (0..3)
            .flat_map(|worker| (0..12).map(move |index| format!("{worker}:{index}")))
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(metadata["processReceipts"].as_array().unwrap().len(), 36);
    }

    #[cfg(unix)]
    #[test]
    fn storage_rejects_symlinks_and_nonregular_files_before_opening_them() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().unwrap();
        let path = account_profile_path(directory.path(), "owner");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(validate_record_path(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        let external = directory.path().join("external.json");
        std::fs::write(&external, "{}").unwrap();
        std::os::unix::fs::symlink(&external, &path).unwrap();
        assert!(read_profile(&path).is_err());
        assert!(write_profile(&path, &WorkspaceProfile::default()).is_err());
        assert_eq!(std::fs::read_to_string(&external).unwrap(), "{}");
    }

    #[test]
    fn empty_record_reads_do_not_create_storage_and_invalid_metadata_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().to_str().unwrap();
        mutate_workspace_record(directory.path(), "owner", workspace, |_, _| Ok(())).unwrap();
        let path = profile_path(directory.path(), "owner", workspace).unwrap();
        assert!(!path.exists());
        let rejected =
            mutate_workspace_record(directory.path(), "owner", workspace, |_, metadata| {
                *metadata = serde_json::json!([]);
                Ok(())
            });
        assert!(rejected.is_err());
        assert!(!path.exists());
    }
}
