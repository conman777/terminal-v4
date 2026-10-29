use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Path, Query, State},
    Extension, Json, Router,
};
use chrono::{Datelike, TimeZone};
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use uuid::Uuid;

#[path = "workspace_tasks/cron.rs"]
mod cron;
#[path = "workspace_tasks/delivery.rs"]
mod delivery;
#[path = "workspace_tasks/schedule_change.rs"]
mod schedule_change;
pub use delivery::{DeliveryState, DeliveryStatus, DeliveryTarget};
#[cfg(test)]
use schedule_change::ReviewedScheduleChange;
pub(crate) use schedule_change::{
    commit_reviewed_schedule_change, prepare_reviewed_schedule_change,
    prepare_reviewed_schedule_edit, ScheduleChange, ScheduleEdit,
};

const TASK_LIMIT: usize = 200;
const RECEIPT_LIMIT: usize = 512 * 1024;
const COMPACT_RESULT_LIMIT: usize = 16 * 1024;
const WORKER_PROTOCOL: u64 = 2;

fn compact_receipt(record: &TaskRecord) -> TaskRecord {
    let mut compact = record.clone();
    let mut end = COMPACT_RESULT_LIMIT.min(compact.result.len());
    while !compact.result.is_char_boundary(end) {
        end -= 1;
    }
    compact.result.truncate(end);
    compact.output.clear();
    compact.output_truncated = true;
    let keep = compact.events.len().saturating_sub(5);
    compact.events.drain(..keep);
    let note = "Result truncated: the full outcome could not be stored.";
    compact.error = Some(match compact.error.take() {
        Some(existing) => format!("{existing} {note}"),
        None => note.into(),
    });
    compact
}

fn ensure_worker_protocol(data_dir: &FsPath) -> Result<(), ApiError> {
    use std::io::Write;
    let directory = data_dir.join("workspace-tasks");
    std::fs::create_dir_all(&directory)
        .map_err(|_| ApiError::internal("Task storage unavailable"))?;
    let path = directory.join("worker-protocol.json");
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|value| value.get("protocol").and_then(|v| v.as_u64()))
                .ok_or_else(|| {
                    ApiError::internal(
                        "Task worker protocol marker is unreadable; refusing to start",
                    )
                })?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(ApiError::internal("Task storage unavailable")),
    };
    match current {
        Some(found) if found > WORKER_PROTOCOL => Err(ApiError::internal(
            "This data directory was written by a newer task worker; refusing to start an older one",
        )),
        Some(found) if found == WORKER_PROTOCOL => Ok(()),
        _ => {
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)
                .map_err(|_| ApiError::internal("Task storage unavailable"))?;
            temporary
                .write_all(format!("{{\"protocol\":{WORKER_PROTOCOL}}}").as_bytes())
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|_| ApiError::internal("Task storage unavailable"))?;
            temporary
                .persist(&path)
                .map_err(|_| ApiError::internal("Task storage unavailable"))?;
            Ok(())
        }
    }
}
const SCHEDULE_LIMIT: usize = 20;
const OUTPUT_LIMIT: usize = 65_536;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
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
pub struct ScheduleInput {
    #[serde(flatten)]
    pub task: TaskInput,
    pub name: String,
    #[serde(default)]
    pub interval_seconds: u64,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub at: Option<CalendarTime>,
    #[serde(default)]
    pub run_once_at: Option<u64>,
    #[serde(default)]
    pub deliver_to: Option<DeliveryTarget>,
}

/// A time of day on chosen weekdays (0 = Sunday), or a 5-field cron expression,
/// in a named time zone or a fixed offset from UTC.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", try_from = "RawCalendarTime")]
pub struct CalendarTime {
    pub hour: u8,
    pub minute: u8,
    pub weekdays: Vec<u8>,
    pub utc_offset_minutes: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCalendarTime {
    hour: Option<u8>,
    minute: Option<u8>,
    weekdays: Option<Vec<u8>>,
    #[serde(default)]
    utc_offset_minutes: i32,
    #[serde(default)]
    time_zone: Option<String>,
    #[serde(default)]
    cron: Option<String>,
}

impl TryFrom<RawCalendarTime> for CalendarTime {
    type Error = String;
    fn try_from(raw: RawCalendarTime) -> Result<Self, String> {
        if raw.cron.is_some() {
            if raw.hour.unwrap_or(0) != 0
                || raw.minute.unwrap_or(0) != 0
                || raw.weekdays.as_ref().is_some_and(|days| !days.is_empty())
            {
                return Err("A cron schedule cannot also set hour, minute or weekdays".into());
            }
        } else if raw.hour.is_none() || raw.minute.is_none() || raw.weekdays.is_none() {
            return Err("hour, minute and weekdays are required".into());
        }
        Ok(Self {
            hour: raw.hour.unwrap_or(0),
            minute: raw.minute.unwrap_or(0),
            weekdays: raw.weekdays.unwrap_or_default(),
            utc_offset_minutes: raw.utc_offset_minutes,
            time_zone: raw.time_zone,
            cron: raw.cron,
        })
    }
}

fn validate_calendar(at: &CalendarTime) -> Result<(), ApiError> {
    if at
        .time_zone
        .as_ref()
        .is_some_and(|zone| zone.parse::<chrono_tz::Tz>().is_err())
    {
        return Err(ApiError::bad_request("Choose a valid IANA time zone"));
    }
    if let Some(expression) = &at.cron {
        if cron::CronExpr::parse(expression).is_none()
            || !(-840..=840).contains(&at.utc_offset_minutes)
            || next_calendar_run(now_ms(), at) == u64::MAX
        {
            return Err(ApiError::bad_request(
                "Use a valid 5-field cron expression with a reachable date",
            ));
        }
        return Ok(());
    }
    let mut days = at.weekdays.clone();
    days.sort_unstable();
    days.dedup();
    if at.hour > 23
        || at.minute > 59
        || days.is_empty()
        || days.len() != at.weekdays.len()
        || days.iter().any(|day| *day > 6)
        || !(-840..=840).contains(&at.utc_offset_minutes)
    {
        return Err(ApiError::bad_request(
            "Choose a time and at least one weekday",
        ));
    }
    Ok(())
}

fn next_cron_run(now: u64, at: &CalendarTime, expression: &str) -> u64 {
    let (Some(expr), Ok(now)) = (cron::CronExpr::parse(expression), i64::try_from(now)) else {
        return u64::MAX;
    };
    let found = match at.time_zone.as_deref().map(str::parse::<chrono_tz::Tz>) {
        Some(Ok(zone)) => expr.next_after(&zone, now),
        Some(Err(_)) => None,
        None => chrono::FixedOffset::east_opt(at.utc_offset_minutes.saturating_mul(60))
            .and_then(|zone| expr.next_after(&zone, now)),
    };
    found
        .and_then(|millis| u64::try_from(millis).ok())
        .unwrap_or(u64::MAX)
}

/// The next moment after `now` (milliseconds since the epoch) matching the calendar time.
pub(crate) fn next_calendar_run(now: u64, at: &CalendarTime) -> u64 {
    const DAY: i64 = 86_400_000;
    if let Some(expression) = &at.cron {
        return next_cron_run(now, at, expression);
    }
    if let Some(zone) = &at.time_zone {
        let Some(instant) = i64::try_from(now)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
        else {
            return u64::MAX;
        };
        let Ok(zone) = zone.parse::<chrono_tz::Tz>() else {
            return u64::MAX;
        };
        let today = instant.with_timezone(&zone).date_naive();
        for day in 0..15 {
            let Some(date) = today.checked_add_days(chrono::Days::new(day)) else {
                break;
            };
            if !at
                .weekdays
                .contains(&(date.weekday().num_days_from_sunday() as u8))
            {
                continue;
            }
            let Some(local) = date.and_hms_opt(at.hour.into(), at.minute.into(), 0) else {
                return u64::MAX;
            };
            // Gaps are skipped; folds run once at their earlier occurrence.
            if let Some(candidate) = zone.from_local_datetime(&local).earliest() {
                if let Ok(timestamp) = u64::try_from(candidate.timestamp_millis()) {
                    if timestamp > now {
                        return timestamp;
                    }
                }
            }
        }
        return u64::MAX;
    }
    let offset = i64::from(at.utc_offset_minutes) * 60_000;
    let local_now = now as i64 + offset;
    let local_midnight = local_now.div_euclid(DAY) * DAY;
    let time = (i64::from(at.hour) * 60 + i64::from(at.minute)) * 60_000;
    for day in 0..8 {
        let local = local_midnight + day * DAY + time;
        // 1 January 1970 was a Thursday (weekday 4).
        let weekday = ((local.div_euclid(DAY) + 4).rem_euclid(7)) as u8;
        if local > local_now && at.weekdays.contains(&weekday) {
            return (local - offset) as u64;
        }
    }
    now.saturating_add(DAY as u64)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    DelegationHeld,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) child_session_id: Option<Uuid>,
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
    #[serde(flatten)]
    pub delivery: DeliveryState,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub id: Uuid,
    pub name: String,
    #[serde(flatten)]
    pub input: TaskInput,
    pub interval_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<CalendarTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_once_at: Option<u64>,
    pub enabled: bool,
    pub next_run_at: Option<u64>,
    pub last_run_at: Option<u64>,
    pub last_task_id: Option<Uuid>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub missed_runs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_missed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<ScheduleSkill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<TaskStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_to: Option<DeliveryTarget>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleSkill {
    pub skill_ref: String,
    pub name: String,
    pub revision: String,
}

const LAST_ERROR_LIMIT: usize = 500;

fn with_last_outcomes(
    mut schedules: Vec<ScheduleRecord>,
    tasks: &[TaskRecord],
) -> Vec<ScheduleRecord> {
    for schedule in &mut schedules {
        schedule.last_status = None;
        schedule.last_error = None;
        let Some(task) = schedule
            .last_task_id
            .and_then(|id| tasks.iter().find(|task| task.id == id))
        else {
            continue;
        };
        schedule.last_status = Some(task.status.clone());
        let failure = matches!(task.status, TaskStatus::Failed | TaskStatus::Interrupted);
        schedule.last_error = task
            .error
            .clone()
            .or_else(|| {
                (failure && task.exit_code.is_some_and(|code| code != 0))
                    .then(|| format!("Exited with code {}", task.exit_code.unwrap_or_default()))
            })
            .map(|error| {
                crate::session_search::safe_history_text(&error)
                    .chars()
                    .take(LAST_ERROR_LIMIT)
                    .collect()
            });
    }
    schedules
}

fn is_zero(value: &u64) -> bool {
    *value == 0
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
    if existing.delivery.progress() > finished.delivery.progress() {
        finished.delivery = existing.delivery.clone();
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
    records
}

fn retain_completion(data_dir: &FsPath, owner: &str, record: TaskRecord) -> std::io::Result<()> {
    use std::io::Write;
    let save = || -> std::io::Result<()> {
        let path = receipt_path(data_dir, owner, record.id);
        let directory = path.parent().unwrap();
        std::fs::create_dir_all(directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        let bytes = serde_json::to_vec(&record)?;
        if bytes.len() > RECEIPT_LIMIT {
            return Err(std::io::Error::other("Completion receipt is too large"));
        }
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path).map_err(|error| error.error)?;
        #[cfg(unix)]
        {
            std::fs::File::open(directory)?.sync_all()?;
            std::fs::File::open(directory.parent().unwrap())?.sync_all()?;
        }
        Ok(())
    };
    save()
}

#[derive(Serialize, Deserialize)]
struct JournalEntry {
    owner: String,
    record: TaskRecord,
}

fn journal_path(data_dir: &FsPath) -> PathBuf {
    data_dir
        .join("workspace-tasks")
        .join("outcome-journal.jsonl")
}

fn journal_guard(data_dir: &FsPath) -> std::io::Result<std::fs::File> {
    let file = lock_file(data_dir, "outcome-journal.lock")
        .map_err(|error| std::io::Error::other(error.message))?;
    file.lock()?;
    Ok(file)
}

fn append_outcome_journal(
    data_dir: &FsPath,
    owner: &str,
    record: &TaskRecord,
) -> std::io::Result<()> {
    use std::io::Write;
    let encode = |record: &TaskRecord| {
        serde_json::to_vec(&JournalEntry {
            owner: owner.into(),
            record: record.clone(),
        })
        .map_err(std::io::Error::other)
    };
    let mut line = encode(record)?;
    if line.len() > RECEIPT_LIMIT {
        line = encode(&compact_receipt(record))?;
    }
    if line.len() > RECEIPT_LIMIT {
        return Err(std::io::Error::other("Outcome journal entry is too large"));
    }
    line.push(b'\n');
    let _guard = journal_guard(data_dir)?;
    let path = journal_path(data_dir);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(&line)?;
    file.sync_all()?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}

fn read_outcome_journal(data_dir: &FsPath) -> Vec<JournalEntry> {
    let Ok(bytes) = std::fs::read(journal_path(data_dir)) else {
        return Vec::new();
    };
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<JournalEntry>(line).ok())
        .filter(|entry| entry.record.status.terminal())
        .collect()
}

fn apply_outcome_journal(store: &mut TaskStore, entries: &[JournalEntry]) {
    for entry in entries.iter().filter(|entry| entry.owner == store.owner_id) {
        if let Some(task) = store
            .tasks
            .iter_mut()
            .find(|task| task.id == entry.record.id)
            .filter(|task| !task.status.terminal())
        {
            merge_completion(task, entry.record.clone());
        }
    }
}

fn settle_outcome_journal(
    data_dir: &FsPath,
    settled: &std::collections::HashSet<(String, Uuid)>,
) -> std::io::Result<()> {
    use std::io::Write;
    if settled.is_empty() {
        return Ok(());
    }
    let _guard = journal_guard(data_dir)?;
    let remaining: Vec<_> = read_outcome_journal(data_dir)
        .into_iter()
        .filter(|entry| !settled.contains(&(entry.owner.clone(), entry.record.id)))
        .collect();
    let path = journal_path(data_dir);
    if remaining.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let directory = path.parent().unwrap();
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    for entry in remaining {
        temporary.write_all(&serde_json::to_vec(&entry).map_err(std::io::Error::other)?)?;
        temporary.write_all(b"\n")?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
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
    let (mut store, needs_storage_migration) = decode_store(&bytes, user_id)?;
    for record in completion_records(data_dir, user_id) {
        if let Some(task) = store.tasks.iter_mut().find(|task| task.id == record.id) {
            if (task.child_session_id.is_some() || record.child_session_id.is_some())
                && (task.child_session_id != record.child_session_id
                    || task.input != record.input
                    || task.created_at != record.created_at
                    || task.schedule_id != record.schedule_id
                    || !matches!(
                        task.status,
                        TaskStatus::Running
                            | TaskStatus::Cancelling
                            | TaskStatus::Completed
                            | TaskStatus::Failed
                            | TaskStatus::Cancelled
                            | TaskStatus::Interrupted
                    )
                    || (task.status.terminal() && task.status != record.status))
            {
                return Err(ApiError::internal(
                    "Saved delegated task receipt does not match; data was preserved",
                ));
            }
            merge_completion(task, record);
        }
    }
    if needs_storage_migration {
        write_store(data_dir, &store)?;
    }
    Ok(store)
}

fn decode_store(bytes: &[u8], user_id: &str) -> Result<(TaskStore, bool), ApiError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::internal("Saved task storage is unreadable; data was preserved"))?;
    let mut needs_storage_migration = false;
    if let Some(tasks) = value.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        for task in tasks {
            let child = task.get("childSessionId").filter(|value| !value.is_null());
            if let Some(child) = child {
                let valid_child = child
                    .as_str()
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .is_some_and(|id| !id.is_nil());
                if !valid_child {
                    return Err(ApiError::internal(
                        "Saved task storage is unreadable; data was preserved",
                    ));
                }
                if let Some(encoded) = task.get("id").and_then(|value| value.as_object()) {
                    let id = encoded.get("value").and_then(|value| value.as_str());
                    let valid_id = id
                        .and_then(|value| Uuid::parse_str(value).ok())
                        .is_some_and(|id| !id.is_nil());
                    if encoded.len() != 2
                        || encoded
                            .get("delegationFormat")
                            .and_then(|value| value.as_u64())
                            != Some(1)
                        || !valid_id
                    {
                        return Err(ApiError::internal(
                            "Saved task storage is unreadable; data was preserved",
                        ));
                    }
                    let id = id.unwrap().to_owned();
                    task["id"] = id.into();
                } else if task.get("id").and_then(|value| value.as_str()).is_some() {
                    needs_storage_migration = true;
                } else {
                    return Err(ApiError::internal(
                        "Saved task storage is unreadable; data was preserved",
                    ));
                }
            }
        }
    }
    if let Some(schedules) = value.get_mut("schedules").and_then(|v| v.as_array_mut()) {
        for schedule in schedules {
            if schedule.get("intervalSeconds").is_some_and(|v| v.is_u64())
                && (schedule.get("at").is_some_and(|v| !v.is_null())
                    || schedule.get("runOnceAt").is_some_and(|v| !v.is_null()))
            {
                needs_storage_migration = true;
            }
            if let Some(encoded) = schedule.get("intervalSeconds").and_then(|v| v.as_object()) {
                let seconds = encoded.get("seconds").and_then(|v| v.as_u64());
                let advanced = schedule.get("at").is_some_and(|v| !v.is_null())
                    || schedule.get("runOnceAt").is_some_and(|v| !v.is_null());
                if encoded.len() != 2
                    || encoded.get("advancedFormat").and_then(|v| v.as_u64()) != Some(1)
                    || seconds.is_none()
                    || !advanced
                {
                    return Err(ApiError::internal(
                        "Saved task storage is unreadable; data was preserved",
                    ));
                }
                schedule["intervalSeconds"] = seconds.unwrap().into();
            }
        }
    }
    let store: TaskStore = serde_json::from_value(value)
        .map_err(|_| ApiError::internal("Saved task storage is unreadable; data was preserved"))?;
    if store.owner_id != user_id
        || store.tasks.len() > TASK_LIMIT
        || store.schedules.len() > SCHEDULE_LIMIT
    {
        return Err(ApiError::internal(
            "Saved task storage owner or bounds are invalid",
        ));
    }
    if store
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::DelegationHeld && task.child_session_id.is_none())
    {
        return Err(ApiError::internal(
            "Saved task storage is unreadable; data was preserved",
        ));
    }
    Ok((store, needs_storage_migration))
}

pub(crate) async fn read_owner_schedules(
    data_dir: PathBuf,
    owner: String,
) -> Result<Vec<ScheduleRecord>, String> {
    tokio::task::spawn_blocking(move || read_owner_schedules_sync(&data_dir, &owner))
        .await
        .map_err(|_| "Schedule storage is unavailable".to_string())?
}

#[cfg(unix)]
fn read_owner_schedules_sync(
    data_dir: &FsPath,
    owner: &str,
) -> Result<Vec<ScheduleRecord>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let unavailable = || "Schedule storage is unavailable or busy".to_string();
    let _local = STORE_LOCK.try_lock().map_err(|_| unavailable())?;
    let root = match data_dir.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(unavailable()),
    };
    let root_file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&root)
        .map_err(|_| unavailable())?;
    let safe_owner = |metadata: &std::fs::Metadata| {
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o022 == 0
    };
    let root_opened = root_file.metadata().map_err(|_| unavailable())?;
    let root_current = std::fs::symlink_metadata(&root).map_err(|_| unavailable())?;
    if !safe_owner(&root_opened)
        || !safe_owner(&root_current)
        || !root_current.is_dir()
        || root_current.file_type().is_symlink()
        || (root_opened.dev(), root_opened.ino()) != (root_current.dev(), root_current.ino())
        || data_dir.canonicalize().ok().as_ref() != Some(&root)
    {
        return Err(unavailable());
    }
    let directory = root.join("workspace-tasks");
    let directory_meta = match std::fs::symlink_metadata(&directory) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        _ => return Err(unavailable()),
    };
    let directory_file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&directory)
        .map_err(|_| unavailable())?;
    let same_directory = || -> Result<bool, String> {
        let opened_root = root_file.metadata().map_err(|_| unavailable())?;
        let current_root = std::fs::symlink_metadata(&root).map_err(|_| unavailable())?;
        let opened = directory_file.metadata().map_err(|_| unavailable())?;
        let current = std::fs::symlink_metadata(&directory).map_err(|_| unavailable())?;
        Ok(data_dir.canonicalize().ok().as_ref() == Some(&root)
            && safe_owner(&opened_root)
            && safe_owner(&current_root)
            && current_root.is_dir()
            && !current_root.file_type().is_symlink()
            && (current_root.dev(), current_root.ino()) == (opened_root.dev(), opened_root.ino())
            && current.is_dir()
            && safe_owner(&opened)
            && safe_owner(&current)
            && !current.file_type().is_symlink()
            && (current.dev(), current.ino()) == (opened.dev(), opened.ino())
            && (current.dev(), current.ino()) == (directory_meta.dev(), directory_meta.ino()))
    };
    if !same_directory()? {
        return Err(unavailable());
    }
    let lock_path = directory.join("store.lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&lock_path)
        .map_err(|_| unavailable())?;
    let same_lock = || -> Result<bool, String> {
        let opened = lock.metadata().map_err(|_| unavailable())?;
        let current = std::fs::symlink_metadata(&lock_path).map_err(|_| unavailable())?;
        Ok(opened.is_file()
            && safe_owner(&opened)
            && safe_owner(&current)
            && opened.nlink() == 1
            && current.is_file()
            && !current.file_type().is_symlink()
            && (current.dev(), current.ino()) == (opened.dev(), opened.ino()))
    };
    if !same_lock()? {
        return Err(unavailable());
    }
    lock.try_lock().map_err(|_| unavailable())?;
    if !same_directory()? || !same_lock()? {
        return Err(unavailable());
    }
    let path = store_path(&root, owner);
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !path.is_symlink() => {
            if !same_directory()? || !same_lock()? {
                return Err(unavailable());
            }
            return Ok(Vec::new());
        }
        Err(_) => return Err(unavailable()),
    };
    let opened = file.metadata().map_err(|_| unavailable())?;
    if !opened.is_file()
        || !safe_owner(&opened)
        || opened.nlink() != 1
        || opened.len() > 32 * 1024 * 1024
    {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(unavailable());
    }
    let after = file.metadata().map_err(|_| unavailable())?;
    let current = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    if !current.is_file()
        || !safe_owner(&after)
        || !safe_owner(&current)
        || after.nlink() != 1
        || current.nlink() != 1
        || current.file_type().is_symlink()
        || (current.dev(), current.ino()) != (opened.dev(), opened.ino())
        || (
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ) != (
            opened.len(),
            opened.mtime(),
            opened.mtime_nsec(),
            opened.ctime(),
            opened.ctime_nsec(),
        )
        || !same_directory()?
        || !same_lock()?
    {
        return Err(unavailable());
    }
    let (store, _) = decode_store(&bytes, owner).map_err(|_| unavailable())?;
    Ok(with_last_outcomes(store.schedules, &store.tasks))
}

#[cfg(not(unix))]
fn read_owner_schedules_sync(
    _data_dir: &FsPath,
    _owner: &str,
) -> Result<Vec<ScheduleRecord>, String> {
    Err("Read-only schedule listing is unavailable on this platform".into())
}

#[cfg(all(test, unix))]
mod read_only_schedule_tests {
    use super::*;

    async fn read_when_available(data: PathBuf, owner: String) -> Vec<ScheduleRecord> {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match read_owner_schedules(data.clone(), owner.clone()).await {
                    Err(error) if error == "Schedule storage is unavailable or busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    Ok(schedules) => break schedules,
                    Err(error) => panic!("Schedule read failed: {error}"),
                }
            }
        })
        .await
        .expect("schedule storage remained busy")
    }

    fn fixture(root: &FsPath, owner: &str) -> TaskStore {
        TaskStore {
            owner_id: owner.into(),
            tasks: vec![],
            schedules: vec![ScheduleRecord {
                id: Uuid::new_v4(),
                name: "Fixture".into(),
                input: TaskInput {
                    workspace_path: root.to_string_lossy().into_owned(),
                    provider: "deepseek".into(),
                    prompt: "Review".into(),
                    model: None,
                    parent_session_id: Some("ss-fixture".into()),
                    parent_task_id: None,
                },
                interval_seconds: 0,
                at: None,
                run_once_at: Some(100),
                enabled: true,
                next_run_at: Some(100),
                last_run_at: None,
                last_task_id: None,
                created_at: 1,
                missed_runs: 0,
                last_missed_at: None,
                skill: None,
                last_status: None,
                last_error: None,
                deliver_to: None,
            }],
        }
    }

    #[tokio::test]
    async fn listing_reads_only_owned_schedules_without_mutating_legacy_storage() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        let store = fixture(&data, "owner");
        let path = store_path(&data, "owner");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = serde_json::to_vec(&store).unwrap();
        std::fs::write(&path, &legacy).unwrap();
        drop(store_file_lock(&data).unwrap());
        let schedules = read_when_available(data.clone(), "owner".into()).await;
        assert_eq!(
            serde_json::to_value(schedules).unwrap(),
            serde_json::to_value(&store.schedules).unwrap()
        );
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert!(read_when_available(data, "other-owner".into())
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn listing_missing_store_creates_nothing_and_rejects_unsafe_or_locked_storage() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        assert!(read_when_available(data.clone(), "owner".into())
            .await
            .is_empty());
        assert!(!data.join("workspace-tasks").exists());
        let store = fixture(&data, "owner");
        write_store(&data, &store).unwrap();
        assert!(read_owner_schedules(data.clone(), "owner".into())
            .await
            .is_err());
        let lock = store_file_lock(&data).unwrap();
        assert!(read_owner_schedules(data.clone(), "owner".into())
            .await
            .is_err());
        drop(lock);
        let path = store_path(&data, "owner");
        std::fs::remove_file(&path).unwrap();
        symlink(data.join("nonexistent"), &path).unwrap();
        assert!(read_owner_schedules(data, "owner".into()).await.is_err());
    }

    #[tokio::test]
    async fn listing_preserves_corrupt_and_foreign_storage() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        let path = store_path(&data, "owner");
        drop(store_file_lock(&data).unwrap());
        for bytes in [
            b"{invalid".to_vec(),
            serde_json::to_vec(&fixture(&data, "foreign")).unwrap(),
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(read_owner_schedules(data.clone(), "owner".into())
                .await
                .is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn listing_rejects_replaced_lock_and_hardlinked_store() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        write_store(&data, &fixture(&data, "owner")).unwrap();
        drop(store_file_lock(&data).unwrap());
        let path = store_path(&data, "owner");
        let before = std::fs::read(&path).unwrap();
        let alias = data.join("store-alias");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(read_owner_schedules(data.clone(), "owner".into())
            .await
            .is_err());
        std::fs::remove_file(alias).unwrap();
        let lock = data.join("workspace-tasks/store.lock");
        std::fs::remove_file(&lock).unwrap();
        symlink(&path, &lock).unwrap();
        assert!(read_owner_schedules(data, "owner".into()).await.is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[tokio::test]
    async fn listing_rejects_group_or_world_writable_storage() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        write_store(&data, &fixture(&data, "owner")).unwrap();
        drop(store_file_lock(&data).unwrap());
        let directory = data.join("workspace-tasks");
        let lock = directory.join("store.lock");
        let store = store_path(&data, "owner");
        let before = std::fs::read(&store).unwrap();
        for path in [&data, &directory, &lock, &store] {
            let previous = std::fs::metadata(path).unwrap().permissions();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777)).unwrap();
            let result = read_owner_schedules(data.clone(), "owner".into()).await;
            std::fs::set_permissions(path, previous).unwrap();
            assert!(result.is_err(), "unsafe path: {}", path.display());
        }
        assert_eq!(std::fs::read(store).unwrap(), before);
    }

    #[test]
    fn schedule_lock_child_fixture() {
        use std::io::Read;
        let Some(root) = std::env::var_os("V4_TEST_SCHEDULE_READ_LOCK") else {
            return;
        };
        let root = PathBuf::from(root);
        let _lock = store_file_lock(&root).unwrap();
        std::fs::write(root.join("child-ready"), "ready").unwrap();
        let mut ignored = String::new();
        std::io::stdin().read_to_string(&mut ignored).unwrap();
    }

    #[tokio::test]
    async fn listing_refuses_a_lock_held_by_another_process_without_writing() {
        use std::process::{Command, Stdio};
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        write_store(&data, &fixture(&data, "owner")).unwrap();
        let path = store_path(&data, "owner");
        let before = std::fs::read(&path).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("workspace_tasks::read_only_schedule_tests::schedule_lock_child_fixture")
            .arg("--nocapture")
            .env("V4_TEST_SCHEDULE_READ_LOCK", &data)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let ready = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !data.join("child-ready").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        if ready.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Lock holder did not start");
        }
        let result = read_owner_schedules(data, "owner".into()).await;
        drop(child.stdin.take());
        let status = child.wait().unwrap();
        assert!(status.success());
        assert!(result.is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}

#[cfg(all(test, unix))]
mod reviewed_schedule_change_tests {
    use super::*;

    async fn commit_when_available(
        reviewed: ReviewedScheduleChange,
        expires_at: i64,
        cancelled: impl Fn() -> bool + Clone + Send + 'static,
    ) -> Result<serde_json::Value, String> {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match commit_reviewed_schedule_change(
                    reviewed.clone(),
                    expires_at,
                    cancelled.clone(),
                )
                .await
                {
                    Err(error) if error == "Schedule storage is unavailable or busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    other => break other,
                }
            }
        })
        .await
        .expect("schedule storage remained busy")
    }

    async fn fixture(data: &FsPath, workspace: &FsPath, enabled: bool) -> ScheduleRecord {
        create_owner_schedule(
            data.into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Inspect the project".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some("ss-parent".into()),
                    parent_task_id: None,
                },
                name: "Fixture".into(),
                interval_seconds: 60,
                enabled,
                at: None,
                run_once_at: None,
                deliver_to: None,
            },
        )
        .await
        .unwrap()
    }

    async fn review(
        data: &FsPath,
        workspace: &FsPath,
        id: Uuid,
        change: ScheduleChange,
    ) -> Result<ReviewedScheduleChange, String> {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match prepare_reviewed_schedule_change(
                    data.into(),
                    "owner".into(),
                    "ss-parent".into(),
                    "turn".into(),
                    workspace.to_string_lossy().into_owned(),
                    id,
                    change,
                )
                .await
                {
                    Err(error) if error == "Schedule storage is unavailable or busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    other => break other,
                }
            }
        })
        .await
        .expect("schedule storage remained busy")
    }

    #[tokio::test]
    async fn scoped_pause_resume_and_remove_preserve_unrelated_schedules() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let selected = fixture(data.path(), &workspace, true).await;
        let unrelated = fixture(data.path(), &workspace, false).await;
        assert!(prepare_reviewed_schedule_change(
            data.path().into(),
            "other".into(),
            "ss-parent".into(),
            "turn".into(),
            workspace.to_string_lossy().into_owned(),
            selected.id,
            ScheduleChange::Pause
        )
        .await
        .is_err());
        assert!(prepare_reviewed_schedule_change(
            data.path().into(),
            "owner".into(),
            "ss-foreign".into(),
            "turn".into(),
            workspace.to_string_lossy().into_owned(),
            selected.id,
            ScheduleChange::Pause
        )
        .await
        .is_err());
        let paused = commit_when_available(
            review(data.path(), &workspace, selected.id, ScheduleChange::Pause)
                .await
                .unwrap(),
            now_ms() as i64 + 60_000,
            || false,
        )
        .await
        .unwrap();
        assert_eq!(paused["schedule"]["enabled"], false);
        assert_eq!(paused["schedule"]["nextRunAt"], serde_json::Value::Null);
        let resumed = commit_when_available(
            review(data.path(), &workspace, selected.id, ScheduleChange::Resume)
                .await
                .unwrap(),
            now_ms() as i64 + 60_000,
            || false,
        )
        .await
        .unwrap();
        assert_eq!(resumed["schedule"]["enabled"], true);
        assert!(resumed["schedule"]["nextRunAt"].as_u64().unwrap() > now_ms());
        let removed = commit_when_available(
            review(data.path(), &workspace, selected.id, ScheduleChange::Remove)
                .await
                .unwrap(),
            now_ms() as i64 + 60_000,
            || false,
        )
        .await
        .unwrap();
        assert_eq!(
            removed,
            serde_json::json!({"removed":true,"id":selected.id})
        );
        let saved = read_store(data.path(), "owner").unwrap();
        assert_eq!(saved.schedules.len(), 1);
        assert_eq!(saved.schedules[0].id, unrelated.id);
    }

    #[tokio::test]
    async fn rejected_stale_cancelled_or_expired_reviews_leave_the_store_unchanged() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let selected = fixture(data.path(), &workspace, true).await;
        let path = store_path(data.path(), "owner");
        let before = std::fs::read(&path).unwrap();
        let cancelled = review(data.path(), &workspace, selected.id, ScheduleChange::Pause)
            .await
            .unwrap();
        assert!(
            commit_when_available(cancelled, now_ms() as i64 + 60_000, || true)
                .await
                .is_err()
        );
        let expired = review(data.path(), &workspace, selected.id, ScheduleChange::Pause)
            .await
            .unwrap();
        assert!(
            commit_when_available(expired, now_ms() as i64 - 1, || false)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let stale = review(data.path(), &workspace, selected.id, ScheduleChange::Pause)
            .await
            .unwrap();
        edit_store(data.path().into(), "owner".into(), move |store| {
            store
                .schedules
                .iter_mut()
                .find(|item| item.id == selected.id)
                .unwrap()
                .name = "Changed by user".into();
            Ok(())
        })
        .await
        .unwrap();
        let changed = std::fs::read(&path).unwrap();
        assert!(
            commit_when_available(stale, now_ms() as i64 + 60_000, || false)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), changed);
    }

    #[tokio::test]
    async fn reviewed_run_queues_once_and_removing_schedule_keeps_its_task() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let selected = fixture(data.path(), &workspace, false).await;
        let result = commit_when_available(
            review(data.path(), &workspace, selected.id, ScheduleChange::Run)
                .await
                .unwrap(),
            now_ms() as i64 + 60_000,
            || false,
        )
        .await
        .unwrap();
        assert_eq!(result["task"]["scheduleId"], serde_json::json!(selected.id));
        assert_eq!(result["task"]["status"], "queued");
        let again = review(data.path(), &workspace, selected.id, ScheduleChange::Run)
            .await
            .unwrap();
        assert!(
            commit_when_available(again, now_ms() as i64 + 60_000, || false)
                .await
                .is_err()
        );
        commit_when_available(
            review(data.path(), &workspace, selected.id, ScheduleChange::Remove)
                .await
                .unwrap(),
            now_ms() as i64 + 60_000,
            || false,
        )
        .await
        .unwrap();
        let store = read_store(data.path(), "owner").unwrap();
        assert!(store.schedules.is_empty());
        assert_eq!(store.tasks.len(), 1);
        assert_eq!(store.tasks[0].schedule_id, Some(selected.id));
    }

    #[tokio::test]
    async fn invalid_calendar_does_not_resume_or_queue_a_task() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let selected = fixture(data.path(), &workspace, false).await;
        edit_store(data.path().into(), "owner".into(), move |store| {
            let schedule = store
                .schedules
                .iter_mut()
                .find(|item| item.id == selected.id)
                .unwrap();
            schedule.at = Some(CalendarTime {
                hour: 9,
                minute: 0,
                weekdays: vec![1],
                utc_offset_minutes: 0,
                time_zone: Some("Invalid/Zone".into()),
                cron: None,
            });
            Ok(())
        })
        .await
        .unwrap();
        let before = std::fs::read(store_path(data.path(), "owner")).unwrap();
        for action in [ScheduleChange::Resume, ScheduleChange::Run] {
            assert!(review(data.path(), &workspace, selected.id, action)
                .await
                .is_err());
        }
        assert_eq!(
            std::fs::read(store_path(data.path(), "owner")).unwrap(),
            before
        );
    }
}

fn write_store(data_dir: &FsPath, store: &TaskStore) -> Result<(), ApiError> {
    use std::io::Write;
    let path = store_path(data_dir, &store.owner_id);
    let directory = path.parent().unwrap();
    std::fs::create_dir_all(directory).map_err(|_| ApiError::internal("Unable to save tasks"))?;
    let mut value =
        serde_json::to_value(store).map_err(|_| ApiError::internal("Unable to serialize tasks"))?;
    for (saved, task) in value["tasks"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(&store.tasks)
    {
        if task.child_session_id.is_some() {
            saved["id"] =
                serde_json::json!({ "delegationFormat": 1, "value": task.id.to_string() });
        }
    }
    for (saved, schedule) in value["schedules"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(&store.schedules)
    {
        if schedule.at.is_some() || schedule.run_once_at.is_some() {
            saved["intervalSeconds"] =
                serde_json::json!({ "advancedFormat": 1, "seconds": schedule.interval_seconds });
        }
    }
    let bytes =
        serde_json::to_vec(&value).map_err(|_| ApiError::internal("Unable to serialize tasks"))?;
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
        .persist(&path)
        .map_err(|_| ApiError::internal("Unable to replace saved tasks"))?;
    #[cfg(unix)]
    std::fs::File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ApiError::internal("Unable to sync saved tasks"))?;
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
        child_session_id: None,
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
        delivery: DeliveryState::default(),
        events: vec![TaskEvent {
            at: now,
            status: TaskStatus::Queued,
            message: "Task intent saved and queued".into(),
        }],
    };
    store.tasks.push(record.clone());
    Ok(record)
}

impl ScheduleRecord {
    fn next_after(&self, now: u64) -> u64 {
        match &self.at {
            Some(at) => next_calendar_run(now, at),
            None => now.saturating_add(self.interval_seconds.saturating_mul(1000)),
        }
    }
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
        let next = schedule.next_after(now);
        let one_shot = schedule.run_once_at.is_some();
        let target = schedule.deliver_to;
        if store
            .tasks
            .iter()
            .any(|task| task.schedule_id == Some(id) && !task.status.terminal())
        {
            if !one_shot {
                store.schedules[index].next_run_at = Some(next);
            }
            continue;
        }
        if let Ok(task) = enqueue(store, input, Some(id), now) {
            delivery::mark_for_delivery(store, task.id, target);
            store.schedules[index].enabled = !one_shot;
            store.schedules[index].next_run_at = (!one_shot).then_some(next);
            store.schedules[index].last_run_at = Some(now);
            store.schedules[index].last_task_id = Some(task.id);
        }
    }
}

const MIN_GRACE_MS: u64 = 120_000;
const MAX_GRACE_MS: u64 = 7_200_000;

fn missed_run_grace_ms(schedule: &ScheduleRecord) -> u64 {
    if schedule.at.is_some() || schedule.run_once_at.is_some() {
        return MAX_GRACE_MS;
    }
    schedule
        .interval_seconds
        .saturating_mul(500)
        .clamp(MIN_GRACE_MS, MAX_GRACE_MS)
}

fn skip_stale_runs(store: &mut TaskStore, now: u64) {
    for index in 0..store.schedules.len() {
        let schedule = &store.schedules[index];
        let Some(due) = schedule.next_run_at.filter(|_| schedule.enabled) else {
            continue;
        };
        if now.saturating_sub(due) <= missed_run_grace_ms(schedule)
            || store
                .tasks
                .iter()
                .any(|task| task.schedule_id == Some(schedule.id) && !task.status.terminal())
        {
            continue;
        }
        let skipped = if schedule.at.is_none() && schedule.run_once_at.is_none() {
            (now - due) / schedule.interval_seconds.max(1).saturating_mul(1000) + 1
        } else {
            1
        };
        let next = schedule.next_after(now);
        let one_shot = schedule.run_once_at.is_some();
        let schedule = &mut store.schedules[index];
        schedule.missed_runs = schedule.missed_runs.saturating_add(skipped);
        schedule.last_missed_at = Some(now);
        schedule.enabled = !one_shot;
        schedule.next_run_at = (!one_shot).then_some(next);
    }
}

fn recover_interrupted(store: &mut TaskStore, now: u64) {
    for task in &mut store.tasks {
        if task.child_session_id.is_none()
            && matches!(task.status, TaskStatus::Running | TaskStatus::Cancelling)
        {
            task.error = Some("The server restarted before the task result was recorded. It may have completed or been interrupted; review its changes before running it again.".into());
            transition(
                task,
                TaskStatus::Interrupted,
                "Task outcome unknown after app restart",
                now,
            );
        }
    }
}

fn cancel_record(record: &mut TaskRecord, now: u64) {
    match record.status {
        TaskStatus::DelegationHeld => transition(
            record,
            TaskStatus::Cancelled,
            "Held delegation cancelled",
            now,
        ),
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

    #[tokio::test]
    async fn held_delegation_task_is_persisted_but_not_claimed_by_regular_worker() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut task_input = input();
        task_input.workspace_path = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        task_input.provider = "deepseek".into();
        task_input.model = Some("fixture-model".into());
        task_input.parent_session_id = Some(format!("ss-{}", Uuid::new_v4().simple()));
        let id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let task = admit_held_delegation(
            dir.path().to_path_buf(),
            "owner".into(),
            task_input,
            id,
            child_id,
        )
        .await
        .unwrap();
        assert_eq!(
            (task.id, task.status, task.child_session_id),
            (id, TaskStatus::DelegationHeld, Some(child_id))
        );
        assert!(claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .is_empty());
        let stored = read_store(dir.path(), "owner").unwrap().tasks.remove(0);
        assert_eq!(
            (stored.status, stored.child_session_id),
            (TaskStatus::DelegationHeld, Some(child_id))
        );

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(dead_code)]
        struct PreviousStore {
            tasks: Vec<PreviousTask>,
        }
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct PreviousTask {
            status: PreviousStatus,
        }
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum PreviousStatus {
            Queued,
            Running,
            Cancelling,
            Completed,
            Failed,
            Cancelled,
            Interrupted,
        }
        let bytes = std::fs::read(store_path(dir.path(), "owner")).unwrap();
        assert!(serde_json::from_slice::<PreviousStore>(&bytes).is_err());
    }

    #[test]
    fn delegated_task_storage_keeps_identity_and_rejects_old_readers_in_every_state() {
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct PreviousStore {
            tasks: Vec<PreviousTask>,
        }
        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct PreviousTask {
            id: Uuid,
        }

        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let mut task = enqueue(&mut store, input(), None, 1).unwrap();
        let child_id = Uuid::new_v4();
        task.child_session_id = Some(child_id);
        for status in [
            TaskStatus::DelegationHeld,
            TaskStatus::Queued,
            TaskStatus::Running,
            TaskStatus::Cancelling,
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
            TaskStatus::Interrupted,
        ] {
            task.status = status.clone();
            store.tasks = vec![task.clone()];
            write_store(dir.path(), &store).unwrap();
            let bytes = std::fs::read(store_path(dir.path(), "owner")).unwrap();
            assert!(serde_json::from_slice::<PreviousStore>(&bytes).is_err());
            let loaded = read_store(dir.path(), "owner").unwrap().tasks.remove(0);
            assert_eq!(
                (loaded.id, loaded.status, loaded.child_session_id),
                (task.id, status, Some(child_id))
            );
        }
        task.child_session_id = None;
        task.status = TaskStatus::Running;
        store.tasks = vec![task];
        write_store(dir.path(), &store).unwrap();
        assert!(serde_json::from_slice::<PreviousStore>(
            &std::fs::read(store_path(dir.path(), "owner")).unwrap()
        )
        .is_ok());
    }

    #[test]
    fn early_delegation_records_migrate_and_invalid_markers_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let mut task = enqueue(&mut store, input(), None, 1).unwrap();
        task.child_session_id = Some(Uuid::new_v4());
        task.status = TaskStatus::Running;
        store.tasks = vec![task.clone()];
        write_store(dir.path(), &store).unwrap();
        let path = store_path(dir.path(), "owner");
        let mut old: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        old["tasks"][0]["id"] = task.id.to_string().into();
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        let loaded = read_store(dir.path(), "owner").unwrap();
        assert_eq!(loaded.tasks[0].child_session_id, task.child_session_id);
        let migrated: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(migrated["tasks"][0]["id"]["delegationFormat"], 1);

        for bad in [serde_json::json!(2), serde_json::json!(null)] {
            let mut invalid = migrated.clone();
            invalid["tasks"][0]["id"]["delegationFormat"] = bad;
            let bytes = serde_json::to_vec(&invalid).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            assert!(read_store(dir.path(), "owner").is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn mismatched_delegation_receipt_does_not_replace_child_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let mut task = enqueue(&mut store, input(), None, 1).unwrap();
        task.child_session_id = Some(Uuid::new_v4());
        task.status = TaskStatus::Running;
        store.tasks = vec![task.clone()];
        write_store(dir.path(), &store).unwrap();
        let saved = std::fs::read(store_path(dir.path(), "owner")).unwrap();
        let mut completed = task.clone();
        completed.status = TaskStatus::Completed;
        let mut wrong_child = completed.clone();
        wrong_child.child_session_id = Some(Uuid::new_v4());
        let mut wrong_prompt = completed.clone();
        wrong_prompt.input.prompt = "Different request".into();
        let mut wrong_creation = completed.clone();
        wrong_creation.created_at += 1;
        for receipt in [wrong_child, wrong_prompt, wrong_creation] {
            retain_completion(dir.path(), "owner", receipt).unwrap();
            assert!(read_store(dir.path(), "owner").is_err());
            assert_eq!(
                std::fs::read(store_path(dir.path(), "owner")).unwrap(),
                saved
            );
        }
        retain_completion(dir.path(), "owner", completed).unwrap();
        let recovered = read_store(dir.path(), "owner").unwrap().tasks.remove(0);
        assert_eq!(
            (recovered.status, recovered.child_session_id),
            (TaskStatus::Completed, task.child_session_id)
        );
    }

    #[test]
    fn named_zone_skips_dst_gaps_and_runs_only_the_first_fold() {
        let gap: CalendarTime = serde_json::from_value(serde_json::json!({
            "hour": 2, "minute": 30, "weekdays": [0], "utcOffsetMinutes": 0, "timeZone": "America/New_York"
        })).unwrap();
        let fold: CalendarTime = serde_json::from_value(serde_json::json!({
            "hour": 1, "minute": 30, "weekdays": [0], "utcOffsetMinutes": 0, "timeZone": "America/New_York"
        })).unwrap();
        assert_eq!(
            next_calendar_run(1_741_500_000_000, &gap),
            1_742_106_600_000
        );
        assert_eq!(
            next_calendar_run(1_762_056_000_000, &fold),
            1_762_061_400_000
        );
        assert_eq!(
            next_calendar_run(1_762_061_400_000, &fold),
            1_762_669_800_000
        );
    }

    #[test]
    fn one_shot_waits_for_enqueue_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut store = TaskStore {
            owner_id: "one-shot-owner".into(),
            ..Default::default()
        };
        let mut value = serde_json::to_value(ScheduleRecord {
            id,
            name: "Once".into(),
            input: input(),
            interval_seconds: 60,
            at: None,
            run_once_at: None,
            enabled: true,
            next_run_at: Some(1),
            last_run_at: None,
            last_task_id: None,
            created_at: 0,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
            deliver_to: None,
        })
        .unwrap();
        value["runOnceAt"] = 1.into();
        store.schedules.push(serde_json::from_value(value).unwrap());
        for _ in 0..TASK_LIMIT {
            enqueue(&mut store, input(), None, 0).unwrap();
        }
        queue_due_schedules(&mut store, 2, |_| true);
        assert_eq!(store.schedules[0].next_run_at, Some(1));
        write_store(dir.path(), &store).unwrap();
        let mut store = read_store(dir.path(), "one-shot-owner").unwrap();
        store.tasks.pop();
        store.tasks[0].schedule_id = Some(id);
        queue_due_schedules(&mut store, 3, |_| true);
        assert_eq!(store.schedules[0].next_run_at, Some(1));
        store.tasks[0].schedule_id = None;
        queue_due_schedules(&mut store, 3, |_| false);
        assert_eq!(store.schedules[0].next_run_at, Some(1));
        queue_due_schedules(&mut store, 3, |_| true);
        assert_eq!(
            (store.schedules[0].enabled, store.schedules[0].next_run_at),
            (false, None)
        );
        write_store(dir.path(), &store).unwrap();
        let mut store = read_store(dir.path(), "one-shot-owner").unwrap();
        queue_due_schedules(&mut store, 4, |_| true);
        assert_eq!(
            store
                .tasks
                .iter()
                .filter(|task| task.schedule_id == Some(id))
                .count(),
            1
        );
        assert!(read_store(dir.path(), "another-owner")
            .unwrap()
            .schedules
            .is_empty());
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
    fn calendar_schedules_run_at_the_chosen_local_time_on_chosen_weekdays() {
        // Monday 6 January 2025, 08:00 UTC.
        let monday_8am_utc = 1_736_150_400_000u64;
        let weekdays_9am_utc = CalendarTime {
            hour: 9,
            minute: 0,
            weekdays: vec![1, 2, 3, 4, 5],
            utc_offset_minutes: 0,
            time_zone: None,
            cron: None,
        };
        let sunday_only = CalendarTime {
            hour: 9,
            minute: 0,
            weekdays: vec![0],
            utc_offset_minutes: 0,
            time_zone: None,
            cron: None,
        };
        let tokyo_9am = CalendarTime {
            hour: 9,
            minute: 0,
            weekdays: vec![2],
            utc_offset_minutes: 540,
            time_zone: None,
            cron: None,
        };
        let hour = 3_600_000u64;
        let day = 24 * hour;
        assert_eq!(
            [
                next_calendar_run(monday_8am_utc, &weekdays_9am_utc),
                next_calendar_run(monday_8am_utc + 2 * hour, &weekdays_9am_utc),
                next_calendar_run(monday_8am_utc, &sunday_only),
                next_calendar_run(monday_8am_utc, &tokyo_9am),
            ],
            [
                monday_8am_utc + hour,
                monday_8am_utc + day + hour,
                monday_8am_utc + 6 * day + hour,
                monday_8am_utc + day - 8 * hour + 0,
            ]
        );
        assert!(validate_calendar(&CalendarTime {
            hour: 24,
            ..weekdays_9am_utc.clone()
        })
        .is_err());
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
            at: None,
            run_once_at: None,
            enabled: true,
            next_run_at: Some(1),
            last_run_at: None,
            last_task_id: None,
            created_at: 1,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
            deliver_to: None,
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
    fn worker_takeover_does_not_interrupt_supervised_delegated_children() {
        let data = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let ordinary = enqueue(&mut store, input(), None, 1).unwrap();
        store.tasks[0].status = TaskStatus::Running;
        let delegated = enqueue(&mut store, input(), None, 2).unwrap();
        store.tasks[1].status = TaskStatus::Running;
        store.tasks[1].child_session_id = Some(Uuid::new_v4());
        let cancelling = enqueue(&mut store, input(), None, 3).unwrap();
        store.tasks[2].status = TaskStatus::Cancelling;
        store.tasks[2].child_session_id = Some(Uuid::new_v4());
        let queued_child = enqueue(&mut store, input(), None, 4).unwrap();
        store.tasks[3].child_session_id = Some(Uuid::new_v4());
        write_store(data.path(), &store).unwrap();
        assert!(claim_tasks(data.path(), true, &Default::default(), 1)
            .unwrap()
            .is_empty());
        let reloaded = read_store(data.path(), "owner").unwrap();
        assert_eq!(
            reloaded
                .tasks
                .iter()
                .map(|task| (task.id, task.status.clone()))
                .collect::<Vec<_>>(),
            vec![
                (ordinary.id, TaskStatus::Interrupted),
                (delegated.id, TaskStatus::Running),
                (cancelling.id, TaskStatus::Cancelling),
                (queued_child.id, TaskStatus::Queued),
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delegated_restart_recovery_requires_authorization_at_commit() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = data.path().canonicalize().unwrap();
        let mut request = input();
        request.workspace_path = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into();
        request.provider = "deepseek".into();
        request.model = Some("fixture".into());
        request.parent_session_id = Some(format!("ss-{}", Uuid::new_v4().simple()));
        let task = Uuid::new_v4();
        let child = Uuid::new_v4();
        admit_held_delegation(root.clone(), "owner".into(), request.clone(), task, child)
            .await
            .unwrap();
        launch_held_delegation(
            root.clone(),
            "owner".into(),
            task,
            child,
            request.clone(),
            || Ok(()),
        )
        .await
        .unwrap();
        let path = store_path(&root, "owner");
        let before = std::fs::read(&path).unwrap();
        assert!(interrupt_unlaunched_delegation(
            root.clone(),
            "owner".into(),
            task,
            child,
            request.clone(),
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(
            recover_unfinished_delegation(&root, "owner", task, child, &request, || Err::<(), _>(
                ApiError::internal("Recovery fenced")
            ))
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut store = read_store(&root, "owner").unwrap();
        store.tasks[0].status = TaskStatus::Queued;
        write_store(&root, &store).unwrap();
        let queued_bytes = std::fs::read(&path).unwrap();
        assert!(
            recover_unfinished_delegation(&root, "owner", task, child, &request, || Ok(()))
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), queued_bytes);
        store.tasks[0].status = TaskStatus::Running;
        write_store(&root, &store).unwrap();
        let saved = recover_unfinished_delegation(&root, "owner", task, child, &request, || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(
            (saved.status, saved.child_session_id),
            (TaskStatus::Interrupted, Some(child))
        );
    }

    #[test]
    fn restart_recovery_reports_unrecorded_outcomes_as_unknown() {
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        enqueue(&mut store, input(), None, 1).unwrap();
        store.tasks[0].status = TaskStatus::Running;
        recover_interrupted(&mut store, 2);
        assert_eq!(
            (
                &store.tasks[0].status,
                store.tasks[0].error.as_deref(),
                store.tasks[0].events.last().map(|event| event.message.as_str()),
            ),
            (
                &TaskStatus::Interrupted,
                Some("The server restarted before the task result was recorded. It may have completed or been interrupted; review its changes before running it again."),
                Some("Task outcome unknown after app restart"),
            )
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
            provider: "deepseek".into(),
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

    #[tokio::test]
    async fn store_transactions_serialize_between_processes() {
        if let Ok(path) = std::env::var("TASK_STORE_TEST_PATH") {
            let data_dir = PathBuf::from(path);
            for _ in 0..20 {
                let workspace_path = data_dir.to_string_lossy().into_owned();
                edit_store(data_dir.clone(), "owner".into(), move |store| {
                    enqueue(
                        store,
                        TaskInput {
                            workspace_path,
                            provider: "claude".into(),
                            prompt: "Review".into(),
                            model: None,
                            parent_session_id: None,
                            parent_task_id: None,
                        },
                        None,
                        1,
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
            }
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let child = || {
            std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "workspace_tasks::persisted_io_tests::store_transactions_serialize_between_processes", "--nocapture"])
            .env("TASK_STORE_TEST_PATH", dir.path()).spawn().unwrap()
        };
        let a = child();
        let b = child();
        assert!(a.wait_with_output().unwrap().status.success());
        assert!(b.wait_with_output().unwrap().status.success());
        assert_eq!(read_store(dir.path(), "owner").unwrap().tasks.len(), 40);
    }

    #[test]
    fn worker_lease_excludes_another_process_and_is_released() {
        if let Ok(path) = std::env::var("TASK_LOCK_TEST_PATH") {
            let acquired = worker_lease(FsPath::new(&path)).is_ok();
            assert_eq!(
                acquired,
                std::env::var("TASK_LOCK_TEST_EXPECT").unwrap() == "yes"
            );
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let lease = worker_lease(dir.path()).unwrap();
        let child = |expected| {
            std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "workspace_tasks::persisted_io_tests::worker_lease_excludes_another_process_and_is_released", "--nocapture"])
            .env("TASK_LOCK_TEST_PATH", dir.path()).env("TASK_LOCK_TEST_EXPECT", expected).output().unwrap()
        };
        let blocked = child("no");
        assert!(
            blocked.status.success(),
            "{}",
            String::from_utf8_lossy(&blocked.stdout)
        );
        drop(lease);
        let acquired = child("yes");
        assert!(
            acquired.status.success(),
            "{}",
            String::from_utf8_lossy(&acquired.stdout)
        );
    }

    // The exact pre-change store and schedule field types from HEAD; unknown fields
    // are accepted by serde, as in that version.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct OldSchedule {
        id: Uuid,
        name: String,
        #[serde(flatten)]
        input: TaskInput,
        interval_seconds: u64,
        enabled: bool,
        next_run_at: Option<u64>,
        last_run_at: Option<u64>,
        last_task_id: Option<Uuid>,
        created_at: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct OldStore {
        owner_id: String,
        tasks: Vec<TaskRecord>,
        schedules: Vec<OldSchedule>,
    }

    // HEAD a71bf926: ScheduleInput ignores unknown fields and validates this interval.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct OldScheduleInput {
        #[serde(flatten)]
        task: TaskInput,
        name: String,
        interval_seconds: u64,
        #[serde(default)]
        enabled: bool,
    }

    #[test]
    fn old_head_rejects_zero_interval_for_every_advanced_input() {
        for timing in [
            serde_json::json!({"runOnceAt": 2_051_222_400_000u64}),
            serde_json::json!({"at": {"hour": 9, "minute": 0, "weekdays": [1], "timeZone": "UTC"}}),
        ] {
            for enabled in [false, true] {
                let mut payload = serde_json::json!({"workspacePath":"/tmp", "provider":"claude", "prompt":"Review", "name":"Review", "intervalSeconds":0, "enabled":enabled});
                payload
                    .as_object_mut()
                    .unwrap()
                    .extend(timing.as_object().unwrap().clone());
                let old: OldScheduleInput = serde_json::from_value(payload).unwrap();
                assert!(!(60..=2_592_000).contains(&old.interval_seconds));
            }
        }
        assert!((60..=2_592_000).contains(&60));
        assert!((60..=2_592_000).contains(&2_592_000));
    }

    #[test]
    fn advanced_schedules_fail_closed_for_the_old_reader_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let input = TaskInput {
            workspace_path: dir.path().to_string_lossy().into_owned(),
            provider: "claude".into(),
            prompt: "Review".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        let base = ScheduleRecord {
            id: Uuid::new_v4(),
            name: "Advanced".into(),
            input,
            interval_seconds: 0,
            at: None,
            run_once_at: Some(1),
            enabled: true,
            next_run_at: Some(1),
            last_run_at: None,
            last_task_id: None,
            created_at: 0,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
            deliver_to: None,
        };
        for schedule in [
            base.clone(),
            ScheduleRecord {
                run_once_at: None,
                at: Some(CalendarTime {
                    hour: 9,
                    minute: 0,
                    weekdays: vec![1],
                    utc_offset_minutes: 0,
                    time_zone: Some("America/New_York".into()),
                    cron: None,
                }),
                interval_seconds: 60,
                ..base.clone()
            },
        ] {
            store.schedules = vec![schedule];
            write_store(dir.path(), &store).unwrap();
            let bytes = std::fs::read(store_path(dir.path(), "owner")).unwrap();
            assert!(serde_json::from_slice::<OldStore>(&bytes).is_err());
            let loaded = read_store(dir.path(), "owner").unwrap();
            assert_eq!(
                serde_json::to_value(&loaded.schedules).unwrap(),
                serde_json::to_value(&store.schedules).unwrap()
            );
        }
        store.schedules = vec![ScheduleRecord {
            run_once_at: None,
            interval_seconds: 60,
            ..base
        }];
        write_store(dir.path(), &store).unwrap();
        assert!(serde_json::from_slice::<OldStore>(
            &std::fs::read(store_path(dir.path(), "owner")).unwrap()
        )
        .is_ok());
    }

    #[test]
    fn reading_an_early_advanced_record_migrates_it_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path(), "owner");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = serde_json::json!({"ownerId":"owner", "tasks":[], "schedules":[{"id":Uuid::new_v4(), "name":"Once", "workspacePath":dir.path(), "provider":"claude", "prompt":"Review", "intervalSeconds":0, "runOnceAt":1, "enabled":true, "nextRunAt":1, "lastRunAt":null, "lastTaskId":null, "createdAt":0}]});
        let bytes = serde_json::to_vec(&record).unwrap();
        assert!(serde_json::from_slice::<OldStore>(&bytes).is_ok());
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            read_store(dir.path(), "owner").unwrap().schedules[0].run_once_at,
            Some(1)
        );
        assert!(serde_json::from_slice::<OldStore>(&std::fs::read(path).unwrap()).is_err());
    }

    #[test]
    fn unknown_advanced_storage_version_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = store_path(dir.path(), "owner");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = serde_json::json!({"ownerId":"owner", "tasks":[], "schedules":[{"intervalSeconds":{"advancedFormat":2,"seconds":0},"runOnceAt":1}]});
        let bytes = serde_json::to_vec(&record).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(read_store(dir.path(), "owner").is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
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

#[cfg(all(test, unix))]
mod delegation_terminal_lookup_tests {
    use super::*;

    #[tokio::test]
    async fn launch_claim_is_exact_and_running_is_durable_before_the_child_starts() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let task_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let input = TaskInput {
            workspace_path: data.to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: Some("fixture-model".into()),
            prompt: "Inspect".into(),
            parent_session_id: Some(format!("ss-{}", Uuid::new_v4().simple())),
            parent_task_id: None,
        };
        admit_held_delegation(
            data.clone(),
            "owner".into(),
            input.clone(),
            task_id,
            child_id,
        )
        .await
        .unwrap();
        let launches = Arc::new(AtomicUsize::new(0));
        for (owner, task, child, changed) in [
            ("other", task_id, child_id, false),
            ("owner", Uuid::new_v4(), child_id, false),
            ("owner", task_id, Uuid::new_v4(), false),
            ("owner", task_id, child_id, true),
        ] {
            let mut requested = input.clone();
            if changed {
                requested.prompt.push_str(" changed");
            }
            let count = Arc::clone(&launches);
            assert!(launch_held_delegation(
                data.clone(),
                owner.into(),
                task,
                child,
                requested,
                move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            )
            .await
            .is_err());
        }
        assert_eq!(launches.load(Ordering::SeqCst), 0);
        let data_for_launch = data.clone();
        let (record, launched) = launch_held_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input.clone(),
            move || {
                let bytes = std::fs::read(store_path(&data_for_launch, "owner")).unwrap();
                let (store, needs_migration) = decode_store(&bytes, "owner").unwrap();
                assert!(!needs_migration);
                assert_eq!(store.tasks[0].status, TaskStatus::Running);
                Ok("child accepted")
            },
        )
        .await
        .unwrap();
        assert_eq!(
            (record.status, launched),
            (TaskStatus::Running, "child accepted")
        );
        assert!(launch_held_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input,
            || Ok(())
        )
        .await
        .is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delegated_launch_serializes_cancellation_and_never_replays_failure() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let task_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let input = TaskInput {
            workspace_path: data.to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: Some("fixture-model".into()),
            prompt: "Inspect".into(),
            parent_session_id: Some(format!("ss-{}", Uuid::new_v4().simple())),
            parent_task_id: None,
        };
        admit_held_delegation(
            data.clone(),
            "owner".into(),
            input.clone(),
            task_id,
            child_id,
        )
        .await
        .unwrap();
        let (entered, wait_entered) = tokio::sync::oneshot::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let launch = tokio::spawn(launch_held_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input.clone(),
            move || {
                entered.send(()).unwrap();
                wait_release.recv().unwrap();
                Err::<(), _>(ApiError::internal("Synthetic launch failure"))
            },
        ));
        wait_entered.await.unwrap();
        let mut cancellation =
            tokio::spawn(edit_store(data.clone(), "owner".into(), move |store| {
                let task = store
                    .tasks
                    .iter_mut()
                    .find(|task| task.id == task_id)
                    .unwrap();
                cancel_record(task, now_ms());
                Ok(task.status.clone())
            }));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut cancellation)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert!(launch.await.unwrap().is_err());
        assert_eq!(
            cancellation.await.unwrap().unwrap(),
            TaskStatus::Interrupted
        );
        assert!(launch_held_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input,
            || Ok(())
        )
        .await
        .is_err());
        let saved = read_store(&data, "owner").unwrap();
        assert_eq!(saved.tasks[0].status, TaskStatus::Interrupted);
    }

    #[tokio::test]
    async fn cancelling_a_held_delegation_prevents_launch() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let task_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let input = TaskInput {
            workspace_path: data.to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: Some("fixture-model".into()),
            prompt: "Inspect".into(),
            parent_session_id: Some(format!("ss-{}", Uuid::new_v4().simple())),
            parent_task_id: None,
        };
        admit_held_delegation(
            data.clone(),
            "owner".into(),
            input.clone(),
            task_id,
            child_id,
        )
        .await
        .unwrap();
        edit_store(data.clone(), "owner".into(), move |store| {
            cancel_record(&mut store.tasks[0], now_ms());
            Ok(())
        })
        .await
        .unwrap();
        assert!(launch_held_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input,
            || -> Result<(), ApiError> { panic!("cancelled child must not start") }
        )
        .await
        .is_err());
        assert_eq!(
            read_store(&data, "owner").unwrap().tasks[0].status,
            TaskStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn delegated_settlement_preserves_exact_scope_and_honors_a_prior_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let task_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let input = TaskInput {
            workspace_path: data.to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: Some("fixture-model".into()),
            prompt: "Inspect".into(),
            parent_session_id: Some(format!("ss-{}", Uuid::new_v4().simple())),
            parent_task_id: None,
        };
        admit_held_delegation(
            data.clone(),
            "owner".into(),
            input.clone(),
            task_id,
            child_id,
        )
        .await
        .unwrap();
        launch_held_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input.clone(),
            || Ok(()),
        )
        .await
        .unwrap();
        let before = std::fs::read(store_path(&data, "owner")).unwrap();
        let redaction_expansion = "token=\n".repeat(9_000);
        assert!(redaction_expansion.len() <= OUTPUT_LIMIT);
        assert!(settle_running_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input.clone(),
            TaskStatus::Completed,
            redaction_expansion,
            Some(0)
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(store_path(&data, "owner")).unwrap(), before);
        let mut changed = input.clone();
        changed.prompt.push_str(" changed");
        for (owner, task, child, request) in [
            ("other", task_id, child_id, input.clone()),
            ("owner", Uuid::new_v4(), child_id, input.clone()),
            ("owner", task_id, Uuid::new_v4(), input.clone()),
            ("owner", task_id, child_id, changed),
        ] {
            assert!(settle_running_delegation(
                data.clone(),
                owner.into(),
                task,
                child,
                request,
                TaskStatus::Completed,
                "answer".into(),
                Some(0)
            )
            .await
            .is_err());
            assert_eq!(std::fs::read(store_path(&data, "owner")).unwrap(), before);
        }
        edit_store(data.clone(), "owner".into(), move |store| {
            cancel_record(&mut store.tasks[0], now_ms());
            Ok(())
        })
        .await
        .unwrap();
        let result = settle_running_delegation(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            input.clone(),
            TaskStatus::Completed,
            "answer".into(),
            Some(0),
        )
        .await
        .unwrap();
        assert_eq!(
            (result.status, result.result),
            (TaskStatus::Cancelled, String::new())
        );
        assert!(settle_running_delegation(
            data,
            "owner".into(),
            task_id,
            child_id,
            input,
            TaskStatus::Completed,
            "answer".into(),
            Some(0)
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn held_delegation_settlement_checks_scope_and_persists_terminal_result() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let task_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let input = TaskInput {
            workspace_path: data.to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: Some("fixture-model".into()),
            prompt: "Investigate the fixture".into(),
            parent_session_id: Some(format!("ss-{}", Uuid::new_v4().simple())),
            parent_task_id: None,
        };
        let held = admit_held_delegation(data.clone(), "owner".into(), input, task_id, child_id)
            .await
            .unwrap();
        let before = std::fs::read(store_path(&data, "owner")).unwrap();
        for (owner, task, child, status, output) in [
            (
                "foreign",
                task_id,
                child_id,
                TaskStatus::Completed,
                "ok".to_string(),
            ),
            (
                "owner",
                Uuid::new_v4(),
                child_id,
                TaskStatus::Completed,
                "ok".to_string(),
            ),
            (
                "owner",
                task_id,
                Uuid::new_v4(),
                TaskStatus::Completed,
                "ok".to_string(),
            ),
            (
                "owner",
                task_id,
                child_id,
                TaskStatus::Running,
                "ok".to_string(),
            ),
            (
                "owner",
                task_id,
                child_id,
                TaskStatus::Completed,
                "x".repeat(OUTPUT_LIMIT + 1),
            ),
        ] {
            assert!(settle_held_delegation_for_test(
                data.clone(),
                owner.into(),
                task,
                child,
                status,
                output,
                Some(0),
                None
            )
            .await
            .is_err());
            assert_eq!(std::fs::read(store_path(&data, "owner")).unwrap(), before);
        }
        let result = settle_held_delegation_for_test(
            data.clone(),
            "owner".into(),
            task_id,
            child_id,
            TaskStatus::Completed,
            "Verified result".into(),
            Some(0),
            None,
        )
        .await
        .unwrap();
        let saved = durable_delegation_terminal(data.clone(), "owner".into(), task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                saved.id,
                saved.child_session_id,
                saved.status,
                saved.result.as_str(),
                saved.exit_code
            ),
            (
                task_id,
                Some(child_id),
                TaskStatus::Completed,
                "Verified result",
                Some(0)
            )
        );
        assert_eq!(
            serde_json::to_value(&saved.input).unwrap(),
            serde_json::to_value(&held.input).unwrap()
        );
        assert_eq!(result.result, saved.result);
        assert!(settle_held_delegation_for_test(
            data,
            "owner".into(),
            task_id,
            child_id,
            TaskStatus::Failed,
            "replay".into(),
            Some(1),
            None
        )
        .await
        .is_err());
    }

    fn record(path: &FsPath) -> TaskRecord {
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        enqueue(
            &mut store,
            TaskInput {
                workspace_path: path.to_string_lossy().into_owned(),
                provider: "claude".into(),
                prompt: "Inspect the fixture".into(),
                model: None,
                parent_session_id: None,
                parent_task_id: None,
            },
            None,
            1,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn absent_store_does_not_create_files_and_existing_store_requires_lock() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), Uuid::new_v4())
                .await
                .unwrap()
                .is_none()
        );
        assert!(!data.join("workspace-tasks").exists());
        let task = record(&data);
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), task.id)
                .await
                .is_err()
        );
        assert!(!data.join("workspace-tasks/store.lock").exists());
    }

    #[tokio::test]
    async fn returns_only_owner_scoped_terminal_results_or_matching_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Running;
        let mut store = TaskStore {
            owner_id: "owner".into(),
            tasks: vec![task.clone()],
            schedules: vec![],
        };
        write_store(&data, &store).unwrap();
        drop(store_file_lock(&data).unwrap());
        assert!(
            durable_delegation_terminal(data.clone(), "other".into(), task.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), task.id)
                .await
                .unwrap()
                .is_none()
        );
        let mut result = task.clone();
        result.status = TaskStatus::Completed;
        result.result = "Saved result".into();
        retain_completion(&data, "owner", result.clone()).unwrap();
        let before = std::fs::read(store_path(&data, "owner")).unwrap();
        let loaded = durable_delegation_terminal(data.clone(), "owner".into(), task.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (loaded.id, loaded.status, loaded.result.as_str()),
            (task.id, TaskStatus::Completed, "Saved result")
        );
        assert_eq!(std::fs::read(store_path(&data, "owner")).unwrap(), before);
        store.tasks.clear();
        write_store(&data, &store).unwrap();
        assert!(durable_delegation_terminal(data, "owner".into(), task.id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rejects_corrupt_or_mismatched_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Running;
        task.child_session_id = Some(Uuid::new_v4());
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        drop(store_file_lock(&data).unwrap());
        let mut receipt = task.clone();
        receipt.status = TaskStatus::Completed;
        receipt.input.prompt = "Different intent".into();
        retain_completion(&data, "owner", receipt).unwrap();
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), task.id)
                .await
                .is_err()
        );
        let mut receipt = task.clone();
        receipt.status = TaskStatus::Completed;
        receipt.child_session_id = Some(Uuid::new_v4());
        retain_completion(&data, "owner", receipt).unwrap();
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), task.id)
                .await
                .is_err()
        );
        std::fs::write(receipt_path(&data, "owner", task.id), b"invalid receipt").unwrap();
        assert!(durable_delegation_terminal(data, "owner".into(), task.id)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn returns_saved_terminal_records_but_not_held_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::DelegationHeld;
        task.child_session_id = Some(Uuid::new_v4());
        let mut store = TaskStore {
            owner_id: "owner".into(),
            tasks: vec![task.clone()],
            schedules: vec![],
        };
        write_store(&data, &store).unwrap();
        drop(store_file_lock(&data).unwrap());
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), task.id)
                .await
                .unwrap()
                .is_none()
        );
        store.tasks[0].status = TaskStatus::Failed;
        store.tasks[0].error = Some("Synthetic failure".into());
        write_store(&data, &store).unwrap();
        let saved = durable_delegation_terminal(data, "owner".into(), task.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (saved.status, saved.error.as_deref()),
            (TaskStatus::Failed, Some("Synthetic failure"))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn waits_for_existing_store_lock_without_changing_the_store() {
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Completed;
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        let before = std::fs::read(store_path(&data, "owner")).unwrap();
        let held = store_file_lock(&data).unwrap();
        let lookup_data = data.clone();
        let mut lookup = tokio::spawn(async move {
            durable_delegation_terminal(lookup_data, "owner".into(), task.id).await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut lookup)
                .await
                .is_err()
        );
        drop(held);
        assert!(tokio::time::timeout(Duration::from_secs(5), lookup)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .is_some());
        assert_eq!(std::fs::read(store_path(&data, "owner")).unwrap(), before);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn terminal_callback_finishes_before_task_deletion() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Completed;
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        drop(store_file_lock(&data).unwrap());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let callback_data = data.clone();
        let task_id = task.id;
        let lookup = tokio::spawn(with_durable_delegation_terminal(
            callback_data,
            "owner".into(),
            task_id,
            move |saved| {
                entered_tx
                    .send(saved.id)
                    .map_err(|_| ApiError::internal("Test signal lost"))?;
                release_rx
                    .recv()
                    .map_err(|_| ApiError::internal("Test release lost"))?;
                Ok(saved.id)
            },
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap(),
            task_id
        );
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.join("workspace-tasks/store.lock"))
            .unwrap();
        assert!(
            probe.try_lock().is_err(),
            "callback must retain the cross-process lock"
        );
        let delete_data = data.clone();
        let mut deletion = tokio::spawn(edit_store(delete_data, "owner".into(), move |store| {
            store.tasks.retain(|item| item.id != task_id);
            Ok(())
        }));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut deletion)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        assert_eq!(lookup.await.unwrap().unwrap(), Some(task_id));
        deletion.await.unwrap().unwrap();
        assert!(durable_delegation_terminal(data, "owner".into(), task_id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn terminal_callback_is_skipped_for_missing_or_nonterminal_task() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let task = record(&data);
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        drop(store_file_lock(&data).unwrap());
        let callback =
            |_record: TaskRecord| -> Result<(), ApiError> { panic!("callback must not run") };
        assert!(
            with_durable_delegation_terminal(data.clone(), "owner".into(), task.id, callback)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            with_durable_delegation_terminal(data, "owner".into(), Uuid::new_v4(), callback)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn terminal_callback_failure_releases_locks_and_preserves_task() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Completed;
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        drop(store_file_lock(&data).unwrap());
        let before = std::fs::read(store_path(&data, "owner")).unwrap();
        let result: Result<Option<()>, ApiError> =
            with_durable_delegation_terminal(data.clone(), "owner".into(), task.id, |_| {
                Err(ApiError::internal("Synthetic staging failure"))
            })
            .await;
        assert_eq!(result.unwrap_err().message, "Synthetic staging failure");
        assert_eq!(std::fs::read(store_path(&data, "owner")).unwrap(), before);
        edit_store(data, "owner".into(), move |store| {
            store.tasks.clear();
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn rejects_legacy_advanced_store_without_migrating_it() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Completed;
        let path = store_path(&data, "owner");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = serde_json::json!({ "ownerId": "owner", "tasks": [task], "schedules": [{
            "id": Uuid::new_v4(), "name": "Once", "workspacePath": data.to_string_lossy(), "provider": "claude", "prompt": "Inspect",
            "intervalSeconds": 0, "runOnceAt": 1, "enabled": true, "nextRunAt": 1, "createdAt": 0
        }] });
        let bytes = serde_json::to_vec(&raw).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        drop(store_file_lock(&data).unwrap());
        let id = Uuid::parse_str(raw["tasks"][0]["id"].as_str().unwrap()).unwrap();
        assert!(durable_delegation_terminal(data, "owner".into(), id)
            .await
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlinked_lock_or_receipt() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Running;
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        drop(store_file_lock(&data).unwrap());
        let lock = data.join("workspace-tasks/store.lock");
        let real_lock = data.join("workspace-tasks/actual.lock");
        std::fs::rename(&lock, &real_lock).unwrap();
        symlink(&real_lock, &lock).unwrap();
        assert!(
            durable_delegation_terminal(data.clone(), "owner".into(), task.id)
                .await
                .is_err()
        );
        std::fs::remove_file(&lock).unwrap();
        std::fs::rename(&real_lock, &lock).unwrap();
        let receipt = receipt_path(&data, "owner", task.id);
        std::fs::create_dir_all(receipt.parent().unwrap()).unwrap();
        symlink(store_path(&data, "owner"), &receipt).unwrap();
        assert!(durable_delegation_terminal(data, "owner".into(), task.id)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejects_fifo_receipt_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let mut task = record(&data);
        task.status = TaskStatus::Running;
        write_store(
            &data,
            &TaskStore {
                owner_id: "owner".into(),
                tasks: vec![task.clone()],
                schedules: vec![],
            },
        )
        .unwrap();
        drop(store_file_lock(&data).unwrap());
        let receipt = receipt_path(&data, "owner", task.id);
        std::fs::create_dir_all(receipt.parent().unwrap()).unwrap();
        let c_path = CString::new(receipt.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let mut lookup = tokio::spawn(durable_delegation_terminal(data, "owner".into(), task.id));
        let result = tokio::time::timeout(Duration::from_secs(1), &mut lookup).await;
        if result.is_err() {
            let writer = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&receipt)
                .unwrap();
            drop(writer);
            let _ = lookup.await;
        }
        assert!(result.expect("FIFO lookup blocked").unwrap().is_err());
    }
}

fn lock_file(data_dir: &FsPath, name: &str) -> Result<std::fs::File, ApiError> {
    let directory = data_dir.join("workspace-tasks");
    std::fs::create_dir_all(&directory)
        .map_err(|_| ApiError::internal("Task storage unavailable"))?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(name))
        .map_err(|_| ApiError::internal("Task storage unavailable"))
}

fn store_file_lock(data_dir: &FsPath) -> Result<std::fs::File, ApiError> {
    let file = lock_file(data_dir, "store.lock")?;
    file.lock()
        .map_err(|_| ApiError::internal("Task storage unavailable"))?;
    Ok(file)
}

#[cfg(test)]
pub(crate) async fn durable_delegation_terminal(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
) -> Result<Option<TaskRecord>, ApiError> {
    with_durable_delegation_terminal(data_dir, owner, task_id, Ok).await
}

#[cfg(any(test, unix))]
/// The callback runs while the task mutex and file lock are held. It must not
/// re-enter task storage. Callers must await it once started: dropping the
/// future does not cancel its blocking storage operation.
pub(crate) async fn with_durable_delegation_terminal<T, F>(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
    callback: F,
) -> Result<Option<T>, ApiError>
where
    T: Send + 'static,
    F: FnOnce(TaskRecord) -> Result<T, ApiError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        durable_delegation_terminal_locked(&data_dir, &owner, task_id, callback)
    })
    .await
    .map_err(|_| ApiError::internal("Task result lookup failed"))?
}

#[cfg(unix)]
fn durable_delegation_terminal_locked<T>(
    data_dir: &FsPath,
    owner: &str,
    task_id: Uuid,
    callback: impl FnOnce(TaskRecord) -> Result<T, ApiError>,
) -> Result<Option<T>, ApiError> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let unavailable = || ApiError::internal("Saved task result is unavailable or ambiguous");
    let _guard = STORE_LOCK.lock().map_err(|_| unavailable())?;
    match data_dir.canonicalize() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(canonical) if canonical == data_dir => {}
        _ => return Err(unavailable()),
    }
    let directory = data_dir.join("workspace-tasks");
    match std::fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(meta) if meta.file_type().is_dir() => {}
        _ => return Err(unavailable()),
    }
    let path = store_path(data_dir, owner);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(meta) if meta.file_type().is_file() => {}
        _ => return Err(unavailable()),
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join("store.lock"))
        .map_err(|_| unavailable())?;
    if !lock.metadata().map_err(|_| unavailable())?.is_file() {
        return Err(unavailable());
    }
    lock.lock().map_err(|_| unavailable())?;
    let read_existing =
        |path: &FsPath, limit: u64, sync_file: bool| -> Result<Option<Vec<u8>>, ApiError> {
            let mut file = match std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(unavailable()),
            };
            let meta = file.metadata().map_err(|_| unavailable())?;
            if !meta.is_file() || meta.len() > limit {
                return Err(unavailable());
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| unavailable())?;
            if bytes.len() as u64 > limit {
                return Err(unavailable());
            }
            if sync_file {
                file.sync_all().map_err(|_| unavailable())?;
            }
            Ok(Some(bytes))
        };
    let Some(bytes) = read_existing(&path, 32 * 1024 * 1024, false)? else {
        return Ok(None);
    };
    let (mut store, needs_migration) = decode_store(&bytes, owner).map_err(|_| unavailable())?;
    if needs_migration {
        return Err(unavailable());
    }
    let Some(task) = store.tasks.iter_mut().find(|task| task.id == task_id) else {
        return Ok(None);
    };
    let completion_dir = directory.join("completions");
    match std::fs::symlink_metadata(&completion_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(meta) if meta.file_type().is_dir() => {}
        _ => return Err(unavailable()),
    }
    if let Some(bytes) = read_existing(&receipt_path(data_dir, owner, task_id), 512 * 1024, true)? {
        let receipt: TaskRecord = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if receipt.id != task.id
            || receipt.child_session_id != task.child_session_id
            || !receipt.status.terminal()
            || receipt.created_at != task.created_at
            || receipt.schedule_id != task.schedule_id
            || receipt.input.workspace_path != task.input.workspace_path
            || receipt.input.provider != task.input.provider
            || receipt.input.prompt != task.input.prompt
            || receipt.input.model != task.input.model
            || receipt.input.parent_session_id != task.input.parent_session_id
            || receipt.input.parent_task_id != task.input.parent_task_id
            || !matches!(
                task.status,
                TaskStatus::Running
                    | TaskStatus::Cancelling
                    | TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Interrupted
            )
            || (task.status.terminal() && task.status != receipt.status)
        {
            return Err(unavailable());
        }
        std::fs::File::open(&completion_dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| unavailable())?;
        std::fs::File::open(&directory)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| unavailable())?;
        merge_completion(task, receipt);
    }
    if task.status.terminal() {
        callback(task.clone()).map(Some)
    } else {
        Ok(None)
    }
}

#[cfg(all(test, not(unix)))]
fn durable_delegation_terminal_locked<T>(
    _data_dir: &FsPath,
    _owner: &str,
    _task_id: Uuid,
    _callback: impl FnOnce(TaskRecord) -> Result<T, ApiError>,
) -> Result<Option<T>, ApiError> {
    Err(ApiError::internal(
        "Durable delegation lookup is unavailable on this platform",
    ))
}

fn worker_lease(data_dir: &FsPath) -> Result<std::fs::File, ApiError> {
    let file = lock_file(data_dir, "worker.lock")?;
    file.try_lock()
        .map_err(|_| ApiError::internal("Another task worker owns this data directory"))?;
    ensure_worker_protocol(data_dir)?;
    Ok(file)
}

static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static LAUNCH_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
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
        let _file_guard = store_file_lock(&data_dir)?;
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

#[cfg(any(test, unix))]
pub(crate) fn validate_held_delegation(input: &TaskInput, task_id: Uuid) -> Result<(), ApiError> {
    validate_task(input)?;
    let workspace = FsPath::new(&input.workspace_path);
    let parent = input
        .parent_session_id
        .as_deref()
        .and_then(|id| id.strip_prefix("ss-"));
    let parent_valid = parent
        .and_then(|value| Uuid::parse_str(value).ok().map(|id| (value, id)))
        .is_some_and(|(value, id)| !id.is_nil() && value == id.simple().to_string());
    if task_id.is_nil()
        || !crate::v4_agent::supports_tasks(&input.provider)
        || input.model.is_none()
        || input.parent_task_id.is_some()
        || !parent_valid
        || workspace.canonicalize().ok().as_deref() != Some(workspace)
    {
        return Err(ApiError::bad_request("Invalid held delegation scope"));
    }
    Ok(())
}

#[cfg(any(test, unix))]
pub(crate) async fn admit_held_delegation(
    data_dir: PathBuf,
    owner: String,
    input: TaskInput,
    task_id: Uuid,
    child_session_id: Uuid,
) -> Result<TaskRecord, ApiError> {
    validate_held_delegation(&input, task_id)?;
    if child_session_id.is_nil() {
        return Err(ApiError::bad_request("Invalid child session ID"));
    }
    edit_store(data_dir, owner, move |store| {
        if store.tasks.iter().any(|task| task.id == task_id) {
            return Err(ApiError::bad_request("Delegation task already exists"));
        }
        let mut task = enqueue(store, input, None, now_ms())?;
        task.id = task_id;
        task.child_session_id = Some(child_session_id);
        task.status = TaskStatus::DelegationHeld;
        task.events[0].status = TaskStatus::DelegationHeld;
        task.events[0].message = "Delegation held for verified admission".into();
        *store.tasks.last_mut().expect("enqueue appends task") = task.clone();
        Ok(task)
    })
    .await
}

#[cfg(any(test, unix))]
pub(crate) async fn launch_held_delegation<T: Send + 'static>(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
    child_id: Uuid,
    input: TaskInput,
    launch: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<(TaskRecord, T), ApiError> {
    validate_held_delegation(&input, task_id)?;
    if child_id.is_nil() {
        return Err(ApiError::bad_request("Invalid child session ID"));
    }
    tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        let _file_guard = store_file_lock(&data_dir)?;
        let mut store = read_store(&data_dir, &owner)?;
        let task = store
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(not_found)?;
        if task.status != TaskStatus::DelegationHeld
            || task.child_session_id != Some(child_id)
            || task.input != input
        {
            return Err(ApiError::bad_request(
                "Delegation task scope or state does not match",
            ));
        }
        transition(
            task,
            TaskStatus::Running,
            "Read-only investigation starting",
            now_ms(),
        );
        let claimed = task.clone();
        // The durable running claim precedes launch. The store locks remain held
        // across launch so a cooperating cancellation cannot pass this boundary.
        write_store(&data_dir, &store)?;
        match launch() {
            Ok(child) => Ok((claimed, child)),
            Err(error) => {
                let task = store
                    .tasks
                    .iter_mut()
                    .find(|task| task.id == task_id)
                    .ok_or_else(not_found)?;
                task.error = Some("Delegated child launch was not confirmed.".into());
                transition(
                    task,
                    TaskStatus::Interrupted,
                    "Delegated launch interrupted",
                    now_ms(),
                );
                write_store(&data_dir, &store).map_err(|_| {
                    ApiError::internal("Delegated launch outcome could not be saved")
                })?;
                Err(error)
            }
        }
    })
    .await
    .map_err(|_| ApiError::internal("Delegated launch outcome is uncertain"))?
}

#[cfg(any(test, unix))]
pub(crate) async fn delegated_task_status(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
    child_id: Uuid,
    input: TaskInput,
) -> Result<TaskStatus, ApiError> {
    edit_store(data_dir, owner, move |store| {
        let task = store
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(not_found)?;
        if task.child_session_id != Some(child_id) || task.input != input {
            return Err(ApiError::bad_request(
                "Delegation task scope does not match",
            ));
        }
        Ok(task.status.clone())
    })
    .await
}

#[cfg(unix)]
pub(crate) async fn interrupt_unlaunched_delegation(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
    child_id: Uuid,
    input: TaskInput,
) -> Result<TaskRecord, ApiError> {
    validate_held_delegation(&input, task_id)?;
    if child_id.is_nil() {
        return Err(ApiError::bad_request("Invalid child session ID"));
    }
    edit_store(data_dir, owner, move |store| {
        let task = store
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(not_found)?;
        if task.child_session_id != Some(child_id) || task.input != input {
            return Err(ApiError::bad_request(
                "Delegation task scope does not match",
            ));
        }
        match task.status {
            TaskStatus::DelegationHeld => {
                transition(
                    task,
                    TaskStatus::Interrupted,
                    "Delegated launch interrupted",
                    now_ms(),
                );
            }
            TaskStatus::Interrupted | TaskStatus::Cancelled => {}
            _ => {
                return Err(ApiError::bad_request(
                    "Delegated launch outcome is uncertain",
                ))
            }
        }
        Ok(task.clone())
    })
    .await
}

#[cfg(unix)]
pub(crate) fn recover_unfinished_delegation<G>(
    data_dir: &FsPath,
    owner: &str,
    task_id: Uuid,
    child_id: Uuid,
    input: &TaskInput,
    authorize: impl FnOnce() -> Result<G, ApiError>,
) -> Result<Option<TaskRecord>, ApiError> {
    recover_delegation_record(data_dir, owner, task_id, child_id, input, true, authorize)
}

#[cfg(unix)]
pub(crate) fn recover_held_unlaunched_delegation<G>(
    data_dir: &FsPath,
    owner: &str,
    task_id: Uuid,
    child_id: Uuid,
    input: &TaskInput,
    authorize: impl FnOnce() -> Result<G, ApiError>,
) -> Result<Option<TaskRecord>, ApiError> {
    recover_delegation_record(data_dir, owner, task_id, child_id, input, false, authorize)
}

#[cfg(unix)]
fn recover_delegation_record<G>(
    data_dir: &FsPath,
    owner: &str,
    task_id: Uuid,
    child_id: Uuid,
    input: &TaskInput,
    allow_running: bool,
    authorize: impl FnOnce() -> Result<G, ApiError>,
) -> Result<Option<TaskRecord>, ApiError> {
    use std::os::unix::fs::OpenOptionsExt;
    validate_held_delegation(input, task_id)?;
    if child_id.is_nil() || data_dir.canonicalize().ok().as_deref() != Some(data_dir) {
        return Err(ApiError::internal("Delegated task scope changed"));
    }
    let unavailable = || ApiError::internal("Saved delegated task is unavailable");
    let _guard = STORE_LOCK.lock().map_err(|_| unavailable())?;
    let directory = data_dir.join("workspace-tasks");
    let path = store_path(data_dir, owner);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata) if metadata.file_type().is_file() => {}
        _ => return Err(unavailable()),
    }
    if !std::fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.file_type().is_dir()) {
        return Err(unavailable());
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join("store.lock"))
        .map_err(|_| unavailable())?;
    if !lock.metadata().map_err(|_| unavailable())?.is_file() {
        return Err(unavailable());
    }
    lock.lock().map_err(|_| unavailable())?;
    let _authorization = authorize()?;
    let mut store = read_store(data_dir, owner)?;
    let Some(task) = store.tasks.iter_mut().find(|task| task.id == task_id) else {
        return Ok(None);
    };
    if task.child_session_id != Some(child_id) || &task.input != input || task.schedule_id.is_some()
    {
        return Err(ApiError::internal("Delegated task scope does not match"));
    }
    if task.status == TaskStatus::Queued {
        return Err(ApiError::internal(
            "Delegated task state is invalid; data was preserved",
        ));
    }
    if !allow_running && matches!(task.status, TaskStatus::Running | TaskStatus::Cancelling) {
        return Err(ApiError::internal(
            "Delegated child cleanup is unconfirmed after restart",
        ));
    }
    let changed = matches!(
        task.status,
        TaskStatus::DelegationHeld | TaskStatus::Running | TaskStatus::Cancelling
    );
    if changed {
        task.result.clear();
        task.error = Some(
            "The previous server stopped before this investigation's outcome was confirmed.".into(),
        );
        transition(
            task,
            TaskStatus::Interrupted,
            "Delegated investigation outcome unknown after restart",
            now_ms(),
        );
    }
    let result = task.clone();
    if changed {
        write_store(data_dir, &store)?;
    }
    Ok(Some(result))
}

#[cfg(any(test, unix))]
pub(crate) async fn settle_running_delegation(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
    child_id: Uuid,
    input: TaskInput,
    status: TaskStatus,
    result: String,
    exit_code: Option<i32>,
) -> Result<TaskRecord, ApiError> {
    validate_held_delegation(&input, task_id)?;
    if child_id.is_nil()
        || result.len() > OUTPUT_LIMIT
        || !matches!(
            status,
            TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Interrupted
        )
        || (status == TaskStatus::Completed && exit_code != Some(0))
        || (status == TaskStatus::Failed && exit_code != Some(1))
        || (matches!(status, TaskStatus::Cancelled | TaskStatus::Interrupted) && !result.is_empty())
    {
        return Err(ApiError::bad_request("Invalid delegated child outcome"));
    }
    let safe_result = crate::session_search::safe_history_text(&result);
    edit_store(data_dir, owner, move |store| {
        let task = store
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(not_found)?;
        if !matches!(task.status, TaskStatus::Running | TaskStatus::Cancelling)
            || task.child_session_id != Some(child_id)
            || task.input != input
        {
            return Err(ApiError::bad_request(
                "Delegation task scope or state does not match",
            ));
        }
        let final_status = if task.status == TaskStatus::Cancelling {
            TaskStatus::Cancelled
        } else {
            status
        };
        if matches!(final_status, TaskStatus::Completed | TaskStatus::Failed)
            && safe_result.len() > OUTPUT_LIMIT
        {
            return Err(ApiError::bad_request(
                "Delegated child outcome exceeds storage limit",
            ));
        }
        task.result = if matches!(final_status, TaskStatus::Completed | TaskStatus::Failed) {
            safe_result
        } else {
            String::new()
        };
        task.exit_code = exit_code;
        task.error = None;
        transition(
            task,
            final_status,
            "Read-only investigation finished",
            now_ms(),
        );
        Ok(task.clone())
    })
    .await
}

#[cfg(test)]
pub(crate) async fn settle_held_delegation_for_test(
    data_dir: PathBuf,
    owner: String,
    task_id: Uuid,
    child_session_id: Uuid,
    status: TaskStatus,
    result: String,
    exit_code: Option<i32>,
    error: Option<String>,
) -> Result<TaskRecord, ApiError> {
    if !status.terminal()
        || task_id.is_nil()
        || child_session_id.is_nil()
        || result.len() > OUTPUT_LIMIT
        || error
            .as_ref()
            .is_some_and(|message| message.len() > OUTPUT_LIMIT)
    {
        return Err(ApiError::bad_request("Invalid delegation result"));
    }
    edit_store(data_dir, owner, move |store| {
        let task = store
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(not_found)?;
        if task.status != TaskStatus::DelegationHeld
            || task.child_session_id != Some(child_session_id)
        {
            return Err(ApiError::bad_request(
                "Delegation task scope or state does not match",
            ));
        }
        task.result = result;
        task.exit_code = exit_code;
        task.error = error;
        transition(task, status, "Delegation test result persisted", now_ms());
        Ok(task.clone())
    })
    .await
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
        if crate::v4_agent::supports(provider) && value["type"] == "v4.result" {
            final_result = value["text"].as_str().map(str::to_owned);
        } else if provider == "claude" {
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
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    deliver_to: Option<Option<DeliveryTarget>>,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
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
            "/api/workspace/schedules/capabilities",
            axum::routing::get(schedule_capabilities),
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

async fn schedule_capabilities(
    Extension(_user): Extension<AuthenticatedUser>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "advancedTimingProtocolVersion": 1 }))
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
        let _file_guard = store_file_lock(&data_dir)?;
        read_store(&data_dir, &owner)
    })
    .await
    .map_err(|_| ApiError::internal("Task storage unavailable"))??;
    let path = query
        .path
        .map(|value| crate::session_search::workspace_filter_key(&value));
    let schedules_with_outcomes = with_last_outcomes(store.schedules, &store.tasks);
    let mut tasks: Vec<_> = store
        .tasks
        .into_iter()
        .filter(|task| {
            path.as_ref().is_none_or(|path| {
                *path == crate::session_search::workspace_filter_key(&task.input.workspace_path)
            })
        })
        .collect();
    tasks.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let schedules = schedules_with_outcomes
        .into_iter()
        .filter(|schedule| {
            path.as_ref().is_none_or(|path| {
                *path == crate::session_search::workspace_filter_key(&schedule.input.workspace_path)
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
    let record =
        create_owner_schedule(state.config().data_dir.clone(), user.user_id, input).await?;
    Ok(Json(record))
}

/// Persist an owner-scoped schedule. Callers must authorize the owner and obtain
/// any required approval before invoking this service.
pub(crate) async fn create_owner_schedule(
    data_dir: PathBuf,
    owner: String,
    input: ScheduleInput,
) -> Result<ScheduleRecord, ApiError> {
    if let Some(when) = input.run_once_at {
        if input.at.is_some() || when <= now_ms() || when > 8_640_000_000_000_000 {
            return Err(ApiError::bad_request(
                "Choose a future one-shot time without a recurring calendar",
            ));
        }
    } else if input.at.is_none() || input.interval_seconds != 0 {
        validate_interval(input.interval_seconds)?;
    }
    if let Some(at) = &input.at {
        validate_calendar(at)?;
    }
    if input.name.trim().is_empty()
        || input.name.chars().count() > 80
        || input.name.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "Schedule name must be 1–80 characters",
        ));
    }
    let task = canonical_task(input.task).await?;
    let record = edit_store(data_dir, owner, move |store| {
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
        if input.run_once_at.is_some_and(|when| when <= now) {
            return Err(ApiError::bad_request(
                "Choose a future one-shot time without a recurring calendar",
            ));
        }
        let schedule = ScheduleRecord {
            id: Uuid::new_v4(),
            name: input.name.trim().into(),
            input: task,
            interval_seconds: input.interval_seconds,
            at: input.at,
            run_once_at: input.run_once_at,
            enabled: input.enabled,
            next_run_at: None,
            last_run_at: None,
            last_task_id: None,
            created_at: now,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
            deliver_to: input.deliver_to,
        };
        let mut schedule = schedule;
        schedule.next_run_at = schedule.enabled.then(|| {
            schedule
                .run_once_at
                .unwrap_or_else(|| schedule.next_after(now))
        });
        store.schedules.push(schedule.clone());
        Ok(schedule)
    })
    .await?;
    Ok(record)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewedSchedule {
    #[serde(skip)]
    data_dir: PathBuf,
    owner: String,
    session_id: String,
    turn_id: String,
    schedule: ScheduleRecord,
}

pub(crate) async fn prepare_reviewed_schedule(
    data_dir: PathBuf,
    owner: String,
    session_id: String,
    turn_id: String,
    input: ScheduleInput,
    skill: Option<ScheduleSkill>,
) -> Result<ReviewedSchedule, ApiError> {
    if owner.is_empty()
        || session_id.is_empty()
        || turn_id.is_empty()
        || input.task.parent_session_id.as_deref() != Some(session_id.as_str())
        || input.task.parent_task_id.is_some()
    {
        return Err(ApiError::bad_request("Invalid schedule scope"));
    }
    if let Some(when) = input.run_once_at {
        if input.at.is_some() || when <= now_ms() || when > 8_640_000_000_000_000 {
            return Err(ApiError::bad_request(
                "Choose a future one-shot time without a recurring calendar",
            ));
        }
    } else if input.at.is_none() || input.interval_seconds != 0 {
        validate_interval(input.interval_seconds)?;
    }
    if let Some(at) = &input.at {
        validate_calendar(at)?;
    }
    if skill.as_ref().is_some_and(|skill| {
        [&skill.skill_ref, &skill.name].iter().any(|text| {
            text.is_empty() || text.chars().count() > 200 || text.chars().any(char::is_control)
        }) || skill.revision.len() != 64
            || !skill.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(ApiError::bad_request("Invalid skill reference"));
    }
    if input.name.trim().is_empty()
        || input.name.chars().count() > 80
        || input.name.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "Schedule name must be 1–80 characters",
        ));
    }
    let task = canonical_task(input.task).await?;
    let now = now_ms();
    let mut schedule = ScheduleRecord {
        id: Uuid::new_v4(),
        name: input.name.trim().into(),
        input: task,
        interval_seconds: input.interval_seconds,
        at: input.at,
        run_once_at: input.run_once_at,
        enabled: input.enabled,
        next_run_at: None,
        last_run_at: None,
        last_task_id: None,
        created_at: now,
        missed_runs: 0,
        last_missed_at: None,
        skill,
        last_status: None,
        last_error: None,
        deliver_to: input.deliver_to,
    };
    schedule.next_run_at = schedule.enabled.then(|| {
        schedule
            .run_once_at
            .unwrap_or_else(|| schedule.next_after(now))
    });
    if schedule.next_run_at == Some(u64::MAX) {
        return Err(ApiError::bad_request("No valid first run is available"));
    }
    Ok(ReviewedSchedule {
        data_dir,
        owner,
        session_id,
        turn_id,
        schedule,
    })
}

/// The lock acquisition and final checks establish the commit boundary. After
/// those checks, the blocking operation must be awaited even if the turn stops.
pub(crate) async fn commit_reviewed_schedule(
    reviewed: ReviewedSchedule,
    expires_at: i64,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<ScheduleRecord, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        let _file_guard = store_file_lock(&reviewed.data_dir)?;
        let mut store = read_store(&reviewed.data_dir, &reviewed.owner)?;
        if store.schedules.len() >= SCHEDULE_LIMIT {
            return Err(ApiError::bad_request(
                "Remove an old schedule before creating another",
            ));
        }
        let path = std::fs::canonicalize(&reviewed.schedule.input.workspace_path)
            .map_err(|_| ApiError::bad_request("Reviewed workspace is unavailable"))?;
        if !path.is_dir() || path != FsPath::new(&reviewed.schedule.input.workspace_path) {
            return Err(ApiError::bad_request("Reviewed workspace changed"));
        }
        if cancelled() {
            return Err(ApiError::bad_request(
                "Schedule approval expired, was cancelled, or its first run is stale",
            ));
        }
        let now = now_ms();
        if expires_at <= now as i64
            || reviewed
                .schedule
                .next_run_at
                .is_some_and(|first| first <= now)
            || reviewed
                .schedule
                .run_once_at
                .is_some_and(|first| first <= now)
        {
            return Err(ApiError::bad_request(
                "Schedule approval expired, was cancelled, or its first run is stale",
            ));
        }
        let schedule = reviewed.schedule;
        store.schedules.push(schedule.clone());
        write_store(&reviewed.data_dir, &store)?;
        Ok(schedule)
    })
    .await
    .map_err(|_| ApiError::internal("Schedule commit could not be confirmed"))?
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
            if let Some(target) = input.deliver_to {
                schedule.deliver_to = target;
            }
            let Some(enabled) = input.enabled else {
                return Ok(schedule.clone());
            };
            if enabled && schedule.run_once_at.is_some() && schedule.last_task_id.is_some() {
                return Err(ApiError::bad_request(
                    "This one-shot schedule has already run",
                ));
            }
            if enabled == schedule.enabled {
                return Ok(schedule.clone());
            }
            let now = now_ms();
            if enabled && !schedule.enabled && schedule.run_once_at.is_some_and(|when| when <= now) {
                return Err(ApiError::bad_request("This one-shot time has passed. Use Run now or create a new schedule for a future time."));
            }
            schedule.enabled = enabled;
            schedule.next_run_at = enabled.then(|| {
                schedule
                    .run_once_at
                    .unwrap_or_else(|| schedule.next_after(now))
            });
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
            if store.schedules[index].run_once_at.is_some()
                && store.schedules[index].last_task_id.is_some()
            {
                return Err(ApiError::bad_request(
                    "This one-shot schedule has already run",
                ));
            }
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
            let target = store.schedules[index].deliver_to;
            let task = delivery::mark_for_delivery(store, task.id, target).unwrap_or(task);
            let schedule = &mut store.schedules[index];
            schedule.last_run_at = Some(now);
            schedule.last_task_id = Some(task.id);
            if schedule.run_once_at.is_some() {
                schedule.enabled = false;
                schedule.next_run_at = None;
            } else {
                schedule.next_run_at = schedule.enabled.then(|| schedule.next_after(now));
            }
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
    let _file_guard = store_file_lock(data)?;
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
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let Some(owner) = value.get("ownerId").and_then(|v| v.as_str()) else {
            continue;
        };
        if store_path(data_dir, owner) != entry.path() {
            continue;
        }
        match read_store(data_dir, owner) {
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
    let _file_guard = store_file_lock(data_dir)?;
    let mut selected = Vec::new();
    let mut occupied: std::collections::HashSet<_> = active
        .iter()
        .map(|p| workspace_key(&p.to_string_lossy()))
        .collect();
    let journal = read_outcome_journal(data_dir);
    let mut settled = std::collections::HashSet::new();
    for mut store in load_owner_stores(data_dir)? {
        let original = serde_json::to_vec(&store)
            .map_err(|_| ApiError::internal("Task storage unavailable"))?;
        let now = now_ms();
        apply_outcome_journal(&mut store, &journal);
        if recover {
            recover_interrupted(&mut store, now);
        }
        skip_stale_runs(&mut store, now);
        queue_due_schedules(&mut store, now, |input| {
            crate::workspace_activity::enter(FsPath::new(&input.workspace_path)).is_ok()
        });
        let mut candidates: Vec<_> = store
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, task)| {
                task.status == TaskStatus::Queued && task.child_session_id.is_none()
            })
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
        settled.extend(
            journal
                .iter()
                .filter(|entry| entry.owner == store.owner_id)
                .map(|entry| (entry.owner.clone(), entry.record.id)),
        );
        selected.extend(
            claimed
                .into_iter()
                .map(|(_, task)| (store.owner_id.clone(), task)),
        );
    }
    if let Err(error) = settle_outcome_journal(data_dir, &settled) {
        tracing::warn!(error = %error, "Applied task outcomes could not be cleared from the journal; they are idempotent");
    }
    Ok(selected)
}

#[cfg(test)]
mod worker_durability_tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_interrupts_task_waiting_for_checkpoint_lock() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        let task_id = task.id;
        let lock = crate::workspace_git::lock_mutations_for_test().await;
        let (stop, shutdown) = tokio::sync::watch::channel(false);
        let mut running = tokio::spawn(execute_task(
            dir.path().into(),
            "owner".into(),
            task,
            shutdown,
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), &mut running).await;
        let receipt = std::fs::read(receipt_path(dir.path(), "owner", task_id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<TaskRecord>(&bytes).ok());
        drop(lock);
        if result.is_err() {
            let _ = running.await;
        }
        assert!(matches!(result, Ok(Ok(()))));
        assert_eq!(
            receipt.map(|record| record.status),
            Some(TaskStatus::Interrupted)
        );
        assert!(!dir.path().join("workspace-git").exists());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interrupted_before_launch_is_durable_while_owner_store_is_locked() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        let id = task.id;
        let lock = store_file_lock(dir.path()).unwrap();
        let mut running = tokio::spawn(interrupt_before_launch(
            dir.path().into(),
            "owner".into(),
            task,
        ));
        let completed = tokio::time::timeout(Duration::from_secs(1), &mut running)
            .await
            .is_ok();
        let durable = std::fs::read(receipt_path(dir.path(), "owner", id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<TaskRecord>(&bytes).ok())
            .map(|record| record.status);
        drop(lock);
        if !completed {
            tokio::time::timeout(Duration::from_secs(5), running)
                .await
                .unwrap()
                .unwrap();
        }
        assert!(completed, "interruption waited for the owner store lock");
        assert_eq!(durable, Some(TaskStatus::Interrupted));
        assert_eq!(
            read_store(dir.path(), "owner").unwrap().tasks[0].status,
            TaskStatus::Interrupted
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interrupted_before_launch_waits_for_a_durable_receipt() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        let id = task.id;
        let obstruction = dir.path().join("workspace-tasks/completions");
        std::fs::write(&obstruction, "blocked").unwrap();
        std::fs::create_dir(journal_path(dir.path())).unwrap();
        let running = tokio::spawn(interrupt_before_launch(
            dir.path().into(),
            "owner".into(),
            task,
        ));
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!running.is_finished());
        std::fs::remove_file(obstruction).unwrap();
        tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap();
        let saved: TaskRecord =
            serde_json::from_slice(&std::fs::read(receipt_path(dir.path(), "owner", id)).unwrap())
                .unwrap();
        assert_eq!(saved.status, TaskStatus::Interrupted);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_owner_store_and_receipt_keep_completion_pending_until_durable() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let mut store = fixture_store(dir.path(), "owner", &[dir.path()]);
        let mut task = store.tasks.remove(0);
        transition(&mut task, TaskStatus::Completed, "finished", now_ms());
        std::fs::write(store_path(dir.path(), "owner"), "corrupt").unwrap();
        let obstruction = dir.path().join("workspace-tasks/completions");
        std::fs::write(&obstruction, "blocked").unwrap();
        std::fs::create_dir(journal_path(dir.path())).unwrap();
        let running = tokio::spawn(persist_final_record(
            dir.path().into(),
            "owner".into(),
            task.clone(),
        ));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !running.is_finished(),
            "terminal result was acknowledged without durable storage"
        );
        std::fs::remove_file(obstruction).unwrap();
        tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap();
        let receipt: TaskRecord = serde_json::from_slice(
            &std::fs::read(receipt_path(dir.path(), "owner", task.id)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            (receipt.id, receipt.status),
            (task.id, TaskStatus::Completed)
        );
    }
    #[tokio::test]
    async fn oversized_outcome_survives_as_a_truncated_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let store = fixture_store(dir.path(), "owner", &[dir.path()]);
        let mut task = store.tasks[0].clone();
        task.result = "x".repeat(600 * 1024);
        transition(&mut task, TaskStatus::Completed, "finished", now_ms());
        persist_completion_receipt(dir.path().into(), "owner".into(), task.clone()).await;
        let recovered = completion_records(dir.path(), "owner");
        assert_eq!(
            (
                recovered.len(),
                recovered[0].id,
                recovered[0].status.clone(),
                recovered[0].result.len() <= COMPACT_RESULT_LIMIT,
                recovered[0]
                    .error
                    .as_deref()
                    .is_some_and(|error| error.contains("truncated")),
            ),
            (1, task.id, TaskStatus::Completed, true, true)
        );
    }

    #[test]
    fn worker_protocol_marker_is_written_and_newer_data_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let marker_path = dir.path().join("workspace-tasks/worker-protocol.json");
        ensure_worker_protocol(dir.path()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(&marker_path).unwrap()
            )
            .unwrap(),
            serde_json::json!({"protocol": WORKER_PROTOCOL})
        );
        std::fs::write(
            &marker_path,
            format!("{{\"protocol\":{}}}", WORKER_PROTOCOL + 1),
        )
        .unwrap();
        assert!(ensure_worker_protocol(dir.path())
            .unwrap_err()
            .message
            .contains("newer"));
        std::fs::write(&marker_path, "garbage").unwrap();
        assert!(ensure_worker_protocol(dir.path()).is_err());
    }

    #[test]
    fn older_protocol_marker_is_upgraded_under_the_lease() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("workspace-tasks")).unwrap();
        let marker_path = dir.path().join("workspace-tasks/worker-protocol.json");
        std::fs::write(&marker_path, "{\"protocol\":0}").unwrap();
        ensure_worker_protocol(dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&marker_path).unwrap(),
            format!("{{\"protocol\":{WORKER_PROTOCOL}}}")
        );
    }

    #[test]
    fn second_lease_is_refused_until_first_is_released() {
        let dir = tempfile::tempdir().unwrap();
        let first = worker_lease(dir.path()).unwrap();
        assert!(worker_lease(dir.path()).is_err());
        drop(first);
        assert!(worker_lease(dir.path()).is_ok());
    }

    fn schedule_fixture(workspace: &FsPath, next_run_at: u64) -> ScheduleRecord {
        ScheduleRecord {
            id: Uuid::new_v4(),
            name: "Daily".into(),
            input: TaskInput {
                workspace_path: workspace.to_string_lossy().into_owned(),
                provider: "codex".into(),
                prompt: "Review".into(),
                model: None,
                parent_session_id: None,
                parent_task_id: None,
            },
            interval_seconds: 60,
            at: None,
            run_once_at: None,
            enabled: true,
            next_run_at: Some(next_run_at),
            last_run_at: None,
            last_task_id: None,
            created_at: 1,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
            deliver_to: None,
        }
    }

    fn store_with_schedule(
        data_dir: &FsPath,
        workspace: &FsPath,
        schedule: ScheduleRecord,
    ) -> TaskStore {
        let mut store = fixture_store(data_dir, "owner", &[workspace]);
        store.tasks.clear();
        store.schedules.push(schedule);
        write_store(data_dir, &store).unwrap();
        store
    }

    #[test]
    fn long_downtime_reports_missed_runs_instead_of_one_silent_catch_up() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let before = now_ms();
        store_with_schedule(
            dir.path(),
            workspace.path(),
            schedule_fixture(workspace.path(), 1),
        );
        let claimed = claim_tasks(dir.path(), true, &Default::default(), 3).unwrap();
        let persisted = read_store(dir.path(), "owner").unwrap();
        let schedule = &persisted.schedules[0];
        assert_eq!(
            (
                claimed.len(),
                persisted.tasks.len(),
                schedule.missed_runs >= before / 60_000,
                schedule.last_missed_at.is_some_and(|at| at >= before),
                schedule.next_run_at.is_some_and(|next| next > before),
                schedule.last_task_id,
                schedule.enabled,
            ),
            (0, 0, true, true, true, None, true)
        );
    }

    #[test]
    fn runs_within_the_grace_window_still_run_and_are_not_reported_missed() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let late = now_ms() - (MIN_GRACE_MS - 30_000);
        store_with_schedule(
            dir.path(),
            workspace.path(),
            schedule_fixture(workspace.path(), late),
        );
        let claimed = claim_tasks(dir.path(), true, &Default::default(), 3).unwrap();
        let schedule = &read_store(dir.path(), "owner").unwrap().schedules[0];
        assert_eq!(
            (claimed.len(), schedule.missed_runs, schedule.last_missed_at),
            (1, 0, None)
        );
    }

    #[test]
    fn stale_one_shot_is_recorded_missed_disabled_and_never_run() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut schedule = schedule_fixture(workspace.path(), 1);
        schedule.run_once_at = Some(1);
        schedule.interval_seconds = 0;
        store_with_schedule(dir.path(), workspace.path(), schedule);
        let claimed = claim_tasks(dir.path(), true, &Default::default(), 3).unwrap();
        let persisted = read_store(dir.path(), "owner").unwrap();
        let schedule = &persisted.schedules[0];
        assert_eq!(
            (
                claimed.len(),
                persisted.tasks.len(),
                schedule.enabled,
                schedule.next_run_at,
                schedule.missed_runs,
                schedule.last_missed_at.is_some(),
            ),
            (0, 0, false, None, 1, true)
        );
    }

    #[test]
    fn stale_calendar_run_is_recorded_missed_and_rescheduled() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut schedule = schedule_fixture(workspace.path(), 1);
        schedule.at = Some(CalendarTime {
            hour: 9,
            minute: 0,
            weekdays: vec![0, 1, 2, 3, 4, 5, 6],
            utc_offset_minutes: 0,
            time_zone: None,
            cron: None,
        });
        store_with_schedule(dir.path(), workspace.path(), schedule);
        let before = now_ms();
        let claimed = claim_tasks(dir.path(), true, &Default::default(), 3).unwrap();
        let schedule = &read_store(dir.path(), "owner").unwrap().schedules[0];
        assert_eq!(
            (
                claimed.len(),
                schedule.missed_runs,
                schedule.next_run_at.is_some_and(|next| next > before),
            ),
            (0, 1, true)
        );
    }

    #[test]
    fn stale_run_with_a_task_still_in_flight_is_overlap_not_a_missed_run() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let schedule = schedule_fixture(workspace.path(), 1);
        let id = schedule.id;
        let mut store = store_with_schedule(dir.path(), workspace.path(), schedule);
        let input = store.schedules[0].input.clone();
        let mut running = enqueue(&mut store, input, Some(id), 0).unwrap();
        transition(&mut running, TaskStatus::Running, "running", 1);
        store.tasks[0].status = TaskStatus::Running;
        skip_stale_runs(&mut store, now_ms());
        assert_eq!(store.schedules[0].missed_runs, 0);
    }

    #[test]
    fn schedule_records_without_missed_run_fields_round_trip_unchanged() {
        let workspace = tempfile::tempdir().unwrap();
        let record = schedule_fixture(workspace.path(), 5);
        let value = serde_json::to_value(&record).unwrap();
        assert!(value.get("missedRuns").is_none() && value.get("lastMissedAt").is_none());
        let loaded: ScheduleRecord = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            (
                loaded.missed_runs,
                loaded.last_missed_at,
                serde_json::to_value(&loaded).unwrap()
            ),
            (0, None, value)
        );
    }

    #[test]
    fn schedule_with_a_non_terminal_task_never_queues_a_duplicate() {
        let workspace = tempfile::tempdir().unwrap();
        for one_shot in [false, true] {
            let mut schedule = schedule_fixture(workspace.path(), 100);
            if one_shot {
                schedule.run_once_at = Some(100);
            }
            let id = schedule.id;
            let mut store = TaskStore {
                owner_id: "owner".into(),
                ..Default::default()
            };
            store.schedules.push(schedule);
            for status in [
                TaskStatus::Queued,
                TaskStatus::Running,
                TaskStatus::Cancelling,
            ] {
                store.tasks.clear();
                let input = store.schedules[0].input.clone();
                enqueue(&mut store, input, Some(id), 0).unwrap();
                store.tasks[0].status = status;
                queue_due_schedules(&mut store, 200, |_| true);
                assert_eq!(
                    (
                        store.tasks.len(),
                        store.schedules[0].last_task_id,
                        store.schedules[0].enabled,
                        store.schedules[0].next_run_at,
                    ),
                    (
                        1,
                        None,
                        true,
                        if one_shot {
                            Some(100)
                        } else {
                            Some(200 + 60_000)
                        }
                    )
                );
                store.schedules[0].next_run_at = Some(100);
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn outcome_survives_total_store_and_receipt_failure_across_restart() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, mut task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        let good_store = std::fs::read(store_path(dir.path(), "owner")).unwrap();
        task.result = "kept answer".into();
        transition(&mut task, TaskStatus::Completed, "finished", now_ms());
        std::fs::write(store_path(dir.path(), "owner"), "corrupt").unwrap();
        let obstruction = dir.path().join("workspace-tasks/completions");
        std::fs::write(&obstruction, "blocked").unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            persist_final_record(dir.path().into(), "owner".into(), task.clone()),
        )
        .await
        .expect("an outcome with a working journal must not wait forever");
        let mut torn = std::fs::OpenOptions::new()
            .append(true)
            .open(journal_path(dir.path()))
            .unwrap();
        std::io::Write::write_all(&mut torn, b"{\"owner\":\"owner\",\"rec").unwrap();
        drop(torn);

        std::fs::write(store_path(dir.path(), "owner"), good_store).unwrap();
        std::fs::remove_file(obstruction).unwrap();
        claim_tasks(dir.path(), true, &Default::default(), 3).unwrap();
        let recovered = read_store(dir.path(), "owner").unwrap();
        assert_eq!(
            (
                recovered.tasks[0].status.clone(),
                recovered.tasks[0].result.clone(),
                recovered.tasks[0].error.clone(),
                journal_path(dir.path()).exists(),
            ),
            (TaskStatus::Completed, "kept answer".into(), None, false)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn outcome_with_no_writable_target_is_only_unknown_after_restart() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, mut task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        transition(&mut task, TaskStatus::Completed, "finished", now_ms());
        std::fs::write(store_path(dir.path(), "owner"), "corrupt").unwrap();
        std::fs::write(dir.path().join("workspace-tasks/completions"), "blocked").unwrap();
        std::fs::create_dir(journal_path(dir.path())).unwrap();
        let pending = tokio::spawn(persist_final_record(
            dir.path().into(),
            "owner".into(),
            task,
        ));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(!pending.is_finished());
        pending.abort();
        let mut store = fixture_store(dir.path(), "owner", &[workspace.path()]);
        store.tasks[0].status = TaskStatus::Running;
        recover_interrupted(&mut store, now_ms());
        assert_eq!(store.tasks[0].status, TaskStatus::Interrupted);
        assert!(store.tasks[0]
            .events
            .last()
            .unwrap()
            .message
            .contains("outcome unknown"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_during_a_started_checkpoint_waits_for_it_and_keeps_the_outcome() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .current_dir(workspace.path())
                .args(args)
                .output()
                .unwrap()
                .status
                .success())
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "Tests"]);
        git(&["config", "user.email", "tests@example.test"]);
        std::fs::write(workspace.path().join("note.txt"), "initial\n").unwrap();
        git(&["add", "note.txt"]);
        git(&["commit", "-m", "initial"]);
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        let task_id = task.id;
        let (stop, mut shutdown) = tokio::sync::watch::channel(false);
        let data = dir.path().to_path_buf();
        let checkpoint = tokio::spawn(async move {
            save_task_checkpoint(&data, "owner", &task, true, &mut shutdown).await
        });
        tokio::task::yield_now().await;
        stop.send(true).unwrap();
        let saved = tokio::time::timeout(Duration::from_secs(10), checkpoint)
            .await
            .expect("an already-started checkpoint must finish within the shutdown bound")
            .unwrap();
        let stored = read_store(dir.path(), "owner").unwrap();
        let record = stored.tasks.iter().find(|task| task.id == task_id).unwrap();
        let finished = saved && record.before_checkpoint_id.is_some();
        let declined = !saved && record.before_checkpoint_id.is_none();
        assert!(finished || declined);
        let mut interrupted = record.clone();
        transition(
            &mut interrupted,
            TaskStatus::Interrupted,
            "shutdown",
            now_ms(),
        );
        persist_final_record(dir.path().into(), "owner".into(), interrupted).await;
        assert_eq!(
            read_store(dir.path(), "owner").unwrap().tasks[0].status,
            TaskStatus::Interrupted
        );
    }

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
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_interrupts_claim_waiting_for_workspace_and_allows_standby_takeover() {
        use std::time::Duration;

        if let Some(data_dir) = std::env::var_os("TASK_STANDBY_TEST_DIR") {
            let data_dir = PathBuf::from(data_dir);
            let state = AppState::new(terminal_v4_core::AppConfig {
                data_dir: data_dir.clone(),
                ..Default::default()
            })
            .unwrap();
            assert!(start_worker(state));
            std::fs::write(data_dir.join("standby-ready"), "ready").unwrap();
            tokio::time::timeout(Duration::from_secs(15), async {
                while !data_dir.join("standby-stop").exists() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .expect("standby was not stopped");
            let key = data_dir.canonicalize().unwrap();
            WORKERS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .send(true)
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                while WORKERS.get().unwrap().lock().unwrap().contains_key(&key) {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .expect("standby did not stop");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data_dir.clone(),
            ..Default::default()
        })
        .unwrap();
        let original = fixture_store(&data_dir, "owner", &[workspace.path()]);
        let guard = crate::workspace_activity::exclusive(workspace.path()).unwrap();
        assert!(start_worker(state));
        tokio::time::timeout(Duration::from_secs(5), async {
            while read_store(&data_dir, "owner").unwrap().tasks[0].status != TaskStatus::Running {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("worker did not claim task");

        let mut standby = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "workspace_tasks::worker_durability_tests::shutdown_interrupts_claim_waiting_for_workspace_and_allows_standby_takeover", "--nocapture"])
            .env("TASK_STANDBY_TEST_DIR", &data_dir)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !data_dir.join("standby-ready").exists() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("standby did not start");
        let key = data_dir.canonicalize().unwrap();
        let store_guard = store_file_lock(&data_dir).unwrap();
        WORKERS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .send(true)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !receipt_path(&data_dir, "owner", original.tasks[0].id).exists()
                || WORKERS.get().unwrap().lock().unwrap().contains_key(&key)
            {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("worker did not durably interrupt and release its lease");
        let saved: TaskRecord = serde_json::from_slice(
            &std::fs::read(receipt_path(&data_dir, "owner", original.tasks[0].id)).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.status, TaskStatus::Interrupted);
        drop(store_guard);
        tokio::time::timeout(Duration::from_secs(3), async {
            while WORKERS.get().unwrap().lock().unwrap().contains_key(&key) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("worker did not finish shutdown while workspace was held");
        let interrupted = read_store(&data_dir, "owner").unwrap().tasks.remove(0);
        assert_eq!(interrupted.id, original.tasks[0].id);
        assert_eq!(interrupted.status, TaskStatus::Interrupted);
        assert!(interrupted.before_checkpoint_id.is_none());
        tokio::time::timeout(Duration::from_secs(5), async {
            while worker_lease(&data_dir).is_ok() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("standby did not acquire released lease");
        drop(guard);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let after_takeover = read_store(&data_dir, "owner").unwrap().tasks.remove(0);
        assert_eq!(after_takeover.status, TaskStatus::Interrupted);
        assert_eq!(after_takeover.events.len(), interrupted.events.len());
        assert!(after_takeover.before_checkpoint_id.is_none());
        std::fs::write(data_dir.join("standby-stop"), "stop").unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), standby.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_during_prelaunch_store_check_does_not_dispatch() {
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fixture_store(dir.path(), "owner", &[workspace.path()]);
        let (_, task) = claim_tasks(dir.path(), false, &Default::default(), 1)
            .unwrap()
            .remove(0);
        let marker = dir.path().join("launched");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("touch \"$1\"")
            .arg("fixture")
            .arg(&marker);
        let store_guard = store_file_lock(dir.path()).unwrap();
        let (stop, shutdown) = tokio::sync::watch::channel(false);
        let run = tokio::spawn(run_command_inner(
            dir.path().into(),
            "owner".into(),
            task,
            command,
            shutdown,
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        stop.send(true).unwrap();
        drop(store_guard);
        tokio::time::timeout(Duration::from_secs(3), run)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !marker.exists(),
            "native command was launched after shutdown"
        );
        assert_eq!(
            read_store(dir.path(), "owner").unwrap().tasks[0].status,
            TaskStatus::Interrupted
        );
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
    let (stop, mut shutdown) = tokio::sync::watch::channel(false);
    keys.insert(data_dir.clone(), stop);
    drop(keys);
    tokio::spawn(async move {
        let _registration = WorkerRegistration(data_dir.clone());
        let _lease = loop {
            if *shutdown.borrow() {
                return;
            }
            match worker_lease(&data_dir) {
                Ok(lease) => break lease,
                Err(error) if error.message.contains("refusing") => {
                    tracing::error!(error = %error.message, "Workspace task worker not started; see docs/development/WORKER_UPGRADE.md");
                    return;
                }
                Err(error) => {
                    tracing::warn!(error = %error.message, "Workspace task worker waiting for lease")
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                _ = shutdown.changed() => {},
            }
        };
        let mut running = tokio::task::JoinSet::new();
        let mut deliveries = tokio::task::JoinSet::new();
        let mut occupied = std::collections::HashSet::new();
        let mut recover = true;
        let mut recover_deliveries = true;
        loop {
            while let Some(result) = running.try_join_next() {
                if let Ok(key) = result {
                    occupied.remove(&key);
                }
            }
            while deliveries.try_join_next().is_some() {}
            if *shutdown.borrow() {
                while running.join_next().await.is_some() {}
                delivery::drain(&mut deliveries).await;
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
            let path = data_dir.clone();
            match tokio::task::spawn_blocking(move || {
                delivery::claim_deliveries(&path, recover_deliveries)
            })
            .await
            {
                Ok(Ok(items)) => {
                    recover_deliveries = false;
                    for item in items {
                        deliveries.spawn(delivery::deliver(data_dir.clone(), item));
                    }
                }
                _ => tracing::warn!("Schedule result delivery queue could not be read"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
    true
}

pub async fn shutdown_workers() {
    {
        let _gate = LAUNCH_GATE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(workers) = WORKERS.get() {
            if let Ok(keys) = workers.lock() {
                for stop in keys.values() {
                    let _ = stop.send(true);
                }
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

async fn save_task_checkpoint(
    data_dir: &FsPath,
    owner: &str,
    task: &TaskRecord,
    before: bool,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> bool {
    let label = if before { "Before task" } else { "After task" };
    let Some(checkpoint) = crate::workspace_git::capture_checkpoint_before_shutdown(
        data_dir,
        owner,
        &task.input.workspace_path,
        label,
        shutdown,
    )
    .await
    else {
        return false;
    };
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
    true
}

async fn execute_task(
    data_dir: PathBuf,
    owner: String,
    task: TaskRecord,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let admission = tokio::select! {
        biased;
        _ = async {
            while !*shutdown.borrow() {
                if shutdown.changed().await.is_err() {
                    break;
                }
            }
        } => None,
        result = crate::workspace_activity::enter_wait(FsPath::new(&task.input.workspace_path)) => Some(result),
    };
    let _activity = match admission {
        None => {
            interrupt_before_launch(data_dir, owner, task).await;
            return;
        }
        Some(Ok(guard)) => guard,
        Some(Err(error)) => {
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
    if *shutdown.borrow() {
        interrupt_before_launch(data_dir, owner, task).await;
        return;
    }
    let command = crate::v4_agent::owner_task_command(
        &data_dir,
        &owner,
        &task.input.provider,
        &task.input.prompt,
        task.input.model.as_deref(),
        FsPath::new(&task.input.workspace_path),
    );
    match command {
        Ok(command) => {
            if !save_task_checkpoint(&data_dir, &owner, &task, true, &mut shutdown).await {
                interrupt_before_launch(data_dir, owner, task).await;
                return;
            }
            run_command_inner(
                data_dir.clone(),
                owner.clone(),
                task.clone(),
                command,
                shutdown.clone(),
            )
            .await;
            save_task_checkpoint(&data_dir, &owner, &task, false, &mut shutdown).await;
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
        let directory = data_dir.clone();
        let user = owner.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _guard = STORE_LOCK
                .lock()
                .map_err(|_| ApiError::internal("Task storage unavailable"))?;
            let _file_guard = store_file_lock(&directory)?;
            let mut store = read_store(&directory, &user)?;
            let existing = store
                .tasks
                .iter_mut()
                .find(|task| task.id == saved.id)
                .ok_or_else(not_found)?;
            merge_completion(existing, saved);
            write_store(&directory, &store)
        })
        .await;
        if result.is_ok_and(|result| result.is_ok()) {
            return;
        }
        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt + 1))).await;
        }
    }
    tracing::error!(task_id = %record.id, "Task finished but its owner store could not be saved; attempting a completion receipt.");
    persist_completion_receipt(data_dir, owner, record).await;
}

async fn persist_completion_receipt(data_dir: PathBuf, owner: String, record: TaskRecord) {
    loop {
        let directory = data_dir.clone();
        let user = owner.clone();
        let saved = record.clone();
        let compact = compact_receipt(&saved);
        if tokio::task::spawn_blocking(move || {
            retain_completion(&directory, &user, saved.clone())
                .or_else(|_| retain_completion(&directory, &user, compact))
                .or_else(|_| append_outcome_journal(&directory, &user, &saved))
        })
        .await
        .is_ok_and(|result| result.is_ok())
        {
            return;
        }
        tracing::error!(task_id = %record.id, "Completion receipt could not be saved; retaining worker ownership until storage is restored.");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn interrupt_before_launch(data_dir: PathBuf, owner: String, mut task: TaskRecord) {
    task.error = Some("Server stopped before native agent launch.".into());
    transition(
        &mut task,
        TaskStatus::Interrupted,
        "Task interrupted by server shutdown",
        now_ms(),
    );
    persist_completion_receipt(data_dir, owner, task).await;
}

use crate::process_tree::ProcessTree;

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
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let id = task.id;
    if *shutdown.borrow() {
        interrupt_before_launch(data_dir, owner, task).await;
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
    let spawned = {
        let _gate = LAUNCH_GATE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *shutdown.borrow() {
            None
        } else {
            Some(command.spawn())
        }
    };
    let Some(spawned) = spawned else {
        interrupt_before_launch(data_dir, owner, task).await;
        return;
    };
    let mut child = match spawned {
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
    #[cfg(unix)]
    let tree = ProcessTree::attach_new_process_group(&child);
    #[cfg(windows)]
    let tree = ProcessTree::attach(&child);
    let process_tree = match tree {
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
    let mut stopping = false;
    let mut shutdown_open = true;
    let mut store_update: Option<
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, ApiError>> + Send>>,
    > = None;
    loop {
        let mut should_stop = false;
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
            status = process_tree.wait(&mut child), if exit_status.is_none() => {
                exit_status = Some(status);
                exited_at = Some(std::time::Instant::now());
                if read_closed { break; }
            }
            changed = shutdown.changed(), if shutdown_open => {
                if changed.is_err() { shutdown_open = false; }
                if *shutdown.borrow() { interrupted = true; should_stop = true; }
            }
            result = async { store_update.as_mut().unwrap().await }, if store_update.is_some() => {
                store_update = None;
                match result {
                    Ok(true) => { cancelled = true; should_stop = true; }
                    Ok(false) => {}
                    Err(_) => { storage_failed = true; should_stop = true; }
                }
            }
            _ = tick.tick() => {
                if store_update.is_none() && exit_status.is_none() {
                    let saved_output = crate::session_search::safe_history_text(&String::from_utf8_lossy(&output));
                    let result = readable_result(&task.input.provider, &String::from_utf8_lossy(&stdout));
                    let directory = data_dir.clone();
                    let user = owner.clone();
                    let was_truncated = truncated;
                    store_update = Some(Box::pin(edit_store(directory, user, move |store| {
                        let record = store.tasks.iter_mut().find(|record| record.id == id).ok_or_else(not_found)?;
                        if !record.status.terminal() && (record.output != saved_output || record.result != result || record.output_truncated != was_truncated) {
                            record.output = saved_output; record.result = result; record.output_truncated = was_truncated; record.updated_at = now_ms();
                        }
                        Ok(record.status == TaskStatus::Cancelling || record.status == TaskStatus::Cancelled)
                    })));
                }
                if started.elapsed() > std::time::Duration::from_secs(1800) && exit_status.is_none() {
                    timed_out = true;
                    should_stop = true;
                }
                if exited_at.is_some_and(|at| at.elapsed() > std::time::Duration::from_secs(1)) { break; }
            }
        }
        if should_stop && !stopping {
            stopping = true;
            if let Err(error) = process_tree.stop(std::time::Duration::from_secs(3)).await {
                tracing::warn!(task_id = %id, %error, "Native tools did not finish controlled cleanup");
                let _ = child.start_kill();
            }
        }
    }
    drop(store_update);
    drop(process_tree);
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
    async fn schedule_capability_is_authenticated_and_side_effect_free() {
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
        let token = crate::auth::issue_access_token(&config.jwt_secret, "owner", "owner");
        let uri = "/api/workspace/schedules/capabilities";
        assert_eq!(
            request(router.clone(), None, "GET", uri, serde_json::Value::Null)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, body) =
            request(router, Some(&token), "GET", uri, serde_json::Value::Null).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::OK,
                serde_json::json!({"advancedTimingProtocolVersion": 1})
            )
        );
        assert!(!config.data_dir.join("workspace-tasks").exists());
    }

    #[tokio::test]
    async fn zero_interval_requires_valid_advanced_timing() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: dir.path().join("data"),
            ..Default::default()
        })
        .unwrap();
        let router = || {
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone())
        };
        let base = serde_json::json!({"workspacePath":dir.path(), "provider":"claude", "prompt":"Review", "name":"Review", "intervalSeconds":0, "enabled":true});
        let calendar =
            serde_json::json!({"hour":9,"minute":0,"weekdays":[1,2,3,4,5],"timeZone":"UTC"});
        for (changes, expected) in [
            (serde_json::json!({"at":calendar}), StatusCode::OK),
            (
                serde_json::json!({"runOnceAt":now_ms() + 60_000}),
                StatusCode::OK,
            ),
            (serde_json::json!({}), StatusCode::BAD_REQUEST),
            (
                serde_json::json!({"at":{"hour":24,"minute":0,"weekdays":[1]}}),
                StatusCode::BAD_REQUEST,
            ),
            (serde_json::json!({"runOnceAt":1}), StatusCode::BAD_REQUEST),
            (
                serde_json::json!({"at":{"hour":9,"minute":0,"weekdays":[1]},"runOnceAt":now_ms() + 60_000}),
                StatusCode::BAD_REQUEST,
            ),
            (
                serde_json::json!({"intervalSeconds":59}),
                StatusCode::BAD_REQUEST,
            ),
            (serde_json::json!({"intervalSeconds":60}), StatusCode::OK),
            (
                serde_json::json!({"intervalSeconds":2_592_000}),
                StatusCode::OK,
            ),
            (
                serde_json::json!({"intervalSeconds":2_592_001}),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let mut input = base.clone();
            input
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            let (status, body) = request(
                router(),
                None,
                "POST",
                "/api/workspace/schedules",
                input.clone(),
            )
            .await;
            assert_eq!(status, expected, "input: {input}, response: {body}");
            if status == StatusCode::OK && input.get("at").is_some() {
                assert_eq!(body["intervalSeconds"], 0);
                let at: CalendarTime = serde_json::from_value(input["at"].clone()).unwrap();
                assert_eq!(
                    body["nextRunAt"].as_u64(),
                    Some(next_calendar_run(body["createdAt"].as_u64().unwrap(), &at))
                );
            }
        }
        assert_eq!(
            read_store(&state.config().data_dir, "owner")
                .unwrap()
                .schedules
                .len(),
            4
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn direct_one_shot_expiring_while_waiting_for_store_lock_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let file_guard = store_file_lock(&data_dir).unwrap();
        let input: ScheduleInput = serde_json::from_value(serde_json::json!({"workspacePath": dir.path(), "provider":"claude", "prompt":"Review", "name":"Once", "runOnceAt": now_ms() + 700, "enabled":false})).unwrap();
        let path = data_dir.clone();
        let task =
            tokio::spawn(async move { create_owner_schedule(path, "owner".into(), input).await });
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        drop(file_guard);
        assert!(task.await.unwrap().is_err());
        assert!(read_store(&data_dir, "owner").unwrap().schedules.is_empty());
    }

    #[tokio::test]
    async fn waiting_worker_takes_over_after_lease_release() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: dir.path().join("data"),
            ..Default::default()
        })
        .unwrap();
        let path = state.config().data_dir.clone();
        let lease = worker_lease(&path).unwrap();
        assert!(start_worker(state));
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        assert!(worker_lease(&path).is_err());
        drop(lease);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if worker_lease(&path).is_err() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("waiting worker did not acquire lease");
        let key = path.canonicalize().unwrap_or(path);
        WORKERS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .send(true)
            .unwrap();
    }

    #[tokio::test]
    async fn one_shot_routes_validate_and_scope_durable_creation_and_triggering() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data_dir.clone(),
            ..Default::default()
        })
        .unwrap();
        let router = |owner: &str| {
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: owner.into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone())
        };
        let mut input = serde_json::json!({"workspacePath": dir.path(), "provider":"claude", "prompt":"Review", "name":"Once", "runOnceAt": now_ms() + 60_000, "enabled":true});
        let (status, schedule) = request(
            router("owner"),
            None,
            "POST",
            "/api/workspace/schedules",
            input.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(read_store(&data_dir, "owner").unwrap().schedules.len(), 1);
        assert!(read_store(&data_dir, "other").unwrap().schedules.is_empty());
        let id = schedule["id"].as_str().unwrap();
        let run = format!("/api/workspace/schedules/{id}/run");
        assert_eq!(
            request(router("other"), None, "POST", &run, serde_json::Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(router("owner"), None, "POST", &run, serde_json::Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(router("owner"), None, "POST", &run, serde_json::Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(
                router("owner"),
                None,
                "PATCH",
                &format!("/api/workspace/schedules/{id}"),
                serde_json::json!({"enabled":true})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let persisted = read_store(&data_dir, "owner").unwrap();
        assert_eq!(
            (
                persisted.tasks.len(),
                persisted.schedules[0].enabled,
                persisted.schedules[0].next_run_at
            ),
            (1, false, None)
        );
        input["runOnceAt"] = 1.into();
        assert_eq!(
            request(
                router("owner"),
                None,
                "POST",
                "/api/workspace/schedules",
                input.clone()
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        input.as_object_mut().unwrap().remove("runOnceAt");
        input["intervalSeconds"] = 60.into();
        input["at"] =
            serde_json::json!({"hour":9,"minute":0,"weekdays":[1],"timeZone":"Not/A_Zone"});
        assert_eq!(
            request(
                router("owner"),
                None,
                "POST",
                "/api/workspace/schedules",
                input
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn repeated_enable_preserves_a_due_recurring_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data_dir.clone(),
            ..Default::default()
        })
        .unwrap();
        let router = || {
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone())
        };
        let (status, schedule) = request(router(), None, "POST", "/api/workspace/schedules", serde_json::json!({"workspacePath": dir.path(), "provider":"claude", "prompt":"Review", "name":"Review", "intervalSeconds":60, "enabled":true})).await;
        assert_eq!(status, StatusCode::OK);
        let id = schedule["id"].as_str().unwrap();
        let mut store = read_store(&data_dir, "owner").unwrap();
        store.schedules[0].next_run_at = Some(1);
        write_store(&data_dir, &store).unwrap();
        for _ in 0..2 {
            let (status, updated) = request(
                router(),
                None,
                "PATCH",
                &format!("/api/workspace/schedules/{id}"),
                serde_json::json!({"enabled":true}),
            )
            .await;
            assert_eq!(
                (status, updated["nextRunAt"].as_u64()),
                (StatusCode::OK, Some(1))
            );
        }
        let mut store = read_store(&data_dir, "owner").unwrap();
        queue_due_schedules(&mut store, now_ms(), |_| true);
        assert_eq!(store.tasks.len(), 1);
    }

    #[tokio::test]
    async fn expired_paused_one_shot_cannot_be_enabled_but_can_run_now() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data_dir.clone(),
            ..Default::default()
        })
        .unwrap();
        let router = || {
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone())
        };
        let (_, schedule) = request(router(), None, "POST", "/api/workspace/schedules", serde_json::json!({"workspacePath": dir.path(), "provider":"claude", "prompt":"Review", "name":"Once", "runOnceAt": now_ms() + 60_000, "enabled":false})).await;
        let id = schedule["id"].as_str().unwrap();
        let mut store = read_store(&data_dir, "owner").unwrap();
        store.schedules[0].run_once_at = Some(1);
        write_store(&data_dir, &store).unwrap();
        let (status, error) = request(
            router(),
            None,
            "PATCH",
            &format!("/api/workspace/schedules/{id}"),
            serde_json::json!({"enabled":true}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"].as_str().unwrap().contains("Run now"));
        let store = read_store(&data_dir, "owner").unwrap();
        assert_eq!(
            (
                store.schedules[0].enabled,
                store.schedules[0].next_run_at,
                store.tasks.len()
            ),
            (false, None, 0)
        );
        assert_eq!(
            request(
                router(),
                None,
                "POST",
                &format!("/api/workspace/schedules/{id}/run"),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(read_store(&data_dir, "owner").unwrap().tasks.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_alias_filters_keep_canonical_tasks_schedules_and_unavailable_results() {
        #[cfg(target_os = "macos")]
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        #[cfg(not(target_os = "macos"))]
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&workspace, &alias).unwrap();
        let canonical = std::fs::canonicalize(&workspace)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: dir.path().join("data"),
            ..Default::default()
        })
        .unwrap();
        let router = routes()
            .layer(Extension(AuthenticatedUser {
                user_id: "alias-owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let input = serde_json::json!({"workspacePath": alias, "provider":"deepseek", "prompt":"Synthetic intent only"});
        let (status, task) = request(
            router.clone(),
            None,
            "POST",
            "/api/workspace/tasks",
            input.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(task["workspacePath"], canonical);
        let mut schedule_input = input;
        schedule_input["name"] = "Paused fixture".into();
        schedule_input["intervalSeconds"] = 60.into();
        schedule_input["enabled"] = false.into();
        let (status, schedule) = request(
            router.clone(),
            None,
            "POST",
            "/api/workspace/schedules",
            schedule_input,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(schedule["workspacePath"], canonical);
        // No worker is started: listing must never execute the queued intent.
        for path in [
            canonical.clone(),
            alias.to_string_lossy().into_owned(),
            format!("{}/", workspace.display()),
        ] {
            let uri = format!(
                "/api/workspace/tasks?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("path", &path)
                    .finish()
            );
            let (status, result) =
                request(router.clone(), None, "GET", &uri, serde_json::Value::Null).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                (result["tasks"].clone(), result["schedules"].clone()),
                (
                    serde_json::json!([task.clone()]),
                    serde_json::json!([schedule.clone()])
                ),
                "filter: {path}"
            );
        }
        std::fs::remove_dir(&workspace).unwrap();
        for (path, expected) in [
            (canonical.as_str(), 1),
            (alias.to_str().unwrap(), 0),
            ("/unavailable-distinct-workspace", 0),
        ] {
            let uri = format!(
                "/api/workspace/tasks?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("path", path)
                    .finish()
            );
            let (status, result) =
                request(router.clone(), None, "GET", &uri, serde_json::Value::Null).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                (
                    result["tasks"].as_array().unwrap().len(),
                    result["schedules"].as_array().unwrap().len()
                ),
                (expected, expected)
            );
        }
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
        let input = serde_json::json!({ "workspacePath": dir.path().to_string_lossy(), "provider": "deepseek", "prompt": "Inspect only", "parentSessionId": "ss-parent" });
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

#[cfg(all(test, windows))]
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
                provider: "deepseek".into(),
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
        let mut command =
            tokio::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
        command.args(["-c", "import sys,time; print('local fixture',flush=True); time.sleep(float(sys.argv[1])); sys.exit(int(sys.argv[2]))", &seconds.to_string(), &exit.to_string()]);
        run_command(data_dir.into(), owner.into(), task, command).await;
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_stops_process_even_when_store_is_locked() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let task = fixture(dir.path(), "locked-owner");
        let marker = dir.path().join("pid");
        let mut command = tokio::process::Command::new("python3");
        command.args(["-c", "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)"]).arg(&marker);
        let (stop, shutdown) = tokio::sync::watch::channel(false);
        let running = tokio::spawn(run_command_inner(
            dir.path().into(),
            "locked-owner".into(),
            task,
            command,
            shutdown,
        ));
        let pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(contents) = std::fs::read_to_string(&marker) {
                    if let Ok(pid) = contents.parse::<i32>() {
                        if pid > 0 {
                            break pid;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let lock = store_file_lock(dir.path()).unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await;
        stop.send(true).unwrap();
        let stopped = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let system = sysinfo::System::new_all();
                if !system
                    .process(sysinfo::Pid::from_u32(pid as u32))
                    .is_some_and(|p| p.status() != sysinfo::ProcessStatus::Zombie)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .is_ok();
        drop(lock);
        tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap();
        assert!(stopped, "shutdown was blocked by the store lock");
        assert_eq!(
            read_store(dir.path(), "locked-owner").unwrap().tasks[0].status,
            TaskStatus::Interrupted
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rapid_root_exit_does_not_leave_owned_group_child() {
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let task = fixture(dir.path(), "rapid-owner");
        let marker = dir.path().join("pid");
        let mut sibling = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let sibling_pid = sibling.id().unwrap();
        let mut command = tokio::process::Command::new("python3");
        command.args(["-c", "import pathlib,subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); pathlib.Path(sys.argv[1]).write_text(str(p.pid))"]).arg(&marker);
        run_command(dir.path().into(), "rapid-owner".into(), task, command).await;
        let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
        let gone = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let system = sysinfo::System::new_all();
                if !system
                    .process(sysinfo::Pid::from_u32(pid as u32))
                    .is_some_and(|p| p.status() != sysinfo::ProcessStatus::Zombie)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .is_ok();
        let sibling_alive =
            sibling.try_wait().unwrap().is_none() && sibling.id() == Some(sibling_pid);
        if !gone {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        sibling.kill().await.unwrap();
        assert!(gone, "owned group child survived root exit");
        assert!(sibling_alive, "unrelated process was stopped");
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
            let mut command =
                tokio::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
            command.args(["-c", "import sys; print(sys.argv[1])", event]);
            run_command(dir.path().into(), "protocol-owner".into(), task, command).await;
            let store = read_store(dir.path(), "protocol-owner").unwrap();
            assert_eq!(
                (store.tasks[0].status.clone(), store.tasks[0].exit_code),
                (TaskStatus::Failed, Some(0))
            );
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_and_shutdown_stop_separate_groups_and_allow_agent_cleanup() {
        for shutdown_requested in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let task = fixture(dir.path(), "detached-tree-owner");
            let id = task.id;
            let pid_file = dir.path().join("descendants.json");
            let cleanup_file = dir.path().join("agent-cleanup.txt");
            let script = dir.path().join("fixture.py");
            std::fs::write(&script, r#"
import json, os, pathlib, signal, subprocess, sys, time
if len(sys.argv) > 3:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    grandchild = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
    pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(), grandchild.pid]))
    while True: time.sleep(1)
child = subprocess.Popen([sys.executable, __file__, sys.argv[1], sys.argv[2], 'child'], start_new_session=True)
def cleanup(*_):
    pathlib.Path(sys.argv[2]).write_text('agent cleanup ran')
    sys.exit(0)
signal.signal(signal.SIGTERM, cleanup)
while True: time.sleep(1)
"#).unwrap();
            let mut command = tokio::process::Command::new("python3");
            command.arg(&script).arg(&pid_file).arg(&cleanup_file);
            let (stop, shutdown) = tokio::sync::watch::channel(false);
            let running = tokio::spawn(run_command_inner(
                dir.path().into(),
                "detached-tree-owner".into(),
                task,
                command,
                shutdown,
            ));
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while std::fs::read(&pid_file)
                    .ok()
                    .and_then(|value| serde_json::from_slice::<Vec<u32>>(&value).ok())
                    .is_none()
                {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            })
            .await
            .unwrap();
            let pids: Vec<u32> =
                serde_json::from_slice(&std::fs::read(&pid_file).unwrap()).unwrap();
            if shutdown_requested {
                stop.send(true).unwrap();
            } else {
                edit_store(
                    dir.path().into(),
                    "detached-tree-owner".into(),
                    move |store| {
                        cancel_record(
                            store.tasks.iter_mut().find(|t| t.id == id).unwrap(),
                            now_ms(),
                        );
                        Ok(())
                    },
                )
                .await
                .unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(8), running)
                .await
                .unwrap()
                .unwrap();
            let mut system = sysinfo::System::new();
            system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(
                    &pids
                        .iter()
                        .copied()
                        .map(sysinfo::Pid::from_u32)
                        .collect::<Vec<_>>(),
                ),
                true,
                sysinfo::ProcessRefreshKind::nothing(),
            );
            let survivors: Vec<u32> = pids
                .iter()
                .copied()
                .filter(|pid| {
                    system
                        .process(sysinfo::Pid::from_u32(*pid))
                        .is_some_and(|p| p.status() != sysinfo::ProcessStatus::Zombie)
                })
                .collect();
            for pid in &survivors {
                unsafe {
                    libc::kill(*pid as i32, libc::SIGKILL);
                }
            }
            assert!(
                survivors.is_empty(),
                "Separate-group tools survived controlled stop: {survivors:?}"
            );
            assert_eq!(
                std::fs::read_to_string(&cleanup_file).unwrap(),
                "agent cleanup ran"
            );
            assert_eq!(
                read_store(dir.path(), "detached-tree-owner").unwrap().tasks[0].status,
                if shutdown_requested {
                    TaskStatus::Interrupted
                } else {
                    TaskStatus::Cancelled
                }
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
            let mut command =
                tokio::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
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
                while std::fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|value| value.parse::<u32>().ok())
                    .is_none()
                {
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

#[cfg(test)]
mod reviewed_schedule_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    async fn prepare(data: &FsPath, workspace: &FsPath) -> ReviewedSchedule {
        prepare_reviewed_schedule(
            data.into(),
            "owner".into(),
            "session".into(),
            "turn".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Review workspace".into(),
                    model: Some("gpt-4.1".into()),
                    parent_session_id: Some("session".into()),
                    parent_task_id: None,
                },
                name: "Review".into(),
                interval_seconds: 60,
                enabled: true,
                at: None,
                run_once_at: None,
                deliver_to: None,
            },
            None,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn reviewed_calendar_zero_interval_requires_valid_timing_and_scope() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let base = serde_json::json!({"workspacePath": workspace.path(), "provider":"openai-api", "prompt":"Review", "parentSessionId":"session", "name":"Review", "intervalSeconds":0, "enabled":true});
        for (changes, accepted) in [
            (
                serde_json::json!({"at":{"hour":9,"minute":0,"weekdays":[1],"timeZone":"UTC"}}),
                true,
            ),
            (serde_json::json!({"runOnceAt":now_ms() + 60_000}), true),
            (serde_json::json!({}), false),
            (
                serde_json::json!({"at":{"hour":24,"minute":0,"weekdays":[1]}}),
                false,
            ),
            (
                serde_json::json!({"at":{"hour":9,"minute":0,"weekdays":[1]},"parentSessionId":"other"}),
                false,
            ),
        ] {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            let input: ScheduleInput = serde_json::from_value(value.clone()).unwrap();
            let result = prepare_reviewed_schedule(
                data.path().into(),
                "owner".into(),
                "session".into(),
                "turn".into(),
                input,
                None,
            )
            .await;
            assert_eq!(result.is_ok(), accepted, "input: {value}");
        }
        assert!(read_store(data.path(), "owner")
            .unwrap()
            .schedules
            .is_empty());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_while_waiting_for_store_lock_and_expiry_do_not_mutate() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let reviewed = prepare(data.path(), workspace.path()).await;
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let guard = STORE_LOCK.lock().unwrap();
        let task = tokio::spawn(commit_reviewed_schedule(
            reviewed,
            now_ms() as i64 + 60_000,
            move || flag.load(Ordering::SeqCst),
        ));
        cancelled.store(true, Ordering::SeqCst);
        drop(guard);
        assert!(task.await.unwrap().is_err());
        let expired = prepare(data.path(), workspace.path()).await;
        assert!(
            commit_reviewed_schedule(expired, now_ms() as i64 - 1, || false)
                .await
                .is_err()
        );
        let mut stale = prepare(data.path(), workspace.path()).await;
        stale.schedule.next_run_at = Some(now_ms());
        assert!(
            commit_reviewed_schedule(stale, now_ms() as i64 + 60_000, || false)
                .await
                .is_err()
        );
        assert!(read_store(data.path(), "owner")
            .unwrap()
            .schedules
            .is_empty());
    }
    #[tokio::test]
    async fn cancellation_after_commit_boundary_reports_the_persisted_result() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let reviewed = prepare(data.path(), workspace.path()).await;
        let flag = Arc::new(AtomicBool::new(false));
        let after_check = flag.clone();
        let saved = commit_reviewed_schedule(reviewed, now_ms() as i64 + 60_000, move || {
            after_check.store(true, Ordering::SeqCst);
            false
        })
        .await
        .unwrap();
        assert!(flag.load(Ordering::SeqCst));
        assert_eq!(
            serde_json::to_value(&read_store(data.path(), "owner").unwrap().schedules).unwrap(),
            serde_json::json!([saved])
        );
        assert!(read_store(data.path(), "other")
            .unwrap()
            .schedules
            .is_empty());
    }
    #[tokio::test]
    async fn persistence_failure_does_not_report_a_saved_schedule() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let invalid_root = data.path().join("file");
        std::fs::write(&invalid_root, "fixture").unwrap();
        let reviewed = prepare(&invalid_root, workspace.path()).await;
        assert!(
            commit_reviewed_schedule(reviewed, now_ms() as i64 + 60_000, || false)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(invalid_root).unwrap(), "fixture");
    }
}

#[cfg(test)]
#[path = "workspace_tasks/schedule_cron_tests.rs"]
mod schedule_cron_tests;

#[cfg(all(test, unix))]
#[path = "workspace_tasks/worker_process_tests.rs"]
mod worker_process_tests;
