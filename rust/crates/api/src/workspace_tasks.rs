use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Path, Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use uuid::Uuid;

const TASK_LIMIT: usize = 200;
const SCHEDULE_LIMIT: usize = 20;
const OUTPUT_LIMIT: usize = 65_536;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub workspace_path: String,
    pub provider: String,
    pub prompt: String,
    pub model: Option<String>,
    pub parent_session_id: Option<String>,
    pub parent_task_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleInput {
    #[serde(flatten)]
    task: TaskInput,
    name: String,
    interval_seconds: u64,
    #[serde(default)]
    enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl TaskStatus {
    fn terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub at: u64,
    pub status: TaskStatus,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: Uuid,
    #[serde(flatten)]
    pub input: TaskInput,
    pub schedule_id: Option<Uuid>,
    pub status: TaskStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub output: String,
    #[serde(default)]
    pub result: String,
    pub output_truncated: bool,
    pub error: Option<String>,
    pub events: Vec<TaskEvent>,
    #[serde(default)]
    pub before_checkpoint_id: Option<Uuid>,
    #[serde(default)]
    pub after_checkpoint_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub id: Uuid,
    pub name: String,
    #[serde(flatten)]
    pub input: TaskInput,
    pub interval_seconds: u64,
    pub enabled: bool,
    pub next_run_at: Option<u64>,
    pub last_run_at: Option<u64>,
    pub last_task_id: Option<Uuid>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStore {
    owner_id: String,
    tasks: Vec<TaskRecord>,
    schedules: Vec<ScheduleRecord>,
}

fn store_path(data_dir: &FsPath, user_id: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    data_dir.join("workspace-tasks").join(format!(
        "{}.json",
        hex::encode(Sha256::digest(user_id.as_bytes()))
    ))
}

type CompletionKey = (PathBuf, String, Uuid);
static PENDING_COMPLETIONS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<CompletionKey, TaskRecord>>,
> = std::sync::OnceLock::new();

fn receipt_path(data_dir: &FsPath, owner: &str, id: Uuid) -> PathBuf {
    data_dir
        .join("workspace-tasks")
        .join("completions")
        .join(format!(
            "{}-{id}.json",
            store_path(data_dir, owner)
                .file_stem()
                .unwrap()
                .to_string_lossy()
        ))
}

fn merge_completion(existing: &mut TaskRecord, mut finished: TaskRecord) {
    finished.before_checkpoint_id = finished
        .before_checkpoint_id
        .or(existing.before_checkpoint_id);
    finished.after_checkpoint_id = finished
        .after_checkpoint_id
        .or(existing.after_checkpoint_id);
    let final_event = finished.events.last().cloned();
    finished.events = existing.events.clone();
    if let Some(event) = final_event {
        if finished.events.len() >= 80 {
            finished.events.remove(0);
        }
        finished.events.push(event);
    }
    if existing.status == TaskStatus::Cancelling && finished.status == TaskStatus::Completed {
        transition(
            &mut finished,
            TaskStatus::Cancelled,
            "Task cancelled",
            now_ms(),
        );
    }
    *existing = finished;
}

fn completion_records(data_dir: &FsPath, owner: &str) -> Vec<TaskRecord> {
    let mut records = Vec::new();
    let directory = data_dir.join("workspace-tasks").join("completions");
    let prefix = format!(
        "{}-",
        store_path(data_dir, owner)
            .file_stem()
            .unwrap()
            .to_string_lossy()
    );
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .take(TASK_LIMIT)
        {
            if !entry.file_type().is_ok_and(|kind| kind.is_file())
                || !entry.metadata().is_ok_and(|meta| meta.len() <= 512 * 1024)
            {
                continue;
            }
            if let Ok(bytes) = std::fs::read(entry.path()) {
                if let Ok(record) = serde_json::from_slice::<TaskRecord>(&bytes) {
                    if record.status.terminal()
                        && receipt_path(data_dir, owner, record.id) == entry.path()
                    {
                        records.push(record);
                    }
                }
            }
        }
    }
    if let Some(pending) = PENDING_COMPLETIONS.get() {
        if let Ok(pending) = pending.lock() {
            records.extend(
                pending
                    .iter()
                    .filter(|((directory, user, _), _)| directory == data_dir && user == owner)
                    .map(|(_, record)| record.clone()),
            );
        }
    }
    records
}

fn retain_completion(data_dir: &FsPath, owner: &str, record: TaskRecord) {
    use std::io::Write;
    if let Ok(mut pending) = PENDING_COMPLETIONS.get_or_init(Default::default).lock() {
        pending.insert((data_dir.into(), owner.into(), record.id), record.clone());
    }
    let save = || -> std::io::Result<()> {
        let path = receipt_path(data_dir, owner, record.id);
        let directory = path.parent().unwrap();
        std::fs::create_dir_all(directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(&serde_json::to_vec(&record)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        Ok(())
    };
    if save().is_err() {
        tracing::error!(task_id = %record.id, "Completion receipt could not be saved; result is held in memory. Restore app data directory permissions and disk space before restarting.");
    }
}

fn read_store(data_dir: &FsPath, user_id: &str) -> Result<TaskStore, ApiError> {
    let path = store_path(data_dir, user_id);
    if !path.exists() {
        return Ok(TaskStore {
            owner_id: user_id.into(),
            ..Default::default()
        });
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|_| ApiError::internal("Saved task storage unavailable"))?;
    if metadata.len() > 32 * 1024 * 1024 {
        return Err(ApiError::internal("Saved task storage exceeds its limit"));
    }
    let bytes =
        std::fs::read(path).map_err(|_| ApiError::internal("Saved task storage unavailable"))?;
    let mut store: TaskStore = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::internal("Saved task storage is unreadable; data was preserved"))?;
    if store.owner_id != user_id
        || store.tasks.len() > TASK_LIMIT
        || store.schedules.len() > SCHEDULE_LIMIT
    {
        return Err(ApiError::internal(
            "Saved task storage owner or bounds are invalid",
        ));
    }
    for record in completion_records(data_dir, user_id) {
        if let Some(task) = store.tasks.iter_mut().find(|task| task.id == record.id) {
            merge_completion(task, record);
        }
    }
    Ok(store)
}

fn write_store(data_dir: &FsPath, store: &TaskStore) -> Result<(), ApiError> {
    use std::io::Write;
    let path = store_path(data_dir, &store.owner_id);
    let directory = path.parent().unwrap();
    std::fs::create_dir_all(directory).map_err(|_| ApiError::internal("Unable to save tasks"))?;
    let bytes =
        serde_json::to_vec(store).map_err(|_| ApiError::internal("Unable to serialize tasks"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(ApiError::bad_request(
            "Remove old task results before creating more tasks",
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| ApiError::internal("Unable to save tasks"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| ApiError::internal("Unable to save tasks"))?;
    temporary
        .persist(path)
        .map_err(|_| ApiError::internal("Unable to replace saved tasks"))?;
    for task in completion_records(data_dir, &store.owner_id)
        .iter()
        .filter(|record| {
            store
                .tasks
                .iter()
                .find(|task| task.id == record.id)
                .is_none_or(|task| task.status.terminal())
        })
    {
        let _ = std::fs::remove_file(receipt_path(data_dir, &store.owner_id, task.id));
        if let Some(pending) = PENDING_COMPLETIONS.get() {
            if let Ok(mut pending) = pending.lock() {
                pending.remove(&(data_dir.into(), store.owner_id.clone(), task.id));
            }
        }
    }
    Ok(())
}

fn validate_task(input: &TaskInput) -> Result<(), ApiError> {
    if input.workspace_path.len() > 2048
        || !FsPath::new(&input.workspace_path).is_absolute()
        || !crate::agent_runtime::supported_task_provider(&input.provider)
        || input.prompt.trim().is_empty()
        || input.prompt.chars().count() > 32_000
        || input.prompt.contains('\0')
        || input.model.as_ref().is_some_and(|model| {
            model.trim().is_empty()
                || model.chars().count() > 200
                || model.chars().any(char::is_control)
        })
        || input
            .parent_session_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 200 || id.chars().any(char::is_control))
    {
        return Err(ApiError::bad_request("Use an absolute workspace, a supported native agent, and a prompt of 1–32000 characters"));
    }
    Ok(())
}

fn enqueue(
    store: &mut TaskStore,
    input: TaskInput,
    schedule_id: Option<Uuid>,
    now: u64,
) -> Result<TaskRecord, ApiError> {
    validate_task(&input)?;
    if store.tasks.len() >= TASK_LIMIT {
        return Err(ApiError::bad_request(
            "Remove an old task before queuing another",
        ));
    }
    if input
        .parent_task_id
        .is_some_and(|id| !store.tasks.iter().any(|task| task.id == id))
    {
        return Err(ApiError::bad_request(
            "Parent task must belong to this owner",
        ));
    }
    let record = TaskRecord {
        id: Uuid::new_v4(),
        input,
        schedule_id,
        status: TaskStatus::Queued,
        created_at: now,
        updated_at: now,
        started_at: None,
        completed_at: None,
        exit_code: None,
        output: String::new(),
        result: String::new(),
        output_truncated: false,
        error: None,
        before_checkpoint_id: None,
        after_checkpoint_id: None,
        events: vec![TaskEvent {
            at: now,
            status: TaskStatus::Queued,
            message: "Task intent saved and queued".into(),
        }],
    };
    store.tasks.push(record.clone());
    Ok(record)
}

fn queue_due_schedules(store: &mut TaskStore, now: u64, can_queue: impl Fn(&TaskInput) -> bool) {
    for index in 0..store.schedules.len() {
        let schedule = &store.schedules[index];
        if !schedule.enabled
            || schedule.next_run_at.is_none_or(|next| next > now)
            || !can_queue(&schedule.input)
        {
            continue;
        }
        let id = schedule.id;
        let input = schedule.input.clone();
        let next = now.saturating_add(schedule.interval_seconds.saturating_mul(1000));
        store.schedules[index].next_run_at = Some(next);
        if store
            .tasks
            .iter()
            .any(|task| task.schedule_id == Some(id) && !task.status.terminal())
        {
            continue;
        }
        if let Ok(task) = enqueue(store, input, Some(id), now) {
            store.schedules[index].last_run_at = Some(now);
            store.schedules[index].last_task_id = Some(task.id);
        }
    }
}

fn recover_interrupted(store: &mut TaskStore, now: u64) {
    for task in &mut store.tasks {
        if matches!(task.status, TaskStatus::Running | TaskStatus::Cancelling) {
            task.error = Some("App server stopped before this task finished. Review changes before running it again.".into());
            transition(
                task,
                TaskStatus::Interrupted,
                "Task interrupted by app restart",
                now,
            );
        }
    }
}

fn cancel_record(record: &mut TaskRecord, now: u64) {
    match record.status {
        TaskStatus::Queued => {
            transition(record, TaskStatus::Cancelled, "Queued task cancelled", now)
        }
        TaskStatus::Running => transition(
            record,
            TaskStatus::Cancelling,
            "Cancellation requested",
            now,
        ),
        _ => {}
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn input() -> TaskInput {
        TaskInput {
            workspace_path: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            provider: "claude".into(),
            prompt: "Review the changes without modifying files.".into(),
            model: None,
            parent_session_id: Some("ss-parent".into()),
            parent_task_id: None,
        }
    }

    #[test]
    fn task_validation_rejects_shell_providers_empty_prompts_and_relative_paths() {
        let mut bad = input();
        bad.provider = "powershell".into();
        assert!(validate_task(&bad).is_err());
        bad = input();
        bad.prompt = " ".into();
        assert!(validate_task(&bad).is_err());
        bad = input();
        bad.workspace_path = "../escape".into();
        assert!(validate_task(&bad).is_err());
        bad = input();
        bad.prompt = "x".repeat(32_001);
        assert!(validate_task(&bad).is_err());
        assert!(validate_task(&input()).is_ok());
    }

    #[test]
    fn scheduling_coalesces_missed_intervals_and_avoids_overlapping_runs() {
        let now = 10_000_000;
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let schedule_id = Uuid::new_v4();
        store.schedules.push(ScheduleRecord {
            id: schedule_id,
            name: "Review".into(),
            input: input(),
            interval_seconds: 60,
            enabled: true,
            next_run_at: Some(1),
            last_run_at: None,
            last_task_id: None,
            created_at: 1,
        });
        queue_due_schedules(&mut store, now, |_| true);
        queue_due_schedules(&mut store, now + 60_000, |_| true);
        assert_eq!(
            (
                store.tasks.len(),
                store.tasks[0].schedule_id,
                store.schedules[0].next_run_at
            ),
            (1, Some(schedule_id), Some(now + 120_000))
        );
        store.tasks[0].status = TaskStatus::Completed;
        queue_due_schedules(&mut store, now + 120_000, |_| true);
        assert_eq!(store.tasks.len(), 2);
    }

    #[test]
    fn cancellation_and_restart_recovery_never_requeue_running_tasks() {
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let queued = enqueue(&mut store, input(), None, 1).unwrap();
        cancel_record(&mut store.tasks[0], 2);
        let running = enqueue(&mut store, input(), None, 3).unwrap();
        store.tasks[1].status = TaskStatus::Running;
        recover_interrupted(&mut store, 4);
        assert_eq!(
            store
                .tasks
                .iter()
                .map(|task| (task.id, task.status.clone(), task.completed_at))
                .collect::<Vec<_>>(),
            vec![
                (queued.id, TaskStatus::Cancelled, Some(2)),
                (running.id, TaskStatus::Interrupted, Some(4))
            ]
        );
    }

    #[test]
    fn child_tasks_require_an_owned_parent_and_queue_has_a_limit() {
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let mut child = input();
        child.parent_task_id = Some(Uuid::new_v4());
        assert!(enqueue(&mut store, child.clone(), None, 1).is_err());
        let parent = enqueue(&mut store, input(), None, 1).unwrap();
        child.parent_task_id = Some(parent.id);
        let task = enqueue(&mut store, child, None, 1).unwrap();
        assert_eq!(task.input.parent_task_id, Some(parent.id));
        for _ in store.tasks.len()..TASK_LIMIT {
            enqueue(&mut store, input(), None, 1).unwrap();
        }
        assert!(enqueue(&mut store, input(), None, 1).is_err());
    }
}

#[cfg(test)]
mod persisted_io_tests {
    use super::*;

    #[test]
    fn durable_intent_and_results_survive_restart_and_owner_keys_cannot_escape() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "../owner".into(),
            ..Default::default()
        };
        let input = TaskInput {
            workspace_path: dir.path().to_string_lossy().into_owned(),
            provider: "hermes".into(),
            prompt: "Inspect".into(),
            model: None,
            parent_session_id: Some("ss-parent".into()),
            parent_task_id: None,
        };
        let task = enqueue(&mut store, input, None, 1).unwrap();
        write_store(dir.path(), &store).unwrap();
        let loaded = read_store(dir.path(), "../owner").unwrap();
        assert_eq!(
            (
                loaded.tasks[0].id,
                loaded.tasks[0].status.clone(),
                loaded.tasks[0].input.parent_session_id.clone()
            ),
            (task.id, TaskStatus::Queued, Some("ss-parent".into()))
        );
        assert!(read_store(dir.path(), "other").unwrap().tasks.is_empty());
        assert_eq!(
            store_path(dir.path(), "../owner").parent().unwrap(),
            dir.path().join("workspace-tasks")
        );
    }

    #[test]
    fn corrupt_storage_is_preserved_and_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path(), "owner");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "corrupt intent").unwrap();
        assert!(read_store(dir.path(), "owner").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "corrupt intent");
    }
}

static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static WORKERS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, tokio::sync::watch::Sender<bool>>>,
> = std::sync::OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn not_found() -> ApiError {
    ApiError {
        status: axum::http::StatusCode::NOT_FOUND,
        message: "Task or schedule not found".into(),
    }
}

async fn edit_store<T: Send + 'static>(
    data_dir: PathBuf,
    owner: String,
    edit: impl FnOnce(&mut TaskStore) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        let mut store = read_store(&data_dir, &owner)?;
        let original = serde_json::to_vec(&store)
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        let value = edit(&mut store)?;
        if serde_json::to_vec(&store).ok().as_deref() != Some(original.as_slice()) {
            write_store(&data_dir, &store)?;
        }
        Ok(value)
    })
    .await
    .map_err(|_| ApiError::internal("Task storage unavailable"))?
}

fn transition(record: &mut TaskRecord, status: TaskStatus, message: &str, now: u64) {
    record.status = status.clone();
    record.updated_at = now;
    if status == TaskStatus::Running {
        record.started_at = Some(now);
    }
    if status.terminal() {
        record.completed_at = Some(now);
    }
    if record.events.len() >= 80 {
        record.events.remove(0);
    }
    record.events.push(TaskEvent {
        at: now,
        status,
        message: message.to_string(),
    });
}

fn append_output(output: &mut Vec<u8>, bytes: &[u8], truncated: &mut bool) {
    if bytes.len() >= OUTPUT_LIMIT {
        output.clear();
        output.extend_from_slice(&bytes[bytes.len() - OUTPUT_LIMIT..]);
        *truncated = true;
        return;
    }
    let overflow = output
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(OUTPUT_LIMIT);
    if overflow > 0 {
        output.drain(..overflow);
        *truncated = true;
    }
    output.extend_from_slice(bytes);
}

fn readable_result(provider: &str, output: &str) -> String {
    if provider == "hermes" {
        return crate::session_search::safe_history_text(output);
    }
    let mut messages = Vec::new();
    let mut final_result = None;
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if provider == "claude" {
            if value["type"] == "result" {
                if let Some(result) = value["result"].as_str() {
                    final_result = Some(result.to_string());
                }
            } else if value["type"] == "assistant" {
                if let Some(content) = value["message"]["content"].as_array() {
                    for block in content {
                        if block["type"] == "text" {
                            if let Some(text) = block["text"].as_str() {
                                messages.push(text.to_string());
                            }
                        }
                    }
                }
            }
        } else if provider == "codex"
            && value["type"] == "item.completed"
            && value["item"]["type"] == "agent_message"
        {
            if let Some(text) = value["item"]["text"].as_str() {
                messages.push(text.to_string());
            }
        }
    }
    crate::session_search::safe_history_text(&final_result.unwrap_or_else(|| messages.join("\n\n")))
}

#[derive(Deserialize)]
struct WorkspaceQuery {
    path: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleUpdate {
    enabled: bool,
}
#[derive(Serialize)]
struct TaskList {
    tasks: Vec<TaskRecord>,
    schedules: Vec<ScheduleRecord>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/tasks",
            axum::routing::get(list).post(create_task),
        )
        .route(
            "/api/workspace/tasks/{id}",
            axum::routing::delete(delete_task),
        )
        .route(
            "/api/workspace/tasks/{id}/cancel",
            axum::routing::post(cancel_task),
        )
        .route(
            "/api/workspace/schedules",
            axum::routing::post(create_schedule),
        )
        .route(
            "/api/workspace/schedules/{id}",
            axum::routing::patch(update_schedule).delete(delete_schedule),
        )
        .route(
            "/api/workspace/schedules/{id}/run",
            axum::routing::post(run_schedule),
        )
        .layer(axum::middleware::map_response(no_store))
}

async fn no_store(mut response: axum::response::Response) -> axum::response::Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<TaskList>, ApiError> {
    if query
        .path
        .as_ref()
        .is_some_and(|path| path.len() > 2048 || !FsPath::new(path).is_absolute())
    {
        return Err(ApiError::bad_request(
            "An absolute workspace path is required",
        ));
    }
    let data_dir = state.config().data_dir.clone();
    let owner = user.user_id;
    let store = tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        read_store(&data_dir, &owner)
    })
    .await
    .map_err(|_| ApiError::internal("Task storage unavailable"))??;
    let path = query
        .path
        .map(|value| crate::session_search::normalize_workspace_path(&value));
    let mut tasks: Vec<_> = store
        .tasks
        .into_iter()
        .filter(|task| {
            path.as_ref().is_none_or(|path| {
                *path == crate::session_search::normalize_workspace_path(&task.input.workspace_path)
            })
        })
        .collect();
    tasks.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let schedules = store
        .schedules
        .into_iter()
        .filter(|schedule| {
            path.as_ref().is_none_or(|path| {
                *path
                    == crate::session_search::normalize_workspace_path(
                        &schedule.input.workspace_path,
                    )
            })
        })
        .collect();
    Ok(Json(TaskList { tasks, schedules }))
}

async fn canonical_task(mut input: TaskInput) -> Result<TaskInput, ApiError> {
    validate_task(&input)?;
    tokio::task::spawn_blocking(move || {
        let path = std::fs::canonicalize(&input.workspace_path)
            .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
        if !path.is_dir() {
            return Err(ApiError::bad_request("Workspace must be a directory"));
        }
        input.workspace_path = path.to_string_lossy().into_owned();
        input.prompt = input.prompt.trim().into();
        Ok(input)
    })
    .await
    .map_err(|_| ApiError::internal("Workspace validation unavailable"))?
}

async fn create_task(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<TaskInput>,
) -> Result<Json<TaskRecord>, ApiError> {
    let input = canonical_task(input).await?;
    let _activity = crate::workspace_activity::enter(FsPath::new(&input.workspace_path))
        .map_err(ApiError::bad_request)?;
    let record = edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| enqueue(store, input, None, now_ms()),
    )
    .await?;
    Ok(Json(record))
}

async fn cancel_task(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<TaskRecord>, ApiError> {
    let record = edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| {
            let task = store
                .tasks
                .iter_mut()
                .find(|task| task.id == id)
                .ok_or_else(not_found)?;
            cancel_record(task, now_ms());
            Ok(task.clone())
        },
    )
    .await?;
    Ok(Json(record))
}

async fn delete_task(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| {
            let task = store
                .tasks
                .iter()
                .find(|task| task.id == id)
                .ok_or_else(not_found)?;
            if !task.status.terminal() {
                return Err(ApiError::bad_request("Cancel the task before removing it"));
            }
            if store
                .tasks
                .iter()
                .any(|task| task.input.parent_task_id == Some(id))
                || store
                    .schedules
                    .iter()
                    .any(|schedule| schedule.input.parent_task_id == Some(id))
            {
                return Err(ApiError::bad_request(
                    "Remove child tasks and schedules first",
                ));
            }
            store.tasks.retain(|task| task.id != id);
            Ok(())
        },
    )
    .await?;
    Ok(Json(serde_json::json!({ "removed": true })))
}

fn validate_interval(seconds: u64) -> Result<(), ApiError> {
    if !(60..=2_592_000).contains(&seconds) {
        return Err(ApiError::bad_request(
            "Schedules repeat every 60 seconds to 30 days",
        ));
    }
    Ok(())
}

async fn create_schedule(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<ScheduleInput>,
) -> Result<Json<ScheduleRecord>, ApiError> {
    validate_interval(input.interval_seconds)?;
    if input.name.trim().is_empty()
        || input.name.chars().count() > 80
        || input.name.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "Schedule name must be 1–80 characters",
        ));
    }
    let task = canonical_task(input.task).await?;
    let record = edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| {
            if store.schedules.len() >= SCHEDULE_LIMIT {
                return Err(ApiError::bad_request(
                    "Remove an old schedule before creating another",
                ));
            }
            if task
                .parent_task_id
                .is_some_and(|id| !store.tasks.iter().any(|parent| parent.id == id))
            {
                return Err(ApiError::bad_request(
                    "Parent task must belong to this workspace owner",
                ));
            }
            let now = now_ms();
            let schedule = ScheduleRecord {
                id: Uuid::new_v4(),
                name: input.name.trim().into(),
                input: task,
                interval_seconds: input.interval_seconds,
                enabled: input.enabled,
                next_run_at: input
                    .enabled
                    .then_some(now.saturating_add(input.interval_seconds * 1000)),
                last_run_at: None,
                last_task_id: None,
                created_at: now,
            };
            store.schedules.push(schedule.clone());
            Ok(schedule)
        },
    )
    .await?;
    Ok(Json(record))
}

async fn update_schedule(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
    Json(input): Json<ScheduleUpdate>,
) -> Result<Json<ScheduleRecord>, ApiError> {
    let record = edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| {
            let schedule = store
                .schedules
                .iter_mut()
                .find(|schedule| schedule.id == id)
                .ok_or_else(not_found)?;
            schedule.enabled = input.enabled;
            schedule.next_run_at = input
                .enabled
                .then_some(now_ms().saturating_add(schedule.interval_seconds * 1000));
            Ok(schedule.clone())
        },
    )
    .await?;
    Ok(Json(record))
}

async fn run_schedule(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<TaskRecord>, ApiError> {
    let record = edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| {
            let index = store
                .schedules
                .iter()
                .position(|schedule| schedule.id == id)
                .ok_or_else(not_found)?;
            if store
                .tasks
                .iter()
                .any(|task| task.schedule_id == Some(id) && !task.status.terminal())
            {
                return Err(ApiError::bad_request(
                    "This schedule already has a pending task",
                ));
            }
            let now = now_ms();
            let _activity = crate::workspace_activity::enter(FsPath::new(
                &store.schedules[index].input.workspace_path,
            ))
            .map_err(ApiError::bad_request)?;
            let task = enqueue(store, store.schedules[index].input.clone(), Some(id), now)?;
            let schedule = &mut store.schedules[index];
            schedule.last_run_at = Some(now);
            schedule.last_task_id = Some(task.id);
            schedule.next_run_at = schedule
                .enabled
                .then_some(now.saturating_add(schedule.interval_seconds * 1000));
            Ok(task)
        },
    )
    .await?;
    Ok(Json(record))
}

async fn delete_schedule(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    edit_store(
        state.config().data_dir.clone(),
        user.user_id,
        move |store| {
            if !store.schedules.iter().any(|schedule| schedule.id == id) {
                return Err(not_found());
            }
            store.schedules.retain(|schedule| schedule.id != id);
            Ok(())
        },
    )
    .await?;
    Ok(Json(serde_json::json!({ "removed": true })))
}

pub(crate) fn has_pending_workspace(data: &FsPath, path: &FsPath) -> Result<bool, ApiError> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Task storage unavailable"))?;
    let key = crate::workspace_activity::workspace_key(path).map_err(ApiError::bad_request)?;
    Ok(load_owner_stores(data)?.iter().any(|store| {
        store.tasks.iter().any(|task| {
            !task.status.terminal()
                && crate::workspace_activity::workspace_key(FsPath::new(&task.input.workspace_path))
                    .ok()
                    .as_ref()
                    == Some(&key)
        })
    }))
}
fn load_owner_stores(data_dir: &FsPath) -> Result<Vec<TaskStore>, ApiError> {
    let directory = data_dir.join("workspace-tasks");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut stores = Vec::new();
    for entry in
        std::fs::read_dir(directory).map_err(|_| ApiError::internal("Task storage unavailable"))?
    {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if !entry.file_type().is_ok_and(|kind| kind.is_file())
            || entry
                .metadata()
                .is_ok_and(|metadata| metadata.len() > 32 * 1024 * 1024)
        {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let Ok(store) = serde_json::from_slice::<TaskStore>(&bytes) else {
            continue;
        };
        if store.tasks.len() > TASK_LIMIT
            || store.schedules.len() > SCHEDULE_LIMIT
            || store_path(data_dir, &store.owner_id) != entry.path()
        {
            continue;
        }
        match read_store(data_dir, &store.owner_id) {
            Ok(store) => stores.push(store),
            Err(error) => {
                tracing::warn!(error = %error.message, "Task owner storage is unavailable; other owners remain available")
            }
        };
    }
    stores.sort_by(|left, right| left.owner_id.cmp(&right.owner_id));
    Ok(stores)
}

fn workspace_key(path: &str) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    if cfg!(windows) {
        PathBuf::from(canonical.to_string_lossy().to_lowercase())
    } else {
        canonical
    }
}

fn claim_tasks(
    data_dir: &FsPath,
    recover: bool,
    active: &std::collections::HashSet<PathBuf>,
    capacity: usize,
) -> Result<Vec<(String, TaskRecord)>, ApiError> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Task storage unavailable"))?;
    let mut selected = Vec::new();
    let mut occupied: std::collections::HashSet<_> = active
        .iter()
        .map(|p| workspace_key(&p.to_string_lossy()))
        .collect();
    for mut store in load_owner_stores(data_dir)? {
        let original = serde_json::to_vec(&store)
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        let now = now_ms();
        if recover {
            recover_interrupted(&mut store, now);
        }
        queue_due_schedules(&mut store, now, |input| {
            crate::workspace_activity::enter(FsPath::new(&input.workspace_path)).is_ok()
        });
        let mut candidates: Vec<_> = store
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, task)| task.status == TaskStatus::Queued)
            .map(|(index, task)| (index, task.created_at))
            .collect();
        candidates.sort_by_key(|(_, at)| *at);
        let mut claimed = Vec::new();
        for (index, _) in candidates {
            if selected.len() + claimed.len() >= capacity {
                break;
            }
            let task = &mut store.tasks[index];
            let key = workspace_key(&task.input.workspace_path);
            if occupied.contains(&key) {
                continue;
            }
            occupied.insert(key.clone());
            transition(task, TaskStatus::Running, "Native agent task started", now);
            claimed.push((key, task.clone()));
        }
        if !completion_records(data_dir, &store.owner_id).is_empty()
            || serde_json::to_vec(&store).ok().as_deref() != Some(original.as_slice())
        {
            if let Err(error) = write_store(data_dir, &store) {
                for (key, _) in claimed {
                    occupied.remove(&key);
                }
                tracing::warn!(owner = %store.owner_id, error = %error.message, "Task owner store could not be saved; other owners remain available");
                continue;
            }
        }
        selected.extend(
            claimed
                .into_iter()
                .map(|(_, task)| (store.owner_id.clone(), task)),
        );
    }
    Ok(selected)
}

#[cfg(test)]
mod worker_durability_tests {
    use super::*;
    fn fixture_store(data_dir: &FsPath, owner: &str, workspaces: &[&FsPath]) -> TaskStore {
        let mut store = TaskStore {
            owner_id: owner.into(),
            ..Default::default()
        };
        for (index, path) in workspaces.iter().enumerate() {
            enqueue(
                &mut store,
                TaskInput {
                    workspace_path: path.to_string_lossy().into_owned(),
                    provider: "codex".into(),
                    prompt: "Local fixture".into(),
                    model: None,
                    parent_session_id: None,
                    parent_task_id: None,
                },
                None,
                index as u64,
            )
            .unwrap();
        }
        write_store(data_dir, &store).unwrap();
        store
    }
    #[test]
    fn claims_three_distinct_workspaces_and_keeps_same_workspace_queued() {
        let dir = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        fixture_store(
            dir.path(),
            "owner",
            &[a.path(), a.path(), b.path(), c.path()],
        );
        let tasks = claim_tasks(dir.path(), false, &Default::default(), 3).unwrap();
        assert_eq!(
            tasks
                .iter()
                .map(|(_, t)| t.input.workspace_path.clone())
                .collect::<Vec<_>>(),
            vec![a.path(), b.path(), c.path()]
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            read_store(dir.path(), "owner")
                .unwrap()
                .tasks
                .iter()
                .map(|t| t.status.clone())
                .collect::<Vec<_>>(),
            vec![
                TaskStatus::Running,
                TaskStatus::Queued,
                TaskStatus::Running,
                TaskStatus::Running
            ]
        );
    }
    #[test]
    fn active_workspace_is_excluded_across_owners_and_idle_stores_are_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "a", &[workspace.path()]);
        fixture_store(dir.path(), "b", &[workspace.path()]);
        let path = store_path(dir.path(), "a");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let active =
            std::collections::HashSet::from([std::fs::canonicalize(workspace.path()).unwrap()]);
        assert!(claim_tasks(dir.path(), false, &active, 3)
            .unwrap()
            .is_empty());
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), before);
    }
    #[test]
    fn completion_keeps_checkpoint_metadata_and_late_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let store = fixture_store(dir.path(), "owner", &[workspace.path()]);
        let mut existing = store.tasks[0].clone();
        let mut finished = existing.clone();
        let before = Uuid::new_v4();
        let after = Uuid::new_v4();
        existing.before_checkpoint_id = Some(before);
        existing.after_checkpoint_id = Some(after);
        transition(
            &mut existing,
            TaskStatus::Cancelling,
            "Cancellation requested",
            2,
        );
        finished.result = "Saved answer".into();
        transition(&mut finished, TaskStatus::Completed, "Completed", 3);
        merge_completion(&mut existing, finished);
        assert_eq!(
            (
                existing.status,
                existing.before_checkpoint_id,
                existing.after_checkpoint_id,
                existing.result
            ),
            (
                TaskStatus::Cancelled,
                Some(before),
                Some(after),
                "Saved answer".into()
            )
        );
    }
    #[test]
    fn corrupt_owner_does_not_prevent_healthy_owner_claim_or_restart_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut store = fixture_store(dir.path(), "healthy", &[workspace.path(), workspace.path()]);
        store.tasks[0].status = TaskStatus::Running;
        write_store(dir.path(), &store).unwrap();
        std::fs::write(store_path(dir.path(), "corrupt"), "invalid").unwrap();
        let claimed = claim_tasks(dir.path(), true, &Default::default(), 3).unwrap();
        assert_eq!(
            (
                claimed.len(),
                read_store(dir.path(), "healthy").unwrap().tasks[0]
                    .status
                    .clone()
            ),
            (1, TaskStatus::Interrupted)
        );
        assert_eq!(
            std::fs::read_to_string(store_path(dir.path(), "corrupt")).unwrap(),
            "invalid"
        );
    }
}

struct WorkerRegistration(PathBuf);
impl Drop for WorkerRegistration {
    fn drop(&mut self) {
        if let Some(workers) = WORKERS.get() {
            if let Ok(mut keys) = workers.lock() {
                keys.remove(&self.0);
            }
        }
    }
}

pub fn start_worker(state: AppState) -> bool {
    let data_dir = state
        .config()
        .data_dir
        .canonicalize()
        .unwrap_or_else(|_| state.config().data_dir.clone());
    let workers = WORKERS.get_or_init(Default::default);
    let Ok(mut keys) = workers.lock() else {
        return false;
    };
    if keys.contains_key(&data_dir) {
        return false;
    }
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    keys.insert(data_dir.clone(), stop);
    drop(keys);
    tokio::spawn(async move {
        let _registration = WorkerRegistration(data_dir.clone());
        let mut running = tokio::task::JoinSet::new();
        let mut occupied = std::collections::HashSet::new();
        let mut recover = true;
        loop {
            while let Some(result) = running.try_join_next() {
                if let Ok(key) = result {
                    occupied.remove(&key);
                }
            }
            if *shutdown.borrow() {
                while running.join_next().await.is_some() {}
                break;
            }
            let path = data_dir.clone();
            let active = occupied.clone();
            let capacity = 3usize.saturating_sub(running.len());
            match tokio::task::spawn_blocking(move || {
                claim_tasks(&path, recover, &active, capacity)
            })
            .await
            {
                Ok(Ok(tasks)) => {
                    recover = false;
                    for (owner, task) in tasks {
                        let key = workspace_key(&task.input.workspace_path);
                        occupied.insert(key.clone());
                        let data_dir = data_dir.clone();
                        let shutdown = shutdown.clone();
                        running.spawn(async move {
                            use futures_util::FutureExt;
                            let mut interrupted = task.clone(); let saved_dir = data_dir.clone(); let saved_owner = owner.clone();
                            if std::panic::AssertUnwindSafe(execute_task(data_dir, owner, task, shutdown)).catch_unwind().await.is_err() {
                                interrupted.error = Some("Task execution stopped unexpectedly. Review workspace changes before running again.".into());
                                transition(&mut interrupted, TaskStatus::Interrupted, "Task worker stopped unexpectedly", now_ms());
                                persist_final_record(saved_dir, saved_owner, interrupted).await;
                            }
                            key
                        });
                    }
                }
                _ => tracing::warn!("Workspace task queue could not be read"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
    true
}

pub async fn shutdown_workers() {
    if let Some(workers) = WORKERS.get() {
        if let Ok(keys) = workers.lock() {
            for stop in keys.values() {
                let _ = stop.send(true);
            }
        }
    }
    for _ in 0..100 {
        if WORKERS
            .get()
            .is_none_or(|workers| workers.lock().is_ok_and(|keys| keys.is_empty()))
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    tracing::error!("Task workers did not finish shutdown within ten seconds; native process guards will terminate their tools when the runtime exits");
}

async fn save_task_checkpoint(data_dir: &FsPath, owner: &str, task: &TaskRecord, before: bool) {
    let label = if before { "Before task" } else { "After task" };
    let checkpoint = crate::workspace_git::capture_checkpoint(
        data_dir,
        owner,
        &task.input.workspace_path,
        label,
    )
    .await;
    let id = task.id;
    let saved = edit_store(data_dir.into(), owner.into(), move |store| {
        let record = store
            .tasks
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(not_found)?;
        let message = match checkpoint {
            Ok(checkpoint) => {
                if before {
                    record.before_checkpoint_id = Some(checkpoint.id);
                } else {
                    record.after_checkpoint_id = Some(checkpoint.id);
                }
                format!("{label} checkpoint saved")
            }
            Err(error) => format!(
                "{label} checkpoint unavailable: {}",
                crate::session_search::safe_history_text(&error.message)
                    .chars()
                    .take(240)
                    .collect::<String>()
            ),
        };
        if record.events.len() >= 80 {
            record.events.remove(0);
        }
        record.events.push(TaskEvent {
            at: now_ms(),
            status: record.status.clone(),
            message,
        });
        Ok(())
    })
    .await;
    if saved.is_err() {
        tracing::warn!(task_id = %task.id, "Task checkpoint metadata could not be saved; review task storage availability");
    }
}

async fn execute_task(
    data_dir: PathBuf,
    owner: String,
    task: TaskRecord,
    shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let _activity = match crate::workspace_activity::enter_wait(FsPath::new(
        &task.input.workspace_path,
    ))
    .await
    {
        Ok(guard) => guard,
        Err(error) => {
            let mut failed = task;
            failed.error = Some(error);
            transition(
                &mut failed,
                TaskStatus::Failed,
                "Workspace unavailable for task",
                now_ms(),
            );
            persist_final_record(data_dir, owner, failed).await;
            return;
        }
    };
    let command = crate::hermes_provider_bridge::owner_task_command(
        &data_dir,
        &owner,
        &task.input.provider,
        &task.input.prompt,
        task.input.model.as_deref(),
        FsPath::new(&task.input.workspace_path),
    );
    match command {
        Ok(command) => {
            save_task_checkpoint(&data_dir, &owner, &task, true).await;
            run_command_inner(
                data_dir.clone(),
                owner.clone(),
                task.clone(),
                command,
                shutdown,
            )
            .await;
            save_task_checkpoint(&data_dir, &owner, &task, false).await;
        }
        Err(_) => {
            let mut failed = task;
            failed.error = Some(
                "Selected agent could not be started. Check its installation and model settings."
                    .into(),
            );
            transition(
                &mut failed,
                TaskStatus::Failed,
                "Native agent unavailable",
                now_ms(),
            );
            persist_final_record(data_dir, owner, failed).await;
        }
    }
}

async fn read_pipe(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    sender: tokio::sync::mpsc::Sender<(bool, Vec<u8>)>,
    stdout: bool,
) {
    use tokio::io::AsyncReadExt;
    let mut buffer = vec![0; 8192];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if sender
                    .send((stdout, buffer[..count].to_vec()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}

async fn persist_final_record(data_dir: PathBuf, owner: String, record: TaskRecord) {
    for attempt in 0..3 {
        let saved = record.clone();
        let result = edit_store(data_dir.clone(), owner.clone(), move |store| {
            let existing = store
                .tasks
                .iter_mut()
                .find(|task| task.id == saved.id)
                .ok_or_else(not_found)?;
            merge_completion(existing, saved);
            Ok(())
        })
        .await;
        if result.is_ok() {
            return;
        }
        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt + 1))).await;
        }
    }
    tracing::error!(task_id = %record.id, "Task finished but its owner store could not be saved. Completion receipt retained; check app data directory permissions and free disk space.");
    retain_completion(&data_dir, &owner, record);
}

#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
// The job owns its handle; Windows permits handle use and closure from any thread.
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        let process = child
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("Process already exited"))?;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, process) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self(job))
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(unix)]
struct ProcessTree(u32);
#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
        child
            .id()
            .map(Self)
            .ok_or_else(|| std::io::Error::other("Process has already exited"))
    }
    fn terminate(&self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(test)]
async fn run_command(
    data_dir: PathBuf,
    owner: String,
    task: TaskRecord,
    command: tokio::process::Command,
) {
    let (_stop, shutdown) = tokio::sync::watch::channel(false);
    run_command_inner(data_dir, owner, task, command, shutdown).await;
}

async fn run_command_inner(
    data_dir: PathBuf,
    owner: String,
    task: TaskRecord,
    mut command: tokio::process::Command,
    shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let id = task.id;
    if *shutdown.borrow() {
        let mut interrupted = task;
        interrupted.error = Some("Server stopped before native agent launch.".into());
        transition(
            &mut interrupted,
            TaskStatus::Interrupted,
            "Task interrupted by server shutdown",
            now_ms(),
        );
        persist_final_record(data_dir, owner, interrupted).await;
        return;
    }
    let cancelled = edit_store(data_dir.clone(), owner.clone(), move |store| {
        let record = store
            .tasks
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(not_found)?;
        if matches!(
            record.status,
            TaskStatus::Cancelling | TaskStatus::Cancelled
        ) {
            cancel_record(record, now_ms());
            if record.status == TaskStatus::Cancelling {
                transition(
                    record,
                    TaskStatus::Cancelled,
                    "Task cancelled before native launch",
                    now_ms(),
                );
            }
            return Ok(true);
        }
        Ok(record.status != TaskStatus::Running)
    })
    .await;
    let cancelled = match cancelled {
        Ok(cancelled) => cancelled,
        Err(_) => {
            let mut failed = task;
            failed.error = Some("Task storage could not be verified before native launch. Check app data directory permissions and free disk space.".into());
            transition(
                &mut failed,
                TaskStatus::Failed,
                "Task storage unavailable before launch",
                now_ms(),
            );
            persist_final_record(data_dir, owner, failed).await;
            return;
        }
    };
    if cancelled {
        return;
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            let mut failed = task;
            failed.error =
                Some("Native agent executable is unavailable or could not be launched.".into());
            transition(
                &mut failed,
                TaskStatus::Failed,
                "Native agent failed to launch",
                now_ms(),
            );
            persist_final_record(data_dir, owner, failed).await;
            return;
        }
    };
    let process_tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill().await;
            let mut failed = task.clone();
            failed.error = Some(format!("Cannot contain native agent tool processes: {error}. Task was stopped before tool execution."));
            transition(
                &mut failed,
                TaskStatus::Failed,
                "Native process containment unavailable",
                now_ms(),
            );
            persist_final_record(data_dir, owner, failed).await;
            return;
        }
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel(32);
    let stdout_reader = tokio::spawn(read_pipe(
        child.stdout.take().unwrap(),
        sender.clone(),
        true,
    ));
    let stderr_reader = tokio::spawn(read_pipe(child.stderr.take().unwrap(), sender, false));
    let mut output = Vec::new();
    let mut stdout = Vec::new();
    let mut truncated = false;
    let mut exit_status = None;
    let mut exited_at = None;
    let started = std::time::Instant::now();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
    let mut cancelled = false;
    let mut timed_out = false;
    let mut interrupted = false;
    let mut storage_failed = false;
    let mut read_closed = false;
    loop {
        tokio::select! {
            bytes = receiver.recv(), if !read_closed => {
                match bytes {
                    Some((is_stdout, bytes)) => {
                        append_output(&mut output, &bytes, &mut truncated);
                        if is_stdout { append_output(&mut stdout, &bytes, &mut truncated); }
                    }
                    None => { read_closed = true; if exit_status.is_some() { break; } }
                }
            }
            status = child.wait(), if exit_status.is_none() => {
                exit_status = Some(status);
                exited_at = Some(std::time::Instant::now());
                if read_closed { break; }
            }
            _ = tick.tick() => {
                let saved_output = crate::session_search::safe_history_text(&String::from_utf8_lossy(&output));
                let result = readable_result(&task.input.provider, &String::from_utf8_lossy(&stdout));
                let cancel = edit_store(data_dir.clone(), owner.clone(), move |store| {
                    let record = store.tasks.iter_mut().find(|record| record.id == id).ok_or_else(not_found)?;
                    if record.output != saved_output || record.result != result || record.output_truncated != truncated {
                        record.output = saved_output; record.result = result; record.output_truncated = truncated; record.updated_at = now_ms();
                    }
                    Ok(record.status == TaskStatus::Cancelling || record.status == TaskStatus::Cancelled)
                }).await;
                let cancel = match cancel { Ok(cancel) => cancel, Err(_) => { storage_failed = true; true } };
                if cancel && exit_status.is_none() {
                    cancelled = !storage_failed;
                    process_tree.terminate();
                    let _ = child.start_kill();
                }
                if *shutdown.borrow() && exit_status.is_none() {
                    interrupted = true;
                    process_tree.terminate();
                    let _ = child.start_kill();
                }
                if started.elapsed() > std::time::Duration::from_secs(1800) && exit_status.is_none() {
                    timed_out = true;
                    process_tree.terminate();
                    let _ = child.start_kill();
                }
                if exited_at.is_some_and(|at| at.elapsed() > std::time::Duration::from_secs(1)) { break; }
            }
        }
    }
    stdout_reader.abort();
    stderr_reader.abort();
    let output = crate::session_search::safe_history_text(&String::from_utf8_lossy(&output));
    let result = readable_result(&task.input.provider, &String::from_utf8_lossy(&stdout));
    let provider_failed = crate::native_provider_events::provider_failed(
        &task.input.provider,
        &String::from_utf8_lossy(&stdout),
    );
    let mut record = task;
    record.output = output;
    record.result = result;
    record.output_truncated = truncated;
    let success = exit_status
        .as_ref()
        .is_some_and(|status| status.as_ref().is_ok_and(|status| status.success()))
        && !provider_failed;
    record.exit_code = exit_status
        .and_then(|status| status.ok())
        .and_then(|status| status.code());
    if interrupted {
        record.error =
            Some("App server stopped. Review workspace changes before running again.".into());
        transition(
            &mut record,
            TaskStatus::Interrupted,
            "Task interrupted by server shutdown",
            now_ms(),
        );
    } else if storage_failed {
        record.error = Some("Task storage became unavailable; native tools were stopped. Check app data directory permissions and free disk space.".into());
        transition(
            &mut record,
            TaskStatus::Failed,
            "Task stopped because storage is unavailable",
            now_ms(),
        );
    } else if cancelled || record.status == TaskStatus::Cancelling {
        transition(
            &mut record,
            TaskStatus::Cancelled,
            "Task cancelled",
            now_ms(),
        );
    } else if timed_out {
        record.error = Some("Task exceeded the 30 minute execution limit.".into());
        transition(
            &mut record,
            TaskStatus::Failed,
            "Task time limit reached",
            now_ms(),
        );
    } else if success {
        transition(
            &mut record,
            TaskStatus::Completed,
            "Task completed",
            now_ms(),
        );
    } else {
        record.error =
            Some("Native agent reported a failure or exited unsuccessfully. Review the saved agent output.".into());
        transition(
            &mut record,
            TaskStatus::Failed,
            "Native agent task failed",
            now_ms(),
        );
    }
    persist_final_record(data_dir, owner, record).await;
}

#[cfg(test)]
mod route_io_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    async fn request(
        router: Router,
        token: Option<&str>,
        method: &str,
        uri: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let response = router
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    #[tokio::test]
    async fn authenticated_queue_and_schedules_preserve_owner_isolation_and_explicit_runs() {
        let dir = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: dir.path().join("data"),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let router = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let owner = crate::auth::issue_access_token(&config.jwt_secret, "owner", "owner");
        let other = crate::auth::issue_access_token(&config.jwt_secret, "other", "other");
        let input = serde_json::json!({ "workspacePath": dir.path().to_string_lossy(), "provider": "hermes", "prompt": "Inspect only", "parentSessionId": "ss-parent" });
        assert_eq!(
            request(
                router.clone(),
                None,
                "GET",
                "/api/workspace/tasks",
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, task) = request(
            router.clone(),
            Some(&owner),
            "POST",
            "/api/workspace/tasks",
            input.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let id = task["id"].as_str().unwrap();
        assert_eq!(
            (task["status"].as_str(), task["parentSessionId"].as_str()),
            (Some("queued"), Some("ss-parent"))
        );
        let (_, data) = request(
            router.clone(),
            Some(&other),
            "GET",
            "/api/workspace/tasks",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(data, serde_json::json!({ "tasks": [], "schedules": [] }));
        assert_eq!(
            request(
                router.clone(),
                Some(&other),
                "POST",
                &format!("/api/workspace/tasks/{id}/cancel"),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (_, cancelled) = request(
            router.clone(),
            Some(&owner),
            "POST",
            &format!("/api/workspace/tasks/{id}/cancel"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(cancelled["status"], "cancelled");
        let mut schedule_input = input;
        schedule_input["name"] = "Review".into();
        schedule_input["intervalSeconds"] = 60.into();
        let (status, schedule) = request(
            router.clone(),
            Some(&owner),
            "POST",
            "/api/workspace/schedules",
            schedule_input.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            (
                schedule["enabled"].as_bool(),
                schedule["nextRunAt"].as_u64()
            ),
            (Some(false), None)
        );
        let schedule_id = schedule["id"].as_str().unwrap();
        let run_uri = format!("/api/workspace/schedules/{schedule_id}/run");
        let (status, run) = request(
            router.clone(),
            Some(&owner),
            "POST",
            &run_uri,
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(
            (status, run["status"].as_str(), run["scheduleId"].as_str()),
            (StatusCode::OK, Some("queued"), Some(schedule_id))
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "POST",
                &run_uri,
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        schedule_input["intervalSeconds"] = 59.into();
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "POST",
                "/api/workspace/schedules",
                schedule_input
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let store = read_store(&config.data_dir, "owner").unwrap();
        assert_eq!((store.tasks.len(), store.schedules.len()), (2, 1));
    }

    #[tokio::test]
    async fn local_child_execution_persists_native_results_and_nonzero_exit_status() {
        let dir = tempfile::tempdir().unwrap();
        let owner = "process-owner".to_string();
        let mut store = TaskStore {
            owner_id: owner.clone(),
            ..Default::default()
        };
        let input = TaskInput {
            workspace_path: dir.path().to_string_lossy().into_owned(),
            provider: "codex".into(),
            prompt: "Local test fixture".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        let mut task = enqueue(&mut store, input, None, now_ms()).unwrap();
        task.status = TaskStatus::Running;
        store.tasks[0] = task.clone();
        write_store(dir.path(), &store).unwrap();
        let mut command = if cfg!(windows) {
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", "Write-Output '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Local execution finished\"}}'; exit 7"]);
            command
        } else {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Local execution finished\"}}'; exit 7"]);
            command
        };
        command.current_dir(dir.path());
        run_command(dir.path().into(), owner.clone(), task, command).await;
        let loaded = read_store(dir.path(), &owner).unwrap();
        assert_eq!(
            (
                loaded.tasks[0].status.clone(),
                loaded.tasks[0].exit_code,
                loaded.tasks[0].result.as_str()
            ),
            (TaskStatus::Failed, Some(7), "Local execution finished")
        );
    }

    #[test]
    fn native_jsonl_results_exclude_tool_payloads_and_preserve_final_answers() {
        let claude = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"First draft\"},{\"type\":\"tool_use\",\"input\":{\"secret\":\"unsafe\"}}]}}\n{\"type\":\"result\",\"result\":\"Final answer\"}";
        let codex = "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"tool-only\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Answer one\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Answer two\"}}";
        assert_eq!(
            (
                readable_result("claude", claude),
                readable_result("codex", codex),
                readable_result("hermes", "Plain answer")
            ),
            (
                "Final answer".into(),
                "Answer one\n\nAnswer two".into(),
                "Plain answer".into()
            )
        );
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;

    #[test]
    fn output_buffer_preserves_split_unicode_and_caps_bytes_without_stopping_pipe_drain() {
        let encoded = "前café".as_bytes();
        let mut output = Vec::new();
        let mut truncated = false;
        append_output(&mut output, &encoded[..2], &mut truncated);
        append_output(&mut output, &encoded[2..], &mut truncated);
        assert_eq!(String::from_utf8(output.clone()).unwrap(), "前café");
        append_output(&mut output, &vec![b'x'; OUTPUT_LIMIT], &mut truncated);
        assert_eq!((output.len(), truncated), (OUTPUT_LIMIT, true));
        append_output(&mut output, b"more", &mut truncated);
        assert_eq!(
            (output.len(), &output[output.len() - 4..]),
            (OUTPUT_LIMIT, b"more".as_slice())
        );
    }
}

#[cfg(test)]
mod completion_recovery_tests {
    use super::*;
    #[cfg(windows)]
    #[tokio::test]
    async fn failed_final_replace_surfaces_result_and_recovers_after_file_unlock() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "receipt-owner".into(),
            ..Default::default()
        };
        let mut record = enqueue(
            &mut store,
            TaskInput {
                workspace_path: dir.path().to_string_lossy().into_owned(),
                provider: "codex".into(),
                prompt: "Local fixture".into(),
                model: None,
                parent_session_id: None,
                parent_task_id: None,
            },
            None,
            1,
        )
        .unwrap();
        store.tasks[0].status = TaskStatus::Running;
        write_store(dir.path(), &store).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(store_path(dir.path(), "receipt-owner"))
            .unwrap();
        record.result = "Completed local result".into();
        transition(&mut record, TaskStatus::Completed, "Task completed", 2);
        persist_final_record(dir.path().into(), "receipt-owner".into(), record.clone()).await;
        let loaded = read_store(dir.path(), "receipt-owner").unwrap();
        assert_eq!(
            (
                loaded.tasks[0].status.clone(),
                loaded.tasks[0].result.clone()
            ),
            (TaskStatus::Completed, "Completed local result".into())
        );
        drop(lock);
        claim_tasks(dir.path(), false, &Default::default(), 3).unwrap();
        let bytes = std::fs::read(store_path(dir.path(), "receipt-owner")).unwrap();
        assert_eq!(
            serde_json::from_slice::<TaskStore>(&bytes).unwrap().tasks[0].status,
            TaskStatus::Completed
        );
    }
}

#[cfg(test)]
mod process_tree_io_tests {
    use super::*;
    fn fixture(data_dir: &FsPath, owner: &str) -> TaskRecord {
        let mut store = TaskStore {
            owner_id: owner.into(),
            ..Default::default()
        };
        let mut task = enqueue(
            &mut store,
            TaskInput {
                workspace_path: data_dir.to_string_lossy().into_owned(),
                provider: "hermes".into(),
                prompt: "Local fixture".into(),
                model: None,
                parent_session_id: None,
                parent_task_id: None,
            },
            None,
            now_ms(),
        )
        .unwrap();
        transition(
            &mut task,
            TaskStatus::Running,
            "Local fixture started",
            now_ms(),
        );
        store.tasks[0] = task.clone();
        write_store(data_dir, &store).unwrap();
        task
    }
    async fn local_command(data_dir: &FsPath, owner: &str, seconds: u64, exit: u8) {
        let task = fixture(data_dir, owner);
        let mut command = tokio::process::Command::new("python");
        command.args(["-c", "import sys,time; print('local fixture',flush=True); time.sleep(float(sys.argv[1])); sys.exit(int(sys.argv[2]))", &seconds.to_string(), &exit.to_string()]);
        run_command(data_dir.into(), owner.into(), task, command).await;
    }
    #[tokio::test]
    async fn three_local_processes_can_execute_concurrently_and_persist_each_exit() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        tokio::join!(
            local_command(a.path(), "a", 2, 0),
            local_command(b.path(), "b", 2, 7),
            local_command(c.path(), "c", 2, 0)
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(
            vec![
                read_store(a.path(), "a").unwrap().tasks[0].status.clone(),
                read_store(b.path(), "b").unwrap().tasks[0].status.clone(),
                read_store(c.path(), "c").unwrap().tasks[0].status.clone()
            ],
            vec![
                TaskStatus::Completed,
                TaskStatus::Failed,
                TaskStatus::Completed
            ]
        );
    }
    #[tokio::test]
    async fn zero_exit_native_protocol_errors_are_persisted_as_failed_tasks() {
        for (provider, event) in [
            (
                "claude",
                r#"{"type":"result","is_error":true,"result":"Permission denied"}"#,
            ),
            (
                "codex",
                r#"{"type":"turn.failed","error":{"message":"Authentication failed"}}"#,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut task = fixture(dir.path(), "protocol-owner");
            task.input.provider = provider.into();
            let mut command = tokio::process::Command::new("python");
            command.args(["-c", "import sys; print(sys.argv[1])", event]);
            run_command(dir.path().into(), "protocol-owner".into(), task, command).await;
            let store = read_store(dir.path(), "protocol-owner").unwrap();
            assert_eq!(
                (store.tasks[0].status.clone(), store.tasks[0].exit_code),
                (TaskStatus::Failed, Some(0))
            );
        }
    }
    #[tokio::test]
    async fn cancellation_and_shutdown_terminate_descendant_tools_and_save_terminal_state() {
        for shutdown_requested in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let task = fixture(dir.path(), "tree-owner");
            let id = task.id;
            let pid_file = dir.path().join("descendant.pid");
            let mut command = tokio::process::Command::new("python");
            command.args(["-c", "import subprocess,sys,time,pathlib; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path(sys.argv[1]).write_text(str(child.pid)); print('ready',flush=True); time.sleep(60)"]);
            command.arg(&pid_file);
            let (stop, shutdown) = tokio::sync::watch::channel(false);
            let running = tokio::spawn(run_command_inner(
                dir.path().into(),
                "tree-owner".into(),
                task,
                command,
                shutdown,
            ));
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while !pid_file.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                }
            })
            .await
            .unwrap();
            let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
            if shutdown_requested {
                stop.send(true).unwrap();
            } else {
                edit_store(dir.path().into(), "tree-owner".into(), move |store| {
                    cancel_record(
                        store.tasks.iter_mut().find(|t| t.id == id).unwrap(),
                        now_ms(),
                    );
                    Ok(())
                })
                .await
                .unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(10), running)
                .await
                .unwrap()
                .unwrap();
            let system = sysinfo::System::new_all();
            let alive = system
                .process(sysinfo::Pid::from_u32(pid))
                .is_some_and(|process| process.status() != sysinfo::ProcessStatus::Zombie);
            if alive {
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill.exe")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .output();
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            assert!(!alive, "Native descendant survived process-tree shutdown");
            assert_eq!(
                read_store(dir.path(), "tree-owner").unwrap().tasks[0].status,
                if shutdown_requested {
                    TaskStatus::Interrupted
                } else {
                    TaskStatus::Cancelled
                }
            );
        }
    }
}
