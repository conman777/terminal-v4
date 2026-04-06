mod auth;
mod external_auth;
pub mod git;
mod state;
mod structured;
mod terminal;
pub mod turn_detector;

use auth::{authenticate_token, require_auth, AuthenticatedUser};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use state::{AppState, BookmarkUpdate, HistoryQuery, NoteUpdate, SettingsPatch};
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use structured::StructuredSessionManager;
use terminal::{TerminalCreateOptions, TerminalSubscriptionEvent, ThreadUpdate};
use terminal_v4_core::{HealthResponse, StructuredSessionSnapshot};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

pub use state::AppState as ApiState;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

pub fn app(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let protected = Router::new()
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/logout", post(logout))
        .route(
            "/api/structured/sessions",
            get(list_structured_sessions).post(create_structured_session),
        )
        .route(
            "/api/structured/sessions/{id}",
            get(get_structured_session)
                .patch(rename_structured_session)
                .delete(delete_structured_session),
        )
        .route(
            "/api/structured/sessions/{id}/thread",
            get(get_structured_thread).patch(update_structured_thread),
        )
        .route(
            "/api/structured/sessions/{id}/message",
            post(send_structured_message),
        )
        .route(
            "/api/structured/sessions/{id}/interrupt",
            post(interrupt_structured_session),
        )
        .route(
            "/api/structured/sessions/{id}/approve",
            post(approve_structured_session),
        )
        .route(
            "/api/terminal",
            get(list_terminal_sessions).post(create_terminal_session),
        )
        .route(
            "/api/terminal/{id}/history",
            get(get_terminal_session_history),
        )
        .route("/api/terminal/{id}/turns", get(get_terminal_turns))
        .route("/api/terminal/{id}/input", post(write_terminal_input))
        .route("/api/terminal/{id}/resize", post(resize_terminal))
        .route("/api/terminal/{id}/restore", post(restore_terminal_session))
        .route(
            "/api/terminal/{id}",
            delete(delete_terminal_session).patch(rename_terminal_session),
        )
        .route(
            "/api/terminal/{id}/git-branches",
            get(get_terminal_git_branches),
        )
        .route(
            "/api/terminal/{id}/git-stats",
            get(get_terminal_git_stats),
        )
        .route(
            "/api/terminal/{id}/git-checkout",
            post(terminal_git_checkout),
        )
        .route(
            "/api/terminal/{id}/thread",
            get(get_terminal_thread).patch(update_terminal_thread),
        )
        .route(
            "/api/terminal/{id}/generate-topic",
            post(generate_terminal_topic),
        )
        .route(
            "/api/terminal/{id}/detect-project",
            post(detect_terminal_project),
        )
        .route("/api/state", get(get_app_state))
        .route("/api/projects/scan", get(scan_projects))
        .route(
            "/api/projects/scan-dirs",
            get(list_project_scan_dirs).post(add_project_scan_dir),
        )
        .route("/api/preview/active-ports", get(get_active_preview_ports))
        .route("/api/fs/list", get(list_filesystem_folders))
        .route("/api/settings", get(get_settings).patch(update_settings))
        .route("/api/system/preview-config", get(get_preview_config))
        .route("/api/bookmarks", get(list_bookmarks).post(create_bookmark))
        .route(
            "/api/bookmarks/{id}",
            put(update_bookmark).delete(delete_bookmark),
        )
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/{id}", put(update_note).delete(delete_note))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/register", post(register_disabled))
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(refresh))
        .route(
            "/api/structured/sessions/{id}/ws",
            get(connect_structured_ws),
        )
        .route("/api/terminal/{id}/ws", get(connect_terminal_ws))
        .route(
            "/api/terminal/{id}/stream",
            get(stream_terminal_session),
        )
        .merge(protected)
        .layer(cors)
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse::ok())
}

async fn register_disabled() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "Registration is disabled. Users are managed externally." })),
    )
}

async fn auth_me(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Json<terminal_v4_core::AuthMeResponse> {
    Json(state.auth_me(&user))
}

#[derive(Debug, Deserialize)]
struct LoginInput {
    username: Option<String>,
    email: Option<String>,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshInput {
    refresh_token: String,
}

async fn login(
    State(state): State<AppState>,
    Json(input): Json<LoginInput>,
) -> Result<Json<terminal_v4_core::AuthResult>, ApiError> {
    let identifier = input
        .username
        .as_deref()
        .or(input.email.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("Username is required"))?;

    if input.password.is_empty() {
        return Err(ApiError::bad_request("Password is required"));
    }

    match state
        .login(identifier, &input.password)
        .await
        .map_err(ApiError::internal)?
    {
        Some(result) => Ok(Json(result)),
        None => Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid credentials".to_string(),
        }),
    }
}

async fn refresh(
    State(state): State<AppState>,
    Json(input): Json<RefreshInput>,
) -> Result<Json<terminal_v4_core::AuthResult>, ApiError> {
    if input.refresh_token.is_empty() {
        return Err(ApiError::bad_request("Refresh token is required"));
    }

    match state
        .refresh_auth(&input.refresh_token)
        .await
        .map_err(ApiError::internal)?
    {
        Some(result) => Ok(Json(result)),
        None => Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid refresh token".to_string(),
        }),
    }
}

async fn logout(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    state
        .logout_user(&user.user_id)
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Debug, Deserialize)]
struct StructuredSessionCreateInput {
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StructuredMessageInput {
    text: String,
}

#[derive(Debug, Deserialize)]
struct StructuredApprovalInput {
    approved: bool,
}

#[derive(Debug, Deserialize)]
struct StructuredRenameInput {
    title: String,
}

async fn create_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<StructuredSessionCreateInput>,
) -> Result<(StatusCode, Json<StructuredSessionSnapshot>), ApiError> {
    validate_string(&input.cwd, 1, 4096, "cwd")?;
    if let Some(provider) = &input.provider {
        validate_string(provider, 1, 80, "provider")?;
    }
    if let Some(model) = &input.model {
        validate_string(model, 1, 120, "model")?;
    }
    if let Some(title) = &input.title {
        validate_string(title, 1, 80, "title")?;
    }

    let session = state
        .structured_session_manager()
        .create_session(
            &user.user_id,
            &input.cwd,
            input.provider.as_deref(),
            input.model.as_deref(),
            input.title.as_deref(),
        )
        .await
        .map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn list_structured_sessions(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Vec<StructuredSessionSnapshot>>, ApiError> {
    state
        .structured_session_manager()
        .list_sessions(&user.user_id)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

async fn get_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<StructuredSessionSnapshot>, ApiError> {
    let Some(session) = state
        .structured_session_manager()
        .get_session(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };
    Ok(Json(session))
}

async fn rename_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<StructuredRenameInput>,
) -> Result<Json<StructuredSessionSnapshot>, ApiError> {
    validate_string(&input.title, 1, 80, "title")?;
    let Some(session) = state
        .structured_session_manager()
        .rename_session(&user.user_id, &session_id, &input.title)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };

    Ok(Json(session))
}

async fn get_structured_thread(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(thread) = state
        .structured_session_manager()
        .get_thread(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };

    Ok(Json(json!({ "thread": thread })))
}

async fn update_structured_thread(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<ThreadUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let Some(thread) = state
        .structured_session_manager()
        .update_thread(
            &user.user_id,
            &session_id,
            structured::StructuredThreadUpdate {
                topic: input.topic,
                topic_auto_generated: input.topic_auto_generated,
                pinned: input.pinned,
                archived: input.archived,
                project_path: input.project_path,
            },
        )
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };

    Ok(Json(json!({ "thread": thread })))
}

async fn send_structured_message(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<StructuredMessageInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.text, 1, 100_000, "text")?;
    state
        .structured_session_manager()
        .send_message(&user.user_id, &session_id, &input.text)
        .await
        .map_err(ApiError::internal)?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "status": "accepted" }))))
}

async fn interrupt_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .structured_session_manager()
        .interrupt(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn approve_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<StructuredApprovalInput>,
) -> Result<Json<Value>, ApiError> {
    state
        .structured_session_manager()
        .approve(&user.user_id, &session_id, input.approved)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn delete_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .structured_session_manager()
        .delete_session(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "status": "deleted" })))
}

async fn get_settings(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<terminal_v4_core::UserSettings>, ApiError> {
    state
        .get_settings(&user)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn list_terminal_sessions(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let sessions = state
        .terminal_manager()
        .list_sessions(&user.user_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "sessions": sessions })))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TerminalHistoryQueryInput {
    history_chars: Option<String>,
    history_events: Option<String>,
    before_ts: Option<String>,
    after_ts: Option<String>,
    before_seq: Option<String>,
    after_seq: Option<String>,
}

async fn get_terminal_session_history(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Query(query): Query<TerminalHistoryQueryInput>,
) -> Result<Json<Value>, ApiError> {
    let query = parse_terminal_history_query(query);
    let Some(snapshot) = state
        .terminal_manager()
        .get_session_history(&user.user_id, &session_id, &query)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };

    let last_entry = snapshot.history.last();
    let next_cursor = last_entry.map(|entry| entry.ts);
    let next_seq = last_entry.and_then(|entry| entry.seq);
    Ok(Json(json!({
        "id": snapshot.id,
        "title": snapshot.title,
        "shell": snapshot.shell,
        "createdAt": snapshot.created_at,
        "updatedAt": snapshot.updated_at,
        "history": snapshot.history,
        "usesTmux": snapshot.uses_tmux,
        "sandbox": snapshot.sandbox,
        "nextCursor": next_cursor,
        "nextSeq": next_seq
    })))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TerminalCreateInput {
    cwd: Option<String>,
    cols: Option<i64>,
    rows: Option<i64>,
    title: Option<String>,
    shell: Option<String>,
    initial_command: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerminalInputBody {
    command: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeInput {
    cols: i64,
    rows: i64,
    client_id: Option<String>,
    priority: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TerminalRestoreInput {
    cols: Option<i64>,
    rows: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TerminalRenameInput {
    title: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ThreadUpdateInput {
    topic: Option<Option<String>>,
    topic_auto_generated: Option<bool>,
    pinned: Option<bool>,
    archived: Option<bool>,
    project_path: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct ProjectScanDirInput {
    path: String,
}

#[derive(Debug, Deserialize, Default)]
struct FilesystemListQuery {
    path: Option<String>,
}

async fn create_terminal_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<TerminalCreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if let Some(title) = &input.title {
        validate_string(title, 1, 80, "title")?;
    }
    if let Some(shell) = &input.shell {
        validate_string(shell, 1, 512, "shell")?;
    }
    if let Some(initial_command) = &input.initial_command {
        validate_string(initial_command, 0, 1000, "initialCommand")?;
    }
    validate_optional_terminal_size(input.cols, "cols")?;
    validate_optional_terminal_size(input.rows, "rows")?;

    let session = state
        .terminal_manager()
        .create_session(
            &user.user_id,
            TerminalCreateOptions {
                cwd: input.cwd,
                cols: input.cols,
                rows: input.rows,
                title: input.title,
                shell: input.shell,
                initial_command: input.initial_command,
            },
        )
        .await
        .map_err(ApiError::internal)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "session": {
                "id": session.id,
                "title": session.title,
                "shell": session.shell,
                "createdAt": session.created_at,
                "updatedAt": session.updated_at,
                "usesTmux": session.uses_tmux,
                "sandbox": session.sandbox
            }
        })),
    ))
}

async fn rename_terminal_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<TerminalRenameInput>,
) -> Result<Json<Value>, ApiError> {
    validate_string(&input.title, 1, 80, "title")?;
    let Some(session) = state
        .terminal_manager()
        .rename_session(&user.user_id, &session_id, &input.title)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };

    Ok(Json(json!({
        "session": {
            "id": session.id,
            "title": session.title,
            "shell": session.shell,
            "cwd": session.cwd,
            "createdAt": session.created_at,
            "updatedAt": session.updated_at,
            "usesTmux": session.uses_tmux,
            "sandbox": session.sandbox,
            "thread": session.thread
        }
    })))
}

async fn write_terminal_input(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<TerminalInputBody>,
) -> Result<StatusCode, ApiError> {
    validate_string(&input.command, 1, 1024 * 1024, "command")?;
    state
        .terminal_manager()
        .write(&user.user_id, &session_id, &input.command)
        .await
        .map_err(|error| ApiError {
            status: StatusCode::NOT_FOUND,
            message: error,
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resize_terminal(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<TerminalResizeInput>,
) -> Result<Json<Value>, ApiError> {
    validate_terminal_size(input.cols, "cols")?;
    validate_terminal_size(input.rows, "rows")?;
    let result = state
        .terminal_manager()
        .resize(
            &user.user_id,
            &session_id,
            input.cols,
            input.rows,
            input.client_id.clone(),
            input.priority.unwrap_or(false),
        )
        .await
        .map_err(|error| ApiError {
            status: StatusCode::NOT_FOUND,
            message: error,
        })?;
    Ok(Json(json!({
        "appliedCols": result.current_cols,
        "appliedRows": result.current_rows,
        "ownerClientId": result.owner_client_id,
        "isOwner": input.client_id.map(|client_id| result.owner_client_id.as_deref() == Some(client_id.as_str()))
    })))
}

async fn restore_terminal_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<TerminalRestoreInput>,
) -> Result<Json<Value>, ApiError> {
    validate_optional_terminal_size(input.cols, "cols")?;
    validate_optional_terminal_size(input.rows, "rows")?;

    let Some(session) = state
        .terminal_manager()
        .restore_session(&user.user_id, &session_id, input.cols, input.rows)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Persisted session not found".to_string(),
        });
    };

    Ok(Json(json!({
        "session": {
            "id": session.id,
            "title": session.title,
            "shell": session.shell,
            "createdAt": session.created_at,
            "updatedAt": session.updated_at,
            "usesTmux": session.uses_tmux,
            "sandbox": session.sandbox
        }
    })))
}

async fn get_terminal_turns(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(_) = terminal_session_summary(&state, &user, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };

    Ok(Json(json!({ "turns": [] })))
}

async fn delete_terminal_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = state
        .terminal_manager()
        .close(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        })
    }
}

async fn get_app_state(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<AppStateQuery>,
) -> Result<Json<Value>, ApiError> {
    let terminal_manager = state.terminal_manager();
    let sessions = terminal_manager
        .list_sessions(&user.user_id)
        .await
        .map_err(ApiError::internal)?;
    let project_info = if let Some(session_id) = query.session_id.as_deref() {
        terminal_manager
            .get_project_info(&user.user_id, session_id)
            .await
            .map_err(ApiError::internal)?
    } else {
        None
    };
    Ok(Json(json!({
        "sessions": sessions,
        "projectInfo": project_info,
        "claudeCodeSessions": []
    })))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppStateQuery {
    session_id: Option<String>,
}

async fn get_terminal_thread(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(thread) = state
        .terminal_manager()
        .get_thread(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };
    Ok(Json(json!({ "thread": thread })))
}

async fn get_terminal_git_branches(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(_) = terminal_session_summary(&state, &user, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Git branches not available for this terminal".to_string(),
        });
    };

    let current_branch = state
        .terminal_manager()
        .get_project_info(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?
        .and_then(|info| info.git_branch);
    let branches = current_branch.clone().into_iter().collect::<Vec<_>>();

    Ok(Json(json!({
        "branches": branches,
        "currentBranch": current_branch
    })))
}

async fn update_terminal_thread(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<ThreadUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let Some(thread) = state
        .terminal_manager()
        .update_thread(
            &user.user_id,
            &session_id,
            ThreadUpdate {
                topic: input.topic,
                topic_auto_generated: input.topic_auto_generated,
                pinned: input.pinned,
                archived: input.archived,
                project_path: input.project_path,
            },
        )
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };
    Ok(Json(json!({ "thread": thread })))
}

async fn generate_terminal_topic(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(session) = terminal_session_summary(&state, &user, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };

    if let Some(topic) = session
        .thread
        .as_ref()
        .and_then(|thread| thread.topic.clone())
        .filter(|topic| !topic.trim().is_empty())
    {
        return Ok(Json(json!({
            "topic": topic,
            "thread": session.thread
        })));
    }

    let Some(topic) = infer_terminal_topic(&session) else {
        return Ok(Json(json!({
            "topic": Value::Null,
            "thread": session.thread
        })));
    };

    let Some(thread) = state
        .terminal_manager()
        .update_thread(
            &user.user_id,
            &session_id,
            ThreadUpdate {
                topic: Some(Some(topic.clone())),
                topic_auto_generated: Some(true),
                pinned: None,
                archived: None,
                project_path: None,
            },
        )
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };

    Ok(Json(json!({
        "topic": topic,
        "thread": thread
    })))
}

async fn detect_terminal_project(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let project_path = state
        .terminal_manager()
        .detect_project(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "projectPath": project_path })))
}

async fn get_terminal_git_stats(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let stats = state
        .terminal_manager()
        .get_git_stats(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "gitStats": stats })))
}

#[derive(Debug, Deserialize)]
struct GitCheckoutInput {
    branch: String,
}

async fn terminal_git_checkout(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<GitCheckoutInput>,
) -> Result<Json<Value>, ApiError> {
    let branch_info = state
        .terminal_manager()
        .git_checkout(&user.user_id, &session_id, &input.branch)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({
        "branches": branch_info.branches,
        "currentBranch": branch_info.current_branch
    })))
}

async fn stream_terminal_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> axum::response::Response {
    let snapshot = match state
        .terminal_manager()
        .get_session_history(&user.user_id, &session_id, &query)
        .await
    {
        Ok(Some(s)) => s,
        Ok(None) => {
            return ApiError {
                status: StatusCode::NOT_FOUND,
                message: "Terminal session not found".to_string(),
            }
            .into_response()
        }
        Err(e) => return ApiError::internal(e).into_response(),
    };

    let is_active = state.terminal_manager().is_active(&session_id).await;

    let broadcast_rx = if is_active {
        state
            .terminal_manager()
            .subscribe(&user.user_id, &session_id)
            .await
            .ok()
    } else {
        None
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, std::convert::Infallible>>(64);

    tokio::spawn(async move {
        for event in &snapshot.history {
            let data = serde_json::to_string(event).unwrap_or_default();
            if tx
                .send(Ok(Event::default().event("data").data(data)))
                .await
                .is_err()
            {
                return;
            }
        }

        if let Some(mut broadcast) = broadcast_rx {
            loop {
                match broadcast.recv().await {
                    Ok(TerminalSubscriptionEvent::Output(event)) => {
                        let data = serde_json::to_string(&event).unwrap_or_default();
                        if tx
                            .send(Ok(Event::default().event("data").data(data)))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(TerminalSubscriptionEvent::Closed) => {
                        let _ = tx
                            .send(Ok(Event::default().event("end").data("{}")))
                            .await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        let _ = tx
                            .send(Ok(Event::default().event("end").data("{}")))
                            .await;
                        break;
                    }
                }
            }
        } else {
            let _ = tx
                .send(Ok(Event::default().event("end").data("{}")))
                .await;
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn scan_projects(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let projects = project_scan_entries(&state, &user).map_err(ApiError::internal)?;
    Ok(Json(json!({ "projects": projects })))
}

async fn list_project_scan_dirs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let directories = project_scan_paths(&state, &user).map_err(ApiError::internal)?;
    Ok(Json(json!({ "directories": directories })))
}

async fn add_project_scan_dir(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<ProjectScanDirInput>,
) -> Result<Json<Value>, ApiError> {
    validate_string(&input.path, 1, 4096, "path")?;
    let mut directories = project_scan_paths(&state, &user).map_err(ApiError::internal)?;
    if !directories
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(input.path.trim()))
    {
        directories.push(input.path.trim().to_string());
    }
    let projects = project_entries_from_paths(directories.iter().cloned());
    Ok(Json(json!({
        "success": true,
        "directories": directories,
        "projects": projects
    })))
}

async fn get_preview_config() -> Json<Value> {
    let default_mode =
        std::env::var("PREVIEW_DEFAULT_MODE").unwrap_or_else(|_| "path-first".to_string());
    let cookie_policy = std::env::var("PREVIEW_COOKIE_POLICY").ok();
    let rewrite_scope = std::env::var("PREVIEW_REWRITE_SCOPE").ok();

    Json(json!({
        "subdomainBases": [],
        "proxyHosts": [],
        "preferPathBased": default_mode == "path-first",
        "defaultMode": default_mode,
        "cookiePolicy": cookie_policy,
        "rewriteScope": rewrite_scope
    }))
}

async fn get_active_preview_ports() -> Json<Value> {
    Json(json!({ "ports": [] }))
}

async fn list_filesystem_folders(
    Query(query): Query<FilesystemListQuery>,
) -> Result<Json<Value>, ApiError> {
    let requested_path = query
        .path
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let resolved_path = filesystem_list_path(requested_path).map_err(ApiError::bad_request)?;
    let folders = visible_folder_names(&resolved_path).map_err(ApiError::bad_request)?;
    let parent = resolved_path
        .parent()
        .map(normalize_filesystem_path)
        .filter(|value| !value.is_empty());

    Ok(Json(json!({
        "path": normalize_filesystem_path(&resolved_path),
        "folders": folders,
        "parent": parent
    })))
}

async fn update_settings(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let patch = SettingsPatch::from_value(payload).map_err(ApiError::bad_request)?;
    state
        .update_settings(&user, patch)
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Debug, Deserialize)]
struct BookmarkCreateInput {
    name: String,
    command: String,
    category: String,
}

#[derive(Debug, Deserialize, Default)]
struct BookmarkUpdateInput {
    name: Option<String>,
    command: Option<String>,
    category: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NoteCreateInput {
    title: String,
    content: String,
    category: String,
}

#[derive(Debug, Deserialize, Default)]
struct NoteUpdateInput {
    title: Option<String>,
    content: Option<String>,
    category: Option<String>,
}

async fn list_bookmarks(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let bookmarks = state.list_bookmarks(&user).map_err(ApiError::internal)?;
    Ok(Json(json!({ "bookmarks": bookmarks })))
}

async fn create_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<BookmarkCreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.name, 1, 100, "name")?;
    validate_string(&input.command, 1, 1000, "command")?;
    validate_string(&input.category, 1, 50, "category")?;

    let bookmark = state
        .create_bookmark(&user, input.name, input.command, input.category)
        .map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(json!({ "bookmark": bookmark }))))
}

async fn update_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(bookmark_id): Path<String>,
    Json(input): Json<BookmarkUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    if let Some(name) = &input.name {
        validate_string(name, 1, 100, "name")?;
    }
    if let Some(command) = &input.command {
        validate_string(command, 1, 1000, "command")?;
    }
    if let Some(category) = &input.category {
        validate_string(category, 1, 50, "category")?;
    }

    match state
        .update_bookmark(
            &user,
            &bookmark_id,
            BookmarkUpdate {
                name: input.name,
                command: input.command,
                category: input.category,
            },
        )
        .map_err(ApiError::internal)?
    {
        Some(bookmark) => Ok(Json(json!({ "bookmark": bookmark }))),
        None => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Bookmark not found".to_string(),
        }),
    }
}

async fn delete_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(bookmark_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = state
        .delete_bookmark(&user, &bookmark_id)
        .map_err(ApiError::internal)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Bookmark not found".to_string(),
        })
    }
}

async fn list_notes(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let notes = state.list_notes(&user).map_err(ApiError::internal)?;
    Ok(Json(json!({ "notes": notes })))
}

async fn create_note(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<NoteCreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.title, 1, 200, "title")?;
    validate_string(&input.content, 0, 50_000, "content")?;
    validate_string(&input.category, 1, 50, "category")?;

    let note = state
        .create_note(&user, input.title, input.content, input.category)
        .map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(json!({ "note": note }))))
}

async fn update_note(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(note_id): Path<String>,
    Json(input): Json<NoteUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    if let Some(title) = &input.title {
        validate_string(title, 1, 200, "title")?;
    }
    if let Some(content) = &input.content {
        validate_string(content, 0, 50_000, "content")?;
    }
    if let Some(category) = &input.category {
        validate_string(category, 1, 50, "category")?;
    }

    match state
        .update_note(
            &user,
            &note_id,
            NoteUpdate {
                title: input.title,
                content: input.content,
                category: input.category,
            },
        )
        .map_err(ApiError::internal)?
    {
        Some(note) => Ok(Json(json!({ "note": note }))),
        None => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Note not found".to_string(),
        }),
    }
}

async fn delete_note(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(note_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = state
        .delete_note(&user, &note_id)
        .map_err(ApiError::internal)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Note not found".to_string(),
        })
    }
}

fn validate_string(
    value: &str,
    min_length: usize,
    max_length: usize,
    field: &str,
) -> Result<(), ApiError> {
    if value.len() < min_length || value.len() > max_length {
        return Err(ApiError::bad_request(format!(
            "{field} length must be between {min_length} and {max_length}"
        )));
    }
    Ok(())
}

fn parse_terminal_history_query(input: TerminalHistoryQueryInput) -> HistoryQuery {
    let max_history_chars = parse_positive_usize(input.history_chars.as_deref());
    let max_history_events = parse_positive_usize(input.history_events.as_deref());
    let default_history_chars = std::env::var("TERMINAL_HISTORY_CHARS")
        .ok()
        .and_then(|value| parse_positive_usize(Some(value.as_str())))
        .or(Some(5_000_000));
    let default_history_events = std::env::var("TERMINAL_HISTORY_EVENTS")
        .ok()
        .and_then(|value| parse_positive_usize(Some(value.as_str())))
        .or(Some(20_000));

    HistoryQuery {
        max_history_chars: max_history_chars.or_else(|| {
            if max_history_events.is_none() {
                default_history_chars
            } else {
                None
            }
        }),
        max_history_events: max_history_events.or_else(|| {
            if max_history_chars.is_none() {
                default_history_events
            } else {
                None
            }
        }),
        before_ts: parse_positive_i64(input.before_ts.as_deref()),
        after_ts: parse_positive_i64(input.after_ts.as_deref()),
        before_seq: parse_positive_i64(input.before_seq.as_deref()),
        after_seq: parse_non_negative_i64(input.after_seq.as_deref()),
    }
}

fn parse_positive_usize(value: Option<&str>) -> Option<usize> {
    value
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
}

fn parse_positive_i64(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn parse_non_negative_i64(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 0)
}

fn validate_optional_terminal_size(value: Option<i64>, field: &str) -> Result<(), ApiError> {
    if let Some(value) = value {
        validate_terminal_size(value, field)?;
    }
    Ok(())
}

fn validate_terminal_size(value: i64, field: &str) -> Result<(), ApiError> {
    if !(1..=500).contains(&value) {
        return Err(ApiError::bad_request(format!(
            "{field} must be between 1 and 500"
        )));
    }
    Ok(())
}

fn project_scan_paths(state: &AppState, user: &AuthenticatedUser) -> Result<Vec<String>, String> {
    let settings = state.get_settings(user)?;
    let terminal_v4_core::UserSettings {
        sidebar_projects,
        pinned_folders,
        recent_folders,
        ..
    } = settings;
    let mut paths = Vec::new();
    if let Some(sidebar_projects) = sidebar_projects {
        for project in sidebar_projects {
            push_unique_path(&mut paths, project.path);
        }
    }
    if let Some(pinned_folders) = pinned_folders {
        for folder in pinned_folders {
            push_unique_path(&mut paths, folder);
        }
    }
    if let Some(recent_folders) = recent_folders {
        for folder in recent_folders {
            push_unique_path(&mut paths, folder);
        }
    }
    Ok(paths)
}

fn project_scan_entries(state: &AppState, user: &AuthenticatedUser) -> Result<Vec<Value>, String> {
    project_scan_paths(state, user).map(|paths| project_entries_from_paths(paths.into_iter()))
}

fn project_entries_from_paths(paths: impl IntoIterator<Item = String>) -> Vec<Value> {
    paths
        .into_iter()
        .map(|path| {
            let name = FsPath::new(&path)
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("Project")
                .to_string();
            json!({
                "path": path,
                "name": name
            })
        })
        .collect()
}

fn push_unique_path(paths: &mut Vec<String>, candidate: String) {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return;
    }
    if paths
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(trimmed))
    {
        return;
    }
    paths.push(trimmed.to_string());
}

#[derive(Debug, Deserialize, Default)]
struct StructuredWsQuery {
    token: Option<String>,
}

async fn connect_structured_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<StructuredWsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let token = query
        .token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Missing structured session token".to_string(),
        })?;
    let user = authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        &token,
    )
    .map_err(|_| ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Invalid or expired token".to_string(),
    })?;

    let structured_manager = state.structured_session_manager();
    let (history, subscription) = structured_manager
        .subscribe(&user.user_id, &session_id)
        .await
        .map_err(|error| ApiError {
            status: StatusCode::NOT_FOUND,
            message: error,
        })?;

    Ok(ws.on_upgrade(move |socket| {
        handle_structured_ws(
            socket,
            structured_manager,
            user,
            session_id,
            history,
            subscription,
        )
    }))
}

async fn handle_structured_ws(
    mut socket: WebSocket,
    structured_manager: StructuredSessionManager,
    user: AuthenticatedUser,
    session_id: String,
    history: Vec<terminal_v4_core::StructuredSessionEvent>,
    mut subscription: tokio::sync::broadcast::Receiver<terminal_v4_core::StructuredSessionEvent>,
) {
    for event in history {
        if socket
            .send(Message::Text(
                json!({
                    "__terminal_meta": true,
                    "type": "structured_event",
                    "event": event
                })
                .to_string()
                .into(),
            ))
            .await
            .is_err()
        {
            return;
        }
    }

    loop {
        tokio::select! {
            event = subscription.recv() => {
                match event {
                    Ok(event) => {
                        if socket
                            .send(Message::Text(
                                json!({
                                    "__terminal_meta": true,
                                    "type": "structured_event",
                                    "event": event
                                })
                                .to_string()
                                .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(message)) => {
                        let Some(payload) = message_text(message) else {
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                            continue;
                        };
                        match value.get("type").and_then(Value::as_str) {
                            Some("message") => {
                                if let Some(text) = value.get("text").and_then(Value::as_str) {
                                    let _ = structured_manager
                                        .send_message(&user.user_id, &session_id, text)
                                        .await;
                                }
                            }
                            Some("interrupt") => {
                                let _ = structured_manager
                                    .interrupt(&user.user_id, &session_id)
                                    .await;
                            }
                            Some("approve") => {
                                let approved = value
                                    .get("approved")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false);
                                let _ = structured_manager
                                    .approve(&user.user_id, &session_id, approved)
                                    .await;
                            }
                            _ => {}
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
        }
    }

    let _ = socket.send(Message::Close(None)).await;
}

async fn terminal_session_summary(
    state: &AppState,
    user: &AuthenticatedUser,
    session_id: &str,
) -> Result<Option<terminal_v4_core::TerminalSessionSummary>, String> {
    state
        .terminal_manager()
        .list_sessions(&user.user_id)
        .await
        .map(|sessions| {
            sessions
                .into_iter()
                .find(|session| session.id == session_id)
        })
}

fn infer_terminal_topic(session: &terminal_v4_core::TerminalSessionSummary) -> Option<String> {
    let title = session.title.trim();
    if !title.is_empty()
        && !title.eq_ignore_ascii_case("terminal")
        && !title.starts_with("Terminal ")
    {
        return Some(title.chars().take(60).collect());
    }

    session
        .thread
        .as_ref()
        .and_then(|thread| thread.project_path.as_deref())
        .or(session.group_path.as_deref())
        .or(Some(session.cwd.as_str()))
        .and_then(|path| FsPath::new(path).file_name())
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(60).collect())
}

fn filesystem_list_path(requested_path: Option<&str>) -> Result<PathBuf, String> {
    let base_path = match requested_path {
        Some(value) => PathBuf::from(value.trim()),
        None => default_filesystem_list_path(),
    };
    let canonical = fs::canonicalize(&base_path)
        .map_err(|error| format!("Cannot access directory: {error}"))?;
    if !canonical.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    Ok(canonical)
}

fn default_filesystem_list_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn visible_folder_names(path: &FsPath) -> Result<Vec<String>, String> {
    let mut folders = fs::read_dir(path)
        .map_err(|error| format!("Cannot access directory: {error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }

            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }

            Some(name)
        })
        .collect::<Vec<_>>();
    folders.sort_by_key(|value| value.to_ascii_lowercase());
    Ok(folders)
}

fn normalize_filesystem_path(path: &FsPath) -> String {
    let value = path.to_string_lossy().to_string();
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

#[derive(Debug, Deserialize, Default)]
struct TerminalWsQuery {
    framed: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerminalWsAuthMessage {
    #[serde(rename = "type")]
    kind: String,
    token: String,
}

async fn connect_terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<TerminalWsQuery>,
) -> impl IntoResponse {
    let framed = matches!(query.framed.as_deref(), Some("1" | "true" | "yes"));
    ws.on_upgrade(move |socket| handle_terminal_ws(socket, state, session_id, framed))
}

async fn handle_terminal_ws(
    mut socket: WebSocket,
    state: AppState,
    session_id: String,
    framed: bool,
) {
    let first_message =
        match tokio::time::timeout(std::time::Duration::from_secs(5), socket.recv()).await {
            Ok(Some(Ok(message))) => message,
            _ => {
                let _ = socket.send(Message::Close(None)).await;
                return;
            }
        };

    let Some(auth_payload) = message_text(first_message) else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let Ok(auth_message) = serde_json::from_str::<TerminalWsAuthMessage>(&auth_payload) else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    if auth_message.kind != "auth" {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    let Ok(user) = authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        &auth_message.token,
    ) else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };

    let terminal_manager = state.terminal_manager();
    let mut subscription = match terminal_manager.subscribe(&user.user_id, &session_id).await {
        Ok(subscription) => subscription,
        Err(_) => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    let client_id = Uuid::new_v4().to_string();
    if send_ws_meta(
        &mut socket,
        framed,
        json!({ "type": "clientId", "clientId": client_id }),
    )
    .await
    .is_err()
    {
        let _ = terminal_manager
            .remove_client(&user.user_id, &session_id, &client_id)
            .await;
        return;
    }

    let mut ping_interval = tokio::time::interval(tokio::time::Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = ping_interval.tick() => {
                if send_ws_meta(&mut socket, framed, json!({ "type": "serverPing" })).await.is_err() {
                    break;
                }
            }
            event = subscription.recv() => {
                match event {
                    Ok(TerminalSubscriptionEvent::Output(output)) => {
                        if let Some(seq) = output.seq {
                            if send_ws_meta(&mut socket, framed, json!({ "type": "serverCursor", "seq": seq })).await.is_err() {
                                break;
                            }
                        }
                        if send_ws_output(&mut socket, framed, &output.text).await.is_err() {
                            break;
                        }
                    }
                    Ok(TerminalSubscriptionEvent::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if send_ws_meta(
                            &mut socket,
                            framed,
                            json!({ "type": "resyncSuggested", "reason": "slow-client-drop", "ts": time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000 }),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(message)) => {
                        let Some(payload) = message_text(message) else {
                            continue;
                        };
                        if payload.contains("__terminal_ping__") {
                            if send_ws_output(&mut socket, framed, "__terminal_pong__").await.is_err() {
                                break;
                            }
                            continue;
                        }
                        if is_client_ping_json(&payload) {
                            if send_ws_meta(&mut socket, framed, json!({ "type": "pong", "source": "terminal-client", "ts": time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000 })).await.is_err() {
                                break;
                            }
                            continue;
                        }
                        if terminal_manager.write(&user.user_id, &session_id, &payload).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
        }
    }

    terminal_manager
        .remove_client(&user.user_id, &session_id, &client_id)
        .await;
    let _ = socket.send(Message::Close(None)).await;
}

fn message_text(message: Message) -> Option<String> {
    match message {
        Message::Text(text) => Some(text.to_string()),
        Message::Binary(data) => String::from_utf8(data.to_vec()).ok(),
        Message::Close(_) => None,
        Message::Ping(_) | Message::Pong(_) => None,
    }
}

fn is_client_ping_json(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .ok()
        .map(|value| {
            value.get("type") == Some(&Value::String("ping".to_string()))
                && value.get("source") == Some(&Value::String("terminal-client".to_string()))
        })
        .unwrap_or(false)
}

async fn send_ws_meta(
    socket: &mut WebSocket,
    framed: bool,
    payload: Value,
) -> Result<(), axum::Error> {
    let text = payload.to_string();
    if framed {
        let mut bytes = Vec::with_capacity(text.len() + 1);
        bytes.push(2_u8);
        bytes.extend_from_slice(text.as_bytes());
        socket.send(Message::Binary(bytes.into())).await
    } else {
        socket.send(Message::Text(text.into())).await
    }
}

async fn send_ws_output(
    socket: &mut WebSocket,
    framed: bool,
    payload: &str,
) -> Result<(), axum::Error> {
    if framed {
        let mut bytes = Vec::with_capacity(payload.len() + 1);
        bytes.push(1_u8);
        bytes.extend_from_slice(payload.as_bytes());
        socket.send(Message::Binary(bytes.into())).await
    } else {
        socket.send(Message::Text(payload.to_string().into())).await
    }
}

#[cfg(test)]
mod tests {
    use super::{app, normalize_filesystem_path, ApiState};
    use crate::auth::issue_access_token;
    use crate::external_auth::{ExternalAuthProvider, ExternalAuthUser};
    use crate::structured::{
        SpawnedStructuredProcess, StructuredProcessController, StructuredProvider,
        StructuredSessionManager, StructuredSpawnOptions,
    };
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use bcrypt::{hash, DEFAULT_COST};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;
    use terminal_v4_core::{AppConfig, HealthResponse, StructuredSessionEvent, UserSettings};
    use tokio::sync::{mpsc, Mutex};
    use tokio::time::{sleep, Duration};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_route_returns_the_expected_payload() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: HealthResponse =
            serde_json::from_slice(&body).expect("payload should deserialize");

        assert_eq!(payload, HealthResponse::ok());
    }

    #[tokio::test]
    async fn authenticated_me_route_returns_token_identity() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-1", "conor");

        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/auth/me")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn local_login_returns_user_and_tokens() {
        let state = test_state();
        state
            .create_local_user_for_test("conor", "secret123")
            .expect("test user should be created");

        let response = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "username": "conor",
                            "password": "secret123"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("login payload should deserialize");

        assert_eq!(payload["user"]["username"], "conor");
        assert!(payload["tokens"]["accessToken"].as_str().is_some());
        assert!(payload["tokens"]["refreshToken"].as_str().is_some());
    }

    #[tokio::test]
    async fn refresh_rotates_tokens_and_logout_invalidates_refresh_tokens() {
        let state = test_state();
        state
            .create_local_user_for_test("conor", "secret123")
            .expect("test user should be created");
        let app = app(state);

        let login_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "username": "conor",
                            "password": "secret123"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        let login_body = login_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let login_payload: Value =
            serde_json::from_slice(&login_body).expect("login payload should deserialize");
        let access_token = login_payload["tokens"]["accessToken"]
            .as_str()
            .expect("access token should be a string")
            .to_string();
        let refresh_token = login_payload["tokens"]["refreshToken"]
            .as_str()
            .expect("refresh token should be a string")
            .to_string();

        let refresh_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/refresh")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "refreshToken": refresh_token
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(refresh_response.status(), StatusCode::OK);
        let refresh_body = refresh_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let refresh_payload: Value =
            serde_json::from_slice(&refresh_body).expect("refresh payload should deserialize");
        let rotated_refresh = refresh_payload["tokens"]["refreshToken"]
            .as_str()
            .expect("rotated refresh token should be a string")
            .to_string();
        assert_ne!(rotated_refresh, "");

        let logout_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/logout")
                    .header("Authorization", format!("Bearer {access_token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(logout_response.status(), StatusCode::OK);

        let invalid_refresh = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/refresh")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "refreshToken": rotated_refresh
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(invalid_refresh.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn external_login_uses_provider_when_local_user_is_missing() {
        let provider = Arc::new(FakeExternalAuthProvider::new(vec![external_user(
            "external-1",
            "conor@example.com",
            Some("Conor"),
            "secret123",
        )]));
        let external_auth: Arc<dyn ExternalAuthProvider> = provider.clone();
        let response = app(test_state_with_external_auth(Some(external_auth)))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "username": "Conor",
                            "password": "secret123"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("login payload should deserialize");

        assert_eq!(
            payload,
            json!({
                "user": {
                    "id": "external-1",
                    "username": "Conor",
                    "created_at": "2026-04-05T10:00:00Z"
                },
                "tokens": {
                    "accessToken": payload["tokens"]["accessToken"],
                    "refreshToken": payload["tokens"]["refreshToken"]
                }
            })
        );
        assert_eq!(provider.identifier_hits(), 1);
        assert_eq!(provider.id_hits(), 0);
    }

    #[tokio::test]
    async fn external_refresh_uses_provider_for_mirror_users() {
        let provider = Arc::new(FakeExternalAuthProvider::new(vec![external_user(
            "external-2",
            "conor@example.com",
            Some("Conor"),
            "secret123",
        )]));
        let external_auth: Arc<dyn ExternalAuthProvider> = provider.clone();
        let app = app(test_state_with_external_auth(Some(external_auth)));

        let login_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "email": "conor@example.com",
                            "password": "secret123"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(login_response.status(), StatusCode::OK);
        let login_body = login_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let login_payload: Value =
            serde_json::from_slice(&login_body).expect("login payload should deserialize");
        let refresh_token = login_payload["tokens"]["refreshToken"]
            .as_str()
            .expect("refresh token should be a string")
            .to_string();

        let refresh_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/refresh")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "refreshToken": refresh_token
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(refresh_response.status(), StatusCode::OK);

        let refresh_body = refresh_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let refresh_payload: Value =
            serde_json::from_slice(&refresh_body).expect("refresh payload should deserialize");

        assert_eq!(refresh_payload["user"]["id"], "external-2");
        assert_eq!(refresh_payload["user"]["username"], "Conor");
        assert_eq!(provider.identifier_hits(), 1);
        assert_eq!(provider.id_hits(), 1);
    }

    #[tokio::test]
    async fn settings_route_requires_authentication() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/api/settings")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn terminal_sessions_route_lists_persisted_sessions_in_updated_order() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-4", "conor");
        write_terminal_session_fixture(
            &state,
            "user-4",
            "session-a",
            json!({
                "id": "session-a",
                "title": "Backend shell",
                "shell": "/bin/bash",
                "cwd": "C:\\repo-a",
                "createdAt": "2026-04-05T09:00:00Z",
                "updatedAt": "2026-04-05T09:30:00Z",
                "history": [
                    { "text": "npm run dev", "ts": 1 },
                    { "text": "ready", "ts": 2 }
                ],
                "sandbox": {
                    "mode": "workspace-write",
                    "workspaceRoot": "C:\\repo-a",
                    "runtimeId": "runtime-a",
                    "runtimeKind": "workspace-copy"
                },
                "thread": {
                    "topic": "Terminal rewrite",
                    "topicAutoGenerated": true,
                    "pinned": false,
                    "archived": false,
                    "projectPath": "C:\\repo-a",
                    "sandboxMode": "workspace-write",
                    "sandboxWorkspaceRoot": "C:\\repo-a",
                    "gitStats": {
                        "linesAdded": 10,
                        "linesRemoved": 3
                    },
                    "lastActivityAt": "2026-04-05T09:31:00Z"
                }
            }),
        );
        write_terminal_session_fixture(
            &state,
            "user-4",
            "session-b",
            json!({
                "id": "session-b",
                "title": "Frontend shell",
                "shell": "/bin/bash",
                "cwd": "C:\\repo-b",
                "createdAt": "2026-04-05T10:00:00Z",
                "updatedAt": "2026-04-05T11:00:00Z",
                "history": [
                    { "text": "pnpm dev", "ts": 3 }
                ]
            }),
        );

        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("terminal sessions payload should deserialize");
        let sessions = payload["sessions"]
            .as_array()
            .expect("sessions should be an array");

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["id"], "session-b");
        assert_eq!(sessions[0]["messageCount"], 1);
        assert_eq!(sessions[0]["isActive"], false);
        assert_eq!(sessions[0]["isBusy"], false);
        assert_eq!(sessions[1]["id"], "session-a");
        assert_eq!(sessions[1]["sandbox"]["runtimeKind"], "workspace-copy");
        assert_eq!(sessions[1]["thread"]["topic"], "Terminal rewrite");
        assert_eq!(sessions[1]["thread"]["gitStats"]["linesAdded"], 10);
        assert_eq!(sessions[1]["lastActivityAt"], "2026-04-05T09:31:00Z");
    }

    #[tokio::test]
    async fn terminal_history_route_returns_snapshot_and_assigns_missing_sequences() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-5", "conor");
        write_terminal_session_fixture(
            &state,
            "user-5",
            "session-history",
            json!({
                "id": "session-history",
                "title": "History shell",
                "shell": "/bin/bash",
                "cwd": "C:\\repo-c",
                "createdAt": "2026-04-05T12:00:00Z",
                "updatedAt": "2026-04-05T12:30:00Z",
                "history": [
                    { "text": "first", "ts": 1000 },
                    { "text": "second", "ts": 2000 },
                    { "text": "third", "ts": 3000, "seq": 9 }
                ]
            }),
        );

        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/terminal/session-history/history")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("history payload should deserialize");

        assert_eq!(payload["id"], "session-history");
        assert_eq!(payload["usesTmux"], false);
        assert_eq!(payload["history"][0]["seq"], 1);
        assert_eq!(payload["history"][1]["seq"], 2);
        assert_eq!(payload["history"][2]["seq"], 9);
        assert_eq!(payload["nextCursor"], 3000);
        assert_eq!(payload["nextSeq"], 9);
    }

    #[tokio::test]
    async fn terminal_history_route_applies_sequence_and_event_filters() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-6", "conor");
        write_terminal_session_fixture(
            &state,
            "user-6",
            "session-filtered",
            json!({
                "id": "session-filtered",
                "title": "Filtered shell",
                "shell": "/bin/bash",
                "cwd": "C:\\repo-d",
                "createdAt": "2026-04-05T13:00:00Z",
                "updatedAt": "2026-04-05T13:30:00Z",
                "history": [
                    { "text": "one", "ts": 1000, "seq": 1 },
                    { "text": "two", "ts": 2000, "seq": 2 },
                    { "text": "three", "ts": 3000, "seq": 3 },
                    { "text": "four", "ts": 4000, "seq": 4 }
                ]
            }),
        );

        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/terminal/session-filtered/history?afterSeq=1&beforeSeq=4&historyEvents=2")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("history payload should deserialize");
        let history = payload["history"]
            .as_array()
            .expect("history should be an array");

        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["text"], "two");
        assert_eq!(history[1]["text"], "three");
        assert_eq!(payload["nextCursor"], 3000);
        assert_eq!(payload["nextSeq"], 3);
    }

    #[tokio::test]
    async fn terminal_create_state_input_and_delete_routes_work_for_live_sessions() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-7", "conor");
        let app = app(state);

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({}).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(create_response.status(), StatusCode::CREATED);
        let create_body = create_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let create_payload: Value =
            serde_json::from_slice(&create_body).expect("create payload should deserialize");
        let session_id = create_payload["session"]["id"]
            .as_str()
            .expect("session id should be a string")
            .to_string();

        let state_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/state?sessionId={session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(state_response.status(), StatusCode::OK);
        let state_body = state_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let state_payload: Value =
            serde_json::from_slice(&state_body).expect("state payload should deserialize");
        assert_eq!(state_payload["claudeCodeSessions"], json!([]));
        assert_eq!(state_payload["sessions"][0]["id"], session_id);
        assert_eq!(state_payload["sessions"][0]["isActive"], true);

        let input_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/terminal/{session_id}/input"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({ "command": if cfg!(windows) { "echo hi\r" } else { "echo hi\n" } })
                            .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(input_response.status(), StatusCode::NO_CONTENT);

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/terminal/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn terminal_restore_route_reactivates_persisted_session() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-8", "conor");
        let app = app(state.clone());
        write_terminal_session_fixture(
            &state,
            "user-8",
            "restorable",
            json!({
                "id": "restorable",
                "title": "Restorable shell",
                "shell": if cfg!(windows) { "C:\\Windows\\System32\\cmd.exe" } else { "/bin/bash" },
                "cwd": state.config().data_dir.to_string_lossy().to_string(),
                "createdAt": "2026-04-05T14:00:00Z",
                "updatedAt": "2026-04-05T14:30:00Z",
                "history": [
                    { "text": "seed", "ts": 1000, "seq": 1 }
                ]
            }),
        );

        let restore_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal/restorable/restore")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({}).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(restore_response.status(), StatusCode::OK);

        let sessions_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(sessions_response.status(), StatusCode::OK);
        let sessions_body = sessions_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let sessions_payload: Value =
            serde_json::from_slice(&sessions_body).expect("sessions payload should deserialize");
        assert_eq!(sessions_payload["sessions"][0]["id"], "restorable");
        assert_eq!(sessions_payload["sessions"][0]["isActive"], true);

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/terminal/restorable")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn project_scan_and_preview_config_routes_return_bootstrap_payloads() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-9", "conor");
        let app = app(state.clone());
        let sidebar_project = state.config().data_dir.join("workspace-one");
        let extra_project = state.config().data_dir.join("workspace-two");
        fs::create_dir_all(&sidebar_project).expect("sidebar project dir should exist");
        fs::create_dir_all(&extra_project).expect("extra project dir should exist");

        let patch_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/settings")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "sidebarProjects": [{
                                "path": sidebar_project.to_string_lossy().to_string(),
                                "name": "workspace-one"
                            }],
                            "recentFolders": [sidebar_project.to_string_lossy().to_string()]
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(patch_response.status(), StatusCode::OK);

        let projects_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/projects/scan")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(projects_response.status(), StatusCode::OK);
        let projects_body = projects_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let projects_payload: Value =
            serde_json::from_slice(&projects_body).expect("projects payload should deserialize");
        assert_eq!(
            projects_payload["projects"][0]["path"],
            sidebar_project.to_string_lossy().to_string()
        );

        let scan_dirs_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/projects/scan-dirs")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(scan_dirs_response.status(), StatusCode::OK);

        let add_dir_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/scan-dirs")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({ "path": extra_project.to_string_lossy().to_string() }).to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(add_dir_response.status(), StatusCode::OK);
        let add_dir_body = add_dir_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let add_dir_payload: Value =
            serde_json::from_slice(&add_dir_body).expect("scan dir payload should deserialize");
        assert_eq!(add_dir_payload["success"], true);
        assert!(add_dir_payload["directories"]
            .as_array()
            .expect("directories should be an array")
            .iter()
            .any(|entry| entry == &Value::String(extra_project.to_string_lossy().to_string())));

        let preview_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/system/preview-config")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(preview_response.status(), StatusCode::OK);
        let preview_body = preview_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let preview_payload: Value =
            serde_json::from_slice(&preview_body).expect("preview payload should deserialize");
        assert_eq!(preview_payload["defaultMode"], "path-first");
    }

    #[tokio::test]
    async fn terminal_thread_metadata_and_project_detection_routes_work() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-10", "conor");
        let app = app(state.clone());
        let repo_path = state.config().data_dir.join("repo");
        fs::create_dir_all(repo_path.join(".git")).expect("git dir should exist");
        let repo_path_string = repo_path.to_string_lossy().to_string();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "cwd": repo_path_string
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(create_response.status(), StatusCode::CREATED);
        let create_body = create_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let create_payload: Value =
            serde_json::from_slice(&create_body).expect("create payload should deserialize");
        let session_id = create_payload["session"]["id"]
            .as_str()
            .expect("session id should be present")
            .to_string();

        let rename_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/terminal/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({ "title": "Renamed shell" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(rename_response.status(), StatusCode::OK);

        let thread_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/terminal/{session_id}/thread"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "topic": "Rust rewrite",
                            "pinned": true
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(thread_response.status(), StatusCode::OK);
        let thread_body = thread_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let thread_payload: Value =
            serde_json::from_slice(&thread_body).expect("thread payload should deserialize");
        assert_eq!(thread_payload["thread"]["topic"], "Rust rewrite");
        assert_eq!(thread_payload["thread"]["pinned"], true);

        let detect_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/terminal/{session_id}/detect-project"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(detect_response.status(), StatusCode::OK);
        let detect_body = detect_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let detect_payload: Value =
            serde_json::from_slice(&detect_body).expect("detect payload should deserialize");
        assert_eq!(
            detect_payload["projectPath"],
            repo_path.to_string_lossy().to_string()
        );

        let state_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/state?sessionId={session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(state_response.status(), StatusCode::OK);
        let state_body = state_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let state_payload: Value =
            serde_json::from_slice(&state_body).expect("state payload should deserialize");
        assert_eq!(
            state_payload["projectInfo"]["cwd"],
            repo_path.to_string_lossy().to_string()
        );

        let get_thread_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/terminal/{session_id}/thread"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(get_thread_response.status(), StatusCode::OK);
        let get_thread_body = get_thread_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let get_thread_payload: Value =
            serde_json::from_slice(&get_thread_body).expect("thread payload should deserialize");
        assert_eq!(
            get_thread_payload["thread"]["projectPath"],
            repo_path.to_string_lossy().to_string()
        );

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/terminal/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn settings_patch_round_trips_and_masks_groq_key() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-2", "conor");
        let app = app(state);

        let patch_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/settings")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "groqApiKey": "gsk_12345678901234567890",
                            "theme": "light",
                            "desktopAllowTerminalInput": true,
                            "recentFolders": ["C:\\repo-a"]
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(patch_response.status(), StatusCode::OK);

        let get_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/settings")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(get_response.status(), StatusCode::OK);

        let body = get_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: UserSettings =
            serde_json::from_slice(&body).expect("settings should deserialize");

        assert_eq!(payload.theme, "light");
        assert_eq!(payload.desktop_allow_terminal_input, Some(true));
        assert_eq!(payload.has_groq_api_key, true);
        assert_eq!(
            payload.groq_api_key.as_deref(),
            Some("********************7890")
        );
        assert_eq!(payload.recent_folders, Some(vec!["C:\\repo-a".to_string()]));
    }

    #[tokio::test]
    async fn bookmarks_and_notes_routes_support_crud() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-3", "conor");
        let app = app(state);

        let bookmarks_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bookmarks")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(bookmarks_response.status(), StatusCode::OK);

        let create_note_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/notes")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "title": "Todo",
                            "content": "Ship rust settings",
                            "category": "Work"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(create_note_response.status(), StatusCode::CREATED);

        let body = create_note_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("note payload should deserialize");
        let note_id = payload["note"]["id"]
            .as_str()
            .expect("note id should be a string");

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/notes/{note_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn filesystem_and_preview_routes_support_bootstrap_ui() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-4", "conor");
        let app = app(state);

        let folder_root = tempdir().expect("temp dir should create");
        let alpha_dir = folder_root.path().join("alpha");
        let hidden_dir = folder_root.path().join(".hidden");
        let file_path = folder_root.path().join("note.txt");
        fs::create_dir_all(&alpha_dir).expect("visible directory should create");
        fs::create_dir_all(&hidden_dir).expect("hidden directory should create");
        fs::write(&file_path, "hello").expect("file should write");

        let folder_path = folder_root.path().to_string_lossy().replace('\\', "/");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/fs/list?path={folder_path}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(response.status(), StatusCode::OK);

        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&body).expect("filesystem payload should deserialize");

        assert_eq!(payload["folders"], json!(["alpha"]));
        assert_eq!(
            payload["path"],
            Value::String(normalize_filesystem_path(folder_root.path()))
        );
        assert_eq!(
            payload["parent"],
            Value::String(normalize_filesystem_path(
                folder_root
                    .path()
                    .parent()
                    .expect("temp dir should have parent")
            ))
        );

        let preview_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/preview/active-ports")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(preview_response.status(), StatusCode::OK);

        let preview_body = preview_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let preview_payload: Value =
            serde_json::from_slice(&preview_body).expect("preview payload should deserialize");
        assert_eq!(preview_payload, json!({ "ports": [] }));
    }

    #[tokio::test]
    async fn terminal_detail_routes_return_bootstrap_payloads_for_live_sessions() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-5", "conor");
        let app = app(state);

        let working_root = tempdir().expect("temp dir should create");
        let project_dir = working_root.path().join("terminal-v4-test");
        fs::create_dir_all(&project_dir).expect("project dir should create");

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "cwd": project_dir.to_string_lossy().to_string()
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(create_response.status(), StatusCode::CREATED);

        let create_body = create_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let create_payload: Value =
            serde_json::from_slice(&create_body).expect("create payload should deserialize");
        let session_id = create_payload["session"]["id"]
            .as_str()
            .expect("session id should be a string")
            .to_string();

        let turns_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/terminal/{session_id}/turns"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(turns_response.status(), StatusCode::OK);

        let turns_body = turns_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let turns_payload: Value =
            serde_json::from_slice(&turns_body).expect("turns payload should deserialize");
        assert_eq!(turns_payload, json!({ "turns": [] }));

        let branches_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/terminal/{session_id}/git-branches"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(branches_response.status(), StatusCode::OK);

        let branches_body = branches_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let branches_payload: Value =
            serde_json::from_slice(&branches_body).expect("branches payload should deserialize");
        assert_eq!(
            branches_payload,
            json!({
                "branches": [],
                "currentBranch": Value::Null
            })
        );

        let topic_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/terminal/{session_id}/generate-topic"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(topic_response.status(), StatusCode::OK);

        let topic_body = topic_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let topic_payload: Value =
            serde_json::from_slice(&topic_body).expect("topic payload should deserialize");
        assert_eq!(topic_payload["topic"], json!("terminal-v4-test"));
        assert_eq!(topic_payload["thread"]["topic"], json!("terminal-v4-test"));
        assert_eq!(topic_payload["thread"]["topicAutoGenerated"], json!(true));

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/terminal/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn structured_session_routes_support_crud() {
        let provider = Arc::new(FakeStructuredProvider::new(false));
        let state = test_state_with_structured_provider(provider);
        let token = issue_access_token(&state.config().jwt_secret, "user-10", "conor");
        let app = app(state.clone());
        let workspace = state.config().data_dir.join("structured-workspace");
        fs::create_dir_all(&workspace).expect("structured workspace should exist");

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/structured/sessions")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "cwd": workspace.to_string_lossy().to_string(),
                            "provider": "claude",
                            "model": "sonnet",
                            "title": "Agent thread"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(create_response.status(), StatusCode::CREATED);

        let create_body = create_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let create_payload: Value =
            serde_json::from_slice(&create_body).expect("create payload should deserialize");
        let session_id = create_payload["id"]
            .as_str()
            .expect("structured session id should be a string")
            .to_string();
        assert!(session_id.starts_with("ss-"));
        assert_eq!(create_payload["provider"], "claude");
        assert_eq!(create_payload["model"], "sonnet");
        assert_eq!(create_payload["title"], "Agent thread");
        assert!(
            create_payload["thread"]["projectPath"]
                .as_str()
                .expect("project path should be a string")
                .ends_with("structured-workspace")
        );
        assert_eq!(create_payload["events"], json!([]));

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/structured/sessions")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = list_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let list_payload: Value =
            serde_json::from_slice(&list_body).expect("list payload should deserialize");
        assert_eq!(list_payload[0]["id"], session_id);
        assert_eq!(list_payload[0]["title"], "Agent thread");

        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/structured/sessions/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(get_response.status(), StatusCode::OK);

        let rename_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/structured/sessions/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({ "title": "Renamed agent" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(rename_response.status(), StatusCode::OK);
        let rename_body = rename_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let rename_payload: Value =
            serde_json::from_slice(&rename_body).expect("rename payload should deserialize");
        assert_eq!(rename_payload["title"], "Renamed agent");

        let thread_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/structured/sessions/{session_id}/thread"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "topic": "Review Rust rewrite",
                            "pinned": true,
                            "archived": false
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(thread_response.status(), StatusCode::OK);
        let thread_body = thread_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let thread_payload: Value =
            serde_json::from_slice(&thread_body).expect("thread payload should deserialize");
        assert_eq!(thread_payload["thread"]["topic"], "Review Rust rewrite");
        assert_eq!(thread_payload["thread"]["pinned"], true);

        let get_thread_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/structured/sessions/{session_id}/thread"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(get_thread_response.status(), StatusCode::OK);
        let get_thread_body = get_thread_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let get_thread_payload: Value =
            serde_json::from_slice(&get_thread_body).expect("get thread payload should deserialize");
        assert_eq!(get_thread_payload["thread"]["topic"], "Review Rust rewrite");
        assert_eq!(get_thread_payload["thread"]["pinned"], true);

        let delete_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/structured/sessions/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(delete_response.status(), StatusCode::OK);
        let delete_body = delete_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let delete_payload: Value =
            serde_json::from_slice(&delete_body).expect("delete payload should deserialize");
        assert_eq!(delete_payload, json!({ "status": "deleted" }));
    }

    #[tokio::test]
    async fn structured_message_routes_record_events_and_delegate_controls() {
        let provider = Arc::new(FakeStructuredProvider::new(true));
        let state = test_state_with_structured_provider(provider.clone());
        let token = issue_access_token(&state.config().jwt_secret, "user-11", "conor");
        let app = app(state.clone());
        let workspace = state.config().data_dir.join("structured-running");
        fs::create_dir_all(&workspace).expect("structured workspace should exist");

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/structured/sessions")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "cwd": workspace.to_string_lossy().to_string(),
                            "provider": "claude"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        let create_body = create_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let create_payload: Value =
            serde_json::from_slice(&create_body).expect("create payload should deserialize");
        let session_id = create_payload["id"]
            .as_str()
            .expect("structured session id should be a string")
            .to_string();

        let message_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{session_id}/message"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({ "text": "hello from rust" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(message_response.status(), StatusCode::ACCEPTED);

        sleep(Duration::from_millis(40)).await;

        let approve_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{session_id}/approve"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({ "approved": true }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(approve_response.status(), StatusCode::OK);

        let interrupt_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{session_id}/interrupt"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(interrupt_response.status(), StatusCode::OK);

        sleep(Duration::from_millis(40)).await;

        let get_response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/structured/sessions/{session_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(get_response.status(), StatusCode::OK);

        let get_body = get_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value =
            serde_json::from_slice(&get_body).expect("session payload should deserialize");
        let events = payload["events"]
            .as_array()
            .expect("events should be an array");
        assert!(events
            .iter()
            .any(|event| { event["type"] == "session_started" && event["provider"] == "claude" }));
        assert!(events.iter().any(|event| {
            event["type"] == "status" && event["status"] == "prompt:hello from rust"
        }));
        assert!(events
            .iter()
            .any(|event| { event["type"] == "status" && event["status"] == "approved" }));
        assert!(events
            .iter()
            .any(|event| { event["type"] == "session_ended" && event["reason"] == "interrupted" }));
        assert_eq!(provider.approval_hits(), 1);
        assert_eq!(provider.interrupt_hits(), 1);
    }

    fn test_state() -> ApiState {
        test_state_with_external_auth(None)
    }

    fn test_state_with_external_auth(
        external_auth: Option<Arc<dyn ExternalAuthProvider>>,
    ) -> ApiState {
        let temp_dir = tempdir().expect("temp dir should create");
        let config = AppConfig {
            data_dir: PathBuf::from(temp_dir.keep()),
            jwt_secret: "test-secret".to_string(),
            ..AppConfig::default()
        };
        ApiState::new_with_external_auth(config, external_auth).expect("state should initialize")
    }

    fn test_state_with_structured_provider(provider: Arc<dyn StructuredProvider>) -> ApiState {
        let temp_dir = tempdir().expect("temp dir should create");
        let config = AppConfig {
            data_dir: PathBuf::from(temp_dir.keep()),
            jwt_secret: "test-secret".to_string(),
            ..AppConfig::default()
        };
        let structured_manager =
            StructuredSessionManager::new_with_providers(config.clone(), vec![provider]);
        ApiState::new_with_services(config, None, structured_manager)
            .expect("state should initialize")
    }

    fn test_app() -> axum::Router {
        app(test_state())
    }

    fn external_user(
        id: &str,
        email: &str,
        display_name: Option<&str>,
        password: &str,
    ) -> ExternalAuthUser {
        ExternalAuthUser {
            id: id.to_string(),
            email: email.to_string(),
            password_hash: hash(password, DEFAULT_COST).expect("password should hash"),
            display_name: display_name.map(str::to_string),
            created_at: "2026-04-05T10:00:00Z".to_string(),
        }
    }

    fn write_terminal_session_fixture(
        state: &ApiState,
        user_id: &str,
        session_id: &str,
        payload: Value,
    ) {
        let sessions_dir = state
            .config()
            .data_dir
            .join("users")
            .join(user_id)
            .join("sessions");
        fs::create_dir_all(&sessions_dir).expect("sessions dir should exist");
        fs::write(
            sessions_dir.join(format!("{session_id}.json")),
            serde_json::to_vec_pretty(&payload).expect("fixture should serialize"),
        )
        .expect("session fixture should write");
    }

    struct FakeStructuredProvider {
        keep_running: bool,
        approval_hits: Arc<AtomicUsize>,
        interrupt_hits: Arc<AtomicUsize>,
    }

    impl FakeStructuredProvider {
        fn new(keep_running: bool) -> Self {
            Self {
                keep_running,
                approval_hits: Arc::new(AtomicUsize::new(0)),
                interrupt_hits: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn approval_hits(&self) -> usize {
            self.approval_hits.load(Ordering::SeqCst)
        }

        fn interrupt_hits(&self) -> usize {
            self.interrupt_hits.load(Ordering::SeqCst)
        }
    }

    impl StructuredProvider for FakeStructuredProvider {
        fn provider_id(&self) -> &'static str {
            "claude"
        }

        fn spawn(
            &self,
            options: StructuredSpawnOptions,
        ) -> Result<SpawnedStructuredProcess, String> {
            let (tx, rx) = mpsc::unbounded_channel();
            let sequence = Arc::new(AtomicUsize::new(0));
            let fake_session_id = format!("fake-{}", options.prompt.replace(' ', "-"));

            tx.send(StructuredSessionEvent::SessionStarted {
                ts: 1,
                seq: next_fake_seq(&sequence),
                session_id: fake_session_id.clone(),
                provider: "claude".to_string(),
            })
            .expect("fake structured start event should send");
            tx.send(StructuredSessionEvent::Status {
                ts: 2,
                seq: next_fake_seq(&sequence),
                status: format!("prompt:{}", options.prompt),
            })
            .expect("fake structured status event should send");

            if !self.keep_running {
                tx.send(StructuredSessionEvent::SessionEnded {
                    ts: 3,
                    seq: next_fake_seq(&sequence),
                    session_id: fake_session_id.clone(),
                    reason: "completed".to_string(),
                })
                .expect("fake structured end event should send");
            }

            Ok(SpawnedStructuredProcess {
                controller: Arc::new(FakeStructuredProcessController {
                    approval_hits: self.approval_hits.clone(),
                    interrupt_hits: self.interrupt_hits.clone(),
                    session_id: fake_session_id,
                    tx: Mutex::new(Some(tx)),
                    sequence,
                }),
                events: rx,
            })
        }
    }

    struct FakeStructuredProcessController {
        approval_hits: Arc<AtomicUsize>,
        interrupt_hits: Arc<AtomicUsize>,
        session_id: String,
        tx: Mutex<Option<mpsc::UnboundedSender<StructuredSessionEvent>>>,
        sequence: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl StructuredProcessController for FakeStructuredProcessController {
        async fn send_input(&self, _text: &str) -> Result<(), String> {
            Ok(())
        }

        async fn send_approval(&self, approved: bool) -> Result<(), String> {
            self.approval_hits.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.tx.lock().await.as_ref() {
                let _ = tx.send(StructuredSessionEvent::Status {
                    ts: 4,
                    seq: next_fake_seq(&self.sequence),
                    status: if approved {
                        "approved".to_string()
                    } else {
                        "rejected".to_string()
                    },
                });
            }
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), String> {
            self.interrupt_hits.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.tx.lock().await.take() {
                let _ = tx.send(StructuredSessionEvent::SessionEnded {
                    ts: 5,
                    seq: next_fake_seq(&self.sequence),
                    session_id: self.session_id.clone(),
                    reason: "interrupted".to_string(),
                });
            }
            Ok(())
        }

        async fn kill(&self) -> Result<(), String> {
            self.interrupt().await
        }
    }

    fn next_fake_seq(sequence: &AtomicUsize) -> i64 {
        sequence.fetch_add(1, Ordering::SeqCst) as i64 + 1
    }

    struct FakeExternalAuthProvider {
        users_by_id: HashMap<String, ExternalAuthUser>,
        identifier_hits: AtomicUsize,
        id_hits: AtomicUsize,
    }

    impl FakeExternalAuthProvider {
        fn new(users: Vec<ExternalAuthUser>) -> Self {
            Self {
                users_by_id: users
                    .into_iter()
                    .map(|user| (user.id.clone(), user))
                    .collect(),
                identifier_hits: AtomicUsize::new(0),
                id_hits: AtomicUsize::new(0),
            }
        }

        fn identifier_hits(&self) -> usize {
            self.identifier_hits.load(Ordering::SeqCst)
        }

        fn id_hits(&self) -> usize {
            self.id_hits.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ExternalAuthProvider for FakeExternalAuthProvider {
        async fn get_user_by_identifier(
            &self,
            identifier: &str,
        ) -> Result<Option<ExternalAuthUser>, String> {
            self.identifier_hits.fetch_add(1, Ordering::SeqCst);
            let normalized = identifier.to_lowercase();
            Ok(self
                .users_by_id
                .values()
                .find(|user| {
                    user.email.to_lowercase() == normalized
                        || user
                            .display_name
                            .as_deref()
                            .map(str::trim)
                            .map(str::to_lowercase)
                            .as_deref()
                            == Some(normalized.as_str())
                })
                .cloned())
        }

        async fn get_user_by_id(&self, user_id: &str) -> Result<Option<ExternalAuthUser>, String> {
            self.id_hits.fetch_add(1, Ordering::SeqCst);
            Ok(self.users_by_id.get(user_id).cloned())
        }
    }
}
