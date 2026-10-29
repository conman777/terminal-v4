//! Project scripts, like T3 Code's project actions: named shell commands saved per project folder.
use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Query, State},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};

const MAX_SCRIPTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectScript {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectScripts {
    pub scripts: Vec<ProjectScript>,
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

fn scripts_path(
    state: &AppState,
    user_id: &str,
    path: &str,
) -> Result<std::path::PathBuf, ApiError> {
    let profile = crate::workspace::profile_path(&state.config().data_dir, user_id, path)?;
    let file = profile
        .file_name()
        .ok_or_else(|| ApiError::internal("Invalid project key"))?
        .to_owned();
    Ok(state
        .config()
        .data_dir
        .join("workspace-scripts")
        .join(
            profile
                .parent()
                .and_then(|owner| owner.file_name())
                .ok_or_else(|| ApiError::internal("Invalid project owner"))?,
        )
        .join(file))
}

pub(crate) fn validate(scripts: &ProjectScripts) -> Result<(), ApiError> {
    let invalid = scripts.scripts.len() > MAX_SCRIPTS
        || scripts.scripts.iter().any(|script| {
            script.name.trim().is_empty()
                || script.name.chars().count() > 60
                || script.name.chars().any(char::is_control)
                || script.command.trim().is_empty()
                || script.command.chars().count() > 2000
                || script.command.contains('\0')
        });
    if invalid {
        return Err(ApiError::bad_request(
            "Up to 20 scripts, each with a name (60 characters) and a command (2000 characters)",
        ));
    }
    Ok(())
}

async fn load(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<PathQuery>,
) -> Result<Json<ProjectScripts>, ApiError> {
    let path = scripts_path(&state, &user.user_id, &query.path)?;
    Ok(Json(
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default(),
    ))
}

async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<PathQuery>,
    Json(scripts): Json<ProjectScripts>,
) -> Result<Json<ProjectScripts>, ApiError> {
    validate(&scripts)?;
    let path = scripts_path(&state, &user.user_id, &query.path)?;
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("Invalid scripts path"))?;
    std::fs::create_dir_all(parent).map_err(|_| ApiError::internal("Unable to save scripts"))?;
    let file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| ApiError::internal("Unable to save scripts"))?;
    serde_json::to_writer(file.as_file(), &scripts)
        .map_err(|_| ApiError::internal("Unable to save scripts"))?;
    file.persist(&path)
        .map_err(|_| ApiError::internal("Unable to save scripts"))?;
    Ok(Json(scripts))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/workspace/scripts", get(load).put(save))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(name: &str, command: &str) -> ProjectScript {
        ProjectScript {
            name: name.into(),
            command: command.into(),
        }
    }

    #[test]
    fn scripts_need_a_name_and_a_command() {
        let ok = ProjectScripts {
            scripts: vec![script("Dev server", "npm run dev")],
        };
        let unnamed = ProjectScripts {
            scripts: vec![script(" ", "npm test")],
        };
        let too_many = ProjectScripts {
            scripts: (0..21).map(|n| script(&format!("s{n}"), "true")).collect(),
        };
        assert_eq!(
            [
                validate(&ok).is_ok(),
                validate(&unnamed).is_ok(),
                validate(&too_many).is_ok()
            ],
            [true, false, false]
        );
    }

    #[tokio::test]
    async fn scripts_are_saved_per_project_and_owner() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let path = project.path().to_str().unwrap().to_owned();
        let user = |id: &str| {
            Extension(AuthenticatedUser {
                user_id: id.into(),
                username: id.into(),
            })
        };
        let _saved = save(
            State(state.clone()),
            user("owner"),
            Query(PathQuery { path: path.clone() }),
            Json(ProjectScripts {
                scripts: vec![script("Dev server", "npm run dev")],
            }),
        )
        .await
        .unwrap();
        let mine = load(
            State(state.clone()),
            user("owner"),
            Query(PathQuery { path: path.clone() }),
        )
        .await
        .unwrap()
        .0
        .scripts;
        let theirs = load(State(state), user("other"), Query(PathQuery { path }))
            .await
            .unwrap()
            .0
            .scripts;
        assert_eq!(
            (mine, theirs),
            (vec![script("Dev server", "npm run dev")], vec![])
        );
    }
}
