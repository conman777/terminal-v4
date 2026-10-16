use crate::{
    auth::AuthenticatedUser,
    provider_rewind::{self, NativeFork, NativePlan},
    state::AppState,
    terminal::TerminalCreateOptions,
    workspace_git, ApiError,
};
use axum::{
    extract::{Path as RoutePath, Query, State},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use uuid::Uuid;
static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    id: Uuid,
    path: String,
    source_id: String,
    target_turn_id: String,
    checkpoint_id: Uuid,
    native_plan: NativePlan,
    files_fingerprint: String,
    status: String,
    recovery_checkpoint_id: Option<Uuid>,
    native_fork: Option<NativeFork>,
    session_id: Option<String>,
    error: Option<String>,
}
fn key(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn directory(data: &Path, owner: &str, workspace: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    data.join("workspace-rewinds").join(key(owner)).join(key(
        &crate::session_search::normalize_workspace_path(&canonical.to_string_lossy()),
    ))
}
fn save(data: &Path, owner: &str, workspace: &Path, operation: &Operation) -> Result<(), ApiError> {
    let directory = directory(data, owner, workspace);
    std::fs::create_dir_all(&directory)
        .map_err(|_| ApiError::internal("Unable to create rewind journal"))?;
    let body = serde_json::to_vec(operation)
        .map_err(|_| ApiError::internal("Unable to encode rewind journal"))?;
    if body.len() > 2_000_000 {
        return Err(ApiError::bad_request("Rewind plan exceeds storage limit"));
    }
    let mut file = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| ApiError::internal("Unable to create rewind journal"))?;
    std::io::Write::write_all(&mut file, &body)
        .map_err(|_| ApiError::internal("Unable to write rewind journal"))?;
    file.as_file()
        .sync_all()
        .map_err(|_| ApiError::internal("Unable to flush rewind journal"))?;
    file.persist(directory.join(format!("{}.json", operation.id)))
        .map_err(|_| ApiError::internal("Unable to save rewind journal"))?;
    Ok(())
}
fn load(data: &Path, owner: &str, workspace: &Path, id: Uuid) -> Result<Operation, ApiError> {
    let path = directory(data, owner, workspace).join(format!("{id}.json"));
    let file = std::fs::File::open(path)
        .map_err(|_| ApiError::not_found("Rewind operation unavailable"))?;
    let mut body = Vec::new();
    file.take(2_000_001)
        .read_to_end(&mut body)
        .map_err(|_| ApiError::internal("Unable to read rewind journal"))?;
    if body.len() > 2_000_000 {
        return Err(ApiError::internal("Rewind journal exceeds limit"));
    }
    let record: Operation =
        serde_json::from_slice(&body).map_err(|_| ApiError::internal("Invalid rewind journal"))?;
    if record.id != id
        || std::fs::canonicalize(&record.path).ok() != std::fs::canonicalize(workspace).ok()
    {
        return Err(ApiError::not_found("Rewind operation unavailable"));
    }
    Ok(record)
}
fn operations(data: &Path, owner: &str, workspace: &Path) -> Result<Vec<Operation>, ApiError> {
    let directory = directory(data, owner, workspace);
    if !directory.exists() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(directory)
        .map_err(|_| ApiError::internal("Unable to read rewind operations"))?;
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| ApiError::internal("Unable to read rewind operations"))?;
        if entry.path().extension().is_some_and(|v| v == "json") {
            let id = entry
                .path()
                .file_stem()
                .and_then(|v| v.to_str())
                .and_then(|v| Uuid::parse_str(v).ok())
                .ok_or_else(|| ApiError::internal("Invalid rewind journal filename"))?;
            records.push(load(data, owner, workspace, id)?);
            if records.len() > 100 {
                return Err(ApiError::bad_request("Rewind operation limit reached"));
            }
        }
    }
    Ok(records)
}
fn workspace(path: &str) -> Result<PathBuf, ApiError> {
    let path =
        std::fs::canonicalize(path).map_err(|_| ApiError::bad_request("Workspace unavailable"))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    Ok(path)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceInput {
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanInput {
    path: String,
    source_id: String,
    target_turn_id: String,
    checkpoint_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuspendInput {
    path: String,
    session_id: String,
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace/rewind", get(list_route))
        .route("/api/workspace/rewind/plan", post(plan_route))
        .route("/api/workspace/rewind/suspend", post(suspend_route))
        .route("/api/workspace/rewind/{id}/apply", post(apply_route))
        .route("/api/workspace/rewind/{id}/resume", post(resume_route))
        .route("/api/workspace/rewind/{id}/recover", post(recover_route))
}
async fn list_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(input): Query<WorkspaceInput>,
) -> Result<Json<Value>, ApiError> {
    let path = workspace(&input.path)?;
    let files =
        workspace_git::rewind_files(&state.config().data_dir, &user.user_id, &input.path).await?;
    let conversations = provider_rewind::list(&path, &user.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    let sessions = state
        .terminal_manager()
        .list_sessions(&user.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    let active: Vec<_> = sessions
        .into_iter()
        .filter(|session| session.is_active && same_workspace(&session.cwd, &path))
        .collect();
    let mut operations = operations(&state.config().data_dir, &user.user_id, &path)?;
    for operation in &mut operations {
        if ["applying", "branchCreated", "recovering", "resuming"]
            .contains(&operation.status.as_str())
        {
            operation.error=Some("Operation is in progress or was interrupted. Stop active work before recovering the saved files.".into());
        }
    }
    Ok(Json(
        json!({"managed":files.managed,"checkpoints":files.checkpoints,"conversations":conversations,"activeSessions":active,"operations":operations}),
    ))
}
fn same_workspace(candidate: &str, workspace: &Path) -> bool {
    crate::workspace_activity::workspace_key(Path::new(candidate))
        .ok()
        .zip(crate::workspace_activity::workspace_key(workspace).ok())
        .is_some_and(|(left, right)| left == right)
}
async fn plan_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<PlanInput>,
) -> Result<Json<Operation>, ApiError> {
    let _mutation = MUTATIONS.lock().await;
    let path = workspace(&input.path)?;
    let _activity = crate::workspace_activity::enter(&path).map_err(ApiError::bad_request)?;
    let files =
        workspace_git::rewind_files(&state.config().data_dir, &user.user_id, &input.path).await?;
    if !files.managed
        || !files
            .checkpoints
            .iter()
            .any(|v| v.id == input.checkpoint_id)
    {
        return Err(ApiError::bad_request(
            "Choose your managed worktree and one of its checkpoints",
        ));
    }
    if files.checkpoints.len() > 95
        || operations(&state.config().data_dir, &user.user_id, &path)?.len() >= 100
    {
        return Err(ApiError::bad_request(
            "Rewind storage limit reached; recovery requires spare checkpoint capacity",
        ));
    }
    let native_plan = provider_rewind::plan(
        &path,
        &user.user_id,
        &input.source_id,
        &input.target_turn_id,
    )
    .await
    .map_err(ApiError::bad_request)?;
    let operation = Operation {
        id: Uuid::new_v4(),
        path: path.to_string_lossy().into(),
        source_id: input.source_id,
        target_turn_id: input.target_turn_id,
        checkpoint_id: input.checkpoint_id,
        native_plan,
        files_fingerprint: files.fingerprint,
        status: "planned".into(),
        recovery_checkpoint_id: None,
        native_fork: None,
        session_id: None,
        error: None,
    };
    save(&state.config().data_dir, &user.user_id, &path, &operation)?;
    Ok(Json(operation))
}
async fn require_idle(state: &AppState, path: &Path) -> Result<(), ApiError> {
    if crate::workspace_tasks::has_pending_workspace(&state.config().data_dir, path)? {
        return Err(ApiError::bad_request(
            "Cancel queued or running tasks in this workspace before rewinding",
        ));
    }
    if state.terminal_manager().has_live_workspace(path).await
        || state
            .structured_session_manager()
            .has_active_workspace(path)
            .await
    {
        return Err(ApiError::bad_request("Suspend live terminals and interrupt structured agents in this workspace before rewinding"));
    }
    Ok(())
}
async fn apply_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
    Json(input): Json<WorkspaceInput>,
) -> Result<Json<Operation>, ApiError> {
    let _mutation = MUTATIONS.lock().await;
    let path = workspace(&input.path)?;
    let _activity = crate::workspace_activity::exclusive(&path).map_err(ApiError::bad_request)?;
    require_idle(&state, &path).await?;
    let data = &state.config().data_dir;
    let mut operation = load(data, &user.user_id, &path, id)?;
    if operation.status == "applied" || operation.status == "resumed" {
        return Ok(Json(operation));
    }
    if operation.status != "planned" {
        return Err(ApiError::bad_request(
            "This rewind cannot be applied again; review its recovery checkpoint",
        ));
    }
    let files = workspace_git::rewind_files(data, &user.user_id, &input.path).await?;
    if !files.managed
        || files.fingerprint != operation.files_fingerprint
        || files.checkpoints.len() > 95
    {
        return Err(ApiError::bad_request("Workspace files, index, HEAD, or checkpoint capacity changed; create a new rewind plan"));
    }
    let refreshed = provider_rewind::plan(
        &path,
        &user.user_id,
        &operation.source_id,
        &operation.target_turn_id,
    )
    .await
    .map_err(ApiError::bad_request)?;
    if refreshed != operation.native_plan {
        return Err(ApiError::bad_request(
            "Native conversation changed; create a new rewind plan",
        ));
    }
    operation.recovery_checkpoint_id = Some(
        workspace_git::capture_checkpoint(
            data,
            &user.user_id,
            &input.path,
            "Before conversation rewind",
        )
        .await?
        .id,
    );
    operation.status = "applying".into();
    save(data, &user.user_id, &path, &operation)?;
    match provider_rewind::apply(&path, &user.user_id, &operation.native_plan).await {
        Ok(branch) => {
            operation.native_fork = Some(branch);
            operation.status = "branchCreated".into();
            save(data, &user.user_id, &path, &operation)?;
        }
        Err(error) => {
            operation.status = "failed".into();
            operation.error = Some(error);
            save(data, &user.user_id, &path, &operation)?;
            return Ok(Json(operation));
        }
    }
    restore_planned_files(data, &user.user_id, &path, &mut operation).await?;
    Ok(Json(operation))
}
async fn restore_planned_files(
    data: &Path,
    owner: &str,
    path: &Path,
    operation: &mut Operation,
) -> Result<(), ApiError> {
    if operation.status != "branchCreated"
        || operation.native_fork.is_none()
        || operation.recovery_checkpoint_id.is_none()
    {
        return Err(ApiError::bad_request(
            "Native branch and recovery checkpoint must exist before file restoration",
        ));
    }
    match workspace_git::restore_checkpoint(
        data,
        owner,
        &path.to_string_lossy(),
        operation.checkpoint_id,
    )
    .await
    {
        Ok(()) => operation.status = "applied".into(),
        Err(error) => {
            operation.status = "failed".into();
            operation.error=Some(format!("Native branch is preserved, but file restore failed: {}. Use the recovery checkpoint before resuming.",error.message));
        }
    }
    save(data, owner, path, operation)
}
async fn suspend_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<SuspendInput>,
) -> Result<Json<Value>, ApiError> {
    let path = workspace(&input.path)?;
    let _activity = crate::workspace_activity::enter(&path).map_err(ApiError::bad_request)?;
    let snapshot = state
        .terminal_manager()
        .list_sessions(&user.user_id)
        .await
        .map_err(ApiError::bad_request)?
        .into_iter()
        .find(|session| session.id == input.session_id)
        .ok_or_else(|| ApiError::not_found("Session unavailable"))?;
    if !same_workspace(&snapshot.cwd, &path) {
        return Err(ApiError::bad_request(
            "Session belongs to another workspace",
        ));
    }
    state
        .terminal_manager()
        .suspend(&user.user_id, &input.session_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({"suspended":true})))
}
async fn resume_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
    Json(input): Json<WorkspaceInput>,
) -> Result<Json<Value>, ApiError> {
    let _mutation = MUTATIONS.lock().await;
    let path = workspace(&input.path)?;
    let _activity = crate::workspace_activity::enter(&path).map_err(ApiError::bad_request)?;
    let data = &state.config().data_dir;
    let mut operation = load(data, &user.user_id, &path, id)?;
    if !["applied", "resumed"].contains(&operation.status.as_str()) {
        return Err(ApiError::bad_request(
            "Files and native conversation must both be rewound before resuming",
        ));
    }
    if let Some(id) = &operation.session_id {
        if state.terminal_manager().is_active(id).await {
            let session = state
                .terminal_manager()
                .get_session_history(&user.user_id, id, &crate::state::HistoryQuery::default())
                .await
                .map_err(ApiError::bad_request)?
                .ok_or_else(|| ApiError::not_found("Resumed session unavailable"))?;
            return Ok(Json(json!({"operation":operation,"session":session})));
        }
    }
    let fork = operation
        .native_fork
        .as_ref()
        .ok_or_else(|| ApiError::internal("Native rewind branch unavailable"))?;
    let mut command = crate::agent_runtime::native_command(&fork.provider)
        .ok_or_else(|| ApiError::bad_request("Native provider is not installed"))?;
    command.args(&fork.resume_args);
    let initial_command =
        crate::agent_runtime::native_launch_command(&command).ok_or_else(|| {
            ApiError::bad_request("Native resume command contains unsupported shell characters")
        })?;
    operation.status = "resuming".into();
    save(data, &user.user_id, &path, &operation)?;
    let session = state
        .terminal_manager()
        .create_session(
            &user.user_id,
            TerminalCreateOptions {
                cwd: Some(operation.path.clone()),
                cols: None,
                rows: None,
                title: Some(format!("Rewound {}", fork.provider)),
                shell: None,
                sandbox_mode: None,
                sandbox_workspace_root: None,
                initial_command: Some(initial_command),
            },
        )
        .await;
    match session {
        Ok(session) => {
            operation.session_id = Some(session.id.clone());
            operation.status = "resumed".into();
            save(data, &user.user_id, &path, &operation)?;
            Ok(Json(json!({"operation":operation,"session":session})))
        }
        Err(error) => {
            operation.status = "applied".into();
            operation.error = Some(error);
            save(data, &user.user_id, &path, &operation)?;
            Ok(Json(json!({"operation":operation})))
        }
    }
}
async fn recover_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
    Json(input): Json<WorkspaceInput>,
) -> Result<Json<Operation>, ApiError> {
    let _mutation = MUTATIONS.lock().await;
    let path = workspace(&input.path)?;
    let _activity = crate::workspace_activity::exclusive(&path).map_err(ApiError::bad_request)?;
    require_idle(&state, &path).await?;
    let data = &state.config().data_dir;
    let mut operation = load(data, &user.user_id, &path, id)?;
    if operation.status == "recovered" {
        return Ok(Json(operation));
    }
    let recovery = operation
        .recovery_checkpoint_id
        .ok_or_else(|| ApiError::bad_request("No recovery checkpoint exists"))?;
    if workspace_git::checkpoint_matches(data, &user.user_id, &input.path, recovery).await? {
        operation.status = "recovered".into();
        operation.error = None;
        save(data, &user.user_id, &path, &operation)?;
        return Ok(Json(operation));
    }
    workspace_git::capture_checkpoint(
        data,
        &user.user_id,
        &input.path,
        "Before recovering rewind files",
    )
    .await?;
    operation.status = "recovering".into();
    save(data, &user.user_id, &path, &operation)?;
    match workspace_git::restore_checkpoint(data, &user.user_id, &input.path, recovery).await {
        Ok(()) => {
            operation.status = "recovered".into();
            operation.error = None;
        }
        Err(error) => {
            operation.status = "failed".into();
            operation.error = Some(error.message);
        }
    }
    save(data, &user.user_id, &path, &operation)?;
    Ok(Json(operation))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn operation(path: &Path) -> Operation {
        Operation {
            id: Uuid::new_v4(),
            path: path.to_string_lossy().into(),
            source_id: "source".into(),
            target_turn_id: "turn".into(),
            checkpoint_id: Uuid::new_v4(),
            native_plan: NativePlan {
                conversation: crate::provider_rewind::NativeConversation {
                    source_id: "source".into(),
                    provider: "codex".into(),
                    native_session_id: "native".into(),
                    title: "Task".into(),
                    turns: vec![],
                    fingerprint: "history".into(),
                },
                target_turn_id: "turn".into(),
                fingerprint: "history".into(),
            },
            files_fingerprint: "files".into(),
            status: "planned".into(),
            recovery_checkpoint_id: None,
            native_fork: None,
            session_id: None,
            error: None,
        }
    }
    fn git(path: &Path, args: &[&str]) {
        let result = std::process::Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    async fn isolated(data: &Path) -> (tempfile::TempDir, String) {
        let parent = tempfile::tempdir().unwrap();
        git(parent.path(), &["init", "-b", "main"]);
        git(parent.path(), &["config", "core.autocrlf", "false"]);
        git(parent.path(), &["config", "user.name", "Rewind tests"]);
        git(
            parent.path(),
            &["config", "user.email", "rewind@example.test"],
        );
        std::fs::write(parent.path().join("file.txt"), "original").unwrap();
        git(parent.path(), &["add", "."]);
        git(parent.path(), &["commit", "-m", "initial"]);
        let tree = workspace_git::create_managed_worktree(
            data,
            "owner",
            parent.path().to_str().unwrap(),
            "Rewind test",
            "HEAD",
        )
        .await
        .unwrap();
        (parent, tree.path)
    }
    #[tokio::test]
    async fn native_branch_file_restore_and_recovery_keep_pre_rewind_edits() {
        let data = tempfile::tempdir().unwrap();
        let (_parent, path) = isolated(data.path()).await;
        let path = Path::new(&path);
        let checkpoint = workspace_git::capture_checkpoint(
            data.path(),
            "owner",
            path.to_str().unwrap(),
            "Original",
        )
        .await
        .unwrap();
        std::fs::write(path.join("file.txt"), "newer unstaged edits").unwrap();
        std::fs::write(path.join("new.txt"), "new untracked file").unwrap();
        let recovery = workspace_git::capture_checkpoint(
            data.path(),
            "owner",
            path.to_str().unwrap(),
            "Recovery",
        )
        .await
        .unwrap();
        let mut record = operation(path);
        record.checkpoint_id = checkpoint.id;
        record.recovery_checkpoint_id = Some(recovery.id);
        record.native_fork = Some(NativeFork {
            provider: "codex".into(),
            native_session_id: "branch".into(),
            original_session_id: "original".into(),
            resume_args: vec!["resume".into(), "branch".into()],
        });
        record.status = "branchCreated".into();
        save(data.path(), "owner", path, &record).unwrap();
        restore_planned_files(data.path(), "owner", path, &mut record)
            .await
            .unwrap();
        assert_eq!(
            (
                record.status.as_str(),
                std::fs::read_to_string(path.join("file.txt")).unwrap(),
                path.join("new.txt").exists()
            ),
            ("applied", "original".into(), false)
        );
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let Json(recovered) = recover_route(
            State(state.clone()),
            Extension(user.clone()),
            RoutePath(record.id),
            Json(WorkspaceInput {
                path: path.to_string_lossy().into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            (
                recovered.status,
                std::fs::read_to_string(path.join("file.txt")).unwrap(),
                std::fs::read_to_string(path.join("new.txt")).unwrap()
            ),
            (
                "recovered".into(),
                "newer unstaged edits".into(),
                "new untracked file".into()
            )
        );
        let mut interrupted = load(data.path(), "owner", path, record.id).unwrap();
        interrupted.status = "recovering".into();
        save(data.path(), "owner", path, &interrupted).unwrap();
        let before_retry =
            workspace_git::rewind_files(data.path(), "owner", path.to_str().unwrap())
                .await
                .unwrap()
                .checkpoints
                .len();
        let Json(again) = recover_route(
            State(state),
            Extension(user),
            RoutePath(record.id),
            Json(WorkspaceInput {
                path: path.to_string_lossy().into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(again.status, "recovered");
        assert_eq!(
            workspace_git::rewind_files(data.path(), "owner", path.to_str().unwrap())
                .await
                .unwrap()
                .checkpoints
                .len(),
            before_retry
        );
    }
    #[tokio::test]
    async fn recovered_operation_cannot_reopen_a_previous_native_branch() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let path = workspace(folder.path().to_str().unwrap()).unwrap();
        let mut record = operation(&path);
        record.status = "recovered".into();
        record.session_id = Some("old-session".into());
        save(data.path(), "owner", &path, &record).unwrap();
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let result = resume_route(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            }),
            RoutePath(record.id),
            Json(WorkspaceInput {
                path: path.to_string_lossy().into(),
            }),
        )
        .await;
        assert_eq!(
            result.unwrap_err().status,
            axum::http::StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn failed_file_restore_retains_branch_and_recovery_and_cannot_resume() {
        let data = tempfile::tempdir().unwrap();
        let (_parent, path) = isolated(data.path()).await;
        let path = workspace(&path).unwrap();
        let mut record = operation(&path);
        record.recovery_checkpoint_id = Some(
            workspace_git::capture_checkpoint(
                data.path(),
                "owner",
                path.to_str().unwrap(),
                "Recovery",
            )
            .await
            .unwrap()
            .id,
        );
        record.native_fork = Some(NativeFork {
            provider: "codex".into(),
            native_session_id: "branch".into(),
            original_session_id: "original".into(),
            resume_args: vec![],
        });
        record.status = "branchCreated".into();
        restore_planned_files(data.path(), "owner", &path, &mut record)
            .await
            .unwrap();
        assert_eq!(
            (
                record.status.as_str(),
                record
                    .native_fork
                    .as_ref()
                    .unwrap()
                    .native_session_id
                    .as_str(),
                record.recovery_checkpoint_id.is_some()
            ),
            ("failed", "branch", true)
        );
        assert_eq!(
            std::fs::read_to_string(path.join("file.txt")).unwrap(),
            "original"
        );
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let result = resume_route(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            }),
            RoutePath(record.id),
            Json(WorkspaceInput {
                path: path.to_string_lossy().into(),
            }),
        )
        .await;
        assert_eq!(
            result.unwrap_err().status,
            axum::http::StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn api_rejects_unauthed_other_owner_and_stale_files_before_native_fork() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        let data = tempfile::tempdir().unwrap();
        let (_parent, path) = isolated(data.path()).await;
        let canonical = workspace(&path).unwrap();
        let mut record = operation(&canonical);
        record.checkpoint_id =
            workspace_git::capture_checkpoint(data.path(), "owner", &path, "Files")
                .await
                .unwrap()
                .id;
        record.files_fingerprint = workspace_git::rewind_files(data.path(), "owner", &path)
            .await
            .unwrap()
            .fingerprint;
        save(data.path(), "owner", &canonical, &record).unwrap();
        std::fs::write(canonical.join("file.txt"), "changed since plan").unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "rewind-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let uri = format!("/api/workspace/rewind/{}/apply", record.id);
        for (owner, status) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("other"), StatusCode::NOT_FOUND),
            (Some("owner"), StatusCode::BAD_REQUEST),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri(&uri)
                .header("content-type", "application/json");
            if let Some(owner) = owner {
                request = request.header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token("rewind-test", owner, owner)
                    ),
                );
            }
            let response = app
                .clone()
                .oneshot(
                    request
                        .body(Body::from(json!({"path":path}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        let saved = load(data.path(), "owner", &canonical, record.id).unwrap();
        assert_eq!(
            (
                saved.status,
                saved.native_fork,
                saved.recovery_checkpoint_id
            ),
            ("planned".into(), None, None)
        );
        assert_eq!(
            std::fs::read_to_string(canonical.join("file.txt")).unwrap(),
            "changed since plan"
        );
    }
    #[test]
    fn journal_is_atomic_owner_and_workspace_scoped_and_preserves_recovery() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut record = operation(workspace.path());
        save(data.path(), "owner", workspace.path(), &record).unwrap();
        assert!(load(data.path(), "other", workspace.path(), record.id).is_err());
        assert!(load(data.path(), "owner", other.path(), record.id).is_err());
        record.status = "applying".into();
        record.recovery_checkpoint_id = Some(Uuid::new_v4());
        save(data.path(), "owner", workspace.path(), &record).unwrap();
        let restored = load(data.path(), "owner", workspace.path(), record.id).unwrap();
        assert_eq!(
            (restored.status, restored.recovery_checkpoint_id),
            ("applying".into(), record.recovery_checkpoint_id)
        );
    }
}
