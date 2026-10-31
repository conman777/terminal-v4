use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;

#[cfg(not(windows))]
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use terminal_v4_core::{
    AppConfig, TerminalSandboxInfo, TerminalSessionSnapshot, TerminalSessionSummary,
    TerminalStreamEvent, ThreadMetadata,
};

use crate::process_tree::ProcessTree;
use crate::state::HistoryQuery;

const DEFAULT_COLS: i64 = 120;
const DEFAULT_ROWS: i64 = 32;
const OUTPUT_BUFFER_SIZE: usize = 4096;
const OUTPUT_QUEUE_CAPACITY: usize = 64;
const BATCH_SIZE_THRESHOLD: usize = 4096;
const BATCH_TIME_MS: u64 = 16;

#[derive(Debug, Clone)]
pub struct TerminalCreateOptions {
    pub cwd: Option<String>,
    pub cols: Option<i64>,
    pub rows: Option<i64>,
    pub title: Option<String>,
    pub shell: Option<String>,
    pub sandbox_mode: Option<String>,
    pub sandbox_workspace_root: Option<String>,
    pub initial_command: Option<String>,
}

/// Re-checks the caller's credential. The manager calls it after every wait and
/// before each side effect it publishes, so a request admitted at the door cannot
/// outlive a logout, revocation or grant expiry that happened while it queued.
pub type TerminalAdmission<'a> = &'a (dyn Fn() -> Result<(), String> + Send + Sync);

pub const TERMINAL_UNAUTHORIZED: &str = "Not authorized: ";
pub const TERMINAL_CONFLICT: &str = "Conflict: ";
const CREATE_REQUEST_PRUNE_THRESHOLD: usize = 128;

/// Optional identity for a terminal that serves as a conversation drawer.
/// `request_id` makes creation idempotent per owner; `companion_of` links the
/// terminal to its conversation in the same journal write that creates it.
#[derive(Debug, Clone, Default)]
pub struct TerminalCreateIntent {
    pub request_id: Option<String>,
    pub companion_of: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TerminalCreation {
    pub session: TerminalSessionSnapshot,
    pub replayed: bool,
}

#[derive(Default)]
struct SpawnExtras<'a> {
    thread: Option<ThreadMetadata>,
    admission: Option<TerminalAdmission<'a>>,
}

fn admit(admission: Option<TerminalAdmission<'_>>) -> Result<(), String> {
    match admission {
        Some(check) => check().map_err(|error| format!("{TERMINAL_UNAUTHORIZED}{error}")),
        None => Ok(()),
    }
}

/// Builds the revalidation a route hands to the manager from the credential it
/// authenticated with. A request with no revalidatable credential fails closed.
pub(crate) fn credential_admission<'a>(
    state: &'a crate::state::AppState,
    owner: &'a str,
    local: Option<&'a crate::auth::LocalAuthority>,
    paired: Option<&'a crate::auth::PairedInputAuthority>,
) -> impl Fn() -> Result<(), String> + Send + Sync + 'a {
    move || {
        if let Some(local) = local {
            #[cfg(unix)]
            {
                let (result, confirmed) =
                    state.accept_with_local_authority(owner, local, |check| check())?;
                result?;
                if !confirmed {
                    return Err("Credential verification outcome is uncertain".into());
                }
                return Ok(());
            }
            #[cfg(not(unix))]
            {
                let (generation, _) = local
                    .valid_for(owner, crate::v4_agent::interaction::now_ms())
                    .ok_or("Credential is invalid or expired")?;
                return state.validate_auth_generation(owner, generation);
            }
        }
        if let Some(paired) = paired {
            let expires =
                crate::paired_environments::validate_input_authority(state, paired, owner)?;
            if crate::v4_agent::interaction::now_ms() >= expires {
                return Err("Paired grant expired".into());
            }
            return Ok(());
        }
        Err("Credential is invalid or expired".into())
    }
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
    pub sandbox_mode: Option<String>,
    pub sandbox_workspace_root: Option<Option<String>>,
    pub companion_of: Option<Option<String>>,
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
    shutting_down: AtomicBool,
    // Lifecycle admission precedes sessions, batcher, then state. Readers skip it.
    lifecycle: Mutex<()>,
    sessions: Mutex<HashMap<String, Arc<LiveSession>>>,
    #[cfg(all(test, unix))]
    admitted_create_pause: StdMutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::sync::oneshot::Receiver<()>,
        )>,
    >,
}

struct LiveSession {
    closed: AtomicBool,
    finalizing: AtomicBool,
    delete_requested: AtomicBool,
    reader_drained: tokio::sync::watch::Sender<bool>,
    state: Mutex<LiveSessionState>,
    io: PtySessionIo,
    broadcaster: broadcast::Sender<TerminalSubscriptionEvent>,
    batcher: Mutex<OutputBatcher>,
    cwd_refreshed_at: Mutex<Option<std::time::Instant>>,
}

#[derive(Clone)]
#[cfg(not(windows))]
struct PtySessionIo {
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    tree: ProcessTree,
    shell_pid: u32,
}

#[derive(Clone)]
#[cfg(windows)]
struct PtySessionIo {
    process: Arc<StdMutex<conpty::Process>>,
    tree: ProcessTree,
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
        tree: ProcessTree,
        shell_pid: u32,
    ) -> Self {
        Self {
            master: Arc::new(StdMutex::new(master)),
            writer: Arc::new(StdMutex::new(writer)),
            tree,
            shell_pid,
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
        self.tree
            .stop(Duration::from_secs(3))
            .await
            .map_err(|error| error.to_string())
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
        self.tree
            .stop(Duration::from_secs(3))
            .await
            .map_err(|error| error.to_string())
    }
}

impl PtySessionIo {
    async fn stop_tree(&self) -> Result<(), String> {
        self.kill().await
    }
}

impl TerminalManager {
    pub fn new(config: AppConfig) -> Self {
        Self {
            inner: Arc::new(TerminalManagerInner {
                config,
                counter: AtomicUsize::new(0),
                shutting_down: AtomicBool::new(false),
                lifecycle: Mutex::new(()),
                sessions: Mutex::new(HashMap::new()),
                #[cfg(all(test, unix))]
                admitted_create_pause: StdMutex::new(None),
            }),
        }
    }

    /// Recover orphaned tmux sessions on startup.
    /// Checks for tmux sessions that match our naming convention but don't
    /// have active in-memory sessions. Logs them for awareness.
    pub(crate) async fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        let sessions: Vec<_> = self
            .inner
            .sessions
            .lock()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect();
        let mut stopping = tokio::task::JoinSet::new();
        for (id, session) in sessions {
            let manager = self.clone();
            stopping.spawn(async move {
                // Tmux's server and panes are deliberately persistent; stopping
                // this PTY detaches only its app-owned client on app shutdown.
                if let Err(error) = stop_and_drain_terminal(&session).await {
                    tracing::warn!(session_id = %id, %error, "Terminal tools/output did not finish controlled cleanup");
                    return;
                }
                if let Err(error) = manager.mark_session_inactive(&id, &session).await {
                    tracing::warn!(session_id = %id, %error, "Terminal shutdown history could not be saved");
                }
            });
        }
        while stopping.join_next().await.is_some() {}
    }

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
                    "Found orphaned tmux session â€” available for restore"
                );
            }
        }
    }

    pub async fn list_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<TerminalSessionSummary>, String> {
        self.restore_surviving_tmux_sessions(user_id).await?;

        let live_sessions: Vec<_> = self.inner.sessions.lock().await.values().cloned().collect();
        let active_sessions = {
            let mut summaries = Vec::new();
            for session in live_sessions {
                if session.state.lock().await.user_id != user_id {
                    continue;
                }
                refresh_session_cwd(&session).await;
                let state = session.state.lock().await;

                summaries.push(summary_from_live_state(
                    &state,
                    !session.closed.load(Ordering::SeqCst),
                ));
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
        self.create_session_admitted(user_id, options, TerminalCreateIntent::default(), None)
            .await
            .map(|created| created.session)
    }

    pub async fn create_session_admitted(
        &self,
        user_id: &str,
        options: TerminalCreateOptions,
        intent: TerminalCreateIntent,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<TerminalCreation, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.create_session_locked(user_id, options, intent, admission)
            .await
    }

    #[cfg(unix)]
    pub(crate) async fn create_session_authorized(
        &self,
        user_id: &str,
        options: TerminalCreateOptions,
        intent: TerminalCreateIntent,
        app: &crate::state::AppState,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        cancelled: &AtomicBool,
    ) -> Result<TerminalCreation, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            return Err(format!(
                "{TERMINAL_UNAUTHORIZED}Terminal request was cancelled"
            ));
        }
        let _owner = self
            .terminal_owner_guard(app, user_id, local, paired)
            .await?;
        let credential = credential_admission(app, user_id, local, paired);
        let admission = || {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Terminal request was cancelled".into());
            }
            credential()
        };
        let result = self
            .create_session_locked(user_id, options, intent, Some(&admission))
            .await;
        #[cfg(test)]
        {
            let pause = self.inner.admitted_create_pause.lock().unwrap().take();
            if let Some((entered, release)) = pause {
                let _ = entered.send(());
                let _ = release.await;
            }
        }
        result
    }

    async fn create_session_locked(
        &self,
        user_id: &str,
        options: TerminalCreateOptions,
        intent: TerminalCreateIntent,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<TerminalCreation, String> {
        admit(admission)?;
        if let Some(request_id) = intent.request_id.as_deref() {
            if let Some(session) = self
                .replay_create_request(user_id, request_id, &intent)
                .await?
            {
                admit(admission)?;
                return Ok(TerminalCreation {
                    session,
                    replayed: true,
                });
            }
        }
        let id = Uuid::new_v4().to_string();
        if let Some(request_id) = intent.request_id.as_deref() {
            save_create_request(&self.inner.config, user_id, request_id, &id)?;
        }
        let title = options
            .title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| {
                let next = self.inner.counter.fetch_add(1, Ordering::SeqCst) + 1;
                format!("Terminal {next}")
            });
        let uses_tmux = should_use_tmux().await;
        let sandbox = build_sandbox_info(
            options.sandbox_mode.as_deref(),
            options
                .sandbox_workspace_root
                .or_else(|| options.cwd.clone()),
            &id,
        );
        let thread = intent.companion_of.clone().map(|companion_of| {
            let mut thread = default_thread_metadata(sandbox.as_ref());
            thread.companion_of = Some(companion_of);
            thread
        });
        let created = self
            .spawn_session_with(
                user_id,
                id.clone(),
                title,
                options.cwd,
                options.shell,
                options.cols,
                options.rows,
                Vec::new(),
                options.initial_command,
                sandbox,
                uses_tmux,
                false,
                SpawnExtras { thread, admission },
            )
            .await;
        let session = match created {
            Ok(session) => session,
            Err(error) => {
                if let Some(request_id) = intent.request_id.as_deref() {
                    let _ = delete_create_request(&self.inner.config, user_id, request_id);
                }
                return Err(error);
            }
        };
        if let Err(error) = admit(admission) {
            // Access ended while the shell started: nothing from this request may stay.
            let rollback = self.close_locked(user_id, &id).await;
            if let Some(request_id) = intent.request_id.as_deref() {
                let _ = delete_create_request(&self.inner.config, user_id, request_id);
            }
            return Err(match rollback {
                Ok(_) => error,
                Err(rollback) => {
                    format!("{error}; the new terminal could not be removed: {rollback}")
                }
            });
        }
        Ok(TerminalCreation {
            session,
            replayed: false,
        })
    }

    /// Returns the terminal an earlier request with this id already created.
    /// A mapping whose terminal was deleted is stale and is replaced by a new creation.
    async fn replay_create_request(
        &self,
        user_id: &str,
        request_id: &str,
        intent: &TerminalCreateIntent,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        let Some(session_id) = load_create_request(&self.inner.config, user_id, request_id)? else {
            return Ok(None);
        };
        let live = self.inner.sessions.lock().await.get(&session_id).cloned();
        let (snapshot, companion_of) = if let Some(session) = live {
            let state = session.state.lock().await;
            if state.user_id != user_id || session.delete_requested.load(Ordering::SeqCst) {
                return Ok(None);
            }
            (
                TerminalSessionSnapshot {
                    id: state.id.clone(),
                    title: state.title.clone(),
                    shell: state.shell.clone(),
                    created_at: state.created_at.clone(),
                    updated_at: state.updated_at.clone(),
                    history: Vec::new(),
                    uses_tmux: state.uses_tmux,
                    current_cols: Some(state.current_cols),
                    current_rows: Some(state.current_rows),
                    sandbox: state.sandbox.clone(),
                },
                state
                    .thread
                    .as_ref()
                    .and_then(|thread| thread.companion_of.clone()),
            )
        } else if let Some(stored) =
            load_persisted_session(&self.inner.config, user_id, &session_id)?
        {
            (
                TerminalSessionSnapshot {
                    id: stored.id,
                    title: stored.title,
                    shell: stored.shell,
                    created_at: stored.created_at,
                    updated_at: stored.updated_at,
                    history: Vec::new(),
                    uses_tmux: stored.uses_tmux,
                    current_cols: None,
                    current_rows: None,
                    sandbox: stored.sandbox,
                },
                stored.thread.and_then(|thread| thread.companion_of),
            )
        } else {
            return Ok(None);
        };
        if companion_of != intent.companion_of {
            return Err(format!(
                "{TERMINAL_CONFLICT}This request id already created a terminal for a different conversation"
            ));
        }
        Ok(Some(snapshot))
    }

    pub async fn restore_session(
        &self,
        user_id: &str,
        session_id: &str,
        cols: Option<i64>,
        rows: Option<i64>,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        self.restore_session_admitted(user_id, session_id, cols, rows, None)
            .await
    }

    pub async fn restore_session_admitted(
        &self,
        user_id: &str,
        session_id: &str,
        cols: Option<i64>,
        rows: Option<i64>,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.restore_session_locked(user_id, session_id, cols, rows, admission)
            .await
    }

    #[cfg(unix)]
    pub(crate) async fn restore_session_authorized(
        &self,
        user_id: &str,
        session_id: &str,
        cols: Option<i64>,
        rows: Option<i64>,
        app: &crate::state::AppState,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        cancelled: &AtomicBool,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            return Err(format!(
                "{TERMINAL_UNAUTHORIZED}Terminal request was cancelled"
            ));
        }
        let _owner = self
            .terminal_owner_guard(app, user_id, local, paired)
            .await?;
        let credential = credential_admission(app, user_id, local, paired);
        let admission = || {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Terminal request was cancelled".into());
            }
            credential()
        };
        self.restore_session_locked(user_id, session_id, cols, rows, Some(&admission))
            .await
    }

    #[cfg(unix)]
    async fn terminal_owner_guard(
        &self,
        app: &crate::state::AppState,
        user_id: &str,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
    ) -> Result<crate::state::owner_input::OwnerInputGuard, String> {
        if local.is_some() == paired.is_some() {
            return Err(format!(
                "{TERMINAL_UNAUTHORIZED}A local account or paired device credential is required"
            ));
        }
        let owner = user_id.to_owned();
        let auth_app = app.clone();
        let guard = tokio::task::spawn_blocking(move || auth_app.acquire_input_guard(&owner))
            .await
            .map_err(|_| "Terminal owner admission unavailable")??;
        if !guard.matches_scope(&self.inner.config.data_dir, user_id) {
            return Err("Terminal owner admission scope mismatch".into());
        }
        app.verify_owner_input_guard(&guard)?;
        admit(Some(&credential_admission(app, user_id, local, paired)))?;
        Ok(guard)
    }

    async fn restore_session_locked(
        &self,
        user_id: &str,
        session_id: &str,
        cols: Option<i64>,
        rows: Option<i64>,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        admit(admission)?;
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let _publication = session.batcher.lock().await;
            admit(admission)?;
            let snapshot = {
                let state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(None);
                }
                if session.delete_requested.load(Ordering::SeqCst) {
                    return Err(
                        "Terminal deletion is incomplete; retry Delete before restoring".into(),
                    );
                }
                if session.finalizing.load(Ordering::SeqCst)
                    && !session.closed.load(Ordering::SeqCst)
                {
                    return Err("Terminal output finalization is pending; wait for its reader or retry Stop".into());
                }
                TerminalSessionSnapshot {
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
                }
            };
            persist_session_state(&self.inner.config, &session).await?;
            admit(admission)?;
            if !session.closed.load(Ordering::SeqCst) {
                return Ok(Some(snapshot));
            }
            // A retaining stop already confirmed tree exit and reader drain.
            // Commit its in-memory final head before creating a fresh PTY.
            drop(_publication);
            self.inner.sessions.lock().await.remove(session_id);
            let _ = session.broadcaster.send(TerminalSubscriptionEvent::Closed);
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
        let restored_sandbox = match persisted.thread.as_ref() {
            Some(thread) => build_sandbox_info(
                Some(thread.sandbox_mode.as_str()),
                thread.sandbox_workspace_root.clone(),
                &persisted.id,
            ),
            None => persisted.sandbox.clone(),
        };
        let restored_thread = persisted.thread.clone();
        let snapshot = self
            .spawn_session_with(
                user_id,
                persisted.id,
                persisted.title,
                Some(persisted.cwd),
                Some(persisted.shell),
                cols,
                rows,
                persisted.history,
                None,
                restored_sandbox.clone(),
                uses_tmux,
                has_existing_tmux,
                SpawnExtras {
                    thread: restored_thread,
                    admission,
                },
            )
            .await?;
        if let Err(error) = admit(admission) {
            let rollback = self
                .suspend_locked(user_id, session_id, has_existing_tmux)
                .await;
            return Err(match rollback {
                Ok(_) => error,
                Err(cleanup) => {
                    format!("{error}; restored terminal cleanup is unconfirmed: {cleanup}")
                }
            });
        }
        Ok(Some(snapshot))
    }

    pub async fn write(&self, user_id: &str, session_id: &str, input: &str) -> Result<(), String> {
        self.write_admitted(user_id, session_id, input, None).await
    }

    pub(crate) async fn write_admitted(
        &self,
        user_id: &str,
        session_id: &str,
        input: &str,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<(), String> {
        tracing::debug!(
            "TerminalManager::write session={session_id} input_len={}",
            input.len()
        );
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
            if session.closed.load(Ordering::SeqCst) || session.finalizing.load(Ordering::SeqCst) {
                return Err("Terminal finalization is pending; input was not sent".into());
            }
        }

        // Try to flush batcher for responsiveness, but don't block if it's busy
        if let Ok(mut batcher) = session.batcher.try_lock() {
            batcher.cancel_timer();
            if !batcher.is_empty() {
                let text = batcher.take();
                let _ = self.record_output(session.clone(), text).await;
            }
        }

        admit(admission)?;
        tracing::debug!("TerminalManager::write calling io.write");
        session.io.write(normalize_newlines(input)).await?;

        #[cfg(windows)]
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

    pub(crate) async fn has_live_workspace(&self, path: &Path) -> bool {
        let sessions = self.inner.sessions.lock().await;
        for session in sessions.values() {
            let state = session.state.lock().await;
            if workspace_contains(path, Path::new(&state.cwd)) {
                return true;
            }
        }
        false
    }
    pub(crate) async fn suspend(&self, user_id: &str, session_id: &str) -> Result<bool, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.suspend_locked(user_id, session_id, false).await
    }

    async fn suspend_locked(
        &self,
        user_id: &str,
        session_id: &str,
        keep_tmux: bool,
    ) -> Result<bool, String> {
        let mut sessions = self.inner.sessions.lock().await;
        let Some(session) = sessions.get(session_id).cloned() else {
            return Ok(load_persisted_session(&self.inner.config, user_id, session_id)?.is_some());
        };
        let (cwd, uses_tmux) = {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(false);
            }
            (state.cwd.clone(), state.uses_tmux)
        };
        if session.delete_requested.load(Ordering::SeqCst) {
            return Err(
                "Terminal deletion is incomplete; retry Delete instead of suspending".into(),
            );
        }
        let _workspace_activity = crate::workspace_activity::enter(Path::new(&cwd))?;
        session.finalizing.store(true, Ordering::SeqCst);
        if uses_tmux && !keep_tmux {
            crate::tmux::kill_session(session_id).await?;
            session.state.lock().await.uses_tmux = false;
        }
        stop_and_drain_terminal(&session).await?;
        let mut batcher = session.batcher.lock().await;
        batcher.cancel_timer();
        let pending = batcher.take();
        if !pending.is_empty() {
            if let Err(error) = self.record_output(session.clone(), pending).await {
                session.closed.store(true, Ordering::SeqCst);
                return Err(error);
            }
        }
        session.closed.store(true, Ordering::SeqCst);
        {
            let mut state = session.state.lock().await;
            state.uses_tmux = uses_tmux && keep_tmux;
            state.is_busy = false;
            state.updated_at = iso_timestamp();
        }
        persist_session_state(&self.inner.config, &session).await?;
        sessions.remove(session_id);
        let _ = session.broadcaster.send(TerminalSubscriptionEvent::Closed);
        Ok(true)
    }

    pub async fn close(&self, user_id: &str, session_id: &str) -> Result<bool, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.close_locked(user_id, session_id).await
    }

    /// Deletes a terminal; the caller holds the lifecycle lock.
    async fn close_locked(&self, user_id: &str, session_id: &str) -> Result<bool, String> {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            let session = sessions.get(session_id).cloned();
            if let Some(session) = &session {
                let state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(false);
                }
            }
            session
        };

        if session.is_none() {
            let Some(stored) = load_persisted_session(&self.inner.config, user_id, session_id)?
            else {
                return Ok(false);
            };
            if stored.uses_tmux {
                crate::tmux::kill_session_if_present(&stored.id).await?;
            }
            return delete_persisted_session(&self.inner.config, user_id, session_id);
        }

        let mut publication = match session.as_ref() {
            Some(session) => Some(session.batcher.lock().await),
            None => None,
        };
        if let Some(session) = &session {
            session.delete_requested.store(true, Ordering::SeqCst);
            session.finalizing.store(true, Ordering::SeqCst);
            session.closed.store(true, Ordering::SeqCst);
            if let Some(batcher) = publication.as_mut() {
                batcher.cancel_timer();
                batcher.take();
            }
        }
        let deletion = delete_persisted_session(&self.inner.config, user_id, session_id);
        drop(publication);
        let mut failures = Vec::new();
        let deleted = match deletion {
            Ok(deleted) => deleted,
            Err(error) => {
                failures.push(format!("Terminal journal deletion failed: {error}"));
                false
            }
        };
        // Keep admission and the manager's cleanup owner until both operations
        // succeed. Failed deletion must still stop the owned process tree.
        if let Some(session) = &session {
            let uses_tmux = session.state.lock().await.uses_tmux;
            if uses_tmux {
                match crate::tmux::kill_session(session_id).await {
                    Ok(()) => session.state.lock().await.uses_tmux = false,
                    Err(error) => failures.push(format!("Terminal tmux cleanup failed: {error}")),
                }
            }
            if let Err(error) = session.io.kill().await {
                failures.push(format!(
                    "Terminal process cleanup remains unconfirmed: {error}"
                ));
            }
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        if let Some(session) = session {
            self.inner.sessions.lock().await.remove(session_id);
            let _ = session.broadcaster.send(TerminalSubscriptionEvent::Closed);
            return Ok(true);
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

    /// Live output may still be delivered while a stopped child's reader drains.
    pub async fn is_active(&self, session_id: &str) -> bool {
        let sessions = self.inner.sessions.lock().await;
        sessions
            .get(session_id)
            .is_some_and(|session| !session.closed.load(Ordering::SeqCst))
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
        tracing::info!(
            "subscribe: session={session_id}, receiver_count={}",
            session.broadcaster.receiver_count()
        );
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

        let _lifecycle = self.inner.lifecycle.lock().await;
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let _publication = session.batcher.lock().await;
            let summary = {
                let mut state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(None);
                }
                if session.closed.load(Ordering::SeqCst)
                    || session.finalizing.load(Ordering::SeqCst)
                {
                    return Err("Terminal finalization is pending; metadata was not changed".into());
                }
                state.title = trimmed.to_string();
                state.updated_at = iso_timestamp();
                summary_from_live_state(&state, true)
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
        self.update_thread_admitted(user_id, session_id, updates, None)
            .await
    }

    pub async fn update_thread_admitted(
        &self,
        user_id: &str,
        session_id: &str,
        updates: ThreadUpdate,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<Option<ThreadMetadata>, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.update_thread_locked(user_id, session_id, updates, admission)
            .await
    }

    #[cfg(unix)]
    pub(crate) async fn update_thread_authorized(
        &self,
        user_id: &str,
        session_id: &str,
        updates: ThreadUpdate,
        app: &crate::state::AppState,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        cancelled: &AtomicBool,
    ) -> Result<Option<ThreadMetadata>, String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            return Err(format!(
                "{TERMINAL_UNAUTHORIZED}Terminal request was cancelled"
            ));
        }
        let _owner = self
            .terminal_owner_guard(app, user_id, local, paired)
            .await?;
        let credential = credential_admission(app, user_id, local, paired);
        let admission = || {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Terminal request was cancelled".into());
            }
            credential()
        };
        self.update_thread_locked(user_id, session_id, updates, Some(&admission))
            .await
    }

    async fn update_thread_locked(
        &self,
        user_id: &str,
        session_id: &str,
        updates: ThreadUpdate,
        admission: Option<TerminalAdmission<'_>>,
    ) -> Result<Option<ThreadMetadata>, String> {
        admit(admission)?;
        let maybe_active = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        if let Some(session) = maybe_active {
            let _publication = session.batcher.lock().await;
            admit(admission)?;
            let thread = {
                let mut state = session.state.lock().await;
                admit(admission)?;
                if state.user_id != user_id {
                    return Ok(None);
                }
                if session.closed.load(Ordering::SeqCst)
                    || session.finalizing.load(Ordering::SeqCst)
                {
                    return Err("Terminal finalization is pending; metadata was not changed".into());
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

        admit(admission)?;
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
        admit(admission)?;
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
            if session.state.lock().await.user_id != user_id {
                return Ok(None);
            }
            refresh_session_cwd(&session).await;
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
        sandbox: Option<TerminalSandboxInfo>,
        uses_tmux: bool,
        existing_tmux: bool,
    ) -> Result<TerminalSessionSnapshot, String> {
        self.spawn_session_with(
            user_id,
            id,
            title,
            cwd,
            shell,
            cols,
            rows,
            history,
            initial_command,
            sandbox,
            uses_tmux,
            existing_tmux,
            SpawnExtras::default(),
        )
        .await
    }

    async fn spawn_session_with(
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
        sandbox: Option<TerminalSandboxInfo>,
        uses_tmux: bool,
        existing_tmux: bool,
        extras: SpawnExtras<'_>,
    ) -> Result<TerminalSessionSnapshot, String> {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err("App server is shutting down".into());
        }
        admit(extras.admission)?;
        let created_at = iso_timestamp();
        let cwd = resolve_cwd(cwd.as_deref())?;
        let _workspace_activity = crate::workspace_activity::enter(Path::new(&cwd))?;
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
            closed: AtomicBool::new(false),
            finalizing: AtomicBool::new(false),
            delete_requested: AtomicBool::new(false),
            reader_drained: tokio::sync::watch::channel(false).0,
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
                sandbox: sandbox.clone(),
                thread: extras.thread,
                is_busy: false,
                last_activity_at: now_millis(),
                uses_tmux,
            }),
            io,
            broadcaster,
            batcher: Mutex::new(OutputBatcher::new()),
            cwd_refreshed_at: Mutex::new(None),
        });

        if let Err(error) = admit(extras.admission) {
            // The shell exists but nothing has been published: stop it and leave no journal.
            let mut failures = vec![error];
            if uses_tmux && !existing_tmux {
                if let Err(cleanup) = crate::tmux::kill_session(&id).await {
                    failures.push(format!("tmux cleanup failed: {cleanup}"));
                }
            }
            if let Err(cleanup) = session.io.stop_tree().await {
                failures.push(format!("process cleanup failed: {cleanup}"));
            }
            return Err(failures.join("; "));
        }
        persist_session_state(&self.inner.config, &session).await?;
        {
            let mut sessions = self.inner.sessions.lock().await;
            if self.inner.shutting_down.load(Ordering::SeqCst) {
                session.io.stop_tree().await?;
                return Err("App server is shutting down".into());
            }
            sessions.insert(id.clone(), session.clone());
        }

        spawn_terminal_reader(self.clone(), session.clone(), reader);
        spawn_terminal_exit_watcher(self.clone(), id.clone(), session.clone(), child);

        if cfg!(windows) {
            sleep(Duration::from_millis(100)).await;
        }

        if let Some(initial_command) = initial_command {
            if let Err(error) = admit(extras.admission) {
                // Revoked access must not run the requested command.
                let _ = self.close_locked(user_id, &id).await;
                return Err(error);
            }
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
            sandbox,
        })
    }

    async fn record_output(&self, session: Arc<LiveSession>, text: String) -> Result<(), String> {
        if text.is_empty() || session.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let event = {
            let mut state = session.state.lock().await;
            if session.closed.load(Ordering::SeqCst) {
                return Ok(());
            }
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
        if session.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let sanitized_text = text;
        if sanitized_text.is_empty() {
            return Ok(());
        }

        // Update busy state based on output content
        {
            let mut state = session.state.lock().await;
            state.last_activity_at = now_millis();
            if let Some(busy) = crate::turn_detector::output_busy_signal(&sanitized_text) {
                state.is_busy = busy;
            }
        }

        // This guard is also the publication barrier. A taken batch must be
        // appended, broadcast and persisted before another publisher or close.
        let mut batcher = session.batcher.lock().await;
        batcher.cancel_timer();
        if let Some(flushed) = batcher.append(&sanitized_text) {
            return self.record_output(session.clone(), flushed).await;
        }
        let manager = self.clone();
        let session_clone = session.clone();
        batcher.flush_handle = Some(tokio::spawn(async move {
            sleep(Duration::from_millis(BATCH_TIME_MS)).await;
            let mut batcher = session_clone.batcher.lock().await;
            if batcher.is_empty() {
                return;
            }
            // Once bytes are claimed, cancellation can affect only future work.
            drop(batcher.flush_handle.take());
            let text = batcher.take();
            let _ = manager.record_output(session_clone.clone(), text).await;
        }));
        Ok(())
    }

    async fn mark_session_inactive(
        &self,
        session_id: &str,
        expected: &Arc<LiveSession>,
    ) -> Result<(), String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        // Keep this entry visible to Delete until the retaining publication
        // finishes. Otherwise Delete can remove the journal while this callback
        // is waiting for a publisher, and the final persist would recreate it.
        let mut sessions = self.inner.sessions.lock().await;
        let Some(session) = sessions
            .get(session_id)
            .filter(|current| Arc::ptr_eq(current, expected))
            .cloned()
        else {
            return Ok(());
        };
        if session.delete_requested.load(Ordering::SeqCst) {
            return Ok(());
        }
        session.finalizing.store(true, Ordering::SeqCst);
        let mut batcher = session.batcher.lock().await;
        batcher.cancel_timer();
        let pending = batcher.take();
        if !pending.is_empty() {
            if let Err(error) = self.record_output(session.clone(), pending).await {
                session.closed.store(true, Ordering::SeqCst);
                return Err(error);
            }
        }
        session.closed.store(true, Ordering::SeqCst);
        {
            let mut state = session.state.lock().await;
            state.is_busy = false;
            state.updated_at = iso_timestamp();
        }
        persist_session_state(&self.inner.config, &session).await?;
        sessions.remove(session_id);
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
            if self.inner.sessions.lock().await.contains_key(&session.id) {
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

fn workspace_contains(workspace: &Path, candidate: &Path) -> bool {
    crate::workspace_activity::workspace_key(workspace)
        .ok()
        .zip(crate::workspace_activity::workspace_key(candidate).ok())
        .is_some_and(|(workspace, candidate)| workspace == candidate)
}

fn summary_from_live_state(state: &LiveSessionState, streamable: bool) -> TerminalSessionSummary {
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
        is_active: streamable,
        is_busy: streamable && busy_is_current(state.is_busy, state.last_activity_at, now_millis()),
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
        companion_of: None,
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
    if let Some(sandbox_mode) = updates.sandbox_mode {
        thread.sandbox_mode = sandbox_mode;
    }
    if let Some(sandbox_workspace_root) = updates.sandbox_workspace_root {
        thread.sandbox_workspace_root = normalize_optional_text(sandbox_workspace_root);
    }
    if let Some(companion_of) = updates.companion_of {
        thread.companion_of = normalize_optional_text(companion_of);
    }
    thread.last_activity_at = iso_timestamp();
}

fn build_sandbox_info(
    mode: Option<&str>,
    workspace_root: Option<String>,
    runtime_id: &str,
) -> Option<TerminalSandboxInfo> {
    let mode = mode.unwrap_or("off").trim();
    if mode.is_empty() || mode == "off" {
        return None;
    }

    Some(TerminalSandboxInfo {
        mode: mode.to_string(),
        workspace_root: normalize_optional_text(workspace_root),
        runtime_id: Some(runtime_id.to_string()),
        runtime_kind: "workspace-copy".to_string(),
    })
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

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let shell_pid = child
        .process_id()
        .ok_or_else(|| "Terminal process ID unavailable".to_string())?;
    let tree = match ProcessTree::attach_pty(child.as_ref()).map_err(|error| error.to_string()) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let io = PtySessionIo::new(pair.master, writer, tree, shell_pid);

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
    let tree = match ProcessTree::attach_pid(process.pid()) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = process.exit(1);
            return Err(error.to_string());
        }
    };
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
        tree,
        writer: Arc::new(StdMutex::new(Box::new(input))),
    };

    Ok((io, Box::new(reader), process_arc))
}

#[derive(Default)]
struct PtyUtf8Chunks {
    pending: Vec<u8>,
}
impl PtyUtf8Chunks {
    fn push(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        let mut cursor = 0;
        while cursor < self.pending.len() {
            match std::str::from_utf8(&self.pending[cursor..]) {
                Ok(text) => {
                    output.push_str(text);
                    cursor = self.pending.len();
                }
                Err(error) => {
                    let valid = cursor + error.valid_up_to();
                    output.push_str(std::str::from_utf8(&self.pending[cursor..valid]).unwrap());
                    cursor = valid;
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{fffd}');
                            cursor += length;
                        }
                        None if eof => {
                            output.push_str(&String::from_utf8_lossy(&self.pending[cursor..]));
                            cursor = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..cursor);
        output
    }
}

/// Read bytes in arrival order, preserving split UTF-8 and flushing a final
/// incomplete sequence on EOF or read error before the sender is dropped.
fn read_terminal_chunks(reader: &mut dyn Read, mut publish: impl FnMut(String) -> bool) {
    let mut buffer = [0_u8; OUTPUT_BUFFER_SIZE];
    let mut decoder = PtyUtf8Chunks::default();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let text = decoder.push(&buffer[..count], false);
                if !text.is_empty() && !publish(text) {
                    return;
                }
            }
            Err(error) => {
                tracing::debug!(%error,"PTY reader ended");
                break;
            }
        }
    }
    let tail = decoder.push(&[], true);
    if !tail.is_empty() {
        let _ = publish(tail);
    }
}
async fn wait_for_terminal_reader(session: &Arc<LiveSession>) -> Result<(), String> {
    let mut drained = session.reader_drained.subscribe();
    loop {
        if *drained.borrow_and_update() {
            return Ok(());
        }
        drained
            .changed()
            .await
            .map_err(|_| "Terminal reader completion channel closed".to_string())?;
    }
}

async fn stop_and_drain_terminal(session: &Arc<LiveSession>) -> Result<(), String> {
    session.finalizing.store(true, Ordering::SeqCst);
    // The tracked tree contains only this PTY client and its descendants. An
    // independently managed tmux server/pane is outside that tree and retained.
    session.io.stop_tree().await?;
    tokio::time::timeout(Duration::from_secs(2), wait_for_terminal_reader(session))
        .await
        .map_err(|_| {
            "Terminal output is still draining; retained history was not marked closed".to_string()
        })?
}

async fn stop_and_eventually_drain_exited_terminal(
    session: &Arc<LiveSession>,
    session_id: &str,
) -> Result<(), String> {
    session.finalizing.store(true, Ordering::SeqCst);
    // Keep tree-stop failure distinct from a slow reader. A natural-exit
    // supervisor has no waiting caller to retry a reader deadline, so it keeps
    // owning finalization after warning rather than abandoning retained bytes.
    session.io.stop_tree().await?;
    let draining = wait_for_terminal_reader(session);
    tokio::pin!(draining);
    if let Ok(result) = tokio::time::timeout(Duration::from_secs(2), &mut draining).await {
        return result;
    }
    tracing::warn!(%session_id, "Terminal exit output is still draining; waiting for final publication");
    draining.await
}
fn spawn_terminal_reader(
    manager: TerminalManager,
    session: Arc<LiveSession>,
    reader: Box<dyn Read + Send>,
) {
    let mut rx = terminal_output_queue(reader);
    tokio::spawn(async move {
        let mut queries = TerminalQueries::default();
        while let Some(text) = rx.recv().await {
            let (text, responses) = queries.push(&text, false);
            for response in responses {
                // A failed reply must not discard text from the same read.
                if let Err(error) = session.io.write(response).await {
                    tracing::debug!(%error, "Terminal query reply failed; preserving received output");
                }
            }
            let _ = manager.handle_terminal_output(session.clone(), text).await;
        }
        let (tail, _) = queries.push("", true);
        if !tail.is_empty() {
            let _ = manager.handle_terminal_output(session.clone(), tail).await;
        }
        // EOF is complete only after every queued decoded chunk was handled.
        session.reader_drained.send_replace(true);
    });
}

fn terminal_output_queue(mut reader: Box<dyn Read + Send>) -> tokio::sync::mpsc::Receiver<String> {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(OUTPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        // Blocking only this reader lets the PTY apply lossless backpressure
        // while persistence catches up, instead of retaining unbounded output.
        read_terminal_chunks(reader.as_mut(), |text| tx.blocking_send(text).is_ok());
    });
    rx
}

#[cfg(not(windows))]
fn wait_for_pty_child(
    tree: &ProcessTree,
    child: &mut dyn PtyChild,
) -> std::io::Result<portable_pty::ExitStatus> {
    loop {
        if let Some(status) = tree.try_wait_pty(child)? {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(not(windows))]
fn spawn_terminal_exit_watcher(
    manager: TerminalManager,
    session_id: String,
    session: Arc<LiveSession>,
    mut child: Box<dyn PtyChild + Send + Sync>,
) {
    tokio::spawn(async move {
        let tree = session.io.tree.clone();
        match tokio::task::spawn_blocking(move || wait_for_pty_child(&tree, child.as_mut())).await {
            Ok(Ok(_)) => {}
            error => {
                tracing::warn!(%session_id, ?error, "Terminal exit observation remains unconfirmed");
                return;
            }
        }
        if let Err(error) = stop_and_eventually_drain_exited_terminal(&session, &session_id).await {
            tracing::warn!(%session_id,%error,"Terminal exit output cleanup remains unconfirmed");
            return;
        }
        if let Err(error) = manager.mark_session_inactive(&session_id, &session).await {
            tracing::warn!(%session_id,%error,"Terminal exit history could not be saved");
        }
    });
}

#[cfg(windows)]
fn spawn_terminal_exit_watcher(
    manager: TerminalManager,
    session_id: String,
    session: Arc<LiveSession>,
    process: Arc<StdMutex<conpty::Process>>,
) {
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || loop {
            let alive = {
                let proc = process.lock().unwrap();
                proc.is_alive()
            };
            if !alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        })
        .await;
        if let Err(error) = stop_and_eventually_drain_exited_terminal(&session, &session_id).await {
            tracing::warn!(%session_id,%error,"Terminal exit output cleanup remains unconfirmed");
            return;
        }
        if let Err(error) = manager.mark_session_inactive(&session_id, &session).await {
            tracing::warn!(%session_id,%error,"Terminal exit history could not be saved");
        }
    });
}

async fn refresh_session_cwd(session: &Arc<LiveSession>) {
    if session.closed.load(Ordering::SeqCst) || session.finalizing.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut checked) = session.cwd_refreshed_at.try_lock() else {
        return;
    };
    if checked.is_some_and(|at| at.elapsed() < Duration::from_millis(250)) {
        return;
    }
    *checked = Some(std::time::Instant::now());
    let (uses_tmux, id) = {
        let state = session.state.lock().await;
        (state.uses_tmux, state.id.clone())
    };
    let cwd = if uses_tmux {
        let output = tokio::time::timeout(
            Duration::from_millis(250),
            tokio::process::Command::new("tmux")
                .args([
                    "display-message",
                    "-p",
                    "-t",
                    &crate::tmux::session_name(&id),
                    "#{pane_current_path}",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()
        .and_then(Result::ok);
        output
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|path| path.trim().to_owned())
            .filter(|path| !path.is_empty())
    } else {
        #[cfg(not(windows))]
        {
            let pid = session.io.shell_pid;
            spawn_blocking_io(move || Ok(process_cwd(pid)))
                .await
                .ok()
                .flatten()
        }
        #[cfg(windows)]
        {
            None
        }
    };
    if let Some(cwd) = cwd {
        let mut state = session.state.lock().await;
        if !session.closed.load(Ordering::SeqCst)
            && !session.finalizing.load(Ordering::SeqCst)
            && state.cwd != cwd
        {
            state.cwd = cwd;
            state.updated_at = iso_timestamp();
        }
    }
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>();
    // Fixed-size kernel metadata for this session's owned shell, without scanning processes.
    let read = unsafe {
        libc::proc_pidinfo(
            i32::try_from(pid).ok()?,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if read != size as i32 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let bytes: Vec<u8> = info
        .pvi_cdir
        .vip_path
        .iter()
        .flatten()
        .map(|byte| *byte as u8)
        .take_while(|byte| *byte != 0)
        .collect();
    String::from_utf8(bytes)
        .ok()
        .filter(|path| !path.is_empty())
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|path| path_to_string(&path))
}

#[cfg(all(not(windows), not(any(target_os = "macos", target_os = "linux"))))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

#[cfg(windows)]
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

#[cfg(windows)]
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

/// Request ids name files, so only the exact characters of a UUID-like token are accepted.
pub fn valid_create_request_id(request_id: &str) -> bool {
    (8..=64).contains(&request_id.len())
        && request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn create_requests_dir(config: &AppConfig, user_id: &str) -> Result<PathBuf, String> {
    Ok(config
        .data_dir
        .join("users")
        .join(sanitize_id(user_id)?)
        .join("terminal-create-requests"))
}

fn create_request_path(
    config: &AppConfig,
    user_id: &str,
    request_id: &str,
) -> Result<PathBuf, String> {
    if !valid_create_request_id(request_id) {
        return Err("Terminal request id is invalid".into());
    }
    Ok(create_requests_dir(config, user_id)?.join(format!("{request_id}.json")))
}

fn load_create_request(
    config: &AppConfig,
    user_id: &str,
    request_id: &str,
) -> Result<Option<String>, String> {
    let path = create_request_path(config, user_id, request_id)?;
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Terminal request record is unreadable: {error}")),
    };
    let value: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|error| format!("Terminal request record is invalid: {error}"))?;
    Ok(value
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::to_owned))
}

fn save_create_request(
    config: &AppConfig,
    user_id: &str,
    request_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let path = create_request_path(config, user_id, request_id)?;
    let dir = create_requests_dir(config, user_id)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    prune_create_requests(config, user_id, &dir);
    let staged = dir.join(format!(".{request_id}.{}.tmp", Uuid::new_v4()));
    let contents = serde_json::to_vec(&serde_json::json!({ "sessionId": session_id }))
        .map_err(|error| error.to_string())?;
    fs::write(&staged, contents).map_err(|error| error.to_string())?;
    fs::rename(&staged, path).map_err(|error| {
        let _ = fs::remove_file(&staged);
        error.to_string()
    })
}

fn delete_create_request(
    config: &AppConfig,
    user_id: &str,
    request_id: &str,
) -> Result<(), String> {
    match fs::remove_file(create_request_path(config, user_id, request_id)?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// Request records outlive their terminals only as stale pointers; drop them once many pile up.
fn prune_create_requests(config: &AppConfig, user_id: &str, dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let entries: Vec<_> = entries.flatten().collect();
    if entries.len() < CREATE_REQUEST_PRUNE_THRESHOLD {
        return;
    }
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(session_id) = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| {
                value
                    .get("sessionId")
                    .and_then(|id| id.as_str().map(str::to_owned))
            })
        else {
            continue;
        };
        if matches!(
            load_persisted_session(config, user_id, &session_id),
            Ok(None)
        ) {
            let _ = fs::remove_file(path);
        }
    }
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

fn resolve_cwd(candidate: Option<&str>) -> Result<String, String> {
    let default = env::var("HOME")
        .ok()
        .or_else(|| {
            env::current_dir()
                .ok()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| ".".to_string());
    let Some(candidate) = candidate else {
        return Ok(default);
    };
    let resolved = fs::canonicalize(candidate)
        .map_err(|error| format!("Invalid terminal working directory {candidate:?}: {error}"))?;
    if !resolved.is_dir() {
        return Err(format!(
            "Invalid terminal working directory {candidate:?}: path is not a directory"
        ));
    }
    Ok(path_to_string(&resolved))
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

/// Matches the frontend's SESSION_BUSY_WINDOW_MS: a TUI sitting idle at its
/// own prompt stops producing output, so quiet sessions are reported idle.
const BUSY_OUTPUT_WINDOW_MS: i64 = 8_000;

fn busy_is_current(is_busy: bool, last_activity_at: i64, now: i64) -> bool {
    is_busy && now.saturating_sub(last_activity_at) < BUSY_OUTPUT_WINDOW_MS
}

#[derive(Default)]
struct TerminalQueries {
    pending: String,
}
impl TerminalQueries {
    fn push(&mut self, text: &str, finished: bool) -> (String, Vec<String>) {
        const QUERY: &str = "\u{1b}[6n";
        self.pending.push_str(text);
        let mut sanitized = String::new();
        let mut responses = Vec::new();
        let mut rest = self.pending.as_str();
        while let Some(index) = rest.find(QUERY) {
            sanitized.push_str(&rest[..index]);
            responses.push("\u{1b}[1;1R".to_string());
            rest = &rest[index + QUERY.len()..];
        }
        let retained = if finished {
            0
        } else {
            (1..QUERY.len())
                .rev()
                .find(|&length| rest.ends_with(&QUERY[..length]))
                .unwrap_or(0)
        };
        let split = rest.len() - retained;
        sanitized.push_str(&rest[..split]);
        self.pending = rest[split..].to_string();
        (sanitized, responses)
    }
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
    #[tokio::test]
    async fn terminal_output_queue_backpressures_slow_consumers_without_losing_text() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct CountingReader {
            bytes: std::io::Cursor<Vec<u8>>,
            reads: Arc<AtomicUsize>,
        }
        impl std::io::Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                std::io::Read::read(&mut self.bytes, buffer)
            }
        }
        let mut bytes = "\u{1b}[32m💡界\u{1b}[0m\r\n".repeat(50_000).into_bytes();
        bytes.extend_from_slice(b"final incomplete UTF-8: \xe2\x82");
        let expected = String::from_utf8_lossy(&bytes).into_owned();
        let reads = Arc::new(AtomicUsize::new(0));
        let mut queue = super::terminal_output_queue(Box::new(CountingReader {
            bytes: std::io::Cursor::new(bytes),
            reads: reads.clone(),
        }));
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while reads.load(Ordering::SeqCst) < 65 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let stalled_reads = reads.load(Ordering::SeqCst);
        let mut actual = String::new();
        while let Some(chunk) = queue.recv().await {
            actual.push_str(&chunk);
        }
        assert_eq!(
            stalled_reads, 65,
            "Reader must stop at 64 queued chunks plus one pending send"
        );
        assert_eq!(actual, expected);
    }

    #[cfg(windows)]
    use super::shell_command;
    use super::{
        apply_thread_update, build_sandbox_info, default_thread_metadata, normalize_newlines,
        read_terminal_chunks, tmux_mode_from_env, PtyUtf8Chunks, ThreadUpdate,
    };
    #[cfg(not(windows))]
    use super::{AppConfig, TerminalCreateOptions, TerminalManager};
    use std::sync::{LazyLock, Mutex as StdMutex};
    #[cfg(not(windows))]
    use tempfile::tempdir;
    use terminal_v4_core::ThreadMetadata;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn live_cwd_tracks_typed_cd_and_ignores_unexecuted_input() {
        use super::{sleep, Duration, Path, Uuid};
        let folder = tempfile::tempdir().unwrap();
        let workspace = folder.path().join("workspace");
        let next = workspace.join("next ' $literal");
        std::fs::create_dir_all(&next).unwrap();
        let manager = TerminalManager::new(AppConfig {
            data_dir: folder.path().join("data"),
            ..Default::default()
        });
        // Explicitly disable tmux for this owned, disposable shell.
        let created = manager
            .spawn_session(
                "cwd-owner",
                Uuid::new_v4().to_string(),
                "cwd fixture".into(),
                Some(workspace.to_string_lossy().into_owned()),
                Some("/bin/sh".into()),
                None,
                None,
                Vec::new(),
                None,
                None,
                false,
                false,
            )
            .await
            .unwrap();
        let observed = async {
            for part in ["c", "d", " ", "\"next ' \\$literal\"", "\r"] {
                manager.write("cwd-owner", &created.id, part).await?;
            }
            manager.write("cwd-owner", &created.id, "pwd\r").await?;
            tokio::time::timeout(Duration::from_secs(4), async {
                loop {
                    let info = manager
                        .get_project_info("cwd-owner", &created.id)
                        .await?
                        .unwrap();
                    if Path::new(&info.cwd) == next.canonicalize().unwrap() {
                        break Ok::<_, String>(());
                    }
                    sleep(Duration::from_millis(40)).await;
                }
            })
            .await
            .map_err(|_| "Live cwd never followed the real shell".to_string())??;
            // An input frame without Enter must not invent a shell directory change.
            manager.write("cwd-owner", &created.id, "cd ..").await?;
            sleep(Duration::from_millis(300)).await;
            let info = manager
                .get_project_info("cwd-owner", &created.id)
                .await?
                .unwrap();
            assert_eq!(Path::new(&info.cwd), next.canonicalize().unwrap());
            assert!(manager
                .get_project_info("foreign-owner", &created.id)
                .await?
                .is_none());
            let summaries = manager.list_sessions("cwd-owner").await?;
            assert_eq!(Path::new(&summaries[0].cwd), next.canonicalize().unwrap());
            Ok::<_, String>(())
        }
        .await;
        manager.close("cwd-owner", &created.id).await.unwrap();
        observed.unwrap();
    }

    #[test]
    fn resolve_cwd_preserves_the_default_only_when_no_directory_is_requested() {
        let expected = std::env::var("HOME").ok().unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        });
        assert_eq!(super::resolve_cwd(None), Ok(expected));
    }

    #[test]
    fn resolve_cwd_returns_the_canonical_requested_directory() {
        let folder = tempfile::tempdir().expect("test folder should exist");
        let child = folder.path().join("child");
        std::fs::create_dir(&child).expect("child should exist");
        let candidate = child.join("..");
        assert_eq!(
            super::resolve_cwd(candidate.to_str()),
            Ok(super::path_to_string(
                &folder.path().canonicalize().unwrap()
            ))
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_cwd_follows_existing_directory_links_and_rejects_broken_links() {
        let folder = tempfile::tempdir().expect("test folder should exist");
        let workspace = folder.path().join("workspace");
        let link = folder.path().join("workspace-link");
        std::fs::create_dir(&workspace).unwrap();
        std::os::unix::fs::symlink(&workspace, &link).unwrap();
        assert_eq!(
            super::resolve_cwd(link.to_str()),
            Ok(super::path_to_string(&workspace.canonicalize().unwrap()))
        );
        std::fs::remove_dir(&workspace).unwrap();
        assert!(super::resolve_cwd(link.to_str()).is_err());
    }

    #[test]
    fn incremental_decoder_preserves_split_unicode_and_invalid_byte_semantics() {
        let cases = [
            "é € ✓ 中文 💡\r\nV4 > ".as_bytes().to_vec(),
            vec![b'a', 0xf0, 0x9f, b'b', 0xff, 0xe2, 0x82],
            vec![0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80],
            vec![0xf0, 0x28, 0x8c, 0xbc, 0xe2, 0x28, 0xa1, 0x80, 0xff],
        ];
        for bytes in cases {
            for first in 0..=bytes.len() {
                for second in first..=bytes.len() {
                    let mut decoder = PtyUtf8Chunks::default();
                    let mut actual = String::new();
                    for part in [&bytes[..first], &bytes[first..second], &bytes[second..]] {
                        actual.push_str(&decoder.push(part, false));
                        assert!(decoder.pending.len() <= 3);
                    }
                    actual.push_str(&decoder.push(&[], true));
                    assert_eq!(
                        actual,
                        String::from_utf8_lossy(&bytes),
                        "splits {first}/{second}"
                    );
                    assert!(decoder.pending.is_empty());
                    assert_eq!(decoder.push(&[], true), "", "EOF must flush exactly once");
                }
            }
        }
    }

    #[test]
    fn incremental_decoder_defers_an_incomplete_suffix_then_flushes_once_on_eof_or_error() {
        let mut decoder = PtyUtf8Chunks::default();
        assert_eq!(decoder.push(&[b'x', 0xf0], false), "x");
        assert_eq!(decoder.push(&[0x9f], false), "");
        assert_eq!(decoder.push(&[0x92], false), "");
        assert_eq!(decoder.pending.len(), 3);
        assert_eq!(decoder.push(&[], true), "\u{fffd}");
        assert_eq!(decoder.push(&[], true), "");
        let mut decoder = PtyUtf8Chunks::default();
        assert_eq!(decoder.push(&[0xf0, 0x9f], false), "");
        assert_eq!(decoder.push(&[0x92, 0xa1], false), "💡");
        assert_eq!(decoder.push(&[], true), "");
    }

    #[test]
    fn incremental_decoder_one_byte_reads_preserve_control_sequences_and_text() {
        let text = "\u{1b}[32m你好 € 💡\u{1b}[0m\r\nV4 > ";
        let mut decoder = PtyUtf8Chunks::default();
        let mut actual = String::new();
        for byte in text.as_bytes() {
            actual.push_str(&decoder.push(&[*byte], false));
            assert!(decoder.pending.len() <= 3);
        }
        actual.push_str(&decoder.push(&[], true));
        assert_eq!(actual, text);
    }

    struct FragmentedPtyReader {
        chunks: std::collections::VecDeque<Vec<u8>>,
        error_at_end: bool,
    }
    impl std::io::Read for FragmentedPtyReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if let Some(bytes) = self.chunks.pop_front() {
                assert!(bytes.len() <= buffer.len());
                buffer[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            } else if self.error_at_end {
                Err(std::io::Error::other("synthetic PTY read end"))
            } else {
                Ok(0)
            }
        }
    }
    #[test]
    fn actual_pty_reader_flushes_split_unicode_and_incomplete_suffix_on_eof_or_error() {
        for error_at_end in [false, true] {
            let bytes = b"prefix \xf0\x9f\x92\xa1 suffix \xe2\x82";
            let mut reader = FragmentedPtyReader {
                chunks: bytes.iter().map(|byte| vec![*byte]).collect(),
                error_at_end,
            };
            let mut chunks = Vec::new();
            read_terminal_chunks(&mut reader, |text| {
                chunks.push(text);
                true
            });
            assert_eq!(chunks.join(""), String::from_utf8_lossy(bytes));
            assert_eq!(chunks.last().unwrap(), "\u{fffd}");
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_delete_waits_for_publication_then_cannot_be_resurrected_by_late_output() {
        let folder = tempfile::tempdir().unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
        manager
            .handle_terminal_output(live.clone(), "PUBLISH_BEFORE_EXPLICIT_DELETE".into())
            .await
            .unwrap();
        let state = live.state.lock().await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while live.batcher.try_lock().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut deleting = Box::pin(manager.close("synthetic-owner", &created.id));
        assert!(futures_util::poll!(&mut deleting).is_pending());
        drop(state);
        assert!(deleting.await.unwrap());
        manager
            .handle_terminal_output(live.clone(), "LATE_OUTPUT_MUST_NOT_RECREATE_JOURNAL".into())
            .await
            .unwrap();
        manager
            .mark_session_inactive(&created.id, &live)
            .await
            .unwrap();
        assert!(super::load_persisted_session(
            &manager.inner.config,
            "synthetic-owner",
            &created.id
        )
        .unwrap()
        .is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn suspend_drains_final_owned_child_bytes_before_retaining_and_closing() {
        let folder = tempfile::tempdir().unwrap();
        let ready = folder.path().join("ready.pid");
        let script = folder.path().join("term-tail.py");
        std::fs::write(&script,"import os,pathlib,signal,sys,time\ndef stop(sig,frame):\n sys.stdout.write('FINAL_BYTES_DURING_SUSPEND\\n');sys.stdout.flush();sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\nwhile True:time.sleep(0.01)\n").unwrap();
        let quote =
            |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: Some(format!(
                        "exec /usr/bin/python3 {} {}",
                        quote(&script),
                        quote(&ready)
                    )),
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let mut events = live.broadcaster.subscribe();
        let observed = async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while !ready.exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Synthetic suspend child did not start".to_string())?;
            manager.suspend("synthetic-owner", &created.id).await?;
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "synthetic-owner",
                &created.id,
            )?
            .ok_or("Suspend did not preserve its journal")?;
            let mut streamed = String::new();
            let mut closed = false;
            while let Ok(event) = events.try_recv() {
                match event {
                    super::TerminalSubscriptionEvent::Output(event) => {
                        assert!(!closed);
                        streamed.push_str(&event.text);
                    }
                    super::TerminalSubscriptionEvent::Closed => closed = true,
                }
            }
            Ok::<_, String>((
                closed,
                streamed,
                stored
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
            ))
        }
        .await;
        live.io.stop_tree().await.unwrap();
        let (closed, streamed, stored) = observed.unwrap();
        assert!(closed);
        assert!(streamed.contains("FINAL_BYTES_DURING_SUSPEND"));
        assert!(stored.contains("FINAL_BYTES_DURING_SUSPEND"));
    }

    #[cfg(unix)]
    async fn metadata_terminal_fixture() -> (
        tempfile::TempDir,
        super::TerminalManager,
        terminal_v4_core::TerminalSessionSnapshot,
        std::sync::Arc<super::LiveSession>,
    ) {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let shell = folder.path().join("metadata-shell.sh");
        let starts = folder.path().join("metadata-started-pids");
        let starts_quoted = starts.to_string_lossy().replace('\'', "'\\''");
        std::fs::write(
            &shell,
            format!("#!/bin/sh\nprintf '%s\\n' \"$$\" >> '{starts_quoted}'\nexec /bin/cat\n"),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "metadata-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: Some("Original metadata title".into()),
                    shell: Some(shell.to_string_lossy().into_owned()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if std::fs::read_to_string(&starts)
                    .ok()
                    .is_some_and(|text| !text.trim().is_empty())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("The owned metadata fixture did not record its PID");
        (folder, manager, created, live)
    }

    #[cfg(unix)]
    async fn assert_metadata_update_does_not_recreate_a_deleted_journal(update_thread: bool) {
        let (_folder, manager, created, live) = metadata_terminal_fixture().await;
        let observed = async {
            let state = live.state.lock().await;
            let mut updating = Box::pin(async {
                if update_thread {
                    manager
                        .update_thread(
                            "metadata-owner",
                            &created.id,
                            ThreadUpdate {
                                topic: Some(Some("Late thread update".into())),
                                pinned: Some(true),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|value| value.is_some())
                } else {
                    manager
                        .rename_session("metadata-owner", &created.id, "Late renamed title")
                        .await
                        .map(|value| value.is_some())
                }
            });
            if !futures_util::poll!(&mut updating).is_pending() {
                return Err("Metadata update did not wait for its held state".to_string());
            }
            let mut deleting = Box::pin(manager.close("metadata-owner", &created.id));
            if !futures_util::poll!(&mut deleting).is_pending() {
                return Err("Delete did not wait for the held lifecycle/state guard".to_string());
            }
            drop(state);

            // On the old path this updater releases state, then yields while
            // persistence reacquires it behind Delete's owner check. A guarded
            // updater may instead complete before Delete; both orders are valid.
            let updated = match futures_util::poll!(&mut updating) {
                std::task::Poll::Ready(result) => Some(result),
                std::task::Poll::Pending => None,
            };
            let deleted = match futures_util::poll!(&mut deleting) {
                std::task::Poll::Ready(result) => Some(result),
                std::task::Poll::Pending => None,
            };
            if let Some(result) = updated {
                result?;
            } else {
                updating.await?;
            }
            let deleted = if let Some(result) = deleted {
                result?
            } else {
                deleting.await?
            };
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "metadata-owner",
                &created.id,
            )?
            .map(|stored| (stored.title, stored.thread));
            Ok::<_, String>((deleted, stored))
        }
        .await;
        live.io.stop_tree().await.unwrap();
        let (deleted, stored) = observed.unwrap();
        assert!(deleted, "The owned terminal was not deleted");
        assert!(
            stored.is_none(),
            "A late metadata update recreated the explicitly deleted journal: {stored:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rename_session_cannot_recreate_a_journal_after_concurrent_explicit_delete() {
        assert_metadata_update_does_not_recreate_a_deleted_journal(false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_thread_cannot_recreate_a_journal_after_concurrent_explicit_delete() {
        assert_metadata_update_does_not_recreate_a_deleted_journal(true).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn metadata_updates_preserve_owner_checks_for_live_and_retained_terminal_journals() {
        let (_folder, manager, created, live) = metadata_terminal_fixture().await;
        let observed = async {
            assert!(manager
                .rename_session("foreign-metadata-owner", &created.id, "Foreign rename")
                .await?
                .is_none());
            assert!(manager
                .update_thread(
                    "foreign-metadata-owner",
                    &created.id,
                    ThreadUpdate {
                        topic: Some(Some("Foreign topic".into())),
                        pinned: Some(true),
                        ..Default::default()
                    },
                )
                .await?
                .is_none());
            {
                let state = live.state.lock().await;
                assert_eq!(state.title, "Original metadata title");
                assert!(state.thread.is_none());
            }
            assert!(manager.suspend("metadata-owner", &created.id).await?);
            let original = super::load_persisted_session(
                &manager.inner.config,
                "metadata-owner",
                &created.id,
            )?
            .ok_or("Retained owned journal is missing")?;
            assert!(manager
                .rename_session(
                    "foreign-metadata-owner",
                    &created.id,
                    "Foreign retained rename"
                )
                .await?
                .is_none());
            assert!(manager
                .update_thread(
                    "foreign-metadata-owner",
                    &created.id,
                    ThreadUpdate {
                        archived: Some(true),
                        ..Default::default()
                    },
                )
                .await?
                .is_none());
            let owned = manager
                .rename_session("metadata-owner", &created.id, "Owned retained rename")
                .await?
                .ok_or("Owner could not rename the retained journal")?;
            assert_eq!(owned.title, "Owned retained rename");
            let thread = manager
                .update_thread(
                    "metadata-owner",
                    &created.id,
                    ThreadUpdate {
                        topic: Some(Some("Owned retained topic".into())),
                        pinned: Some(true),
                        ..Default::default()
                    },
                )
                .await?
                .ok_or("Owner could not update the retained thread")?;
            assert_eq!(thread.topic.as_deref(), Some("Owned retained topic"));
            assert!(thread.pinned);
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "metadata-owner",
                &created.id,
            )?
            .ok_or("Owned metadata updates lost the retained journal")?;
            assert_eq!(stored.title, "Owned retained rename");
            assert_eq!(stored.history, original.history);
            assert_eq!(
                stored.thread.unwrap().topic.as_deref(),
                Some("Owned retained topic")
            );
            assert!(super::load_persisted_session(
                &manager.inner.config,
                "foreign-metadata-owner",
                &created.id,
            )?
            .is_none());
            manager.close("metadata-owner", &created.id).await?;
            Ok::<_, String>(())
        }
        .await;
        live.io.stop_tree().await.unwrap();
        observed.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_restores_start_only_one_owned_process_for_the_same_retained_session() {
        use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
        let (folder, manager, created, old_live) = metadata_terminal_fixture().await;
        assert!(manager
            .suspend("metadata-owner", &created.id)
            .await
            .unwrap());
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let original = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let fifo = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let restoring_manager = manager.clone();
        let restoring_id = created.id.clone();
        let runtime = tokio::runtime::Handle::current();
        let first = tokio::task::spawn_blocking(move || {
            runtime.block_on(restoring_manager.restore_session(
                "metadata-owner",
                &restoring_id,
                None,
                None,
            ))
        });
        let writer = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                match std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&path)
                {
                    Ok(writer) => break writer,
                    Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("Could not connect concurrent restore gate: {error}"),
                }
            }
        })
        .await
        .expect("First restore did not reach its real stored-head read");
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, &original).unwrap();
        let mut second =
            Box::pin(manager.restore_session("metadata-owner", &created.id, None, None));
        let second_result = match futures_util::poll!(&mut second) {
            std::task::Poll::Ready(result) => Some(result),
            std::task::Poll::Pending => None,
        };
        let early_second_live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned();
        let written = (|| {
            let mut writer = writer;
            std::io::Write::write_all(&mut writer, &original)
        })();
        let first_result = tokio::time::timeout(std::time::Duration::from_secs(4), first)
            .await
            .expect("First restore did not settle after its stored head was released")
            .unwrap();
        let first_live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let second_result = if let Some(result) = second_result {
            result
        } else {
            second.await
        };
        let second_live = early_second_live.unwrap_or_else(|| first_live.clone());
        let same_instance = std::sync::Arc::ptr_eq(&first_live, &second_live);
        let expected_observed_starts = if same_instance { 2 } else { 3 };
        let launches = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let text = std::fs::read_to_string(folder.path().join("metadata-started-pids"))
                    .unwrap_or_default();
                let pids = text
                    .lines()
                    .filter_map(|line| line.parse::<u32>().ok())
                    .collect::<Vec<_>>();
                if pids.len() >= expected_observed_starts {
                    break pids;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        manager.close("metadata-owner", &created.id).await.unwrap();
        old_live.io.stop_tree().await.unwrap();
        first_live.io.stop_tree().await.unwrap();
        second_live.io.stop_tree().await.unwrap();
        written.unwrap();
        assert!(first_result.unwrap().is_some());
        assert!(second_result.unwrap().is_some());
        let launches = launches.expect("Owned restore launch markers did not arrive");
        assert!(
            same_instance,
            "Concurrent restores replaced an already live owned process"
        );
        assert_eq!(
            launches.len(),
            2,
            "Expected the original child plus one restored child, got {launches:?}"
        );
        assert_ne!(launches[0], launches[1]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn silent_restore_durably_preserves_thread_and_next_launch_sandbox_metadata() {
        let (folder, manager, created, old_live) = metadata_terminal_fixture().await;
        let workspace = folder.path().to_string_lossy().into_owned();
        let expected_thread = manager
            .update_thread(
                "metadata-owner",
                &created.id,
                ThreadUpdate {
                    topic: Some(Some("Retained restore topic".into())),
                    pinned: Some(true),
                    sandbox_mode: Some("read-only".into()),
                    sandbox_workspace_root: Some(Some(workspace.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert!(manager
            .suspend("metadata-owner", &created.id)
            .await
            .unwrap());
        let original =
            super::load_persisted_session(&manager.inner.config, "metadata-owner", &created.id)
                .unwrap()
                .unwrap();
        let restored = manager
            .restore_session("metadata-owner", &created.id, None, None)
            .await
            .unwrap()
            .unwrap();
        let restored_live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let live_metadata = {
            let state = restored_live.state.lock().await;
            (state.thread.clone(), state.sandbox.clone())
        };
        let persisted =
            super::load_persisted_session(&manager.inner.config, "metadata-owner", &created.id)
                .unwrap()
                .unwrap();
        manager.close("metadata-owner", &created.id).await.unwrap();
        old_live.io.stop_tree().await.unwrap();
        restored_live.io.stop_tree().await.unwrap();
        let expected_sandbox =
            super::build_sandbox_info(Some("read-only"), Some(workspace), &created.id);
        assert_eq!(live_metadata.0.as_ref(), Some(&expected_thread));
        assert_eq!(live_metadata.1, expected_sandbox);
        assert_eq!(restored.sandbox, expected_sandbox);
        assert_eq!(persisted.history, original.history);
        assert_eq!(persisted.sandbox, expected_sandbox);
        assert_eq!(
            persisted.thread.as_ref(),
            Some(&expected_thread),
            "A silent restore returned success before the restored thread metadata was durable"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_session_cannot_recreate_a_retained_journal_after_concurrent_explicit_delete() {
        use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
        let (_folder, manager, created, old_live) = metadata_terminal_fixture().await;
        assert!(manager
            .suspend("metadata-owner", &created.id)
            .await
            .unwrap());
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let original = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let fifo = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let restoring_manager = manager.clone();
        let restoring_id = created.id.clone();
        let runtime = tokio::runtime::Handle::current();
        // The FIFO pauses the actual stored-head read after restore has passed
        // its inactive lookup. Only this fresh fixture's path is replaced.
        let restoring = tokio::task::spawn_blocking(move || {
            runtime.block_on(restoring_manager.restore_session(
                "metadata-owner",
                &restoring_id,
                None,
                None,
            ))
        });
        let writer = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                match std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&path)
                {
                    Ok(writer) => break writer,
                    Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("Could not connect synthetic restore gate: {error}"),
                }
            }
        })
        .await
        .expect("Restore never reached the synthetic stored-head read");
        // Keep the open FIFO descriptors as the pause gate, but restore a
        // regular path before Delete or the later spawn persists its snapshot.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, &original).unwrap();
        let mut deleting = Box::pin(manager.close("metadata-owner", &created.id));
        let deleted = match futures_util::poll!(&mut deleting) {
            std::task::Poll::Ready(result) => Some(result),
            std::task::Poll::Pending => None,
        };
        let delete_finished_during_restore = deleted.is_some();
        let written = (|| {
            let mut writer = writer;
            std::io::Write::write_all(&mut writer, &original)
        })();
        let restored = tokio::time::timeout(std::time::Duration::from_secs(4), restoring)
            .await
            .expect("Restore did not settle after its stored head was released")
            .unwrap();
        let deleted = if let Some(result) = deleted {
            result
        } else {
            deleting.await
        };
        let resurrected =
            super::load_persisted_session(&manager.inner.config, "metadata-owner", &created.id)
                .unwrap()
                .is_some();
        // Always close a resurrected fixture process before reporting failure.
        manager.close("metadata-owner", &created.id).await.unwrap();
        old_live.io.stop_tree().await.unwrap();
        written.unwrap();
        assert!(restored.unwrap().is_some());
        assert!(deleted.unwrap());
        assert!(
            !delete_finished_during_restore,
            "Delete acknowledged before the in-flight owned restore settled"
        );
        assert!(
            !resurrected,
            "An in-flight restore recreated the explicitly deleted journal"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_journal_deletion_keeps_terminal_process_cleanup_owned_and_retryable() {
        let (folder, manager, created, live) = metadata_terminal_fixture().await;
        let pid = std::fs::read_to_string(folder.path().join("metadata-started-pids"))
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-delete.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic delete fault").unwrap();
        let first = manager.close("metadata-owner", &created.id).await;
        let retained = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, &live));
        let alive_after_error = unsafe { libc::kill(pid, 0) } == 0;
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        let retry = manager.close("metadata-owner", &created.id).await;
        let retry_process_exit = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        let journal_exists_after_retry = path.exists();
        // The old implementation loses the manager entry on its first error;
        // keep the explicit fixture Arc so its real child is always stopped.
        live.io.stop_tree().await.unwrap();
        assert!(first.is_err(), "The synthetic deletion fault was hidden");
        assert!(
            !alive_after_error || retained,
            "Deletion failed with a live child but discarded its cleanup owner"
        );
        assert!(retry.unwrap());
        assert!(
            retry_process_exit.is_ok(),
            "Retrying Delete acknowledged while the original owned child still ran"
        );
        assert!(!journal_exists_after_retry);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_after_failed_suspend_recovers_a_fresh_working_pty() {
        let (folder, manager, created, old_live) = metadata_terminal_fixture().await;
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-suspend.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic finalization fault").unwrap();
        let suspended = manager.suspend("metadata-owner", &created.id).await;
        let supervisors_settled = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while std::sync::Arc::strong_count(&old_live) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        let was_closed = old_live.closed.load(std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        let restored = manager
            .restore_session("metadata-owner", &created.id, None, None)
            .await;
        let current = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned();
        let fresh_live = current.as_ref().is_some_and(|current| {
            !std::sync::Arc::ptr_eq(current, &old_live)
                && !current.closed.load(std::sync::atomic::Ordering::SeqCst)
        });
        let working_io = async {
            if matches!(&restored, Ok(Some(_))) && fresh_live {
                let mut events = current.as_ref().unwrap().broadcaster.subscribe();
                manager
                    .write("metadata-owner", &created.id, "RESTORED_PTY_WORKS\n")
                    .await?;
                tokio::time::timeout(std::time::Duration::from_secs(3), async {
                    loop {
                        match events.recv().await.map_err(|error| error.to_string())? {
                            super::TerminalSubscriptionEvent::Output(event)
                                if event.text.contains("RESTORED_PTY_WORKS") =>
                            {
                                return Ok::<_, String>(())
                            }
                            super::TerminalSubscriptionEvent::Closed => {
                                return Err("Restored PTY closed before live output".into())
                            }
                            _ => {}
                        }
                    }
                })
                .await
                .map_err(|_| "Restored PTY did not stream working I/O".to_string())?
            } else {
                Err("Restore did not produce a fresh live PTY".to_string())
            }
        }
        .await;
        let launches = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let text =
                    std::fs::read_to_string(folder.path().join("metadata-started-pids")).unwrap();
                let pids = text
                    .lines()
                    .map(|line| line.parse::<u32>().unwrap())
                    .collect::<Vec<_>>();
                if pids.len() >= if fresh_live { 2 } else { 1 } {
                    break pids;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        manager.close("metadata-owner", &created.id).await.unwrap();
        old_live.io.stop_tree().await.unwrap();
        if let Some(current) = current {
            current.io.stop_tree().await.unwrap();
        }
        assert!(
            suspended.is_err(),
            "The synthetic finalization fault was hidden"
        );
        assert!(
            supervisors_settled.is_ok(),
            "The fixture's exit owners did not settle"
        );
        assert!(
            was_closed,
            "The failed suspend did not reach its final persistence boundary"
        );
        assert!(restored.unwrap().is_some());
        assert!(
            fresh_live,
            "Restore acknowledged the original stopped, closed PTY"
        );
        working_io.unwrap();
        let launches = launches.unwrap();
        assert_eq!(launches.len(), 2);
        assert_ne!(launches[0], launches[1]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn late_exit_finalization_cannot_recreate_a_journal_while_delete_retry_is_pending() {
        let (folder, manager, created, live) = metadata_terminal_fixture().await;
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-late-delete.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic pending delete").unwrap();
        let first = manager.close("metadata-owner", &created.id).await;
        let lifecycle = manager.inner.lifecycle.lock().await;
        live.io.stop_tree().await.unwrap();
        super::wait_for_terminal_reader(&live).await.unwrap();
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        let mut late_exit = Box::pin(manager.mark_session_inactive(&created.id, &live));
        assert!(futures_util::poll!(&mut late_exit).is_pending());
        drop(lifecycle);
        let finalized = late_exit.await;
        let recreated = path.exists();
        let restored = manager
            .restore_session("metadata-owner", &created.id, None, None)
            .await;
        let retry = manager.close("metadata-owner", &created.id).await;
        live.io.stop_tree().await.unwrap();
        assert!(first.is_err());
        finalized.unwrap();
        assert!(
            !recreated,
            "A delayed exit callback recreated a pending Delete journal"
        );
        let error = restored.expect_err("A pending Delete was allowed to restore a terminal");
        assert!(
            error.to_ascii_lowercase().contains("delet"),
            "Pending Delete was not explained: {error}"
        );
        assert!(retry.unwrap(), "Retry lost its owned pending Delete");
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_pending_batch_persistence_retains_closed_bytes_for_fresh_restore() {
        let (folder, manager, created, old_live) = metadata_terminal_fixture().await;
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-pending-flush.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic pending-flush fault").unwrap();
        manager
            .handle_terminal_output(
                old_live.clone(),
                "PENDING_FINAL_BYTES_AFTER_SAVE_FAULT".into(),
            )
            .await
            .unwrap();
        {
            let mut batcher = old_live.batcher.lock().await;
            batcher.cancel_timer();
            assert!(!batcher.is_empty());
        }
        let suspended = manager.suspend("metadata-owner", &created.id).await;
        let closed_at_error = old_live.closed.load(std::sync::atomic::Ordering::SeqCst);
        let retained_in_memory = old_live
            .state
            .try_lock()
            .unwrap()
            .history
            .iter()
            .any(|event| event.text.contains("PENDING_FINAL_BYTES_AFTER_SAVE_FAULT"));
        let supervisors_settled = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while std::sync::Arc::strong_count(&old_live) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        let restored = manager
            .restore_session("metadata-owner", &created.id, None, None)
            .await;
        let current = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned();
        let fresh_live = current.as_ref().is_some_and(|current| {
            !std::sync::Arc::ptr_eq(current, &old_live)
                && !current.closed.load(std::sync::atomic::Ordering::SeqCst)
        });
        let stored =
            super::load_persisted_session(&manager.inner.config, "metadata-owner", &created.id)
                .unwrap();
        manager.close("metadata-owner", &created.id).await.unwrap();
        old_live.io.stop_tree().await.unwrap();
        if let Some(current) = current {
            current.io.stop_tree().await.unwrap();
        }
        assert!(suspended.is_err());
        assert!(
            closed_at_error,
            "A stopped PTY stayed active when its pending batch failed to persist"
        );
        assert!(
            retained_in_memory,
            "The already-published final batch was discarded"
        );
        assert!(supervisors_settled.is_ok());
        assert!(restored.unwrap().is_some());
        assert!(
            fresh_live,
            "Restore acknowledged a stopped pending-flush PTY"
        );
        assert!(
            stored
                .unwrap()
                .history
                .iter()
                .any(|event| event.text.contains("PENDING_FINAL_BYTES_AFTER_SAVE_FAULT")),
            "Fresh restore lost final bytes retained after the failed save"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_refuses_a_stopped_pty_while_its_bounded_reader_drain_is_pending() {
        let folder = tempfile::tempdir().unwrap();
        let ready = folder.path().join("ready.pid");
        let stopping = folder.path().join("stopping");
        let release = folder.path().join("release-tail");
        let script = folder.path().join("delayed-stop-tail.py");
        std::fs::write(&script,"import os,pathlib,signal,sys,time\ndef stop(sig,frame):\n pathlib.Path(sys.argv[2]).write_text('stopping')\n while not pathlib.Path(sys.argv[3]).exists():time.sleep(0.005)\n sys.stdout.write('TAIL_AFTER_BOUNDED_DRAIN\\n');sys.stdout.flush();sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\nwhile True:time.sleep(0.01)\n").unwrap();
        let quote =
            |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "drain-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: Some(format!(
                        "exec /usr/bin/python3 {} {} {} {}",
                        quote(&script),
                        quote(&ready),
                        quote(&stopping),
                        quote(&release)
                    )),
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let mut events = live.broadcaster.subscribe();
        let observed = async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while !ready.exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Bounded-drain child did not start".to_string())?;
            let suspend_manager = manager.clone();
            let suspend_id = created.id.clone();
            let suspending =
                tokio::spawn(
                    async move { suspend_manager.suspend("drain-owner", &suspend_id).await },
                );
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while !stopping.exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Bounded-drain child did not receive stop".to_string())?;
            // The stop owner has finished its ownership check. Hold only the
            // reader's state while the handler emits final bytes and exits.
            let state = live.state.lock().await;
            std::fs::write(&release, "go").map_err(|error| error.to_string())?;
            let suspended = tokio::time::timeout(std::time::Duration::from_secs(5), suspending)
                .await
                .map_err(|_| "Bounded suspend never returned".to_string())?
                .map_err(|error| error.to_string())?;
            let reader_remains_streamable = manager.is_active(&created.id).await;
            let mut restoring =
                Box::pin(manager.restore_session("drain-owner", &created.id, None, None));
            if !futures_util::poll!(&mut restoring).is_pending() {
                return Err("Restore did not wait for the held owner state".to_string());
            }
            drop(state);
            let restored = restoring.await;
            let streamed = tokio::time::timeout(std::time::Duration::from_secs(4), async {
                let mut text = String::new();
                loop {
                    match events.recv().await.map_err(|error| error.to_string())? {
                        super::TerminalSubscriptionEvent::Output(event) => {
                            text.push_str(&event.text)
                        }
                        super::TerminalSubscriptionEvent::Closed => return Ok::<_, String>(text),
                    }
                }
            })
            .await
            .map_err(|_| "Natural supervisor did not finalize the late reader".to_string())??;
            let stored =
                super::load_persisted_session(&manager.inner.config, "drain-owner", &created.id)?
                    .ok_or("Bounded drain lost retained history")?;
            Ok::<_, String>((
                suspended,
                restored,
                streamed,
                stored.history,
                reader_remains_streamable,
            ))
        }
        .await;
        manager.close("drain-owner", &created.id).await.unwrap();
        live.io.stop_tree().await.unwrap();
        let (suspended, restored, streamed, history, reader_remains_streamable) = observed.unwrap();
        assert!(
            reader_remains_streamable,
            "A still-draining reader lost its live tail subscription"
        );
        assert!(
            suspended.is_err(),
            "The deliberately blocked bounded reader was falsely confirmed drained"
        );
        let error =
            restored.expect_err("Restore acknowledged a stopped PTY with pending reader bytes");
        assert!(
            error.to_ascii_lowercase().contains("finaliz")
                || error.to_ascii_lowercase().contains("drain"),
            "Pending reader was not explained: {error}"
        );
        assert!(streamed.contains("TAIL_AFTER_BOUNDED_DRAIN"));
        assert!(history
            .iter()
            .any(|event| event.text.contains("TAIL_AFTER_BOUNDED_DRAIN")));
    }

    #[test]
    fn busy_expires_after_a_quiet_output_window() {
        use super::{busy_is_current, BUSY_OUTPUT_WINDOW_MS};
        let last_output = 1_000_000;
        let states = [
            busy_is_current(true, last_output, last_output + BUSY_OUTPUT_WINDOW_MS - 1),
            busy_is_current(true, last_output, last_output + BUSY_OUTPUT_WINDOW_MS),
            busy_is_current(false, last_output, last_output),
        ];
        assert_eq!(states, [true, false, false]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closed_retained_cleanup_owner_is_not_reported_as_live_or_busy() {
        let (folder, manager, created, live) = metadata_terminal_fixture().await;
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-status-fault.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic status fault").unwrap();
        let suspended = manager.suspend("metadata-owner", &created.id).await;
        let supervisors_settled = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while std::sync::Arc::strong_count(&live) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        // A failed final-head write can retain stale activity metadata. Status
        // must describe the closed stream without discarding its cleanup owner.
        live.state.lock().await.is_busy = true;
        let owned = manager.list_sessions("metadata-owner").await;
        let foreign = manager.list_sessions("foreign-metadata-owner").await;
        let streamable = manager.is_active(&created.id).await;
        let retained = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, &live));
        let workspace_still_owned = manager.has_live_workspace(folder.path()).await;
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        manager.close("metadata-owner", &created.id).await.unwrap();
        live.io.stop_tree().await.unwrap();
        assert!(suspended.is_err());
        assert!(supervisors_settled.is_ok());
        assert!(
            retained,
            "Reporting an inactive stream discarded its cleanup owner"
        );
        assert!(
            workspace_still_owned,
            "Retained cleanup stopped guarding its workspace"
        );
        assert!(!streamable, "A closed retained PTY was reported streamable");
        let owned = owned.unwrap();
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].id, created.id);
        assert!(
            !owned[0].is_active,
            "A failed stopped PTY was listed as live"
        );
        assert!(
            !owned[0].is_busy,
            "A closed retained stream was listed as busy"
        );
        assert!(foreign.unwrap().is_empty());
    }

    #[cfg(unix)]
    fn isolated_named_tmux_test_root(test_name: &str) -> Option<std::path::PathBuf> {
        const CHILD_ROOT: &str = "V4_OWNED_TMUX_RETRY_TEST_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            return Some(root.into());
        }
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary_dir = root.path().join("bin");
        std::fs::create_dir(&binary_dir).unwrap();
        let fake = binary_dir.join("tmux");
        std::fs::write(
            &fake,
            r#"#!/usr/bin/python3
import os,pathlib,sys
r=pathlib.Path(os.environ['V4_OWNED_TMUX_RETRY_TEST_ROOT'])
expected=(r/'expected-session').read_text()
args=sys.argv[1:]
if (r/'journal-path').exists(): expected='='+expected
if args==['has-session','-t',expected]:
 p=r/'has-count';p.write_text(str((int(p.read_text()) if p.exists() else 0)+1))
 sys.exit(1 if (r/'named-cleaned').exists() else 0)
if args!=['kill-session','-t',expected]:sys.exit(64)
if (r/'journal-path').exists() and not pathlib.Path((r/'journal-path').read_text()).exists():
 print('recovery journal deleted before named cleanup',file=sys.stderr);sys.exit(65)
p=r/'kill-count';p.write_text(str((int(p.read_text()) if p.exists() else 0)+1))
if (r/'reject-kill').exists():
 print('synthetic named cleanup refused',file=sys.stderr);sys.exit(1)
if (r/'named-cleaned').exists():
 print(('can\'t find session: '+expected) if (r/'journal-path').exists() else 'synthetic session already removed',file=sys.stderr);sys.exit(1)
(r/'named-cleaned').write_text('confirmed')
if (r/'obstruct-delete').exists():
 p=pathlib.Path((r/'journal-path').read_text());p.rename(r/'retained-journal');p.mkdir()
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut search = vec![binary_dir];
        search.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD_ROOT, root.path())
            .env("PATH", std::env::join_paths(search).unwrap())
            .env("TERMINAL_USE_TMUX", "false")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Isolated named-cleanup fixture failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        None
    }

    #[cfg(unix)]
    async fn assert_known_named_tmux_cleanup_is_not_repeated(deleting: bool) {
        let test_name = if deleting {
            "terminal::tests::delete_retry_does_not_repeat_known_successful_named_tmux_cleanup"
        } else {
            "terminal::tests::suspend_retry_does_not_repeat_known_successful_named_tmux_cleanup"
        };
        let Some(root) = isolated_named_tmux_test_root(test_name) else {
            return;
        };
        let (folder, manager, created, live) = metadata_terminal_fixture().await;
        std::fs::write(
            root.join("expected-session"),
            crate::tmux::session_name(&created.id),
        )
        .unwrap();
        live.state.lock().await.uses_tmux = true;
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-named-cleanup.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic named-cleanup fault").unwrap();
        if !deleting {
            manager
                .handle_terminal_output(live.clone(), "FINAL_AFTER_NAMED_CLEANUP".into())
                .await
                .unwrap();
            let mut batcher = live.batcher.lock().await;
            batcher.cancel_timer();
            assert!(!batcher.is_empty());
        }
        let first = if deleting {
            manager.close("metadata-owner", &created.id).await
        } else {
            manager.suspend("metadata-owner", &created.id).await
        };
        let supervisors_settled = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while std::sync::Arc::strong_count(&live) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        let cleanup_recorded = !live.state.lock().await.uses_tmux;
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        let retry = if deleting {
            manager.close("metadata-owner", &created.id).await
        } else {
            manager.suspend("metadata-owner", &created.id).await
        };
        let calls = std::fs::read_to_string(root.join("kill-count"))
            .unwrap()
            .parse::<usize>()
            .unwrap();
        let saved_tail = if deleting {
            true
        } else {
            super::load_persisted_session(&manager.inner.config, "metadata-owner", &created.id)
                .unwrap()
                .is_some_and(|stored| {
                    stored
                        .history
                        .iter()
                        .any(|event| event.text.contains("FINAL_AFTER_NAMED_CLEANUP"))
                })
        };
        // Ensure the intentionally failing old implementation cannot keep a
        // named-cleanup retry fence or an owned process alive after this test.
        live.state.lock().await.uses_tmux = false;
        manager.close("metadata-owner", &created.id).await.unwrap();
        live.io.stop_tree().await.unwrap();
        assert!(first.is_err());
        assert!(supervisors_settled.is_ok());
        assert!(root.join("named-cleaned").exists());
        assert!(
            cleanup_recorded,
            "Known successful named cleanup was not recorded before a later failure"
        );
        assert!(
            retry.unwrap(),
            "Retry did not finish after storage was repaired"
        );
        assert_eq!(
            calls, 1,
            "Retry repeated a named kill already confirmed successful"
        );
        assert!(
            saved_tail,
            "Retry lost the pending final output after named cleanup"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_retry_does_not_repeat_known_successful_named_tmux_cleanup() {
        assert_known_named_tmux_cleanup_is_not_repeated(true).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn suspend_retry_does_not_repeat_known_successful_named_tmux_cleanup() {
        assert_known_named_tmux_cleanup_is_not_repeated(false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_pending_delete_keeps_its_managed_tmux_owner_inactive_without_auto_restore() {
        let Some(root)=isolated_named_tmux_test_root("terminal::tests::listing_pending_delete_keeps_its_managed_tmux_owner_inactive_without_auto_restore") else {return;};
        let _env_guard = ENV_LOCK.lock().unwrap();
        let (folder, manager, created, live) = metadata_terminal_fixture().await;
        std::fs::write(
            root.join("expected-session"),
            crate::tmux::session_name(&created.id),
        )
        .unwrap();
        std::fs::write(
            root.join("reject-kill"),
            "synthetic named server is still present",
        )
        .unwrap();
        live.state.lock().await.uses_tmux = true;
        super::persist_session_state(&manager.inner.config, &live)
            .await
            .unwrap();
        let path = super::sessions_dir(&manager.inner.config, "metadata-owner")
            .unwrap()
            .join(format!("{}.json", created.id));
        let backup = folder.path().join("journal-before-managed-tmux-fault.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("obstruction"), "synthetic pending-delete fault").unwrap();
        let first = manager.close("metadata-owner", &created.id).await;
        let retained = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, &live));
        let named_cleanup_unconfirmed = live.state.lock().await.uses_tmux;
        std::fs::remove_file(path.join("obstruction")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        // Only this exact-test child changes mode, and restores it even if the
        // list call unwinds. Its tmux lookup resolves to the owned fake.
        struct RestoreMode(Option<std::ffi::OsString>);
        impl Drop for RestoreMode {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => unsafe { std::env::set_var("TERMINAL_USE_TMUX", value) },
                    None => unsafe { std::env::remove_var("TERMINAL_USE_TMUX") },
                }
            }
        }
        let mode = RestoreMode(std::env::var_os("TERMINAL_USE_TMUX"));
        unsafe { std::env::set_var("TERMINAL_USE_TMUX", "true") };
        let listed = manager.list_sessions("metadata-owner").await;
        drop(mode);
        let has_calls = std::fs::read_to_string(root.join("has-count"))
            .ok()
            .map(|text| text.parse::<usize>().unwrap())
            .unwrap_or(0);
        std::fs::remove_file(root.join("reject-kill")).unwrap();
        let retry = manager.close("metadata-owner", &created.id).await;
        live.io.stop_tree().await.unwrap();
        let error = first.unwrap_err();
        assert!(
            error.contains("synthetic named cleanup refused"),
            "Unknown named cleanup failure was hidden: {error}"
        );
        assert!(retained);
        assert!(
            named_cleanup_unconfirmed,
            "Failed named cleanup was falsely recorded successful"
        );
        assert!(retry.unwrap());
        let listed = listed.expect("Listing an owned cleanup record attempted automatic restore");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert!(!listed[0].is_active);
        assert!(!listed[0].is_busy);
        assert_eq!(
            has_calls, 0,
            "Automatic restore probed a session still managed for cleanup"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preserving_exit_and_explicit_delete_cannot_recreate_a_deleted_terminal_journal() {
        let folder = tempfile::tempdir().unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let observed = async {
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            manager
                .handle_terminal_output(live.clone(), "FINAL_BEFORE_DELETE_RACE".into())
                .await?;
            let state = live.state.lock().await;
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while live.batcher.try_lock().is_ok() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Publication did not claim its batch".to_string())?;
            let mut preserving = Box::pin(manager.mark_session_inactive(&created.id, &live));
            assert!(futures_util::poll!(&mut preserving).is_pending());
            let mut deleting = Box::pin(manager.close("synthetic-owner", &created.id));
            let deletion_result = match futures_util::poll!(&mut deleting) {
                std::task::Poll::Ready(result) => Some(result),
                std::task::Poll::Pending => None,
            };
            let deleted_before_publication = deletion_result.is_some();
            drop(state);
            preserving.await?;
            let deleted = if let Some(result) = deletion_result {
                result?
            } else {
                deleting.await?
            };
            Ok::<_, String>((deleted_before_publication, deleted))
        }
        .await;
        live.io.stop_tree().await.unwrap();
        let (premature, deleted) = observed.unwrap();
        assert!(deleted);
        assert!(
            !premature,
            "Delete bypassed a retaining publisher after its manager entry was removed"
        );
        assert!(
            super::load_persisted_session(&manager.inner.config, "synthetic-owner", &created.id)
                .unwrap()
                .is_none(),
            "A retaining EOF callback resurrected a deleted journal"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn final_child_text_with_cursor_query_survives_a_failed_reply_after_exit() {
        let folder = tempfile::tempdir().unwrap();
        let ready = folder.path().join("ready.pid");
        let release = folder.path().join("release");
        let script = folder.path().join("cursor-tail.py");
        std::fs::write(&script,"import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\nwhile not pathlib.Path(sys.argv[2]).exists():time.sleep(0.005)\nsys.stdout.write('FINAL_TEXT_WITH_QUERY\\x1b[6n\\n');sys.stdout.flush();os._exit(0)\n").unwrap();
        let quote =
            |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: Some(format!(
                        "exec /usr/bin/python3 {} {} {}",
                        quote(&script),
                        quote(&ready),
                        quote(&release)
                    )),
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let mut events = live.broadcaster.subscribe();
        let observed = async {
            let pid = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if let Some(pid) = std::fs::read_to_string(&ready)
                        .ok()
                        .and_then(|text| text.parse::<i32>().ok())
                    {
                        break pid;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Cursor-query fixture child did not start".to_string())?;
            // Delay the reply write until the only slave process has exited.
            let writer = live.io.writer.lock().unwrap();
            std::fs::write(&release, "go").map_err(|error| error.to_string())?;
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Cursor-query fixture child did not exit".to_string())?;
            drop(writer);
            let streamed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let mut text = String::new();
                loop {
                    match events.recv().await.map_err(|error| error.to_string())? {
                        super::TerminalSubscriptionEvent::Output(event) => {
                            text.push_str(&event.text)
                        }
                        super::TerminalSubscriptionEvent::Closed => return Ok::<_, String>(text),
                    }
                }
            })
            .await
            .map_err(|_| "Cursor-query fixture did not close its stream".to_string())??;
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "synthetic-owner",
                &created.id,
            )?
            .ok_or("Cursor-query fixture lost its retained journal")?;
            Ok::<_, String>((
                streamed,
                stored
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
            ))
        }
        .await;
        live.io.stop_tree().await.unwrap();
        let (streamed, stored) = observed.unwrap();
        assert!(
            streamed.contains("FINAL_TEXT_WITH_QUERY"),
            "Unwritable query reply discarded final live text: {streamed:?}"
        );
        assert!(
            stored.contains("FINAL_TEXT_WITH_QUERY"),
            "Unwritable query reply discarded final stored text: {stored:?}"
        );
        assert!(!streamed.contains("\u{1b}[6n"));
    }

    static ENV_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

    #[cfg(unix)]
    #[tokio::test]
    async fn natural_exit_drains_real_final_bytes_before_retaining_history_and_closing_live_output()
    {
        let folder = tempfile::tempdir().unwrap();
        let script = folder.path().join("final-output.py");
        let ready = folder.path().join("ready.pid");
        let release = folder.path().join("release");
        std::fs::write(&script,"import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\nwhile not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.005)\nsys.stdout.write('ACTUAL_FINAL_OUTPUT_FROM_EXITING_CHILD\\n');sys.stdout.flush();os._exit(0)\n").unwrap();
        let quote =
            |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: Some(format!(
                        "exec /usr/bin/python3 {} {} {}",
                        quote(&script),
                        quote(&ready),
                        quote(&release)
                    )),
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let mut events = live.broadcaster.subscribe();
        let observed = async {
            let pid = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if let Some(pid) = std::fs::read_to_string(&ready)
                        .ok()
                        .and_then(|text| text.parse::<i32>().ok())
                    {
                        break pid;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Synthetic final-output child did not start".to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            let state = live.state.lock().await;
            std::fs::write(&release, "go").map_err(|error| error.to_string())?;
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Synthetic child did not exit".to_string())?;
            // The raw bytes exist before child exit, but the consumer is held
            // here. EOF finalization must wait for that consumer, not drop it.
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            let closed_before_drain = live.closed.load(std::sync::atomic::Ordering::SeqCst);
            drop(state);
            let streamed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let mut text = String::new();
                loop {
                    match events.recv().await.map_err(|error| error.to_string())? {
                        super::TerminalSubscriptionEvent::Output(event) => {
                            text.push_str(&event.text)
                        }
                        super::TerminalSubscriptionEvent::Closed => return Ok::<_, String>(text),
                    }
                }
            })
            .await
            .map_err(|_| "Natural exit did not close its live stream".to_string())??;
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "synthetic-owner",
                &created.id,
            )?
            .ok_or("Natural exit lost its retained terminal journal")?;
            Ok::<_, String>((
                closed_before_drain,
                streamed,
                stored
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
            ))
        }
        .await;
        live.io.stop_tree().await.unwrap();
        let (premature, streamed, stored) = observed.unwrap();
        assert!(
            !premature,
            "Natural exit closed before its queued reader bytes drained"
        );
        assert!(
            streamed.contains("ACTUAL_FINAL_OUTPUT_FROM_EXITING_CHILD"),
            "Live output omitted final child bytes: {streamed:?}"
        );
        assert!(
            stored.contains("ACTUAL_FINAL_OUTPUT_FROM_EXITING_CHILD"),
            "Retained history omitted final child bytes: {stored:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn natural_exit_eventually_closes_after_its_initial_reader_drain_deadline() {
        let folder = tempfile::tempdir().unwrap();
        let script = folder.path().join("delayed-final-output.py");
        let ready = folder.path().join("ready.pid");
        let release = folder.path().join("release");
        std::fs::write(&script,"import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\nwhile not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.005)\nsys.stdout.write('FINAL_OUTPUT_AFTER_DRAIN_DEADLINE\\n');sys.stdout.flush();os._exit(0)\n").unwrap();
        let quote =
            |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: Some(format!(
                        "exec /usr/bin/python3 {} {} {}",
                        quote(&script),
                        quote(&ready),
                        quote(&release)
                    )),
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let mut events = live.broadcaster.subscribe();
        let observed = async {
            let pid = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if let Some(pid) = std::fs::read_to_string(&ready)
                        .ok()
                        .and_then(|text| text.parse::<i32>().ok())
                    {
                        break pid;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Synthetic final-output child did not start".to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            let state = live.state.lock().await;
            std::fs::write(&release, "go").map_err(|error| error.to_string())?;
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "Synthetic child did not exit".to_string())?;
            // Keep the real reader consumer blocked beyond the supervisor's
            // initial two-second warning deadline. The background supervisor
            // must still finalize once these owned bytes can be published.
            tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
            let closed_before_drain = live.closed.load(std::sync::atomic::Ordering::SeqCst);
            drop(state);
            let streamed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let mut text = String::new();
                loop {
                    match events.recv().await.map_err(|error| error.to_string())? {
                        super::TerminalSubscriptionEvent::Output(event) => {
                            text.push_str(&event.text)
                        }
                        super::TerminalSubscriptionEvent::Closed => return Ok::<_, String>(text),
                    }
                }
            })
            .await
            .map_err(|_| {
                "Natural exit never resumed finalization after its drain deadline".to_string()
            })??;
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "synthetic-owner",
                &created.id,
            )?
            .ok_or("Natural exit lost its retained terminal journal")?;
            Ok::<_, String>((
                closed_before_drain,
                streamed,
                stored
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
            ))
        }
        .await;
        live.io.stop_tree().await.unwrap();
        let (premature, streamed, stored) = observed.unwrap();
        assert!(
            !premature,
            "Natural exit closed before its queued reader bytes drained"
        );
        assert!(
            streamed.contains("FINAL_OUTPUT_AFTER_DRAIN_DEADLINE"),
            "Live output omitted final child bytes: {streamed:?}"
        );
        assert!(
            stored.contains("FINAL_OUTPUT_AFTER_DRAIN_DEADLINE"),
            "Retained history omitted final child bytes: {stored:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preserving_exit_cannot_drop_a_final_batch_already_owned_by_publication() {
        let folder = tempfile::tempdir().unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let mut live_events = live.broadcaster.subscribe();
        let observed = async {
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            manager
                .handle_terminal_output(live.clone(), "FINAL_OWNED_OUTPUT_BEFORE_EXIT\r\n".into())
                .await?;
            let state_guard = live.state.lock().await;
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if live.batcher.try_lock().is_err() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "The production timer did not take its final batch".to_string())?;
            // Drive the production retaining EOF callback at the exact owned
            // publication window. This is not the explicit Delete operation.
            let mut exit = Box::pin(manager.mark_session_inactive(&created.id, &live));
            assert!(futures_util::poll!(&mut exit).is_pending());
            assert!(!live.closed.load(std::sync::atomic::Ordering::SeqCst));
            drop(state_guard);
            exit.await?;
            let stored = super::load_persisted_session(
                &manager.inner.config,
                "synthetic-owner",
                &created.id,
            )?
            .ok_or("Preserving exit lost its terminal journal")?;
            Ok::<_, String>(
                stored
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
            )
        }
        .await;
        // The callback normally follows an exited process. Its disposable shell
        // is explicitly stopped here; no real user process is touched.
        live.io.stop_tree().await.unwrap();
        let output = observed.unwrap();
        let mut streamed = String::new();
        let mut saw_closed = false;
        while let Ok(event) = live_events.try_recv() {
            match event {
                super::TerminalSubscriptionEvent::Output(event) => {
                    assert!(!saw_closed);
                    streamed.push_str(&event.text);
                }
                super::TerminalSubscriptionEvent::Closed => saw_closed = true,
            }
        }
        assert!(saw_closed);
        assert!(streamed.contains("FINAL_OWNED_OUTPUT_BEFORE_EXIT"));

        assert!(
            output.contains("FINAL_OWNED_OUTPUT_BEFORE_EXIT"),
            "Preserving exit rejected already-owned output: {output:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_a_later_batch_timer_cannot_discard_output_already_taken_for_publication() {
        let folder = tempfile::tempdir().unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let created = manager
            .create_session(
                "synthetic-owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: Some("/bin/sh".into()),
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .cloned()
            .unwrap();
        let observed = async {
            // Only a disposable synthetic shell exists; this string is injected
            // through the production PTY output handler, without model traffic.
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            manager
                .handle_terminal_output(live.clone(), "BROWSER_DENIED_CONFIRMED\r\n".into())
                .await?;
            let state_guard = live.state.lock().await;
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if live.batcher.try_lock().is_err() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "The production timer did not take its output batch".to_string())?;
            // Reproduce the transfer/cancel interleaving: once a timer has
            // taken bytes, a later reader/input may cancel only future work.
            assert!(
                live.batcher.try_lock().is_err(),
                "Owned publication cannot be cancelled by a later batch"
            );
            drop(state_guard);
            manager
                .handle_terminal_output(live.clone(), "V4 > ".into())
                .await?;
            tokio::time::sleep(std::time::Duration::from_millis(super::BATCH_TIME_MS * 3)).await;
            Ok::<_, String>(
                live.state
                    .lock()
                    .await
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
            )
        }
        .await;
        manager.close("synthetic-owner", &created.id).await.unwrap();
        let output = observed.unwrap();
        assert!(
            output.contains("BROWSER_DENIED_CONFIRMED"),
            "A taken batch was aborted before publication: {output:?}"
        );
        assert!(output.contains("V4 > "));
    }

    #[tokio::test]
    async fn rewind_exclusion_blocks_terminal_creation_before_process_spawn() {
        let folder = tempfile::tempdir().unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let guard = crate::workspace_activity::exclusive(folder.path()).unwrap();
        let result = manager
            .create_session(
                "owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: None,
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await;
        if let Ok(session) = &result {
            let _ = manager.close("owner", &session.id).await;
        }
        drop(guard);
        assert!(matches!(result,Err(error) if error.contains("rewind")));
    }

    #[tokio::test]
    async fn suspend_stops_native_pty_and_preserves_owned_transcript() {
        let folder = tempfile::tempdir().unwrap();
        let manager = super::TerminalManager::new(terminal_v4_core::AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        let session = manager
            .create_session(
                "owner",
                super::TerminalCreateOptions {
                    cwd: Some(folder.path().to_string_lossy().into_owned()),
                    cols: None,
                    rows: None,
                    title: None,
                    shell: None,
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            )
            .await
            .unwrap();
        let live = {
            manager
                .inner
                .sessions
                .lock()
                .await
                .get(&session.id)
                .cloned()
                .unwrap()
        };
        manager
            .record_output(live.clone(), "persisted rewind marker".into())
            .await
            .unwrap();
        assert!(!manager.suspend("other", &session.id).await.unwrap());
        assert!(manager.has_live_workspace(&folder.path().join(".")).await);
        assert!(manager.suspend("owner", &session.id).await.unwrap());
        assert!(!manager.has_live_workspace(folder.path()).await);
        let stored = super::load_persisted_session(&manager.inner.config, "owner", &session.id)
            .unwrap()
            .unwrap();
        assert!(stored
            .history
            .iter()
            .any(|event| event.text == "persisted rewind marker"));
        assert!(
            super::load_persisted_session(&manager.inner.config, "other", &session.id)
                .unwrap()
                .is_none()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_close_suspend_and_shutdown_stop_detached_tools_and_preserve_intended_history()
    {
        for action in ["close", "suspend", "shutdown"] {
            let folder = tempfile::tempdir().unwrap();
            let app = crate::ApiState::new(terminal_v4_core::AppConfig {
                data_dir: folder.path().join("app"),
                ..Default::default()
            })
            .unwrap();
            let manager = app.terminal_manager();
            let script = folder.path().join("pty-fixture.py");
            let pids_file = folder.path().join("pids.json");
            std::fs::write(&script, r#"
import json, os, pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(), child.pid]))
print('native pty fixture ready', flush=True)
while True: time.sleep(1)
"#).unwrap();
            let quote = |path: &std::path::Path| {
                format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
            };
            let session = manager
                .create_session(
                    "pty-tree-owner",
                    super::TerminalCreateOptions {
                        cwd: Some(folder.path().to_string_lossy().into_owned()),
                        cols: None,
                        rows: None,
                        title: None,
                        shell: Some("/bin/sh".into()),
                        sandbox_mode: None,
                        sandbox_workspace_root: None,
                        initial_command: Some(format!(
                            "exec python3 {} {}",
                            quote(&script),
                            quote(&pids_file)
                        )),
                    },
                )
                .await
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(8), async {
                while std::fs::read(&pids_file)
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
                serde_json::from_slice(&std::fs::read(&pids_file).unwrap()).unwrap();
            let live = manager
                .inner
                .sessions
                .lock()
                .await
                .get(&session.id)
                .cloned()
                .unwrap();
            manager
                .record_output(live.clone(), "saved transcript marker".into())
                .await
                .unwrap();
            live.batcher
                .lock()
                .await
                .append("final buffered shutdown marker");
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                match action {
                    "close" => {
                        manager.close("pty-tree-owner", &session.id).await.unwrap();
                    }
                    "suspend" => {
                        manager
                            .suspend("pty-tree-owner", &session.id)
                            .await
                            .unwrap();
                    }
                    _ => crate::shutdown_services(&app).await,
                }
            })
            .await
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
                .into_iter()
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
                "PTY {action} leaked native tools: {survivors:?}"
            );
            assert!(!manager.is_active(&session.id).await);
            let stored =
                super::load_persisted_session(&manager.inner.config, "pty-tree-owner", &session.id)
                    .unwrap();
            if action == "close" {
                assert!(stored.is_none());
            } else {
                let stored = stored.unwrap();
                let text: String = stored
                    .history
                    .iter()
                    .map(|event| event.text.as_str())
                    .collect();
                assert!(text.contains("saved transcript marker"));
                assert!(text.contains("final buffered shutdown marker"));
            }
            if action == "shutdown" {
                let result = manager
                    .create_session(
                        "pty-tree-owner",
                        super::TerminalCreateOptions {
                            cwd: None,
                            cols: None,
                            rows: None,
                            title: None,
                            shell: Some("/bin/sh".into()),
                            sandbox_mode: None,
                            sandbox_workspace_root: None,
                            initial_command: None,
                        },
                    )
                    .await;
                assert!(matches!(result,Err(error) if error.contains("shutting down")));
            }
        }
    }

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
    fn query_stream_replies_for_every_fragmentation_and_preserves_other_text() {
        let text = "前💡\u{1b}[6n\u{1b}[31m色\u{1b}[0m\u{1b}[6n後";
        let expected = (
            "前💡\u{1b}[31m色\u{1b}[0m後".to_string(),
            vec!["\u{1b}[1;1R".to_string(); 2],
        );
        let boundaries: Vec<_> = (0..=text.len())
            .filter(|i| text.is_char_boundary(*i))
            .collect();
        for &first in &boundaries {
            for &second in boundaries.iter().filter(|&&i| i >= first) {
                let mut stream = super::TerminalQueries::default();
                let mut actual = (String::new(), Vec::new());
                for part in [&text[..first], &text[first..second], &text[second..]] {
                    let (text, replies) = stream.push(part, false);
                    actual.0.push_str(&text);
                    actual.1.extend(replies);
                }
                let (tail, replies) = stream.push("", true);
                actual.0.push_str(&tail);
                actual.1.extend(replies);
                assert_eq!(actual, expected, "split at {first}/{second}");
                assert_eq!(stream.push("", true), (String::new(), Vec::new()));
            }
        }
    }

    #[test]
    fn query_stream_preserves_partial_queries_mismatches_and_unicode_at_eof() {
        for text in [
            "\u{1b}",
            "\u{1b}[",
            "\u{1b}[6",
            "\u{1b}[60n",
            "\u{1b}[?6n",
            "\u{1b}💡",
            "\u{1b}[6💡",
            "\u{1b}\u{1b}[31m",
        ] {
            let mut stream = super::TerminalQueries::default();
            let mut actual = String::new();
            for ch in text.chars() {
                let (chunk, replies) = stream.push(&ch.to_string(), false);
                actual.push_str(&chunk);
                assert!(replies.is_empty());
            }
            let (tail, replies) = stream.push("", true);
            actual.push_str(&tail);
            assert_eq!((actual, replies), (text.to_string(), Vec::new()));
            assert_eq!(stream.push("", true), (String::new(), Vec::new()));
        }
        for prefix in ["\u{1b}", "\u{1b}[", "\u{1b}[6"] {
            let mut stream = super::TerminalQueries::default();
            assert_eq!(
                stream.push(prefix, false),
                (String::new(), Vec::new()),
                "only a possible query suffix is deferred"
            );
            assert_eq!(stream.push("", true), (prefix.to_string(), Vec::new()));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_exit_captures_unobserved_same_group_child_and_preserves_sibling_heartbeat() {
        use std::{io::Read, process::Stdio, time::Duration};
        async fn heartbeat_after(path: &std::path::Path, previous: Option<&str>) -> Option<String> {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(value) = std::fs::read_to_string(path) {
                        if !value.is_empty() && previous != Some(value.as_str()) {
                            return value;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .ok()
        }
        let folder = tempfile::tempdir().unwrap();
        let marker = folder.path().join("child.json");
        let heartbeat = folder.path().join("heartbeat");
        let sibling_heartbeat = folder.path().join("sibling-heartbeat");
        let source = r#"#!/usr/bin/python3
import json, os, pathlib, signal, time
root = pathlib.Path(__file__).parent
r,w = os.pipe()
time.sleep(.08)
child = os.fork()
if child == 0:
    os.close(r)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    (root/'child.json').write_text(json.dumps([os.getpid(), os.getpgrp(), os.getsid(0)]))
    os.write(w,b'R');os.close(w)
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        (root/'heartbeat').write_text(str(time.monotonic_ns()));time.sleep(.02)
    os._exit(0)
os.close(w);os.read(r,1);os.close(r)
os._exit(0)
"#;
        use std::os::unix::fs::PermissionsExt;
        let script = folder.path().join("fast-exit.py");
        std::fs::write(&script, source).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut sibling = std::process::Command::new("/usr/bin/python3")
            .args(["-c", "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+8\nwhile time.monotonic()<end: p.write_text(str(time.monotonic_ns())); time.sleep(.02)"])
            .arg(&sibling_heartbeat).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let (io, reader, mut child) = super::spawn_pty_process(
            script.to_str().unwrap(),
            &[],
            folder.path().to_str().unwrap(),
            80,
            24,
        )
        .unwrap();
        let root_pid = child.process_id().unwrap() as i32;
        // Block this current-thread runtime: no 50 ms observer can see the fork.
        let status = super::wait_for_pty_child(&io.tree, child.as_mut());
        let ids: Vec<i32> = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        let cleanup_tree = super::ProcessTree::attach_pid(ids[0] as u32).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        let before = heartbeat_after(&heartbeat, None).await;
        let sibling_before = heartbeat_after(&sibling_heartbeat, None).await;
        let stopped = io.stop_tree().await;
        // A write can land between the pre-stop read and the kill; compare from the stop onward.
        let at_stop = std::fs::read_to_string(&heartbeat).ok();
        let sibling_at_stop = heartbeat_after(&sibling_heartbeat, None).await;
        tokio::time::sleep(Duration::from_millis(140)).await;
        let after = std::fs::read_to_string(&heartbeat).ok();
        let sibling_after = heartbeat_after(&sibling_heartbeat, sibling_at_stop.as_deref()).await;
        let sibling_running = sibling.try_wait().is_ok_and(|status| status.is_none());
        // Fixture cleanup runs before assertions, including on the red path.
        let cleanup = cleanup_tree.stop(Duration::ZERO).await;
        let _ = sibling.kill();
        let _ = sibling.wait();
        let _ = tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut bytes = Vec::new();
            let _ = reader.read_to_end(&mut bytes);
        })
        .await;
        assert!(status.is_ok());
        assert!(cleanup.is_ok(), "Fixture cleanup failed: {cleanup:?}");
        assert!(stopped.is_ok(), "{stopped:?}");
        assert_eq!(
            &ids[1..],
            &[root_pid, root_pid],
            "fixture escaped PTY group/session"
        );
        assert!(before.is_some(), "Owned child never wrote a heartbeat");
        assert!(at_stop.is_some(), "Owned child heartbeat disappeared");
        assert_eq!(
            after, at_stop,
            "Owned child continued real work after cleanup"
        );
        assert!(
            sibling_before.is_some()
                && sibling_at_stop.is_some()
                && sibling_after.is_some()
                && sibling_running,
            "Sibling heartbeat was unavailable"
        );
        assert_ne!(
            sibling_after, sibling_at_stop,
            "Unrelated sibling stopped doing work"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inactive_tmux_delete_confirms_named_cleanup_before_removing_journal_and_retries_failures(
    ) {
        let Some(root) = isolated_named_tmux_test_root("terminal::tests::inactive_tmux_delete_confirms_named_cleanup_before_removing_journal_and_retries_failures") else {return;};
        let folder = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(AppConfig {
            data_dir: folder.path().join("data"),
            ..Default::default()
        });
        let id = "inactive-owned";
        let stored = super::StoredTerminalSession {
            id: id.into(),
            title: "retained".into(),
            shell: "/bin/sh".into(),
            cwd: folder.path().to_string_lossy().into_owned(),
            created_at: super::iso_timestamp(),
            updated_at: super::iso_timestamp(),
            history: Vec::new(),
            uses_tmux: true,
            sandbox: None,
            thread: None,
        };
        super::save_persisted_session(&manager.inner.config, "owned", &stored).unwrap();
        let journal = super::sessions_dir(&manager.inner.config, "owned")
            .unwrap()
            .join(format!("{id}.json"));
        std::fs::write(root.join("expected-session"), crate::tmux::session_name(id)).unwrap();
        std::fs::write(
            root.join("journal-path"),
            journal.to_string_lossy().as_bytes(),
        )
        .unwrap();
        std::fs::write(root.join("reject-kill"), "refuse").unwrap();
        let foreign = manager.close("foreign", id).await.unwrap();
        let first = manager.close("owned", id).await;
        let retained_after_failure = journal.exists();
        let calls_after_failure =
            std::fs::read_to_string(root.join("kill-count")).unwrap_or_default();
        std::fs::remove_file(root.join("reject-kill")).unwrap();
        let retry = manager.close("owned", id).await;
        assert!(!foreign);
        assert!(
            first.is_err(),
            "Named cleanup failure was acknowledged: {first:?}"
        );
        assert!(retained_after_failure, "Failure destroyed recovery journal");
        assert_eq!(calls_after_failure, "1");
        assert!(retry.unwrap());
        assert!(root.join("named-cleaned").exists());
        assert!(!journal.exists());
        assert_eq!(
            std::fs::read_to_string(root.join("kill-count")).unwrap(),
            "2"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inactive_tmux_delete_retry_accepts_absence_after_cleanup_then_storage_failure() {
        let Some(root) = isolated_named_tmux_test_root("terminal::tests::inactive_tmux_delete_retry_accepts_absence_after_cleanup_then_storage_failure") else {return;};
        let folder = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(AppConfig {
            data_dir: folder.path().join("data"),
            ..Default::default()
        });
        let id = "inactive-retry";
        let stored = super::StoredTerminalSession {
            id: id.into(),
            title: "retained".into(),
            shell: "/bin/sh".into(),
            cwd: folder.path().to_string_lossy().into_owned(),
            created_at: super::iso_timestamp(),
            updated_at: super::iso_timestamp(),
            history: Vec::new(),
            uses_tmux: true,
            sandbox: None,
            thread: None,
        };
        super::save_persisted_session(&manager.inner.config, "owned", &stored).unwrap();
        let journal = super::sessions_dir(&manager.inner.config, "owned")
            .unwrap()
            .join(format!("{id}.json"));
        std::fs::write(root.join("expected-session"), crate::tmux::session_name(id)).unwrap();
        std::fs::write(
            root.join("journal-path"),
            journal.to_string_lossy().as_bytes(),
        )
        .unwrap();
        std::fs::write(root.join("obstruct-delete"), "fail storage after cleanup").unwrap();
        let first = manager.close("owned", id).await;
        assert!(first.is_err());
        assert!(root.join("named-cleaned").exists());
        assert!(root.join("retained-journal").exists());
        std::fs::remove_dir(&journal).unwrap();
        std::fs::rename(root.join("retained-journal"), &journal).unwrap();
        std::fs::remove_file(root.join("obstruct-delete")).unwrap();
        let retry = manager.close("owned", id).await;
        assert!(retry.unwrap());
        assert!(!journal.exists());
        assert_eq!(
            std::fs::read_to_string(root.join("kill-count")).unwrap(),
            "2"
        );
    }

    #[test]
    fn intercept_terminal_queries_replies_to_cursor_status_requests() {
        let (sanitized, responses) =
            super::TerminalQueries::default().push("prefix\u{1b}[6nsuffix\u{1b}[6n", true);

        assert_eq!(sanitized, "prefixsuffix");
        assert_eq!(
            responses,
            vec!["\u{1b}[1;1R".to_string(), "\u{1b}[1;1R".to_string()]
        );
    }

    #[test]
    fn build_sandbox_info_maps_default_permissions_to_workspace_copy() {
        let sandbox = build_sandbox_info(
            Some("workspace-write"),
            Some("C:\\repo".to_string()),
            "session-1",
        )
        .expect("workspace sandbox should be present");

        assert_eq!(sandbox.mode, "workspace-write");
        assert_eq!(sandbox.workspace_root.as_deref(), Some("C:\\repo"));
        assert_eq!(sandbox.runtime_id.as_deref(), Some("session-1"));
        assert_eq!(sandbox.runtime_kind, "workspace-copy");
    }

    #[test]
    fn build_sandbox_info_leaves_full_access_without_sandbox_metadata() {
        assert_eq!(
            build_sandbox_info(Some("off"), Some("C:\\repo".to_string()), "session-1"),
            None
        );
    }

    #[test]
    fn apply_thread_update_marks_and_clears_a_conversation_companion() {
        let mut thread = default_thread_metadata(None);
        apply_thread_update(
            &mut thread,
            ThreadUpdate {
                companion_of: Some(Some("ss-conversation".to_string())),
                ..ThreadUpdate::default()
            },
        );
        let marked = thread.companion_of.clone();
        apply_thread_update(
            &mut thread,
            ThreadUpdate {
                companion_of: Some(None),
                ..ThreadUpdate::default()
            },
        );
        assert_eq!(
            (marked.as_deref(), thread.companion_of),
            (Some("ss-conversation"), None)
        );
    }

    #[test]
    fn apply_thread_update_persists_next_launch_permissions() {
        let mut thread = ThreadMetadata {
            topic: None,
            topic_auto_generated: false,
            pinned: false,
            archived: false,
            project_path: None,
            sandbox_mode: "off".to_string(),
            sandbox_workspace_root: None,
            git_stats: None,
            last_activity_at: "2026-04-24T00:00:00Z".to_string(),
            companion_of: None,
        };

        apply_thread_update(
            &mut thread,
            ThreadUpdate {
                sandbox_mode: Some("read-only".to_string()),
                sandbox_workspace_root: Some(Some("C:\\repo".to_string())),
                ..ThreadUpdate::default()
            },
        );

        assert_eq!(thread.sandbox_mode, "read-only");
        assert_eq!(thread.sandbox_workspace_root.as_deref(), Some("C:\\repo"));
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
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
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

#[cfg(all(test, unix))]
mod thread_terminal_admission_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const OWNER: &str = "drawer-owner";
    const THREAD: &str = "ss-thread-one";

    struct Fixture {
        folder: tempfile::TempDir,
        manager: TerminalManager,
        pid_log: PathBuf,
        shell: String,
    }

    fn fixture() -> Fixture {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let shell = folder.path().join("recording-shell.sh");
        let pid_log = folder.path().join("started-pids");
        let quoted = pid_log.to_string_lossy().replace('\'', "'\\''");
        fs::write(
            &shell,
            format!("#!/bin/sh\nprintf '%s\\n' \"$$\" >> '{quoted}'\nexec /bin/cat\n"),
        )
        .unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        let manager = TerminalManager::new(AppConfig {
            data_dir: folder.path().join("app"),
            ..Default::default()
        });
        Fixture {
            shell: shell.to_string_lossy().into_owned(),
            folder,
            manager,
            pid_log,
        }
    }

    impl Fixture {
        fn options(&self) -> TerminalCreateOptions {
            TerminalCreateOptions {
                cwd: Some(self.folder.path().to_string_lossy().into_owned()),
                cols: None,
                rows: None,
                title: None,
                shell: Some(self.shell.clone()),
                sandbox_mode: None,
                sandbox_workspace_root: None,
                initial_command: None,
            }
        }

        fn config(&self) -> &AppConfig {
            &self.manager.inner.config
        }

        fn journals(&self) -> Vec<String> {
            let dir = sessions_dir(self.config(), OWNER).unwrap();
            let mut names: Vec<String> = fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        }

        fn request_records(&self) -> usize {
            fs::read_dir(create_requests_dir(self.config(), OWNER).unwrap())
                .map(|entries| entries.flatten().count())
                .unwrap_or(0)
        }

        fn started_pids(&self) -> Vec<String> {
            fs::read_to_string(&self.pid_log)
                .map(|text| text.lines().map(str::to_owned).collect())
                .unwrap_or_default()
        }

        async fn wait_for_pids(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.started_pids().len() < count {
                    sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("the recording shell never started");
        }

        async fn assert_gone(&self, pid: &str) {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let state = std::process::Command::new("ps")
                        .args(["-o", "stat=", "-p", pid])
                        .output()
                        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                        .unwrap_or_default();
                    if state.is_empty() || state.starts_with('Z') {
                        break;
                    }
                    sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("process {pid} survived a denied terminal request"));
        }

        async fn assert_nothing_published(&self) {
            assert_eq!(
                (
                    self.manager.list_sessions(OWNER).await.unwrap().len(),
                    self.journals(),
                    self.request_records()
                ),
                (0, Vec::<String>::new(), 0)
            );
        }
    }

    fn intent(request_id: &str) -> TerminalCreateIntent {
        TerminalCreateIntent {
            request_id: Some(request_id.into()),
            companion_of: Some(THREAD.into()),
        }
    }

    fn revoked() -> Result<(), String> {
        Err("Credential has been revoked".into())
    }

    #[tokio::test]
    async fn create_queued_behind_the_lifecycle_lock_is_denied_when_access_ends_while_waiting() {
        let fixture = fixture();
        let ended = AtomicBool::new(false);
        let admission = || {
            if ended.load(Ordering::SeqCst) {
                revoked()
            } else {
                Ok(())
            }
        };
        let held = fixture.manager.inner.lifecycle.lock().await;
        let creating = fixture.manager.create_session_admitted(
            OWNER,
            fixture.options(),
            intent("11111111-1111-4111-8111-111111111111"),
            Some(&admission),
        );
        tokio::pin!(creating);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut creating)
                .await
                .is_err(),
            "the request should be queued behind the held lifecycle lock"
        );
        ended.store(true, Ordering::SeqCst);
        drop(held);
        let error = creating.await.unwrap_err();
        assert_eq!(
            (error.as_str(), fixture.started_pids()),
            (
                "Not authorized: Credential has been revoked",
                Vec::<String>::new()
            )
        );
        fixture.assert_nothing_published().await;
    }

    #[tokio::test]
    async fn create_denied_at_any_admission_point_leaves_no_process_journal_or_record() {
        let fixture = fixture();
        let counted = AtomicUsize::new(0);
        let counting = || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        let control = fixture
            .manager
            .create_session_admitted(
                OWNER,
                fixture.options(),
                intent("22222222-2222-4222-8222-222222222222"),
                Some(&counting),
            )
            .await
            .unwrap();
        let points = counted.load(Ordering::SeqCst);
        // After the lock wait, entering spawn, before the journal is published, and after the shell starts.
        assert_eq!(
            points, 4,
            "every point where a create request waits or publishes must re-check access"
        );
        fixture.wait_for_pids(1).await;
        fixture
            .manager
            .close(OWNER, &control.session.id)
            .await
            .unwrap();
        fixture.assert_gone(&fixture.started_pids()[0]).await;
        // A deleted terminal leaves only a stale request pointer, which is covered separately.
        delete_create_request(
            fixture.config(),
            OWNER,
            "22222222-2222-4222-8222-222222222222",
        )
        .unwrap();
        fixture.assert_nothing_published().await;

        for denied_at in 1..=points {
            let calls = AtomicUsize::new(0);
            let admission = || {
                if calls.fetch_add(1, Ordering::SeqCst) + 1 >= denied_at {
                    revoked()
                } else {
                    Ok(())
                }
            };
            let error = fixture
                .manager
                .create_session_admitted(
                    OWNER,
                    fixture.options(),
                    intent(&format!("33333333-3333-4333-8333-3333333333{denied_at:02}")),
                    Some(&admission),
                )
                .await
                .unwrap_err();
            assert!(
                error.starts_with(TERMINAL_UNAUTHORIZED),
                "denial at admission point {denied_at} produced {error}"
            );
            fixture.assert_nothing_published().await;
        }
        // A shell that outlived its denial would still be starting up; give it time to log its pid.
        sleep(Duration::from_millis(500)).await;
        let pids = fixture.started_pids();
        for pid in &pids {
            fixture.assert_gone(pid).await;
        }
    }

    #[tokio::test]
    async fn initial_command_does_not_run_when_access_ends_before_it_is_sent() {
        let fixture = fixture();
        let marker = fixture.folder.path().join("ran");
        let command = format!("touch '{}'", marker.display());
        let options = || TerminalCreateOptions {
            shell: Some("/bin/sh".into()),
            initial_command: Some(command.clone()),
            ..fixture.options()
        };
        let counted = AtomicUsize::new(0);
        let counting = || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        let control = fixture
            .manager
            .create_session_admitted(
                OWNER,
                options(),
                TerminalCreateIntent::default(),
                Some(&counting),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !marker.exists() {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("an admitted initial command should run");
        fixture
            .manager
            .close(OWNER, &control.session.id)
            .await
            .unwrap();
        fs::remove_file(&marker).unwrap();

        // The check right before the command is the one after the journal is published.
        let points = counted.load(Ordering::SeqCst);
        assert_eq!(
            points, 5,
            "a create with a command adds a re-check before the command is sent"
        );
        let calls = AtomicUsize::new(0);
        let admission = || {
            if calls.fetch_add(1, Ordering::SeqCst) + 1 >= points - 1 {
                revoked()
            } else {
                Ok(())
            }
        };
        let error = fixture
            .manager
            .create_session_admitted(
                OWNER,
                options(),
                TerminalCreateIntent::default(),
                Some(&admission),
            )
            .await
            .unwrap_err();
        sleep(Duration::from_millis(400)).await;
        assert_eq!(
            (
                error.starts_with(TERMINAL_UNAUTHORIZED),
                marker.exists(),
                fixture.journals()
            ),
            (true, false, Vec::<String>::new())
        );
    }

    #[tokio::test]
    async fn repeated_create_request_returns_the_same_linked_terminal_across_restart() {
        let fixture = fixture();
        let request = "44444444-4444-4444-8444-444444444444";
        let first = fixture
            .manager
            .create_session_admitted(OWNER, fixture.options(), intent(request), None)
            .await
            .unwrap();
        let second = fixture
            .manager
            .create_session_admitted(OWNER, fixture.options(), intent(request), None)
            .await
            .unwrap();
        fixture.wait_for_pids(1).await;
        let journal: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                sessions_dir(fixture.config(), OWNER)
                    .unwrap()
                    .join(format!("{}.json", first.session.id)),
            )
            .unwrap(),
        )
        .unwrap();
        let listed = fixture.manager.list_sessions(OWNER).await.unwrap();
        assert_eq!(
            (
                first.replayed,
                second.replayed,
                second.session.id.clone(),
                fixture.started_pids().len(),
                fixture.journals().len(),
                listed
                    .iter()
                    .map(|s| s.thread.as_ref().and_then(|t| t.companion_of.clone()))
                    .collect::<Vec<_>>(),
                journal["thread"]["companionOf"].as_str().map(str::to_owned),
            ),
            (
                false,
                true,
                first.session.id.clone(),
                1,
                1,
                vec![Some(THREAD.to_string())],
                Some(THREAD.to_string()),
            )
        );

        // A server restart keeps only the journal and the request record.
        let restarted = TerminalManager::new(fixture.config().clone());
        let third = restarted
            .create_session_admitted(OWNER, fixture.options(), intent(request), None)
            .await
            .unwrap();
        assert_eq!(
            (
                third.replayed,
                third.session.id,
                fixture.started_pids().len(),
                fixture.journals().len()
            ),
            (true, first.session.id.clone(), 1, 1)
        );
        fixture
            .manager
            .close(OWNER, &first.session.id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn concurrent_duplicate_requests_from_two_tabs_create_one_terminal() {
        let fixture = fixture();
        let request = "55555555-5555-4555-8555-555555555555";
        let (left, right) = tokio::join!(
            fixture.manager.create_session_admitted(
                OWNER,
                fixture.options(),
                intent(request),
                None
            ),
            fixture.manager.create_session_admitted(
                OWNER,
                fixture.options(),
                intent(request),
                None
            ),
        );
        let (left, right) = (left.unwrap(), right.unwrap());
        fixture.wait_for_pids(1).await;
        sleep(Duration::from_millis(200)).await;
        let mut replays = [left.replayed, right.replayed];
        replays.sort();
        assert_eq!(
            (
                left.session.id.clone(),
                replays,
                fixture.started_pids().len(),
                fixture.journals().len()
            ),
            (right.session.id, [false, true], 1, 1)
        );
        fixture
            .manager
            .close(OWNER, &left.session.id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn request_id_reused_for_another_conversation_conflicts_without_creating() {
        let fixture = fixture();
        let request = "66666666-6666-4666-8666-666666666666";
        let created = fixture
            .manager
            .create_session_admitted(OWNER, fixture.options(), intent(request), None)
            .await
            .unwrap();
        let error = fixture
            .manager
            .create_session_admitted(
                OWNER,
                fixture.options(),
                TerminalCreateIntent {
                    request_id: Some(request.into()),
                    companion_of: Some("ss-other-thread".into()),
                },
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(
            (
                error.starts_with(TERMINAL_CONFLICT),
                fixture.journals().len()
            ),
            (true, 1)
        );
        fixture
            .manager
            .close(OWNER, &created.session.id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn request_record_for_a_deleted_terminal_is_stale_and_creates_a_fresh_one() {
        let fixture = fixture();
        let request = "77777777-7777-4777-8777-777777777777";
        let first = fixture
            .manager
            .create_session_admitted(OWNER, fixture.options(), intent(request), None)
            .await
            .unwrap();
        fixture
            .manager
            .close(OWNER, &first.session.id)
            .await
            .unwrap();
        let second = fixture
            .manager
            .create_session_admitted(OWNER, fixture.options(), intent(request), None)
            .await
            .unwrap();
        assert_eq!(
            (
                second.replayed,
                second.session.id != first.session.id,
                fixture.journals().len()
            ),
            (false, true, 1)
        );
        fixture
            .manager
            .close(OWNER, &second.session.id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn create_request_ids_cannot_name_other_files() {
        let fixture = fixture();
        for bad in [
            "../escape-escape",
            "short",
            "has space in it",
            &"a".repeat(65),
        ] {
            let error = fixture
                .manager
                .create_session_admitted(OWNER, fixture.options(), intent(bad), None)
                .await
                .unwrap_err();
            assert_eq!(error, "Terminal request id is invalid", "{bad}");
        }
        fixture.assert_nothing_published().await;
    }

    #[tokio::test]
    async fn link_update_rechecks_admission_after_waiting_for_terminal_state() {
        let fixture = fixture();
        let created = fixture
            .manager
            .create_session(OWNER, fixture.options())
            .await
            .unwrap();
        let session = fixture
            .manager
            .inner
            .sessions
            .lock()
            .await
            .get(&created.id)
            .unwrap()
            .clone();
        let state = session.state.lock().await;
        let ended = AtomicBool::new(false);
        let admission = || {
            if ended.load(Ordering::SeqCst) {
                revoked()
            } else {
                Ok(())
            }
        };
        let linking = fixture.manager.update_thread_admitted(
            OWNER,
            &created.id,
            ThreadUpdate {
                companion_of: Some(Some(THREAD.into())),
                ..ThreadUpdate::default()
            },
            Some(&admission),
        );
        tokio::pin!(linking);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut linking)
                .await
                .is_err()
        );
        ended.store(true, Ordering::SeqCst);
        drop(state);
        let result = linking.await;
        let linked = fixture
            .manager
            .get_thread(OWNER, &created.id)
            .await
            .unwrap()
            .unwrap()
            .companion_of;
        fixture.manager.close(OWNER, &created.id).await.unwrap();
        assert!(result.unwrap_err().starts_with(TERMINAL_UNAUTHORIZED));
        assert!(linked.is_none());
    }

    #[tokio::test]
    async fn link_update_denied_after_waiting_leaves_the_terminal_unlinked() {
        let fixture = fixture();
        let created = fixture
            .manager
            .create_session(OWNER, fixture.options())
            .await
            .unwrap();
        let ended = AtomicBool::new(false);
        let admission = || {
            if ended.load(Ordering::SeqCst) {
                revoked()
            } else {
                Ok(())
            }
        };
        let link = || ThreadUpdate {
            companion_of: Some(Some(THREAD.into())),
            ..ThreadUpdate::default()
        };
        let held = fixture.manager.inner.lifecycle.lock().await;
        let linking =
            fixture
                .manager
                .update_thread_admitted(OWNER, &created.id, link(), Some(&admission));
        tokio::pin!(linking);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut linking)
                .await
                .is_err()
        );
        ended.store(true, Ordering::SeqCst);
        drop(held);
        let error = linking.await.unwrap_err();
        let companion = |manager: &TerminalManager| {
            let manager = manager.clone();
            let id = created.id.clone();
            async move {
                manager
                    .get_thread(OWNER, &id)
                    .await
                    .unwrap()
                    .unwrap()
                    .companion_of
            }
        };
        let persisted: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                sessions_dir(fixture.config(), OWNER)
                    .unwrap()
                    .join(format!("{}.json", created.id)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            (
                error.starts_with(TERMINAL_UNAUTHORIZED),
                companion(&fixture.manager).await,
                persisted["thread"]["companionOf"].is_null(),
            ),
            (true, None, true)
        );
        let linked = fixture
            .manager
            .update_thread_admitted(OWNER, &created.id, link(), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(linked.companion_of.as_deref(), Some(THREAD));
        fixture.manager.close(OWNER, &created.id).await.unwrap();
    }

    #[tokio::test]
    async fn link_update_denied_for_a_retained_terminal_leaves_its_journal_untouched() {
        let fixture = fixture();
        let id = "retained-owned";
        let stored = StoredTerminalSession {
            id: id.into(),
            title: "retained".into(),
            shell: fixture.shell.clone(),
            cwd: fixture.folder.path().to_string_lossy().into_owned(),
            created_at: iso_timestamp(),
            updated_at: iso_timestamp(),
            history: Vec::new(),
            uses_tmux: false,
            sandbox: None,
            thread: None,
        };
        save_persisted_session(fixture.config(), OWNER, &stored).unwrap();
        let path = sessions_dir(fixture.config(), OWNER)
            .unwrap()
            .join(format!("{id}.json"));
        let before = fs::read(&path).unwrap();
        let admission = || revoked();
        let error = fixture
            .manager
            .update_thread_admitted(
                OWNER,
                id,
                ThreadUpdate {
                    companion_of: Some(Some(THREAD.into())),
                    ..ThreadUpdate::default()
                },
                Some(&admission),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (
                error.starts_with(TERMINAL_UNAUTHORIZED),
                fs::read(&path).unwrap() == before
            ),
            (true, true)
        );
    }

    #[tokio::test]
    async fn restore_revoked_after_publication_stops_new_shell_and_preserves_history_and_thread() {
        let fixture = fixture();
        let id = "restore-revoked-after-publication";
        let mut thread = default_thread_metadata(None);
        thread.companion_of = Some(THREAD.into());
        save_persisted_session(
            fixture.config(),
            OWNER,
            &StoredTerminalSession {
                id: id.into(),
                title: "retained".into(),
                shell: fixture.shell.clone(),
                cwd: fixture.folder.path().to_string_lossy().into_owned(),
                created_at: iso_timestamp(),
                updated_at: iso_timestamp(),
                history: vec![TerminalStreamEvent {
                    text: "prior output".into(),
                    ts: 1,
                    seq: Some(1),
                }],
                uses_tmux: false,
                sandbox: None,
                thread: Some(thread),
            },
        )
        .unwrap();
        let calls = AtomicUsize::new(0);
        let admission = || {
            if calls.fetch_add(1, Ordering::SeqCst) + 1 >= 4 {
                revoked()
            } else {
                Ok(())
            }
        };
        let result = fixture
            .manager
            .restore_session_admitted(OWNER, id, None, None, Some(&admission))
            .await;
        if result.is_ok() {
            fixture.manager.close(OWNER, id).await.unwrap();
            panic!("restore returned after its authorization ended");
        }
        assert!(result.unwrap_err().starts_with(TERMINAL_UNAUTHORIZED));
        let retained = load_persisted_session(fixture.config(), OWNER, id)
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                fixture.manager.is_active(id).await,
                retained.thread.unwrap().companion_of.as_deref() == Some(THREAD),
                retained
                    .history
                    .iter()
                    .any(|entry| entry.text == "prior output")
            ),
            (false, true, true)
        );
        sleep(Duration::from_millis(200)).await;
        for pid in fixture.started_pids() {
            fixture.assert_gone(&pid).await;
        }
    }

    #[tokio::test]
    async fn restore_revoked_while_reading_an_active_terminal_leaves_the_existing_shell_running() {
        let fixture = fixture();
        let created = fixture
            .manager
            .create_session(OWNER, fixture.options())
            .await
            .unwrap();
        fixture.wait_for_pids(1).await;
        let calls = AtomicUsize::new(0);
        let admission = || {
            if calls.fetch_add(1, Ordering::SeqCst) + 1 >= 3 {
                revoked()
            } else {
                Ok(())
            }
        };
        let result = fixture
            .manager
            .restore_session_admitted(OWNER, &created.id, None, None, Some(&admission))
            .await;
        assert!(result.unwrap_err().starts_with(TERMINAL_UNAUTHORIZED));
        assert!(fixture.manager.is_active(&created.id).await);
        fixture.manager.close(OWNER, &created.id).await.unwrap();
        fixture.assert_gone(&fixture.started_pids()[0]).await;
    }

    #[tokio::test]
    async fn restore_denied_after_waiting_starts_no_process_and_keeps_the_journal() {
        let fixture = fixture();
        let id = "restore-owned";
        let stored = StoredTerminalSession {
            id: id.into(),
            title: "retained".into(),
            shell: fixture.shell.clone(),
            cwd: fixture.folder.path().to_string_lossy().into_owned(),
            created_at: iso_timestamp(),
            updated_at: iso_timestamp(),
            history: Vec::new(),
            uses_tmux: false,
            sandbox: None,
            thread: None,
        };
        save_persisted_session(fixture.config(), OWNER, &stored).unwrap();
        let path = sessions_dir(fixture.config(), OWNER)
            .unwrap()
            .join(format!("{id}.json"));
        let before = fs::read(&path).unwrap();
        let ended = AtomicBool::new(false);
        let admission = || {
            if ended.load(Ordering::SeqCst) {
                revoked()
            } else {
                Ok(())
            }
        };
        let held = fixture.manager.inner.lifecycle.lock().await;
        let restoring =
            fixture
                .manager
                .restore_session_admitted(OWNER, id, None, None, Some(&admission));
        tokio::pin!(restoring);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut restoring)
                .await
                .is_err()
        );
        ended.store(true, Ordering::SeqCst);
        drop(held);
        let error = restoring.await.unwrap_err();
        sleep(Duration::from_millis(200)).await;
        assert_eq!(
            (
                error.starts_with(TERMINAL_UNAUTHORIZED),
                fixture.started_pids(),
                fs::read(&path).unwrap() == before,
                fixture.manager.is_active(id).await,
            ),
            (true, Vec::<String>::new(), true, false)
        );

        // The retained terminal is still restorable once access is valid.
        let restored = fixture
            .manager
            .restore_session_admitted(OWNER, id, None, None, None)
            .await
            .unwrap()
            .unwrap();
        fixture.wait_for_pids(1).await;
        assert_eq!(restored.id, id);
        fixture.manager.close(OWNER, id).await.unwrap();
    }
}

#[cfg(all(test, unix))]
mod thread_terminal_route_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    const THREAD: &str = "ss-route-thread";

    struct Harness {
        folder: tempfile::TempDir,
        state: crate::state::AppState,
        token: String,
        owner: String,
    }

    async fn harness() -> Harness {
        let folder = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(AppConfig {
            data_dir: folder.path().join("data"),
            jwt_secret: "route-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("drawer", "drawer-password")
            .unwrap();
        let login = state
            .login("drawer", "drawer-password")
            .await
            .unwrap()
            .unwrap();
        Harness {
            token: login.tokens.access_token,
            owner: login.user.id,
            folder,
            state,
        }
    }

    impl Harness {
        async fn call(&self, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
            self.call_with_token(method, uri, body, &self.token).await
        }

        async fn call_with_token(
            &self,
            method: &str,
            uri: &str,
            body: Value,
            token: &str,
        ) -> (StatusCode, Value) {
            let response = crate::app(self.state.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            )
        }

        fn create_body(&self, request_id: &str) -> Value {
            json!({
                "cwd": self.folder.path().to_string_lossy(),
                "shell": "/bin/sh",
                "requestId": request_id,
                "companionOf": THREAD,
            })
        }

        fn journal(&self, id: &str) -> PathBuf {
            sessions_dir(self.state.config(), &self.owner)
                .unwrap()
                .join(format!("{id}.json"))
        }

        fn journal_count(&self) -> usize {
            fs::read_dir(sessions_dir(self.state.config(), &self.owner).unwrap())
                .map(|entries| entries.flatten().count())
                .unwrap_or(0)
        }

        async fn revoke_while_queued(
            &self,
            method: &str,
            uri: &str,
            body: Value,
        ) -> (StatusCode, Value) {
            let manager = self.state.terminal_manager();
            let held = manager.inner.lifecycle.lock().await;
            let request = self.call(method, uri, body);
            tokio::pin!(request);
            assert!(
                tokio::time::timeout(Duration::from_millis(150), &mut request)
                    .await
                    .is_err(),
                "the request should be queued behind the lifecycle lock"
            );
            self.state.logout_user(&self.owner).unwrap();
            drop(held);
            request.await
        }
    }

    #[tokio::test]
    async fn create_route_waits_for_owner_admission_before_starting_a_shell() {
        let harness = harness().await;
        let guard = harness.state.acquire_input_guard(&harness.owner).unwrap();
        let request = harness.call(
            "POST",
            "/api/terminal",
            harness.create_body("88888888-8888-4888-8888-888888888888"),
        );
        tokio::pin!(request);
        if let Ok((status, body)) =
            tokio::time::timeout(Duration::from_millis(150), &mut request).await
        {
            if status == StatusCode::CREATED {
                harness
                    .state
                    .terminal_manager()
                    .close(&harness.owner, body["session"]["id"].as_str().unwrap())
                    .await
                    .unwrap();
            }
            panic!("terminal creation bypassed the owner admission lock: {status}");
        }
        assert_eq!(harness.journal_count(), 0);
        drop(guard);
        let (status, body) = request.await;
        assert_eq!(status, StatusCode::CREATED);
        harness
            .state
            .terminal_manager()
            .close(&harness.owner, body["session"]["id"].as_str().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn logout_waits_until_an_admitted_terminal_create_finishes() {
        let harness = harness().await;
        let manager = harness.state.terminal_manager();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *manager.inner.admitted_create_pause.lock().unwrap() = Some((entered_tx, release_rx));
        let state = harness.state.clone();
        let token = harness.token.clone();
        let body = harness.create_body("cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd");
        let creation = tokio::spawn(async move {
            crate::app(state)
                .oneshot(
                    Request::post("/api/terminal")
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let state = harness.state.clone();
        let owner = harness.owner.clone();
        let mut logout = tokio::task::spawn_blocking(move || state.logout_user(&owner));
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut logout)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        let response = creation.await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        logout.await.unwrap().unwrap();
        manager
            .close(&harness.owner, body["session"]["id"].as_str().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paired_revocation_waits_until_an_admitted_terminal_create_finishes() {
        let harness = harness().await;
        let (grant_id, token) =
            crate::paired_environments::synthetic_input_grant(&harness.state, &harness.owner);
        let manager = harness.state.terminal_manager();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *manager.inner.admitted_create_pause.lock().unwrap() = Some((entered_tx, release_rx));
        let state = harness.state.clone();
        let body = harness.create_body("bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc");
        let creation = tokio::spawn(async move {
            crate::app(state)
                .oneshot(
                    Request::post("/api/terminal")
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let path = format!("/api/environments/grants/{grant_id}");
        let revoke = harness.call("DELETE", &path, Value::Null);
        tokio::pin!(revoke);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut revoke)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        let response = creation.await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(revoke.await.0, StatusCode::NO_CONTENT);
        manager
            .close(&harness.owner, body["session"]["id"].as_str().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnected_create_waiting_for_lifecycle_does_not_start_a_shell() {
        let harness = harness().await;
        let manager = harness.state.terminal_manager();
        let held = manager.inner.lifecycle.lock().await;
        let state = harness.state.clone();
        let token = harness.token.clone();
        let body = harness.create_body("efefefef-efef-4fef-8fef-efefefefefef");
        let request = tokio::spawn(async move {
            crate::app(state)
                .oneshot(
                    Request::post("/api/terminal")
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        sleep(Duration::from_millis(200)).await;
        request.abort();
        let _ = request.await;
        drop(held);
        let settled = manager.inner.lifecycle.lock().await;
        drop(settled);
        let sessions = manager.list_sessions(&harness.owner).await.unwrap();
        for session in &sessions {
            manager.close(&harness.owner, &session.id).await.unwrap();
        }
        assert_eq!((sessions.len(), harness.journal_count()), (0, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnected_restore_waiting_for_lifecycle_does_not_start_a_shell() {
        let harness = harness().await;
        let manager = harness.state.terminal_manager();
        let id = "restore-disconnected";
        save_persisted_session(
            harness.state.config(),
            &harness.owner,
            &StoredTerminalSession {
                id: id.into(),
                title: "retained".into(),
                shell: "/bin/sh".into(),
                cwd: harness.folder.path().to_string_lossy().into_owned(),
                created_at: iso_timestamp(),
                updated_at: iso_timestamp(),
                history: vec![],
                uses_tmux: false,
                sandbox: None,
                thread: None,
            },
        )
        .unwrap();
        let before = fs::read(harness.journal(id)).unwrap();
        let held = manager.inner.lifecycle.lock().await;
        let state = harness.state.clone();
        let token = harness.token.clone();
        let request = tokio::spawn(async move {
            crate::app(state)
                .oneshot(
                    Request::post(format!("/api/terminal/{id}/restore"))
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        sleep(Duration::from_millis(200)).await;
        request.abort();
        let _ = request.await;
        drop(held);
        let settled = manager.inner.lifecycle.lock().await;
        drop(settled);
        let active = manager.is_active(id).await;
        if active {
            manager.close(&harness.owner, id).await.unwrap();
        }
        assert!(!active);
        assert_eq!(fs::read(harness.journal(id)).unwrap(), before);
    }

    #[tokio::test]
    async fn paired_create_queued_before_grant_revocation_does_not_start_a_shell() {
        let harness = harness().await;
        let (grant_id, token) =
            crate::paired_environments::synthetic_input_grant(&harness.state, &harness.owner);
        let manager = harness.state.terminal_manager();
        let held = manager.inner.lifecycle.lock().await;
        let request = harness.call_with_token(
            "POST",
            "/api/terminal",
            harness.create_body("abababab-abab-4bab-8bab-abababababab"),
            &token,
        );
        tokio::pin!(request);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut request)
                .await
                .is_err()
        );
        let (revoked, _) = harness
            .call(
                "DELETE",
                &format!("/api/environments/grants/{grant_id}"),
                Value::Null,
            )
            .await;
        assert_eq!(revoked, StatusCode::NO_CONTENT);
        drop(held);
        let (status, _) = request.await;
        assert_eq!(
            (status, harness.journal_count()),
            (StatusCode::UNAUTHORIZED, 0)
        );
    }

    #[tokio::test]
    async fn restore_route_waits_for_owner_admission_before_starting_a_shell() {
        let harness = harness().await;
        let id = "restore-owner-fence";
        save_persisted_session(
            harness.state.config(),
            &harness.owner,
            &StoredTerminalSession {
                id: id.into(),
                title: "retained".into(),
                shell: "/bin/sh".into(),
                cwd: harness.folder.path().to_string_lossy().into_owned(),
                created_at: iso_timestamp(),
                updated_at: iso_timestamp(),
                history: vec![],
                uses_tmux: false,
                sandbox: None,
                thread: None,
            },
        )
        .unwrap();
        let guard = harness.state.acquire_input_guard(&harness.owner).unwrap();
        let path = format!("/api/terminal/{id}/restore");
        let request = harness.call("POST", &path, json!({}));
        tokio::pin!(request);
        if let Ok((status, _)) =
            tokio::time::timeout(Duration::from_millis(150), &mut request).await
        {
            if status == StatusCode::OK {
                harness
                    .state
                    .terminal_manager()
                    .close(&harness.owner, id)
                    .await
                    .unwrap();
            }
            panic!("terminal restore bypassed the owner admission lock: {status}");
        }
        assert!(!harness.state.terminal_manager().is_active(id).await);
        drop(guard);
        let (status, _) = request.await;
        assert_eq!(status, StatusCode::OK);
        harness
            .state
            .terminal_manager()
            .close(&harness.owner, id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn link_route_waits_for_owner_admission_before_updating_thread() {
        let harness = harness().await;
        let (_, created) = harness
            .call(
                "POST",
                "/api/terminal",
                json!({"cwd": harness.folder.path().to_string_lossy(), "shell":"/bin/sh"}),
            )
            .await;
        let id = created["session"]["id"].as_str().unwrap().to_owned();
        let path = format!("/api/terminal/{id}/thread");
        let guard = harness.state.acquire_input_guard(&harness.owner).unwrap();
        let request = harness.call("PATCH", &path, json!({"companionOf":THREAD}));
        tokio::pin!(request);
        if let Ok((status, _)) =
            tokio::time::timeout(Duration::from_millis(150), &mut request).await
        {
            drop(guard);
            harness
                .state
                .terminal_manager()
                .close(&harness.owner, &id)
                .await
                .unwrap();
            panic!("terminal thread update bypassed owner admission: {status}");
        }
        assert!(harness
            .state
            .terminal_manager()
            .get_thread(&harness.owner, &id)
            .await
            .unwrap()
            .unwrap()
            .companion_of
            .is_none());
        drop(guard);
        assert_eq!(request.await.0, StatusCode::OK);
        harness
            .state
            .terminal_manager()
            .close(&harness.owner, &id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retained_terminal_link_waits_for_owner_admission_before_persisting() {
        let harness = harness().await;
        let id = "retained-link-fence";
        save_persisted_session(
            harness.state.config(),
            &harness.owner,
            &StoredTerminalSession {
                id: id.into(),
                title: "retained".into(),
                shell: "/bin/sh".into(),
                cwd: harness.folder.path().to_string_lossy().into_owned(),
                created_at: iso_timestamp(),
                updated_at: iso_timestamp(),
                history: vec![],
                uses_tmux: false,
                sandbox: None,
                thread: None,
            },
        )
        .unwrap();
        let before = fs::read(harness.journal(id)).unwrap();
        let guard = harness.state.acquire_input_guard(&harness.owner).unwrap();
        let path = format!("/api/terminal/{id}/thread");
        let request = harness.call("PATCH", &path, json!({"companionOf":THREAD}));
        tokio::pin!(request);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut request)
                .await
                .is_err()
        );
        assert_eq!(fs::read(harness.journal(id)).unwrap(), before);
        drop(guard);
        assert_eq!(request.await.0, StatusCode::OK);
        let saved: Value = serde_json::from_slice(&fs::read(harness.journal(id)).unwrap()).unwrap();
        assert_eq!(saved["thread"]["companionOf"], THREAD);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnected_link_waiting_for_lifecycle_does_not_update_thread() {
        let harness = harness().await;
        let (_, created) = harness
            .call(
                "POST",
                "/api/terminal",
                json!({"cwd": harness.folder.path().to_string_lossy(), "shell":"/bin/sh"}),
            )
            .await;
        let id = created["session"]["id"].as_str().unwrap().to_owned();
        let before: Value =
            serde_json::from_slice(&fs::read(harness.journal(&id)).unwrap()).unwrap();
        let manager = harness.state.terminal_manager();
        let held = manager.inner.lifecycle.lock().await;
        let app = harness.state.clone();
        let token = harness.token.clone();
        let path = format!("/api/terminal/{id}/thread");
        let request = tokio::spawn(async move {
            crate::app(app)
                .oneshot(
                    Request::patch(path)
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(json!({"companionOf":THREAD}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        sleep(Duration::from_millis(200)).await;
        request.abort();
        let _ = request.await;
        drop(held);
        let settled = manager.inner.lifecycle.lock().await;
        drop(settled);
        let thread = manager
            .get_thread(&harness.owner, &id)
            .await
            .unwrap()
            .unwrap();
        let journal: Value =
            serde_json::from_slice(&fs::read(harness.journal(&id)).unwrap()).unwrap();
        manager.close(&harness.owner, &id).await.unwrap();
        assert_eq!(
            (thread.companion_of, &journal["thread"]),
            (None, &before["thread"])
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnected_link_waiting_for_terminal_state_does_not_update_thread() {
        let harness = harness().await;
        let (_, created) = harness
            .call(
                "POST",
                "/api/terminal",
                json!({"cwd": harness.folder.path().to_string_lossy(), "shell":"/bin/sh"}),
            )
            .await;
        let id = created["session"]["id"].as_str().unwrap().to_owned();
        let manager = harness.state.terminal_manager();
        let session = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&id)
            .unwrap()
            .clone();
        let held = session.state.lock().await;
        let app = harness.state.clone();
        let token = harness.token.clone();
        let path = format!("/api/terminal/{id}/thread");
        let request = tokio::spawn(async move {
            crate::app(app)
                .oneshot(
                    Request::patch(path)
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(json!({"companionOf":THREAD}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        sleep(Duration::from_millis(200)).await;
        request.abort();
        let _ = request.await;
        drop(held);
        let settled = manager.inner.lifecycle.lock().await;
        drop(settled);
        let thread = manager
            .get_thread(&harness.owner, &id)
            .await
            .unwrap()
            .unwrap();
        manager.close(&harness.owner, &id).await.unwrap();
        assert_eq!(thread.companion_of, None);
    }

    #[tokio::test]
    async fn paired_link_queued_before_grant_revocation_leaves_thread_unchanged() {
        let harness = harness().await;
        let (_, created) = harness
            .call(
                "POST",
                "/api/terminal",
                json!({"cwd": harness.folder.path().to_string_lossy(), "shell":"/bin/sh"}),
            )
            .await;
        let id = created["session"]["id"].as_str().unwrap().to_owned();
        let (grant_id, token) =
            crate::paired_environments::synthetic_input_grant(&harness.state, &harness.owner);
        let manager = harness.state.terminal_manager();
        let held = manager.inner.lifecycle.lock().await;
        let path = format!("/api/terminal/{id}/thread");
        let request =
            harness.call_with_token("PATCH", &path, json!({"companionOf":THREAD}), &token);
        tokio::pin!(request);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut request)
                .await
                .is_err()
        );
        let (revoked, _) = harness
            .call(
                "DELETE",
                &format!("/api/environments/grants/{grant_id}"),
                Value::Null,
            )
            .await;
        assert_eq!(revoked, StatusCode::NO_CONTENT);
        drop(held);
        let status = request.await.0;
        let thread = manager
            .get_thread(&harness.owner, &id)
            .await
            .unwrap()
            .unwrap();
        manager.close(&harness.owner, &id).await.unwrap();
        assert_eq!(
            (status, thread.companion_of),
            (StatusCode::UNAUTHORIZED, None)
        );
    }

    #[tokio::test]
    async fn create_route_is_idempotent_and_links_the_terminal_in_the_creating_write() {
        let harness = harness().await;
        let request = "88888888-8888-4888-8888-888888888888";
        let (created, first) = harness
            .call("POST", "/api/terminal", harness.create_body(request))
            .await;
        let (replayed, second) = harness
            .call("POST", "/api/terminal", harness.create_body(request))
            .await;
        let id = first["session"]["id"].as_str().unwrap().to_owned();
        let journal: Value =
            serde_json::from_str(&fs::read_to_string(harness.journal(&id)).unwrap()).unwrap();
        let (_, listing) = harness.call("GET", "/api/terminal", Value::Null).await;
        assert_eq!(
            (
                created,
                replayed,
                second["session"]["id"].as_str().unwrap(),
                first["session"]["requestId"].as_str(),
                first["session"]["companionOf"].as_str(),
                second["replayed"].as_bool(),
                journal["thread"]["companionOf"].as_str(),
                harness.journal_count(),
                listing
                    .as_array()
                    .map(Vec::len)
                    .or_else(|| listing["sessions"].as_array().map(Vec::len)),
            ),
            (
                StatusCode::CREATED,
                StatusCode::OK,
                id.as_str(),
                Some(request),
                Some(THREAD),
                Some(true),
                Some(THREAD),
                1,
                Some(1),
            )
        );
        harness
            .state
            .terminal_manager()
            .close(&harness.owner, &id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn create_route_rejects_malformed_request_ids_and_conflicting_reuse() {
        let harness = harness().await;
        let (bad, _) = harness
            .call(
                "POST",
                "/api/terminal",
                harness.create_body("../../etc/passwd"),
            )
            .await;
        let request = "99999999-9999-4999-8999-999999999999";
        let (created, first) = harness
            .call("POST", "/api/terminal", harness.create_body(request))
            .await;
        let mut other = harness.create_body(request);
        other["companionOf"] = json!("ss-someone-else");
        let (conflict, _) = harness.call("POST", "/api/terminal", other).await;
        assert_eq!(
            (bad, created, conflict, harness.journal_count()),
            (
                StatusCode::BAD_REQUEST,
                StatusCode::CREATED,
                StatusCode::CONFLICT,
                1
            )
        );
        harness
            .state
            .terminal_manager()
            .close(&harness.owner, first["session"]["id"].as_str().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn create_route_started_before_logout_is_refused_and_leaves_nothing_behind() {
        let harness = harness().await;
        let request = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let (status, body) = harness
            .revoke_while_queued("POST", "/api/terminal", harness.create_body(request))
            .await;
        let requests = create_requests_dir(harness.state.config(), &harness.owner).unwrap();
        assert_eq!(
            (
                status,
                body["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("revoked")),
                harness.journal_count(),
                fs::read_dir(requests)
                    .map(|entries| entries.flatten().count())
                    .unwrap_or(0),
                harness
                    .state
                    .terminal_manager()
                    .list_sessions(&harness.owner)
                    .await
                    .unwrap()
                    .len(),
            ),
            (StatusCode::UNAUTHORIZED, true, 0, 0, 0)
        );
    }

    #[tokio::test]
    async fn link_route_started_before_logout_is_refused_and_leaves_the_terminal_standalone() {
        let harness = harness().await;
        let (_, created) = harness
            .call(
                "POST",
                "/api/terminal",
                json!({ "cwd": harness.folder.path().to_string_lossy(), "shell": "/bin/sh" }),
            )
            .await;
        let id = created["session"]["id"].as_str().unwrap().to_owned();
        let (status, _) = harness
            .revoke_while_queued(
                "PATCH",
                &format!("/api/terminal/{id}/thread"),
                json!({ "companionOf": THREAD }),
            )
            .await;
        let journal: Value =
            serde_json::from_str(&fs::read_to_string(harness.journal(&id)).unwrap()).unwrap();
        let live = harness
            .state
            .terminal_manager()
            .get_thread(&harness.owner, &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                status,
                journal["thread"]["companionOf"].is_null(),
                live.companion_of
            ),
            (StatusCode::UNAUTHORIZED, true, None)
        );
        harness
            .state
            .terminal_manager()
            .close(&harness.owner, &id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn restore_route_started_before_logout_is_refused_and_starts_no_shell() {
        let harness = harness().await;
        let id = "route-restore-owned";
        let marker = harness.folder.path().join("restored-shell-ran");
        let shell = harness.folder.path().join("marker-shell.sh");
        fs::write(
            &shell,
            format!("#!/bin/sh\ntouch '{}'\nexec /bin/cat\n", marker.display()),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        }
        save_persisted_session(
            harness.state.config(),
            &harness.owner,
            &StoredTerminalSession {
                id: id.into(),
                title: "retained".into(),
                shell: shell.to_string_lossy().into_owned(),
                cwd: harness.folder.path().to_string_lossy().into_owned(),
                created_at: iso_timestamp(),
                updated_at: iso_timestamp(),
                history: Vec::new(),
                uses_tmux: false,
                sandbox: None,
                thread: None,
            },
        )
        .unwrap();
        let before = fs::read(harness.journal(id)).unwrap();
        let (status, _) = harness
            .revoke_while_queued("POST", &format!("/api/terminal/{id}/restore"), json!({}))
            .await;
        sleep(Duration::from_millis(300)).await;
        assert_eq!(
            (
                status,
                marker.exists(),
                fs::read(harness.journal(id)).unwrap() == before,
                harness.state.terminal_manager().is_active(id).await,
            ),
            (StatusCode::UNAUTHORIZED, false, true, false)
        );
    }
}
