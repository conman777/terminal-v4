use crate::ApiError;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const TAIL_LINES: usize = 20;
const LINE_CHARS: usize = 300;
const MAX_ENTRIES: usize = 128;
const FINISHED_TTL: Duration = Duration::from_secs(900);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StageStatus {
    Pending,
    Running,
    Done,
    Failed,
    Warning,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RunStatus {
    Running,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stage {
    pub id: &'static str,
    pub label: &'static str,
    pub status: StageStatus,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressSnapshot {
    pub operation_id: Uuid,
    pub status: RunStatus,
    pub cancelling: bool,
    pub stages: Vec<Stage>,
    pub tail: Vec<String>,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    pub cleanup: Option<String>,
    pub cleaned: Option<bool>,
}

struct Inner {
    status: RunStatus,
    stages: Vec<Stage>,
    tail: VecDeque<String>,
    error: Option<String>,
    cleanup: Option<String>,
    cleaned: Option<bool>,
    finished: Option<Instant>,
}

pub(crate) struct WorktreeProgress {
    id: Uuid,
    started: Instant,
    cancel: CancellationToken,
    inner: Mutex<Inner>,
}

fn stage(id: &'static str, label: &'static str) -> Stage {
    Stage {
        id,
        label,
        status: StageStatus::Pending,
        detail: None,
    }
}

fn clean_line(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(LINE_CHARS)
        .collect()
}

impl WorktreeProgress {
    pub(crate) fn new(id: Uuid) -> Arc<Self> {
        Arc::new(Self {
            id,
            started: Instant::now(),
            cancel: CancellationToken::new(),
            inner: Mutex::new(Inner {
                status: RunStatus::Running,
                stages: vec![
                    stage("base", "Checking base"),
                    stage("checkout", "Creating worktree"),
                    stage("setup", "Setup script"),
                ],
                tail: VecDeque::new(),
                error: None,
                cleanup: None,
                cleaned: None,
                finished: None,
            }),
        })
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub(crate) fn cancel(&self) -> bool {
        let running = self.lock().status == RunStatus::Running;
        if running {
            self.cancel.cancel();
        }
        running
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn set_stage(&self, id: &str, status: StageStatus, detail: Option<String>) {
        let mut inner = self.lock();
        if let Some(stage) = inner.stages.iter_mut().find(|s| s.id == id) {
            stage.status = status;
            if detail.is_some() {
                stage.detail = detail.map(|d| clean_line(&d));
            }
        }
    }

    pub(crate) fn push_line(&self, raw: &str) {
        let line = clean_line(raw);
        if line.trim().is_empty() {
            return;
        }
        let mut inner = self.lock();
        if inner.tail.len() == TAIL_LINES {
            inner.tail.pop_front();
        }
        inner.tail.push_back(line);
    }

    pub(crate) fn last_line(&self) -> Option<String> {
        self.lock().tail.back().cloned()
    }

    pub(crate) fn set_cleanup(&self, cleaned: bool, note: String) {
        let mut inner = self.lock();
        inner.cleaned = Some(cleaned);
        inner.cleanup = Some(clean_line(&note));
    }

    pub(crate) fn finish(&self, status: RunStatus, error: Option<String>) {
        let mut inner = self.lock();
        if inner.status != RunStatus::Running {
            return;
        }
        inner.status = status;
        inner.error = error.map(|e| clean_line(&e));
        inner.finished = Some(Instant::now());
        let failing = match status {
            RunStatus::Failed => Some(StageStatus::Failed),
            RunStatus::Cancelled => Some(StageStatus::Cancelled),
            _ => None,
        };
        for stage in inner.stages.iter_mut() {
            match (stage.status, failing) {
                (StageStatus::Running, Some(next)) => stage.status = next,
                (StageStatus::Pending, Some(_)) => stage.status = StageStatus::Skipped,
                (StageStatus::Pending, None) => stage.status = StageStatus::Skipped,
                _ => {}
            }
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.lock().status == RunStatus::Running
    }

    pub(crate) fn snapshot(&self) -> ProgressSnapshot {
        let inner = self.lock();
        ProgressSnapshot {
            operation_id: self.id,
            status: inner.status,
            cancelling: inner.status == RunStatus::Running && self.cancel.is_cancelled(),
            stages: inner.stages.clone(),
            tail: inner.tail.iter().cloned().collect(),
            elapsed_ms: inner
                .finished
                .unwrap_or_else(Instant::now)
                .duration_since(self.started)
                .as_millis() as u64,
            error: inner.error.clone(),
            cleanup: inner.cleanup.clone(),
            cleaned: inner.cleaned,
        }
    }
}

type Registry = HashMap<(String, Uuid), Arc<WorktreeProgress>>;

static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

fn with_registry<T>(f: impl FnOnce(&mut Registry) -> T) -> T {
    let mut guard = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

pub(crate) fn begin(owner: &str, id: Uuid) -> Result<Arc<WorktreeProgress>, ApiError> {
    with_registry(|map| {
        if let Some(existing) = map.get(&(owner.to_string(), id)) {
            if existing.is_running() {
                return Err(ApiError {
                    status: axum::http::StatusCode::CONFLICT,
                    message: "This worktree request is already running.".into(),
                });
            }
        }
        map.retain(|_, entry| {
            entry
                .lock()
                .finished
                .is_none_or(|at| at.elapsed() < FINISHED_TTL)
        });
        if map.len() >= MAX_ENTRIES && !map.contains_key(&(owner.to_string(), id)) {
            return Err(ApiError::bad_request(
                "Too many worktree requests are tracked. Try again shortly.",
            ));
        }
        let progress = WorktreeProgress::new(id);
        map.insert((owner.to_string(), id), progress.clone());
        Ok(progress)
    })
}

pub(crate) fn lookup(owner: &str, id: Uuid) -> Option<Arc<WorktreeProgress>> {
    with_registry(|map| map.get(&(owner.to_string(), id)).cloned())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunEnd {
    Success,
    Failed(Option<i32>),
    Cancelled,
    TimedOut,
}

async fn pump(stream: impl AsyncRead + Unpin, progress: Arc<WorktreeProgress>) {
    let mut stream = stream;
    let mut buffer = [0u8; 4096];
    let mut line = String::new();
    let mut overflow = false;
    loop {
        let count = match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for ch in String::from_utf8_lossy(&buffer[..count]).chars() {
            if ch == '\n' || ch == '\r' {
                if !line.is_empty() {
                    progress.push_line(&line);
                }
                line.clear();
                overflow = false;
            } else if !overflow {
                line.push(ch);
                if line.chars().count() >= LINE_CHARS {
                    overflow = true;
                }
            }
        }
    }
    if !line.is_empty() {
        progress.push_line(&line);
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
}
#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

pub(crate) async fn run_streamed(
    mut command: tokio::process::Command,
    progress: &Arc<WorktreeProgress>,
    timeout: Duration,
) -> Result<RunEnd, ApiError> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| ApiError::internal("Unable to start the worktree process"))?;
    let pid = child.id();
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|s| tokio::spawn(pump(s, progress.clone()))),
        child
            .stderr
            .take()
            .map(|s| tokio::spawn(pump(s, progress.clone()))),
    ]
    .into_iter()
    .flatten()
    .collect();
    let token = progress.token();
    let end = tokio::select! {
        status = child.wait() => match status {
            Ok(status) if status.success() => RunEnd::Success,
            Ok(status) => RunEnd::Failed(status.code()),
            Err(_) => RunEnd::Failed(None),
        },
        _ = token.cancelled() => RunEnd::Cancelled,
        _ = tokio::time::sleep(timeout) => RunEnd::TimedOut,
    };
    kill_group(pid);
    if end != RunEnd::Success && end != RunEnd::Failed(None) {
        let _ = child.wait().await;
    }
    for reader in readers {
        let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
    }
    Ok(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_is_bounded_and_control_characters_are_removed() {
        let progress = WorktreeProgress::new(Uuid::new_v4());
        for index in 0..(TAIL_LINES + 5) {
            progress.push_line(&format!("line {index}\u{1b}[0m"));
        }
        progress.push_line(&"x".repeat(LINE_CHARS * 3));
        let snapshot = progress.snapshot();
        assert_eq!(
            (
                snapshot.tail.len(),
                snapshot.tail[0].clone(),
                snapshot.tail.last().unwrap().chars().count()
            ),
            (TAIL_LINES, "line 6[0m".to_string(), LINE_CHARS)
        );
    }

    #[test]
    fn registry_is_owner_scoped_and_rejects_a_running_duplicate() {
        let id = Uuid::new_v4();
        let first = begin("alice", id).unwrap();
        assert!(begin("alice", id).is_err());
        assert!(lookup("bob", id).is_none());
        assert!(lookup("alice", id).is_some());
        first.finish(RunStatus::Ready, None);
        assert!(begin("alice", id).is_ok());
    }

    #[test]
    fn cancelling_a_finished_run_changes_nothing() {
        let progress = WorktreeProgress::new(Uuid::new_v4());
        progress.finish(RunStatus::Ready, None);
        assert!(!progress.cancel());
        assert!(!progress.snapshot().cancelling);
    }

    #[tokio::test]
    async fn cancelling_kills_the_whole_process_group() {
        let progress = WorktreeProgress::new(Uuid::new_v4());
        let marker = tempfile::tempdir().unwrap();
        let file = marker.path().join("survivor");
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg(format!(
            "echo started; (sleep 2; echo alive > '{}') & sleep 30",
            file.display()
        ));
        let canceller = progress.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            canceller.cancel();
        });
        let end = run_streamed(command, &progress, Duration::from_secs(20))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert_eq!(
            (end, progress.last_line(), file.exists()),
            (RunEnd::Cancelled, Some("started".to_string()), false)
        );
    }
}
