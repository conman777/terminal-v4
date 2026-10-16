use crate::{
    auth::AuthenticatedUser,
    session_search::{normalize_workspace_path, safe_history_text},
    state::AppState,
    ApiError,
};
use axum::{
    extract::{Path as RoutePath, Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const FILE_LIMIT: u64 = 8 * 1024 * 1024;
const TEXT_LIMIT: usize = 120_000;
static IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NativeMessage {
    role: String,
    text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTranscript {
    source_id: String,
    provider: String,
    workspace_path: String,
    title: String,
    messages: Vec<NativeMessage>,
    truncated: bool,
}
#[derive(Deserialize)]
struct WorkspaceQuery {
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    source_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    source_id: String,
    provider: String,
    title: String,
    message_count: usize,
    truncated: bool,
}
impl From<&NativeTranscript> for Summary {
    fn from(value: &NativeTranscript) -> Self {
        Self {
            source_id: value.source_id.clone(),
            provider: value.provider.clone(),
            title: value.title.clone(),
            message_count: value.messages.len(),
            truncated: value.truncated,
        }
    }
}
#[derive(Clone)]
struct NativeRoots {
    claude: PathBuf,
    codex: PathBuf,
    hermes: PathBuf,
}
impl NativeRoots {
    fn configured() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default();
        let root = |env: &str, fallback: &str| {
            std::env::var_os(env)
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(fallback))
        };
        Self {
            claude: root("CLAUDE_CONFIG_DIR", ".claude").join("projects"),
            codex: root("CODEX_HOME", ".codex").join("sessions"),
            hermes: root("HERMES_HOME", ".hermes").join("state.db"),
        }
    }
}
pub fn routes() -> Router<AppState> {
    routes_with_roots(NativeRoots::configured())
}
fn routes_with_roots(roots: NativeRoots) -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/native-history/sources",
            axum::routing::get(sources),
        )
        .route(
            "/api/workspace/native-history/import",
            axum::routing::post(import),
        )
        .route(
            "/api/workspace/native-history/imports",
            axum::routing::get(imports),
        )
        .route(
            "/api/workspace/native-history/imports/{id}",
            axum::routing::get(open_import),
        )
        .layer(Extension(roots))
        .layer(axum::middleware::map_response(
            crate::session_search::private_response,
        ))
}
fn workspace(path: &str) -> Result<PathBuf, ApiError> {
    if path.len() > 2048 || path.chars().any(char::is_control) || !Path::new(path).is_absolute() {
        return Err(ApiError::bad_request(
            "Select an absolute workspace directory",
        ));
    }
    let path = std::fs::canonicalize(path)
        .map_err(|_| ApiError::bad_request("Workspace directory unavailable"))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    Ok(path)
}
fn same_workspace(candidate: &str, expected: &Path) -> bool {
    std::fs::canonicalize(candidate).ok().is_some_and(|path| {
        normalize_workspace_path(&path.to_string_lossy())
            == normalize_workspace_path(&expected.to_string_lossy())
    })
}
fn source_id(provider: &str, id: &str, path: &Path) -> String {
    hex::encode(Sha256::digest(
        format!(
            "{provider}\0{id}\0{}",
            normalize_workspace_path(&path.to_string_lossy())
        )
        .as_bytes(),
    ))
}
fn visible_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    matches!(
                        item["type"].as_str(),
                        Some("text" | "input_text" | "output_text")
                    )
                })
                .filter_map(|item| item["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn retain(
    messages: &mut Vec<NativeMessage>,
    role: &str,
    text: &str,
    used: &mut usize,
    truncated: &mut bool,
) {
    let text = safe_history_text(text);
    if text.trim().is_empty() {
        return;
    }
    if messages.len() >= 200 || *used >= TEXT_LIMIT {
        *truncated = true;
        return;
    }
    let available = TEXT_LIMIT - *used;
    let clipped: String = text.chars().take(available.min(12000)).collect();
    *truncated |= clipped.len() < text.len();
    *used += clipped.chars().count();
    messages.push(NativeMessage {
        role: role.into(),
        text: clipped,
    });
}
fn parse_jsonl(provider: &str, body: &str, expected: &Path) -> Option<NativeTranscript> {
    let mut id = String::new();
    let mut matching = false;
    let mut messages = Vec::new();
    let mut used = 0;
    let mut truncated = false;
    let mut event_users: Vec<usize> = Vec::new();
    for line in body.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = record["type"].as_str().unwrap_or("");
        if provider == "claude" {
            if record["isSidechain"] == true
                || record["isMeta"] == true
                || record["isCompactSummary"] == true
            {
                continue;
            }
            if let Some(cwd) = record["cwd"].as_str() {
                if !same_workspace(cwd, expected) {
                    return None;
                }
                matching = true;
            }
            if let Some(session) = record["sessionId"].as_str() {
                if !id.is_empty() && id != session {
                    return None;
                }
                id = session.into();
            }
            if matches!(kind, "user" | "assistant") {
                retain(
                    &mut messages,
                    kind,
                    &visible_text(&record["message"]["content"]),
                    &mut used,
                    &mut truncated,
                );
            }
        } else if provider == "codex" {
            let payload = &record["payload"];
            if kind == "session_meta" {
                if let Some(cwd) = payload["cwd"].as_str() {
                    if !same_workspace(cwd, expected) {
                        return None;
                    }
                    matching = true;
                }
                if let Some(session) = payload["id"]
                    .as_str()
                    .or_else(|| payload["session_id"].as_str())
                {
                    id = session.into();
                }
            }
            if kind == "event_msg" && payload["type"] == "user_message" {
                if let Some(text) = payload["message"].as_str() {
                    let clean = safe_history_text(text);
                    let duplicate = messages
                        .iter()
                        .enumerate()
                        .rev()
                        .take_while(|(_, m)| m.role != "assistant")
                        .find(|(i, m)| {
                            m.role == "user" && m.text == clean && !event_users.contains(i)
                        })
                        .map(|(i, _)| i);
                    if let Some(index) = duplicate {
                        event_users.push(index);
                    } else {
                        let index = messages.len();
                        retain(&mut messages, "user", text, &mut used, &mut truncated);
                        event_users.push(index);
                    }
                }
            } else if kind == "response_item" && payload["type"] == "message" {
                let role = payload["role"].as_str().unwrap_or("");
                if matches!(role, "user" | "assistant") {
                    let text = visible_text(&payload["content"]);
                    let clean = safe_history_text(&text);
                    let duplicate = role == "user"
                        && messages
                            .iter()
                            .enumerate()
                            .rev()
                            .take_while(|(_, m)| m.role != "assistant")
                            .any(|(i, m)| m.text == clean && event_users.contains(&i));
                    if !duplicate {
                        retain(&mut messages, role, &text, &mut used, &mut truncated);
                    }
                }
            }
        }
    }
    if !matching || id.is_empty() || id.len() > 200 || messages.is_empty() {
        return None;
    }
    let title = messages
        .iter()
        .find(|m| m.role == "user")
        .or_else(|| messages.first())
        .unwrap()
        .text
        .lines()
        .next()
        .unwrap_or("Imported conversation")
        .chars()
        .take(100)
        .collect();
    Some(NativeTranscript {
        source_id: source_id(provider, &id, expected),
        provider: provider.into(),
        workspace_path: expected.to_string_lossy().into_owned(),
        title,
        messages,
        truncated,
    })
}
fn walk(root: &Path, depth: usize, entries: &mut usize, files: &mut Vec<PathBuf>) {
    if depth > 5 || *entries >= 2000 {
        return;
    }
    let Ok(directory) = std::fs::read_dir(root) else {
        return;
    };
    for entry in directory.flatten() {
        *entries += 1;
        if *entries > 2000 {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            walk(&entry.path(), depth + 1, entries, files);
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            files.push(entry.path());
        }
    }
}
fn scan(roots: &NativeRoots, path: &Path) -> (Vec<NativeTranscript>, Vec<String>) {
    let mut results = Vec::new();
    let mut warnings = Vec::new();
    for (provider, root) in [("claude", &roots.claude), ("codex", &roots.codex)] {
        let mut files = Vec::new();
        let mut visited = 0;
        walk(root, 0, &mut visited, &mut files);
        files.sort_by_key(|file| {
            std::cmp::Reverse(std::fs::metadata(file).and_then(|m| m.modified()).ok())
        });
        let mut total = 0;
        for file in files {
            let Ok(metadata) = std::fs::symlink_metadata(&file) else {
                continue;
            };
            if metadata.file_type().is_symlink() || metadata.len() > FILE_LIMIT {
                continue;
            }
            total += metadata.len();
            if total > 32 * 1024 * 1024 {
                warnings.push(format!(
                    "{provider}: scan byte budget reached; older conversations may be omitted"
                ));
                break;
            }
            let Ok(file) = std::fs::File::open(&file) else {
                continue;
            };
            let mut body = String::new();
            if file.take(FILE_LIMIT + 1).read_to_string(&mut body).is_err()
                || body.len() as u64 > FILE_LIMIT
            {
                continue;
            }
            if let Some(transcript) = parse_jsonl(provider, &body, path) {
                results.push(transcript);
            }
            if results.len() >= 50 {
                break;
            }
        }
        if visited >= 2000 {
            warnings.push(format!("{provider}: scan entry budget reached"));
        }
    }
    if roots.hermes.exists()
        && std::fs::metadata(&roots.hermes)
            .is_ok_and(|metadata| metadata.len() <= 256 * 1024 * 1024)
    {
        match scan_hermes(&roots.hermes, path) {
            Ok(rows) => results.extend(rows),
            Err(_) => warnings.push(
                "Hermes history is unavailable or uses an unsupported database schema".into(),
            ),
        }
    }
    let mut seen = std::collections::HashSet::new();
    results.retain(|record| seen.insert(record.source_id.clone()));
    if results.len() > 50 {
        warnings
            .push("Native history result budget reached; some conversations were omitted".into());
    }
    results.truncate(50);
    (results, warnings)
}
fn scan_hermes(database: &Path, expected: &Path) -> Result<Vec<NativeTranscript>, rusqlite::Error> {
    let db = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(std::time::Duration::from_millis(100))?;
    let mut statement=db.prepare("SELECT id, cwd FROM sessions WHERE source = 'cli' AND cwd IS NOT NULL ORDER BY started_at DESC LIMIT 500")?;
    let sessions = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut results = Vec::new();
    for (id, cwd) in sessions {
        if !same_workspace(&cwd, expected) {
            continue;
        }
        let mut query=db.prepare("SELECT role, substr(content,1,12001) FROM messages WHERE session_id = ? AND role IN ('user','assistant') AND active = 1 AND _compressed_summary = 0 ORDER BY id LIMIT 201")?;
        let mut messages = Vec::new();
        let mut used = 0;
        let mut truncated = false;
        for row in query.query_map([&id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })? {
            let (role, text) = row?;
            if let Some(text) = text {
                if text.starts_with('\0') {
                    continue;
                }
                retain(&mut messages, &role, &text, &mut used, &mut truncated);
            }
        }
        if !messages.is_empty() {
            let title = messages[0].text.chars().take(100).collect();
            results.push(NativeTranscript {
                source_id: source_id("hermes", &id, expected),
                provider: "hermes".into(),
                workspace_path: expected.to_string_lossy().into_owned(),
                title,
                messages,
                truncated,
            });
        }
        if results.len() >= 20 {
            break;
        }
    }
    Ok(results)
}
fn import_directory(data: &Path, user: &str, path: &Path) -> PathBuf {
    data.join("native-history")
        .join(hex::encode(Sha256::digest(user.as_bytes())))
        .join(hex::encode(Sha256::digest(
            normalize_workspace_path(&path.to_string_lossy()).as_bytes(),
        )))
}
fn checked_id(id: &str) -> Result<(), ApiError> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("Invalid native source ID"));
    }
    Ok(())
}
fn read_import(directory: &Path, id: &str) -> Result<NativeTranscript, ApiError> {
    checked_id(id)?;
    let file = std::fs::File::open(directory.join(format!("{id}.json")))
        .map_err(|_| ApiError::not_found("Imported conversation not found"))?;
    let mut body = Vec::new();
    file.take(800_001)
        .read_to_end(&mut body)
        .map_err(|_| ApiError::internal("Unable to read imported conversation"))?;
    if body.len() > 800_000 {
        return Err(ApiError::internal(
            "Imported conversation exceeds storage limit",
        ));
    }
    serde_json::from_slice(&body)
        .map_err(|_| ApiError::internal("Imported conversation is invalid"))
}
async fn sources(
    Extension(roots): Extension<NativeRoots>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<Value>, ApiError> {
    let path = workspace(&query.path)?;
    let (rows, warnings) = tokio::task::spawn_blocking(move || scan(&roots, &path))
        .await
        .map_err(|_| ApiError::internal("Unable to scan native history"))?;
    Ok(Json(
        serde_json::json!({"sources":rows.iter().map(Summary::from).collect::<Vec<_>>(),"warnings":warnings}),
    ))
}
async fn import(
    Extension(roots): Extension<NativeRoots>,
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
    Json(request): Json<ImportRequest>,
) -> Result<Json<NativeTranscript>, ApiError> {
    checked_id(&request.source_id)?;
    let path = workspace(&query.path)?;
    let data = state.config().data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let (rows, _) = scan(&roots, &path);
        let record = rows
            .into_iter()
            .find(|row| row.source_id == request.source_id)
            .ok_or_else(|| {
                ApiError::not_found("Native conversation is no longer available for this workspace")
            })?;
        let _guard = IMPORT_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Native import storage is unavailable"))?;
        let directory = import_directory(&data, &user.user_id, &path);
        std::fs::create_dir_all(&directory)
            .map_err(|_| ApiError::internal("Unable to store native import"))?;
        if std::fs::read_dir(&directory)
            .map_err(|_| ApiError::internal("Unable to read native imports"))?
            .take(51)
            .count()
            >= 50
            && !directory
                .join(format!("{}.json", record.source_id))
                .exists()
        {
            return Err(ApiError::bad_request(
                "Workspace is limited to 50 imported conversations",
            ));
        }
        let directory = std::fs::canonicalize(&directory)
            .map_err(|_| ApiError::internal("Unable to resolve native import storage"))?;
        let mut file = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| ApiError::internal("Unable to store native import"))?;
        serde_json::to_writer(file.as_file_mut(), &record)
            .map_err(|_| ApiError::internal("Unable to store native import"))?;
        file.persist(directory.join(format!("{}.json", record.source_id)))
            .map_err(|_| ApiError::internal("Unable to save native import"))?;
        Ok(Json(record))
    })
    .await
    .map_err(|_| ApiError::internal("Unable to import native conversation"))?
}
async fn imports(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<Vec<Summary>>, ApiError> {
    let path = workspace(&query.path)?;
    let directory = import_directory(&state.config().data_dir, &user.user_id, &path);
    let mut rows = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.take(50).flatten() {
            if let Some(id) = entry.path().file_stem().and_then(|id| id.to_str()) {
                if let Ok(record) = read_import(&directory, id) {
                    rows.push(Summary::from(&record));
                }
            }
        }
    }
    Ok(Json(rows))
}
async fn open_import(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<NativeTranscript>, ApiError> {
    let path = workspace(&query.path)?;
    Ok(Json(read_import(
        &import_directory(&state.config().data_dir, &user.user_id, &path),
        &id,
    )?))
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    #[test]
    fn visible_messages_are_unicode_safe_bounded_and_redacted() {
        let mut messages = Vec::new();
        let mut used = 0;
        let mut truncated = false;
        retain(
            &mut messages,
            "assistant",
            &"\u{524d}".repeat(12001),
            &mut used,
            &mut truncated,
        );
        retain(
            &mut messages,
            "user",
            "password=private",
            &mut used,
            &mut truncated,
        );
        assert_eq!(
            (
                messages[0].text.chars().count(),
                messages[1].text.as_str(),
                truncated
            ),
            (12000, "[redacted]", true)
        );
    }
    #[test]
    fn claude_keeps_only_visible_text_for_exact_workspace() {
        let workspace = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let body = [serde_json::json!({"type":"user","sessionId":"session-one","cwd":workspace,"message":{"content":[{"type":"text","text":"Fix build"},{"type":"tool_result","content":"secret tool output"}]}}), serde_json::json!({"type":"assistant","sessionId":"session-one","cwd":workspace,"message":{"content":[{"type":"text","text":"Done"},{"type":"thinking","thinking":"private"}]}})].iter().map(ToString::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(
            parse_jsonl("claude", &body, &workspace).unwrap().messages,
            vec![
                NativeMessage {
                    role: "user".into(),
                    text: "Fix build".into()
                },
                NativeMessage {
                    role: "assistant".into(),
                    text: "Done".into()
                }
            ]
        );
        assert!(parse_jsonl("claude", &body, &workspace.join("other")).is_none());
    }
    #[test]
    fn codex_deduplicates_response_user_and_event_without_importing_tools() {
        let workspace = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let body = [serde_json::json!({"type":"session_meta","payload":{"id":"native-session","cwd":workspace}}),serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix"}]}}),serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix"}}),serde_json::json!({"type":"response_item","payload":{"type":"function_call","arguments":"never import"}}),serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed"}]}})].iter().map(ToString::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(
            parse_jsonl("codex", &body, &workspace).unwrap().messages,
            vec![
                NativeMessage {
                    role: "user".into(),
                    text: "Fix".into()
                },
                NativeMessage {
                    role: "assistant".into(),
                    text: "Fixed".into()
                }
            ]
        );
    }
}

#[cfg(test)]
mod persisted_io_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    async fn call(
        router: Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = router
            .oneshot(
                request
                    .body(if method == "POST" {
                        Body::from(body.to_string())
                    } else {
                        Body::empty()
                    })
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    fn fixtures(directory: &Path, project: &Path) -> NativeRoots {
        let roots = NativeRoots {
            claude: directory.join("claude"),
            codex: directory.join("codex"),
            hermes: directory.join("state.db"),
        };
        std::fs::create_dir_all(&roots.claude).unwrap();
        std::fs::create_dir_all(&roots.codex).unwrap();
        let transcript = serde_json::json!({"type":"user","sessionId":"native-id","cwd":project,"message":{"content":"Build fix\nOPENAI_API_KEY=sk-mustnotpersist"}});
        std::fs::write(roots.claude.join("native.jsonl"), transcript.to_string()).unwrap();
        std::fs::write(
            roots.codex.join("wrong-project.jsonl"),
            serde_json::json!({"type":"session_meta","payload":{"id":"wrong","cwd":directory}})
                .to_string(),
        )
        .unwrap();
        let db = rusqlite::Connection::open(&roots.hermes).unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT, source TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,active INTEGER,_compressed_summary INTEGER);").unwrap();
        db.execute(
            "INSERT INTO sessions VALUES('hermes-cli','cli',?,1)",
            [project.to_str().unwrap()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES('gateway','telegram',?,2)",
            [project.to_str().unwrap()],
        )
        .unwrap();
        db.execute_batch("INSERT INTO messages VALUES (1,'hermes-cli','user','Review architecture',1,0),(2,'hermes-cli','assistant','Use Rust API',1,0),(3,'hermes-cli','tool','private tool output',1,0),(4,'hermes-cli','assistant','compressed hidden summary',1,1),(5,'gateway','user','gateway private content',1,0);").unwrap();
        roots
    }
    #[test]
    fn actual_hermes_database_exports_only_active_cli_visible_messages() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let expected = std::fs::canonicalize(&project).unwrap();
        let roots = fixtures(directory.path(), &expected);
        let rows = scan_hermes(&roots.hermes, &expected).unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row.messages.clone())
                .collect::<Vec<_>>(),
            vec![vec![
                NativeMessage {
                    role: "user".into(),
                    text: "Review architecture".into()
                },
                NativeMessage {
                    role: "assistant".into(),
                    text: "Use Rust API".into()
                }
            ]]
        );
    }
    #[tokio::test]
    async fn jwt_import_is_workspace_filtered_redacted_durable_and_owner_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let project = std::fs::canonicalize(&project).unwrap();
        let roots = fixtures(directory.path(), &project);
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().join("app-data"),
            ..Default::default()
        };
        let state = AppState::new(config).unwrap();
        let token = crate::auth::issue_access_token(&state.config().jwt_secret, "owner", "owner");
        let other = crate::auth::issue_access_token(&state.config().jwt_secret, "other", "other");
        let router = routes_with_roots(roots.clone())
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state.clone());
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", project.to_str().unwrap())
            .finish();
        let uri = format!("/api/workspace/native-history/sources?{query}");
        assert_eq!(
            call(router.clone(), "GET", &uri, None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        let (status, result) = call(router.clone(), "GET", &uri, Some(&token), Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["sources"].as_array().unwrap().len(), 2);
        let source = result["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["provider"] == "claude")
            .unwrap()["sourceId"]
            .as_str()
            .unwrap();
        let (status, imported) = call(
            router.clone(),
            "POST",
            &format!("/api/workspace/native-history/import?{query}"),
            Some(&token),
            serde_json::json!({"sourceId":source}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(imported["messages"][0]["text"], "Build fix\n[redacted]");
        let open = format!("/api/workspace/native-history/imports/{source}?{query}");
        assert_eq!(
            call(router.clone(), "GET", &open, Some(&other), Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        std::fs::remove_file(roots.claude.join("native.jsonl")).unwrap();
        let fresh = AppState::new(state.config().clone()).unwrap();
        let router = routes_with_roots(roots)
            .route_layer(axum::middleware::from_fn_with_state(
                fresh.clone(),
                crate::auth::require_auth,
            ))
            .with_state(fresh);
        assert_eq!(
            call(router.clone(), "GET", &open, Some(&token), Value::Null).await,
            (StatusCode::OK, imported)
        );
        let invalid = format!("/api/workspace/native-history/imports/not-a-source?{query}");
        assert_eq!(
            call(router, "GET", &invalid, Some(&token), Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
}
