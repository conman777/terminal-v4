use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use terminal_v4_core::{
    AppConfig, StructuredSessionEvent, StructuredSessionSnapshot, StructuredThreadMetadata,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::debug;
use uuid::Uuid;

#[derive(Clone)]
pub struct StructuredSessionManager {
    inner: Arc<StructuredSessionManagerInner>,
}

struct StructuredSessionManagerInner {
    config: AppConfig,
    providers: HashMap<String, Arc<dyn StructuredProvider>>,
    sessions: Mutex<HashMap<String, Arc<StructuredLiveSession>>>,
}

struct StructuredLiveSession {
    state: Mutex<StructuredSessionState>,
    broadcaster: broadcast::Sender<StructuredSessionEvent>,
}

struct StructuredSessionState {
    id: String,
    user_id: String,
    title: String,
    cwd: String,
    provider: String,
    model: Option<String>,
    created_at: String,
    updated_at: String,
    thread: Option<StructuredThreadMetadata>,
    events: Vec<StructuredSessionEvent>,
    active_cli_session_id: Option<String>,
    process: Option<Arc<dyn StructuredProcessController>>,
}

#[derive(Debug, Clone, Default)]
pub struct StructuredThreadUpdate {
    pub topic: Option<Option<String>>,
    pub topic_auto_generated: Option<bool>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub project_path: Option<Option<String>>,
}

#[derive(Clone)]
pub(crate) struct StructuredSpawnOptions {
    pub prompt: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub model: Option<String>,
}

pub(crate) struct SpawnedStructuredProcess {
    pub controller: Arc<dyn StructuredProcessController>,
    pub events: mpsc::UnboundedReceiver<StructuredSessionEvent>,
}

#[async_trait]
pub(crate) trait StructuredProcessController: Send + Sync {
    async fn send_input(&self, text: &str) -> Result<(), String>;
    async fn send_approval(&self, approved: bool) -> Result<(), String>;
    async fn interrupt(&self) -> Result<(), String>;
    async fn kill(&self) -> Result<(), String>;
}

pub(crate) trait StructuredProvider: Send + Sync {
    fn provider_id(&self) -> &'static str;
    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String>;
}

impl StructuredSessionManager {
    pub fn new(config: AppConfig) -> Self {
        Self::new_with_providers(config, vec![Arc::new(ClaudeStructuredProvider)])
    }

    pub(crate) fn new_with_providers(
        config: AppConfig,
        providers: Vec<Arc<dyn StructuredProvider>>,
    ) -> Self {
        let providers = providers
            .into_iter()
            .map(|provider| (provider.provider_id().to_string(), provider))
            .collect();
        Self {
            inner: Arc::new(StructuredSessionManagerInner {
                config,
                providers,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        cwd: &str,
        provider: Option<&str>,
        model: Option<&str>,
        title: Option<&str>,
    ) -> Result<StructuredSessionSnapshot, String> {
        let provider = provider.unwrap_or("claude").trim();
        if !self.inner.providers.contains_key(provider) {
            return Err(format!("Unknown provider: {provider}"));
        }

        let cwd = normalize_structured_cwd(cwd)?;
        let now = iso_timestamp();
        let id = format!("ss-{}", Uuid::new_v4().simple());
        let resolved_title = normalize_structured_title(title, provider);
        let initial_thread = default_structured_thread(Some(cwd.clone()), &now);
        let (broadcaster, _) = broadcast::channel(256);
        let session = Arc::new(StructuredLiveSession {
            state: Mutex::new(StructuredSessionState {
                id: id.clone(),
                user_id: user_id.to_string(),
                title: resolved_title,
                cwd,
                provider: provider.to_string(),
                model: model.map(str::to_string),
                created_at: now.clone(),
                updated_at: now,
                thread: Some(initial_thread),
                events: Vec::new(),
                active_cli_session_id: None,
                process: None,
            }),
            broadcaster,
        });

        {
            let mut sessions = self.inner.sessions.lock().await;
            sessions.insert(id.clone(), session);
        }

        let snapshot = self
            .get_session(user_id, &id)
            .await?
            .ok_or_else(|| "Failed to create structured session".to_string())?;
        self.persist_snapshot(user_id, &snapshot)?;
        Ok(snapshot)
    }

    pub async fn list_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<StructuredSessionSnapshot>, String> {
        self.load_user_sessions(user_id).await?;
        let sessions = self.inner.sessions.lock().await;
        let mut snapshots = Vec::new();
        for session in sessions.values() {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                continue;
            }
            snapshots.push(snapshot_from_state(&state));
        }
        snapshots.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(snapshots)
    }

    pub async fn get_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<StructuredSessionSnapshot>, String> {
        self.load_user_sessions(user_id).await?;
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return Ok(None);
        };
        let state = session.state.lock().await;
        if state.user_id != user_id {
            return Ok(None);
        }
        Ok(Some(snapshot_from_state(&state)))
    }

    pub async fn rename_session(
        &self,
        user_id: &str,
        session_id: &str,
        title: &str,
    ) -> Result<Option<StructuredSessionSnapshot>, String> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err("Session title is required".to_string());
        }

        self.load_user_sessions(user_id).await?;
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return Ok(None);
        };

        let snapshot = {
            let mut state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(None);
            }
            state.title = trimmed.to_string();
            state.updated_at = iso_timestamp();
            let updated_at = state.updated_at.clone();
            touch_structured_thread(state.thread.as_mut(), &updated_at);
            snapshot_from_state(&state)
        };

        self.persist_snapshot(user_id, &snapshot)?;
        Ok(Some(snapshot))
    }

    pub async fn get_thread(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<StructuredThreadMetadata>, String> {
        let Some(session) = self.get_session(user_id, session_id).await? else {
            return Ok(None);
        };

        Ok(Some(session.thread.unwrap_or_else(|| {
            default_structured_thread(Some(session.cwd), &session.updated_at)
        })))
    }

    pub async fn update_thread(
        &self,
        user_id: &str,
        session_id: &str,
        updates: StructuredThreadUpdate,
    ) -> Result<Option<StructuredThreadMetadata>, String> {
        self.load_user_sessions(user_id).await?;
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return Ok(None);
        };

        let (snapshot, thread) = {
            let mut state = session.state.lock().await;
            if state.user_id != user_id {
                return Ok(None);
            }
            let mut thread = state.thread.clone().unwrap_or_else(|| {
                default_structured_thread(Some(state.cwd.clone()), &state.updated_at)
            });
            apply_structured_thread_update(&mut thread, updates);
            state.updated_at = iso_timestamp();
            let updated_at = state.updated_at.clone();
            touch_structured_thread(Some(&mut thread), &updated_at);
            state.thread = Some(thread.clone());
            (snapshot_from_state(&state), thread)
        };

        self.persist_snapshot(user_id, &snapshot)?;
        Ok(Some(thread))
    }

    pub async fn send_message(
        &self,
        user_id: &str,
        session_id: &str,
        text: &str,
    ) -> Result<(), String> {
        self.load_user_sessions(user_id).await?;
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

        let (provider_id, cwd, model, continuation, existing_process) = {
            let mut state = session.state.lock().await;
            if state.user_id != user_id {
                return Err(format!("Session not found: {session_id}"));
            }
            let existing_process = state.process.clone();
            state.process = None;
            (
                state.provider.clone(),
                state.cwd.clone(),
                state.model.clone(),
                state.active_cli_session_id.clone(),
                existing_process,
            )
        };

        if let Some(process) = existing_process {
            process.kill().await?;
        }

        let provider = self
            .inner
            .providers
            .get(&provider_id)
            .cloned()
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
        let spawned = provider.spawn(StructuredSpawnOptions {
            prompt: text.trim().to_string(),
            cwd,
            session_id: continuation,
            model,
        })?;
        let controller = spawned.controller.clone();
        let mut events = spawned.events;

        {
            let mut state = session.state.lock().await;
            state.process = Some(controller.clone());
            state.updated_at = iso_timestamp();
        }

        let manager = self.clone();
        let session_id = session_id.to_string();
        let user_id = user_id.to_string();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if manager
                    .record_event(&user_id, &session_id, event)
                    .await
                    .is_err()
                {
                    break;
                }
            }
            let _ = manager
                .clear_process(&user_id, &session_id, &controller)
                .await;
        });

        Ok(())
    }

    pub async fn interrupt(&self, user_id: &str, session_id: &str) -> Result<(), String> {
        let Some(process) = self.current_process(user_id, session_id).await? else {
            return Ok(());
        };
        process.interrupt().await
    }

    pub async fn approve(
        &self,
        user_id: &str,
        session_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        let Some(process) = self.current_process(user_id, session_id).await? else {
            return Ok(());
        };
        process.send_approval(approved).await
    }

    pub async fn delete_session(&self, user_id: &str, session_id: &str) -> Result<(), String> {
        self.load_user_sessions(user_id).await?;
        let removed = {
            let mut sessions = self.inner.sessions.lock().await;
            sessions.remove(session_id)
        };
        if let Some(session) = removed {
            let process = {
                let state = session.state.lock().await;
                if state.user_id != user_id {
                    return Ok(());
                }
                state.process.clone()
            };
            if let Some(process) = process {
                let _ = process.kill().await;
            }
        }

        let path = structured_session_path(&self.inner.config, user_id, session_id);
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub async fn subscribe(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<
        (
            Vec<StructuredSessionEvent>,
            broadcast::Receiver<StructuredSessionEvent>,
        ),
        String,
    > {
        self.load_user_sessions(user_id).await?;
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

        let history = {
            let state = session.state.lock().await;
            if state.user_id != user_id {
                return Err(format!("Session not found: {session_id}"));
            }
            state.events.clone()
        };
        Ok((history, session.broadcaster.subscribe()))
    }

    async fn current_process(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<Arc<dyn StructuredProcessController>>, String> {
        self.load_user_sessions(user_id).await?;
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return Ok(None);
        };
        let state = session.state.lock().await;
        if state.user_id != user_id {
            return Ok(None);
        }
        Ok(state.process.clone())
    }

    async fn clear_process(
        &self,
        user_id: &str,
        session_id: &str,
        controller: &Arc<dyn StructuredProcessController>,
    ) -> Result<(), String> {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return Ok(());
        };
        let mut state = session.state.lock().await;
        if state.user_id != user_id {
            return Ok(());
        }
        if state
            .process
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, controller))
        {
            state.process = None;
            state.updated_at = iso_timestamp();
            let snapshot = snapshot_from_state(&state);
            drop(state);
            self.persist_snapshot(user_id, &snapshot)?;
        }
        Ok(())
    }

    async fn record_event(
        &self,
        user_id: &str,
        session_id: &str,
        event: StructuredSessionEvent,
    ) -> Result<(), String> {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

        let snapshot = {
            let mut state = session.state.lock().await;
            if state.user_id != user_id {
                return Err(format!("Session not found: {session_id}"));
            }
            if let StructuredSessionEvent::SessionStarted { session_id, .. } = &event {
                if session_id != "unknown" {
                    state.active_cli_session_id = Some(session_id.clone());
                }
            }
            state.updated_at = iso_timestamp();
            let updated_at = state.updated_at.clone();
            touch_structured_thread(state.thread.as_mut(), &updated_at);
            state.events.push(event.clone());
            snapshot_from_state(&state)
        };

        let _ = session.broadcaster.send(event);
        self.persist_snapshot(user_id, &snapshot)?;
        Ok(())
    }

    async fn load_user_sessions(&self, user_id: &str) -> Result<(), String> {
        let dir = structured_user_dir(&self.inner.config, user_id);
        if !dir.exists() {
            return Ok(());
        }

        let mut loaded = HashMap::new();
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let payload = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let snapshot: StructuredSessionSnapshot =
                serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            let normalized_title = if snapshot.title.trim().is_empty() {
                default_structured_title(&snapshot.provider)
            } else {
                snapshot.title.clone()
            };
            let normalized_thread = snapshot.thread.clone().or_else(|| {
                Some(default_structured_thread(
                    Some(snapshot.cwd.clone()),
                    &snapshot.updated_at,
                ))
            });
            let (broadcaster, _) = broadcast::channel(256);
            loaded.insert(
                snapshot.id.clone(),
                Arc::new(StructuredLiveSession {
                    state: Mutex::new(StructuredSessionState {
                        id: snapshot.id.clone(),
                        user_id: user_id.to_string(),
                        title: normalized_title,
                        cwd: snapshot.cwd,
                        provider: snapshot.provider,
                        model: snapshot.model,
                        created_at: snapshot.created_at,
                        updated_at: snapshot.updated_at,
                        thread: normalized_thread,
                        active_cli_session_id: last_cli_session_id(&snapshot.events),
                        process: None,
                        events: snapshot.events,
                    }),
                    broadcaster,
                }),
            );
        }

        let mut sessions = self.inner.sessions.lock().await;
        for (session_id, session) in loaded {
            sessions.entry(session_id).or_insert(session);
        }
        Ok(())
    }

    fn persist_snapshot(
        &self,
        user_id: &str,
        snapshot: &StructuredSessionSnapshot,
    ) -> Result<(), String> {
        let dir = structured_user_dir(&self.inner.config, user_id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let path = structured_session_path(&self.inner.config, user_id, &snapshot.id);
        let payload = serde_json::to_vec_pretty(snapshot).map_err(|error| error.to_string())?;
        fs::write(path, payload).map_err(|error| error.to_string())
    }
}

fn structured_user_dir(config: &AppConfig, user_id: &str) -> PathBuf {
    config
        .data_dir
        .join("users")
        .join(sanitize_identifier(user_id))
        .join("structured")
}

fn structured_session_path(config: &AppConfig, user_id: &str, session_id: &str) -> PathBuf {
    structured_user_dir(config, user_id).join(format!("{}.json", sanitize_identifier(session_id)))
}

fn sanitize_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect()
}

fn snapshot_from_state(state: &StructuredSessionState) -> StructuredSessionSnapshot {
    StructuredSessionSnapshot {
        id: state.id.clone(),
        title: state.title.clone(),
        cwd: state.cwd.clone(),
        provider: state.provider.clone(),
        model: state.model.clone(),
        created_at: state.created_at.clone(),
        updated_at: state.updated_at.clone(),
        thread: state.thread.clone(),
        events: state.events.clone(),
    }
}

fn last_cli_session_id(events: &[StructuredSessionEvent]) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        StructuredSessionEvent::SessionStarted { session_id, .. } if session_id != "unknown" => {
            Some(session_id.clone())
        }
        _ => None,
    })
}

fn default_structured_title(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "claude" => "Claude Code".to_string(),
        "codex" => "Codex".to_string(),
        "gemini" => "Gemini CLI".to_string(),
        other if !other.is_empty() => {
            let mut characters = other.chars();
            let Some(first) = characters.next() else {
                return "Structured session".to_string();
            };
            format!("{}{}", first.to_ascii_uppercase(), characters.as_str())
        }
        _ => "Structured session".to_string(),
    }
}

fn normalize_structured_title(title: Option<&str>, provider: &str) -> String {
    title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_structured_title(provider))
}

fn default_structured_thread(
    project_path: Option<String>,
    updated_at: &str,
) -> StructuredThreadMetadata {
    StructuredThreadMetadata {
        topic: None,
        topic_auto_generated: false,
        pinned: false,
        archived: false,
        project_path,
        last_activity_at: updated_at.to_string(),
    }
}

fn touch_structured_thread(thread: Option<&mut StructuredThreadMetadata>, updated_at: &str) {
    if let Some(thread) = thread {
        thread.last_activity_at = updated_at.to_string();
    }
}

fn apply_structured_thread_update(
    thread: &mut StructuredThreadMetadata,
    updates: StructuredThreadUpdate,
) {
    if let Some(topic) = updates.topic {
        thread.topic = topic;
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
        thread.project_path = project_path;
    }
}

fn normalize_structured_cwd(cwd: &str) -> Result<String, String> {
    let candidate = Path::new(cwd);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve working directory: {error}"))?;
    if !resolved.is_dir() {
        return Err("Working directory must be a folder".to_string());
    }
    Ok(resolved.to_string_lossy().to_string())
}

fn iso_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 timestamps should format")
}

fn now_ts() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

fn next_seq(counter: &AtomicUsize) -> i64 {
    counter.fetch_add(1, Ordering::SeqCst) as i64 + 1
}

struct ClaudeStructuredProvider;

impl StructuredProvider for ClaudeStructuredProvider {
    fn provider_id(&self) -> &'static str {
        "claude"
    }

    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        let is_windows = cfg!(windows);
        let claude_bin = std::env::var("CLAUDE_BIN").unwrap_or_else(|_| {
            if is_windows {
                "claude.cmd".to_string()
            } else {
                "claude".to_string()
            }
        });
        let mut args = vec![
            "-p".to_string(),
            options.prompt.clone(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];

        if let Some(model) = options
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--model".to_string());
            args.push(model.to_string());
        }

        if !options.cwd.trim().is_empty() {
            args.push("--add-dir".to_string());
            args.push(options.cwd.clone());
        }

        if let Some(session_id) = options
            .session_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--continue".to_string());
            args.push(session_id.to_string());
        }

        if matches!(std::env::var("CLAUDE_ASSUME_YES").as_deref(), Ok("true")) {
            args.push("--dangerously-skip-permissions".to_string());
        }

        let mut command = if is_windows {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(&claude_bin);
            command
        } else {
            Command::new(&claude_bin)
        };

        command
            .args(&args)
            .current_dir(&options.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture structured provider stdout".to_string())?;
        let stderr = child.stderr.take();

        let (tx, rx) = mpsc::unbounded_channel();
        let interrupted = Arc::new(AtomicBool::new(false));
        let controller = Arc::new(ClaudeStructuredProcessController {
            child: Arc::new(Mutex::new(child)),
            stdin: Mutex::new(stdin),
            interrupted: interrupted.clone(),
        });

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        debug!(target: "structured::claude", "{line}");
                    }
                }
            });
        }

        tokio::spawn(read_claude_events(
            stdout,
            tx,
            controller.child.clone(),
            interrupted,
            options.session_id,
        ));

        Ok(SpawnedStructuredProcess {
            controller,
            events: rx,
        })
    }
}

struct ClaudeStructuredProcessController {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    interrupted: Arc<AtomicBool>,
}

#[async_trait]
impl StructuredProcessController for ClaudeStructuredProcessController {
    async fn send_input(&self, text: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let Some(stdin) = stdin.as_mut() else {
            return Err("Structured provider stdin is unavailable".to_string());
        };
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())
    }

    async fn send_approval(&self, approved: bool) -> Result<(), String> {
        let answer = if approved { "y\n" } else { "n\n" };
        self.send_input(answer).await
    }

    async fn interrupt(&self) -> Result<(), String> {
        self.interrupted.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().await;
        child.kill().await.map_err(|error| error.to_string())
    }

    async fn kill(&self) -> Result<(), String> {
        self.interrupted.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().await;
        child.kill().await.map_err(|error| error.to_string())
    }
}

async fn read_claude_events(
    stdout: impl tokio::io::AsyncRead + Unpin,
    tx: mpsc::UnboundedSender<StructuredSessionEvent>,
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
    initial_session_id: Option<String>,
) {
    let seq = AtomicUsize::new(0);
    let mut session_id = initial_session_id.unwrap_or_else(|| "unknown".to_string());
    let mut accumulated_text = String::new();
    let mut current_tool_name: Option<String> = None;
    let mut lines = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(start) = trimmed.find('{') else {
            continue;
        };
        let Some(end) = trimmed.rfind('}') else {
            continue;
        };
        if end <= start {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&trimmed[start..=end]) else {
            continue;
        };
        for event in map_claude_message(
            &message,
            &seq,
            &mut accumulated_text,
            &mut current_tool_name,
        ) {
            if let StructuredSessionEvent::SessionStarted {
                session_id: next_session_id,
                ..
            } = &event
            {
                session_id = next_session_id.clone();
            }
            if tx.send(event).is_err() {
                return;
            }
        }
    }

    let status = {
        let mut child = child.lock().await;
        child.wait().await.ok()
    };
    let reason = if interrupted.load(Ordering::SeqCst) {
        "interrupted"
    } else if status.as_ref().is_some_and(|status| status.success()) {
        "completed"
    } else {
        "error"
    };
    let _ = tx.send(StructuredSessionEvent::SessionEnded {
        ts: now_ts(),
        seq: next_seq(&seq),
        session_id,
        reason: reason.to_string(),
    });
}

fn map_claude_message(
    message: &Value,
    seq: &AtomicUsize,
    accumulated_text: &mut String,
    current_tool_name: &mut Option<String>,
) -> Vec<StructuredSessionEvent> {
    let mut events = Vec::new();
    let timestamp = now_ts();

    if message.get("type") == Some(&Value::String("system".to_string()))
        && message.get("subtype") == Some(&Value::String("init".to_string()))
    {
        events.push(StructuredSessionEvent::SessionStarted {
            ts: timestamp,
            seq: next_seq(seq),
            session_id: message
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            provider: "claude".to_string(),
        });
        return events;
    }

    if message.get("type") == Some(&Value::String("assistant".to_string())) {
        if let Some(content) = message
            .get("message")
            .and_then(|value| value.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                if block.get("type") == Some(&Value::String("text".to_string())) {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if text.is_empty() {
                        continue;
                    }
                    accumulated_text.push_str(&text);
                    events.push(StructuredSessionEvent::MessageDelta {
                        ts: timestamp,
                        seq: next_seq(seq),
                        role: "assistant".to_string(),
                        content: text,
                    });
                } else if block.get("type") == Some(&Value::String("tool_use".to_string())) {
                    let tool_name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    *current_tool_name = Some(tool_name.clone());
                    events.push(StructuredSessionEvent::ToolStarted {
                        ts: timestamp,
                        seq: next_seq(seq),
                        tool_name,
                        tool_input: block
                            .get("input")
                            .cloned()
                            .unwrap_or(Value::Object(Default::default())),
                        tool_call_id: block.get("id").and_then(Value::as_str).map(str::to_string),
                    });
                }
            }
        }
        return events;
    }

    if message.get("type") == Some(&Value::String("user".to_string()))
        && message.get("tool_use_result").is_some()
    {
        let result = message
            .get("tool_use_result")
            .cloned()
            .map(|value| match value {
                Value::String(text) => text,
                other => other.to_string(),
            })
            .unwrap_or_default();
        events.push(StructuredSessionEvent::ToolCompleted {
            ts: timestamp,
            seq: next_seq(seq),
            tool_name: current_tool_name
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            result,
            is_error: message
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            tool_call_id: None,
        });
        *current_tool_name = None;
        return events;
    }

    if message.get("type") == Some(&Value::String("result".to_string())) {
        if !accumulated_text.is_empty() {
            events.push(StructuredSessionEvent::MessageCompleted {
                ts: timestamp,
                seq: next_seq(seq),
                role: "assistant".to_string(),
                content: accumulated_text.clone(),
            });
            accumulated_text.clear();
        }
        if message.get("subtype") != Some(&Value::String("success".to_string())) {
            events.push(StructuredSessionEvent::Error {
                ts: timestamp,
                seq: next_seq(seq),
                message: format!(
                    "CLI result: {}",
                    message
                        .get("subtype")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ),
                code: None,
            });
        }
        return events;
    }

    events.push(StructuredSessionEvent::RawProviderEvent {
        ts: timestamp,
        seq: next_seq(seq),
        provider: "claude".to_string(),
        data: message.clone(),
    });
    events
}
