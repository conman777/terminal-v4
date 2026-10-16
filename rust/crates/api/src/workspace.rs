use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceProfile {
    pub memory: String,
    pub skills: Vec<WorkspaceSkill>,
    pub default_agent: String,
    pub selection: Option<WorkspaceSelection>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSkill {
    pub id: uuid::Uuid,
    pub name: String,
    pub instructions: String,
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
    Router::new().route("/api/workspace/profile", axum::routing::get(load).put(save))
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

pub(crate) fn validate_profile(profile: &WorkspaceProfile) -> Result<(), ApiError> {
    use std::collections::HashSet;
    if profile.memory.chars().count() > 6000 || profile.skills.len() > 20 {
        return Err(ApiError::bad_request(
            "Workspace knowledge is limited to 6000 characters and 20 skills",
        ));
    }
    if profile.default_agent.len() > 64
        || !profile
            .default_agent
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
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
    for skill in &profile.skills {
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
    if total > 50_000 {
        return Err(ApiError::bad_request(
            "Workspace context is limited to 50000 characters in total",
        ));
    }
    Ok(())
}

pub(crate) static PROFILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn read_record(path: &std::path::Path) -> Result<(WorkspaceProfile, serde_json::Value), ApiError> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((WorkspaceProfile::default(), serde_json::json!({})));
        }
        Err(_) => return Err(ApiError::internal("Unable to read saved workspace")),
    };
    let mut content = Vec::new();
    file.take(1_000_001)
        .read_to_end(&mut content)
        .map_err(|_| ApiError::internal("Unable to read saved workspace"))?;
    if content.len() > 1_000_000 {
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
    let (_, metadata) = read_record(path)?;
    write_record(path, profile, &metadata)
}

fn write_record(
    path: &std::path::Path,
    profile: &WorkspaceProfile,
    metadata: &serde_json::Value,
) -> Result<(), ApiError> {
    use std::io::Write;
    let mut document = serde_json::to_value(profile)
        .map_err(|_| ApiError::internal("Unable to save workspace"))?;
    document["workspaceMetadata"] = metadata.clone();
    let content = serde_json::to_vec(&document)
        .map_err(|_| ApiError::internal("Unable to save workspace"))?;
    if content.len() > 1_000_000 {
        return Err(ApiError::bad_request(
            "Workspace storage is limited to 1000000 bytes",
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

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn workspace_profile_rejects_duplicate_skill_ids_and_empty_content() {
        let skill = WorkspaceSkill {
            id: uuid::Uuid::nil(),
            name: "Review".into(),
            instructions: "Check async boundaries.".into(),
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
