mod agent_browser;
mod agent_catalog;
mod agent_mcp;
mod agent_mcp_apps;
mod agent_runtime;
mod auth;
#[cfg(test)]
mod auth_protocol;
#[cfg(unix)]
mod auth_session_logout;
mod browser_runtime;
mod build_info;
mod collaboration;
mod device_relay;
mod external_auth;
mod file_transfers;
pub mod files;
mod followup_queue;
pub mod git;
mod local_testing;
mod native_history;
mod native_provider_events;
mod open_in_editor;
mod paired_environments;
pub mod passkey;
pub mod preview;
mod process_tree;
pub mod processes;
#[cfg(unix)]
pub mod provider_connections;
#[cfg(not(unix))]
#[path = "provider_connections_unavailable.rs"]
pub mod provider_connections;
mod provider_rewind;
mod remote_desktop;
mod remote_permissions;
mod remote_tunnels;
pub mod screenshots;
mod system_doctor;
mod telegram_gateway;
mod workspace_files;
// Board routes stay disabled until admission and receipt durability are safe.
#[cfg(test)]
#[allow(dead_code)]
mod workspace_board;
mod workspace_scripts;

#[cfg(test)]
mod feature_delivery_contract_tests;
#[cfg(test)]
mod file_rename_contract_tests;
#[cfg(test)]
mod rebuild_route_tests;
mod recall_index;
mod session_recordings;
mod session_search;
mod state;
#[cfg(test)]
mod static_frontend_route_tests;
mod structured;
mod structured_share;
mod system_rebuild;
pub mod system_stats;
mod terminal;
mod thread_lineage;
mod thread_order;
pub mod tmux;
pub mod transcribe;
pub mod turn_detector;
#[cfg(test)]
mod upload_contract_tests;
#[cfg(test)]
mod user_attachments_red_preview;
mod user_images;
#[cfg(test)]
mod utility_route_tests;
pub mod v4_agent;
pub mod vault;
#[cfg(unix)]
mod vault_admission;
pub mod webcontainer;
mod workspace;
mod workspace_activity;
mod workspace_browser;
mod workspace_git;
mod workspace_proposals;
mod workspace_pull_request;
mod workspace_rewind;
mod workspace_skills;
pub mod workspace_tasks;
mod worktree_setup;

#[cfg(test)]
use auth::issue_preview_token;
use auth::{require_auth, AuthenticatedUser};
use axum::body::Body;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{any, delete, get, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use state::{
    AppState, BookmarkUpdate, ChangePasswordResult, HistoryQuery, NoteUpdate, SettingsPatch,
};
use std::convert::Infallible;
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use structured::StructuredSessionManager;
use terminal::{TerminalCreateOptions, TerminalSubscriptionEvent, ThreadUpdate};
use terminal_v4_core::{HealthResponse, StructuredSessionSnapshot, SANDBOX_MODES};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;
use tower::ServiceExt as _;
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};

pub use state::AppState as ApiState;

pub fn start_services(state: &AppState) {
    workspace_browser::register_host(state);
    state.stats_collector().start_background_collection();
    device_relay::start(state);
    telegram_gateway::start_workers(state);
    tokio::task::spawn_blocking(|| {
        let removed = v4_agent::reap_leftover_execution_containers();
        if removed > 0 {
            tracing::info!(
                removed,
                "Removed leftover run_command containers from earlier runs"
            );
        }
    });
}

pub async fn shutdown_services(state: &AppState) {
    workspace_browser::shutdown(state).await;
    state.stats_collector().shutdown().await;
    device_relay::shutdown(state).await;
    remote_tunnels::shutdown(state);
    state.provider_connections().request_drain();
    let (_, structured, _, _, _) = tokio::join!(
        workspace_tasks::shutdown_workers(),
        async { state.structured_session_manager().shutdown().await },
        agent_mcp_apps::shutdown(&state.config().data_dir),
        agent_mcp::shutdown(&state.config().data_dir),
        async {
            state.terminal_manager().shutdown().await;
            session_recordings::shutdown(&state.config().data_dir).await;
        },
    );
    if let Err(error) = structured {
        tracing::warn!(%error,"Structured agent cleanup could not be confirmed; provider verifier remains available for retained cleanup");
    } else if !state.provider_connections().shutdown().await {
        tracing::warn!("Provider supervisor is still retaining original resources during shutdown");
    }
}

const PREVIEW_COOKIE_NAME: &str = "terminal_preview_token";

/// Maximum bytes buffered on a terminal WebSocket before dropping output and
/// suggesting a resync.  Mirrors the TypeScript backend's
/// `TERMINAL_WS_MAX_BUFFERED_BYTES` env-var (default 1 MB).
fn terminal_ws_max_buffered_bytes() -> usize {
    static CACHED: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        std::env::var("TERMINAL_WS_MAX_BUFFERED_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1_000_000)
    })
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

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

    #[cfg(unix)]
    let ownership_recovery_routes = structured::ownership_recovery::routes();
    #[cfg(not(unix))]
    let ownership_recovery_routes = Router::new();

    #[cfg(unix)]
    let input_recovery_routes = Router::new()
        .route(
            "/api/structured/input-watermark",
            get(supervised_input_watermark),
        )
        .route(
            "/api/structured/input-capabilities",
            get(supervised_input_capabilities),
        )
        .route(
            "/api/structured/input-receipts/{session}/{operation}",
            get(get_supervised_input_receipt),
        )
        .route(
            "/api/structured/sessions/{id}/input-receipts",
            get(list_supervised_input_receipts),
        )
        .route(
            "/api/structured/input-receipts",
            get(list_unresolved_input_receipts),
        )
        .route(
            "/api/structured/input-receipts/{session}/{operation}/review",
            post(review_supervised_input_receipt),
        );
    #[cfg(not(unix))]
    let input_recovery_routes = Router::new();

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    let supervised_input_routes = Router::new()
        .route(
            "/api/structured/sessions/{id}/input-capabilities",
            get(supervised_input_session_capabilities),
        )
        .route(
            "/api/structured/sessions/{id}/supervised-input",
            post(send_supervised_input),
        )
        .route(
            "/api/structured/sessions/{id}/input-operation",
            post(issue_supervised_input_operation),
        );
    #[cfg(not(all(unix, any(test, feature = "supervised-input-preview"))))]
    let supervised_input_routes = Router::new();

    let protected = Router::new()
        .merge(paired_environments::routes())
        .merge(device_relay::routes())
        .merge(remote_desktop::routes())
        .merge(workspace_browser::routes())
        .merge(collaboration::routes())
        .merge(agent_catalog::routes())
        .merge(provider_connections::routes())
        .merge(agent_mcp::routes())
        .merge(thread_lineage::routes())
        .merge(thread_order::routes())
        .merge(agent_mcp_apps::routes())
        .merge(agent_browser::routes())
        .merge(native_history::routes())
        .merge(workspace::routes())
        .merge(workspace_proposals::routes())
        .merge(workspace_skills::routes())
        .merge(workspace_git::routes())
        .merge(workspace_pull_request::routes())
        .merge(open_in_editor::routes())
        .merge(system_doctor::routes())
        .merge(workspace_files::routes())
        .merge(workspace_scripts::routes())
        .merge(telegram_gateway::routes())
        .merge(file_transfers::routes())
        .merge(session_recordings::routes())
        .merge(remote_tunnels::routes())
        .merge(workspace_rewind::routes())
        .merge(session_search::routes())
        .merge(workspace_tasks::routes())
        .merge(structured::start_requests::routes())
        .merge(ownership_recovery_routes)
        .merge(supervised_input_routes)
        .merge(input_recovery_routes)
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/change-password", post(change_password))
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
            "/api/structured/sessions/{id}/selection",
            axum::routing::patch(update_structured_selection),
        )
        .route(
            "/api/structured/sessions/{id}/access",
            axum::routing::patch(update_structured_access),
        )
        .route("/api/structured/usage", get(structured_usage))
        .route(
            "/api/structured/sessions/{id}/message",
            post(send_structured_message),
        )
        .route(
            "/api/structured/sessions/{id}/input",
            post(send_structured_input),
        )
        .merge(structured::queue::routes())
        .merge(structured_share::routes())
        .merge(structured::context::routes())
        .merge(structured::turn_changes::routes())
        .merge(user_images::routes())
        .route(
            "/api/structured/sessions/{id}/compact",
            post(compact_structured_session),
        )
        .route(
            "/api/structured/sessions/{id}/requests/{requestId}",
            get(get_structured_request_receipt),
        )
        .route(
            "/api/structured/sessions/{id}/artifacts/{artifactId}/{format}",
            get(get_structured_artifact),
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
            "/api/structured/sessions/{id}/private-output/preview",
            post(preview_private_output),
        )
        .route(
            "/api/structured/sessions/{id}/private-output/approve",
            post(approve_private_output),
        )
        .route(
            "/api/structured/sessions/{id}/approval-capability",
            get(get_codex_approval_capability),
        )
        .route(
            "/api/structured/sessions/{id}/approval-claims/{approval_id}/reserve",
            post(reserve_codex_approval),
        )
        .route(
            "/api/structured/sessions/{id}/approval-claims/{approval_id}/review",
            post(review_codex_approval_claim),
        )
        .route(
            "/api/terminal",
            get(list_terminal_sessions).post(create_terminal_session),
        )
        .route(
            "/api/terminal/{id}/history",
            get(get_terminal_session_history),
        )
        .route("/api/terminal/{id}/stream", get(stream_terminal_session))
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
            "/api/terminal/{id}/project-info",
            get(get_terminal_project_info),
        )
        .route("/api/terminal/{id}/git-stats", get(get_terminal_git_stats))
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
        .route("/api/fs/list", get(list_filesystem_folders))
        .route("/api/settings", get(get_settings).patch(update_settings))
        .route("/api/system/preview-config", get(get_preview_config))
        .route("/api/preview/session", post(create_preview_session))
        .route(
            "/api/preview/resource-auth",
            post(preview::resource_auth::issue_resource_auth),
        )
        .route("/api/bookmarks", get(list_bookmarks).post(create_bookmark))
        .route(
            "/api/bookmarks/{id}",
            put(update_bookmark).delete(delete_bookmark),
        )
        .route(
            "/api/mobile-keyboard-debug",
            get(list_mobile_keyboard_debug_entries)
                .post(ingest_mobile_keyboard_debug_entry)
                .delete(clear_mobile_keyboard_debug_entries),
        )
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/{id}", put(update_note).delete(delete_note))
        // Vault routes
        .route("/api/vault", get(list_vault_keys).post(add_vault_key))
        .route("/api/vault/{id}/reveal", get(reveal_vault_key))
        .route("/api/vault/{id}", delete(delete_vault_key))
        // File routes
        .route("/api/files/list", get(list_files))
        .route("/api/files/mkdir", post(mkdir))
        .route(
            "/api/files/upload",
            post(upload_file).layer(axum::extract::DefaultBodyLimit::max(
                100 * 1024 * 1024 + 65_536,
            )),
        )
        .route("/api/files/download", get(download_file))
        .route("/api/files/delete", delete(delete_file).post(delete_file))
        .route("/api/files/rename", post(rename_file))
        .route("/api/files/unzip", post(unzip_file))
        .route(
            "/api/files/screenshot",
            post(upload_screenshot).layer(axum::extract::DefaultBodyLimit::max(
                10 * 1024 * 1024 + 65_536,
            )),
        )
        .route(
            "/api/files/attachment",
            post(upload_attachment).layer(axum::extract::DefaultBodyLimit::max(
                ATTACHMENT_LIMIT + 65_536,
            )),
        )
        .route("/api/fs/download", get(download_directory))
        .route("/api/preview", get(get_preview_file))
        // Passkey routes (authed)
        .route(
            "/api/auth/passkey/register/begin",
            post(passkey_register_begin),
        )
        .route(
            "/api/auth/passkey/register/complete",
            post(passkey_register_complete),
        )
        .route(
            "/api/auth/passkey/credentials",
            get(passkey_list_credentials),
        )
        .route(
            "/api/auth/passkey/credentials/{id}",
            delete(passkey_delete_credential),
        )
        // Preview routes
        .route(
            "/api/preview/{port}/cookies",
            get(get_preview_cookies).delete(clear_preview_cookies),
        )
        .route(
            "/api/preview/{port}/proxy-logs",
            get(get_preview_proxy_logs).delete(clear_preview_proxy_logs),
        )
        .route(
            "/api/preview/{port}/logs",
            get(get_preview_logs)
                .post(ingest_preview_log)
                .delete(clear_preview_logs),
        )
        .route("/api/preview/{port}/log-stream", get(stream_preview_logs))
        .route(
            "/api/preview/{port}/websockets",
            get(get_preview_websockets).delete(clear_preview_websockets),
        )
        .route(
            "/api/preview/{port}/storage",
            get(get_preview_storage).post(update_preview_storage),
        )
        .route("/api/preview/{port}/evaluate", post(evaluate_preview))
        .route(
            "/api/preview/{port}/client-operation",
            post(authorize_preview_client_operation),
        )
        .route(
            "/api/preview/{port}/performance",
            get(get_preview_performance)
                .post(ingest_preview_performance)
                .delete(clear_preview_performance),
        )
        .route("/api/preview/logs", get(list_preview_log_ports))
        .route(
            "/api/preview/active-ports",
            get(get_active_preview_ports_scan),
        )
        .route("/api/proxy-external", get(proxy_external_url))
        .route(
            "/api/preview/external/logs",
            get(get_external_logs)
                .post(ingest_external_log)
                .delete(clear_external_logs),
        )
        // Dev proxy routes
        .route("/api/dev-proxy/{port}", get(dev_proxy_handler))
        .route("/api/dev-proxy-ws/{port}", any(dev_proxy_ws_handler_root))
        .route(
            "/api/dev-proxy-ws/{port}/{*rest}",
            any(dev_proxy_ws_handler_path),
        )
        .route(
            "/api/dev-proxy/{port}/{*rest}",
            get(dev_proxy_handler_path)
                .post(dev_proxy_handler_path)
                .put(dev_proxy_handler_path)
                .delete(dev_proxy_handler_path),
        )
        // Process routes
        .route("/api/processes", get(list_processes))
        .route("/api/processes/start", post(start_process))
        .route("/api/processes/stop", post(stop_process))
        .route(
            "/api/process-logs/{pid}",
            get(get_process_logs).delete(clear_process_logs),
        )
        .route("/api/process-logs", get(list_all_processes))
        .route(
            "/api/preview/{port}/process-logs",
            get(get_process_logs_by_port),
        )
        // WebContainer
        .route("/api/webcontainer/files", get(get_webcontainer_files))
        // Transcription
        .route("/api/transcribe/health", get(transcribe_health))
        .route(
            "/api/transcribe",
            post(transcribe_audio).layer(axum::extract::DefaultBodyLimit::max(
                25 * 1024 * 1024 + 65_536,
            )),
        )
        // Screenshots
        .route(
            "/api/preview/{port}/screenshot",
            post(take_preview_screenshot),
        )
        .route(
            "/api/preview/{port}/screenshot/element",
            post(take_element_screenshot),
        )
        .route(
            "/api/preview/{port}/recording/start",
            post(start_preview_recording),
        )
        .route(
            "/api/preview/recording/{recording_id}/stop",
            post(stop_preview_recording),
        )
        .route("/api/preview/screenshots", get(list_screenshots_handler))
        .route(
            "/api/preview/screenshots/{filename}",
            get(get_screenshot_handler).delete(delete_screenshot_handler),
        )
        // System stats routes
        .route("/api/system/stats", get(get_system_stats))
        .route("/api/system/stats/history", get(get_stats_history))
        .route("/api/system/rebuild", post(trigger_rebuild))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let router = Router::new()
        .merge(workspace_browser::public_routes())
        .merge(paired_environments::public_routes())
        .merge(device_relay::public_routes())
        .merge(collaboration::public_routes())
        .merge(structured_share::public_routes())
        .merge(remote_tunnels::public_routes())
        .route("/api/health", get(health))
        .route("/api/client-build", get(client_build))
        .route("/api/build-info", get(build_info_route))
        .route("/api/auth/register", post(register_disabled))
        .route("/api/auth/login", post(login))
        .route("/api/auth/mode", get(local_testing::mode))
        .route("/api/auth/local-testing", post(local_testing::enter))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/latency/ws", get(connect_latency_ws))
        .route("/preview/{port}", any(preview_proxy_root))
        .route("/preview/{port}/", any(preview_proxy_root))
        .route("/preview/{port}/{*rest}", any(preview_proxy_path))
        .route(
            "/api/structured/sessions/{id}/ws",
            get(connect_structured_ws),
        )
        .route(
            "/api/auth/passkey/authenticate/begin",
            post(passkey_auth_begin),
        )
        .route(
            "/api/auth/passkey/authenticate/complete",
            post(passkey_auth_complete),
        )
        .route(
            "/api/preview/{port}/performance/stream",
            get(stream_preview_performance),
        )
        .route("/api/terminal/{id}/ws", get(connect_terminal_ws))
        .merge(protected)
        .with_state(state.clone());

    // Serve frontend static files with SPA fallback
    let frontend_dir = resolve_frontend_dir(&state.config().data_dir);

    let router = if frontend_dir.exists() {
        let fd = frontend_dir.clone();
        let spa_fallback = tower::service_fn(move |request: axum::extract::Request| {
            let fd = fd.clone();
            async move {
                let path = request.uri().path();

                // API routes return proper 404 JSON (shouldn't normally reach here
                // since API routes are registered above, but just in case)
                if path.starts_with("/api/") {
                    return Ok(axum::response::Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(
                            r#"{"error":"Not Found","message":"API route not found"}"#,
                        ))
                        .unwrap());
                }

                // Static assets with hashes should NOT fallback to index.html
                // They're immutable - if missing, they're truly missing (stale cache)
                if path.starts_with("/assets/") {
                    return Ok(axum::response::Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(
                            r#"{"error":"Not Found","message":"Asset not found - please refresh the page"}"#,
                        ))
                        .unwrap());
                }

                // SPA fallback: serve index.html with no-cache headers
                match tokio::fs::read(fd.join("index.html")).await {
                    Ok(contents) => Ok(axum::response::Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/html")
                        .header("cache-control", "no-cache, no-store, must-revalidate")
                        .header("pragma", "no-cache")
                        .header("expires", "0")
                        .body(axum::body::Body::from(contents))
                        .unwrap()),
                    Err(_) => Ok(axum::response::Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(axum::body::Body::from("index.html not found"))
                        .unwrap()),
                }
            }
        });
        let runner_document = spa_fallback.clone();
        let serve_dir =
            tower_http::services::ServeDir::new(&frontend_dir).not_found_service(spa_fallback);
        // Wrap the static file service with cache-control middleware
        let static_handler = get(|request: axum::extract::Request| async move {
            let path = request.uri().path().to_string();
            let is_runner = matches!(path.as_str(), "/webcontainer" | "/webcontainer/");
            let mut response = if is_runner {
                runner_document.oneshot(request).await.into_response()
            } else {
                serve_dir.oneshot(request).await.into_response()
            };
            let is_html = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/html"));
            // HTML reached through a directory or SPA fallback must never be immutable.
            if is_html || path.ends_with(".html") || path == "/" {
                let headers = response.headers_mut();
                headers.insert(
                    "cache-control",
                    "no-cache, no-store, must-revalidate".parse().unwrap(),
                );
                headers.insert("pragma", "no-cache".parse().unwrap());
                headers.insert("expires", "0".parse().unwrap());
            } else if response.status().is_success() {
                // JS/CSS/assets with hashes: cache for 1 year
                let headers = response.headers_mut();
                headers.insert(
                    "cache-control",
                    "public, max-age=31536000, immutable".parse().unwrap(),
                );
            }
            if is_runner && response.status().is_success() && is_html {
                let headers = response.headers_mut();
                headers.insert("cross-origin-opener-policy", "same-origin".parse().unwrap());
                headers.insert(
                    "cross-origin-embedder-policy",
                    "require-corp".parse().unwrap(),
                );
                headers.insert("cache-control", "no-store".parse().unwrap());
                headers.insert(
                    "referrer-policy",
                    "strict-origin-when-cross-origin".parse().unwrap(),
                );
                headers.insert(
                    "content-security-policy",
                    "frame-ancestors 'none'".parse().unwrap(),
                );
            }
            response
        });
        router.fallback(static_handler)
    } else {
        router
    };

    router
        .layer(middleware::from_fn(remote_workspace_cache_policy))
        .layer(middleware::from_fn_with_state(
            state,
            preview_host_middleware,
        ))
        .layer(cors)
}

async fn remote_workspace_cache_policy(
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let private = request.uri().path() == "/api/structured/start-requests"
        || request
            .uri()
            .path()
            .starts_with("/api/structured/start-requests/")
        || request.uri().path() == "/api/structured/ownership"
        || request.uri().path() == "/api/structured/owner-cleanup"
        || request
            .uri()
            .path()
            .starts_with("/api/structured/owner-cleanup/")
        || request
            .uri()
            .path()
            .starts_with("/api/structured/ownership/")
        || matches!(
            request
                .uri()
                .path()
                .strip_prefix("/api/")
                .and_then(|path| path.split('/').next()),
            Some(
                "transfers"
                    | "recordings"
                    | "collaboration"
                    | "desktop"
                    | "workspace-browser"
                    | "tunnels"
                    | "relay"
                    | "environments"
            )
        );
    let mut response = next.run(request).await;
    if private {
        response.headers_mut().insert(
            "cache-control",
            axum::http::HeaderValue::from_static("private, no-store"),
        );
    }
    response
}

fn resolve_frontend_dir(data_dir: &FsPath) -> PathBuf {
    let configured_dir = std::env::var_os("TERMINAL_V4_FRONTEND_DIR").map(PathBuf::from);
    resolve_frontend_dir_with_current_dir(
        data_dir,
        std::env::current_dir().ok().as_deref(),
        configured_dir.as_deref(),
    )
}

fn resolve_frontend_dir_with_current_dir(
    data_dir: &FsPath,
    current_dir: Option<&FsPath>,
    configured_dir: Option<&FsPath>,
) -> PathBuf {
    if let Some(directory) = configured_dir {
        return directory.to_path_buf();
    }
    let data_relative_frontend_dir = data_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("frontend").join("dist"));
    let repo_frontend_dir = current_dir.and_then(find_frontend_dist_from_ancestors);
    let fallback_frontend_dir = PathBuf::from("frontend").join("dist");

    [data_relative_frontend_dir, repo_frontend_dir]
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .unwrap_or(fallback_frontend_dir)
}

fn find_frontend_dist_from_ancestors(start_dir: &FsPath) -> Option<PathBuf> {
    start_dir
        .ancestors()
        .map(|dir| dir.join("frontend").join("dist"))
        .find(|path| path.exists())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse::ok())
}

async fn build_info_route(State(state): State<AppState>) -> axum::response::Response {
    let info = build_info::build_info(
        &resolve_frontend_dir(&state.config().data_dir),
        workspace_tasks::WORKER_PROTOCOL,
    );
    (
        [(
            axum::http::header::CACHE_CONTROL,
            "no-cache, no-store, must-revalidate",
        )],
        Json(info),
    )
        .into_response()
}

async fn client_build(State(state): State<AppState>) -> axum::response::Response {
    let no_cache = [
        (
            axum::http::header::CACHE_CONTROL,
            "no-cache, no-store, must-revalidate",
        ),
        (axum::http::header::PRAGMA, "no-cache"),
        (axum::http::header::EXPIRES, "0"),
    ];
    match client_build_info(&resolve_frontend_dir(&state.config().data_dir)) {
        Ok(info) => (no_cache, Json(info)).into_response(),
        Err(error) => (no_cache, error).into_response(),
    }
}

fn client_build_info(frontend_dir: &FsPath) -> Result<Value, ApiError> {
    let index_path = frontend_dir.join("index.html");
    let html = std::fs::read_to_string(&index_path).map_err(|_| ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: "Client build unavailable".to_string(),
    })?;
    let index_mtime_ms = std::fs::metadata(&index_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64);
    let (main_script, main_stylesheet) = client_build_assets(&html);
    let build_id = main_script
        .clone()
        .or_else(|| index_mtime_ms.map(|ms| ms.to_string()))
        .unwrap_or_default();
    let checked_at = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as u64;

    Ok(json!({
        "buildId": build_id,
        "mainScript": main_script,
        "mainStylesheet": main_stylesheet,
        "indexMtimeMs": index_mtime_ms,
        "checkedAt": checked_at,
    }))
}

fn client_build_assets(index_html: &str) -> (Option<String>, Option<String>) {
    let main_script =
        regex_lite::Regex::new(r#"<script\b[^>]*\bsrc="([^"]*/assets/index-[^"]+\.js)""#)
            .expect("static client script expression");
    let main_stylesheet =
        regex_lite::Regex::new(r#"<link\b[^>]*\bhref="([^"]*/assets/index-[^"]+\.css)""#)
            .expect("static client stylesheet expression");
    let first_capture = |expression: &regex_lite::Regex| {
        expression
            .captures(index_html)
            .map(|captures| captures[1].to_string())
    };
    (first_capture(&main_script), first_capture(&main_stylesheet))
}

async fn preview_host_middleware(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let Some(port) = preview_subdomain_port(request.headers()) else {
        return next.run(request).await;
    };

    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let (mut parts, body) = request.into_parts();
    let ws = WebSocketUpgrade::from_request_parts(&mut parts, &state).await;
    let request = axum::extract::Request::from_parts(parts, body);

    match preview_subdomain_proxy_inner(state, port, path, request, ws).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
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
    authority: Option<Extension<crate::auth::LocalAuthority>>,
) -> Result<axum::response::Response, ApiError> {
    let authority = authority
        .map(|Extension(value)| value)
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "A valid local session is required to sign out".into(),
        })?;
    let session_scoped = authority.auth_protocol() == 1;
    #[cfg(unix)]
    let manager = state.structured_session_manager();
    #[cfg(unix)]
    let coordinated = manager.owner_cleanup_enabled();
    #[cfg(not(unix))]
    let coordinated = false;
    let logout_state = state.clone();
    let logout_owner = user.user_id.clone();
    #[cfg(unix)]
    let status_owner = logout_owner.clone();
    let revoked = tokio::task::spawn_blocking(move || {
        logout_state.logout_user_authorized(&logout_owner, &authority)
    })
    .await
    .map_err(|_| ApiError::internal("Logout worker unavailable"))?
    .map_err(ApiError::internal)?;
    if !revoked {
        return Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "The session changed before sign out".into(),
        });
    }
    if session_scoped {
        return Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response());
    }
    tokio::spawn(async move {
        workspace_browser::close_owner(&state, &user.user_id).await;
        tokio::join!(
            async {
                if !coordinated {
                    if let Err(error) = state.structured_session_manager().close_owner(&user.user_id).await {
                        tracing::warn!(%error,"Structured owner cleanup could not be confirmed during logout");
                    }
                }
            },
            agent_mcp_apps::close_owner(&state.config().data_dir, &user.user_id),
            agent_mcp::close_owner(&state.config().data_dir, &user.user_id),
        );
    }).await.map_err(|_| ApiError::internal("Owner cleanup worker stopped"))?;
    #[cfg(unix)]
    if coordinated {
        let pending =
            tokio::task::spawn_blocking(move || manager.owner_cleanup_status(&status_owner))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .is_none_or(|status| status["state"] != "complete");
        return Ok((
            if pending { StatusCode::ACCEPTED } else { StatusCode::OK },
            [(axum::http::header::SET_COOKIE, expired_preview_cookie())],
            Json(json!({"success":true,"cleanup":{"state":if pending { "pending" } else { "complete" }}})),
        ).into_response());
    }
    Ok((
        [(axum::http::header::SET_COOKIE, expired_preview_cookie())],
        Json(json!({ "success": true })),
    )
        .into_response())
}

async fn create_preview_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let access = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "A direct owner login is required to create a preview session".into(),
        })?;
    let owner = crate::auth::authenticate_local_token(&state, access)
        .ok()
        .filter(|owner| owner.user_id == user.user_id)
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "A direct owner login is required to create a preview session".into(),
        })?;
    let _user = owner;
    let token = crate::auth::preview_token_for_access(&state, access).map_err(|_| ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "The owner login is no longer valid".into(),
    })?;
    Ok((
        [(
            axum::http::header::SET_COOKIE,
            preview_cookie_header(&token),
        )],
        Json(json!({ "success": true })),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordInput {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<ChangePasswordInput>,
) -> Result<Json<Value>, ApiError> {
    validate_string(&input.current_password, 1, 4_096, "currentPassword")?;
    validate_string(&input.new_password, 6, 4_096, "newPassword")?;

    match state
        .change_password(&user, &input.current_password, &input.new_password)
        .map_err(ApiError::internal)?
    {
        ChangePasswordResult::Changed => Ok(Json(json!({ "success": true }))),
        ChangePasswordResult::InvalidCurrentPassword => Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Current password is incorrect".to_string(),
        }),
        ChangePasswordResult::ExternallyManaged => Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Password changes are managed by the external auth provider".to_string(),
        }),
        ChangePasswordResult::LocalTesting => Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: "Testing accounts use only a username and do not have a password".into(),
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuredSessionCreateInput {
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    service_tier: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuredMessageInput {
    text: String,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuredInputWrite {
    text: String,
    fallback_to_message: Option<bool>,
    request_id: Option<String>,
    delivery_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuredApprovalInput {
    approved: bool,
    approval_id: Option<String>,
    reservation_id: Option<String>,
    reservation_token: Option<String>,
    /// Answers to an agent's questions, keyed by question id.
    answers: Option<Value>,
    /// Also allow this kind of action for the rest of the conversation.
    #[serde(default)]
    for_session: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateOutputPreviewInput {
    approval_id: String,
    action_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateOutputDecisionInput {
    approval_id: String,
    action_id: String,
    preview_token: String,
}

#[derive(Debug, Deserialize)]
struct StructuredRenameInput {
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuredSelectionInput {
    model: String,
    reasoning: Option<String>,
    #[serde(default, deserialize_with = "deserialize_service_tier_update")]
    service_tier: Option<Option<String>>,
}

fn deserialize_service_tier_update<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

async fn create_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<StructuredSessionCreateInput>,
) -> Result<(StatusCode, Json<StructuredSessionSnapshot>), ApiError> {
    validate_string(&input.cwd, 1, 4096, "cwd")?;
    if let Some(provider) = &input.provider {
        #[cfg(unix)]
        let saved_profile = v4_agent::profile::Binding::parse(provider).is_some();
        #[cfg(not(unix))]
        let saved_profile = false;
        if !saved_profile {
            validate_string(provider, 1, 80, "provider")?;
        }
    }
    if let Some(model) = &input.model {
        validate_string(model, 1, 200, "model")?;
    }
    if let Some(title) = &input.title {
        validate_string(title, 1, 80, "title")?;
    }

    if let Some(reasoning) = &input.reasoning {
        validate_string(reasoning, 1, 40, "reasoning")?;
    }
    let manager = state.structured_session_manager();
    let result = if input.reasoning.is_some() || input.service_tier.is_some() {
        manager
            .create_with_options(
                &user.user_id,
                &input.cwd,
                input.provider.as_deref(),
                input.model.as_deref(),
                input.reasoning.as_deref(),
                input.service_tier.as_deref(),
                input.title.as_deref(),
            )
            .await
    } else {
        manager
            .create_session(
                &user.user_id,
                &input.cwd,
                input.provider.as_deref(),
                input.model.as_deref(),
                input.title.as_deref(),
            )
            .await
    };
    let session = result.map_err(|message| ApiError {
        status: StatusCode::BAD_REQUEST,
        message,
    })?;
    Ok((StatusCode::CREATED, Json(session)))
}

#[derive(Debug, Default, Deserialize)]
struct StructuredSessionListQuery {
    view: Option<String>,
}

async fn list_structured_sessions(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    method: axum::http::Method,
    Query(query): Query<StructuredSessionListQuery>,
) -> Result<Json<Value>, ApiError> {
    let manager = state.structured_session_manager();
    let inventory = match query.view.as_deref() {
        Some("inventory") => true,
        None | Some("") => false,
        Some(_) => return Err(ApiError::bad_request("Unknown structured session view")),
    };
    manager
        .list_sessions_authorized(
            &user.user_id,
            inventory,
            &state,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            method.as_str(),
        )
        .await
        .map(Json)
        .map_err(structured_read_error)
}

async fn get_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    method: axum::http::Method,
    Path(session_id): Path<String>,
) -> Result<Json<StructuredSessionSnapshot>, ApiError> {
    let Some(session) = state
        .structured_session_manager()
        .get_session_authorized(
            &user.user_id,
            &session_id,
            &state,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            method.as_str(),
        )
        .await
        .map_err(structured_read_error)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };
    Ok(Json(session))
}

fn structured_read_error(error: structured::StructuredControlError) -> ApiError {
    let status = match error.code {
        "unauthorized" => StatusCode::UNAUTHORIZED,
        "unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    ApiError {
        status,
        message: error.message,
    }
}

async fn rename_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(session_id): Path<String>,
    Json(input): Json<StructuredRenameInput>,
) -> Result<Json<StructuredSessionSnapshot>, ApiError> {
    validate_string(&input.title, 1, 80, "title")?;
    let Some(session) = state
        .structured_session_manager()
        .rename_session_authorized(
            &user.user_id,
            &session_id,
            &input.title,
            &state,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
        )
        .await
        .map_err(|error| match error.code {
            "unauthorized" => ApiError {
                status: StatusCode::UNAUTHORIZED,
                message: error.message,
            },
            "unavailable" => ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: error.message,
            },
            "conflict" => ApiError {
                status: StatusCode::CONFLICT,
                message: error.message,
            },
            _ => ApiError::internal(error.message),
        })?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };

    Ok(Json(session))
}
async fn update_structured_selection(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<StructuredSelectionInput>,
) -> Result<Json<StructuredSessionSnapshot>, ApiError> {
    state
        .structured_session_manager()
        .update_codex_options(
            &user.user_id,
            &session_id,
            &input.model,
            input.reasoning.as_deref(),
            input.service_tier.as_ref().map(|tier| tier.as_deref()),
        )
        .await
        .map(Json)
        .map_err(structured_control_error)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredAccessInput {
    mode: String,
}

async fn structured_usage(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let threads = state
        .structured_session_manager()
        .usage_summary(&user.user_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "threads": threads })))
}

async fn update_structured_access(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
    Json(input): Json<StructuredAccessInput>,
) -> Result<Json<StructuredSessionSnapshot>, ApiError> {
    state
        .structured_session_manager()
        .update_access_mode(&user.user_id, &session_id, &input.mode)
        .await
        .map(Json)
        .map_err(structured_control_error)
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
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(session_id): Path<String>,
    Json(input): Json<ThreadUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    if input
        .snooze_for_seconds
        .is_some_and(|seconds| !(60..=2_592_000).contains(&seconds))
    {
        return Err(ApiError::bad_request(
            "Snooze must be between one minute and 30 days",
        ));
    }
    if input.wake_snooze == Some(true) && input.snooze_for_seconds.is_some() {
        return Err(ApiError::bad_request("Choose either snooze or wake"));
    }
    let Some(thread) = state
        .structured_session_manager()
        .update_thread_authorized(
            &user.user_id,
            &session_id,
            structured::StructuredThreadUpdate {
                topic: input.topic,
                topic_auto_generated: input.topic_auto_generated,
                pinned: input.pinned,
                archived: input.archived,
                project_path: input.project_path,
                snooze_for_seconds: input.snooze_for_seconds,
                wake_snooze: input.wake_snooze.unwrap_or(false),
                settled: input.settled,
            },
            &state,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
        )
        .await
        .map_err(|error| {
            if error.code == "unauthorized" {
                ApiError {
                    status: StatusCode::UNAUTHORIZED,
                    message: error.message,
                }
            } else if error.code == "unavailable" {
                ApiError {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    message: error.message,
                }
            } else if error.code == "conflict"
                || matches!(
                    error.message.as_str(),
                    "Resolve pending requests or recovery before snoozing this thread"
                        | "Finish or resolve this thread's work before settling it"
                        | "Settle this thread without another lifecycle change"
                        | "Settlement is available only for V4 conversations"
                        | "Settlement is unavailable on this server"
                )
            {
                ApiError {
                    status: StatusCode::CONFLICT,
                    message: error.message,
                }
            } else {
                ApiError::internal(error.message)
            }
        })?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".to_string(),
        });
    };

    Ok(Json(
        json!({ "thread": thread, "threadLifecycleVersion": 1, "threadSettlementVersion": 1 }),
    ))
}

fn structured_control_error(error: structured::StructuredControlError) -> ApiError {
    ApiError {
        status: match error.code {
            "not_found" => StatusCode::NOT_FOUND,
            "invalid" => StatusCode::BAD_REQUEST,
            "conflict" => StatusCode::CONFLICT,
            "gone" => StatusCode::GONE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        },
        message: error.message,
    }
}
async fn send_structured_message(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(input): Json<StructuredMessageInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.text, 1, 100_000, "text")?;
    let receipt = state
        .structured_session_manager()
        .submit_message_with_paired(
            &user.user_id,
            &id,
            &input.text,
            input.request_id.as_deref(),
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            &state,
        )
        .await
        .map_err(structured_control_error)?;
    Ok((StatusCode::ACCEPTED, Json(json!(receipt))))
}
async fn send_structured_input(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(input): Json<StructuredInputWrite>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.text, 1, 100_000, "text")?;
    let manager = state.structured_session_manager();
    let snapshot = manager
        .get_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".into(),
        })?;
    if matches!(snapshot.runtime.as_deref(), Some("v4" | "codex")) {
        if input.fallback_to_message != Some(true) {
            return Err(ApiError {
                status: StatusCode::CONFLICT,
                message: "V4 conversation input requires an accepted message request".into(),
            });
        }
        let receipt = manager
            .submit_message_with_paired(
                &user.user_id,
                &id,
                &input.text,
                input.request_id.as_deref(),
                authority.as_ref().map(|Extension(value)| value),
                paired.as_ref().map(|Extension(value)| value),
                &state,
            )
            .await
            .map_err(structured_control_error)?;
        return Ok((StatusCode::ACCEPTED, Json(json!(receipt))));
    }
    let result = manager
        .send_input_with_authority(
            &user.user_id,
            &id,
            &input.text,
            input.fallback_to_message.unwrap_or(false),
            input.request_id.as_deref(),
            input.delivery_token.as_deref(),
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            Some(&state),
        )
        .await;
    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    if state.supervised_input_enabled() && input.delivery_token.is_some() {
        return match result {
            Ok(()) => Ok((
                StatusCode::ACCEPTED,
                Json(
                    json!({"status":"accepted", "outcome":"delivered", "requestId": input.request_id}),
                ),
            )),
            Err(message) => Ok((
                StatusCode::CONFLICT,
                Json(
                    json!({"error":message.message, "outcome":"uncertain", "requestId": input.request_id}),
                ),
            )),
        };
    }
    if let Err(error) = result {
        if error.uncertain {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({"error": error.message, "outcome": "uncertain"})),
            ));
        }
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: error.message,
        });
    }
    Ok((StatusCode::ACCEPTED, Json(json!({"status":"accepted"}))))
}

#[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
async fn send_supervised_input(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(id): Path<String>,
    Json(input): Json<StructuredInputWrite>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !state.supervised_input_enabled()
        || input.delivery_token.is_none()
        || input.request_id.is_none()
        || input.fallback_to_message != Some(false)
        || authority.is_none()
    {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: "A supervised raw input request and token are required".into(),
        });
    }
    send_structured_input(
        State(state),
        Extension(user),
        authority,
        None,
        Path(id),
        Json(input),
    )
    .await
}

#[cfg(unix)]
async fn require_input_recovery(state: &AppState, local: bool) -> Result<(), ApiError> {
    if !local {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Input recovery unavailable".into(),
        });
    }
    let state = state.clone();
    let installed = tokio::task::spawn_blocking(move || state.input_installation_active())
        .await
        .map_err(|_| ApiError::internal("Input recovery unavailable"))?
        .map_err(ApiError::internal)?;
    if !installed {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Input recovery unavailable".into(),
        });
    }
    Ok(())
}

#[cfg(unix)]
async fn supervised_input_capabilities(
    State(state): State<AppState>,
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<Json<Value>, ApiError> {
    if authority.is_none() {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Supervised input unavailable".into(),
        });
    }
    require_input_recovery(&state, authority.is_some()).await?;
    #[cfg(any(test, feature = "supervised-input-preview"))]
    let enabled = state.supervised_input_enabled();
    #[cfg(not(any(test, feature = "supervised-input-preview")))]
    let enabled = false;
    Ok(Json(json!({"protocol":1, "enabled":enabled})))
}

#[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
async fn supervised_input_session_capabilities(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !state.supervised_input_enabled() || authority.is_none() {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Supervised input unavailable".into(),
        });
    }
    let eligible = state
        .structured_session_manager()
        .supervised_input_session_eligible(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?;
    if eligible != Some(true) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Supervised input unavailable for this session".into(),
        });
    }
    Ok(Json(json!({"protocol":1})))
}

#[cfg(unix)]
async fn supervised_input_watermark(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<Json<Value>, ApiError> {
    require_input_recovery(&state, authority.is_some()).await?;
    let authority = authority
        .ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Local authority required".into(),
        })?
        .0;
    let cutoff =
        tokio::task::spawn_blocking(move || state.input_watermark(&user.user_id, &authority))
            .await
            .map_err(|_| ApiError::internal("Input watermark unavailable"))?
            .map_err(|message| ApiError {
                status: StatusCode::CONFLICT,
                message,
            })?;
    Ok(Json(json!({"protocol":1, "rejectBefore": cutoff})))
}

#[cfg(unix)]
async fn get_supervised_input_receipt(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path((session, operation)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    require_input_recovery(&state, authority.is_some()).await?;
    let status = state
        .input_receipt(&user.user_id, &session, &operation)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Input receipt unavailable".into(),
        })?;
    Ok(Json(
        json!({"sessionId":session, "requestId":operation, "status":status}),
    ))
}

#[cfg(unix)]
async fn list_supervised_input_receipts(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_input_recovery(&state, authority.is_some()).await?;
    state
        .structured_session_manager()
        .get_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".into(),
        })?;
    let receipts = state
        .list_input_receipts(&user.user_id, &id)
        .map_err(ApiError::internal)?;
    Ok(Json(
        json!({"receipts": receipts.into_iter().map(|(request_id, status)| json!({"requestId": request_id, "status": status})).collect::<Vec<_>>() }),
    ))
}

#[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
async fn issue_supervised_input_operation(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !state.supervised_input_enabled() {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Supervised input unavailable".into(),
        });
    }
    let (incarnation, generation) = state
        .structured_session_manager()
        .supervised_input_target(&user.user_id, &id)
        .await
        .map_err(|message| ApiError {
            status: StatusCode::CONFLICT,
            message,
        })?;
    let authority = authority
        .ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Local authority required".into(),
        })?
        .0;
    let (operation, token) = tokio::task::spawn_blocking(move || {
        state.issue_input_operation(&user.user_id, &authority, &id, &incarnation, generation)
    })
    .await
    .map_err(|_| ApiError::internal("Input issuance unavailable"))?
    .map_err(|message| ApiError {
        status: StatusCode::CONFLICT,
        message,
    })?;
    Ok(Json(
        json!({"requestId":operation, "deliveryToken":token, "protocol":1}),
    ))
}

#[cfg(unix)]
#[derive(Deserialize)]
struct InputReceiptQuery {
    after: Option<i64>,
}

#[cfg(unix)]
async fn list_unresolved_input_receipts(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Query(query): Query<InputReceiptQuery>,
) -> Result<Json<Value>, ApiError> {
    require_input_recovery(&state, authority.is_some()).await?;
    let after = query.after.unwrap_or(0);
    if after < 0 {
        return Err(ApiError::bad_request("Invalid input receipt cursor"));
    }
    let (receipts, next_cursor) = state
        .list_unresolved_input_receipts(&user.user_id, after)
        .map_err(ApiError::internal)?;
    Ok(Json(
        json!({"receipts": receipts.into_iter().map(|(session_id, request_id, status)| json!({"sessionId": session_id, "requestId": request_id, "status": status})).collect::<Vec<_>>(), "nextCursor": next_cursor }),
    ))
}

#[cfg(unix)]
async fn review_supervised_input_receipt(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path((session, operation)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    require_input_recovery(&state, authority.is_some()).await?;
    let authority = authority
        .ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Local authority required".into(),
        })?
        .0;
    let reviewed_session = session.clone();
    let reviewed_operation = operation.clone();
    let status = tokio::task::spawn_blocking(move || {
        state.review_input_receipt(&user.user_id, &authority, &session, &operation)
    })
    .await
    .map_err(|_| ApiError::internal("Input review unavailable"))?
    .map_err(|message| ApiError {
        status: StatusCode::CONFLICT,
        message,
    })?;
    Ok(Json(
        json!({"sessionId":reviewed_session, "requestId":reviewed_operation, "status":status}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuredCompactInput {
    request_id: String,
    instructions: Option<String>,
    expected_revision: Option<String>,
}
async fn compact_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
    Json(input): Json<StructuredCompactInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let receipt = state
        .structured_session_manager()
        .compact(
            &user.user_id,
            &id,
            &input.request_id,
            input.instructions.as_deref(),
            input.expected_revision.as_deref(),
        )
        .await
        .map_err(structured_control_error)?;
    Ok((StatusCode::ACCEPTED, Json(json!(receipt))))
}
async fn get_structured_request_receipt(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, request_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    state
        .structured_session_manager()
        .request_receipt(&user.user_id, &id, &request_id)
        .await
        .map_err(structured_control_error)?
        .map(|receipt| Json(json!(receipt)))
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "No accepted request receipt exists for this account and session".into(),
        })
}
async fn get_structured_artifact(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, artifact_id, format)): Path<(String, String, String)>,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = state
        .structured_session_manager()
        .get_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .filter(|snapshot| snapshot.runtime.as_deref() == Some("v4"))
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Artifact unavailable".into(),
        })?;
    let mime = match format.as_str() {
        "png" => "image/png",
        "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => {
            return Err(ApiError {
                status: StatusCode::NOT_FOUND,
                message: "Artifact unavailable".into(),
            });
        }
    };
    let session = structured::engine_session_id(&id).map_err(ApiError::internal)?;
    let bytes = crate::v4_agent::read_artifact(
        &state.config().data_dir,
        &user.user_id,
        std::path::Path::new(&snapshot.cwd),
        &session,
        &artifact_id,
        mime,
    )
    .map_err(|_| ApiError {
        status: StatusCode::NOT_FOUND,
        message: "Artifact unavailable".into(),
    })?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, mime),
            (axum::http::header::CACHE_CONTROL, "private, no-store"),
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
async fn interrupt_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = state.structured_session_manager();
    if manager
        .get_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .is_none()
    {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".into(),
        });
    }
    #[cfg(unix)]
    let stopped = manager
        .interrupt_authorized(
            &user.user_id,
            &id,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            &state,
        )
        .await;
    #[cfg(not(unix))]
    let stopped = {
        let _ = (authority, paired);
        manager.interrupt(&user.user_id, &id).await
    };
    stopped.map_err(|message| ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message,
    })?;
    Ok(Json(json!({"status":"cancelled","cleanupConfirmed":true})))
}
async fn get_codex_approval_capability(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mode, outstanding) = state
        .structured_session_manager()
        .codex_approval_capability(&user.user_id, &id)
        .await
        .map_err(structured_control_error)?;
    Ok(Json(
        json!({"protocol":1,"mode":mode,"outstanding":outstanding}),
    ))
}
async fn reserve_codex_approval(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path((id, approval_id)): Path<(String, String)>,
) -> axum::response::Response {
    #[cfg(unix)]
    {
        match state
            .structured_session_manager()
            .reserve_codex_approval(
                &user.user_id,
                &id,
                &approval_id,
                authority.as_ref().map(|Extension(value)| value),
                paired.as_ref().map(|Extension(value)| value),
                &state,
            )
            .await {
            Ok((reservation_id, token)) => Json(json!({"approvalId":approval_id,"reservationId":reservation_id,"deliveryToken":token,"status":"reserved"})).into_response(),
            Err(error) if error.code == "reservation_not_started" => (StatusCode::CONFLICT, Json(json!({"status":"not_started","error":error.message}))).into_response(),
            Err(error) => structured_control_error(error).into_response(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (state, user, authority, paired, id, approval_id);
        ApiError::internal("Approval reservation is unavailable on this platform").into_response()
    }
}
async fn review_codex_approval_claim(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path((id, approval_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    #[cfg(unix)]
    state
        .structured_session_manager()
        .review_codex_approval_claim(
            &user.user_id,
            &id,
            &approval_id,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            &state,
        )
        .await
        .map_err(structured_control_error)?;
    #[cfg(not(unix))]
    {
        let _ = (state, user, authority, paired, id, approval_id);
        return Err(ApiError::internal(
            "Approval review is unavailable on this platform",
        ));
    }
    #[cfg(unix)]
    Ok(Json(json!({"approvalId":approval_id,"status":"reviewed"})))
}
#[cfg(unix)]
fn valid_private_output_reference(approval_id: &str, action_id: &str) -> bool {
    approval_id.len() == 36
        && uuid::Uuid::parse_str(approval_id).is_ok()
        && action_id.len() == 64
        && action_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

async fn preview_private_output(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(input): Json<PrivateOutputPreviewInput>,
) -> Result<axum::response::Response, ApiError> {
    #[cfg(unix)]
    {
        if !valid_private_output_reference(&input.approval_id, &input.action_id) {
            return Err(ApiError {
                status: StatusCode::BAD_REQUEST,
                message: "Invalid private review reference".into(),
            });
        }
        let (token, output) = state
            .structured_session_manager()
            .preview_private_output(
                &user.user_id,
                &id,
                &input.approval_id,
                &input.action_id,
                authority.as_ref().map(|Extension(value)| value),
                paired.as_ref().map(|Extension(value)| value),
                &state,
            )
            .await
            .map_err(structured_control_error)?;
        Ok((
            [
                (axum::http::header::CACHE_CONTROL, "private, no-store"),
                (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            Json(json!({"previewToken":token,"output":output})),
        )
            .into_response())
    }
    #[cfg(not(unix))]
    {
        let _ = (state, user, authority, paired, id, input);
        Err(ApiError::internal(
            "Private output review is unavailable on this platform",
        ))
    }
}

async fn approve_private_output(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(input): Json<PrivateOutputDecisionInput>,
) -> Result<axum::response::Response, ApiError> {
    #[cfg(unix)]
    {
        if !valid_private_output_reference(&input.approval_id, &input.action_id)
            || input.preview_token.len() != 36
            || uuid::Uuid::parse_str(&input.preview_token).is_err()
        {
            return Err(ApiError {
                status: StatusCode::BAD_REQUEST,
                message: "Invalid private review token".into(),
            });
        }
        let receipt = state
            .structured_session_manager()
            .decide_private_output(
                &user.user_id,
                &id,
                &input.approval_id,
                &input.action_id,
                &input.preview_token,
                authority.as_ref().map(|Extension(value)| value),
                paired.as_ref().map(|Extension(value)| value),
                &state,
            )
            .await
            .map_err(structured_control_error)?;
        Ok((
            [(axum::http::header::CACHE_CONTROL, "private, no-store")],
            Json(json!(receipt)),
        )
            .into_response())
    }
    #[cfg(not(unix))]
    {
        let _ = (state, user, authority, paired, id, input);
        Err(ApiError::internal(
            "Private output review is unavailable on this platform",
        ))
    }
}

async fn approve_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(input): Json<StructuredApprovalInput>,
) -> Result<Json<Value>, ApiError> {
    let manager = state.structured_session_manager();
    let reservation = match (
        input.reservation_id.as_deref(),
        input.reservation_token.as_deref(),
    ) {
        (None, None) => None,
        (Some(id), Some(token)) => Some((id, token)),
        _ => {
            return Err(ApiError {
                status: StatusCode::BAD_REQUEST,
                message: "Reservation ID and token are both required".into(),
            })
        }
    };
    let receipt = manager
        .approve_with_paired(
            &user.user_id,
            &id,
            input.approval_id.as_deref(),
            input.approved,
            input.answers,
            input.for_session,
            reservation,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            &state,
        )
        .await
        .map_err(structured_control_error)?;
    Ok(Json(json!(receipt)))
}
async fn delete_structured_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manager = state.structured_session_manager();
    if manager
        .get_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .is_none()
    {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Session not found".into(),
        });
    }
    manager
        .delete_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({"status":"deleted"})))
}

async fn get_settings(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<Json<terminal_v4_core::UserSettings>, ApiError> {
    let authority = settings_local_authority(authority)?;
    tokio::task::spawn_blocking(move || state.get_settings_authorized(&user, &authority))
        .await
        .map_err(|_| ApiError::internal("Settings worker unavailable"))?
        .map(Json)
        .map_err(settings_authority_error)
}

fn settings_local_authority(
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<auth::LocalAuthority, ApiError> {
    authority
        .map(|Extension(value)| value)
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "A valid local session is required".into(),
        })
}

fn settings_authority_error(error: String) -> ApiError {
    if matches!(
        error.as_str(),
        "Credential is invalid or expired" | "Credential has been revoked"
    ) {
        ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "The session is no longer valid".into(),
        }
    } else {
        ApiError::internal(error)
    }
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
    sandbox_mode: Option<String>,
    workspace_root: Option<String>,
    initial_command: Option<String>,
    request_id: Option<String>,
    companion_of: Option<String>,
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
    snooze_for_seconds: Option<i64>,
    wake_snooze: Option<bool>,
    settled: Option<bool>,
    sandbox_mode: Option<String>,
    sandbox_workspace_root: Option<Option<String>>,
    companion_of: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct ProjectScanDirInput {
    path: String,
}

#[derive(Debug, Deserialize, Default)]
struct FilesystemListQuery {
    path: Option<String>,
}

fn terminal_session_error(message: String) -> ApiError {
    if message.starts_with("Invalid terminal working directory ") {
        ApiError::bad_request(message)
    } else if let Some(reason) = message.strip_prefix(terminal::TERMINAL_UNAUTHORIZED) {
        ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: reason.to_string(),
        }
    } else if let Some(reason) = message.strip_prefix(terminal::TERMINAL_CONFLICT) {
        ApiError {
            status: StatusCode::CONFLICT,
            message: reason.to_string(),
        }
    } else {
        ApiError::internal(message)
    }
}

#[cfg(unix)]
struct TerminalRequestLifetime(std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg(unix)]
impl Drop for TerminalRequestLifetime {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn create_terminal_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
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
    if let Some(sandbox_mode) = &input.sandbox_mode {
        validate_sandbox_mode(sandbox_mode)?;
    }
    if let Some(workspace_root) = &input.workspace_root {
        validate_string(workspace_root, 1, 1024, "workspaceRoot")?;
    }
    if let Some(companion_of) = &input.companion_of {
        validate_string(companion_of, 1, 200, "companionOf")?;
    }
    if input
        .request_id
        .as_deref()
        .is_some_and(|request_id| !terminal::valid_create_request_id(request_id))
    {
        return Err(ApiError::bad_request(
            "requestId must be 8 to 64 letters, digits or hyphens",
        ));
    }
    validate_optional_terminal_size(input.cols, "cols")?;
    validate_optional_terminal_size(input.rows, "rows")?;

    #[cfg(not(unix))]
    let admission = terminal::credential_admission(
        &state,
        &user.user_id,
        authority.as_ref().map(|Extension(value)| value),
        paired.as_ref().map(|Extension(value)| value),
    );
    let request_id = input.request_id.clone();
    let options = TerminalCreateOptions {
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        title: input.title,
        shell: input.shell,
        sandbox_mode: input.sandbox_mode,
        sandbox_workspace_root: input.workspace_root,
        initial_command: input.initial_command,
    };
    let intent = terminal::TerminalCreateIntent {
        request_id: input.request_id,
        companion_of: input.companion_of.clone(),
    };
    #[cfg(unix)]
    let creation = {
        let lifetime = TerminalRequestLifetime(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        ));
        let cancelled = lifetime.0.clone();
        let app = state.clone();
        let owner = user.user_id.clone();
        let local = authority.map(|Extension(value)| value);
        let paired = paired.map(|Extension(value)| value);
        let result = tokio::spawn(async move {
            app.terminal_manager()
                .create_session_authorized(
                    &owner,
                    options,
                    intent,
                    &app,
                    local.as_ref(),
                    paired.as_ref(),
                    &cancelled,
                )
                .await
        })
        .await
        .map_err(|_| ApiError::internal("Terminal creation outcome is uncertain"))?
        .map_err(terminal_session_error)?;
        drop(lifetime);
        result
    };
    #[cfg(not(unix))]
    let creation = state
        .terminal_manager()
        .create_session_admitted(&user.user_id, options, intent, Some(&admission))
        .await
        .map_err(terminal_session_error)?;
    let session = creation.session;

    let cwd = state
        .terminal_manager()
        .get_project_info(&user.user_id, &session.id)
        .await
        .map_err(ApiError::internal)?
        .map(|project| project.cwd);

    Ok((
        if creation.replayed {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(json!({
            "session": {
                "id": session.id,
                "title": session.title,
                "shell": session.shell,
                "cwd": cwd,
                "createdAt": session.created_at,
                "updatedAt": session.updated_at,
                "usesTmux": session.uses_tmux,
                "sandbox": session.sandbox,
                "requestId": request_id,
                "companionOf": input.companion_of,
            },
            "replayed": creation.replayed
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
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(session_id): Path<String>,
    Json(input): Json<TerminalInputBody>,
) -> Result<StatusCode, ApiError> {
    validate_string(&input.command, 1, 1024 * 1024, "command")?;
    let admission = terminal::credential_admission(
        &state,
        &user.user_id,
        authority.as_ref().map(|Extension(value)| value),
        paired.as_ref().map(|Extension(value)| value),
    );
    state
        .terminal_manager()
        .write_admitted(&user.user_id, &session_id, &input.command, Some(&admission))
        .await
        .map_err(
            |error| match error.strip_prefix(terminal::TERMINAL_UNAUTHORIZED) {
                Some(reason) => ApiError {
                    status: StatusCode::UNAUTHORIZED,
                    message: reason.to_string(),
                },
                None => ApiError {
                    status: StatusCode::NOT_FOUND,
                    message: error,
                },
            },
        )?;
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
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(session_id): Path<String>,
    Json(input): Json<TerminalRestoreInput>,
) -> Result<Json<Value>, ApiError> {
    validate_optional_terminal_size(input.cols, "cols")?;
    validate_optional_terminal_size(input.rows, "rows")?;

    #[cfg(not(unix))]
    let admission = terminal::credential_admission(
        &state,
        &user.user_id,
        authority.as_ref().map(|Extension(value)| value),
        paired.as_ref().map(|Extension(value)| value),
    );
    #[cfg(unix)]
    let restored = {
        let lifetime = TerminalRequestLifetime(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        ));
        let cancelled = lifetime.0.clone();
        let app = state.clone();
        let owner = user.user_id.clone();
        let local = authority.map(|Extension(value)| value);
        let paired = paired.map(|Extension(value)| value);
        let result = tokio::spawn(async move {
            app.terminal_manager()
                .restore_session_authorized(
                    &owner,
                    &session_id,
                    input.cols,
                    input.rows,
                    &app,
                    local.as_ref(),
                    paired.as_ref(),
                    &cancelled,
                )
                .await
        })
        .await
        .map_err(|_| ApiError::internal("Terminal restore outcome is uncertain"))?
        .map_err(terminal_session_error)?;
        drop(lifetime);
        result
    };
    #[cfg(not(unix))]
    let restored = state
        .terminal_manager()
        .restore_session_admitted(
            &user.user_id,
            &session_id,
            input.cols,
            input.rows,
            Some(&admission),
        )
        .await
        .map_err(terminal_session_error)?;
    let Some(session) = restored else {
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

    let project = state
        .terminal_manager()
        .get_project_info(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?;
    let branches = match project {
        Some(project) => git::list_git_branches(&project.cwd).await,
        None => None,
    }
    .unwrap_or(git::GitBranchInfo {
        current_branch: None,
        branches: Vec::new(),
    });

    Ok(Json(
        serde_json::to_value(branches).map_err(|error| ApiError::internal(error.to_string()))?,
    ))
}

async fn get_terminal_project_info(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(project_info) = state
        .terminal_manager()
        .get_project_info(&user.user_id, &session_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Terminal session not found".to_string(),
        });
    };

    Ok(Json(
        serde_json::to_value(project_info)
            .map_err(|error| ApiError::internal(error.to_string()))?,
    ))
}

async fn update_terminal_thread(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    paired: Option<Extension<auth::PairedInputAuthority>>,
    Path(session_id): Path<String>,
    Json(input): Json<ThreadUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    if input.snooze_for_seconds.is_some()
        || input.wake_snooze == Some(true)
        || input.settled.is_some()
    {
        return Err(ApiError::bad_request(
            "Snooze and settlement are available only for structured conversations",
        ));
    }
    if let Some(sandbox_mode) = &input.sandbox_mode {
        validate_sandbox_mode(sandbox_mode)?;
    }
    if let Some(Some(sandbox_workspace_root)) = &input.sandbox_workspace_root {
        validate_string(sandbox_workspace_root, 1, 1024, "sandboxWorkspaceRoot")?;
    }
    if let Some(Some(companion_of)) = &input.companion_of {
        validate_string(companion_of, 1, 200, "companionOf")?;
    }
    #[cfg(not(unix))]
    let admission = terminal::credential_admission(
        &state,
        &user.user_id,
        authority.as_ref().map(|Extension(value)| value),
        paired.as_ref().map(|Extension(value)| value),
    );
    let updates = ThreadUpdate {
        topic: input.topic,
        topic_auto_generated: input.topic_auto_generated,
        pinned: input.pinned,
        archived: input.archived,
        project_path: input.project_path,
        sandbox_mode: input.sandbox_mode,
        sandbox_workspace_root: input.sandbox_workspace_root,
        companion_of: input.companion_of,
    };
    #[cfg(unix)]
    let updated = {
        let lifetime = TerminalRequestLifetime(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        ));
        let cancelled = lifetime.0.clone();
        let app = state.clone();
        let owner = user.user_id.clone();
        let local = authority.map(|Extension(value)| value);
        let paired = paired.map(|Extension(value)| value);
        let result = tokio::spawn(async move {
            app.terminal_manager()
                .update_thread_authorized(
                    &owner,
                    &session_id,
                    updates,
                    &app,
                    local.as_ref(),
                    paired.as_ref(),
                    &cancelled,
                )
                .await
        })
        .await
        .map_err(|_| ApiError::internal("Terminal update outcome is uncertain"))?
        .map_err(terminal_session_error)?;
        drop(lifetime);
        result
    };
    #[cfg(not(unix))]
    let updated = state
        .terminal_manager()
        .update_thread_admitted(&user.user_id, &session_id, updates, Some(&admission))
        .await
        .map_err(terminal_session_error)?;
    let Some(thread) = updated else {
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
                sandbox_mode: None,
                sandbox_workspace_root: None,
                companion_of: None,
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
    let session = terminal_session_summary(&state, &user, &session_id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("Terminal session not found"))?;
    let _activity = file_mutation_guard(&session.cwd)?;
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
            .into_response();
        }
        Err(e) => return ApiError::internal(e).into_response(),
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, std::convert::Infallible>>(64);

    tokio::spawn(async move {
        let mut last_sequence = snapshot.history.iter().filter_map(|event| event.seq).max();

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
                        if event
                            .seq
                            .zip(last_sequence)
                            .is_some_and(|(next, previous)| next <= previous)
                        {
                            continue;
                        }
                        if let Some(sequence) = event.seq {
                            last_sequence = Some(sequence);
                        }

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
                        let _ = tx.send(Ok(Event::default().event("end").data("{}"))).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        let _ = tx.send(Ok(Event::default().event("end").data("{}"))).await;
                        break;
                    }
                }
            }
        } else {
            let _ = tx.send(Ok(Event::default().event("end").data("{}"))).await;
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
        "subdomainBases": preview::subdomain_bases(),
        "proxyHosts": preview::proxy_hosts(),
        "preferPathBased": default_mode == "path-first",
        "defaultMode": default_mode,
        "cookiePolicy": cookie_policy,
        "rewriteScope": rewrite_scope
    }))
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
    authority: Option<Extension<auth::LocalAuthority>>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let patch = SettingsPatch::from_value(payload).map_err(ApiError::bad_request)?;
    let authority = settings_local_authority(authority)?;
    tokio::task::spawn_blocking(move || state.update_settings_authorized(&user, &authority, patch))
        .await
        .map_err(|_| ApiError::internal("Settings worker unavailable"))?
        .map_err(settings_authority_error)?;
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

#[derive(Clone, Copy)]
enum UtilityKind {
    Note,
    Bookmark,
}

fn utility_with_authority<T>(
    state: &AppState,
    user: &AuthenticatedUser,
    authority: Option<Extension<auth::LocalAuthority>>,
    prepare: impl FnOnce() -> Result<state::PreparedUtility<T>, String>,
) -> Result<T, ApiError> {
    utility_with_authority_for(state, user, authority, UtilityKind::Note, prepare)
}

fn utility_with_authority_for<T>(
    state: &AppState,
    user: &AuthenticatedUser,
    authority: Option<Extension<auth::LocalAuthority>>,
    kind: UtilityKind,
    prepare: impl FnOnce() -> Result<state::PreparedUtility<T>, String>,
) -> Result<T, ApiError> {
    let authority = settings_local_authority(authority)?;
    let resource = match kind {
        UtilityKind::Note => "note",
        UtilityKind::Bookmark => "bookmark",
    };
    let ownership_error = match kind {
        UtilityKind::Note => state::NOTE_OWNER_AMBIGUOUS,
        UtilityKind::Bookmark => {
            "Bookmark storage ownership is ambiguous. Administrator review is required."
        }
    };
    let uncertain =
        format!("The {resource} operation may have completed. Check its status before retrying");
    let map_error = |error: String| {
        if error == state::NOTE_OWNER_AMBIGUOUS {
            ApiError {
                status: StatusCode::CONFLICT,
                message: ownership_error.into(),
            }
        } else if error == "Notes storage is busy or unavailable"
            || error == "Authentication admission unavailable"
            || error == "Authentication admission is busy"
        {
            ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: if error == "Notes storage is busy or unavailable"
                    && matches!(kind, UtilityKind::Bookmark)
                {
                    "Bookmarks storage is busy or unavailable".into()
                } else {
                    error
                },
            }
        } else {
            settings_authority_error(error)
        }
    };
    let _file_lock = state.try_lock_note_files().map_err(&map_error)?;
    #[cfg(unix)]
    let _lease = vault_admission::notes_exclusive(
        &state.config().data_dir,
        &state
            .note_storage_id(user)
            .map_err(settings_authority_error)?,
    )
    .map_err(|_| ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: match kind {
            UtilityKind::Note => "Notes storage or its lock is unavailable".into(),
            UtilityKind::Bookmark => "Bookmarks storage or its lock is unavailable".into(),
        },
    })?;
    let attempted = std::cell::Cell::new(false);
    #[cfg(unix)]
    state
        .try_with_owner_review(&user.user_id, &authority, |tx, check| {
            check()?;
            AppState::verify_note_owner(tx, &user.user_id)
        })
        .map_err(&map_error)?;
    #[cfg(unix)]
    let prepared = prepare();
    let review = |tx: &rusqlite::Transaction<'_>, check: &dyn Fn() -> Result<(), String>| {
        check()?;
        AppState::verify_note_owner(tx, &user.user_id)?;
        #[cfg(not(unix))]
        let prepared = prepare();
        check()?;
        attempted.set(true);
        let result = prepared.and_then(|value| value.commit());
        if check().is_err() {
            return Ok(Err(uncertain.clone()));
        }
        Ok(result)
    };
    #[cfg(unix)]
    let result = state.try_with_owner_review(&user.user_id, &authority, review);
    #[cfg(not(unix))]
    let result = state.with_owner_review(&user.user_id, &authority, review);
    let result = result.map_err(|error| {
        if attempted.get()
            && matches!(
                error.as_str(),
                "Credential is invalid or expired" | "Credential has been revoked"
            )
        {
            uncertain.clone()
        } else {
            error
        }
    });
    result.map_err(&map_error)?.map_err(map_error)
}

async fn list_bookmarks(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<Json<Value>, ApiError> {
    let bookmarks = tokio::task::spawn_blocking(move || {
        utility_with_authority_for(&state, &user, authority, UtilityKind::Bookmark, || {
            state.prepare_bookmark_list(&user)
        })
    })
    .await
    .map_err(|_| ApiError::internal("Bookmarks worker unavailable"))??;
    Ok(Json(json!({ "bookmarks": bookmarks })))
}

async fn create_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Json(input): Json<BookmarkCreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.name, 1, 100, "name")?;
    validate_string(&input.command, 1, 1000, "command")?;
    validate_string(&input.category, 1, 50, "category")?;

    let bookmark = tokio::task::spawn_blocking(move || {
        utility_with_authority_for(&state, &user, authority, UtilityKind::Bookmark, || {
            state.prepare_bookmark_create(&user, input.name, input.command, input.category)
        })
    })
    .await
    .map_err(|_| ApiError::internal("Bookmarks worker unavailable"))??;
    Ok((StatusCode::CREATED, Json(json!({ "bookmark": bookmark }))))
}

async fn update_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
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

    match tokio::task::spawn_blocking(move || {
        utility_with_authority_for(&state, &user, authority, UtilityKind::Bookmark, || {
            state.prepare_bookmark_update(
                &user,
                &bookmark_id,
                BookmarkUpdate {
                    name: input.name,
                    command: input.command,
                    category: input.category,
                },
            )
        })
    })
    .await
    .map_err(|_| ApiError::internal("Bookmarks worker unavailable"))??
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
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(bookmark_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = tokio::task::spawn_blocking(move || {
        utility_with_authority_for(&state, &user, authority, UtilityKind::Bookmark, || {
            state.prepare_bookmark_delete(&user, &bookmark_id)
        })
    })
    .await
    .map_err(|_| ApiError::internal("Bookmarks worker unavailable"))??;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Bookmark not found".to_string(),
        })
    }
}

async fn list_mobile_keyboard_debug_entries(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let entries = state
        .list_mobile_keyboard_debug_entries(&user)
        .map_err(ApiError::internal)?;
    Ok(Json(json!({
        "count": entries.len(),
        "entries": entries
    })))
}

async fn ingest_mobile_keyboard_debug_entry(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
    Json(entry): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let request_user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok());
    let saved_entry = state
        .append_mobile_keyboard_debug_entry(&user, entry, request_user_agent)
        .map_err(|error| {
            if error.contains("must be a JSON object") {
                ApiError::bad_request(error)
            } else {
                ApiError::internal(error)
            }
        })?;
    Ok(Json(json!({ "entry": saved_entry })))
}

async fn clear_mobile_keyboard_debug_entries(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    state
        .clear_mobile_keyboard_debug_entries(&user)
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_notes(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<Json<Value>, ApiError> {
    let notes = tokio::task::spawn_blocking(move || {
        utility_with_authority(&state, &user, authority, || state.prepare_note_list(&user))
    })
    .await
    .map_err(|_| ApiError::internal("Notes worker unavailable"))??;
    Ok(Json(json!({ "notes": notes })))
}

async fn create_note(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Json(input): Json<NoteCreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_string(&input.title, 1, 200, "title")?;
    validate_string(&input.content, 0, 50_000, "content")?;
    validate_string(&input.category, 1, 50, "category")?;

    let note = tokio::task::spawn_blocking(move || {
        utility_with_authority(&state, &user, authority, || {
            state.prepare_note_create(&user, input.title, input.content, input.category)
        })
    })
    .await
    .map_err(|_| ApiError::internal("Notes worker unavailable"))??;
    Ok((StatusCode::CREATED, Json(json!({ "note": note }))))
}

async fn update_note(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
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

    match tokio::task::spawn_blocking(move || {
        utility_with_authority(&state, &user, authority, || {
            state.prepare_note_update(
                &user,
                &note_id,
                NoteUpdate {
                    title: input.title,
                    content: input.content,
                    category: input.category,
                },
            )
        })
    })
    .await
    .map_err(|_| ApiError::internal("Notes worker unavailable"))??
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
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(note_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = tokio::task::spawn_blocking(move || {
        utility_with_authority(&state, &user, authority, || {
            state.prepare_note_delete(&user, &note_id)
        })
    })
    .await
    .map_err(|_| ApiError::internal("Notes worker unavailable"))??;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Note not found".to_string(),
        })
    }
}

// --- Vault handlers ---

async fn list_vault_keys(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
) -> Result<Json<Value>, ApiError> {
    let authority = settings_local_authority(authority)?;
    let masked = tokio::task::spawn_blocking(move || {
        state.with_authorized_vault(&user, &authority, |tx| {
            let cipher = vault::VaultCipher::load(&state.config().data_dir)?;
            AppState::list_vault_keys_from_connection(tx, &user)?
                .into_iter()
                .map(|e| {
                    Ok(json!({
                        "id": e.id,
                        "keyName": e.key_name,
                        "keyValue": vault::mask_key(&cipher.decrypt(&e.key_value)?),
                        "createdAt": e.created_at
                    }))
                })
                .collect::<Result<Vec<Value>, String>>()
        })
    })
    .await
    .map_err(|_| ApiError::internal("Vault worker unavailable"))?
    .map_err(vault_authority_error)?;
    Ok(Json(json!({ "keys": masked })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddVaultKeyInput {
    key_name: String,
    key_value: String,
}

fn vault_mutation_error(error: String) -> ApiError {
    #[cfg(unix)]
    {
        vault_admission::api_error(error)
    }
    #[cfg(not(unix))]
    {
        ApiError::internal(error)
    }
}

fn vault_authority_error(error: String) -> ApiError {
    if matches!(
        error.as_str(),
        "Credential is invalid or expired" | "Credential has been revoked"
    ) {
        settings_authority_error(error)
    } else {
        vault_mutation_error(error)
    }
}

async fn add_vault_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Json(input): Json<AddVaultKeyInput>,
) -> Result<Json<Value>, ApiError> {
    validate_string(&input.key_name, 1, 100, "keyName")?;
    validate_string(&input.key_value, 1, 10000, "keyValue")?;
    let authority = settings_local_authority(authority)?;
    let id = Uuid::new_v4().to_string();
    let now = iso_timestamp();
    let response = json!({
        "id": id,
        "keyName": input.key_name.trim(),
        "keyValue": vault::mask_key(&input.key_value),
        "createdAt": now
    });
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let _lease = vault_admission::exclusive(&state.config().data_dir, &user.user_id)?;
        state.with_authorized_vault(&user, &authority, |tx| {
            let cipher = vault::VaultCipher::load(&state.config().data_dir)?;
            let encrypted = cipher.encrypt(&input.key_value)?;
            tx.execute("INSERT INTO api_key_vault (id, user_id, key_name, key_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, user.user_id, input.key_name.trim(), encrypted, now])
                .map_err(|error| error.to_string())?;
            Ok(())
        })
    }).await.map_err(|_| ApiError::internal("Vault worker unavailable"))?.map_err(vault_authority_error)?;
    Ok(Json(response))
}

async fn reveal_vault_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(key_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let authority = settings_local_authority(authority)?;
    let entry = tokio::task::spawn_blocking(move || {
        let first = state.with_authorized_vault(&user, &authority, |tx| {
            let entry = AppState::get_vault_key_from_connection(tx, &user, &key_id)?;
            match entry {
                Some(mut entry) if entry.key_value.starts_with("enc:v2:") => {
                    entry.key_value = vault::VaultCipher::load(&state.config().data_dir)?.decrypt(&entry.key_value)?;
                    Ok((Some(entry), false))
                }
                Some(_) => Ok((None, true)),
                None => Ok((None, false)),
            }
        })?;
        if !first.1 { return Ok(first.0); }
        #[cfg(unix)]
        let _lease = vault_admission::exclusive(&state.config().data_dir, &user.user_id)?;
        state.with_authorized_vault(&user, &authority, |tx| {
            let Some(mut entry) = AppState::get_vault_key_from_connection(tx, &user, &key_id)? else { return Ok(None); };
            let cipher = vault::VaultCipher::load(&state.config().data_dir)?;
            let decrypted = cipher.decrypt(&entry.key_value)?;
            if !entry.key_value.starts_with("enc:v2:") {
                let encrypted = cipher.encrypt(&decrypted)?;
                tx.execute("UPDATE api_key_vault SET key_value = ?1 WHERE id = ?2 AND user_id = ?3 AND key_value = ?4",
                    rusqlite::params![encrypted, entry.id, user.user_id, entry.key_value])
                    .map_err(|error| error.to_string())?;
            }
            entry.key_value = decrypted;
            Ok(Some(entry))
        })
    }).await.map_err(|_| ApiError::internal("Vault worker unavailable"))?.map_err(vault_authority_error)?
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Key not found".to_string(),
        })?;
    Ok(Json(json!({
        "id": entry.id,
        "keyName": entry.key_name,
        "keyValue": entry.key_value,
        "createdAt": entry.created_at
    })))
}

async fn delete_vault_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<auth::LocalAuthority>>,
    Path(key_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let authority = settings_local_authority(authority)?;
    let deleted = tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let _lease = vault_admission::exclusive(&state.config().data_dir, &user.user_id)?;
        state.with_authorized_vault(&user, &authority, |tx| {
            let count = tx
                .execute(
                    "DELETE FROM api_key_vault WHERE id = ? AND user_id = ?",
                    rusqlite::params![key_id, user.user_id],
                )
                .map_err(|error| error.to_string())?;
            Ok(count > 0)
        })
    })
    .await
    .map_err(|_| ApiError::internal("Vault worker unavailable"))?
    .map_err(vault_authority_error)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Key not found".to_string(),
        })
    }
}

// Compatibility only for paired_environments' existing vault-key + JWT derivation.
// Vault and provider credentials must use VaultCipher with their runtime data directory.
fn vault_encryption_key() -> String {
    std::env::var("VAULT_ENCRYPTION_KEY")
        .unwrap_or_else(|_| "dev-vault-key-change-in-production".to_string())
}

fn iso_timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("rfc3339 formatting should succeed")
}

// --- Passkey handlers ---
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyRegisterCompleteInput {
    credential: serde_json::Value,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyAuthBeginInput {
    username: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyAuthCompleteInput {
    username: String,
    credential: serde_json::Value,
}

async fn passkey_register_begin(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let account = state
        .get_user_public_by_id(&user.user_id)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "User not found".to_string(),
        })?;
    let existing = {
        let conn = state.lock_db().map_err(ApiError::internal)?;
        passkey::db::list_passkeys(&conn, &user.user_id).map_err(ApiError::internal)?
    };
    let options = state
        .passkey_service()
        .begin_registration(
            &user.user_id,
            &account.username,
            &existing
                .iter()
                .map(|entry| entry.passkey.clone())
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(
        serde_json::to_value(options).map_err(|error| ApiError::internal(error.to_string()))?,
    ))
}

async fn passkey_register_complete(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<PasskeyRegisterCompleteInput>,
) -> Result<Json<Value>, ApiError> {
    let credential: RegisterPublicKeyCredential = serde_json::from_value(input.credential)
        .map_err(|_| ApiError::bad_request("Invalid credential payload"))?;
    let passkey = state
        .passkey_service()
        .complete_registration(&user.user_id, credential)
        .await
        .map_err(ApiError::bad_request)?;
    let conn = state.lock_db().map_err(ApiError::internal)?;
    let saved =
        passkey::db::create_credential(&conn, &user.user_id, &passkey, input.name.as_deref())
            .map_err(ApiError::internal)?;
    Ok(Json(json!({
        "id": saved.id,
        "name": saved.name,
        "credentialId": saved.credential_id,
        "createdAt": saved.created_at,
    })))
}

async fn passkey_auth_begin(
    State(state): State<AppState>,
    Json(input): Json<PasskeyAuthBeginInput>,
) -> Result<Json<Value>, ApiError> {
    let username = input.username.trim();
    if username.is_empty() {
        return Err(ApiError::bad_request("Username is required"));
    }
    let user = state
        .get_passkey_user_by_identifier(username)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::bad_request("User not found"))?;
    auth::validate_allowed_username(state.config().allowed_username.as_deref(), &user.username)
        .map_err(|message| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message,
        })?;
    let passkeys = {
        let conn = state.lock_db().map_err(ApiError::internal)?;
        passkey::db::list_passkeys(&conn, &user.id).map_err(ApiError::internal)?
    };
    if passkeys.is_empty() {
        return Err(ApiError::bad_request(
            "No compatible passkeys registered for this user. Sign in with your password and register a new passkey.",
        ));
    }
    let options = state
        .passkey_service()
        .begin_authentication(
            &user.id,
            &passkeys
                .iter()
                .map(|entry| entry.passkey.clone())
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(
        serde_json::to_value(options).map_err(|error| ApiError::internal(error.to_string()))?,
    ))
}

async fn passkey_auth_complete(
    State(state): State<AppState>,
    Json(input): Json<PasskeyAuthCompleteInput>,
) -> Result<Json<terminal_v4_core::AuthResult>, ApiError> {
    let username = input.username.trim();
    if username.is_empty() {
        return Err(ApiError::bad_request("Username is required"));
    }
    let user = state
        .get_passkey_user_by_identifier(username)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "User not found".to_string(),
        })?;
    auth::validate_allowed_username(state.config().allowed_username.as_deref(), &user.username)
        .map_err(|message| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message,
        })?;
    let credential: PublicKeyCredential = serde_json::from_value(input.credential)
        .map_err(|_| ApiError::bad_request("Invalid credential payload"))?;
    let auth_result = state
        .passkey_service()
        .complete_authentication(&user.id, credential)
        .await
        .map_err(|message| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message,
        })?;
    let credential_id =
        passkey::db::lookup_credential_id(auth_result.cred_id()).map_err(ApiError::internal)?;
    let conn = state.lock_db().map_err(ApiError::internal)?;
    let mut stored = passkey::db::get_passkey_by_credential_id(&conn, &credential_id)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Credential not found".to_string(),
        })?;
    let _ = stored.passkey.update_credential(&auth_result);
    passkey::db::update_credential_after_authentication(
        &conn,
        &stored.record.id,
        &stored.passkey,
        &iso_timestamp(),
    )
    .map_err(ApiError::internal)?;
    drop(conn);
    let auth_result = state
        .issue_auth_result_for_public_user(user)
        .map_err(ApiError::internal)?;
    Ok(Json(auth_result))
}

async fn passkey_list_credentials(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.lock_db().map_err(ApiError::internal)?;
    let creds = passkey::db::list_credentials(&conn, &user.user_id).map_err(ApiError::internal)?;
    Ok(Json(json!({ "credentials": creds })))
}

async fn passkey_delete_credential(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(credential_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let conn = state.lock_db().map_err(ApiError::internal)?;
    let deleted = passkey::db::delete_credential(&conn, &user.user_id, &credential_id)
        .map_err(ApiError::internal)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Credential not found".to_string(),
        })
    }
}

// --- File handlers ---

#[derive(Debug, Deserialize)]
struct FilePathQuery {
    path: String,
}

fn frontend_file_item(entry: &files::FileEntry) -> Value {
    json!({
        "name": &entry.name,
        "path": &entry.path,
        "type": if entry.is_directory { "directory" } else { "file" },
        "isDirectory": entry.is_directory,
        "size": entry.size,
        "modified": &entry.modified,
    })
}

fn safe_relative_upload_path(filename: &str) -> Result<PathBuf, ApiError> {
    let normalized = filename.replace('\\', "/");
    let mut relative = PathBuf::new();

    for component in FsPath::new(&normalized).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => relative.push(part),
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(ApiError::bad_request("Invalid filename"));
            }
        }
    }

    if relative.as_os_str().is_empty() {
        return Err(ApiError::bad_request("Invalid filename"));
    }

    Ok(relative)
}

fn upload_target_path(base_path: &str, filename: &str) -> Result<String, ApiError> {
    let relative = safe_relative_upload_path(filename)?;
    if base_path == "~" {
        return Ok(format!(
            "~/{}",
            relative.to_string_lossy().replace('\\', "/")
        ));
    }
    Ok(PathBuf::from(base_path)
        .join(relative)
        .to_string_lossy()
        .to_string())
}

fn download_filename(path: &FsPath, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .chars()
        .map(|ch| {
            if matches!(ch, '"' | '\\' | ';' | '\r' | '\n') {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

async fn list_files(
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<FilePathQuery>,
) -> Result<Json<Value>, ApiError> {
    let entries = files::list_directory(&query.path)
        .await
        .map_err(file_api_error)?;
    let items: Vec<Value> = entries.iter().map(frontend_file_item).collect();
    Ok(Json(json!({
        "path": query.path,
        "items": items,
        "entries": entries
    })))
}

#[derive(Debug, Deserialize)]
struct MkdirInput {
    path: String,
}

fn file_mutation_guard(path: &str) -> Result<workspace_activity::WorkspaceActivity, ApiError> {
    let path = files::resolve_safe_path(path).map_err(file_api_error)?;
    workspace_activity::enter(&path).map_err(|message| ApiError {
        status: StatusCode::CONFLICT,
        message,
    })
}

async fn mkdir(
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<MkdirInput>,
) -> Result<StatusCode, ApiError> {
    let _activity = file_mutation_guard(&input.path)?;
    files::create_directory(&input.path)
        .await
        .map_err(file_api_error)?;
    Ok(StatusCode::CREATED)
}

async fn upload_file(
    Extension(_user): Extension<AuthenticatedUser>,
    mut multipart: axum_extra::extract::Multipart,
) -> Result<Json<Value>, ApiError> {
    let mut file_path = None;
    let mut files_to_upload: Vec<(String, Option<String>, Vec<u8>)> = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("Multipart error: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "path" {
            file_path = Some(
                field
                    .text()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("Failed to read path: {e}")))?,
            );
        } else if name == "file" || name == "files" {
            let filename = field.file_name().map(str::to_string);
            let data = field
                .bytes()
                .await
                .map_err(|e| ApiError::bad_request(format!("Failed to read file: {e}")))?;
            if data.len() > 100 * 1024 * 1024 {
                return Err(ApiError::bad_request("File exceeds 100MB limit"));
            }
            files_to_upload.push((name, filename, data.to_vec()));
        }
    }

    let path = file_path.ok_or_else(|| ApiError::bad_request("Missing path field"))?;
    if files_to_upload.is_empty() {
        return Err(ApiError::bad_request("Missing file field"));
    }

    let mut planned_uploads = Vec::new();
    for (field_name, filename, data) in files_to_upload {
        let target_path = if field_name == "files" {
            let filename = filename.ok_or_else(|| ApiError::bad_request("Missing filename"))?;
            upload_target_path(&path, &filename)?
        } else {
            path.clone()
        };
        planned_uploads.push((target_path, data));
    }
    let _activities = planned_uploads
        .iter()
        .map(|(target, _)| file_mutation_guard(target))
        .collect::<Result<Vec<_>, _>>()?;
    let mut uploaded_paths = Vec::new();
    for (target_path, data) in planned_uploads {
        files::write_file(&target_path, &data)
            .await
            .map_err(file_api_error)?;
        uploaded_paths.push(target_path);
    }

    Ok(Json(json!({
        "success": true,
        "path": uploaded_paths.first().cloned().unwrap_or(path),
        "files": uploaded_paths
    })))
}

async fn download_file(
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<FilePathQuery>,
) -> Result<axum::response::Response, ApiError> {
    match files::read_download_file(&query.path).await {
        Ok(data) => {
            let filename = download_filename(FsPath::new(&query.path), "download");
            let content_length = data.len().to_string();
            return Ok((
                [
                    (
                        axum::http::header::CONTENT_TYPE,
                        "application/octet-stream".to_string(),
                    ),
                    (
                        axum::http::header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"{filename}\""),
                    ),
                    (axum::http::header::CONTENT_LENGTH, content_length),
                ],
                Body::from(data),
            )
                .into_response());
        }
        Err(message) if message == "Path is not a file" => {}
        Err(message) => return Err(file_api_error(message)),
    }

    let folder_name = format!(
        "{}.zip",
        download_filename(FsPath::new(&query.path), "download")
    );
    let file = tokio::task::spawn_blocking(move || files::create_zip_archive_file(&query.path))
        .await
        .map_err(|e| ApiError::internal(format!("ZIP task failed: {e}")))?
        .map_err(file_api_error)?;
    let stream = ReaderStream::new(tokio::fs::File::from_std(file));

    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                "application/zip".to_string(),
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{folder_name}\""),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
struct DeleteFileInput {
    path: String,
}

async fn delete_file(
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<DeleteFileInput>,
) -> Result<StatusCode, ApiError> {
    let _activity = file_mutation_guard(&input.path)?;
    files::delete_path(&input.path)
        .await
        .map_err(file_api_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameInput {
    #[serde(alias = "oldPath")]
    from: String,
    #[serde(alias = "newPath")]
    to: String,
}

async fn rename_file(
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<RenameInput>,
) -> Result<StatusCode, ApiError> {
    let _source_activity = file_mutation_guard(&input.from)?;
    let _target_activity = file_mutation_guard(&input.to)?;
    files::rename_path(&input.from, &input.to)
        .await
        .map_err(file_api_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnzipInput {
    path: Option<String>,
    zip_path: Option<String>,
    target: Option<String>,
    extract_to: Option<String>,
}

async fn unzip_file(
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<UnzipInput>,
) -> Result<Json<Value>, ApiError> {
    let zip_path = input
        .zip_path
        .or(input.path)
        .ok_or_else(|| ApiError::bad_request("zipPath is required"))?;
    let target = input.target.or(input.extract_to).unwrap_or_else(|| {
        FsPath::new(&zip_path)
            .parent()
            .and_then(|parent| parent.to_str())
            .filter(|parent| !parent.is_empty())
            .unwrap_or(".")
            .to_string()
    });
    let _activity = file_mutation_guard(&target)?;
    let count = files::extract_zip(&zip_path, &target)
        .await
        .map_err(file_api_error)?;
    Ok(Json(
        json!({ "success": true, "extracted": count, "extractedTo": target }),
    ))
}

fn screenshot_extension(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

async fn upload_screenshot(
    Extension(_user): Extension<AuthenticatedUser>,
    mut multipart: axum_extra::extract::Multipart,
) -> Result<Json<Value>, ApiError> {
    let mut file_path = None;
    let mut file_data = None;
    let mut detected_mime = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("Multipart error: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "path" {
            file_path = Some(
                field
                    .text()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("Failed to read path: {e}")))?,
            );
        } else if name == "file" || name == "image" {
            let data = field
                .bytes()
                .await
                .map_err(|e| ApiError::bad_request(format!("Failed to read file: {e}")))?;
            if data.len() > 10 * 1024 * 1024 {
                return Err(ApiError::bad_request("Image exceeds 10MB limit"));
            }
            let mime = files::detect_image_mime(&data);
            if mime.is_none() {
                return Err(ApiError::bad_request(
                    "File is not a recognized image format",
                ));
            }
            detected_mime = mime;
            file_data = Some(data);
        }
    }

    let data = file_data.ok_or_else(|| ApiError::bad_request("Missing image field"))?;
    let path = file_path.unwrap_or_else(|| {
        let ext = screenshot_extension(detected_mime.unwrap_or("image/png"));
        format!("~/screenshots/screenshot-{}.{ext}", Uuid::new_v4())
    });

    let _activity = file_mutation_guard(&path)?;
    files::write_file(&path, &data)
        .await
        .map_err(file_api_error)?;
    Ok(Json(json!({ "success": true, "path": path })))
}

const ATTACHMENT_LIMIT: usize = 25 * 1024 * 1024;

/// A safe file name for an uploaded attachment: no folders, no hidden or control characters.
fn attachment_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
}

/// Any file attached to an agent message (PDFs, logs, documents); the agent receives its path.
async fn upload_attachment(
    Extension(_user): Extension<AuthenticatedUser>,
    mut multipart: axum_extra::extract::Multipart,
) -> Result<Json<Value>, ApiError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("Multipart error: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let name = attachment_name(field.file_name().unwrap_or("attachment"));
        let data = field
            .bytes()
            .await
            .map_err(|e| ApiError::bad_request(format!("Failed to read file: {e}")))?;
        if data.len() > ATTACHMENT_LIMIT {
            return Err(ApiError::bad_request("Attachments are limited to 25 MB"));
        }
        let path = format!("~/terminal-v4-uploads/{}/{name}", Uuid::new_v4());
        let _activity = file_mutation_guard(&path)?;
        files::write_file(&path, &data)
            .await
            .map_err(file_api_error)?;
        let absolute = files::resolve_safe_path(&path).map_err(ApiError::bad_request)?;
        return Ok(Json(
            json!({ "path": absolute.to_string_lossy(), "name": name }),
        ));
    }
    Err(ApiError::bad_request("Missing file field"))
}

async fn download_directory(
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<FilePathQuery>,
) -> Result<axum::response::Response, ApiError> {
    let file = tokio::task::spawn_blocking(move || files::create_zip_archive_file(&query.path))
        .await
        .map_err(|e| ApiError::internal(format!("ZIP task failed: {e}")))?
        .map_err(file_api_error)?;
    let stream = ReaderStream::new(tokio::fs::File::from_std(file));

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/zip"),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"download.zip\"",
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

fn file_api_error(message: String) -> ApiError {
    let status = if message.starts_with("Destination exists:") {
        StatusCode::CONFLICT
    } else if message.starts_with("Access denied") {
        StatusCode::FORBIDDEN
    } else if message.starts_with("Path not found") || message.starts_with("Cannot resolve") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };

    ApiError { status, message }
}

// --- Preview handlers ---

#[derive(Debug, Deserialize)]
struct PreviewFileQuery {
    path: String,
    file: Option<String>,
    token: Option<String>,
    #[serde(rename = "previewToken")]
    preview_token: Option<String>,
}

async fn get_preview_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<PreviewFileQuery>,
) -> Result<axum::response::Response, ApiError> {
    let parent = query
        .preview_token
        .as_deref()
        .or(query.token.as_deref())
        .or_else(|| {
            headers
                .get(axum::http::header::COOKIE)
                .and_then(|header| header.to_str().ok())
                .and_then(|header| {
                    header
                        .split(';')
                        .find_map(|cookie| cookie.trim().strip_prefix("terminal_preview_token="))
                })
        });
    if let Some(token) = preview::auth_urls::selected_resource_token(
        &state,
        &headers,
        query.preview_token.as_deref(),
    ) {
        if !preview::auth_urls::resource_root_allowed(&state, &token, &query.path) {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                message: "Preview resource credential is outside its project scope".into(),
            });
        }
    }
    let resource = parent.and_then(|token| {
        preview::auth_urls::resource_token_for_root(
            &state,
            token,
            "/api/preview",
            Some(&query.path),
        )
    });
    let file = preview::static_files::load_preview_file(&query.path, query.file.as_deref())
        .await
        .map_err(|message| {
            let status = if message.starts_with("Access denied") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::NOT_FOUND
            };
            ApiError { status, message }
        })?;

    let token = resource.as_deref().map(|token| ("previewToken", token));
    let bytes = preview::static_rewrite::rewrite_static_content(
        file.content_type,
        file.bytes,
        &query.path,
        &file.relative_file,
        token,
    );

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, file.content_type),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
            (
                axum::http::header::CONTENT_SECURITY_POLICY,
                preview::DOCUMENT_SANDBOX,
            ),
        ],
        bytes,
    )
        .into_response())
}

async fn get_preview_cookies(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> Result<Json<Value>, ApiError> {
    let cookies = preview_cookies_for_user(&state, &user.user_id, port).await;
    Ok(Json(json!({
        "cookies": cookies,
        "hasCookies": !cookies.is_empty(),
    })))
}

async fn clear_preview_cookies(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> StatusCode {
    clear_preview_cookies_for_user(&state, &user.user_id, port).await;
    StatusCode::NO_CONTENT
}

#[derive(Debug, Deserialize)]
struct ProxyLogQuery {
    since: Option<i64>,
}

async fn get_preview_proxy_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Query(query): Query<ProxyLogQuery>,
) -> Result<Json<Value>, ApiError> {
    let logs = preview_proxy_logs_for_user(&state, &user.user_id, port, query.since).await;
    Ok(Json(json!({ "port": port, "logs": logs })))
}

async fn clear_preview_proxy_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> Json<Value> {
    clear_preview_proxy_logs_for_user(&state, &user.user_id, port).await;
    Json(json!({ "success": true, "port": port }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewWebSocketQuery {
    connection_id: Option<String>,
    direction: Option<String>,
}

async fn get_preview_websockets(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Query(query): Query<PreviewWebSocketQuery>,
) -> Result<Json<preview::ws_logs::Snapshot>, ApiError> {
    if query
        .direction
        .as_deref()
        .is_some_and(|direction| !matches!(direction, "sent" | "received"))
    {
        return Err(ApiError::bad_request("direction must be sent or received"));
    }
    Ok(Json(state.preview_log_store().websockets().snapshot(
        &user.user_id,
        port,
        query.connection_id.as_deref(),
        query.direction.as_deref(),
    )))
}

async fn clear_preview_websockets(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> StatusCode {
    state
        .preview_log_store()
        .websockets()
        .clear(&user.user_id, port);
    StatusCode::NO_CONTENT
}

async fn get_preview_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Query(query): Query<PreviewLogQuery>,
) -> Result<Json<Value>, ApiError> {
    let logs = state
        .preview_log_store()
        .get_logs(
            &user.user_id,
            port,
            query.log_type.as_deref(),
            query.level.as_deref(),
            query.since,
            query.limit,
        )
        .await;
    Ok(Json(json!({ "logs": logs })))
}

#[derive(Debug, Deserialize)]
struct PreviewLogQuery {
    #[serde(rename = "type")]
    log_type: Option<String>,
    level: Option<String>,
    since: Option<i64>,
    limit: Option<usize>,
}

async fn ingest_preview_log(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Json(entries): Json<Vec<preview::logs::PreviewLogEntry>>,
) -> StatusCode {
    for entry in entries {
        state
            .preview_log_store()
            .add_log(&user.user_id, port, entry)
            .await;
    }
    StatusCode::OK
}

async fn clear_preview_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> StatusCode {
    state
        .preview_log_store()
        .clear_logs(&user.user_id, port)
        .await;
    StatusCode::NO_CONTENT
}

async fn list_preview_log_ports(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let ports = state.preview_log_store().active_ports(&user.user_id).await;
    let entries: Vec<Value> = ports
        .into_iter()
        .map(|(port, count)| json!({ "port": port, "logCount": count }))
        .collect();
    Ok(Json(json!({ "ports": entries })))
}

async fn get_active_preview_ports_scan(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let ports = state.port_scanner().get_active_ports().await;
    Ok(Json(json!({ "ports": ports })))
}

#[derive(Debug, Deserialize)]
struct PreviewLogStreamQuery {
    since: Option<i64>,
    types: Option<String>,
    #[serde(rename = "proxyAfter")]
    proxy_after: Option<String>,
}

async fn stream_preview_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Query(query): Query<PreviewLogStreamQuery>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let requested_types = query
        .types
        .as_deref()
        .unwrap_or("proxy,server")
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let include_proxy =
        requested_types.is_empty() || requested_types.iter().any(|value| value == "proxy");
    let include_server =
        requested_types.is_empty() || requested_types.iter().any(|value| value == "server");
    let poll_ms = preview_log_stream_poll_ms();
    let initial_since = query.since.unwrap_or(0).max(0);
    let initial_proxy_cursor = preview::request_logs::LogCursor::for_resume(
        initial_since,
        query.proxy_after.as_deref().or_else(|| {
            headers
                .get("last-event-id")
                .and_then(|value| value.to_str().ok())
        }),
    )
    .map_err(ApiError::bad_request)?;

    let request_log_store = state.request_log_store().clone();
    let process_manager = state.process_manager().clone();
    let user_id = user.user_id.clone();
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(64);

    tokio::spawn(async move {
        let mut proxy_cursor = initial_proxy_cursor;
        let mut process_cursor = processes::LogCursor {
            timestamp: initial_since,
            id: None,
        };
        let mut last_ping_at = now_millis();

        loop {
            if include_proxy {
                let entries = preview_proxy_logs_after_cursor_for_user(
                    &request_log_store,
                    &user_id,
                    port,
                    proxy_cursor.clone(),
                )
                .await;
                for entry in entries {
                    proxy_cursor = preview::request_logs::LogCursor {
                        timestamp: entry.timestamp,
                        id: Some(entry.id.clone()),
                    };
                    if tx
                        .send(Ok(Event::default()
                            .event("proxy")
                            .id(entry.id.clone())
                            .data(
                                serde_json::to_string(&entry).unwrap_or_else(|_| "{}".to_string()),
                            )))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }

            if include_server {
                if let Some(entries) = process_manager
                    .get_logs_by_port_after_cursor(port, process_cursor.clone())
                    .await
                {
                    for entry in entries {
                        process_cursor = processes::LogCursor {
                            timestamp: entry.timestamp,
                            id: Some(entry.id.clone()),
                        };
                        if tx
                            .send(Ok(Event::default().event("server").data(
                                serde_json::to_string(&entry).unwrap_or_else(|_| "{}".to_string()),
                            )))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }

            if now_millis() - last_ping_at >= 15_000 {
                last_ping_at = now_millis();
                if tx
                    .send(Ok(Event::default()
                        .event("ping")
                        .data(json!({ "ts": last_ping_at }).to_string())))
                    .await
                    .is_err()
                {
                    return;
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(poll_ms)).await;
        }
    });

    Ok(Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15))))
}

#[derive(Debug, Deserialize)]
struct ExternalProxyQuery {
    url: String,
    #[serde(rename = "previewToken")]
    preview_token: Option<String>,
}

async fn proxy_external_url(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<ExternalProxyQuery>,
) -> Result<axum::response::Response, ApiError> {
    let target =
        preview::external_proxy::normalized_target(&query.url).map_err(ApiError::bad_request)?;
    let selected_resource = preview::auth_urls::selected_resource_token(
        &state,
        &headers,
        query.preview_token.as_deref(),
    );
    if let Some(token) = selected_resource.as_deref() {
        if !preview::auth_urls::resource_root_allowed(&state, token, &target) {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                message: "Preview resource credential is outside its URL scope".into(),
            });
        }
    }
    let resp = preview::external_proxy::proxy_external(&query.url)
        .await
        .map_err(ApiError::bad_request)?;

    let parent = selected_resource
        .as_deref()
        .or_else(|| {
            headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        })
        .or(query.preview_token.as_deref())
        .or_else(|| {
            headers
                .get(axum::http::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value
                        .split(';')
                        .find_map(|cookie| cookie.trim().strip_prefix("terminal_preview_token="))
                })
        });
    let resource = parent
        .and_then(|parent| {
            preview::auth_urls::resource_token_for_root(
                &state,
                parent,
                "/api/proxy-external",
                Some(&target),
            )
        })
        .ok_or_else(|| {
            ApiError::bad_request("External preview requires a scoped resource credential")
        })?;
    let origin = request_origin(&headers).unwrap_or_else(|| {
        std::env::var("API_ORIGIN").unwrap_or_else(|_| "http://localhost:3020".into())
    });
    let body = preview::external_proxy::authorize_external_dependencies(
        &resp.content_type,
        resp.body,
        &resp.final_url,
        &origin,
        |target| preview::auth_urls::external_dependency_token(&state, &resource, target),
    )
    .map_err(ApiError::bad_request)?;
    Ok((
        StatusCode::from_u16(resp.status).unwrap_or(StatusCode::BAD_GATEWAY),
        [
            (axum::http::header::CONTENT_TYPE, resp.content_type),
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".into()),
            (
                axum::http::header::CONTENT_SECURITY_POLICY,
                preview::DOCUMENT_SANDBOX.into(),
            ),
        ],
        body,
    )
        .into_response())
}

// External logs share the same store on a virtual port (65535)
const EXTERNAL_LOG_PORT: u16 = 65535;

async fn get_external_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let logs = state
        .preview_log_store()
        .get_logs(&user.user_id, EXTERNAL_LOG_PORT, None, None, None, None)
        .await;
    Ok(Json(json!({ "logs": logs })))
}

async fn ingest_external_log(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(entries): Json<Vec<preview::logs::PreviewLogEntry>>,
) -> StatusCode {
    for entry in entries {
        state
            .preview_log_store()
            .add_log(&user.user_id, EXTERNAL_LOG_PORT, entry)
            .await;
    }
    StatusCode::OK
}

async fn clear_external_logs(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> StatusCode {
    state
        .preview_log_store()
        .clear_logs(&user.user_id, EXTERNAL_LOG_PORT)
        .await;
    StatusCode::NO_CONTENT
}

async fn dev_proxy_handler(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let query = request
        .uri()
        .query()
        .map(|value| format!("/?{value}"))
        .unwrap_or_else(|| "/".to_string());
    dev_proxy_inner(state, &user.user_id, port, query, request).await
}

async fn dev_proxy_handler_path(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((port, rest)): Path<(u16, String)>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let path = request
        .uri()
        .query()
        .map(|value| format!("/{rest}?{value}"))
        .unwrap_or_else(|| format!("/{rest}"));
    dev_proxy_inner(state, &user.user_id, port, path, request).await
}

async fn dev_proxy_ws_handler_root(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let path = request
        .uri()
        .query()
        .map(|value| format!("/?{value}"))
        .unwrap_or_else(|| "/".to_string());
    dev_proxy_ws_inner(state, user.user_id, port, path, ws, request).await
}

async fn dev_proxy_ws_handler_path(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((port, rest)): Path<(u16, String)>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let path = request
        .uri()
        .query()
        .map(|value| format!("/{rest}?{value}"))
        .unwrap_or_else(|| format!("/{rest}"));
    dev_proxy_ws_inner(state, user.user_id, port, path, ws, request).await
}

async fn read_preview_request_body(body: axum::body::Body) -> Result<Vec<u8>, ApiError> {
    axum::body::to_bytes(body, 10 * 1024 * 1024)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|_| ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: "Preview request body could not be buffered within the 10 MiB limit"
                .to_string(),
        })
}

fn dev_proxy_forwarded_path(request: &axum::extract::Request, path: &str) -> String {
    let path = preview::auth_urls::strip_preview_token(path);
    if request
        .extensions()
        .get::<auth::QueryAccessTokenUsed>()
        .is_some()
    {
        preview::auth_urls::strip_query_key(&path, "token")
    } else {
        path
    }
}

async fn dev_proxy_inner(
    state: AppState,
    user_id: &str,
    port: u16,
    path: String,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let started_at = now_millis();
    let method = request.method().as_str().to_string();
    let path = dev_proxy_forwarded_path(&request, &path);
    let mut headers = request.headers().clone();
    let auth_token = preview_request_token(&request);
    let ws_proxy_origin = websocket_proxy_origin(&headers);
    for name in [
        axum::http::header::AUTHORIZATION,
        axum::http::header::COOKIE,
        axum::http::header::REFERER,
    ] {
        headers.remove(name);
    }
    if let Some(cookie) = state
        .cookie_store()
        .get_cookie_header_for_request(user_id, port, "localhost", &path)
        .await
    {
        if let Ok(value) = cookie.parse() {
            headers.insert(axum::http::header::COOKIE, value);
        }
    }
    let body = Some(read_preview_request_body(request.into_body()).await?);
    let request_size = body.as_ref().map(Vec::len);

    let api_origin = preview_api_origin(&headers);

    match preview::dev_proxy::proxy_dev_request(
        port,
        &path,
        &method,
        &headers,
        body,
        &api_origin,
        ws_proxy_origin.as_deref(),
        auth_token.as_deref(),
    )
    .await
    {
        Ok(mut resp) => {
            for cookie in resp
                .headers
                .get_all(axum::http::header::SET_COOKIE)
                .iter()
                .filter_map(|v| v.to_str().ok())
            {
                state
                    .cookie_store()
                    .store_from_set_cookie_for_request(user_id, port, "localhost", &path, cookie)
                    .await;
            }
            resp.headers.remove(axum::http::header::SET_COOKIE);
            let status = StatusCode::from_u16(resp.status).unwrap_or(StatusCode::BAD_GATEWAY);
            let status_text = status.canonical_reason().map(str::to_string);
            let content_type = resp
                .headers
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let response_size = Some(resp.body.len());
            state
                .request_log_store()
                .add_log(
                    user_id,
                    port,
                    preview::request_logs::ProxyLogInput {
                        timestamp: started_at,
                        method: method.clone(),
                        url: format!("http://localhost:{port}{path}"),
                        status: Some(resp.status),
                        status_text,
                        duration: now_millis() - started_at,
                        request_size,
                        response_size,
                        content_type,
                        error: None,
                    },
                )
                .await;

            Ok(preview::proxy::into_axum_response(resp))
        }
        Err(error) => {
            state
                .request_log_store()
                .add_log(
                    user_id,
                    port,
                    preview::request_logs::ProxyLogInput {
                        timestamp: started_at,
                        method,
                        url: format!("http://localhost:{port}{path}"),
                        status: None,
                        status_text: None,
                        duration: now_millis() - started_at,
                        request_size,
                        response_size: None,
                        content_type: None,
                        error: Some(error.clone()),
                    },
                )
                .await;
            Err(ApiError::internal(error))
        }
    }
}

async fn dev_proxy_ws_inner(
    state: AppState,
    owner: String,
    port: u16,
    path: String,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let ws = ws.map_err(|_| ApiError::bad_request("WebSocket upgrade required"))?;
    let path = dev_proxy_forwarded_path(&request, &path);
    let cookie_header = state
        .cookie_store()
        .get_cookie_header_for_request(&owner, port, "localhost", &path)
        .await;
    let mut request_headers = request.headers().clone();
    request_headers.remove(axum::http::header::AUTHORIZATION);
    let prepared = preview::ws_proxy::prepare_websocket(
        &state.preview_log_store().websockets(),
        &owner,
        port,
        &path,
        &request_headers,
        cookie_header.as_deref(),
    )
    .await
    .map_err(|message| ApiError {
        status: StatusCode::BAD_GATEWAY,
        message,
    })?;
    let ws = ws.protocols(prepared.selected_protocol().map(str::to_owned));
    Ok(ws
        .on_upgrade(move |socket| async move {
            let _ = prepared.relay(socket).await;
        })
        .into_response())
}

async fn preview_proxy_root(
    State(state): State<AppState>,
    Path(port): Path<u16>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let path = request
        .uri()
        .query()
        .map(|value| format!("/?{value}"))
        .unwrap_or_else(|| "/".to_string());
    preview_proxy_inner(state, port, path, request, ws).await
}

async fn preview_proxy_path(
    State(state): State<AppState>,
    Path((port, rest)): Path<(u16, String)>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let path = request
        .uri()
        .query()
        .map(|value| format!("/{rest}?{value}"))
        .unwrap_or_else(|| format!("/{rest}"));
    preview_proxy_inner(state, port, path, request, ws).await
}

async fn preview_proxy_inner(
    state: AppState,
    port: u16,
    path: String,
    request: axum::extract::Request,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<axum::response::Response, ApiError> {
    preview_proxy_response(state, port, path, request, ws, PreviewRewriteMode::Path).await
}

async fn preview_subdomain_proxy_inner(
    state: AppState,
    port: u16,
    path: String,
    request: axum::extract::Request,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<axum::response::Response, ApiError> {
    let preview_origin =
        request_origin(request.headers()).unwrap_or_else(|| "http://localhost:3020".to_string());
    let websocket_origin = websocket_proxy_origin(request.headers());
    preview_proxy_response(
        state,
        port,
        path,
        request,
        ws,
        PreviewRewriteMode::Subdomain {
            preview_origin,
            websocket_origin,
        },
    )
    .await
}

enum PreviewRewriteMode {
    Path,
    Subdomain {
        preview_origin: String,
        websocket_origin: Option<String>,
    },
}

async fn preview_proxy_response(
    state: AppState,
    port: u16,
    path: String,
    request: axum::extract::Request,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    rewrite_mode: PreviewRewriteMode,
) -> Result<axum::response::Response, ApiError> {
    let preview_user = authenticate_preview_request_user(&state, &request, port)?;
    let resource_prefix = format!("/preview/{port}");
    let resource = preview_request_token(&request)
        .and_then(|token| preview::auth_urls::resource_token(&state, &token, &resource_prefix));
    let origin =
        request_origin(request.headers()).unwrap_or_else(|| "http://localhost:3020".into());
    let document_url = match &rewrite_mode {
        PreviewRewriteMode::Path => format!("{origin}{resource_prefix}{path}"),
        PreviewRewriteMode::Subdomain { preview_origin, .. } => format!("{preview_origin}{path}"),
    };
    let path = preview::auth_urls::strip_preview_token(&path);
    let scope_user_id = preview_user.user_id.clone();
    let cookie_header = state
        .cookie_store()
        .get_cookie_header_for_request(&scope_user_id, port, "localhost", &path)
        .await;
    if ws.is_ok()
        && preview_request_token(&request)
            .as_deref()
            .is_some_and(|token| preview::auth_urls::is_resource_token(&state, token))
    {
        return Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Resource credentials cannot control preview WebSockets".into(),
        });
    }
    if let Ok(ws) = ws {
        let credential = request
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned)
            .or_else(|| preview_request_token(&request))
            .unwrap_or_default();
        if credential.starts_with("tv4pair.")
            && !auth::runtime_message_allowed(&state, &credential, false, "input")
        {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                message: "Preview WebSocket control requires terminal input permission".into(),
            });
        }
        let authorization_path = preview_auth_route_path(&request).to_string();
        let mut request_headers = request.headers().clone();
        request_headers.remove(axum::http::header::AUTHORIZATION);
        let telemetry = state.preview_log_store().websockets();
        let prepared = tokio::select! {
            _ = wait_for_preview_revocation(&state, &credential, &authorization_path) => {
                return Err(ApiError { status: StatusCode::UNAUTHORIZED, message: "Invalid or expired preview session".into() });
            },
            result = preview::ws_proxy::prepare_websocket(&telemetry, &scope_user_id, port, &path, &request_headers, cookie_header.as_deref()) => {
                result.map_err(|message| ApiError { status: StatusCode::BAD_GATEWAY, message })?
            },
        };
        let ws = ws.protocols(prepared.selected_protocol().map(str::to_owned));
        return Ok(ws
            .on_upgrade(move |socket| async move {
                tokio::select! {
                    _ = wait_for_preview_revocation(&state, &credential, &authorization_path) => {},
                    _ = prepared.relay(socket) => {},
                }
            })
            .into_response());
    }

    let started_at = now_millis();
    let method = request.method().as_str().to_string();
    let mut headers = request.headers().clone();
    headers.remove(axum::http::header::COOKIE);
    headers.remove(axum::http::header::AUTHORIZATION);
    headers.remove(axum::http::header::REFERER);
    populate_forward_headers(&mut headers);
    let body = Some(read_preview_request_body(request.into_body()).await?);
    let request_size = body.as_ref().map(Vec::len);

    if let Some(cookie_header) = cookie_header {
        if let Ok(value) = axum::http::HeaderValue::from_str(&cookie_header) {
            headers.insert(axum::http::header::COOKIE, value);
        }
    }

    let api_origin = preview_api_origin(&headers);
    let hosts = preview::proxy_hosts();

    match preview::proxy::proxy_request(port, &path, &method, &headers, body, &hosts).await {
        Ok(mut response) => {
            let set_cookies = response
                .headers
                .get_all(axum::http::header::SET_COOKIE)
                .iter()
                .filter_map(|value| value.to_str().ok().map(str::to_string))
                .collect::<Vec<_>>();
            for cookie in set_cookies {
                state
                    .cookie_store()
                    .store_from_set_cookie_for_request(
                        &scope_user_id,
                        port,
                        "localhost",
                        &path,
                        &cookie,
                    )
                    .await;
            }
            response.headers.remove(axum::http::header::SET_COOKIE);

            let content_type = response
                .headers
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);

            if let Some(content_type) = content_type.as_deref() {
                if preview::script_inject::is_html_content_type(content_type) {
                    if let Ok(html) = String::from_utf8(response.body.clone()) {
                        let rewritten = match &rewrite_mode {
                            PreviewRewriteMode::Path => {
                                preview::path_rewrite::rewrite_html_for_path_preview_at_path(
                                    &html,
                                    port,
                                    &api_origin,
                                    &path,
                                )
                            }
                            PreviewRewriteMode::Subdomain {
                                preview_origin,
                                websocket_origin,
                            } => preview::host_rewrite::rewrite_html_for_subdomain_preview(
                                &html,
                                port,
                                &api_origin,
                                preview_origin,
                                websocket_origin.as_deref(),
                            ),
                        };
                        let controller = resource.as_deref().and_then(|token| {
                            preview::auth_urls::resource_controller(&state, token, &resource_prefix)
                        });
                        response.body = preview::script_inject::bind_controller(
                            &rewritten,
                            controller.as_ref(),
                        )
                        .into_bytes();
                        update_proxy_response_length(&mut response);
                    }
                } else if is_css_content_type(content_type, &path) {
                    if let Ok(css) = String::from_utf8(response.body.clone()) {
                        let rewritten = match &rewrite_mode {
                            PreviewRewriteMode::Path => {
                                preview::path_rewrite::rewrite_css_for_path_preview(&css, port)
                            }
                            PreviewRewriteMode::Subdomain { preview_origin, .. } => {
                                preview::host_rewrite::rewrite_css_for_subdomain_preview(
                                    &css,
                                    port,
                                    preview_origin,
                                )
                            }
                        };
                        response.body = rewritten.into_bytes();
                        update_proxy_response_length(&mut response);
                    }
                } else if is_javascript_content_type(content_type, &path) {
                    if let Ok(script) = String::from_utf8(response.body.clone()) {
                        let rewritten = match &rewrite_mode {
                            PreviewRewriteMode::Path => {
                                preview::path_rewrite::rewrite_script_for_path_preview(
                                    &script, port,
                                )
                            }
                            PreviewRewriteMode::Subdomain {
                                preview_origin,
                                websocket_origin,
                            } => preview::host_rewrite::rewrite_script_for_subdomain_preview(
                                &script,
                                port,
                                preview_origin,
                                websocket_origin.as_deref(),
                            ),
                        };
                        response.body = rewritten.into_bytes();
                        update_proxy_response_length(&mut response);
                    }
                }
            }
            if let (Some(token), Some(content_type)) =
                (resource.as_deref(), content_type.as_deref())
            {
                if let Ok(content) = std::str::from_utf8(&response.body) {
                    let prefix = if matches!(rewrite_mode, PreviewRewriteMode::Path) {
                        resource_prefix.as_str()
                    } else {
                        "/"
                    };
                    response.body = preview::auth_urls::authorize_resources(
                        content,
                        content_type,
                        &document_url,
                        prefix,
                        token,
                    )
                    .into_bytes();
                    update_proxy_response_length(&mut response);
                }
            }

            response.headers.insert(
                axum::http::header::CONTENT_SECURITY_POLICY,
                axum::http::HeaderValue::from_static(preview::DOCUMENT_SANDBOX),
            );
            let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::BAD_GATEWAY);
            state
                .request_log_store()
                .add_log(
                    &scope_user_id,
                    port,
                    preview::request_logs::ProxyLogInput {
                        timestamp: started_at,
                        method: method.clone(),
                        url: format!("http://localhost:{port}{path}"),
                        status: Some(response.status),
                        status_text: status.canonical_reason().map(str::to_string),
                        duration: now_millis() - started_at,
                        request_size,
                        response_size: Some(response.body.len()),
                        content_type,
                        error: None,
                    },
                )
                .await;

            Ok(preview::proxy::into_axum_response(response))
        }
        Err(error) => {
            state
                .request_log_store()
                .add_log(
                    &scope_user_id,
                    port,
                    preview::request_logs::ProxyLogInput {
                        timestamp: started_at,
                        method,
                        url: format!("http://localhost:{port}{path}"),
                        status: None,
                        status_text: None,
                        duration: now_millis() - started_at,
                        request_size,
                        response_size: None,
                        content_type: None,
                        error: Some(error.clone()),
                    },
                )
                .await;
            let wants_page = headers
                .get(axum::http::header::ACCEPT)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|accept| accept.contains("text/html"));
            if wants_page {
                return Ok(preview::proxy::unreachable_page(&error));
            }
            Err(ApiError {
                status: StatusCode::BAD_GATEWAY,
                message: error,
            })
        }
    }
}

#[derive(Debug, Deserialize)]
struct PreviewStorageUpdate {
    #[serde(rename = "type")]
    storage_type: String,
    operation: String,
    key: Option<String>,
    value: Option<String>,
    entries: Option<std::collections::HashMap<String, String>>,
}

fn preview_client_required(action: &str) -> ApiError {
    ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        message: format!("Server-side preview {action} is unavailable. Use the loaded preview client; no operation was queued."),
    }
}

async fn get_preview_storage(
    Extension(_user): Extension<AuthenticatedUser>,
    Path(_port): Path<u16>,
) -> Result<Json<Value>, ApiError> {
    Err(preview_client_required("storage snapshots"))
}

async fn update_preview_storage(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Json(input): Json<PreviewStorageUpdate>,
) -> Result<Json<Value>, ApiError> {
    validate_preview_storage_update(&input)?;
    if input.storage_type != "cookies" {
        return Err(preview_client_required("browser storage changes"));
    }

    if input.storage_type == "cookies" {
        let validate = |name: &str, value: &str| {
            preview::cookie_jar::validate_cookie_entry(name, value).map_err(ApiError::bad_request)
        };
        match input.operation.as_str() {
            "set" => {
                let key = input.key.as_deref().unwrap_or_default();
                let value = input.value.as_deref().unwrap_or_default();
                validate(key, value)?;
                state
                    .cookie_store()
                    .set_cookie(&user.user_id, port, key, value)
                    .await;
            }
            "remove" => {
                let key = input.key.as_deref().unwrap_or_default();
                validate(key, "")?;
                state
                    .cookie_store()
                    .remove_cookie(&user.user_id, port, key)
                    .await;
            }
            "clear" => {
                state
                    .cookie_store()
                    .clear_cookies(&user.user_id, port)
                    .await
            }
            "import" => {
                let entries = input
                    .entries
                    .as_ref()
                    .expect("import entries validated above");
                for (key, value) in entries {
                    validate(key, value)?;
                }
                for (key, value) in entries {
                    state
                        .cookie_store()
                        .set_cookie(&user.user_id, port, key, value)
                        .await;
                }
            }
            _ => unreachable!("operation validated above"),
        }
    }

    Ok(Json(json!({
        "success": true,
        "port": port,
        "type": input.storage_type,
        "operation": input.operation
    })))
}

fn validate_preview_storage_update(input: &PreviewStorageUpdate) -> Result<(), ApiError> {
    let valid_types = ["localStorage", "sessionStorage", "cookies"];
    let valid_operations = ["set", "remove", "clear", "import"];

    if !valid_types.contains(&input.storage_type.as_str()) {
        return Err(ApiError::bad_request("Invalid storage type"));
    }
    if !valid_operations.contains(&input.operation.as_str()) {
        return Err(ApiError::bad_request("Invalid operation"));
    }

    if input.operation == "set" {
        let key = input
            .key
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("Missing or invalid key for set operation"))?;
        let value = input
            .value
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("Missing or invalid value for set operation"))?;
        validate_preview_storage_key(key)?;
        if value.len() > 100_000 {
            return Err(ApiError::bad_request("Value too long (max 100KB)"));
        }
    }

    if input.operation == "remove" {
        let key = input
            .key
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("Missing or invalid key for remove operation"))?;
        validate_preview_storage_key(key)?;
    }

    if input.operation == "import" {
        let entries = input.entries.as_ref().ok_or_else(|| {
            ApiError::bad_request("Missing or invalid entries for import operation")
        })?;
        for (key, value) in entries {
            validate_preview_storage_key(key)?;
            if value.len() > 100_000 {
                return Err(ApiError::bad_request("Imported value too long (max 100KB)"));
            }
        }
    }

    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum PreviewClientOperation {
    Evaluate { expression: String },
    Storage { storage: PreviewStorageUpdate },
}

async fn authorize_preview_client_operation(
    Extension(_user): Extension<AuthenticatedUser>,
    Path(_port): Path<u16>,
    Json(input): Json<PreviewClientOperation>,
) -> Result<Json<Value>, ApiError> {
    match input {
        PreviewClientOperation::Evaluate { expression } => {
            if !preview_eval_enabled() {
                return Err(ApiError {
                    status: StatusCode::FORBIDDEN,
                    message: "Preview eval endpoint is disabled".into(),
                });
            }
            validate_preview_expression(&expression)?;
        }
        PreviewClientOperation::Storage { storage } => {
            validate_preview_storage_update(&storage)?;
            if storage.storage_type == "cookies" {
                return Err(ApiError::bad_request(
                    "Use the server cookie storage endpoint for cookies",
                ));
            }
        }
    }
    Ok(Json(
        json!({"authorized":true,"executed":false,"delivery":"preview-client"}),
    ))
}

fn validate_preview_expression(expression: &str) -> Result<(), ApiError> {
    if expression.trim().is_empty() {
        return Err(ApiError::bad_request("Invalid expression"));
    }
    if expression.len() > 10_000 {
        return Err(ApiError::bad_request("Expression too long (max 10KB)"));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct PreviewEvaluateInput {
    expression: String,
}

async fn evaluate_preview(
    Extension(_user): Extension<AuthenticatedUser>,
    Path(_port): Path<u16>,
    Json(input): Json<PreviewEvaluateInput>,
) -> Result<Json<Value>, ApiError> {
    validate_preview_expression(&input.expression)?;
    Err(preview_client_required("JavaScript evaluation"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPerformanceInput {
    metrics: Vec<preview::performance::PerformanceMetricEntry>,
}

async fn get_preview_performance(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> Result<Json<Value>, ApiError> {
    let metrics = state
        .preview_performance_store()
        .get_metrics(&user.user_id, port)
        .await;
    Ok(Json(json!({ "port": port, "metrics": metrics })))
}

async fn ingest_preview_performance(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Json(input): Json<PreviewPerformanceInput>,
) -> Result<Json<Value>, ApiError> {
    if input.metrics.len() > 500 {
        return Err(ApiError::bad_request(
            "Too many performance metrics in one request",
        ));
    }

    state
        .preview_performance_store()
        .add_metrics(&user.user_id, port, input.metrics)
        .await
        .map_err(ApiError::bad_request)?;

    Ok(Json(json!({ "success": true, "port": port })))
}

async fn clear_preview_performance(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
) -> Json<Value> {
    state
        .preview_performance_store()
        .clear_metrics(&user.user_id, port)
        .await;
    Json(json!({ "success": true, "port": port }))
}

// --- WebContainer handler ---

#[derive(Debug, Deserialize)]
struct WebContainerQuery {
    path: String,
}

async fn get_webcontainer_files(
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<WebContainerQuery>,
) -> Result<Json<Value>, ApiError> {
    let root = files::resolve_existing_contained_path(&query.path).map_err(|_| ApiError {
        status: StatusCode::FORBIDDEN,
        message: "Project root is unavailable or outside allowed file roots".into(),
    })?;
    let path = root
        .to_str()
        .ok_or_else(|| ApiError::bad_request("Project root is not valid UTF-8"))?;
    let tree = webcontainer::get_file_tree(path)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(tree))
}

// --- Transcription handlers ---

#[derive(Debug, Deserialize)]
struct TranscribeHealthQuery {
    provider: Option<TranscribeProvider>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TranscribeProvider {
    Local,
    Groq,
}

impl TranscribeProvider {
    fn as_str(&self) -> &str {
        match self {
            Self::Local => "local",
            Self::Groq => "groq",
        }
    }
}

async fn transcribe_health(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<TranscribeHealthQuery>,
) -> Result<Json<Value>, ApiError> {
    let api_key = state
        .transcription_api_key(&user)
        .map_err(ApiError::internal)?;
    let health = transcribe::health_check(
        query.provider.as_ref().map(TranscribeProvider::as_str),
        api_key.as_deref(),
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::to_value(health).unwrap_or_default()))
}

async fn transcribe_audio(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<TranscribeHealthQuery>,
    multipart: axum_extra::extract::Multipart,
) -> Result<Json<Value>, ApiError> {
    let (data, filename) = read_transcription_audio(multipart).await?;
    let api_key = state
        .transcription_api_key(&user)
        .map_err(ApiError::internal)?;
    let result = transcribe::transcribe(
        data,
        &filename,
        api_key.as_deref(),
        query.provider.as_ref().map(TranscribeProvider::as_str),
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}
async fn read_transcription_audio(
    mut multipart: axum_extra::extract::Multipart,
) -> Result<(Vec<u8>, String), ApiError> {
    let mut audio_data = None;
    let mut filename = "audio.webm".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("Multipart error: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            if let Some(fname) = field.file_name() {
                filename = fname.to_string();
            }
            let data = field
                .bytes()
                .await
                .map_err(|e| ApiError::bad_request(format!("Read error: {e}")))?;
            if data.len() > 25 * 1024 * 1024 {
                return Err(ApiError::bad_request("Audio exceeds 25MB limit"));
            }
            audio_data = Some(data.to_vec());
        }
    }

    let data = audio_data.ok_or_else(|| ApiError::bad_request("No audio file provided"))?;
    Ok((data, filename))
}

#[cfg(test)]
mod transcription_contract_tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    #[tokio::test]
    async fn transcription_multipart_accepts_the_canonical_file_part() {
        let router = Router::new().route(
            "/",
            post(|multipart: axum_extra::extract::Multipart| async {
                let (data, filename) = read_transcription_audio(multipart).await?;
                Ok::<_, ApiError>(Json(
                    json!({ "filename": filename, "audio": String::from_utf8(data).unwrap() }),
                ))
            }),
        );
        for (part, expected_status) in
            [("file", StatusCode::OK), ("audio", StatusCode::BAD_REQUEST)]
        {
            let request = axum::http::Request::builder().method("POST").uri("/")
                .header("Content-Type", "multipart/form-data; boundary=fixture")
                .body(Body::from(format!("--fixture\r\nContent-Disposition: form-data; name=\"{part}\"; filename=\"fixture.webm\"\r\nContent-Type: audio/webm\r\n\r\nsynthetic-audio\r\n--fixture--\r\n"))).unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected_status);
            if part == "file" {
                let bytes = response.into_body().collect().await.unwrap().to_bytes();
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap(),
                    json!({ "filename": "fixture.webm", "audio": "synthetic-audio" })
                );
            }
        }
    }

    #[tokio::test]
    async fn transcription_health_uses_only_the_authenticated_users_saved_key() {
        let folder = tempfile::tempdir().unwrap();
        let state = AppState::new_with_external_auth(
            AppConfig {
                data_dir: folder.path().to_path_buf(),
                jwt_secret: "synthetic-transcription-secret".into(),
                ..AppConfig::default()
            },
            None,
        )
        .unwrap();
        let owner = AuthenticatedUser {
            user_id: "transcription-owner".into(),
            username: "synthetic-owner".into(),
        };
        let other = AuthenticatedUser {
            user_id: "transcription-other".into(),
            username: "synthetic-other".into(),
        };
        state
            .update_settings(
                &owner,
                state::SettingsPatch {
                    groq_api_key: state::FieldPatch::Value("synthetic-saved-key".into()),
                    ..state::SettingsPatch::default()
                },
            )
            .unwrap();
        assert_eq!(
            state.transcription_api_key(&owner).unwrap().as_deref(),
            Some("synthetic-saved-key")
        );
        assert_eq!(state.transcription_api_key(&other).unwrap(), None);
        assert_ne!(
            state.get_settings(&owner).unwrap().groq_api_key.as_deref(),
            Some("synthetic-saved-key")
        );
        let router = Router::new()
            .route("/api/transcribe/health", get(transcribe_health))
            .layer(Extension(owner))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/transcribe/health?provider=groq")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload,
            json!({ "available": true, "provider": "groq", "message": "OK" })
        );
        assert!(!String::from_utf8_lossy(&body).contains("synthetic-saved-key"));
    }
}

// --- Screenshot handlers ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotInput {
    selector: Option<String>,
    full_page: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingInput {
    width: Option<u32>,
    height: Option<u32>,
}

async fn take_preview_screenshot(
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Json(input): Json<ScreenshotInput>,
) -> Result<Json<Value>, ApiError> {
    let url = format!("http://localhost:{port}");
    let result = screenshots::take_screenshot(
        &user.user_id,
        &url,
        input.selector.as_deref(),
        input.full_page.unwrap_or(false),
        input.width,
        input.height,
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

async fn take_element_screenshot(
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Json(input): Json<ScreenshotInput>,
) -> Result<Json<Value>, ApiError> {
    let selector = input
        .selector
        .ok_or_else(|| ApiError::bad_request("selector is required"))?;
    let url = format!("http://localhost:{port}");
    let result = screenshots::take_screenshot(
        &user.user_id,
        &url,
        Some(&selector),
        false,
        input.width,
        input.height,
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

async fn start_preview_recording(
    Extension(user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Json(input): Json<RecordingInput>,
) -> Result<Json<Value>, ApiError> {
    let url = format!("http://localhost:{port}");
    let result = screenshots::start_recording(&user.user_id, &url, input.width, input.height)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({
        "success": true,
        "recordingId": result.recording_id,
        "started": result.started,
    })))
}

async fn stop_preview_recording(
    Extension(user): Extension<AuthenticatedUser>,
    Path(recording_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(result) = screenshots::stop_recording(&user.user_id, &recording_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Recording not found".to_string(),
        });
    };
    Ok(Json(json!({
        "success": true,
        "filename": result.filename,
        "duration": result.duration,
    })))
}

async fn list_screenshots_handler(
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let list = screenshots::list_screenshots(&user.user_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "screenshots": list })))
}

async fn get_screenshot_handler(
    Extension(user): Extension<AuthenticatedUser>,
    Path(filename): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let data = screenshots::get_screenshot(&user.user_id, &filename)
        .await
        .map_err(|e| ApiError {
            status: StatusCode::NOT_FOUND,
            message: e,
        })?;
    Ok(([(axum::http::header::CONTENT_TYPE, "image/png")], data).into_response())
}

async fn delete_screenshot_handler(
    Extension(user): Extension<AuthenticatedUser>,
    Path(filename): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = screenshots::delete_screenshot(&user.user_id, &filename)
        .await
        .map_err(ApiError::internal)?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Screenshot not found".to_string(),
        })
    }
}

// --- Process handlers ---

#[derive(Debug, Deserialize)]
struct ProcessListQuery {
    paths: Option<String>,
}

fn project_type_for_path(path: &str) -> &'static str {
    let project_path = FsPath::new(path);
    if project_path.join("package.json").exists() {
        return "node";
    }
    if project_path.join("requirements.txt").exists()
        || project_path.join("setup.py").exists()
        || project_path.join("pyproject.toml").exists()
    {
        return "python";
    }
    "unknown"
}

fn repo_name_for_path(path: &str) -> String {
    FsPath::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn normalized_path_string(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn process_is_in_repo(process_cwd: &str, repo_path: &str) -> bool {
    let process_cwd = normalized_path_string(process_cwd);
    let repo_path = normalized_path_string(repo_path);
    process_cwd == repo_path || process_cwd.starts_with(&format!("{repo_path}/"))
}

fn repo_process_payload(
    repo_paths: Vec<String>,
    processes: Vec<processes::ProcessInfo>,
) -> Vec<Value> {
    repo_paths
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            let name = repo_name_for_path(&path);
            let project_type = project_type_for_path(&path);
            let matching_processes: Vec<Value> = processes
                .iter()
                .filter(|process| process.running && process_is_in_repo(&process.cwd, &path))
                .map(|process| {
                    json!({
                        "pid": process.pid,
                        "port": process.port,
                        "command": &process.command,
                    })
                })
                .collect();
            json!({
                "path": path,
                "name": name,
                "projectType": project_type,
                "running": !matching_processes.is_empty(),
                "processes": matching_processes,
            })
        })
        .collect()
}

fn start_command_for_project(path: &str) -> Option<(String, Vec<String>)> {
    match project_type_for_path(path) {
        "node" => {
            let package_path = FsPath::new(path).join("package.json");
            if let Ok(package_text) = fs::read_to_string(package_path) {
                if let Ok(package_json) = serde_json::from_str::<Value>(&package_text) {
                    if package_json
                        .pointer("/scripts/start")
                        .and_then(Value::as_str)
                        .is_some()
                    {
                        return Some(("npm".to_string(), vec!["start".to_string()]));
                    }
                    if package_json
                        .pointer("/scripts/dev")
                        .and_then(Value::as_str)
                        .is_some()
                    {
                        return Some((
                            "npm".to_string(),
                            vec!["run".to_string(), "dev".to_string()],
                        ));
                    }
                }
            }
            Some(("npm".to_string(), vec!["start".to_string()]))
        }
        "python" => {
            let project_path = FsPath::new(path);
            if project_path.join("manage.py").exists() {
                Some((
                    "python".to_string(),
                    vec!["manage.py".to_string(), "runserver".to_string()],
                ))
            } else if project_path.join("app.py").exists() {
                Some(("python".to_string(), vec!["app.py".to_string()]))
            } else if project_path.join("main.py").exists() {
                Some(("python".to_string(), vec!["main.py".to_string()]))
            } else {
                None
            }
        }
        _ => None,
    }
}

async fn list_processes(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<ProcessListQuery>,
) -> Result<Json<Value>, ApiError> {
    let processes = state.process_manager().list_active().await;
    let repo_paths: Vec<String> = query
        .paths
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    if !repo_paths.is_empty() {
        return Ok(Json(json!({
            "repos": repo_process_payload(repo_paths, processes)
        })));
    }
    Ok(Json(json!({ "processes": processes })))
}

#[derive(Debug, Deserialize)]
struct StartProcessInput {
    path: Option<String>,
    cwd: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

async fn start_process(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<StartProcessInput>,
) -> Result<Json<Value>, ApiError> {
    let (cwd, command, args) = if let Some(path) = input.path {
        let (command, args) = start_command_for_project(&path).ok_or_else(|| {
            ApiError::bad_request(format!(
                "Cannot determine start command for {} project",
                project_type_for_path(&path)
            ))
        })?;
        (path, command, args)
    } else {
        (
            input
                .cwd
                .ok_or_else(|| ApiError::bad_request("cwd is required"))?,
            input
                .command
                .ok_or_else(|| ApiError::bad_request("command is required"))?,
            input.args,
        )
    };
    let args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let info = state
        .process_manager()
        .start(&cwd, &command, &args)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(
        json!({ "success": true, "pid": info.pid, "process": info }),
    ))
}

#[derive(Debug, Deserialize)]
struct StopProcessInput {
    pid: u32,
}

async fn stop_process(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<StopProcessInput>,
) -> Result<Json<Value>, ApiError> {
    let stopped = state
        .process_manager()
        .stop(input.pid)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "stopped": stopped })))
}

#[derive(Debug, Deserialize)]
struct ProcessLogQuery {
    since: Option<i64>,
}

async fn get_process_logs(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Path(pid): Path<u32>,
    Query(query): Query<ProcessLogQuery>,
) -> Result<Json<Value>, ApiError> {
    let logs = state
        .process_manager()
        .get_logs_by_pid(pid, query.since)
        .await
        .unwrap_or_default();
    Ok(Json(json!({ "logs": logs })))
}

async fn clear_process_logs(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Path(pid): Path<u32>,
) -> StatusCode {
    state.process_manager().clear_logs(pid).await;
    StatusCode::NO_CONTENT
}

async fn list_all_processes(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let processes = state.process_manager().list_all().await;
    Ok(Json(json!({ "processes": processes })))
}

async fn get_process_logs_by_port(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Path(port): Path<u16>,
    Query(query): Query<ProcessLogQuery>,
) -> Result<Json<Value>, ApiError> {
    let logs = state
        .process_manager()
        .get_logs_by_port(port, query.since)
        .await
        .unwrap_or_default();
    Ok(Json(json!({ "logs": logs })))
}

// --- System stats handlers ---

async fn get_system_stats(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let stats = state.stats_collector().get_current_with_processes().await;
    Ok(Json(json!({ "stats": stats })))
}

#[derive(Debug, Deserialize)]
struct StatsHistoryQuery {
    range: Option<String>,
}

async fn get_stats_history(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
    Query(query): Query<StatsHistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let range = query.range.as_deref().unwrap_or("24h");
    let collector = state.stats_collector();
    let history = collector.get_history(range).await;
    let mut response = json!({ "history": history });
    let health = collector.history_health();
    if let Some(error) = health.error {
        response["historyError"] = json!(error);
        response["historyPersistenceEnabled"] = json!(health.persistence_enabled);
    }
    Ok(Json(response))
}

async fn trigger_rebuild(
    Extension(_user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    // Running host build scripts is off unless the server owner opts in; there is no admin role.
    if std::env::var("TERMINAL_V4_ALLOW_REBUILD").as_deref() != Ok("1") {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Rebuilding from the browser is turned off. Start the server with TERMINAL_V4_ALLOW_REBUILD=1 to allow it.".into(),
        });
    }
    let command = system_rebuild::RebuildConfig::from_env()
        .command(cfg!(windows))
        .map_err(ApiError::internal)?;
    let output = tokio::process::Command::new(command.program)
        .args(command.args)
        .current_dir(&command.project_root)
        .env("REBUILD_PROJECT_ROOT", &command.project_root)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| ApiError::internal(format!("Rebuild failed: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(Json(json!({
        "success": output.status.success(),
        "stdout": stdout,
        "stderr": stderr
    })))
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

fn validate_sandbox_mode(value: &str) -> Result<(), ApiError> {
    if !SANDBOX_MODES.contains(&value) {
        return Err(ApiError::bad_request(format!(
            "Sandbox mode must be one of: {}",
            SANDBOX_MODES.join(", ")
        )));
    }
    if value != "off" {
        return Err(ApiError::bad_request(
            "Sandbox modes are disabled until runtime isolation is enforced",
        ));
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
    project_scan_paths(state, user).map(project_entries_from_paths)
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
struct LatencyWsQuery {
    token: Option<String>,
}

async fn connect_latency_ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(query): Query<LatencyWsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    authenticate_runtime_websocket(&state, &headers, query.token.as_deref(), "/api/latency/ws")?;
    Ok(ws.on_upgrade(handle_latency_ws))
}

async fn handle_latency_ws(mut socket: WebSocket) {
    while let Some(message) = socket.recv().await {
        let Ok(message) = message else {
            break;
        };

        match message {
            Message::Text(text) => {
                let payload = text.to_string();
                if payload == "ping" {
                    if socket.send(Message::Text("pong".into())).await.is_err() {
                        break;
                    }
                    continue;
                }

                let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                    continue;
                };
                if value.get("type") != Some(&Value::String("ping".to_string())) {
                    continue;
                }

                let response = json!({
                    "type": "pong",
                    "id": value.get("id").cloned().unwrap_or(Value::Null),
                    "sentAt": value.get("sentAt").cloned().unwrap_or(Value::Null),
                    "serverAt": time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000,
                });
                if socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct PreviewPerformanceStreamQuery {
    token: Option<String>,
}

async fn stream_preview_performance(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
    Path(port): Path<u16>,
    Query(query): Query<PreviewPerformanceStreamQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let user = authenticate_runtime_websocket(
        &state,
        &headers,
        query.token.as_deref(),
        &format!("/api/preview/{port}/performance/stream"),
    )?;

    let subscription = state
        .preview_performance_store()
        .subscribe(&user.user_id, port)
        .await;

    let runtime_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or(query.token)
        .unwrap_or_default();
    let authorization_path = format!("/api/preview/{port}/performance/stream");
    Ok(ws.on_upgrade(move |socket| async move {
        tokio::select! {
            _ = wait_for_preview_revocation(&state,&runtime_token,&authorization_path)=>{},
            _ = handle_preview_performance_ws(socket,subscription)=>{},
        }
    }))
}

async fn handle_preview_performance_ws(
    mut socket: WebSocket,
    mut subscription: tokio::sync::broadcast::Receiver<
        preview::performance::PerformanceMetricsSnapshot,
    >,
) {
    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            result = subscription.recv() => {
                match result {
                    Ok(metrics) => {
                        let payload = json!({
                            "type": "performance-update",
                            "metrics": metrics,
                        });
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct StructuredWsQuery {
    token: Option<String>,
    last_seq: Option<i64>,
}

async fn connect_structured_ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<StructuredWsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let user = authenticate_runtime_websocket(
        &state,
        &headers,
        query.token.as_deref(),
        &format!("/api/structured/sessions/{session_id}/ws"),
    )?;

    let structured_manager = state.structured_session_manager();
    let (history, subscription) = structured_manager
        .subscribe(&user.user_id, &session_id)
        .await
        .map_err(|error| ApiError {
            status: StatusCode::NOT_FOUND,
            message: error,
        })?;

    let runtime_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or(query.token.clone())
        .unwrap_or_default();
    let last_seq = query.last_seq;
    Ok(ws
        .max_message_size(131072)
        .max_frame_size(131072)
        .on_upgrade(move |socket| {
            handle_structured_ws(
                socket,
                StructuredWsConnection {
                    state,
                    runtime_token,
                    structured_manager,
                    user,
                    session_id,
                    history,
                    subscription,
                    last_seq,
                },
            )
        }))
}

struct StructuredWsConnection {
    state: AppState,
    runtime_token: String,
    structured_manager: StructuredSessionManager,
    user: AuthenticatedUser,
    session_id: String,
    history: Vec<terminal_v4_core::StructuredSessionEvent>,
    subscription: tokio::sync::broadcast::Receiver<terminal_v4_core::StructuredSessionEvent>,
    last_seq: Option<i64>,
}

async fn handle_structured_ws(mut socket: WebSocket, connection: StructuredWsConnection) {
    let StructuredWsConnection {
        state,
        runtime_token,
        structured_manager,
        user,
        session_id,
        history,
        mut subscription,
        last_seq,
    } = connection;
    // Send event history on connect — filtered by last_seq if provided (resume)
    for event in history {
        if let Some(cursor) = last_seq {
            if event.seq() <= cursor {
                continue;
            }
        }
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

    // Keep connection alive even when broadcast channel is closed (inactive session).
    // Without this, persisted sessions would close the WS immediately after history,
    // causing the frontend to enter a reconnect loop.
    let mut broadcast_closed = false;
    let mut authorization_check = tokio::time::interval(std::time::Duration::from_secs(2));
    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(15));
    ping_interval.tick().await; // consume first immediate tick

    loop {
        tokio::select! {
            _=authorization_check.tick()=>{if auth::authenticate_runtime_token(&state,&runtime_token,&format!("/api/structured/sessions/{session_id}/ws")).is_err(){let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4401,reason:"Session access expired or was revoked".into()}))).await;break;}}

            event = subscription.recv(), if !broadcast_closed => {
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
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        // Notify client that events were lost so it can trigger a full resync
                        let _ = socket.send(Message::Text(
                            json!({
                                "__terminal_meta": true,
                                "type": "events_lost",
                                "count": count
                            })
                            .to_string()
                            .into(),
                        )).await;
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Channel closed (no active process) — keep WS alive for client messages
                        broadcast_closed = true;
                    }
                }
            }
            _ = ping_interval.tick() => {
                if socket.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
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
                        let kind=value.get("type").and_then(Value::as_str).unwrap_or("");
                        if !auth::runtime_message_allowed(&state,&runtime_token,true,kind){let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4403,reason:"Agent control is not permitted".into()}))).await;break;}
                        let request_id=value.get("requestId").and_then(Value::as_str);
                        let authority = match auth::authenticate_runtime_with_authority(&state, &runtime_token, "GET", &format!("/api/structured/sessions/{session_id}/ws")) {
                            Ok((verified, authority)) if verified.user_id == user.user_id => authority,
                            _ => { let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4401,reason:"Session access expired or was revoked".into()}))).await; break; }
                        };
                        let paired = runtime_token.starts_with("tv4pair.").then(|| auth::PairedInputAuthority {
                            token: runtime_token.clone(), path: format!("/api/structured/sessions/{session_id}/ws"), method: "GET".into(),
                        });
                        let result:Result<Value,structured::StructuredControlError>=match kind {
                            "message" if value.get("attachments").is_some()=>Err(structured::StructuredControlError{code:"invalid",message:"Image attachments require the dedicated image send route".into()}),
                            "message"=>match value.get("text").and_then(Value::as_str) {
                                Some(text) if text.chars().count()<=100_000 && !text.contains('\0')=>structured_manager.submit_message_with_paired(&user.user_id,&session_id,text,request_id,authority.as_ref(),paired.as_ref(),&state).await.map(|receipt|json!(receipt)),
                                _=>Err(structured::StructuredControlError {code:"invalid",message:"Message text is missing or exceeds its limit".into()}),
                            },
                            "approve"=>match value.get("approved").and_then(Value::as_bool) {
                                Some(approved)=>match (value.get("reservationId"), value.get("reservationToken")) {
                                    (None, None) => structured_manager.approve_with_paired(&user.user_id,&session_id,value.get("approvalId").and_then(Value::as_str),approved,value.get("answers").cloned(),false,None,authority.as_ref(),paired.as_ref(),&state).await.map(|receipt|json!(receipt)),
                                    (Some(id), Some(token)) if id.is_string() && token.is_string() => structured_manager.approve_with_paired(&user.user_id,&session_id,value.get("approvalId").and_then(Value::as_str),approved,value.get("answers").cloned(),false,Some((id.as_str().unwrap(), token.as_str().unwrap())),authority.as_ref(),paired.as_ref(),&state).await.map(|receipt|json!(receipt)),
                                    _ => Err(structured::StructuredControlError {code:"invalid",message:"Reservation ID and token are both required".into()}),
                                },
                                None=>Err(structured::StructuredControlError {code:"invalid",message:"Approval decision must be a boolean".into()}),
                            },
                            "interrupt"=>{
                                #[cfg(unix)]
                                let stopped = structured_manager.interrupt_authorized(&user.user_id,&session_id,authority.as_ref(),paired.as_ref(),&state).await;
                                #[cfg(not(unix))]
                                let stopped = structured_manager.interrupt(&user.user_id,&session_id).await;
                                stopped.map(|_|json!({"status":"cancelled","cleanupConfirmed":true})).map_err(|message|structured::StructuredControlError {code:"cleanup_failed",message})
                            },
                            _=>Err(structured::StructuredControlError {code:"invalid",message:"Unsupported structured command".into()}),
                        };
                        let response=match result {
                            Ok(receipt)=>json!({"__terminal_meta":true,"type":"command_receipt","requestId":request_id,"receipt":receipt}),
                            Err(error)=>json!({"__terminal_meta":true,"type":"command_rejected","requestId":request_id,"error":{"code":error.code,"message":error.message}}),
                        };
                        if socket.send(Message::Text(response.to_string().into())).await.is_err(){break;}

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
    let value = value.strip_prefix(r"\\?\").unwrap_or(&value);
    #[cfg(target_os = "macos")]
    if let Some(stripped) = value.strip_prefix("/private") {
        return stripped.to_string();
    }
    value.to_string()
}

fn now_millis() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .expect("timestamp should fit in i64")
}

fn preview_log_stream_poll_ms() -> u64 {
    std::env::var("PREVIEW_LOG_STREAM_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1000)
}

fn preview_eval_enabled() -> bool {
    std::env::var("PREVIEW_EVAL_ENABLED")
        .map(|value| value == "true")
        .unwrap_or(false)
}

fn validate_preview_storage_key(key: &str) -> Result<(), ApiError> {
    if key.len() > 256 {
        return Err(ApiError::bad_request("Key too long (max 256 characters)"));
    }
    if !key
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return Err(ApiError::bad_request(
            "Key contains invalid characters (allowed: alphanumeric, underscore, dash, dot)",
        ));
    }
    Ok(())
}

fn is_css_content_type(content_type: &str, path: &str) -> bool {
    content_type.to_ascii_lowercase().contains("text/css")
        || path.ends_with(".css")
        || path.contains(".css?")
}

fn is_javascript_content_type(content_type: &str, path: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    content_type.contains("javascript")
        || content_type.contains("ecmascript")
        || path.ends_with(".js")
        || path.contains(".js?")
        || path.ends_with(".mjs")
        || path.contains(".mjs?")
}

fn update_proxy_response_length(response: &mut preview::proxy::ProxyResponse) {
    response
        .headers
        .remove(axum::http::header::TRANSFER_ENCODING);
    if let Ok(length) = axum::http::HeaderValue::from_str(&response.body.len().to_string()) {
        response
            .headers
            .insert(axum::http::header::CONTENT_LENGTH, length);
    }
    response
        .headers
        .remove(axum::http::header::CONTENT_ENCODING);
}

fn websocket_proxy_origin(headers: &axum::http::HeaderMap) -> Option<String> {
    let host = request_host(headers)?;
    let proto = request_scheme(headers);
    let ws_scheme = if proto.eq_ignore_ascii_case("https") {
        "wss"
    } else {
        "ws"
    };
    Some(format!("{ws_scheme}://{host}"))
}

fn request_origin(headers: &axum::http::HeaderMap) -> Option<String> {
    let host = request_host(headers)?;
    Some(format!("{}://{host}", request_scheme(headers)))
}

/// API origin as the browser sees it, for scripts injected into previews opened
/// in their own tab. Subdomain previews proxy every path to the app, so the API
/// is on the base host.
fn preview_api_origin(headers: &axum::http::HeaderMap) -> String {
    if let Ok(origin) = std::env::var("API_ORIGIN") {
        return origin;
    }
    let Some(host) = request_host(headers) else {
        return "http://localhost:3020".to_string();
    };
    format!(
        "{}://{}",
        request_scheme(headers),
        preview::strip_preview_subdomain(&host)
    )
}

fn preview_subdomain_port(headers: &axum::http::HeaderMap) -> Option<u16> {
    let host = request_host(headers)?;
    preview::extract_port_from_preview_subdomain(&host, &preview::subdomain_bases())
}

fn populate_forward_headers(headers: &mut axum::http::HeaderMap) {
    if let Some(host) = request_host(headers) {
        if let Ok(value) = axum::http::HeaderValue::from_str(&host) {
            headers.insert("x-forwarded-host", value);
        }
    }

    if let Ok(value) = axum::http::HeaderValue::from_str(request_scheme(headers)) {
        headers.insert("x-forwarded-proto", value);
    }

    let request_host = request_host(headers);
    let forwarded_port = request_host
        .as_deref()
        .and_then(host_port)
        .unwrap_or_else(|| {
            if request_scheme(headers).eq_ignore_ascii_case("https") {
                "443"
            } else {
                "80"
            }
        });
    if let Ok(value) = axum::http::HeaderValue::from_str(forwarded_port) {
        headers.insert("x-forwarded-port", value);
    }

    headers.insert(
        "x-forwarded-for",
        axum::http::HeaderValue::from_static("127.0.0.1"),
    );
}

fn request_host(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(axum::http::header::HOST))
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn request_scheme(headers: &axum::http::HeaderMap) -> &str {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http")
}

fn host_port(host: &str) -> Option<&str> {
    if host.starts_with('[') {
        return host
            .split_once(']')
            .and_then(|(_, rest)| rest.strip_prefix(':'))
            .filter(|value| !value.is_empty());
    }

    host.rsplit_once(':')
        .map(|(_, port)| port)
        .filter(|port| !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()))
}

fn authenticate_runtime_websocket(
    state: &AppState,
    headers: &HeaderMap,
    query_token: Option<&str>,
    path: &str,
) -> Result<AuthenticatedUser, ApiError> {
    let result = if let Some(token) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        auth::authenticate_runtime_token(state, token, path)
    } else {
        query_token
            .ok_or_else(|| "Missing session token".to_string())
            .and_then(|token| crate::auth::authenticate_local_token(state, token))
    };
    result.map_err(|_| ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Invalid or expired session token".into(),
    })
}

async fn wait_for_preview_revocation(state: &AppState, token: &str, path: &str) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        interval.tick().await;
        if auth::authenticate_runtime_request(state, token, "GET", path).is_err()
            && crate::auth::authenticate_runtime_preview_token(state, token, path).is_err()
        {
            return;
        }
    }
}

fn authenticate_preview_request_user(
    state: &AppState,
    request: &axum::extract::Request,
    port: u16,
) -> Result<AuthenticatedUser, ApiError> {
    if let Some(token) = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return auth::authenticate_runtime_request(
            state,
            token,
            request.method().as_str(),
            preview_auth_route_path(request),
        )
        .map_err(|_| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid or expired preview session".into(),
        });
    }
    let token = preview_request_token(request).ok_or_else(|| ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Missing preview session".to_string(),
    })?;

    crate::auth::authenticate_runtime_preview_token(state, &token, preview_auth_route_path(request))
        .or_else(|_| {
            let path = if preview_subdomain_port(request.headers()).is_some() {
                format!("/preview/{port}{}", request.uri().path())
            } else {
                request.uri().path().into()
            };
            preview::auth_urls::authenticate_resource_token(
                state,
                &token,
                request.method().as_str(),
                &path,
            )
        })
        .map_err(|_| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid or expired preview session".to_string(),
        })
}

fn preview_auth_route_path(request: &axum::extract::Request) -> &str {
    if preview_subdomain_port(request.headers()).is_some() {
        "/preview/"
    } else {
        request.uri().path()
    }
}

fn preview_request_token(request: &axum::extract::Request) -> Option<String> {
    preview_cookie_token(request).or_else(|| preview_query_token(request))
}

fn preview_cookie_token(request: &axum::extract::Request) -> Option<String> {
    request
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookie_header| {
            cookie_header.split(';').find_map(|segment| {
                let (name, value) = segment.trim().split_once('=')?;
                if name == PREVIEW_COOKIE_NAME {
                    Some(value.to_string())
                } else {
                    None
                }
            })
        })
}

fn preview_query_token(request: &axum::extract::Request) -> Option<String> {
    request.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key == "previewToken" {
                Some(value.to_string())
            } else {
                None
            }
        })
    })
}

fn preview_cookie_header(token: &str) -> String {
    let secure = if matches!(
        std::env::var("API_ORIGIN").ok().as_deref(),
        Some(origin) if origin.starts_with("https://")
    ) {
        "; Secure"
    } else {
        ""
    };

    format!("{PREVIEW_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900{secure}")
}

fn expired_preview_cookie() -> String {
    format!("{PREVIEW_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

async fn preview_cookies_for_user(
    state: &AppState,
    user_id: &str,
    port: u16,
) -> Vec<preview::cookie_jar::StoredCookie> {
    state.cookie_store().list_cookies(user_id, port).await
}

async fn clear_preview_cookies_for_user(state: &AppState, user_id: &str, port: u16) {
    state.cookie_store().clear_cookies(user_id, port).await;
}

async fn preview_proxy_logs_for_user(
    state: &AppState,
    user_id: &str,
    port: u16,
    since: Option<i64>,
) -> Vec<preview::request_logs::ProxyLogEntry> {
    let mut logs = state
        .request_log_store()
        .get_logs(user_id, port, since)
        .await;
    sort_proxy_logs(&mut logs);
    logs
}

async fn clear_preview_proxy_logs_for_user(state: &AppState, user_id: &str, port: u16) {
    state.request_log_store().clear_logs(user_id, port).await;
}

async fn preview_proxy_logs_after_cursor_for_user(
    request_log_store: &preview::request_logs::RequestLogStore,
    user_id: &str,
    port: u16,
    cursor: preview::request_logs::LogCursor,
) -> Vec<preview::request_logs::ProxyLogEntry> {
    request_log_store
        .get_logs_after_cursor(user_id, port, cursor)
        .await
}

fn sort_proxy_logs(entries: &mut [preview::request_logs::ProxyLogEntry]) {
    entries.sort_by(|left, right| {
        left.timestamp
            .cmp(&right.timestamp)
            .then_with(|| left.id.cmp(&right.id))
    });
}

#[derive(Debug, Deserialize, Default)]
struct TerminalWsQuery {
    framed: Option<String>,
    history: Option<String>,
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
    let replay_history = !matches!(query.history.as_deref(), Some("0" | "false" | "no"));
    ws.on_upgrade(move |socket| {
        handle_terminal_ws(socket, state, session_id, framed, replay_history)
    })
}

async fn handle_terminal_ws(
    mut socket: WebSocket,
    state: AppState,
    session_id: String,
    framed: bool,
    replay_history: bool,
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

    let Ok(user) = auth::authenticate_runtime_token(
        &state,
        &auth_message.token,
        &format!("/api/terminal/{session_id}/ws"),
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

    let mut last_sequence = None;
    if replay_history {
        if let Ok(Some(snapshot)) = terminal_manager
            .get_session_history(
                &user.user_id,
                &session_id,
                &crate::state::HistoryQuery {
                    max_history_events: Some(200),
                    max_history_chars: Some(200_000),
                    ..Default::default()
                },
            )
            .await
        {
            for event in &snapshot.history {
                if let Some(seq) = event.seq {
                    if send_ws_meta(
                        &mut socket,
                        framed,
                        json!({"type":"serverCursor","seq":seq}),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    last_sequence = Some(seq);
                }
                if send_ws_output(&mut socket, framed, &event.text)
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    }

    let mut ping_interval = tokio::time::interval(tokio::time::Duration::from_secs(15));
    let max_buffered = terminal_ws_max_buffered_bytes();
    let mut buffered_bytes: usize = 0;
    let mut backpressure_active = false;
    let mut resync_pending = false;

    let mut authorization_check = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        tokio::select! {
            _=authorization_check.tick()=>{
                if auth::authenticate_runtime_token(&state,&auth_message.token,&format!("/api/terminal/{session_id}/ws")).is_err(){let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4401,reason:"Session access expired or was revoked".into()}))).await;break;}
            }

            _ = ping_interval.tick() => {
                if send_ws_meta(&mut socket, framed, json!({ "type": "serverPing" })).await.is_err() {
                    break;
                }
            }
            event = subscription.recv() => {
                match event {
                    Ok(TerminalSubscriptionEvent::Output(output)) => {
                        if output.seq.zip(last_sequence).is_some_and(|(next, previous)| next <= previous) {
                            continue;
                        }
                        if let Some(sequence) = output.seq {
                            last_sequence = Some(sequence);
                        }
                        // Backpressure: if buffered bytes exceed the limit,
                        // drop output and suggest a resync instead.
                        let msg_len = output.text.len();
                        if buffered_bytes + msg_len > max_buffered {
                            backpressure_active = true;
                            if !resync_pending {
                                resync_pending = true;
                                if send_ws_meta(
                                    &mut socket,
                                    framed,
                                    json!({ "type": "resyncSuggested", "reason": "backpressure", "ts": time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000 }),
                                )
                                .await
                                .is_err()
                                {
                                    break;
                                }
                            }
                            continue;
                        }
                        // Buffer has drained enough — clear backpressure state.
                        if backpressure_active {
                            backpressure_active = false;
                            resync_pending = false;
                        }
                        if let Some(seq) = output.seq {
                            if send_ws_meta(&mut socket, framed, json!({ "type": "serverCursor", "seq": seq })).await.is_err() {
                                break;
                            }
                        }
                        buffered_bytes += msg_len;
                        if send_ws_output(&mut socket, framed, &output.text).await.is_err() {
                            break;
                        }
                        // After a successful await-ed send the data has been
                        // handed off to the OS send buffer, so we can reclaim.
                        buffered_bytes = buffered_bytes.saturating_sub(msg_len);
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
                        if !auth::runtime_message_allowed(&state,&auth_message.token,false,"input") {
                            let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4403,reason:"Terminal input is not permitted".into()}))).await;break;
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
    #[test]
    fn preview_api_origin_follows_the_browser_facing_host() {
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut map = axum::http::HeaderMap::new();
            for (name, value) in pairs {
                map.insert(*name, value.parse().unwrap());
            }
            map
        };
        let origins = [
            super::preview_api_origin(&headers(&[("host", "localhost:3041")])),
            super::preview_api_origin(&headers(&[
                ("host", "mac.tail.ts.net"),
                ("x-forwarded-proto", "https"),
            ])),
            super::preview_api_origin(&headers(&[(
                "host",
                "preview-8799.192.168.1.5.nip.io:3020",
            )])),
        ];
        assert_eq!(
            origins,
            [
                "http://localhost:3041",
                "https://mac.tail.ts.net",
                "http://192.168.1.5.nip.io:3020"
            ]
        );
    }

    use super::{
        app, client_build_assets, client_build_info, normalize_filesystem_path,
        resolve_frontend_dir_with_current_dir, validate_sandbox_mode, ApiState,
    };
    use crate::auth::issue_access_token;
    use crate::external_auth::{ExternalAuthProvider, ExternalAuthUser};
    use crate::preview;
    use crate::structured::{
        SpawnedStructuredProcess, StructuredProcessController, StructuredProvider,
        StructuredSessionManager, StructuredSpawnOptions,
    };
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::extract::ws::rejection::WebSocketUpgradeRejection;
    use axum::extract::ws::{Message, WebSocketUpgrade};
    use axum::http::{Request, StatusCode};
    use axum::routing::{any, get};
    use bcrypt::{hash, DEFAULT_COST};
    use futures_util::{SinkExt, StreamExt};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    #[cfg(unix)]
    use std::sync::{LazyLock, Mutex as StdMutex};
    use tempfile::tempdir;
    use terminal_v4_core::{AppConfig, HealthResponse, StructuredSessionEvent, UserSettings};
    use tokio::sync::{mpsc, Mutex};
    use tokio::time::{sleep, Duration};
    use tokio_tungstenite::tungstenite;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tower::ServiceExt;

    #[cfg(unix)]
    static ENV_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

    #[cfg(unix)]
    #[tokio::test]
    async fn webcontainer_export_enforces_existing_file_roots_before_traversal() {
        let _guard = ENV_LOCK.lock().unwrap();
        struct RestoreRoots(Option<std::ffi::OsString>);
        impl Drop for RestoreRoots {
            fn drop(&mut self) {
                unsafe {
                    match &self.0 {
                        Some(value) => std::env::set_var("TERMINAL_V4_ALLOWED_FILE_ROOTS", value),
                        None => std::env::remove_var("TERMINAL_V4_ALLOWED_FILE_ROOTS"),
                    }
                }
            }
        }
        let cwd = std::env::current_dir().unwrap();
        let allowed = tempfile::Builder::new()
            .prefix(".wc-contained-test-")
            .tempdir_in(&cwd)
            .unwrap();
        let outside = tempdir().unwrap();
        let project = allowed.path().join("project");
        fs::create_dir(&project).unwrap();
        for directory in [&project, &outside.path().to_path_buf()] {
            fs::write(
                directory.join("package.json"),
                r#"{"name":"owned-synthetic-project"}"#,
            )
            .unwrap();
            fs::write(directory.join("marker.txt"), "OWNED_SYNTHETIC_MARKER").unwrap();
        }
        let _restore = RestoreRoots(std::env::var_os("TERMINAL_V4_ALLOWED_FILE_ROOTS"));
        unsafe {
            std::env::set_var("TERMINAL_V4_ALLOWED_FILE_ROOTS", allowed.path());
        }
        std::os::unix::fs::symlink(outside.path(), allowed.path().join("outside-link")).unwrap();
        std::os::unix::fs::symlink(&project, allowed.path().join("inside-link")).unwrap();
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "wc-containment", "synthetic");
        for (path, authorized, expected) in [
            (
                outside.path().to_path_buf(),
                false,
                StatusCode::UNAUTHORIZED,
            ),
            (outside.path().to_path_buf(), true, StatusCode::FORBIDDEN),
            (
                allowed.path().join("outside-link"),
                true,
                StatusCode::FORBIDDEN,
            ),
            (project.clone(), true, StatusCode::OK),
            (
                project.strip_prefix(&cwd).unwrap().to_path_buf(),
                true,
                StatusCode::OK,
            ),
            (allowed.path().join("inside-link"), true, StatusCode::OK),
        ] {
            let uri = format!(
                "/api/webcontainer/files?path={}",
                url::form_urlencoded::byte_serialize(path.to_str().unwrap().as_bytes())
                    .collect::<String>()
            );
            let mut request = Request::builder().uri(uri);
            if authorized {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            let response = app(state.clone())
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(status, expected, "{}: {body}", path.display());
            if expected == StatusCode::OK {
                assert_eq!(
                    body["files"]["marker.txt"]["file"]["contents"],
                    "OWNED_SYNTHETIC_MARKER"
                );
            } else {
                assert!(body.get("files").is_none());
                assert!(!String::from_utf8_lossy(&bytes).contains("OWNED_SYNTHETIC_MARKER"));
            }
        }
    }

    #[tokio::test]
    async fn repair_followup_branch_inventory_includes_alternate_refs_and_keeps_owner_gate() {
        let directory = tempdir().unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec![
                "-c",
                "user.name=Synthetic Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
            vec!["branch", "feature/second"],
        ] {
            let result = std::process::Command::new("git")
                .args(args)
                .current_dir(directory.path())
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let state = test_state();
        let owner = "branch-inventory-fixture";
        let id = "branch-inventory-terminal";
        let sessions = state
            .config()
            .data_dir
            .join("users")
            .join(owner)
            .join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join(format!("{id}.json")),
            json!({
                "id":id,"title":"Synthetic branch fixture","shell":"/bin/sh","cwd":directory.path(),
                "createdAt":"2026-10-23T00:00:00Z","updatedAt":"2026-10-23T00:00:00Z","history":[]
            })
            .to_string(),
        )
        .unwrap();
        for (user, expected) in [
            (owner, StatusCode::OK),
            ("different-owner", StatusCode::NOT_FOUND),
        ] {
            let token = issue_access_token(&state.config().jwt_secret, user, "synthetic");
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/terminal/{id}/git-branches"))
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(status, expected, "{body}");
            if expected == StatusCode::OK {
                assert_eq!(
                    body,
                    json!({"branches":["feature/second","main"],"currentBranch":"main"})
                );
            }
        }
    }

    #[tokio::test]
    async fn repair_followup_preview_body_limit_never_forwards_an_empty_replacement() {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let upstream = axum::Router::new().route(
            "/{*path}",
            axum::routing::any(move |request: axum::extract::Request| {
                let observed = observed.clone();
                async move {
                    let body = axum::body::to_bytes(request.into_body(), 10 * 1024 * 1024 + 1)
                        .await
                        .unwrap();
                    observed.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({"bytes":body.len()}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let state = test_state();
        let token = issue_access_token(
            &state.config().jwt_secret,
            "preview-body-fixture",
            "synthetic",
        );
        for (route, limit) in [
            (format!("/preview/{port}/owned-upload"), 10 * 1024 * 1024),
            (
                format!("/api/dev-proxy/{port}/owned-upload"),
                10 * 1024 * 1024,
            ),
        ] {
            for size in [64, limit, limit + 1] {
                let before = count.load(Ordering::SeqCst);
                let stream = futures_util::stream::iter([Ok::<_, std::io::Error>(
                    axum::body::Bytes::from(vec![b'x'; size]),
                )]);
                let response = app(state.clone())
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(&route)
                            .header("authorization", format!("Bearer {token}"))
                            .header("transfer-encoding", "chunked")
                            .body(Body::from_stream(stream))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                let body: Value = serde_json::from_slice(
                    &response.into_body().collect().await.unwrap().to_bytes(),
                )
                .unwrap();
                if size <= limit {
                    assert_eq!(
                        (status, body, count.load(Ordering::SeqCst)),
                        (StatusCode::OK, json!({"bytes":size}), before + 1),
                        "{route}"
                    );
                } else {
                    assert_eq!(
                        (status, count.load(Ordering::SeqCst)),
                        (StatusCode::PAYLOAD_TOO_LARGE, before),
                        "{route}: {body}"
                    );
                }
            }
        }
        server.abort();
    }

    #[test]
    fn validate_sandbox_mode_rejects_unenforced_modes() {
        assert!(validate_sandbox_mode("off").is_ok());

        let workspace_write = validate_sandbox_mode("workspace-write")
            .expect_err("workspace-write should stay disabled until enforced");
        assert_eq!(workspace_write.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            workspace_write.message,
            "Sandbox modes are disabled until runtime isolation is enforced"
        );

        let read_only =
            validate_sandbox_mode("read-only").expect_err("read-only should stay disabled");
        assert_eq!(read_only.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn terminal_websocket_respects_history_opt_out_and_sequences_replay() {
        use tokio_tungstenite::tungstenite::Message as WsMessage;
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "ws-replay-owner", "fixture");
        let (port, server) = spawn_router(app(state.clone())).await;
        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{port}");
        let created: Value = client.post(format!("{base}/api/terminal"))
            .bearer_auth(&token)
            .json(&json!({"shell": if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }, "title":"Replay fixture"}))
            .send().await.unwrap().json().await.unwrap();
        let id = created["session"]["id"].as_str().unwrap();
        let command = if cfg!(windows) {
            "echo SAVED_WS_FIXTURE\r"
        } else {
            "printf 'SAVED_WS_FIXTURE\\n'\r"
        };
        state
            .terminal_manager()
            .write("ws-replay-owner", id, command)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let history = state
                    .terminal_manager()
                    .get_session_history("ws-replay-owner", id, &Default::default())
                    .await
                    .unwrap()
                    .unwrap();
                if history
                    .history
                    .iter()
                    .any(|event| event.text.contains("SAVED_WS_FIXTURE"))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        for replay in [false, true] {
            let (mut socket, _) = tokio_tungstenite::connect_async(format!(
                "ws://127.0.0.1:{port}/api/terminal/{id}/ws?history={}",
                if replay { 1 } else { 0 }
            ))
            .await
            .unwrap();
            socket
                .send(WsMessage::Text(
                    json!({"type":"auth","token":token}).to_string().into(),
                ))
                .await
                .unwrap();
            let mut output = String::new();
            let mut cursor_count = 0;
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while let Some(frame) = socket.next().await {
                    let text = frame.unwrap().into_text().unwrap();
                    if let Ok(meta) = serde_json::from_str::<Value>(&text) {
                        if meta["type"] == "serverCursor" {
                            cursor_count += 1;
                        }
                        if meta["type"] == "serverPing" {
                            break;
                        }
                    } else {
                        output.push_str(&text);
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(
                output.contains("SAVED_WS_FIXTURE"),
                replay,
                "history opt-out must avoid duplicate HTTP/WebSocket output"
            );
            assert_eq!(
                cursor_count > 0,
                replay,
                "replayed output must carry sequence cursors"
            );
            socket.close(None).await.unwrap();
        }
        state
            .terminal_manager()
            .close("ws-replay-owner", id)
            .await
            .unwrap();
        server.abort();
    }

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

    #[test]
    fn resolve_frontend_dir_prefers_repo_relative_bundle_when_present() {
        let temp_root = tempdir().expect("temp dir should create");
        let repo_root = temp_root.path().join("repo");
        let repo_frontend_dist = repo_root.join("frontend").join("dist");
        fs::create_dir_all(&repo_frontend_dist).expect("frontend dist should create");

        let resolved = resolve_frontend_dir_with_current_dir(
            std::path::Path::new("unused/data-dir"),
            Some(&repo_root),
            None,
        );

        assert_eq!(resolved, repo_frontend_dist);
    }

    #[test]
    fn resolve_frontend_dir_finds_bundle_in_current_dir_ancestors() {
        let temp_root = tempdir().expect("temp dir should create");
        let repo_root = temp_root.path().join("repo");
        let desktop_workdir = repo_root.join("desktop").join("tauri");
        let repo_frontend_dist = repo_root.join("frontend").join("dist");
        fs::create_dir_all(&desktop_workdir).expect("desktop workdir should create");
        fs::create_dir_all(&repo_frontend_dist).expect("frontend dist should create");

        let resolved = resolve_frontend_dir_with_current_dir(
            std::path::Path::new("unused/data-dir"),
            Some(&desktop_workdir),
            None,
        );

        assert_eq!(resolved, repo_frontend_dist);
    }

    #[test]
    fn resolve_frontend_dir_prefers_packaged_override_without_a_checkout() {
        let root = tempdir().unwrap();
        let assets = root.path().join("V4.app/Contents/Resources/frontend/dist");
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("index.html"), "<div id=\"root\"></div>").unwrap();
        assert_eq!(
            resolve_frontend_dir_with_current_dir(
                &root.path().join("user-data"),
                Some(root.path()),
                Some(&assets),
            ),
            assets
        );
    }

    #[tokio::test]
    async fn root_path_serves_public_frontend_html_when_bundle_exists() {
        let temp_root = tempdir().expect("temp dir should create");
        let frontend_dist = temp_root.path().join("frontend").join("dist");
        fs::create_dir_all(&frontend_dist).expect("frontend dist should create");
        fs::write(
            frontend_dist.join("index.html"),
            "<!doctype html><title>terminal-v4</title>",
        )
        .expect("index html should write");

        let state = test_state_with_data_dir(temp_root.path().join("app").join("data"));
        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("text/html")
        );
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let html = String::from_utf8(body.to_vec()).expect("html should decode");
        assert!(html.contains("<title>terminal-v4</title>"));
    }

    #[test]
    fn client_build_assets_reads_main_script_and_stylesheet_from_index_html() {
        let main_script = "/assets/index-AbC123.js";
        let main_stylesheet = "/assets/index-DeF456.css";
        let html = format!(
            r#"<script type="module" crossorigin src="{main_script}"></script><link rel="modulepreload" href="/assets/vendor-react-x.js"><link rel="stylesheet" crossorigin href="{main_stylesheet}">"#
        );

        assert_eq!(
            client_build_assets(&html),
            (
                Some(main_script.to_string()),
                Some(main_stylesheet.to_string())
            )
        );
        assert_eq!(
            client_build_assets("<title>no bundle</title>"),
            (None, None)
        );
    }

    #[tokio::test]
    async fn client_build_route_reports_the_served_bundle_without_auth() {
        let main_script = "/assets/index-Build42.js";
        let temp_root = tempdir().expect("temp dir should create");
        let frontend_dist = temp_root.path().join("frontend").join("dist");
        fs::create_dir_all(&frontend_dist).expect("frontend dist should create");
        fs::write(
            frontend_dist.join("index.html"),
            format!(r#"<script type="module" src="{main_script}"></script>"#),
        )
        .expect("index html should write");

        let state = test_state_with_data_dir(temp_root.path().join("app").join("data"));
        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/client-build?t=1")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("no-cache, no-store, must-revalidate")
        );
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let payload: Value = serde_json::from_slice(&body).expect("payload should decode");
        assert_eq!(payload["buildId"], main_script);
        assert_eq!(payload["mainScript"], main_script);
        assert_eq!(payload["mainStylesheet"], Value::Null);
        assert!(payload["indexMtimeMs"].is_u64());
        assert!(payload["checkedAt"].is_u64());
    }

    #[tokio::test]
    async fn build_info_route_reports_commit_and_served_manifest_without_auth() {
        let temp_root = tempdir().expect("temp dir should create");
        let frontend_dist = temp_root.path().join("frontend").join("dist");
        fs::create_dir_all(&frontend_dist).expect("frontend dist should create");
        let html = r#"<script type="module" src="/assets/index-Build42.js"></script>"#;
        fs::write(frontend_dist.join("index.html"), html).expect("index html should write");

        let state = test_state_with_data_dir(temp_root.path().join("app").join("data"));
        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/build-info")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload["frontend"]["assets"],
            json!(["assets/index-Build42.js"])
        );
        assert_eq!(
            payload["frontend"]["manifestHash"],
            crate::build_info::manifest_hash(&["assets/index-Build42.js".to_string()])
        );
        assert_eq!(
            payload["workerProtocol"],
            crate::workspace_tasks::WORKER_PROTOCOL
        );
        assert_eq!(payload["commit"], crate::build_info::COMMIT);
        assert!(!String::from_utf8_lossy(&body).contains(temp_root.path().to_str().unwrap()));
    }

    #[test]
    fn client_build_info_reports_unavailable_without_a_frontend_bundle() {
        let temp_root = tempdir().expect("temp dir should create");
        let missing_frontend_dir = temp_root.path().join("frontend").join("dist");

        let status = client_build_info(&missing_frontend_dir)
            .map(|_| ())
            .map_err(|error| error.status);

        assert_eq!(status, Err(StatusCode::SERVICE_UNAVAILABLE));
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
        let rotated_access = refresh_payload["tokens"]["accessToken"]
            .as_str()
            .unwrap()
            .to_string();

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

        for token in [&access_token, &rotated_access] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/auth/me")
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

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
    async fn terminal_create_rejects_invalid_working_directories_without_starting_a_session() {
        let state = test_state();
        let user_id = "invalid-terminal-cwd";
        let token = issue_access_token(&state.config().jwt_secret, user_id, "synthetic-user");
        let folder = tempfile::tempdir().expect("test folder should exist");
        let file = folder.path().join("regular-file");
        fs::write(&file, "not a directory").expect("test file should exist");
        let router = app(state.clone());

        for cwd in [
            folder.path().join("missing").to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            String::new(),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/terminal")
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(json!({ "cwd": cwd }).to_string()))
                        .expect("request should build"),
                )
                .await
                .expect("router should respond");
            let status = response.status();
            let body = response
                .into_body()
                .collect()
                .await
                .expect("body should collect")
                .to_bytes();
            let payload: Value = serde_json::from_slice(&body).expect("payload should deserialize");
            if let Some(id) = payload["session"]["id"].as_str() {
                state
                    .terminal_manager()
                    .close(user_id, id)
                    .await
                    .expect("unexpected session should close");
            }
            assert_eq!(status, StatusCode::BAD_REQUEST, "invalid cwd: {cwd:?}");
            assert!(payload["error"]
                .as_str()
                .is_some_and(|error| error.contains("working directory")));
            assert!(state
                .terminal_manager()
                .list_sessions(user_id)
                .await
                .expect("sessions should list")
                .is_empty());
        }
    }

    #[tokio::test]
    async fn terminal_restore_rejects_a_missing_directory_and_preserves_history_for_retry() {
        let state = test_state();
        let user_id = "restore-missing-terminal-cwd";
        let token = issue_access_token(&state.config().jwt_secret, user_id, "synthetic-user");
        let folder = tempfile::tempdir().expect("test folder should exist");
        let cwd = folder.path().join("removed-workspace");
        write_terminal_session_fixture(
            &state,
            user_id,
            "missing-workspace",
            json!({
                "id": "missing-workspace", "title": "Saved terminal",
                "shell": if cfg!(windows) { "C:\\Windows\\System32\\cmd.exe" } else { "/bin/sh" },
                "cwd": cwd.to_string_lossy(),
                "createdAt": "2026-04-05T14:00:00Z", "updatedAt": "2026-04-05T14:30:00Z",
                "history": [{ "text": "retained output", "ts": 1000, "seq": 1 }]
            }),
        );
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal/missing-workspace/restore")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from("{}"))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        let status = response.status();
        if status.is_success() {
            state
                .terminal_manager()
                .close(user_id, "missing-workspace")
                .await
                .expect("unexpected session should close");
        }
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let saved = state
            .terminal_manager()
            .get_session_history(user_id, "missing-workspace", &Default::default())
            .await
            .expect("saved history should load")
            .expect("saved terminal should remain");
        assert_eq!(
            saved
                .history
                .iter()
                .map(|event| event.text.as_str())
                .collect::<Vec<_>>(),
            ["retained output"]
        );
        let sessions = state
            .terminal_manager()
            .list_sessions(user_id)
            .await
            .expect("sessions should list");
        assert!(!sessions[0].is_active);

        fs::create_dir(&cwd).expect("restored workspace should exist");
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal/missing-workspace/restore")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from("{}"))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        let status = response.status();
        state
            .terminal_manager()
            .close(user_id, "missing-workspace")
            .await
            .expect("restored terminal should close");
        assert_eq!(
            status,
            StatusCode::OK,
            "restoring should succeed when its workspace exists again"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_create_returns_resolved_cwd_matching_inventory_for_directory_symlinks() {
        let state = test_state();
        let user_id = "terminal-symlink-cwd";
        let token = issue_access_token(&state.config().jwt_secret, user_id, "synthetic-user");
        let folder = tempfile::tempdir().expect("test folder should exist");
        let workspace = folder.path().join("workspace");
        let alias = folder.path().join("workspace-alias");
        fs::create_dir(&workspace).expect("workspace should exist");
        std::os::unix::fs::symlink(&workspace, &alias).expect("workspace alias should exist");
        let router = app(state.clone());

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({ "cwd": alias, "shell": "/bin/sh" }).to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        let create_status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let created: Value = serde_json::from_slice(&body).unwrap();
        let session_id = created["session"]["id"].as_str().unwrap();

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/terminal")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let inventory_status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let inventory: Value = serde_json::from_slice(&body).unwrap();
        state
            .terminal_manager()
            .close(user_id, session_id)
            .await
            .expect("synthetic shell should close before assertions");

        assert_eq!(create_status, StatusCode::CREATED);
        assert_eq!(inventory_status, StatusCode::OK);
        assert_eq!(inventory["sessions"][0]["id"], session_id);
        assert_eq!(created["session"]["cwd"], inventory["sessions"][0]["cwd"]);
        let returned_cwd = created["session"]["cwd"].as_str().unwrap();
        assert_ne!(returned_cwd, alias.to_str().unwrap());
        assert_eq!(
            fs::canonicalize(returned_cwd).unwrap(),
            fs::canonicalize(&workspace).unwrap()
        );
    }

    #[cfg(not(windows))]
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
                        json!({
                            "command": if cfg!(windows) { "exit\r" } else { "echo hi\n" }
                        })
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
        assert_eq!(
            preview_payload["subdomainBases"],
            json!(preview::subdomain_bases())
        );
        assert_eq!(preview_payload["proxyHosts"], json!(preview::proxy_hosts()));
    }

    #[tokio::test]
    async fn terminal_thread_metadata_and_project_detection_routes_work() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-10", "conor");
        let app = app(state.clone());
        let repo_path = state.config().data_dir.join("repo");
        fs::create_dir_all(repo_path.join(".git")).expect("git dir should exist");
        fs::write(
            repo_path.join("Cargo.toml"),
            "[package]\nname = \"repo\"\nversion = \"0.1.0\"\n",
        )
        .expect("cargo manifest should exist");
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
                            "pinned": true,
                            "sandboxMode": "off",
                            "sandboxWorkspaceRoot": null
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
        assert_eq!(thread_payload["thread"]["sandboxMode"], "off");
        assert!(thread_payload["thread"]["sandboxWorkspaceRoot"].is_null());

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
            Value::String(normalize_filesystem_path(&repo_path))
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
            fs::canonicalize(&repo_path)
                .expect("workspace should resolve")
                .to_string_lossy()
                .to_string()
        );
        assert_eq!(state_payload["projectInfo"]["projectType"], "rust");
        assert_eq!(state_payload["projectInfo"]["startCommand"], "cargo run");

        let project_info_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/terminal/{session_id}/project-info"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(project_info_response.status(), StatusCode::OK);
        let project_info_body = project_info_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let project_info_payload: Value = serde_json::from_slice(&project_info_body)
            .expect("project info payload should deserialize");
        assert_eq!(project_info_payload["projectType"], "rust");
        assert_eq!(project_info_payload["startCommand"], "cargo run");

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
            normalize_filesystem_path(&repo_path)
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
    async fn change_password_route_updates_local_credentials() {
        let state = test_state();
        let user = state
            .create_local_user_for_test("conor", "old-password")
            .expect("local user should be created");
        let token = issue_access_token(&state.config().jwt_secret, &user.id, &user.username);
        let app = app(state);

        let change_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/change-password")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "currentPassword": "old-password",
                            "newPassword": "new-password"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(change_response.status(), StatusCode::OK);

        let old_login_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "username": "conor",
                            "password": "old-password"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(old_login_response.status(), StatusCode::UNAUTHORIZED);

        let new_login_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "username": "conor",
                            "password": "new-password"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(new_login_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn bookmarks_and_notes_routes_support_crud() {
        let state = test_state();
        state.lock_db().unwrap().execute(
            "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('user-3','conor','synthetic','2026','2026')", [],
        ).unwrap();
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
    async fn mobile_keyboard_debug_routes_store_and_clear_entries() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-mobile", "conor");
        let logs_path = state
            .config()
            .data_dir
            .join("users")
            .join("user-mobile")
            .join("mobile-keyboard-debug.json");
        let app = app(state);

        let ingest_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mobile-keyboard-debug")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "Mobile Safari Test")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "visualViewportHeight": 402,
                            "visualViewportOffsetTop": 248,
                            "layout": {
                                "top": 248,
                                "height": 402
                            }
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(ingest_response.status(), StatusCode::OK);
        assert!(logs_path.exists());

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mobile-keyboard-debug")
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
        assert_eq!(list_payload["count"], 1);
        assert_eq!(list_payload["entries"][0]["visualViewportHeight"], 402);
        assert_eq!(
            list_payload["entries"][0]["requestUserAgent"],
            "Mobile Safari Test"
        );
        assert!(list_payload["entries"][0]["serverRecordedAt"]
            .as_str()
            .is_some());

        let clear_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/mobile-keyboard-debug")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(clear_response.status(), StatusCode::OK);

        let cleared_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/mobile-keyboard-debug")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        let cleared_body = cleared_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let cleared_payload: Value =
            serde_json::from_slice(&cleared_body).expect("cleared payload should deserialize");
        assert_eq!(cleared_payload["count"], 0);
        assert_eq!(cleared_payload["entries"], json!([]));
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
        assert!(preview_payload["ports"].is_array());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_download_rejects_symlink_escape() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-download", "conor");
        let app = app(state);
        let temp_root = tempdir().expect("temp dir should create");
        let base_dir = temp_root.path().join("base");
        let outside_dir = temp_root.path().join("outside");
        fs::create_dir_all(&base_dir).expect("base dir should create");
        fs::create_dir_all(&outside_dir).expect("outside dir should create");
        let outside_file = outside_dir.join("secret.txt");
        fs::write(&outside_file, "secret").expect("outside file should write");
        let link_path = base_dir.join("link.txt");
        std::os::unix::fs::symlink(&outside_file, &link_path).expect("symlink should create");

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/files/download?path={}",
                        link_path.to_string_lossy()
                    ))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn preview_route_family_supports_file_serving_storage_and_proxy_logs() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-preview", "conor");
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("api crate should be nested under rust/crates/api")
            .to_path_buf();
        let preview_dir =
            tempfile::tempdir_in(&project_root).expect("preview temp dir should create in repo");
        fs::write(
            preview_dir.path().join("index.html"),
            "<h1>Rust Preview</h1>",
        )
        .expect("preview file should write");

        state
            .request_log_store()
            .add_log(
                "user-preview",
                5173,
                preview::request_logs::ProxyLogInput {
                    timestamp: 123,
                    method: "GET".to_string(),
                    url: "http://localhost:5173/".to_string(),
                    status: Some(200),
                    status_text: Some("OK".to_string()),
                    duration: 5,
                    request_size: None,
                    response_size: Some(18),
                    content_type: Some("text/html".to_string()),
                    error: None,
                },
            )
            .await;

        let app = app(state);

        let preview_path = preview_dir.path().to_string_lossy().replace('\\', "/");
        let preview_query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", &preview_path)
            .append_pair("file", "index.html")
            .finish();
        let preview_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/preview?{preview_query}"))
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
        let preview_html = std::str::from_utf8(&preview_body).expect("preview should remain UTF-8");
        assert!(preview_html.starts_with("<h1>Rust Preview</h1>"));
        assert!(preview_html.contains("data-preview-inspector=\"true\""));

        let proxy_logs_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/preview/5173/proxy-logs")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(proxy_logs_response.status(), StatusCode::OK);
        let proxy_logs_body = proxy_logs_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let proxy_logs_payload: Value =
            serde_json::from_slice(&proxy_logs_body).expect("proxy logs should deserialize");
        assert_eq!(proxy_logs_payload["logs"].as_array().map(Vec::len), Some(1));

        let storage_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/preview/5173/storage")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(storage_response.status(), StatusCode::NOT_IMPLEMENTED);

        let invalid_storage_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/preview/5173/storage")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "type": "localStorage",
                            "operation": "set",
                            "key": "bad key!",
                            "value": "123"
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(invalid_storage_response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn preview_performance_routes_store_clear_and_stream_metrics() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-performance", "conor");
        let (app_port, app_handle) = spawn_router(app(state)).await;
        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{app_port}");

        let post_response = client
            .post(format!("{base_url}/api/preview/5173/performance"))
            .bearer_auth(&token)
            .json(&json!({
                "metrics": [{
                    "type": "coreWebVitals",
                    "timestamp": 10,
                    "data": { "lcp": 1234 }
                }]
            }))
            .send()
            .await
            .expect("performance post should succeed");
        assert_eq!(post_response.status(), reqwest::StatusCode::OK);

        let get_response = client
            .get(format!("{base_url}/api/preview/5173/performance"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("performance get should succeed");
        assert_eq!(get_response.status(), reqwest::StatusCode::OK);
        let get_payload: Value = get_response
            .json()
            .await
            .expect("performance payload should deserialize");
        assert_eq!(
            get_payload["metrics"]["coreWebVitals"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );

        let stream_url =
            format!("ws://127.0.0.1:{app_port}/api/preview/5173/performance/stream?token={token}");
        let (mut socket, _) = tokio_tungstenite::connect_async(&stream_url)
            .await
            .expect("performance websocket should connect");

        let second_post_response = client
            .post(format!("{base_url}/api/preview/5173/performance"))
            .bearer_auth(&token)
            .json(&json!({
                "metrics": [{
                    "type": "runtimeMetrics",
                    "timestamp": 20,
                    "data": { "fps": 60 }
                }]
            }))
            .send()
            .await
            .expect("second performance post should succeed");
        assert_eq!(second_post_response.status(), reqwest::StatusCode::OK);

        let stream_message = socket
            .next()
            .await
            .expect("stream update should arrive")
            .expect("stream update should be valid");
        let stream_payload: Value = serde_json::from_str(
            &stream_message
                .into_text()
                .expect("performance websocket payload should be text"),
        )
        .expect("performance websocket payload should parse");
        assert_eq!(stream_payload["type"], "performance-update");
        assert_eq!(
            stream_payload["metrics"]["runtimeMetrics"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );

        let delete_response = client
            .delete(format!("{base_url}/api/preview/5173/performance"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("performance delete should succeed");
        assert_eq!(delete_response.status(), reqwest::StatusCode::OK);

        let empty_response = client
            .get(format!("{base_url}/api/preview/5173/performance"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("performance get after delete should succeed");
        let empty_payload: Value = empty_response
            .json()
            .await
            .expect("empty performance payload should deserialize");
        assert_eq!(
            empty_payload["metrics"],
            json!({
                "coreWebVitals": [],
                "loadMetrics": [],
                "runtimeMetrics": []
            })
        );

        let _ = socket.close(None).await;
        app_handle.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preview_recording_routes_start_and_stop_recordings() {
        let _env_guard = ENV_LOCK.lock().expect("env lock should acquire");
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-recording", "conor");
        let app = app(state);
        let temp = tempdir().expect("temp dir should create");
        let bin_path = temp.path().join("fake-node");
        let recordings_dir = temp.path().join("recordings");

        fs::write(
            &bin_path,
            r#"#!/bin/sh
mkdir -p "$TERMINAL_V4_RECORDING_OUTPUT_DIR"
echo READY
while IFS= read -r command; do
  if [ "$command" = STOP ]; then
    touch "$TERMINAL_V4_RECORDING_OUTPUT_DIR/test-recording.webm"
    exit 0
  fi
done
exit 1
"#,
        )
        .expect("fake node script should write");
        let mut permissions = fs::metadata(&bin_path)
            .expect("script metadata should load")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&bin_path, permissions).expect("script permissions should update");

        let previous_node_bin = std::env::var("PLAYWRIGHT_NODE_BIN").ok();
        let previous_recording_dir = std::env::var("RECORDING_DIR").ok();
        unsafe {
            std::env::set_var("PLAYWRIGHT_NODE_BIN", &bin_path);
            std::env::set_var("RECORDING_DIR", &recordings_dir);
        }

        let start_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/preview/5173/recording/start")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({ "width": 800, "height": 600 }).to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(start_response.status(), StatusCode::OK);
        let start_body = start_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let start_payload: Value =
            serde_json::from_slice(&start_body).expect("start payload should deserialize");
        assert_eq!(start_payload["success"], Value::Bool(true));
        let recording_id = start_payload["recordingId"]
            .as_str()
            .expect("recording id should be returned")
            .to_string();

        let stop_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/preview/recording/{recording_id}/stop"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(stop_response.status(), StatusCode::OK);
        let stop_body = stop_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let stop_payload: Value =
            serde_json::from_slice(&stop_body).expect("stop payload should deserialize");
        assert_eq!(stop_payload["success"], Value::Bool(true));
        assert_eq!(
            stop_payload["filename"],
            Value::String("test-recording.webm".to_string())
        );

        match previous_node_bin {
            Some(value) => unsafe { std::env::set_var("PLAYWRIGHT_NODE_BIN", value) },
            None => unsafe { std::env::remove_var("PLAYWRIGHT_NODE_BIN") },
        }
        match previous_recording_dir {
            Some(value) => unsafe { std::env::set_var("RECORDING_DIR", value) },
            None => unsafe { std::env::remove_var("RECORDING_DIR") },
        }
    }

    #[tokio::test]
    async fn path_preview_proxy_rewrites_html_and_surfaces_anonymous_logs_and_cookies() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-path-preview", "conor");
        let preview_cookie = preview_test_cookie(&state, "user-path-preview", "conor");
        let app = app(state);
        let (port, upstream_handle) = spawn_preview_upstream().await;

        let preview_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/preview/{port}/?view=app"))
                    .header(axum::http::header::COOKIE, preview_cookie.as_str())
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
        let preview_html =
            String::from_utf8(preview_body.to_vec()).expect("html response should be utf-8");
        assert!(preview_html.contains("data-preview-debug"));
        assert!(preview_html.contains(&format!(r#"<base href="/preview/{port}/">"#)));
        assert!(preview_html.contains(&format!(
            r#"href="/preview/{port}/styles.css?previewToken="#
        )));
        assert!(preview_html.contains(&format!(r#"src="/preview/{port}/main.js?previewToken="#)));
        assert!(preview_html.contains(&format!(
            r#"from "/preview/{port}/@react-refresh?previewToken="#
        )));
        assert!(preview_html.contains(&format!(
            r#"import("/preview/{port}/src/main.jsx?previewToken="#
        )));

        let css_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/preview/{port}/styles.css"))
                    .header(axum::http::header::COOKIE, preview_cookie.as_str())
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(css_response.status(), StatusCode::OK);
        let css_body = css_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let css_text = String::from_utf8(css_body.to_vec()).expect("css should be utf-8");
        assert!(css_text.contains(&format!(
            r#"url("/preview/{port}/assets/bg.png?previewToken="#
        )));

        let cookies_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/preview/{port}/cookies"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(cookies_response.status(), StatusCode::OK);
        let cookies_body = cookies_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let cookies_payload: Value =
            serde_json::from_slice(&cookies_body).expect("cookie payload should deserialize");
        assert_eq!(cookies_payload["hasCookies"], Value::Bool(true));
        assert_eq!(cookies_payload["cookies"][0]["name"], "session");

        let proxy_logs_response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/preview/{port}/proxy-logs"))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(proxy_logs_response.status(), StatusCode::OK);
        let proxy_logs_body = proxy_logs_response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let proxy_logs_payload: Value =
            serde_json::from_slice(&proxy_logs_body).expect("proxy logs should deserialize");
        let logs = proxy_logs_payload["logs"]
            .as_array()
            .expect("logs should be an array");
        assert!(logs.len() >= 2);
        assert!(logs.iter().any(|entry| {
            entry["url"]
                .as_str()
                .map(|value| value == format!("http://localhost:{port}/?view=app"))
                .unwrap_or(false)
        }));
        assert!(logs.iter().any(|entry| {
            entry["url"]
                .as_str()
                .map(|value| value == format!("http://localhost:{port}/styles.css"))
                .unwrap_or(false)
        }));

        upstream_handle.abort();
    }

    #[tokio::test]
    async fn preview_subdomain_host_proxy_intercepts_http_requests() {
        let state = test_state();
        let preview_cookie = preview_test_cookie(&state, "user-preview-subdomain", "conor");
        let (upstream_port, upstream_handle) = spawn_preview_upstream().await;
        let (app_port, app_handle) = spawn_router(app(state)).await;
        let client = reqwest::Client::new();

        let response = client
            .get(format!("http://127.0.0.1:{app_port}/?mode=subdomain"))
            .header(reqwest::header::COOKIE, preview_cookie)
            .header(
                "Host",
                format!("preview-{upstream_port}.localhost:{app_port}"),
            )
            .send()
            .await
            .expect("subdomain preview request should succeed");

        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body = response.text().await.expect("response body should read");
        assert!(body.contains("data-preview-debug"));
        assert!(body.contains(r#"href="/styles.css?previewToken="#));
        assert!(body.contains(r#"src="/main.js?previewToken="#));

        app_handle.abort();
        upstream_handle.abort();
    }

    #[tokio::test]
    async fn latency_websocket_replies_to_authenticated_ping_messages() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-latency", "conor");
        let (app_port, app_handle) = spawn_router(app(state)).await;

        let url = format!("ws://127.0.0.1:{app_port}/api/latency/ws?token={token}");
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("latency websocket should connect");

        socket
            .send(tungstenite::Message::Text("ping".into()))
            .await
            .expect("ping should send");

        let pong = socket
            .next()
            .await
            .expect("pong should arrive")
            .expect("pong frame should be valid");
        assert_eq!(pong.into_text().expect("pong should be text"), "pong");

        let _ = socket.close(None).await;
        app_handle.abort();
    }

    #[tokio::test]
    async fn path_preview_proxy_bridges_websocket_messages_to_upstream() {
        let state = test_state();
        let preview_cookie = preview_test_cookie(&state, "user-path-preview-ws", "conor");
        let (upstream_port, upstream_handle) = spawn_preview_ws_upstream().await;
        let (app_port, app_handle) = spawn_router(app(state)).await;

        let url = format!("ws://127.0.0.1:{app_port}/preview/{upstream_port}/hmr");
        let mut request = url
            .into_client_request()
            .expect("websocket request should build");
        request.headers_mut().insert(
            axum::http::header::COOKIE,
            axum::http::HeaderValue::from_str(&preview_cookie).expect("cookie header should build"),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("websocket client should connect");

        let initial_message = socket
            .next()
            .await
            .expect("initial websocket message should arrive")
            .expect("initial websocket message should be valid");
        assert_eq!(initial_message.into_text().expect("text frame"), "ready");

        socket
            .send(tungstenite::Message::Text("ping".into()))
            .await
            .expect("client should send websocket message");

        let echoed_message = socket
            .next()
            .await
            .expect("echoed websocket message should arrive")
            .expect("echoed websocket message should be valid");
        assert_eq!(echoed_message.into_text().expect("text frame"), "echo:ping");

        let _ = socket.close(None).await;
        app_handle.abort();
        upstream_handle.abort();
    }

    #[tokio::test]
    async fn preview_subdomain_host_proxy_bridges_websocket_messages_to_upstream() {
        let state = test_state();
        let preview_cookie = preview_test_cookie(&state, "user-preview-subdomain-ws", "conor");
        let (upstream_port, upstream_handle) = spawn_preview_ws_upstream().await;
        let (app_port, app_handle) = spawn_router(app(state)).await;

        let mut request = format!("ws://127.0.0.1:{app_port}/hmr")
            .into_client_request()
            .expect("websocket request should build");
        request.headers_mut().insert(
            axum::http::header::COOKIE,
            axum::http::HeaderValue::from_str(&preview_cookie).expect("cookie header should build"),
        );
        request.headers_mut().insert(
            axum::http::header::HOST,
            axum::http::HeaderValue::from_str(&format!(
                "preview-{upstream_port}.localhost:{app_port}"
            ))
            .expect("host header should build"),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("websocket client should connect");

        let initial_message = socket
            .next()
            .await
            .expect("initial websocket message should arrive")
            .expect("initial websocket message should be valid");
        assert_eq!(initial_message.into_text().expect("text frame"), "ready");

        socket
            .send(tungstenite::Message::Text("subdomain".into()))
            .await
            .expect("client should send websocket message");

        let echoed_message = socket
            .next()
            .await
            .expect("echoed websocket message should arrive")
            .expect("echoed websocket message should be valid");
        assert_eq!(
            echoed_message.into_text().expect("text frame"),
            "echo:subdomain"
        );

        let _ = socket.close(None).await;
        app_handle.abort();
        upstream_handle.abort();
    }

    #[tokio::test]
    async fn dev_proxy_forwarding_removes_consumed_credentials_and_keeps_business_tokens() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let upstream = axum::Router::new().route(
            "/owned",
            axum::routing::get(
                |uri: axum::http::Uri, headers: axum::http::HeaderMap, ws: WebSocketUpgrade| async move {
                    let payload = json!({"query":uri.query().unwrap_or(""),
                    "authorization":headers.get("authorization").and_then(|v|v.to_str().ok()),
                    "cookie":headers.get("cookie").and_then(|v|v.to_str().ok()),
                    "referer":headers.get("referer").and_then(|v|v.to_str().ok())});
                    ws.on_upgrade(move |mut socket| async move {
                        let _ = socket
                            .send(axum::extract::ws::Message::Text(payload.to_string().into()))
                            .await;
                        let _ = socket.recv().await;
                    })
                },
            ),
        );
        let (upstream_port, upstream_handle) = spawn_router(upstream).await;
        let state = test_state();
        let token = issue_access_token(
            &state.config().jwt_secret,
            "dev-credential-fixture",
            "synthetic",
        );
        let (app_port, app_handle) = spawn_router(app(state)).await;
        for (query, bearer, expected) in [
            (
                format!("token={token}&previewToken=reserved&topic=owned"),
                false,
                vec![("topic", "owned")],
            ),
            (
                "token=business&previewToken=reserved&topic=owned".into(),
                true,
                vec![("token", "business"), ("topic", "owned")],
            ),
            (
                format!("token={token}&token=business&topic=owned"),
                false,
                vec![("topic", "owned")],
            ),
        ] {
            let url =
                format!("ws://127.0.0.1:{app_port}/api/dev-proxy-ws/{upstream_port}/owned?{query}");
            let mut request = url.into_client_request().unwrap();
            if bearer {
                request
                    .headers_mut()
                    .insert("authorization", format!("Bearer {token}").parse().unwrap());
            }
            request
                .headers_mut()
                .insert("cookie", "private=synthetic".parse().unwrap());
            request
                .headers_mut()
                .insert("referer", "http://fixture.invalid/private".parse().unwrap());
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let payload: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            let pairs: Vec<_> =
                url::form_urlencoded::parse(payload["query"].as_str().unwrap().as_bytes())
                    .into_owned()
                    .collect();
            assert_eq!(
                pairs,
                expected
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                (
                    &payload["authorization"],
                    &payload["cookie"],
                    &payload["referer"]
                ),
                (&Value::Null, &Value::Null, &Value::Null)
            );
            socket.close(None).await.unwrap();
        }
        app_handle.abort();
        upstream_handle.abort();
    }

    #[tokio::test]
    async fn dev_proxy_websocket_route_bridges_messages_for_authenticated_clients() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "user-dev-proxy", "conor");
        let (upstream_port, upstream_handle) = spawn_preview_ws_upstream().await;
        let (app_port, app_handle) = spawn_router(app(state)).await;

        let url =
            format!("ws://127.0.0.1:{app_port}/api/dev-proxy-ws/{upstream_port}/hmr?token={token}");
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("websocket client should connect");

        let initial_message = socket
            .next()
            .await
            .expect("initial websocket message should arrive")
            .expect("initial websocket message should be valid");
        assert_eq!(initial_message.into_text().expect("text frame"), "ready");

        socket
            .send(tungstenite::Message::Text("dev-proxy".into()))
            .await
            .expect("client should send websocket message");

        let echoed_message = socket
            .next()
            .await
            .expect("echoed websocket message should arrive")
            .expect("echoed websocket message should be valid");
        assert_eq!(
            echoed_message.into_text().expect("text frame"),
            "echo:dev-proxy"
        );

        let _ = socket.close(None).await;
        app_handle.abort();
        upstream_handle.abort();
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
    async fn structured_inventory_omits_transcripts_and_preserves_owned_metadata_and_detail_routes()
    {
        let state =
            test_state_with_structured_provider(Arc::new(FakeStructuredProvider::new(false)));
        let manager = state.structured_session_manager();
        let workspace = state.config().data_dir.canonicalize().unwrap();
        let cwd = workspace.to_str().unwrap();
        let owner = "inventory-owner";
        let other = "inventory-other";
        let session = manager
            .create_session(
                owner,
                cwd,
                Some("claude"),
                Some("sonnet"),
                Some("Inventory fixture"),
            )
            .await
            .unwrap();
        let other_session = manager
            .create_session(other, cwd, Some("claude"), None, Some("Other fixture"))
            .await
            .unwrap();
        manager
            .send_message(owner, &session.id, "Inventory event fixture")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if manager
                    .get_session(owner, &session.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .events
                    .last()
                    .is_some_and(|event| matches!(event, StructuredSessionEvent::SessionEnded { reason, .. } if reason == "completed"))
                {
                    break;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let router = app(state.clone());
        let owner_token = issue_access_token(&state.config().jwt_secret, owner, "fixture");
        let other_token = issue_access_token(&state.config().jwt_secret, other, "fixture");
        for (token, expected_id, expected_seq) in [
            (&owner_token, &session.id, 4),
            (&other_token, &other_session.id, 0),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/structured/sessions?view=inventory")
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let inventory: Value = serde_json::from_slice(&body).unwrap();
            let entries = inventory.as_array().unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0]["id"], *expected_id);
            assert_eq!(entries[0]["provider"], "claude");
            assert_eq!(entries[0]["status"], "idle");
            if expected_id == &session.id {
                assert_eq!(
                    (entries[0]["title"].as_str(), entries[0]["model"].as_str()),
                    (Some("Inventory fixture"), Some("sonnet"))
                );
            }
            assert_eq!(
                (
                    entries[0]["latestSeq"].as_i64(),
                    entries[0]["statusSeq"].as_i64()
                ),
                (Some(expected_seq), Some(expected_seq))
            );
            assert!(
                entries[0].get("events").is_none(),
                "Inventory must not transport transcript bodies"
            );
            assert_eq!(
                (
                    entries[0]["cwd"].as_str(),
                    entries[0]["thread"]["projectPath"].as_str()
                ),
                (Some(cwd), Some(cwd))
            );
        }
        for uri in [
            "/api/structured/sessions".to_string(),
            format!("/api/structured/sessions/{}", session.id),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header("Authorization", format!("Bearer {owner_token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let payload: Value = serde_json::from_slice(&body).unwrap();
            let detail = if payload.is_array() {
                &payload[0]
            } else {
                &payload
            };
            assert_eq!(
                (
                    detail["id"].as_str(),
                    detail["title"].as_str(),
                    detail["provider"].as_str(),
                    detail["model"].as_str()
                ),
                (
                    Some(session.id.as_str()),
                    Some("Inventory fixture"),
                    Some("claude"),
                    Some("sonnet")
                )
            );
            let events = detail["events"].as_array().unwrap();
            assert_eq!(
                events
                    .iter()
                    .map(|event| (event["type"].as_str(), event["seq"].as_i64()))
                    .collect::<Vec<_>>(),
                vec![
                    (Some("message_completed"), Some(1)),
                    (Some("session_started"), Some(2)),
                    (Some("status"), Some(3)),
                    (Some("session_ended"), Some(4)),
                ]
            );
            assert_eq!(
                (events[0]["role"].as_str(), events[0]["content"].as_str()),
                (Some("user"), Some("Inventory event fixture"))
            );
            assert!(events[0]["messageId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()));
            assert_eq!(events[3]["reason"], "completed");
        }
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/structured/sessions?view=unknown")
                    .header("Authorization", format!("Bearer {owner_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
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
        assert!(create_payload["thread"]["projectPath"]
            .as_str()
            .expect("project path should be a string")
            .ends_with("structured-workspace"));
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
        let get_thread_payload: Value = serde_json::from_slice(&get_thread_body)
            .expect("get thread payload should deserialize");
        assert_eq!(get_thread_payload["thread"]["topic"], "Review Rust rewrite");
        assert_eq!(get_thread_payload["thread"]["pinned"], true);

        for payload in [
            json!({"snoozeForSeconds": 0}),
            json!({"snoozeForSeconds": 60, "wakeSnooze": true}),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PATCH")
                        .uri(format!("/api/structured/sessions/{session_id}/thread"))
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        let snooze_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/structured/sessions/{session_id}/thread"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({"snoozeForSeconds": 3600}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(snooze_response.status(), StatusCode::OK);
        let snooze_payload: Value = serde_json::from_slice(
            &snooze_response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
        )
        .unwrap();
        assert_eq!(snooze_payload["threadLifecycleVersion"], 1);
        assert!(snooze_payload["thread"]["snooze"]["untilMs"]
            .as_i64()
            .is_some());

        let inventory_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/structured/sessions?view=inventory")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(inventory_response.status(), StatusCode::OK);
        let inventory_payload: Value = serde_json::from_slice(
            &inventory_response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
        )
        .unwrap();
        assert_eq!(inventory_payload[0]["threadLifecycle"]["snoozed"], true);
        assert_eq!(
            inventory_payload[0]["threadLifecycle"]["requiresAttention"],
            false
        );

        let wake_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/structured/sessions/{session_id}/thread"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({"wakeSnooze": true}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wake_response.status(), StatusCode::OK);
        let wake_payload: Value = serde_json::from_slice(
            &wake_response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
        )
        .unwrap();
        assert!(wake_payload["thread"].get("snooze").is_none());

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

    #[cfg(unix)]
    #[tokio::test]
    async fn structured_settlement_routes_require_owner_and_publish_lifecycle() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new_runtime(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let owner = "settlement-owner";
        let token = issue_access_token(&state.config().jwt_secret, owner, "owner");
        let foreign = issue_access_token(&state.config().jwt_secret, "other-owner", "other");
        let workspace = state.config().data_dir.join("settlement-workspace");
        fs::create_dir_all(&workspace).unwrap();
        let session = state
            .structured_session_manager()
            .create_session(
                owner,
                workspace.to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        let app = app(state.clone());
        let patch = |token: &str, value: bool| {
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/structured/sessions/{}/thread", session.id))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(json!({"settled":value}).to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(patch(&foreign, true))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let response = app.clone().oneshot(patch(&token, true)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["threadSettlementVersion"], 1);
        assert_eq!(
            body["thread"]["settlement"]["queueFingerprint"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/structured/sessions?view=inventory")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let inventory: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(inventory[0]["threadLifecycle"]["settled"], true);
        let response = app.oneshot(patch(&token, false)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert!(body["thread"].get("settlement").is_none());
        state.structured_session_manager().shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn structured_input_route_can_start_a_message_when_idle() {
        let provider = Arc::new(FakeStructuredProvider::new(false));
        let state = test_state_with_structured_provider(provider.clone());
        let token =
            issue_access_token(&state.config().jwt_secret, "user-structured-input", "conor");
        let app = app(state.clone());
        let workspace = state.config().data_dir.join("structured-input-idle");
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

        let input_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{session_id}/input"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({
                            "text": "hello from input\n",
                            "fallbackToMessage": true
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(input_response.status(), StatusCode::ACCEPTED);

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
        assert!(events.iter().any(|event| {
            event["type"] == "status" && event["status"] == "prompt:hello from input"
        }));
        assert_eq!(provider.spawn_hits(), 1);
        assert_eq!(provider.input_hits(), 0);
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

        let input_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{session_id}/input"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({ "text": "follow-up\n" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(input_response.status(), StatusCode::ACCEPTED);

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
            .any(|event| { event["type"] == "status" && event["status"] == "input:follow-up\\n" }));
        assert!(events
            .iter()
            .any(|event| { event["type"] == "status" && event["status"] == "approved" }));
        assert!(events
            .iter()
            .any(|event| { event["type"] == "session_ended" && event["reason"] == "interrupted" }));
        assert_eq!(provider.spawn_hits(), 1);
        assert_eq!(provider.input_hits(), 1);
        assert_eq!(provider.approval_hits(), 1);
        assert_eq!(provider.interrupt_hits(), 1);
    }

    #[tokio::test]
    async fn workspace_routes_keep_owned_history_and_tasks_out_of_shared_caches() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "workspace-owner", "owner");
        for uri in ["/api/workspace/history", "/api/workspace/tasks"] {
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response
                    .headers()
                    .get("cache-control")
                    .and_then(|value| value.to_str().ok()),
                Some("private, no-store")
            );
        }
    }

    #[tokio::test]
    async fn remote_workspace_responses_are_private_and_not_stored() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "remote-cache-owner", "owner");
        for uri in [
            "/api/transfers",
            "/api/recordings",
            "/api/collaboration/invitations",
            "/api/tunnels",
            "/api/relay/status",
            "/api/desktop/status",
            "/api/environments",
        ] {
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(
                response
                    .headers()
                    .get("cache-control")
                    .and_then(|value| value.to_str().ok()),
                Some("private, no-store"),
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn workspace_profile_routes_require_authentication() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/api/workspace/profile?path=/project")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn workspace_profile_persists_and_isolates_users_and_projects() {
        let state = test_state();
        let project = state.config().data_dir.join("workspace-profile-project");
        fs::create_dir_all(&project).unwrap();
        let other_project = state.config().data_dir.join("workspace-profile-other");
        fs::create_dir_all(&other_project).unwrap();
        let uri = format!(
            "/api/workspace/profile?path={}",
            url::form_urlencoded::byte_serialize(project.to_str().unwrap().as_bytes())
                .collect::<String>()
        );
        let token = issue_access_token(&state.config().jwt_secret, "workspace-owner", "owner");
        let other_token =
            issue_access_token(&state.config().jwt_secret, "workspace-other", "other");
        let profile = json!({
            "memory": "Use the Rust API.", "defaultAgent": "claude",
            "selection": { "model": "sonnet", "reasoning": "high" },
            "skills": [{ "id": "00000000-0000-4000-8000-000000000001", "name": "Review", "instructions": "Check async boundaries." }]
        });
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(&uri)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(profile.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let fresh_state = test_state_with_data_dir(state.config().data_dir.clone());
        let mut results = Vec::new();
        let other_uri = format!(
            "/api/workspace/profile?path={}",
            url::form_urlencoded::byte_serialize(other_project.to_str().unwrap().as_bytes())
                .collect::<String>()
        );
        for (request_uri, request_token) in
            [(&uri, &token), (&uri, &other_token), (&other_uri, &token)]
        {
            let response = app(fresh_state.clone())
                .oneshot(
                    Request::builder()
                        .uri(request_uri)
                        .header("Authorization", format!("Bearer {request_token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            results.push(
                serde_json::from_slice::<Value>(
                    &response.into_body().collect().await.unwrap().to_bytes(),
                )
                .unwrap(),
            );
        }
        let empty = json!({ "memory": "", "defaultAgent": "", "selection": null, "skills": [] });
        assert_eq!(results, vec![profile, empty.clone(), empty]);
    }

    #[tokio::test]
    async fn workspace_profile_rejects_oversized_knowledge() {
        let state = test_state();
        let token = issue_access_token(&state.config().jwt_secret, "workspace-owner", "owner");
        let project = state.config().data_dir.to_str().unwrap();
        let uri = format!(
            "/api/workspace/profile?path={}",
            url::form_urlencoded::byte_serialize(project.as_bytes()).collect::<String>()
        );
        let response = app(state)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(uri)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({ "memory": "x".repeat(6001) }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    async fn preview_grant(state: &ApiState, profile: &str) -> (String, String) {
        let owner = issue_access_token(&state.config().jwt_secret, "preview-grant-owner", "owner");
        let issued = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/environments/pairing-code")
                    .header("Authorization", format!("Bearer {owner}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({"label":"Preview grant","profile":profile}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(issued.status(), StatusCode::OK);
        let code: Value =
            serde_json::from_slice(&issued.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let exchanged = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/environments/exchange")
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({"code":code["code"]}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(exchanged.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&exchanged.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        (
            body["credential"].as_str().unwrap().into(),
            body["grantId"].as_str().unwrap().into(),
        )
    }

    #[tokio::test]
    async fn preview_grant_cannot_issue_or_renew_owner_preview_cookies() {
        let state = test_state();
        for profile in ["observer", "operator"] {
            let (credential, _) = preview_grant(&state, profile).await;
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/preview/session")
                        .header("Authorization", format!("Bearer {credential}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert!(response.headers().get("set-cookie").is_none());
        }
        let cookie = preview_test_cookie(&state, "preview-grant-owner", "owner");
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/preview/session")
                    .header("Cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let owner = issue_access_token(&state.config().jwt_secret, "preview-grant-owner", "owner");
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/preview/session")
                    .header("Authorization", format!("Bearer {owner}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("set-cookie").is_some());
    }

    #[tokio::test]
    async fn preview_grant_observer_cannot_open_an_opaque_control_socket() {
        let state = test_state();
        let (credential, _) = preview_grant(&state, "observer").await;
        let (upstream, upstream_task) = spawn_preview_ws_upstream().await;
        let (port, task) = spawn_router(app(state)).await;
        let mut request = format!("ws://127.0.0.1:{port}/preview/{upstream}/hmr")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {credential}").parse().unwrap(),
        );
        let connection = tokio_tungstenite::connect_async(request).await;
        task.abort();
        upstream_task.abort();
        assert!(
            matches!(connection,Err(tungstenite::Error::Http(response)) if response.status()==StatusCode::FORBIDDEN)
        );
    }

    #[tokio::test]
    async fn preview_grant_revocation_closes_direct_preview_and_performance_sockets() {
        let state = test_state();
        let (credential, grant) = preview_grant(&state, "operator").await;
        let (upstream, upstream_task) = spawn_preview_ws_upstream().await;
        let (port, task) = spawn_router(app(state.clone())).await;
        let mut request = format!("ws://127.0.0.1:{port}/preview/{upstream}/hmr")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {credential}").parse().unwrap(),
        );
        let (mut preview, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(
            preview.next().await.unwrap().unwrap().into_text().unwrap(),
            "ready"
        );
        let mut request =
            format!("ws://127.0.0.1:{port}/api/preview/{upstream}/performance/stream")
                .into_client_request()
                .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {credential}").parse().unwrap(),
        );
        let (mut performance, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let owner = issue_access_token(&state.config().jwt_secret, "preview-grant-owner", "owner");
        let revoke = app(state)
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/environments/grants/{grant}"))
                    .header("Authorization", format!("Bearer {owner}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoke.status(), StatusCode::NO_CONTENT);
        let results = tokio::join!(
            tokio::time::timeout(Duration::from_secs(5), preview.next()),
            tokio::time::timeout(Duration::from_secs(5), performance.next())
        );
        task.abort();
        upstream_task.abort();
        for result in [results.0, results.1] {
            let frame = result
                .expect("Revoked socket must close within two seconds plus scheduling margin");
            assert!(matches!(
                frame,
                None | Some(Err(_)) | Some(Ok(tungstenite::Message::Close(_)))
            ));
        }
    }

    #[tokio::test]
    async fn preview_grant_direct_event_stream_closes_after_revocation() {
        let state = test_state();
        let (credential, grant) = preview_grant(&state, "observer").await;
        let (port, task) = spawn_router(app(state.clone())).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!(
                "http://127.0.0.1:{port}/api/preview/5173/log-stream"
            ))
            .bearer_auth(credential)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let owner = issue_access_token(&state.config().jwt_secret, "preview-grant-owner", "owner");
        let revoke = app(state)
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/environments/grants/{grant}"))
                    .header("Authorization", format!("Bearer {owner}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoke.status(), StatusCode::NO_CONTENT);
        let closed = tokio::time::timeout(Duration::from_secs(5), response.bytes()).await;
        task.abort();
        closed
            .expect("Revoked paired event stream must close")
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn structured_create_accepts_canonical_saved_profile_ids_beyond_static_provider_limit() {
        use crate::v4_agent::profile::Binding;
        use terminal_v4_provider_connections::Transport;
        let state = test_state();
        let workspace = state.config().data_dir.join("own-profile-workspace");
        fs::create_dir_all(&workspace).unwrap();
        let token = issue_access_token("test-secret", "own-profile-owner", "own-profile-owner");
        let app = app(state.clone());
        let request = |uri: &str, method: &str, body: Value| {
            Request::builder()
                .method(method)
                .uri(uri)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        for (provider, transport) in [
            ("lmstudio", Transport::OpenAiChat),
            ("actual", Transport::OpenAiResponses),
        ] {
            let profile = uuid::Uuid::new_v4().to_string();
            let saved = app.clone().oneshot(request(
                &format!("/api/agent/connections/{profile}"), "PUT",
                json!({"operationId":uuid::Uuid::new_v4(),"expectedRevision":null,"provider":provider,"mode":"local","baseUrl":"http://127.0.0.1:9/v1","auth":{"type":"none"}}),
            )).await.unwrap();
            assert_eq!(saved.status(), StatusCode::OK);
            let saved: Value =
                serde_json::from_slice(&saved.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            let id = Binding::provider_id(
                &profile,
                saved["savedRevision"].as_str().unwrap(),
                transport,
            );
            assert!(id.len() > 80);
            let response = app.clone().oneshot(request(
                "/api/structured/sessions", "POST",
                json!({"cwd":workspace,"provider":id,"model":"own-model","title":"Own saved connection"}),
            )).await.unwrap();
            let status = response.status();
            let body: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(status, StatusCode::CREATED, "{body}");
            assert_eq!(body["provider"], id);
            assert_eq!(body["model"], "own-model");
            assert_eq!(body["runtime"], "v4");
            for invalid in [id.to_uppercase(), format!("{id}:extra"), "x".repeat(81)] {
                let response = app
                    .clone()
                    .oneshot(request(
                        "/api/structured/sessions",
                        "POST",
                        json!({"cwd":workspace,"provider":invalid,"model":"own-model"}),
                    ))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            }
        }
        state.structured_session_manager().shutdown().await.unwrap();
        assert!(state.provider_connections().shutdown().await);
    }

    #[tokio::test]
    async fn codex_selection_route_updates_owned_idle_chat_and_rejects_invalid_or_other_owner() {
        let state = test_state();
        let owner = "selection-route-owner";
        let session = state
            .structured_session_manager()
            .create_with_selection(
                owner,
                state.config().data_dir.to_str().unwrap(),
                Some("codex"),
                Some("old-model"),
                Some("low"),
                Some("Keep this chat"),
            )
            .await
            .unwrap();
        let router = app(state.clone());
        let owner_token = issue_access_token(&state.config().jwt_secret, owner, "fixture");
        let other_token = issue_access_token(
            &state.config().jwt_secret,
            "selection-route-other",
            "fixture",
        );
        for (token, body, status) in [
            (
                Some(&owner_token),
                json!({ "model": "new-model", "reasoning": "high", "serviceTier": "fast" }),
                StatusCode::OK,
            ),
            (
                Some(&owner_token),
                json!({ "model": "", "reasoning": "high" }),
                StatusCode::BAD_REQUEST,
            ),
            (
                Some(&owner_token),
                json!({ "model": "new-model", "reasoning": "high", "serviceTier": "invalid" }),
                StatusCode::BAD_REQUEST,
            ),
            (
                Some(&other_token),
                json!({ "model": "other-model", "reasoning": "low" }),
                StatusCode::NOT_FOUND,
            ),
            (
                None,
                json!({ "model": "other-model" }),
                StatusCode::UNAUTHORIZED,
            ),
        ] {
            let mut request = Request::builder()
                .method("PATCH")
                .uri(format!("/api/structured/sessions/{}/selection", session.id))
                .header("Content-Type", "application/json");
            if let Some(token) = token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            let response = router
                .clone()
                .oneshot(request.body(Body::from(body.to_string())).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            if status == StatusCode::OK {
                let body: Value = serde_json::from_slice(
                    &response.into_body().collect().await.unwrap().to_bytes(),
                )
                .unwrap();
                assert_eq!(body["serviceTier"], "fast");
                assert_eq!(
                    (
                        body["id"].as_str(),
                        body["model"].as_str(),
                        body["reasoning"].as_str(),
                        body["title"].as_str()
                    ),
                    (
                        Some(session.id.as_str()),
                        Some("new-model"),
                        Some("high"),
                        Some("Keep this chat")
                    )
                );
            }
        }
        let reset_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/structured/sessions/{}/selection", session.id))
                    .header("Content-Type", "application/json")
                    .header("Authorization", format!("Bearer {owner_token}"))
                    .body(Body::from(
                        json!({"model":"new-model","reasoning":"high","serviceTier":null})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reset_response.status(), StatusCode::OK);
        let unchanged = state
            .structured_session_manager()
            .get_session(owner, &session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.service_tier, None);
        assert_eq!(
            (unchanged.model.as_deref(), unchanged.reasoning.as_deref()),
            (Some("new-model"), Some("high"))
        );
    }

    fn test_state() -> ApiState {
        test_state_with_external_auth(None)
    }

    fn preview_test_cookie(state: &ApiState, user_id: &str, username: &str) -> String {
        format!(
            "{}={}",
            crate::PREVIEW_COOKIE_NAME,
            crate::issue_preview_token(&state.config().jwt_secret, user_id, username)
        )
    }

    fn test_state_with_data_dir(data_dir: PathBuf) -> ApiState {
        let config = AppConfig {
            data_dir,
            jwt_secret: "test-secret".to_string(),
            ..AppConfig::default()
        };
        ApiState::new_with_external_auth(config, None).expect("state should initialize")
    }

    fn test_state_with_external_auth(
        external_auth: Option<Arc<dyn ExternalAuthProvider>>,
    ) -> ApiState {
        let temp_dir = tempdir().expect("temp dir should create");
        let temp_root = PathBuf::from(temp_dir.keep());
        let config = AppConfig {
            data_dir: temp_root.join("data").join("state"),
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

    async fn spawn_preview_upstream() -> (u16, tokio::task::JoinHandle<()>) {
        let upstream = axum::Router::new()
            .route(
                "/",
                get(|| async {
                    (
                        [
                            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
                            (axum::http::header::SET_COOKIE, "session=abc123; Path=/"),
                        ],
                        r#"
                            <html>
                              <head>
                                <link rel="stylesheet" href="/styles.css">
                              </head>
                              <body>
                                <script type="module">
                                  import RefreshRuntime from "/@react-refresh";
                                  window.__refreshRuntime = RefreshRuntime;
                                  import("/src/main.jsx");
                                </script>
                                <script src="/main.js"></script>
                              </body>
                            </html>
                        "#,
                    )
                }),
            )
            .route(
                "/styles.css",
                get(|| async {
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
                        r#"body { background-image: url("/assets/bg.png"); }"#,
                    )
                }),
            )
            .route(
                "/main.js",
                get(|| async {
                    (
                        [(
                            axum::http::header::CONTENT_TYPE,
                            "text/javascript; charset=utf-8",
                        )],
                        r#"console.log("preview main");"#,
                    )
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let port = listener
            .local_addr()
            .expect("listener should have local addr")
            .port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, upstream)
                .await
                .expect("preview upstream should serve");
        });

        (port, handle)
    }

    async fn spawn_preview_ws_upstream() -> (u16, tokio::task::JoinHandle<()>) {
        let upstream = axum::Router::new().route(
            "/hmr",
            any(
                |ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>| async move {
                    let ws = ws.expect("websocket upgrade should succeed");
                    ws.on_upgrade(|mut socket| async move {
                        let _ = socket.send(Message::Text("ready".into())).await;
                        while let Some(Ok(message)) = socket.recv().await {
                            match message {
                                Message::Text(text) => {
                                    let _ = socket
                                        .send(Message::Text(format!("echo:{text}").into()))
                                        .await;
                                }
                                Message::Close(frame) => {
                                    let _ = socket.send(Message::Close(frame)).await;
                                    break;
                                }
                                _ => {}
                            }
                        }
                    })
                },
            ),
        );

        spawn_router(upstream).await
    }

    async fn spawn_router(router: axum::Router) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let port = listener
            .local_addr()
            .expect("listener should expose a local address")
            .port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("router should serve");
        });
        (port, handle)
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
        spawn_hits: Arc<AtomicUsize>,
        input_hits: Arc<AtomicUsize>,
        approval_hits: Arc<AtomicUsize>,
        interrupt_hits: Arc<AtomicUsize>,
    }

    impl FakeStructuredProvider {
        fn new(keep_running: bool) -> Self {
            Self {
                keep_running,
                spawn_hits: Arc::new(AtomicUsize::new(0)),
                input_hits: Arc::new(AtomicUsize::new(0)),
                approval_hits: Arc::new(AtomicUsize::new(0)),
                interrupt_hits: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn spawn_hits(&self) -> usize {
            self.spawn_hits.load(Ordering::SeqCst)
        }

        fn input_hits(&self) -> usize {
            self.input_hits.load(Ordering::SeqCst)
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
            self.spawn_hits.fetch_add(1, Ordering::SeqCst);
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
                    input_hits: self.input_hits.clone(),
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
        input_hits: Arc<AtomicUsize>,
        approval_hits: Arc<AtomicUsize>,
        interrupt_hits: Arc<AtomicUsize>,
        session_id: String,
        tx: Mutex<Option<mpsc::UnboundedSender<StructuredSessionEvent>>>,
        sequence: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl StructuredProcessController for FakeStructuredProcessController {
        async fn send_input(&self, text: &str) -> Result<(), String> {
            self.input_hits.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.tx.lock().await.as_ref() {
                let _ = tx.send(StructuredSessionEvent::Status {
                    ts: 4,
                    seq: next_fake_seq(&self.sequence),
                    status: format!("input:{}", text.replace('\r', "\\r").replace('\n', "\\n")),
                });
            }
            Ok(())
        }

        #[cfg(unix)]
        async fn send_input_before_expiry(
            &self,
            text: &str,
            expires_at_ms: i64,
        ) -> Result<(), String> {
            let tx = self.tx.lock().await;
            if crate::v4_agent::interaction::now_ms() >= expires_at_ms {
                return Err("Credential expired before stdin delivery".into());
            }
            self.input_hits.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(StructuredSessionEvent::Status {
                    ts: 4,
                    seq: next_fake_seq(&self.sequence),
                    status: format!("input:{}", text.replace('\r', "\\r").replace('\n', "\\n")),
                });
            }
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

        #[cfg(unix)]
        async fn send_paired_decision(
            &self,
            id: Option<&str>,
            approved: bool,
            answers: Option<Value>,
            for_session: bool,
            context: Arc<crate::structured::PairedDecisionContext>,
        ) -> Result<crate::v4_agent::interaction::DecisionReceipt, String> {
            if answers.is_some() || for_session {
                return Err("Fixture does not support that approval".into());
            }
            let tx = self.tx.lock().await;
            context.check_for_test()?;
            self.approval_hits.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(StructuredSessionEvent::Status {
                    ts: 4,
                    seq: next_fake_seq(&self.sequence),
                    status: if approved {
                        "approved".into()
                    } else {
                        "rejected".into()
                    },
                });
            }
            Ok(crate::v4_agent::interaction::DecisionReceipt {
                status: "accepted".into(),
                approval_id: id.unwrap_or("").into(),
                approved,
            })
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

#[cfg(test)]
mod file_mutation_rewind_tests {
    use super::*;
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;
    #[tokio::test]
    async fn checkout_rewind_excludes_file_mutation_routes() {
        let output = std::env::current_dir().unwrap().join("output");
        std::fs::create_dir_all(&output).unwrap();
        let directory = tempfile::tempdir_in(&output).unwrap();
        let checkout = directory.path().join("checkout");
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        let existing = checkout.join("existing.txt");
        std::fs::write(&existing, "original").unwrap();
        let state = AppState::new_with_external_auth(
            AppConfig {
                data_dir: directory.path().join("state"),
                jwt_secret: "file-guard-test".into(),
                ..AppConfig::default()
            },
            None,
        )
        .unwrap();
        let token = auth::issue_access_token(&state.config().jwt_secret, "owner", "owner");
        let _rewind = workspace_activity::exclusive(&checkout).unwrap();
        let app = app(state);
        for (method, url, body) in [
            (
                "POST",
                "/api/files/mkdir",
                json!({"path":checkout.join("new-directory")}),
            ),
            ("DELETE", "/api/files/delete", json!({"path":existing})),
            (
                "POST",
                "/api/files/rename",
                json!({"from":existing,"to":checkout.join("renamed.txt")}),
            ),
            (
                "POST",
                "/api/files/unzip",
                json!({"zipPath":checkout.join("archive.zip"),"extractTo":checkout.join("extracted")}),
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(url)
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT, "{method} {url}");
        }
        for (route, filename, data) in [
            (
                "/api/files/upload",
                "upload.txt",
                b"uploaded bytes".as_slice(),
            ),
            (
                "/api/files/screenshot",
                "screenshot.png",
                b"\x89PNG\r\n\x1a\n".as_slice(),
            ),
        ] {
            let target = checkout.join(filename);
            let mut body=format!("--rewind-test\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{}\r\n--rewind-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n",target.to_string_lossy()).into_bytes();
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n--rewind-test--\r\n");
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(route)
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "multipart/form-data; boundary=rewind-test")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT, "{route}");
            assert!(!target.exists());
        }
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "original");
        assert!(!checkout.join("new-directory").exists());
        assert!(!checkout.join("renamed.txt").exists());
    }
}

#[cfg(test)]
mod preview_framing_regression {
    #[test]
    fn rewritten_preview_has_one_valid_body_length_and_no_upstream_transfer_encoding() {
        let mut response = crate::preview::proxy::ProxyResponse {
            status: 200,
            headers: axum::http::HeaderMap::new(),
            body: b"rewritten html".to_vec(),
        };
        response.headers.insert(
            axum::http::header::TRANSFER_ENCODING,
            "chunked".parse().unwrap(),
        );
        super::update_proxy_response_length(&mut response);
        assert!(!response
            .headers
            .contains_key(axum::http::header::TRANSFER_ENCODING));
        assert_eq!(response.headers[axum::http::header::CONTENT_LENGTH], "14");
    }
}

#[cfg(all(test, unix))]
mod browser_checked_cleanup_api_red {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use serde_json::{json, Value};
    use tower::ServiceExt;
    async fn setup() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        AppState,
        String,
        crate::v4_agent::browser::CleanupProbe,
    ) {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "checked-browser-api".into(),
            ..Default::default()
        })
        .unwrap();
        let id = state
            .structured_session_manager()
            .create_session(
                "checked-owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-v4-pro"),
                None,
            )
            .await
            .unwrap()
            .id;
        let probe = state
            .structured_session_manager()
            .seed_browser_cleanup_test_client("checked-owner", &id)
            .await;
        (data, workspace, state, id, probe)
    }
    fn request(method: &str, path: &str, owner: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header(
                "authorization",
                format!(
                    "Bearer {}",
                    crate::auth::issue_access_token("checked-browser-api", owner, owner)
                ),
            )
            .body(Body::from(body.to_string()))
            .unwrap()
    }
    async fn value(response: axum::response::Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap()
    }
    #[tokio::test]
    async fn browser_checked_cleanup_stop_never_confirms_failed_profile_and_explicit_retry_succeeds(
    ) {
        let (_data, _workspace, state, id, probe) = setup().await;
        let router = app(state.clone());
        probe.fail(Some(crate::v4_agent::browser::CleanupPhase::Profile));
        let response = router
            .clone()
            .oneshot(request(
                "POST",
                &format!("/api/structured/sessions/{id}/interrupt"),
                "checked-owner",
                Value::Null,
            ))
            .await
            .unwrap();
        assert!(
            probe.calls(crate::v4_agent::browser::CleanupPhase::Profile) > 0,
            "Stop must attempt checked browser profile cleanup"
        );
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "Stop must not acknowledge unconfirmed browser cleanup"
        );
        let body = value(response).await;
        assert_ne!(body["cleanupConfirmed"], true);
        assert!(probe.profile().exists());
        let snapshot = state
            .structured_session_manager()
            .get_session("checked-owner", &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.status.as_deref(), Some("cleanup_required"));
        let response=router.clone().oneshot(request("POST",&format!("/api/structured/sessions/{id}/input"),"checked-owner",json!({"requestId":uuid::Uuid::new_v4(),"text":"must remain blocked","fallbackToMessage":true}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        probe.fail(None);
        let response = router
            .oneshot(request(
                "POST",
                &format!("/api/structured/sessions/{id}/interrupt"),
                "checked-owner",
                Value::Null,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            value(response).await,
            json!({"status":"cancelled","cleanupConfirmed":true})
        );
        assert!(!probe.profile().exists());
        assert_eq!(probe.spawns(), 1);
    }
    #[tokio::test]
    async fn browser_checked_cleanup_config_saved_but_failed_cleanup_is503_and_same_save_retries() {
        let (data, _workspace, state, id, probe) = setup().await;
        let router = app(state.clone());
        probe.fail(Some(crate::v4_agent::browser::CleanupPhase::Profile));
        let foreign = router
            .clone()
            .oneshot(request(
                "PUT",
                "/api/agent/browser",
                "checked-foreign",
                json!({"enabled":false}),
            ))
            .await
            .unwrap();
        assert_eq!(foreign.status(), StatusCode::OK);
        assert!(probe.profile().exists());
        let response = router
            .clone()
            .oneshot(request(
                "PUT",
                "/api/agent/browser",
                "checked-owner",
                json!({"enabled":false}),
            ))
            .await
            .unwrap();
        assert!(
            probe.calls(crate::v4_agent::browser::CleanupPhase::Profile) > 0,
            "Config PUT must attempt checked browser profile cleanup"
        );
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = value(response).await;
        assert_eq!(body["settingsSaved"], true);
        assert_eq!(body["cleanupConfirmed"], false);
        assert_eq!(body["config"]["enabled"], false);
        assert!(
            !crate::v4_agent::browser::load_config(data.path(), "checked-owner")
                .unwrap()
                .enabled
        );
        assert!(probe.profile().exists());
        assert_eq!(
            state
                .structured_session_manager()
                .get_session("checked-owner", &id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_deref(),
            Some("cleanup_required")
        );
        probe.fail(None);
        let response = router
            .oneshot(request(
                "PUT",
                "/api/agent/browser",
                "checked-owner",
                json!({"enabled":false}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(value(response).await["enabled"], false);
        assert!(!probe.profile().exists());
        assert_eq!(probe.spawns(), 1);
    }
    #[tokio::test]
    async fn browser_checked_cleanup_delete_failure_preserves_session_and_retained_profile_until_delete_retry(
    ) {
        let (_data, _workspace, state, id, probe) = setup().await;
        let router = app(state.clone());
        let profile = probe.profile();
        probe.fail(Some(crate::v4_agent::browser::CleanupPhase::Profile));
        let response = router
            .clone()
            .oneshot(request(
                "DELETE",
                &format!("/api/structured/sessions/{id}"),
                "checked-owner",
                Value::Null,
            ))
            .await
            .unwrap();
        let status = response.status();
        let body = value(response).await;
        let retained = state
            .structured_session_manager()
            .get_session("checked-owner", &id)
            .await
            .unwrap();
        let profile_retained = profile.exists();
        let intake=router.clone().oneshot(request("POST",&format!("/api/structured/sessions/{id}/input"),"checked-owner",json!({"requestId":uuid::Uuid::new_v4(),"text":"deletion cleanup remains blocked","fallbackToMessage":true}))).await.unwrap();
        probe.fail(None);
        let retry = router
            .oneshot(request(
                "DELETE",
                &format!("/api/structured/sessions/{id}"),
                "checked-owner",
                Value::Null,
            ))
            .await
            .unwrap();
        let gone = probe.owned_processes_gone().await;
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "Existing Delete error contract must not acknowledge failed cleanup: {body}"
        );
        assert!(
            retained.is_some() && profile_retained,
            "Failed Delete removed session/profile ownership"
        );
        assert_eq!(intake.status(), StatusCode::CONFLICT);
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(value(retry).await, json!({"status":"deleted"}));
        assert!(state
            .structured_session_manager()
            .get_session("checked-owner", &id)
            .await
            .unwrap()
            .is_none());
        assert!(!profile.exists() && gone);
        assert_eq!(probe.spawns(), 1);
    }

    #[tokio::test]
    async fn browser_checked_cleanup_shutdown_propagates_profile_error_and_retains_owner_for_retry()
    {
        let (_data, _workspace, state, id, probe) = setup().await;
        let profile = probe.profile();
        probe.fail(Some(crate::v4_agent::browser::CleanupPhase::Profile));
        let first = state.structured_session_manager().shutdown().await;
        let error = first.as_ref().err().cloned().unwrap_or_default();
        let snapshot = state
            .structured_session_manager()
            .get_session("checked-owner", &id)
            .await
            .unwrap();
        let retained = profile.exists();
        probe.fail(None);
        let retry = state.structured_session_manager().shutdown().await;
        let gone = probe.owned_processes_gone().await;
        assert!(
            first.is_err() && error.contains("synthetic browser profile failure"),
            "Shutdown omitted browser failure: {error}"
        );
        assert!(
            snapshot.is_some_and(|snapshot| snapshot.status.as_deref() == Some("cleanup_required"))
                && retained
        );
        assert!(retry.is_ok() && !profile.exists() && gone);
        assert_eq!(probe.spawns(), 1);
    }

    #[tokio::test]
    async fn browser_checked_cleanup_cancelled_http_stop_waiter_keeps_owned_cleanup_running() {
        let (_data, _workspace, state, id, probe) = setup().await;
        let router = app(state.clone());
        let profile = probe.profile();
        let gate = probe.hold(crate::v4_agent::browser::CleanupPhase::Profile);
        let path = format!("/api/structured/sessions/{id}/interrupt");
        let waiting = tokio::spawn(async move {
            router
                .oneshot(request("POST", &path, "checked-owner", Value::Null))
                .await
        });
        let entered = gate.wait_entered().await;
        waiting.abort();
        let _ = waiting.await;
        let pending = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state
                .structured_session_manager()
                .get_session("checked-owner", &id),
        )
        .await;
        let retained_profile = profile.exists();
        let active = gate.active();
        gate.release();
        let finished = gate.wait_finished().await;
        let retry = app(state.clone())
            .oneshot(request(
                "POST",
                &format!("/api/structured/sessions/{id}/interrupt"),
                "checked-owner",
                Value::Null,
            ))
            .await
            .unwrap();
        let gone = probe.owned_processes_gone().await;
        assert!(entered && finished && gone);
        assert!(retained_profile && active == 1);
        assert!(
            matches!(pending,Ok(Ok(Some(snapshot))) if snapshot.status.as_deref()==Some("cleanup_required")),
            "Pending Stop must remain readable without holding its state lock"
        );
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(
            value(retry).await,
            json!({"status":"cancelled","cleanupConfirmed":true})
        );
        assert!(!profile.exists());
        assert_eq!(gate.entered(), 1);
        assert_eq!(gate.peak(), 1);
        assert_eq!(probe.spawns(), 1);
    }
}

#[cfg(test)]
mod attachment_name_tests {
    #[test]
    fn attachment_names_keep_only_a_plain_file_name() {
        assert_eq!(
            [
                super::attachment_name("../../etc/passwd"),
                super::attachment_name("C:\\Users\\me\\report.pdf"),
                super::attachment_name(".env"),
                super::attachment_name(""),
                super::attachment_name("notes: draft?.md"),
            ],
            [
                "passwd",
                "report.pdf",
                "env",
                "attachment",
                "notes_ draft_.md"
            ]
        );
    }
}
