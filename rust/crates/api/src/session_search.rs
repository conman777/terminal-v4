use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    q: Option<String>,
    path: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub workspace_path: String,
    pub updated_at: String,
    pub snippet: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace/history", axum::routing::get(search))
        .layer(axum::middleware::map_response(private_response))
}

fn validate_query(query: &SearchQuery) -> Result<(), ApiError> {
    if query
        .q
        .as_ref()
        .is_some_and(|q| q.chars().count() > 256 || q.chars().any(char::is_control))
        || query
            .path
            .as_ref()
            .is_some_and(|path| path.len() > 2048 || !std::path::Path::new(path).is_absolute())
        || query.limit.is_some_and(|limit| limit == 0 || limit > 50)
    {
        return Err(ApiError::bad_request(
            "Search accepts up to 256 characters, an absolute workspace path, and 1–50 results",
        ));
    }
    Ok(())
}

pub(crate) fn safe_history_text(text: &str) -> String {
    use regex_lite::Regex;
    use std::sync::OnceLock;
    static TERMINAL: OnceLock<Regex> = OnceLock::new();
    static SECRET_LINE: OnceLock<Regex> = OnceLock::new();
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    static URL_AUTH: OnceLock<Regex> = OnceLock::new();
    let terminal = TERMINAL.get_or_init(|| {
        Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))").unwrap()
    });
    let secret = SECRET_LINE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:[a-z0-9_]*(?:api_key|token|secret|password)|authorization)\s*[:=]")
            .unwrap()
    });
    let token = TOKEN.get_or_init(|| Regex::new(r"\b(?:sk-[a-zA-Z0-9_-]+|gh[pousr]_[a-zA-Z0-9_]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)").unwrap());
    let url_auth = URL_AUTH.get_or_init(|| Regex::new(r"https?://[^/\s:@]+:[^/\s@]+@").unwrap());
    let clean = terminal.replace_all(text, "");
    clean
        .lines()
        .map(|line| {
            if secret.is_match(line) {
                "[redacted]".to_string()
            } else {
                let value = token.replace_all(line, "[redacted]");
                url_auth
                    .replace_all(&value, "[redacted]@")
                    .chars()
                    .filter(|c| !c.is_control() || *c == '\t')
                    .collect()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn snippet(text: &str, query: &str) -> Option<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_lowercase();
    let needle = query.trim().to_lowercase();
    let byte_index = if needle.is_empty() {
        0
    } else {
        lower.find(&needle)?
    };
    let match_chars = lower[..byte_index].chars().count();
    let characters: Vec<char> = normalized.chars().collect();
    let start = match_chars
        .saturating_sub(72)
        .min(characters.len().saturating_sub(240));
    let end = (start + 240).min(characters.len());
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        characters[start..end].iter().collect::<String>(),
        if end < characters.len() { "…" } else { "" }
    ))
}

async fn search(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SessionSearchResult>>, ApiError> {
    validate_query(&query)?;
    let search_text = query.q.as_deref().unwrap_or("").trim();
    let filter = query.path.as_deref().map(normalize_workspace_path);
    let state_for_io = state.clone();
    let owner = user.clone();
    let terminals =
        tokio::task::spawn_blocking(move || state_for_io.list_terminal_sessions(&owner))
            .await
            .map_err(|_| ApiError::internal("Unable to load saved conversations"))?
            .map_err(|_| ApiError::internal("Unable to load saved conversations"))?;
    let mut results = Vec::new();
    for session in terminals {
        let path = session
            .thread
            .as_ref()
            .and_then(|thread| thread.project_path.as_deref())
            .unwrap_or(&session.cwd);
        if filter
            .as_ref()
            .is_some_and(|value| *value != normalize_workspace_path(path))
        {
            continue;
        }
        let snapshot = state
            .terminal_manager()
            .get_session_history(
                &user.user_id,
                &session.id,
                &crate::state::HistoryQuery::default(),
            )
            .await
            .map_err(|_| ApiError::internal("Unable to load saved conversation"))?;
        let body = snapshot
            .map(|value| {
                value
                    .history
                    .into_iter()
                    .map(|event| event.text)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let title = safe_history_text(&session.title);
        let cleaned = safe_history_text(&body);
        if let Some(found) = snippet(&cleaned, search_text).or_else(|| snippet(&title, search_text))
        {
            results.push(SessionSearchResult {
                session_id: session.id,
                kind: "terminal".into(),
                title,
                workspace_path: path.to_string(),
                updated_at: session.updated_at,
                snippet: found,
            });
        }
    }
    for session in state
        .structured_session_manager()
        .list_sessions(&user.user_id)
        .await
        .map_err(|_| ApiError::internal("Unable to load saved conversations"))?
    {
        let path = session
            .thread
            .as_ref()
            .and_then(|thread| thread.project_path.as_deref())
            .unwrap_or(&session.cwd);
        if filter
            .as_ref()
            .is_some_and(|value| *value != normalize_workspace_path(path))
        {
            continue;
        }
        let body = session
            .events
            .iter()
            .filter_map(|event| match event {
                terminal_v4_core::StructuredSessionEvent::MessageCompleted {
                    role,
                    content,
                    ..
                } if role == "user" || role == "assistant" => Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let title = safe_history_text(&session.title);
        if let Some(found) =
            snippet(&safe_history_text(&body), search_text).or_else(|| snippet(&title, search_text))
        {
            results.push(SessionSearchResult {
                session_id: session.id,
                kind: "structured".into(),
                title,
                workspace_path: path.to_string(),
                updated_at: session.updated_at,
                snippet: found,
            });
        }
    }
    results.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    results.truncate(query.limit.unwrap_or(20));
    Ok(Json(results))
}

pub(crate) fn normalize_workspace_path(path: &str) -> String {
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn query_rejects_oversized_input_relative_paths_and_invalid_limits() {
        assert_eq!(
            [
                validate_query(&SearchQuery {
                    q: Some("a".repeat(257)),
                    ..Default::default()
                })
                .is_err(),
                validate_query(&SearchQuery {
                    path: Some("../project".into()),
                    ..Default::default()
                })
                .is_err(),
                validate_query(&SearchQuery {
                    limit: Some(0),
                    ..Default::default()
                })
                .is_err(),
                validate_query(&SearchQuery {
                    limit: Some(51),
                    ..Default::default()
                })
                .is_err(),
                validate_query(&SearchQuery::default()).is_err(),
            ],
            [true, true, true, true, false]
        );
    }

    #[test]
    fn snippets_are_case_insensitive_centered_and_unicode_safe() {
        let text = format!("{} café KERNEL fix {}", "前".repeat(300), "終".repeat(300));
        let result = snippet(&text, "kernel").unwrap();
        assert!(result.contains("KERNEL"));
        assert!(result.chars().count() <= 242);
        assert_eq!(snippet("Other content", "kernel"), None);
        assert_eq!(
            snippet("  recent\n  conversation ", ""),
            Some("recent conversation".into())
        );
    }

    #[test]
    fn secret_lines_tokens_and_terminal_controls_are_removed_before_search() {
        let text = "\u{1b}[32mFixed build\u{1b}[0m\nOPENAI_API_KEY=sk-secretkey1234567890\nAuthorization: Bearer token123\nUse sk-secretkey1234567890 safely.";
        assert_eq!(
            safe_history_text(text),
            "Fixed build\n[redacted]\n[redacted]\nUse [redacted] safely."
        );
        assert_eq!(snippet(&safe_history_text(text), "secretkey"), None);
    }
}

#[cfg(test)]
mod persisted_io_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn owned_saved_bodies_are_searchable_and_other_owners_are_excluded() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().to_string_lossy().into_owned();
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().into(),
            ..Default::default()
        };
        for (owner, id, kind, text, date, path) in [
            (
                "owner",
                "pty-1",
                "sessions",
                "compiler kernel fix",
                "2026-10-12T10:00:00Z",
                workspace.as_str(),
            ),
            (
                "owner",
                "ss-1",
                "structured",
                "KERNEL review",
                "2026-10-14T10:00:00Z",
                workspace.as_str(),
            ),
            (
                "other",
                "pty-2",
                "sessions",
                "kernel private secret",
                "2026-10-15T10:00:00Z",
                workspace.as_str(),
            ),
            (
                "owner",
                "pty-3",
                "sessions",
                "kernel different workspace",
                "2026-10-16T10:00:00Z",
                "/elsewhere",
            ),
        ] {
            let dir = directory.path().join("users").join(owner).join(kind);
            std::fs::create_dir_all(&dir).unwrap();
            let mut record = serde_json::json!({
                "id": id, "title": id, "cwd": path, "createdAt": date, "updatedAt": date,
                "shell": "pwsh", "history": [{"text": text, "ts": 1, "seq": 1}],
                "provider": "claude", "events": [{"type": "message_completed", "role": "assistant", "content": text, "ts": 1, "seq": 1}]
            });
            if kind == "structured" {
                record["events"].as_array_mut().unwrap().push(serde_json::json!({
                    "type": "raw_provider_event", "provider": "claude", "data": {"credentials": "rawsecret"}, "ts": 2, "seq": 2
                }));
            }
            std::fs::write(dir.join(format!("{id}.json")), record.to_string()).unwrap();
        }
        let state = AppState::new(config).unwrap();
        let router = routes()
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            }))
            .with_state(state);
        let uri = format!(
            "/api/workspace/history?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("q", "kernel")
                .append_pair("path", &workspace)
                .append_pair("limit", "2")
                .finish()
        );
        let response = router
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 100_000)
            .await
            .unwrap();
        let records: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            records
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["sessionId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["ss-1", "pty-1"]
        );
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/workspace/history?q=rawsecret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100_000)
                .await
                .unwrap()
                .as_ref(),
            b"[]"
        );
    }
}

pub(crate) async fn private_response(
    mut response: axum::response::Response,
) -> axum::response::Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}
