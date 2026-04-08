use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;

#[cfg(not(windows))]
use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use terminal_v4_core::{
    AppConfig, TerminalSandboxInfo, TerminalSessionSnapshot, TerminalSessionSummary,
    TerminalStreamEvent, ThreadMetadata,
};

use crate::state::HistoryQuery;

const DEFAULT_COLS: i64 = 120;
const DEFAULT_ROWS: i64 = 32;
const OUTPUT_BUFFER_SIZE: usize = 4096;
const BATCH_SIZE_THRESHOLD: usize = 4096;
const BATCH_TIME_MS: u64 = 16;

#[derive(Debug, Clone)]
pub struct TerminalCreateOptions {
    pub cwd: Option<String>,
    pub cols: Option<i64>,
    pub rows: Option<i64>,
    pub title: Option<String>,
    pub shell: Option<String>,
    pub initial_command: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TerminalResizeResult {
    pub current_cols: i64,
    pub current_rows: i64,
    pub owner_client_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadUpdate {
    pub topic: Option<Option<String>>,
    pub topic_auto_generated: Option<bool>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub project_path: Option<Option<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjectInfo {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_path: Option<String>,
    pub git_branch: Option<String>,
}

#[derive(Debug, Clone)]
pub enum TerminalSubscriptionEvent {
    Output(TerminalStreamEvent),
    Closed,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<TerminalManagerInner>,
}

struct TerminalManagerInner {
    config: AppConfig,
    counter: AtomicUsize,
    sessions: Mutex<HashMap<String, Arc<LiveSession>>>,
}

struct LiveSession {
    state: Mutex<LiveSessionState>,
    io: PtySessionIo,
    broadcaster: broadcast::Sender<TerminalSubscriptionEvent>,
    batcher: Mutex<OutputBatcher>,
}

#[derive(Clone)]
#[cfg(not(windows))]
struct PtySessionIo {
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    killer: Arc<StdMutex<Box<dyn ChildKiller + Send + Sync>>>,
}

#[derive(Clone)]
#[cfg(windows)]
struct PtySessionIo {
    process: Arc<StdMutex<conpty::Process>>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
}

struct LiveSessionState {
    id: String,
    user_id: String,
    title: String,
    shell: String,
    cwd: String,
    created_at: String,
    updated_at: String,
    history: Vec<TerminalStreamEvent>,
    next_seq: i64,
    current_cols: i64,
    current_rows: i64,
    primary_client_id: Option<String>,
    client_dimensions: HashMap<String, ClientDimensions>,
    sandbox: Option<TerminalSandboxInfo>,
    thread: Option<ThreadMetadata>,
    is_busy: bool,
    last_activity_at: i64,
    uses_tmux: bool,
}

/// Coalesces rapid PTY output into fewer broadcasts.
///
/// Flushes when the buffer exceeds `BATCH_SIZE_THRESHOLD` bytes or after
/// `BATCH_TIME_MS` milliseconds of quiet, whichever comes first.
struct OutputBatcher {
    buffer: String,
    flush_handle: Option<tokio::task::JoinHandle<()>>,
}

impl OutputBatcher {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            flush_handle: None,
        }
    }

    /// Append text to the batch buffer. Returns text to flush if size threshold hit.
    fn append(&mut self, text: &str) -> Option<String> {
        self.buffer.push_str(text);
        if self.buffer.len() >= BATCH_SIZE_THRESHOLD {
            Some(self.take())
        } else {
            None
        }
    }

    fn take(&mut self) -> String {
        std::mem::take(&mut self.buffer)
    }

    fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    fn cancel_timer(&mut self) {
        if let Some(handle) = self.flush_handle.take() {
            handle.abort();
        }
    }
}

#[derive(Clone)]
struct ClientDimensions {
    cols: i64,
    rows: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTerminalSession {
    id: String,
    title: String,
    shell: String,
    cwd: String,
    created_at: String,
    updated_at: String,
    history: Vec<TerminalStreamEvent>,
    #[serde(default)]
    uses_tmux: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox: Option<TerminalSandboxInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread: Option<ThreadMetadata>,
}

#[cfg(not(windows))]
impl PtySessionIo {
    fn new(
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
    ) -> Self {
        Self {
            master: Arc::new(StdMutex::new(master)),
            writer: Arc::new(StdMutex::new(writer)),
            killer: Arc::new(StdMutex::new(killer)),
        }
    }

    async fn write(&self, data: String) -> Result<(), String> {
        let writer = self.writer.clone();
        spawn_blocking_io(move || {
            let mut writer = lock_blocking(writer.as_ref(), "terminal writer")?;
            writer
                .write_all(data.as_bytes())
                .map_err(|error| error.to_string())?;
            writer.flush().map_err(|error| error.to_string())
        })
        .await
    }

    async fn resize(&self, cols: i64, rows: i64) -> Result<(), String> {
        let master = self.master.clone();
        let size = pty_size(cols, rows)?;
        spawn_blocking_io(move || {
            let master = lock_blocking(master.as_ref(), "terminal master")?;
            master.resize(size).map_err(|error| error.to_string())
        })
        .await
    }

    async fn kill(&self) -> Result<(), String> {
        let killer = self.killer.clone();
        spawn_blocking_io(move || {
            let mut killer = lock_blocking(killer.as_ref(), "terminal killer")?;
            killer.kill().map_err(|error| error.to_string())
        })
        .await
    }

    #[cfg(test)]
    async fn get_size(&self) -> Result<PtySize, String> {
        let master = self.master.clone();
        spawn_blocking_io(move || {
            let master = lock_blocking(master.as_ref(), "terminal master")?;
            master.get_size().map_err(|error| error.to_string())
        })
        .await
    }
}

#[cfg(windows)]
impl PtySessionIo {
    async fn write(&self, data: String) -> Result<(), String> {
        let writer = self.writer.clone();
        let data_len = data.len();
        tracing::debug!("PtySessionIo::write: {} bytes", data_len);
        spawn_blocking_io(move || {
            let mut writer = lock_blocking(writer.as_ref(), "terminal writer")?;
            writer
                .write_all(data.as_bytes())
                .map_err(|error| error.to_string())?;
            writer.flush().map_err(|error| error.to_string())?;
            tracing::debug!("PtySessionIo::write: flushed {} bytes OK", data_len);
            Ok(())
        })
        .await
    }

    async fn resize(&self, cols: i64, rows: i64) -> Result<(), String> {
        let process = self.process.clone();
        spawn_blocking_io(move || {
            let mut process = lock_blocking(process.as_ref(), "terminal process")?;
            process
                .resize(cols as i16, rows as i16)
                .map_err(|error| error.to_string())
        })
        .await
    }

    async fn kill(&self) -> Result<(), String> {
        let process = self.process.clone();
        spawn_blocking_io(move || {
            let mut process = lock_blocking(process.as_ref(), "terminal process")?;
            process.exit(1).map_err(|error| error.to_string())
        })
        .await
    }
}

impl TerminalManager {
    pub fn new(config: AppConfig) -> Self {
        Self {
            inner: Arc::new(TerminalManagerInner {
                config,
                counter: AtomicUsize::new(0),
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Recover orphaned tmux sessions on startup.
    /// Checks for tmux sessions that match our naming convention but don't
    /// have active in-memory sessions. Logs them for awareness.
    pub async fn recover_orphaned_tmux_sessions(&self) {
        if !crate::tmux::is_tmux_available().await {
            return;
        }

        let orphaned = crate::tmux::list_sessions().await;
        if orphaned.is_empty() {
            return;
        }

        let active = self.inner.sessions.lock().await;
        for session_id in &orphaned {
            if !active.contains_key(session_id) {
                tracing::info!(
                    session_id = session_id.as_str(),
                    "Found orphaned tmux session — available for restore"
                );
            }
        }
    }

    pub async fn list_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<TerminalSessionSummary>, String> {
        self.restore_surviving_tmux_sessions(user_id).await?;

        let active_sessions = {
            let sessions = self.inner.sessions.lock().await;
            let mut summaries = Vec::new();
            for session in sessions.values() {
                let state = session.state.lock().await;
                if state.user_id != user_id {
                    continue;
                }

                summaries.push(summary_from_live_state(&state));
            }
            summaries
        };

        let active_ids: HashSet<String> = active_sessions
            .iter()
            .map(|session| session.id.clone())
            .collect();
        let mut merged = active_sessions;
        for persisted in load_persisted_sessions(&self.inner.config, user_id)? {
            if active_ids.contains(&persisted.id) {
                continue;
            }

            merged.push(summary_from_stored(&persisted));
        }

        merged.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(merged)
    }

    pub async fn get_session_history(
        &self,
        user_id: &str,
        session_id: &str,
        query: &HistoryQuery,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };

        if let Some(session) = maybe_active {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(None);
            }

            let history = limit_history(&state.history, query);
            return Ok(Some(TerminalSessionSnapshot {
                id: state.id.clone(),
                title: state.title.clone(),
                shell: state.shell.clone(),
                created_at: state.created_at.clone(),
                updated_at: state.updated_at.clone(),
                history,
                uses_tmux: state.uses_tmux,
                current_cols: Some(state.current_cols),
                current_rows: Some(state.current_rows),
                sandbox: state.sandbox.clone(),
            }));
        }

        let Some(mut persisted) = load_persisted_session(&self.inner.config, user_id, session_id)?
        else {
            return Ok(None);
        };
        ensure_history_sequences(&mut persisted.history);
        let history = limit_history(&persisted.history, query);
        Ok(Some(TerminalSessionSnapshot {
            id: persisted.id,
            title: persisted.title,
            shell: persisted.shell,
            created_at: persisted.created_at,
            updated_at: persisted.updated_at,
            history,
            uses_tmux: persisted.uses_tmux,
            current_cols: None,
            current_rows: None,
            sandbox: persisted.sandbox,
        }))
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        options: TerminalCreateOptions,
    ) -> Result<TerminalSessionSnapshot, String> {
        let id = Uuid::new_v4().to_string();
        let title = options
            .title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| {
                let next = self.inner.counter.fetch_add(1, Ordering::SeqCst) + 1;
                format!("Terminal {next}")
            });
        let uses_tmux = should_use_tmux().await;
        self.spawn_session(
            user_id,
            id,
            title,
            options.cwd,
            options.shell,
            options.cols,
            options.rows,
            Vec::new(),
            options.initial_command,
            uses_tmux,
            false,
        )
        .await
    }

    pub async fn restore_session(
        &self,
        user_id: &str,
        session_id: &str,
        cols: Option<i64>,
        rows: Option<i64>,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(None);
            }
            return Ok(Some(TerminalSessionSnapshot {
                id: state.id.clone(),
                title: state.title.clone(),
                shell: state.shell.clone(),
                created_at: state.created_at.clone(),
                updated_at: state.updated_at.clone(),
                history: state.history.clone(),
                uses_tmux: state.uses_tmux,
                current_cols: Some(state.current_cols),
                current_rows: Some(state.current_rows),
                sandbox: state.sandbox.clone(),
            }));
        }

        let Some(mut persisted) = load_persisted_session(&self.inner.config, user_id, session_id)?
        else {
            return Ok(None);
        };
        ensure_history_sequences(&mut persisted.history);
        let uses_tmux = should_use_tmux().await;
        let has_existing_tmux = uses_tmux && crate::tmux::session_exists(session_id).await;
        if has_existing_tmux {
            if let Some(cwd) = crate::tmux::get_session_cwd(session_id).await {
                persisted.cwd = cwd;
            }
            persisted.history.clear();
        }
        let restored_sandbox = persisted.sandbox.clone();
        let restored_thread = persisted.thread.clone();
        let snapshot = self
            .spawn_session(
                user_id,
                persisted.id,
                persisted.title,
                Some(persisted.cwd),
                Some(persisted.shell),
                cols,
                rows,
                persisted.history,
                None,
                uses_tmux,
                has_existing_tmux,
            )
            .await?;
        let maybe_session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_session {
            let mut state = session.state.lock().await;
            state.sandbox = restored_sandbox;
            state.thread = restored_thread;
        }
        Ok(Some(snapshot))
    }

    pub async fn write(&self, user_id: &str, session_id: &str, input: &str) -> Result<(), String> {
        tracing::debug!("TerminalManager::write session={session_id} input_len={}", input.len());
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| format!("Terminal session {session_id} not found"))?;

        {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Err(format!("Terminal session {session_id} not found"));
            }
        }

        // Try to flush batcher for responsiveness, but don't block if it's busy
        if let Ok(mut batcher) = session.batcher.try_lock() {
            batcher.cancel_timer();
            if !batcher.is_empty() {
                let text = batcher.take();
                drop(batcher);
                let _ = self.record_output(session.clone(), text).await;
            }
        }

        tracing::debug!("TerminalManager::write calling io.write");
        session.io.write(normalize_newlines(input)).await?;

        update_cwd_from_input(&session, input).await;
        Ok(())
    }

    pub async fn resize(
        &self,
        user_id: &str,
        session_id: &str,
        cols: i64,
        rows: i64,
        client_id: Option<String>,
        priority: bool,
    ) -> Result<TerminalResizeResult, String> {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| format!("Terminal session {session_id} not found"))?;

        let mut state = session.state.lock().await;
        if state.user_id != user_id {
            return Err(format!("Terminal session {session_id} not found"));
        }

        let now = now_millis();
        if let Some(client_id) = client_id.clone() {
            state.client_dimensions.insert(
                client_id.clone(),
                ClientDimensions {
                    cols,
                    rows,
                    updated_at: now,
                },
            );
            if priority {
                state.primary_client_id = Some(client_id);
            }
        }
        if state.primary_client_id.is_none() && client_id.is_some() {
            state.primary_client_id = client_id.clone();
        }

        let (target_cols, target_rows) = if let Some(owner) = state.primary_client_id.as_ref() {
            state
                .client_dimensions
                .get(owner)
                .map(|dims| (dims.cols, dims.rows))
                .unwrap_or((cols, rows))
        } else {
            (cols, rows)
        };

        drop(state);
        session.io.resize(target_cols, target_rows).await?;
        let uses_tmux = {
            let state = session.state.lock().await;
            state.uses_tmux
        };
        if uses_tmux {
            if let (Ok(cols), Ok(rows)) = (u16::try_from(target_cols), u16::try_from(target_rows)) {
                let _ = crate::tmux::resize_session(session_id, cols, rows).await;
            }
        }

        let mut state = session.state.lock().await;
        state.current_cols = target_cols;
        state.current_rows = target_rows;
        Ok(TerminalResizeResult {
            current_cols: target_cols,
            current_rows: target_rows,
            owner_client_id: state.primary_client_id.clone(),
        })
    }

    pub async fn remove_client(&self, user_id: &str, session_id: &str, client_id: &str) {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return;
        };

        let mut state = session.state.lock().await;
        if state.user_id != user_id {
            return;
        }

        state.client_dimensions.remove(client_id);
        if state.primary_client_id.as_deref() == Some(client_id) {
            state.primary_client_id = state
                .client_dimensions
                .iter()
                .max_by_key(|(_, dims)| dims.updated_at)
                .map(|(id, _)| id.clone());
        }
    }

    pub async fn close(&self, user_id: &str, session_id: &str) -> Result<bool, String> {
        let session = {
            let mut sessions = self.inner.sessions.lock().await;
            if let Some(session) = sessions.get(session_id) {
                let state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(false);
                }
            }
            sessions.remove(session_id)
        };

        let mut deleted = delete_persisted_session(&self.inner.config, user_id, session_id)?;
        if let Some(session) = session {
            deleted = true;
            let _ = session.broadcaster.send(TerminalSubscriptionEvent::Closed);
            let uses_tmux = {
                let state = session.state.lock().await;
                state.uses_tmux
            };
            if uses_tmux {
                let _ = crate::tmux::kill_session(session_id).await;
            }
            let _ = session.io.kill().await;
        }
        Ok(deleted)
    }

    /// Get git diff stats for the session's working directory.
    pub async fn get_git_stats(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<terminal_v4_core::ThreadGitStats>, String> {
        let cwd = self
            .get_project_info(user_id, session_id)
            .await?
            .map(|info| info.cwd);
        let Some(cwd) = cwd else {
            return Ok(None);
        };
        Ok(crate::git::get_git_diff_stats(&cwd).await)
    }

    /// Run git checkout in the session's working directory.
    pub async fn git_checkout(
        &self,
        user_id: &str,
        session_id: &str,
        branch: &str,
    ) -> Result<crate::git::GitBranchInfo, String> {
        let cwd = self
            .get_project_info(user_id, session_id)
            .await?
            .map(|info| info.cwd)
            .ok_or_else(|| format!("Terminal session {session_id} not found"))?;
        crate::git::git_checkout(&cwd, branch).await?;
        crate::git::list_git_branches(&cwd)
            .await
            .ok_or_else(|| "Failed to list branches after checkout".to_string())
    }

    pub async fn is_active(&self, session_id: &str) -> bool {
        let sessions = self.inner.sessions.lock().await;
        sessions.contains_key(session_id)
    }

    pub async fn subscribe(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<broadcast::Receiver<TerminalSubscriptionEvent>, String> {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| format!("Terminal session {session_id} not found"))?;
        let state = session.state.lock().await;
        if state.user_id != user_id {
            return Err(format!("Terminal session {session_id} not found"));
        }
        tracing::info!("subscribe: session={session_id}, receiver_count={}", session.broadcaster.receiver_count());
        Ok(session.broadcaster.subscribe())
    }

    pub async fn rename_session(
        &self,
        user_id: &str,
        session_id: &str,
        title: &str,
    ) -> Result<Option<TerminalSessionSummary>, String> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err("Session title is required".to_string());
        }

        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let summary = {
                let mut state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(None);
                }
                state.title = trimmed.to_string();
                state.updated_at = iso_timestamp();
                summary_from_live_state(&state)
            };
            persist_session_state(&self.inner.config, &session).await?;
            return Ok(Some(summary));
        }

        let Some(mut persisted) = load_persisted_session(&self.inner.config, user_id, session_id)?
        else {
            return Ok(None);
        };
        persisted.title = trimmed.to_string();
        persisted.updated_at = iso_timestamp();
        save_persisted_session(&self.inner.config, user_id, &persisted)?;
        Ok(Some(summary_from_stored(&persisted)))
    }

    pub async fn get_thread(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<ThreadMetadata>, String> {
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(None);
            }
            return Ok(Some(state.thread.clone().unwrap_or_else(|| {
                default_thread_metadata(state.sandbox.as_ref())
            })));
        }

        let Some(persisted) = load_persisted_session(&self.inner.config, user_id, session_id)?
        else {
            return Ok(None);
        };
        Ok(Some(persisted.thread.unwrap_or_else(|| {
            default_thread_metadata(persisted.sandbox.as_ref())
        })))
    }

    pub async fn update_thread(
        &self,
        user_id: &str,
        session_id: &str,
        updates: ThreadUpdate,
    ) -> Result<Option<ThreadMetadata>, String> {
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let thread = {
                let mut state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(None);
                }

                let mut thread = state
                    .thread
                    .clone()
                    .unwrap_or_else(|| default_thread_metadata(state.sandbox.as_ref()));
                apply_thread_update(&mut thread, updates);
                state.thread = Some(thread.clone());
                state.updated_at = iso_timestamp();
                thread
            };
            persist_session_state(&self.inner.config, &session).await?;
            return Ok(Some(thread));
        }

        let Some(mut persisted) = load_persisted_session(&self.inner.config, user_id, session_id)?
        else {
            return Ok(None);
        };
        let mut thread = persisted
            .thread
            .clone()
            .unwrap_or_else(|| default_thread_metadata(persisted.sandbox.as_ref()));
        apply_thread_update(&mut thread, updates);
        persisted.thread = Some(thread.clone());
        persisted.updated_at = iso_timestamp();
        save_persisted_session(&self.inner.config, user_id, &persisted)?;
        Ok(Some(thread))
    }

    pub async fn detect_project(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<String>, String> {
        let cwd = self
            .get_project_info(user_id, session_id)
            .await?
            .map(|info| info.cwd);
        let Some(cwd) = cwd else {
            return Ok(None);
        };
        let project_path = detect_git_root(&cwd);
        let updated = self
            .update_thread(
                user_id,
                session_id,
                ThreadUpdate {
                    project_path: Some(project_path.clone()),
                    ..ThreadUpdate::default()
                },
            )
            .await?;
        if updated.is_none() {
            return Ok(None);
        }
        Ok(project_path)
    }

    pub async fn get_project_info(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<SessionProjectInfo>, String> {
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(None);
            }
            let project_path = state
                .thread
                .as_ref()
                .and_then(|thread| thread.project_path.clone())
                .or_else(|| detect_git_root(&state.cwd));
            return Ok(Some(build_project_info(
                &state.cwd,
                project_path.as_deref().and_then(detect_git_branch),
            )));
        }

        let Some(persisted) = load_persisted_session(&self.inner.config, user_id, session_id)?
        else {
            return Ok(None);
        };
        let project_path = persisted
            .thread
            .as_ref()
            .and_then(|thread| thread.project_path.clone())
            .or_else(|| detect_git_root(&persisted.cwd));
        Ok(Some(build_project_info(
            &persisted.cwd,
            project_path.as_deref().and_then(detect_git_branch),
        )))
    }

    async fn spawn_session(
        &self,
        user_id: &str,
        id: String,
        title: String,
        cwd: Option<String>,
        shell: Option<String>,
        cols: Option<i64>,
        rows: Option<i64>,
        history: Vec<TerminalStreamEvent>,
        initial_command: Option<String>,
        uses_tmux: bool,
        existing_tmux: bool,
    ) -> Result<TerminalSessionSnapshot, String> {
        let created_at = iso_timestamp();
        let cwd = resolve_cwd(cwd.as_deref());
        let shell = shell.unwrap_or_else(detect_shell);
        let (shell_path, shell_args) = shell_command(&shell);

        let mut history = history;
        let next_seq = ensure_history_sequences(&mut history);
        let current_cols = cols.unwrap_or(DEFAULT_COLS);
        let current_rows = rows.unwrap_or(DEFAULT_ROWS);
        let (io, reader, child) = if uses_tmux {
            let cols = u16::try_from(current_cols)
                .map_err(|_| format!("Terminal columns {current_cols} are outside tmux range"))?;
            let rows = u16::try_from(current_rows)
                .map_err(|_| format!("Terminal rows {current_rows} are outside tmux range"))?;
            if !existing_tmux {
                crate::tmux::create_detached_session(&id, &shell_path, &cwd, cols, rows).await?;
            }
            let tmux_args = vec![
                "attach-session".to_string(),
                "-t".to_string(),
                crate::tmux::session_name(&id),
            ];
            spawn_pty_process("tmux", &tmux_args, &cwd, current_cols, current_rows)?
        } else {
            spawn_pty_process(&shell_path, &shell_args, &cwd, current_cols, current_rows)?
        };
        let (broadcaster, _) = broadcast::channel(256);

        let session = Arc::new(LiveSession {
            state: Mutex::new(LiveSessionState {
                id: id.clone(),
                user_id: user_id.to_string(),
                title: title.clone(),
                shell: shell.clone(),
                cwd: cwd.clone(),
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
                history,
                next_seq,
                current_cols,
                current_rows,
                primary_client_id: None,
                client_dimensions: HashMap::new(),
                sandbox: None,
                thread: None,
                is_busy: false,
                last_activity_at: now_millis(),
                uses_tmux,
            }),
            io,
            broadcaster,
            batcher: Mutex::new(OutputBatcher::new()),
        });

        persist_session_state(&self.inner.config, &session).await?;
        {
            let mut sessions = self.inner.sessions.lock().await;
            sessions.insert(id.clone(), session.clone());
        }

        spawn_terminal_reader(self.clone(), session.clone(), reader);
        spawn_terminal_exit_watcher(self.clone(), id.clone(), child);

        if cfg!(windows) {
            sleep(Duration::from_millis(100)).await;
        }

        if let Some(initial_command) = initial_command {
            let newline = if cfg!(windows) { "\r\n" } else { "\n" };
            let _ = session
                .io
                .write(format!("{initial_command}{newline}"))
                .await;
        }

        Ok(TerminalSessionSnapshot {
            id,
            title,
            shell,
            created_at,
            updated_at: iso_timestamp(),
            history: Vec::new(),
            uses_tmux,
            current_cols: Some(current_cols),
            current_rows: Some(current_rows),
            sandbox: None,
        })
    }

    async fn record_output(&self, session: Arc<LiveSession>, text: String) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }

        let event = {
            let mut state = session.state.lock().await;
            let event = TerminalStreamEvent {
                text,
                ts: now_millis(),
                seq: Some(state.next_seq),
            };
            state.next_seq += 1;
            state.updated_at = iso_timestamp();
            state.history.push(event.clone());
            event
        };

        let receivers = session.broadcaster.receiver_count();
        let send_result = session
            .broadcaster
            .send(TerminalSubscriptionEvent::Output(event));
        tracing::debug!(
            "record_output: broadcast to {} receivers, result={}",
            receivers,
            send_result.is_ok()
        );
        persist_session_state(&self.inner.config, &session).await
    }

    async fn handle_terminal_output(
        &self,
        session: Arc<LiveSession>,
        text: String,
    ) -> Result<(), String> {
        let (sanitized_text, responses) = intercept_terminal_queries(&text);
        for response in responses {
            session.io.write(response).await?;
        }

        // Update busy state based on output content
        {
            let mut state = session.state.lock().await;
            state.last_activity_at = now_millis();
            state.is_busy = !crate::turn_detector::output_indicates_idle_prompt(&sanitized_text);
        }

        // Output batching: accumulate small writes, flush on size or timer
        let flush_text = {
            let mut batcher = session.batcher.lock().await;
            batcher.cancel_timer();
            if let Some(flushed) = batcher.append(&sanitized_text) {
                Some(flushed)
            } else {
                // Schedule a timer flush
                let manager = self.clone();
                let session_clone = session.clone();
                let handle = tokio::spawn(async move {
                    sleep(Duration::from_millis(BATCH_TIME_MS)).await;
                    let text = {
                        let mut batcher = session_clone.batcher.lock().await;
                        if batcher.is_empty() {
                            return;
                        }
                        batcher.take()
                    };
                    let _ = manager.record_output(session_clone, text).await;
                });
                // Store flush handle — batcher lock is still held from above
                batcher.flush_handle = Some(handle);
                None
            }
        };

        let Some(flush_text) = flush_text else {
            return Ok(());
        };

        self.record_output(session, flush_text).await
    }

    async fn mark_session_inactive(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.inner.sessions.lock().await;
            sessions.remove(session_id)
        };
        let Some(session) = session else {
            return Ok(());
        };

        persist_session_state(&self.inner.config, &session).await?;
        let _ = session.broadcaster.send(TerminalSubscriptionEvent::Closed);
        Ok(())
    }

    async fn restore_surviving_tmux_sessions(&self, user_id: &str) -> Result<(), String> {
        if !should_use_tmux().await {
            return Ok(());
        }

        let persisted = load_persisted_sessions(&self.inner.config, user_id)?;
        for session in persisted {
            if !session.uses_tmux {
                continue;
            }
            if self.is_active(&session.id).await {
                continue;
            }
            if crate::tmux::session_exists(&session.id).await {
                let _ = self
                    .restore_session(user_id, &session.id, None, None)
                    .await?;
            }
        }

        Ok(())
    }
}

fn summary_from_live_state(state: &LiveSessionState) -> TerminalSessionSummary {
    TerminalSessionSummary {
        id: state.id.clone(),
        title: state.title.clone(),
        shell: state.shell.clone(),
        cwd: state.cwd.clone(),
        cwd_source: None,
        group_path: None,
        created_at: state.created_at.clone(),
        updated_at: state.updated_at.clone(),
        last_activity_at: state
            .thread
            .as_ref()
            .map(|thread| thread.last_activity_at.clone())
            .unwrap_or_else(|| state.updated_at.clone()),
        message_count: state.history.len(),
        is_active: true,
        is_busy: state.is_busy,
        uses_tmux: state.uses_tmux,
        sandbox: state.sandbox.clone(),
        thread: state.thread.clone(),
    }
}

fn summary_from_stored(session: &StoredTerminalSession) -> TerminalSessionSummary {
    TerminalSessionSummary {
        id: session.id.clone(),
        title: session.title.clone(),
        shell: session.shell.clone(),
        cwd: session.cwd.clone(),
        cwd_source: None,
        group_path: None,
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        last_activity_at: session
            .thread
            .as_ref()
            .map(|thread| thread.last_activity_at.clone())
            .unwrap_or_else(|| session.updated_at.clone()),
        message_count: session.history.len(),
        is_active: false,
        is_busy: false,
        uses_tmux: session.uses_tmux,
        sandbox: session.sandbox.clone(),
        thread: session.thread.clone(),
    }
}

fn default_thread_metadata(sandbox: Option<&TerminalSandboxInfo>) -> ThreadMetadata {
    ThreadMetadata {
        topic: None,
        topic_auto_generated: false,
        pinned: false,
        archived: false,
        project_path: None,
        sandbox_mode: sandbox
            .map(|value| value.mode.clone())
            .unwrap_or_else(|| "off".to_string()),
        sandbox_workspace_root: sandbox.and_then(|value| value.workspace_root.clone()),
        git_stats: None,
        last_activity_at: iso_timestamp(),
    }
}

fn apply_thread_update(thread: &mut ThreadMetadata, updates: ThreadUpdate) {
    if let Some(topic) = updates.topic {
        thread.topic = normalize_optional_text(topic);
    }
    if let Some(topic_auto_generated) = updates.topic_auto_generated {
        thread.topic_auto_generated = topic_auto_generated;
    }
    if let Some(pinned) = updates.pinned {
        thread.pinned = pinned;
    }
    if let Some(archived) = updates.archived {
        thread.archived = archived;
    }
    if let Some(project_path) = updates.project_path {
        thread.project_path = normalize_optional_text(project_path);
    }
    thread.last_activity_at = iso_timestamp();
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn detect_git_root(start: &str) -> Option<String> {
    let mut current = PathBuf::from(start);
    if current.is_file() {
        current = current.parent()?.to_path_buf();
    }

    loop {
        let git_dir = current.join(".git");
        if git_dir.is_dir() || git_dir.is_file() {
            return Some(path_to_string(
                &current.canonicalize().unwrap_or_else(|_| current.clone()),
            ));
        }
        if !current.pop() {
            return None;
        }
    }
}

fn detect_git_branch(project_path: &str) -> Option<String> {
    let git_dir = resolve_git_dir(Path::new(project_path))?;
    let head_contents = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head_contents.trim();
    if let Some(reference) = head.strip_prefix("ref: refs/heads/") {
        let trimmed = reference.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else if head.is_empty() {
        None
    } else {
        Some(head.chars().take(7).collect())
    }
}

fn build_project_info(cwd: &str, git_branch: Option<String>) -> SessionProjectInfo {
    let cwd_path = Path::new(cwd);
    let project_type;
    let mut project_name = None;
    let mut start_command = None;
    let mut index_path = None;

    if let Some(package_json) = read_json_file(&cwd_path.join("package.json")) {
        project_type = Some("node".to_string());
        project_name = package_json
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        start_command = package_json
            .get("scripts")
            .and_then(|value| value.get("dev"))
            .and_then(|_| Some("npm run dev".to_string()))
            .or_else(|| {
                package_json
                    .get("scripts")
                    .and_then(|value| value.get("start"))
                    .and_then(|_| Some("npm start".to_string()))
            });
    } else if cwd_path.join("requirements.txt").is_file() && cwd_path.join("app.py").is_file() {
        project_type = Some("python-flask".to_string());
        start_command = Some("python app.py".to_string());
    } else if cwd_path.join("manage.py").is_file() {
        project_type = Some("django".to_string());
        start_command = Some("python manage.py runserver".to_string());
    } else if cwd_path.join("Cargo.toml").is_file() {
        project_type = Some("rust".to_string());
        start_command = Some("cargo run".to_string());
    } else if cwd_path.join("go.mod").is_file() {
        project_type = Some("go".to_string());
        start_command = Some("go run .".to_string());
    } else if cwd_path.join("index.html").is_file() && !cwd_path.join("package.json").is_file() {
        project_type = Some("static".to_string());
        index_path = Some(path_to_string(&cwd_path.join("index.html")));
    } else {
        project_type = Some("unknown".to_string());
    }

    SessionProjectInfo {
        cwd: cwd.to_string(),
        project_type,
        project_name,
        start_command,
        index_path,
        git_branch,
    }
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn resolve_git_dir(project_path: &Path) -> Option<PathBuf> {
    let git_path = project_path.join(".git");
    if git_path.is_dir() {
        return Some(git_path);
    }
    if !git_path.is_file() {
        return None;
    }

    let contents = fs::read_to_string(&git_path).ok()?;
    let relative = contents.trim().strip_prefix("gitdir:")?.trim();
    if relative.is_empty() {
        return None;
    }
    let resolved = if Path::new(relative).is_absolute() {
        PathBuf::from(relative)
    } else {
        project_path.join(relative)
    };
    Some(resolved)
}

fn path_to_string(path: &Path) -> String {
    let rendered = path.to_string_lossy().to_string();
    if cfg!(windows) {
        rendered
            .strip_prefix(r"\\?\")
            .unwrap_or(rendered.as_str())
            .to_string()
    } else if cfg!(target_os = "macos") {
        rendered
            .strip_prefix("/private")
            .unwrap_or(rendered.as_str())
            .to_string()
    } else {
        rendered
    }
}

#[cfg(not(windows))]
fn spawn_pty_process(
    shell_path: &str,
    shell_args: &[String],
    cwd: &str,
    cols: i64,
    rows: i64,
) -> Result<
    (
        PtySessionIo,
        Box<dyn Read + Send>,
        Box<dyn PtyChild + Send + Sync>,
    ),
    String,
> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows)?)
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(shell_path);
    command.args(shell_args.iter());
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let killer = child.clone_killer();
    let io = PtySessionIo::new(pair.master, writer, killer);

    Ok((io, reader, child))
}

#[cfg(windows)]
fn spawn_pty_process(
    shell_path: &str,
    shell_args: &[String],
    cwd: &str,
    cols: i64,
    rows: i64,
) -> Result<
    (
        PtySessionIo,
        Box<dyn Read + Send>,
        Arc<StdMutex<conpty::Process>>,
    ),
    String,
> {
    let mut cmd = shell_path.to_string();
    for arg in shell_args {
        cmd.push(' ');
        cmd.push_str(arg);
    }
    // Set cwd by prefixing the command
    let full_cmd = format!("cd /d {cwd} && {cmd}");

    tracing::info!("conpty: spawning command: {full_cmd}");
    let mut process = conpty::spawn(&full_cmd).map_err(|error| {
        tracing::error!("conpty spawn failed: {error}");
        error.to_string()
    })?;
    tracing::info!("conpty: spawn succeeded, is_alive={}", process.is_alive());

    tracing::info!("conpty: getting output reader");
    let reader = process.output().map_err(|error| {
        tracing::error!("conpty output failed: {error}");
        error.to_string()
    })?;
    tracing::info!("conpty: getting input writer");
    let input = process.input().map_err(|error| {
        tracing::error!("conpty input failed: {error}");
        error.to_string()
    })?;

    let cols_i16 = i16::try_from(cols).unwrap_or(120);
    let rows_i16 = i16::try_from(rows).unwrap_or(32);
    process
        .resize(cols_i16, rows_i16)
        .map_err(|error| error.to_string())?;
    tracing::info!("conpty: setup complete");
    let process_arc = Arc::new(StdMutex::new(process));

    let io = PtySessionIo {
        process: process_arc.clone(),
        writer: Arc::new(StdMutex::new(Box::new(input))),
    };

    Ok((io, Box::new(reader), process_arc))
}

fn spawn_terminal_reader(
    manager: TerminalManager,
    session: Arc<LiveSession>,
    mut reader: Box<dyn Read + Send>,
) {
    // Use a channel to decouple the blocking PTY read thread from the async
    // runtime.  block_on() from a plain OS thread can deadlock on Windows
    // ConPTY when the async handler contends on tokio Mutex locks held by
    // timer tasks spawned inside handle_terminal_output.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    thread::spawn(move || {
        tracing::info!("PTY reader thread started");
        let mut buffer = [0_u8; OUTPUT_BUFFER_SIZE];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    tracing::info!("PTY reader: EOF (0 bytes)");
                    return;
                }
                Ok(count) => {
                    tracing::debug!("PTY reader: got {} bytes", count);
                    let text = String::from_utf8_lossy(&buffer[..count]).to_string();
                    if tx.send(text).is_err() {
                        tracing::info!("PTY reader: channel closed");
                        return;
                    }
                }
                Err(err) => {
                    tracing::warn!("PTY reader error: {err}");
                    return;
                }
            }
        }
    });

    tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            let _ = manager.handle_terminal_output(session.clone(), text).await;
        }
    });
}

#[cfg(not(windows))]
fn spawn_terminal_exit_watcher(
    manager: TerminalManager,
    session_id: String,
    mut child: Box<dyn PtyChild + Send + Sync>,
) {
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || child.wait()).await;
        let _ = manager.mark_session_inactive(&session_id).await;
    });
}

#[cfg(windows)]
fn spawn_terminal_exit_watcher(
    manager: TerminalManager,
    session_id: String,
    process: Arc<StdMutex<conpty::Process>>,
) {
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            loop {
                let alive = {
                    let proc = process.lock().unwrap();
                    proc.is_alive()
                };
                if !alive {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        })
        .await;
        let _ = manager.mark_session_inactive(&session_id).await;
    });
}

async fn update_cwd_from_input(session: &Arc<LiveSession>, input: &str) {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return;
    }

    let cwd_update = if trimmed == "cd" {
        env::var("HOME").ok()
    } else {
        parse_cd_target(trimmed)
    };

    let Some(target) = cwd_update else {
        return;
    };

    let mut state = session.state.lock().await;
    let candidate = if Path::new(&target).is_absolute() {
        PathBuf::from(target)
    } else {
        PathBuf::from(&state.cwd).join(target)
    };
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    if resolved.is_dir() {
        state.cwd = path_to_string(&resolved);
        state.updated_at = iso_timestamp();
    }
}

fn parse_cd_target(input: &str) -> Option<String> {
    let rest = input.strip_prefix("cd ")?;
    let trimmed = rest.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn persist_session_state(
    config: &AppConfig,
    session: &Arc<LiveSession>,
) -> Result<(), String> {
    let (user_id, stored) = {
        let state = session.state.lock().await;
        (
            state.user_id.clone(),
            StoredTerminalSession {
                id: state.id.clone(),
                title: state.title.clone(),
                shell: state.shell.clone(),
                cwd: state.cwd.clone(),
                created_at: state.created_at.clone(),
                updated_at: state.updated_at.clone(),
                history: state.history.clone(),
                uses_tmux: state.uses_tmux,
                sandbox: state.sandbox.clone(),
                thread: state.thread.clone(),
            },
        )
    };
    save_persisted_session(config, &user_id, &stored)
}

fn save_persisted_session(
    config: &AppConfig,
    user_id: &str,
    session: &StoredTerminalSession,
) -> Result<(), String> {
    let sessions_dir = sessions_dir(config, user_id)?;
    fs::create_dir_all(&sessions_dir).map_err(|error| error.to_string())?;
    let path = sessions_dir.join(format!("{}.json", sanitize_id(&session.id)?));
    let contents = serde_json::to_vec_pretty(session).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn load_persisted_sessions(
    config: &AppConfig,
    user_id: &str,
) -> Result<Vec<StoredTerminalSession>, String> {
    let sessions_dir = sessions_dir(config, user_id)?;
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    for entry in fs::read_dir(&sessions_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(_) => continue,
        };
        let mut session = match serde_json::from_str::<StoredTerminalSession>(&contents) {
            Ok(session) => session,
            Err(_) => continue,
        };
        ensure_history_sequences(&mut session.history);
        sessions.push(session);
    }
    Ok(sessions)
}

fn load_persisted_session(
    config: &AppConfig,
    user_id: &str,
    session_id: &str,
) -> Result<Option<StoredTerminalSession>, String> {
    let path = sessions_dir(config, user_id)?.join(format!("{}.json", sanitize_id(session_id)?));
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut session = serde_json::from_str::<StoredTerminalSession>(&contents)
        .map_err(|error| error.to_string())?;
    ensure_history_sequences(&mut session.history);
    Ok(Some(session))
}

fn delete_persisted_session(
    config: &AppConfig,
    user_id: &str,
    session_id: &str,
) -> Result<bool, String> {
    let path = sessions_dir(config, user_id)?.join(format!("{}.json", sanitize_id(session_id)?));
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn sessions_dir(config: &AppConfig, user_id: &str) -> Result<PathBuf, String> {
    Ok(config
        .data_dir
        .join("users")
        .join(sanitize_id(user_id)?)
        .join("sessions"))
}

fn sanitize_id(value: &str) -> Result<String, String> {
    let sanitized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect();
    if sanitized.is_empty() {
        return Err("Identifier must contain alphanumeric characters or hyphens".to_string());
    }
    Ok(sanitized)
}

fn detect_shell() -> String {
    if cfg!(windows) {
        env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

async fn should_use_tmux() -> bool {
    match tmux_mode_from_env() {
        Some(false) => false,
        Some(true) => crate::tmux::is_tmux_available().await,
        None if cfg!(test) => false,
        None => crate::tmux::is_tmux_available().await,
    }
}

fn tmux_mode_from_env() -> Option<bool> {
    let value = std::env::var("TERMINAL_USE_TMUX").ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn shell_command(shell: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        let shell_name = Path::new(shell)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let args = if shell_name.contains("powershell") || shell_name == "pwsh" {
            vec!["-NoLogo".to_string(), "-NoExit".to_string()]
        } else {
            Vec::new()
        };
        (shell.to_string(), args)
    } else {
        (shell.to_string(), vec!["-i".to_string()])
    }
}

fn resolve_cwd(candidate: Option<&str>) -> String {
    let default = env::var("HOME")
        .ok()
        .or_else(|| {
            env::current_dir()
                .ok()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| ".".to_string());
    let Some(candidate) = candidate else {
        return default;
    };
    let path = PathBuf::from(candidate);
    let resolved = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    if resolved.is_dir() {
        resolved.to_string_lossy().to_string()
    } else {
        default
    }
}

fn normalize_newlines(input: &str) -> String {
    if cfg!(windows) {
        input
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', "\r\n")
    } else {
        input.to_string()
    }
}

#[cfg(not(windows))]
fn pty_size(cols: i64, rows: i64) -> Result<PtySize, String> {
    let cols = u16::try_from(cols)
        .map_err(|_| format!("Terminal columns {cols} are outside the supported PTY range"))?;
    let rows = u16::try_from(rows)
        .map_err(|_| format!("Terminal rows {rows} are outside the supported PTY range"))?;
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn lock_blocking<'a, T>(
    value: &'a StdMutex<T>,
    resource: &str,
) -> Result<std::sync::MutexGuard<'a, T>, String> {
    value
        .lock()
        .map_err(|_| format!("Failed to access {resource} because the lock is poisoned"))
}

async fn spawn_blocking_io<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

fn iso_timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("rfc3339 formatting should succeed")
}

fn now_millis() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .expect("timestamp should fit in i64")
}

fn intercept_terminal_queries(text: &str) -> (String, Vec<String>) {
    let mut sanitized = text.to_string();
    let mut responses = Vec::new();

    while let Some(index) = sanitized.find("\u{1b}[6n") {
        sanitized.replace_range(index..index + 4, "");
        responses.push("\u{1b}[1;1R".to_string());
    }

    (sanitized, responses)
}

fn limit_history(
    history: &[TerminalStreamEvent],
    query: &HistoryQuery,
) -> Vec<TerminalStreamEvent> {
    if query.max_history_chars.is_none()
        && query.max_history_events.is_none()
        && query.before_ts.is_none()
        && query.after_ts.is_none()
        && query.before_seq.is_none()
        && query.after_seq.is_none()
    {
        return history.to_vec();
    }

    let end_index = query
        .before_seq
        .map(|before_seq| find_history_end_index_by_seq(history, before_seq))
        .or_else(|| {
            query
                .before_ts
                .map(|before_ts| find_history_end_index(history, before_ts))
        })
        .unwrap_or(history.len());
    let mut start_index = query
        .after_seq
        .map(|after_seq| find_history_start_index_by_seq(history, after_seq))
        .or_else(|| {
            query
                .after_ts
                .map(|after_ts| find_history_start_index(history, after_ts))
        })
        .unwrap_or(0);

    if start_index > end_index {
        start_index = end_index;
    }

    if let Some(max_history_events) = query.max_history_events {
        if end_index.saturating_sub(start_index) > max_history_events {
            start_index = end_index.saturating_sub(max_history_events);
        }
    }

    if let Some(max_history_chars) = query.max_history_chars {
        let mut char_count = 0_usize;
        for index in (start_index..end_index).rev() {
            char_count += history[index].text.len();
            if char_count > max_history_chars {
                start_index = index + 1;
                break;
            }
        }
    }

    history[start_index..end_index].to_vec()
}

fn ensure_history_sequences(history: &mut [TerminalStreamEvent]) -> i64 {
    let mut next_seq = 1_i64;
    for entry in history.iter_mut() {
        if entry.seq.is_none() {
            entry.seq = Some(next_seq);
        }
        next_seq = next_seq.max(entry.seq.unwrap_or(next_seq) + 1);
    }
    next_seq
}

fn find_history_end_index(history: &[TerminalStreamEvent], before_ts: i64) -> usize {
    if before_ts <= 0 {
        return history.len();
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].ts >= before_ts {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn find_history_start_index(history: &[TerminalStreamEvent], after_ts: i64) -> usize {
    if after_ts < 0 {
        return 0;
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].ts > after_ts {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn find_history_end_index_by_seq(history: &[TerminalStreamEvent], before_seq: i64) -> usize {
    if before_seq <= 0 {
        return history.len();
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].seq.unwrap_or(0) >= before_seq {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn find_history_start_index_by_seq(history: &[TerminalStreamEvent], after_seq: i64) -> usize {
    if after_seq < 0 {
        return 0;
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].seq.unwrap_or(0) > after_seq {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

#[cfg(test)]
mod tests {
    use super::{
        intercept_terminal_queries, normalize_newlines, shell_command, tmux_mode_from_env,
        AppConfig, TerminalCreateOptions, TerminalManager,
    };
    use std::sync::{LazyLock, Mutex as StdMutex};
    use tempfile::tempdir;

    static ENV_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

    #[test]
    fn normalize_newlines_matches_platform_terminal_conventions() {
        let input = "echo one\r\necho two\recho three\n";
        let normalized = normalize_newlines(input);

        if cfg!(windows) {
            assert_eq!(normalized, "echo one\r\necho two\r\necho three\r\n");
        } else {
            assert_eq!(normalized, input);
        }
    }

    #[test]
    fn intercept_terminal_queries_replies_to_cursor_status_requests() {
        let (sanitized, responses) = intercept_terminal_queries("prefix\u{1b}[6nsuffix\u{1b}[6n");

        assert_eq!(sanitized, "prefixsuffix");
        assert_eq!(
            responses,
            vec!["\u{1b}[1;1R".to_string(), "\u{1b}[1;1R".to_string()]
        );
    }

    #[tokio::test]
    #[cfg(not(windows))]
    async fn resize_updates_the_underlying_pty_dimensions() {
        let working_dir = tempdir().expect("temp dir should create");
        let data_dir = tempdir().expect("data dir should create");
        let manager = TerminalManager::new(AppConfig {
            data_dir: data_dir.path().to_path_buf(),
            ..AppConfig::default()
        });
        let user_id = "user-pty-resize";
        let session = manager
            .create_session(
                user_id,
                TerminalCreateOptions {
                    cwd: Some(working_dir.path().to_string_lossy().to_string()),
                    cols: Some(90),
                    rows: Some(28),
                    title: None,
                    shell: None,
                    initial_command: None,
                },
            )
            .await
            .expect("session should create");

        let live_session = {
            let sessions = manager.inner.sessions.lock().await;
            sessions
                .get(&session.id)
                .cloned()
                .expect("live session should exist")
        };
        let original_size = live_session
            .io
            .get_size()
            .await
            .expect("pty size should be available");
        assert_eq!(original_size.cols, 90);
        assert_eq!(original_size.rows, 28);

        let resized = manager
            .resize(
                user_id,
                &session.id,
                132,
                41,
                Some("client-a".to_string()),
                true,
            )
            .await
            .expect("resize should succeed");

        assert_eq!(resized.current_cols, 132);
        assert_eq!(resized.current_rows, 41);
        assert_eq!(resized.owner_client_id.as_deref(), Some("client-a"));

        let live_session = {
            let sessions = manager.inner.sessions.lock().await;
            sessions
                .get(&session.id)
                .cloned()
                .expect("live session should still exist")
        };
        let resized_size = live_session
            .io
            .get_size()
            .await
            .expect("pty size should be available after resize");

        assert_eq!(resized_size.cols, 132);
        assert_eq!(resized_size.rows, 41);
        let _ = manager.close(user_id, &session.id).await;
    }

    #[test]
    fn tmux_mode_parses_boolean_overrides() {
        let _env_guard = ENV_LOCK.lock().expect("env lock should acquire");
        let previous = std::env::var("TERMINAL_USE_TMUX").ok();

        unsafe { std::env::set_var("TERMINAL_USE_TMUX", "true") };
        assert_eq!(tmux_mode_from_env(), Some(true));

        unsafe { std::env::set_var("TERMINAL_USE_TMUX", "false") };
        assert_eq!(tmux_mode_from_env(), Some(false));

        unsafe { std::env::set_var("TERMINAL_USE_TMUX", "auto") };
        assert_eq!(tmux_mode_from_env(), None);

        match previous {
            Some(value) => unsafe { std::env::set_var("TERMINAL_USE_TMUX", value) },
            None => unsafe { std::env::remove_var("TERMINAL_USE_TMUX") },
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_cmd_launches_without_extra_arguments() {
        let (shell, args) = shell_command("C:\\Windows\\System32\\cmd.exe");

        assert_eq!(shell, "C:\\Windows\\System32\\cmd.exe");
        assert!(args.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_powershell_still_uses_no_logo_and_no_exit() {
        let (shell, args) =
            shell_command("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");

        assert_eq!(
            shell,
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
        assert_eq!(args, vec!["-NoLogo".to_string(), "-NoExit".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn conpty_smoke_test_reads_output() {
        use std::io::{Read, Write};

        let mut proc = conpty::spawn("cmd.exe").expect("conpty spawn");
        let mut reader = proc.output().expect("conpty output");
        let mut writer = proc.input().expect("conpty input");

        // Write a command
        writer.write_all(b"echo CONPTY_OK\r\n").unwrap();
        writer.flush().unwrap();

        let mut buf = [0u8; 4096];
        let mut all_output = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if std::time::Instant::now() > deadline {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    all_output.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if all_output.contains("CONPTY_OK") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        proc.exit(0).ok();
        assert!(
            all_output.contains("CONPTY_OK"),
            "Expected CONPTY_OK in output, got: {all_output:?}"
        );
    }
}
