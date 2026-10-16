use crate::{
    auth::AuthenticatedUser,
    session_search::safe_history_text,
    state::{AppState, HistoryQuery},
    terminal::TerminalSubscriptionEvent,
    ApiError,
};
use axum::{
    extract::{Path as RoutePath, Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use terminal_v4_core::{StructuredSessionEvent, TerminalStreamEvent};
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

const MAX_EVENTS: usize = 10_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 128 * 1024;
const MAX_RECORDINGS: usize = 32;
const MAX_ACTIVE: usize = 8;
const FORMAT: &str = "terminal-v4-session-recording";
static STORE: Mutex<()> = Mutex::new(());
type Jobs = HashMap<PathBuf, Active>;
static ACTIVE: OnceLock<Mutex<Jobs>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayEvent {
    source_seq: i64,
    ts: i64,
    kind: String,
    text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recording {
    format: String,
    version: u8,
    id: Uuid,
    session_id: String,
    kind: String,
    workspace_path: String,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
    receipt: Option<String>,
    events: Vec<ReplayEvent>,
}
#[derive(Clone)]
struct Active {
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    data_dir: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartInput {
    session_id: String,
    kind: String,
    workspace_path: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    workspace_path: Option<String>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/recordings", axum::routing::get(list).post(start))
        .route(
            "/api/recordings/{id}",
            axum::routing::get(get).delete(delete),
        )
        .route("/api/recordings/{id}/stop", axum::routing::post(stop))
        .route("/api/recordings/{id}/export", axum::routing::get(export))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    "cache-control",
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}
fn jobs() -> &'static Mutex<Jobs> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .div_euclid(1_000_000) as i64
}
fn directory(root: &Path, owner: &str) -> PathBuf {
    root.join("session-recordings")
        .join(hex::encode(Sha256::digest(owner.as_bytes())))
}
fn record_path(root: &Path, owner: &str, id: Uuid) -> PathBuf {
    directory(root, owner).join(format!("{id}.json"))
}
fn canonical(path: &str) -> Result<PathBuf, ApiError> {
    let path = Path::new(path);
    if !path.is_absolute() || path.as_os_str().len() > 4096 {
        return Err(ApiError::bad_request(
            "An absolute workspace path is required",
        ));
    }
    let result = path
        .canonicalize()
        .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
    if !result.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    Ok(result)
}
fn save(path: &Path, record: &Recording) -> Result<(), String> {
    let _guard = STORE.lock().map_err(|_| "Recording store unavailable")?;
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES + 64 * 1024 {
        return Err("Recording storage limit reached".into());
    }
    std::fs::create_dir_all(path.parent().ok_or("Invalid recording path")?)
        .map_err(|e| e.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut temporary, &bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
fn read(path: &Path) -> Result<Recording, ApiError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| ApiError::not_found("Recording not found"))?;
    if file
        .metadata()
        .map_err(|error| ApiError::internal(error.to_string()))?
        .len()
        > (MAX_BYTES + 64 * 1024) as u64
    {
        return Err(ApiError::internal("Recording exceeds its storage limit"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 64 * 1024 + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut record: Recording =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::internal("Invalid recording file"))?;
    if record.format != FORMAT
        || record.version != 1
        || record.events.len() > MAX_EVENTS
        || record.events.iter().any(|event| {
            event.text.len() > MAX_EVENT_BYTES
                || !["terminal", "agent"].contains(&event.kind.as_str())
        })
        || record
            .events
            .windows(2)
            .any(|pair| pair[0].source_seq >= pair[1].source_seq)
    {
        return Err(ApiError::internal(
            "Unsupported or invalid recording format",
        ));
    }
    let active = jobs()
        .lock()
        .map_err(|_| ApiError::internal("Recording manager unavailable"))?
        .contains_key(path);
    if record.status == "recording" && !active {
        record.status = "interrupted".into();
        record.ended_at = Some(now());
        record.receipt = Some(
            "Server stopped before capture completed; the last persisted output is available."
                .into(),
        );
        save(path, &record).map_err(|error| ApiError::internal(error.to_string()))?;
    }
    Ok(record)
}
fn summary(record: &Recording) -> Value {
    json!({"id":record.id,"sessionId":record.session_id,"kind":record.kind,"workspacePath":record.workspace_path,
        "startedAt":record.started_at,"endedAt":record.ended_at,"status":record.status,"receipt":record.receipt,
        "eventCount":record.events.len(),"firstTs":record.events.first().map(|e|e.ts),"lastTs":record.events.last().map(|e|e.ts)})
}
fn append_event(
    events: &mut Vec<ReplayEvent>,
    last_seq: &mut i64,
    event: ReplayEvent,
) -> Result<(), String> {
    if event.source_seq <= *last_seq {
        return Ok(());
    }
    if *last_seq > 0 && event.source_seq != *last_seq + 1 {
        return Err("Output sequence gap; recording stopped to avoid a misleading replay".into());
    }
    if event.text.len() > MAX_EVENT_BYTES
        || events.len() >= MAX_EVENTS
        || events.iter().map(|e| e.text.len() * 6 + 128).sum::<usize>() + event.text.len() * 6 + 128
            > MAX_BYTES - 64 * 1024
    {
        return Err("Recording size or event limit reached".into());
    }
    *last_seq = event.source_seq;
    events.push(event);
    Ok(())
}
fn terminal_event(event: TerminalStreamEvent) -> Result<ReplayEvent, String> {
    Ok(ReplayEvent {
        source_seq: event.seq.ok_or("Output is missing a sequence number")?,
        ts: event.ts,
        kind: "terminal".into(),
        text: event.text,
    })
}
fn structured_event(event: &StructuredSessionEvent) -> Result<ReplayEvent, String> {
    let value = serde_json::to_value(event).map_err(|e| e.to_string())?;
    let kind = value["type"].as_str().unwrap_or("");
    let text = if value["role"] == "user" || kind == "raw_provider_event" || kind == "tool_started"
    {
        String::new()
    } else if ["message_delta", "tool_output", "tool_completed", "error"].contains(&kind) {
        ["content", "output", "result", "message"]
            .iter()
            .find_map(|key| value[*key].as_str())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    Ok(ReplayEvent {
        source_seq: value["seq"]
            .as_i64()
            .ok_or("Agent output is missing a sequence number")?,
        ts: value["ts"].as_i64().unwrap_or_else(now),
        kind: "agent".into(),
        text,
    })
}
enum Source {
    Terminal(broadcast::Receiver<TerminalSubscriptionEvent>),
    Structured(broadcast::Receiver<StructuredSessionEvent>),
}
impl Source {
    fn try_next(&mut self) -> Result<Option<ReplayEvent>, String> {
        match self {
            Self::Terminal(receiver) => match receiver.try_recv() {
                Ok(TerminalSubscriptionEvent::Output(event)) => terminal_event(event).map(Some),
                Ok(TerminalSubscriptionEvent::Closed)
                | Err(broadcast::error::TryRecvError::Empty)
                | Err(broadcast::error::TryRecvError::Closed) => Ok(None),
                Err(broadcast::error::TryRecvError::Lagged(_)) => Err(
                    "Capture fell behind live output; recording stopped with a sequence gap".into(),
                ),
            },
            Self::Structured(receiver) => match receiver.try_recv() {
                Ok(StructuredSessionEvent::SessionEnded { .. })
                | Err(broadcast::error::TryRecvError::Empty)
                | Err(broadcast::error::TryRecvError::Closed) => Ok(None),
                Ok(event) => structured_event(&event).map(Some),
                Err(broadcast::error::TryRecvError::Lagged(_)) => Err(
                    "Capture fell behind agent events; recording stopped with a sequence gap"
                        .into(),
                ),
            },
        }
    }
    async fn next(&mut self) -> Result<Option<ReplayEvent>, String> {
        match self {
            Self::Terminal(receiver) => match receiver.recv().await {
                Ok(TerminalSubscriptionEvent::Output(event)) => terminal_event(event).map(Some),
                Ok(TerminalSubscriptionEvent::Closed)
                | Err(broadcast::error::RecvError::Closed) => Ok(None),
                Err(broadcast::error::RecvError::Lagged(_)) => Err(
                    "Capture fell behind live output; recording stopped with a sequence gap".into(),
                ),
            },
            Self::Structured(receiver) => match receiver.recv().await {
                Ok(StructuredSessionEvent::SessionEnded { .. }) => Ok(None),
                Ok(event) => structured_event(&event).map(Some),
                Err(broadcast::error::RecvError::Closed) => Ok(None),
                Err(broadcast::error::RecvError::Lagged(_)) => Err(
                    "Capture fell behind agent events; recording stopped with a sequence gap"
                        .into(),
                ),
            },
        }
    }
}
async fn start(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<StartInput>,
) -> Result<Json<Value>, ApiError> {
    if input.session_id.is_empty()
        || input.session_id.len() > 160
        || !["terminal", "structured"].contains(&input.kind.as_str())
    {
        return Err(ApiError::bad_request(
            "Choose a terminal or structured session",
        ));
    }
    let workspace = canonical(&input.workspace_path)?;
    let (source, initial) = if input.kind == "terminal" {
        let manager = state.terminal_manager();
        let receiver = manager
            .subscribe(&user.user_id, &input.session_id)
            .await
            .map_err(|_| ApiError::not_found("Active session not found"))?;
        let summary = manager
            .list_sessions(&user.user_id)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .into_iter()
            .find(|session| session.id == input.session_id && session.is_active)
            .ok_or_else(|| ApiError::not_found("Active session not found"))?;
        if canonical(&summary.cwd)? != workspace {
            return Err(ApiError::bad_request(
                "Session belongs to another workspace",
            ));
        }
        let history = manager
            .get_session_history(&user.user_id, &input.session_id, &HistoryQuery::default())
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("Session not found"))?;
        (
            Source::Terminal(receiver),
            history
                .history
                .into_iter()
                .map(terminal_event)
                .collect::<Result<Vec<_>, _>>()
                .map_err(ApiError::bad_request)?,
        )
    } else {
        let manager = state.structured_session_manager();
        let (_, receiver) = manager
            .subscribe(&user.user_id, &input.session_id)
            .await
            .map_err(|_| ApiError::not_found("Agent session not found"))?;
        let snapshot = manager
            .get_session(&user.user_id, &input.session_id)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::not_found("Agent session not found"))?;
        if canonical(&snapshot.cwd)? != workspace {
            return Err(ApiError::bad_request(
                "Session belongs to another workspace",
            ));
        }
        (
            Source::Structured(receiver),
            snapshot
                .events
                .iter()
                .map(structured_event)
                .collect::<Result<Vec<_>, _>>()
                .map_err(ApiError::bad_request)?,
        )
    };
    let mut record = Recording {
        format: FORMAT.into(),
        version: 1,
        id: Uuid::new_v4(),
        session_id: input.session_id,
        kind: input.kind,
        workspace_path: workspace.to_string_lossy().into_owned(),
        started_at: now(),
        ended_at: None,
        status: "recording".into(),
        receipt: None,
        events: Vec::new(),
    };
    let mut last_seq = 0;
    for event in initial {
        append_event(&mut record.events, &mut last_seq, event).map_err(ApiError::bad_request)?;
    }
    let path = record_path(&state.config().data_dir, &user.user_id, record.id);
    let (stop_tx, stop_rx) = watch::channel(false);
    let (done_tx, done_rx) = watch::channel(false);
    {
        let mut active = jobs()
            .lock()
            .map_err(|_| ApiError::internal("Recording manager unavailable"))?;
        if active.len() >= MAX_ACTIVE {
            return Err(ApiError::bad_request(
                "At most eight simultaneous recordings are supported",
            ));
        }
        let dir = directory(&state.config().data_dir, &user.user_id);
        let count = std::fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
                    .count()
            })
            .unwrap_or(0);
        if count >= MAX_RECORDINGS {
            return Err(ApiError::bad_request(
                "Delete an older recording first; at most 32 recordings per account",
            ));
        }
        for active_path in active.keys().filter(|p| p.parent() == Some(dir.as_path())) {
            if let Ok(bytes) = std::fs::read(active_path) {
                if let Ok(existing) = serde_json::from_slice::<Recording>(&bytes) {
                    if existing.session_id == record.session_id && existing.kind == record.kind {
                        return Err(ApiError::bad_request(
                            "This session is already being recorded",
                        ));
                    }
                }
            }
        }
        save(&path, &record).map_err(|error| ApiError::internal(error.to_string()))?;
        active.insert(
            path.clone(),
            Active {
                stop: stop_tx,
                done: done_rx,
                data_dir: state.config().data_dir.clone(),
            },
        );
    }
    let result = summary(&record);
    tokio::spawn(capture(path, record, source, last_seq, stop_rx, done_tx));
    Ok(Json(result))
}
async fn persist(path: &Path, record: &Recording) -> Result<(), String> {
    let path = path.to_owned();
    let record = record.clone();
    tokio::task::spawn_blocking(move || save(&path, &record))
        .await
        .map_err(|e| e.to_string())?
}
async fn capture(
    path: PathBuf,
    mut record: Recording,
    mut source: Source,
    mut last_seq: i64,
    mut stop: watch::Receiver<bool>,
    done: watch::Sender<bool>,
) {
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(250));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut dirty = false;
    let (status, receipt) = 'capture: loop {
        tokio::select! {
            biased;
            changed = stop.changed() => {
                let _ = changed;
                loop {
                    match source.try_next() {
                        Ok(Some(event)) => if let Err(error) = append_event(&mut record.events, &mut last_seq, event) { break 'capture ("incomplete", error); },
                        Ok(None) => break,
                        Err(error) => break 'capture ("incomplete", error),
                    }
                }
                break ("stopped", "Recording stopped by its owner or server shutdown".to_string());
            }
            _ = timer.tick(), if dirty => {
                if let Err(error) = persist(&path, &record).await { break ("failed", format!("Recording storage failed: {error}")); }
                dirty = false;
            }
            event = source.next() => match event {
                Ok(Some(event)) => {
                    if let Err(error) = append_event(&mut record.events, &mut last_seq, event) { break ("incomplete", error); }
                    dirty = true;
                }
                Ok(None) => break ("ended", "Session ended".to_string()),
                Err(error) => break ("incomplete", error),
            }
        }
    };
    record.status = status.into();
    record.receipt = Some(receipt);
    record.ended_at = Some(now());
    if let Err(error) = persist(&path, &record).await {
        tracing::error!("Could not finalize session recording: {error}");
    }
    if let Ok(mut active) = jobs().lock() {
        active.remove(&path);
    }
    let _ = done.send(true);
}
async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let workspace = query.workspace_path.as_deref().map(canonical).transpose()?;
    let dir = directory(&state.config().data_dir, &user.user_id);
    let mut records = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.take(MAX_RECORDINGS + 1) {
            let path = entry
                .map_err(|error| ApiError::internal(error.to_string()))?
                .path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let record = read(&path)?;
            if workspace
                .as_ref()
                .is_none_or(|path| Path::new(&record.workspace_path) == path)
            {
                records.push(summary(&record));
            }
        }
    }
    records.sort_by(|a, b| b["startedAt"].as_i64().cmp(&a["startedAt"].as_i64()));
    Ok(Json(json!({"recordings":records})))
}
async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
) -> Result<Json<Recording>, ApiError> {
    Ok(Json(read(&record_path(
        &state.config().data_dir,
        &user.user_id,
        id,
    ))?))
}
async fn stop_job(path: &Path) {
    let active = jobs().lock().ok().and_then(|jobs| jobs.get(path).cloned());
    if let Some(mut active) = active {
        let _ = active.stop.send(true);
        if !*active.done.borrow() {
            let _ = active.done.changed().await;
        }
    }
}
async fn stop(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let path = record_path(&state.config().data_dir, &user.user_id, id);
    read(&path)?;
    stop_job(&path).await;
    Ok(Json(summary(&read(&path)?)))
}
async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let path = record_path(&state.config().data_dir, &user.user_id, id);
    read(&path)?;
    stop_job(&path).await;
    std::fs::remove_file(path).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({"deleted":true})))
}
async fn export(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<Uuid>,
) -> Result<Json<Recording>, ApiError> {
    let mut record = read(&record_path(&state.config().data_dir, &user.user_id, id))?;
    for event in &mut record.events {
        let newline = event.text.ends_with('\n');
        event.text = safe_history_text(&event.text);
        if newline {
            event.text.push('\n');
        }
    }
    Ok(Json(record))
}
pub(crate) async fn shutdown(data_dir: &Path) {
    let paths = jobs()
        .lock()
        .map(|active| {
            active
                .iter()
                .filter(|(_, job)| job.data_dir == data_dir)
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for path in paths {
        stop_job(&path).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_sequences_dedupe_snapshot_overlap_and_expose_gaps() {
        let mut events = Vec::new();
        let mut last = 0;
        let event = ReplayEvent {
            source_seq: 3,
            ts: 100,
            kind: "terminal".into(),
            text: "hello".into(),
        };
        append_event(&mut events, &mut last, event.clone()).unwrap();
        append_event(&mut events, &mut last, event).unwrap();
        assert_eq!((events.len(), last), (1, 3));
        assert!(append_event(
            &mut events,
            &mut last,
            ReplayEvent {
                source_seq: 5,
                ts: 110,
                kind: "terminal".into(),
                text: "gap".into()
            }
        )
        .is_err());
    }
    #[test]
    fn bounded_events_and_structured_inputs_are_not_stored() {
        let mut events = Vec::new();
        let mut seq = 0;
        assert!(append_event(
            &mut events,
            &mut seq,
            ReplayEvent {
                source_seq: 1,
                ts: 1,
                kind: "terminal".into(),
                text: "x".repeat(MAX_EVENT_BYTES + 1)
            }
        )
        .is_err());
        let event = StructuredSessionEvent::MessageCompleted {
            ts: 1,
            seq: 1,
            role: "user".into(),
            content: "secret typed by user".into(),
        };
        assert_eq!(structured_event(&event).unwrap().text, "");
    }
    #[test]
    fn interrupted_receipts_persist_and_owners_have_separate_stores() {
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let path = record_path(root.path(), "owner", id);
        let record = Recording {
            format: FORMAT.into(),
            version: 1,
            id,
            session_id: "s".into(),
            kind: "terminal".into(),
            workspace_path: root.path().to_string_lossy().into_owned(),
            started_at: 1,
            ended_at: None,
            status: "recording".into(),
            receipt: None,
            events: vec![],
        };
        save(&path, &record).unwrap();
        let loaded = read(&path).unwrap();
        assert_eq!(
            (loaded.status.as_str(), read(&path).unwrap().status.as_str()),
            ("interrupted", "interrupted")
        );
        assert!(read(&record_path(root.path(), "other", id)).is_err());
    }
    async fn http(
        state: &AppState,
        owner: &str,
        method: &str,
        uri: &str,
        body: Value,
    ) -> (axum::http::StatusCode, Value) {
        use tower::ServiceExt;
        let router = routes()
            .layer(Extension(AuthenticatedUser {
                user_id: owner.into(),
                username: owner.into(),
            }))
            .with_state(state.clone());
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), MAX_BYTES + 100_000)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[tokio::test]
    async fn real_pty_output_records_stops_and_survives_reload_without_cross_owner_access() {
        let root = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: root.path().join("app"),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let manager = state.terminal_manager();
        let session = manager
            .create_session(
                "owner",
                crate::terminal::TerminalCreateOptions {
                    cwd: Some(root.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let (status, started) = http(
            &state,
            "owner",
            "POST",
            "/api/recordings",
            json!({"sessionId":session.id,"kind":"terminal","workspacePath":root.path()}),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{started}");
        let id = started["id"].as_str().unwrap();
        manager
            .write("owner", &session.id, "echo RECORDING_OUTPUT_MARKER\n")
            .await
            .unwrap();
        let output = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let (_, body) = http(
                    &state,
                    "owner",
                    "GET",
                    &format!("/api/recordings/{id}"),
                    Value::Null,
                )
                .await;
                if body["events"].as_array().is_some_and(|events| {
                    events.iter().any(|event| {
                        event["text"]
                            .as_str()
                            .is_some_and(|text| text.contains("RECORDING_OUTPUT_MARKER"))
                    })
                }) {
                    break body;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await;
        let stopped = http(
            &state,
            "owner",
            "POST",
            &format!("/api/recordings/{id}/stop"),
            Value::Null,
        )
        .await;
        manager.close("owner", &session.id).await.unwrap();
        assert!(output.is_ok(), "PTY output was not recorded");
        assert_eq!(stopped.1["status"], "stopped");
        let (_, exported) = http(
            &state,
            "owner",
            "GET",
            &format!("/api/recordings/{id}/export"),
            Value::Null,
        )
        .await;
        assert_eq!(exported["format"], FORMAT);
        let isolated = http(
            &state,
            "other",
            "GET",
            &format!("/api/recordings/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(isolated.0, axum::http::StatusCode::NOT_FOUND);
        let reloaded = AppState::new(config).unwrap();
        let (_, saved) = http(
            &reloaded,
            "owner",
            "GET",
            &format!("/api/recordings/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(
            (
                saved["status"].as_str(),
                saved["events"].as_array().unwrap().len()
            ),
            (
                Some("stopped"),
                exported["events"].as_array().unwrap().len()
            )
        );
        assert_eq!(
            http(
                &reloaded,
                "owner",
                "DELETE",
                &format!("/api/recordings/{id}"),
                Value::Null
            )
            .await
            .1,
            json!({"deleted":true})
        );
        assert_eq!(
            http(
                &reloaded,
                "owner",
                "GET",
                &format!("/api/recordings/{id}"),
                Value::Null
            )
            .await
            .0,
            axum::http::StatusCode::NOT_FOUND
        );
    }
    #[tokio::test]
    async fn structured_fixture_omits_user_and_provider_envelopes_and_export_redacts_credentials() {
        let root = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: root.path().join("app"),
            ..Default::default()
        };
        let folder = config
            .data_dir
            .join("users")
            .join("owner")
            .join("structured");
        std::fs::create_dir_all(&folder).unwrap();
        let snapshot = json!({"id":"ss-fixture","title":"Fixture","cwd":root.path(),"provider":"claude",
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",
            "events":[{"type":"message_completed","role":"user","content":"private typed prompt","ts":1,"seq":1},
                {"type":"message_delta","role":"assistant","content":"Build complete\nAPI_KEY=secret-example\n","ts":2,"seq":2},
                {"type":"tool_completed","toolName":"compile","result":"compile ok","isError":false,"ts":3,"seq":3},
                {"type":"raw_provider_event","provider":"claude","data":{"token":"raw-private-value"},"ts":4,"seq":4}]});
        std::fs::write(folder.join("ss-fixture.json"), snapshot.to_string()).unwrap();
        let state = AppState::new(config).unwrap();
        let (status, started) = http(
            &state,
            "owner",
            "POST",
            "/api/recordings",
            json!({"sessionId":"ss-fixture","kind":"structured","workspacePath":root.path()}),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{started}");
        let id = started["id"].as_str().unwrap();
        let _ = http(
            &state,
            "owner",
            "POST",
            &format!("/api/recordings/{id}/stop"),
            Value::Null,
        )
        .await;
        let (_, exported) = http(
            &state,
            "owner",
            "GET",
            &format!("/api/recordings/{id}/export"),
            Value::Null,
        )
        .await;
        let body = exported.to_string();
        assert!(
            body.contains("Build complete")
                && body.contains("compile ok")
                && body.contains("[redacted]")
        );
        assert!(
            !body.contains("secret-example")
                && !body.contains("private typed prompt")
                && !body.contains("raw-private-value")
        );
        assert_eq!(exported["events"].as_array().unwrap().len(), 4);
    }
    #[tokio::test]
    async fn backpressure_is_an_explicit_incomplete_receipt() {
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let path = record_path(root.path(), "owner", id);
        let record = Recording {
            format: FORMAT.into(),
            version: 1,
            id,
            session_id: "ss".into(),
            kind: "structured".into(),
            workspace_path: root.path().to_string_lossy().into_owned(),
            started_at: 1,
            ended_at: None,
            status: "recording".into(),
            receipt: None,
            events: vec![],
        };
        let (sender, receiver) = broadcast::channel(1);
        for seq in 1..=3 {
            sender
                .send(StructuredSessionEvent::MessageDelta {
                    ts: seq,
                    seq,
                    role: "assistant".into(),
                    content: "output".into(),
                })
                .unwrap();
        }
        let (_stop, stop) = watch::channel(false);
        let (done, _) = watch::channel(false);
        capture(
            path.clone(),
            record,
            Source::Structured(receiver),
            0,
            stop,
            done,
        )
        .await;
        let saved = read(&path).unwrap();
        assert_eq!(saved.status, "incomplete");
        assert!(saved.receipt.unwrap().contains("sequence gap"));
    }
}
