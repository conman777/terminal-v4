use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Extension, Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
use uuid::Uuid;

const HELPER: &str = include_str!("workspace_browser.cjs");
const IMAGE_INVENTORY: &str = include_str!("browser_image_inventory.js");
const IDLE: Duration = Duration::from_secs(1800);
#[cfg(test)]
#[path = "workspace_browser_integration_tests.rs"]
mod integration_tests;
#[path = "workspace_browser_mcp.rs"]
mod mcp;

pub(crate) fn has_pending_session(
    data: &FsPath,
    owner: &str,
    session: &str,
) -> Result<bool, String> {
    mcp::has_pending_session(data, owner, session)
}
#[derive(Clone)]
pub(crate) struct AgentBrowserConnection {
    pub url: String,
    pub token: String,
    _lease: Arc<AgentLease>,
}
impl std::fmt::Debug for AgentBrowserConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentBrowserConnection")
            .field("url", &self.url)
            .field("token", &"[redacted]")
            .finish()
    }
}
struct AgentLease {
    key: String,
    owner: Owner,
    label: String,
    active: Arc<AtomicBool>,
}
impl Drop for AgentLease {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        mcp::cancel_capability(&self.key);
        if let Ok(mut capabilities) = CAPABILITIES.lock() {
            capabilities.remove(&self.key);
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let (data, owner) = self.owner.clone();
            let label = self.label.clone();
            runtime.spawn(async move {
                let _ = release_shared_agent(&data, &owner, &label).await;
            });
        }
    }
}
#[derive(Clone)]
struct Capability {
    owner: Owner,
    label: String,
    expires: Instant,
    active: Arc<AtomicBool>,
}
static CAPABILITIES: LazyLock<StdMutex<HashMap<String, Capability>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static HOSTS: LazyLock<StdMutex<HashMap<PathBuf, u16>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
pub(crate) fn agent_connection(
    config: &terminal_v4_core::AppConfig,
    owner: &str,
    label: &str,
) -> Result<AgentBrowserConnection, String> {
    use sha2::{Digest, Sha256};
    if owner.is_empty() || label.is_empty() || label.len() > 512 {
        return Err("Invalid browser agent scope".into());
    }
    let token = format!(
        "tv4browser.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let key = hex::encode(Sha256::digest(token.as_bytes()));
    let mut capabilities = CAPABILITIES
        .lock()
        .map_err(|_| "Browser capability registry unavailable")?;
    capabilities.retain(|_, value| value.expires > Instant::now());
    if capabilities.len() >= 1024 {
        return Err("Too many active browser connections".into());
    }
    let owned = (config.data_dir.clone(), owner.to_owned());
    let active = Arc::new(AtomicBool::new(true));
    capabilities.insert(
        key.clone(),
        Capability {
            owner: owned.clone(),
            label: label.to_owned(),
            expires: Instant::now() + Duration::from_secs(12 * 3600),
            active: active.clone(),
        },
    );
    Ok(AgentBrowserConnection {
        url: format!("http://127.0.0.1:{}/api/workspace-browser/mcp", config.port),
        token,
        _lease: Arc::new(AgentLease {
            key,
            owner: owned,
            label: label.to_owned(),
            active,
        }),
    })
}
pub(crate) fn register_host(state: &AppState) {
    if let Ok(mut hosts) = HOSTS.lock() {
        hosts.insert(state.config().data_dir.clone(), state.config().port);
    }
}
pub(crate) fn shared_available(data: &FsPath) -> bool {
    HOSTS.lock().is_ok_and(|hosts| hosts.contains_key(data))
}
#[cfg(test)]
pub(crate) struct SharedHostTestGuard {
    data: PathBuf,
    previous: Option<u16>,
}
#[cfg(test)]
impl Drop for SharedHostTestGuard {
    fn drop(&mut self) {
        let mut hosts = HOSTS.lock().unwrap();
        if let Some(port) = self.previous {
            hosts.insert(self.data.clone(), port);
        } else {
            hosts.remove(&self.data);
        }
    }
}
#[cfg(test)]
pub(crate) fn register_shared_test_host(data: &FsPath) -> SharedHostTestGuard {
    let data = data.to_path_buf();
    let previous = HOSTS.lock().unwrap().insert(data.clone(), 0);
    SharedHostTestGuard { data, previous }
}
#[cfg(test)]
pub(crate) struct SharedSessionTestGuard {
    key: Owner,
    entry: Entry,
}
#[cfg(test)]
impl SharedSessionTestGuard {
    pub(crate) fn set_state(&self, state: Value) {
        *self.entry.last_state.lock().unwrap() = state;
    }
    pub(crate) fn bump_generation(&self) {
        self.entry.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) async fn replace_session(&self) {
        SESSIONS.lock().await.get_mut(&self.key).unwrap().id = Uuid::new_v4();
    }
}
#[cfg(test)]
impl Drop for SharedSessionTestGuard {
    fn drop(&mut self) {
        let key = self.key.clone();
        let entry = self.entry.clone();
        tokio::spawn(async move {
            let mut registry = SESSIONS.lock().await;
            if registry
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(&current.worker, &entry.worker))
            {
                registry.remove(&key);
            }
            drop(registry);
            let _ = entry.worker.lock().await.close().await;
        });
    }
}
#[cfg(test)]
pub(crate) async fn register_shared_test_session(
    data: &FsPath,
    owner: &str,
    state: Value,
) -> SharedSessionTestGuard {
    let key = (data.to_path_buf(), owner.to_owned());
    let entry = integration_tests::pipe_fixture().await;
    *entry.last_state.lock().unwrap() = state;
    assert!(SESSIONS
        .lock()
        .await
        .insert(key.clone(), entry.clone())
        .is_none());
    SharedSessionTestGuard { key, entry }
}
type Owner = (PathBuf, String);
#[derive(Clone)]
struct Entry {
    id: Uuid,
    worker: Arc<Mutex<Worker>>,
    control: Arc<StdMutex<BrowserControl>>,
    last_state: Arc<StdMutex<Value>>,
    generation: Arc<AtomicU64>,
    #[cfg(test)]
    keyboard_inflight: Arc<AtomicBool>,
    #[cfg(test)]
    keyboard_lease: Arc<StdMutex<Option<Arc<std::fs::File>>>>,
}
#[derive(Clone, Default)]
struct ActionPermit {
    active: Vec<Arc<AtomicBool>>,
    expires: Option<Instant>,
}
impl ActionPermit {
    fn check(&self) -> Result<(), String> {
        if self
            .expires
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err("This browser agent lease expired. Start a fresh browser action.".into());
        }
        if self.active.iter().any(|gate| !gate.load(Ordering::SeqCst)) {
            return Err("This browser action was cancelled.".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
enum Caller {
    Observer,
    Human(u64),
    Agent {
        label: String,
        read: bool,
        generation: u64,
        permit: ActionPermit,
        configuration: Option<(Owner, Vec<u8>)>,
    },
}
struct CallLifetime(Arc<AtomicBool>);
impl Drop for CallLifetime {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct PressLifetime(Arc<StdMutex<bool>>);
impl Drop for PressLifetime {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = false;
        }
    }
}
fn track_call(caller: &mut Caller) -> CallLifetime {
    let active = Arc::new(AtomicBool::new(true));
    if let Caller::Agent { permit, .. } = caller {
        permit.active.push(active.clone());
    }
    CallLifetime(active)
}
#[derive(Default, Clone)]
enum BrowserControl {
    #[default]
    Available,
    Human,
    #[cfg(test)]
    HumanPending,
    Agent(String),
}
impl Entry {
    fn authorize_press_control(&self, caller: &Caller) -> Result<(), ApiError> {
        let Caller::Agent {
            label,
            read: false,
            generation,
            permit,
            ..
        } = caller
        else {
            return Err(ApiError::bad_request(
                "Keyboard action requires an agent control scope.",
            ));
        };
        let mut control = self
            .control
            .try_lock()
            .map_err(|_| unavailable("Browser control state unavailable"))?;
        permit.check().map_err(ApiError::bad_request)?;
        if self.generation.load(Ordering::SeqCst) != *generation {
            return Err(ApiError::bad_request(
                "Browser control changed; request fresh action approval.",
            ));
        }
        match &*control {
            BrowserControl::Human => Err(ApiError::bad_request("The user has taken control. Ask them to choose Let agents control before continuing.")),
            #[cfg(test)]
            BrowserControl::HumanPending => Err(ApiError::bad_request("The user has taken control. Ask them to choose Let agents control before continuing.")),
            BrowserControl::Agent(owner) if owner != label => Err(ApiError::bad_request("Another agent controls this browser. Wait for it to release control.")),
            BrowserControl::Available => { *control = BrowserControl::Agent(label.to_owned()); Ok(()) },
            _ => Ok(()),
        }?;
        #[cfg(test)]
        self.keyboard_inflight.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn call_press(
        &self,
        value: Value,
        mut caller: Caller,
        cancellation: crate::v4_agent::interaction::Cancellation,
    ) -> Result<Value, ApiError> {
        let _lifetime = track_call(&mut caller);
        let active = Arc::new(StdMutex::new(true));
        let _press_lifetime = PressLifetime(active.clone());
        let entry = self.clone();
        let task_cancel = cancellation.clone();
        let task = tokio::spawn(async move {
            let mut worker = entry.worker.lock().await;
            #[cfg(test)]
            if entry.keyboard_inflight.load(Ordering::SeqCst) {
                return Err(ApiError::bad_request("Keyboard release is still pending."));
            }
            #[cfg(test)]
            let lease = if let Caller::Agent {
                configuration: Some((owner, _)),
                ..
            } = &caller
            {
                Some(Arc::new(
                    crate::v4_agent::browser::browser_settings_lease(&owner.0, &owner.1)
                        .map_err(ApiError::bad_request)?,
                ))
            } else {
                None
            };
            if let Caller::Agent {
                configuration: Some((owner, reviewed)),
                ..
            } = &caller
            {
                let current = crate::v4_agent::browser::load_config(&owner.0, &owner.1)
                    .ok()
                    .and_then(|config| serde_json::to_vec(&config).ok());
                if current.as_ref() != Some(reviewed) {
                    return Err(ApiError::bad_request(
                        "Browser settings changed; request fresh action approval.",
                    ));
                }
            }
            task_cancel
                .admit(|| {
                    let active = active
                        .try_lock()
                        .map_err(|_| "Keyboard admission unavailable".to_string())?;
                    if !*active {
                        return Err("Keyboard action caller stopped".into());
                    }
                    entry
                        .authorize_press_control(&caller)
                        .map_err(|error| error.message)
                })
                .map_err(ApiError::bad_request)?;
            #[cfg(test)]
            {
                *entry
                    .keyboard_lease
                    .lock()
                    .map_err(|_| unavailable("Browser settings lease unavailable"))? = lease;
                worker.last_state = Value::Null;
            }
            let result = worker.call(value).await;
            #[cfg(test)]
            entry.settle_takeover(&worker.last_state)?;
            if worker.last_state["tabs"].is_array() {
                *entry
                    .last_state
                    .lock()
                    .map_err(|_| unavailable("Browser state unavailable"))? =
                    worker.last_state.clone();
            }
            result
        });
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(ApiError::bad_request("Keyboard action cancelled; inspect the page before retrying.")),
            result = task => result.map_err(|_| unavailable("Keyboard action stopped unexpectedly"))?,
        }
    }
    fn authorize(&self, caller: &Caller) -> Result<(), ApiError> {
        match caller {
            Caller::Observer => Ok(()),
            Caller::Human(generation) => {
                let control = self
                    .control
                    .lock()
                    .map_err(|_| unavailable("Browser control state unavailable"))?;
                if self.generation.load(Ordering::SeqCst) != *generation {
                    return Err(ApiError::bad_request(
                        "Browser control changed; retry your input.",
                    ));
                }
                if matches!(*control, BrowserControl::Agent(_)) {
                    return Err(ApiError {
                        status: axum::http::StatusCode::LOCKED,
                        message: "An agent is controlling this browser. Use Take control first."
                            .into(),
                    });
                }
                Ok(())
            }
            Caller::Agent {
                label,
                read,
                generation,
                permit,
                configuration,
            } => {
                let mut control = self
                    .control
                    .lock()
                    .map_err(|_| unavailable("Browser control state unavailable"))?;
                permit.check().map_err(ApiError::bad_request)?;
                if self.generation.load(Ordering::SeqCst) != *generation {
                    return Err(ApiError::bad_request(
                        "Browser control changed; request fresh action approval.",
                    ));
                }
                if let Some((owner, reviewed)) = configuration {
                    let current = crate::v4_agent::browser::load_config(&owner.0, &owner.1)
                        .ok()
                        .and_then(|config| serde_json::to_vec(&config).ok());
                    if current.as_ref() != Some(reviewed) {
                        return Err(ApiError::bad_request(
                            "Browser settings changed; request fresh action approval.",
                        ));
                    }
                }
                match &*control {
                    #[cfg(test)]
                    BrowserControl::HumanPending => return Err(ApiError::bad_request("Browser takeover is pending.")),
                    BrowserControl::Human if !read => return Err(ApiError::bad_request("The user has taken control. Ask them to choose Let agents control before continuing.")),
                    BrowserControl::Agent(owner) if owner != label => return Err(ApiError::bad_request("Another agent controls this browser. Wait for it to release control.")),
                    BrowserControl::Available => *control = BrowserControl::Agent(label.to_owned()),
                    _ => {}
                }
                Ok(())
            }
        }
    }
    async fn call(&self, value: Value, mut caller: Caller) -> Result<Value, ApiError> {
        let _lifetime = track_call(&mut caller);
        let entry = self.clone();
        tokio::spawn(async move {
            let mut worker = entry.worker.lock().await;
            entry.authorize(&caller)?;
            #[cfg(test)]
            let keyboard_inflight = entry.keyboard_inflight.load(Ordering::SeqCst);
            #[cfg(test)]
            if keyboard_inflight {
                worker.last_state = Value::Null;
            }
            let result = worker.call(value).await;
            #[cfg(test)]
            if keyboard_inflight {
                entry.settle_takeover(&worker.last_state)?;
            }
            if worker.last_state["tabs"].is_array() {
                *entry
                    .last_state
                    .lock()
                    .map_err(|_| unavailable("Browser state unavailable"))? =
                    worker.last_state.clone();
            }
            result
        })
        .await
        .map_err(|_| unavailable("Browser operation stopped unexpectedly"))?
    }
    #[cfg(test)]
    fn settle_takeover(&self, value: &Value) -> Result<(), ApiError> {
        if value.get("keyboardRelease") == Some(&Value::Null) {
            *self
                .keyboard_lease
                .lock()
                .map_err(|_| unavailable("Browser settings lease unavailable"))? = None;
            self.keyboard_inflight.store(false, Ordering::SeqCst);
        }
        let mut control = self
            .control
            .lock()
            .map_err(|_| unavailable("Browser control state unavailable"))?;
        if matches!(*control, BrowserControl::HumanPending)
            && value.get("keyboardRelease") == Some(&Value::Null)
        {
            *control = BrowserControl::Human;
        }
        Ok(())
    }
    fn decorate(&self, mut value: Value) -> Result<Value, ApiError> {
        let control = self
            .control
            .lock()
            .map_err(|_| unavailable("Browser control state unavailable"))?;
        value["control"] = match &*control {
            BrowserControl::Available => json!({"owner":"unclaimed"}),
            BrowserControl::Human => json!({"owner":"human"}),
            #[cfg(test)]
            BrowserControl::HumanPending => json!({"owner":"human_pending"}),
            BrowserControl::Agent(label) => json!({"owner":"agent","label":label}),
        };
        if value["tabs"].is_array() {
            *self
                .last_state
                .lock()
                .map_err(|_| unavailable("Browser state unavailable"))? = json!({"tabs":value["tabs"],"activeTabId":value["activeTabId"],"dialog":value["dialog"]});
        }
        Ok(value)
    }
    fn human_input(&self, dialog: bool) -> Result<(), ApiError> {
        let control = self
            .control
            .lock()
            .map_err(|_| unavailable("Browser control state unavailable"))?;
        #[cfg(test)]
        let pending = matches!(*control, BrowserControl::HumanPending) && !dialog;
        #[cfg(not(test))]
        let pending = {
            let _ = dialog;
            false
        };
        if matches!(*control, BrowserControl::Agent(_)) || pending {
            return Err(ApiError {
                status: axum::http::StatusCode::LOCKED,
                message: "An agent is controlling this browser. Use Take control first.".into(),
            });
        }
        Ok(())
    }
}
static SESSIONS: LazyLock<Mutex<HashMap<Owner, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace-browser/sessions", post(start))
        .route("/api/workspace-browser/approvals", get(mcp::approvals))
        .route("/api/workspace-browser/approvals/{id}", post(mcp::decide))
        .route(
            "/api/workspace-browser/sessions/{id}",
            get(status).delete(stop),
        )
        .route("/api/workspace-browser/sessions/{id}/frame", get(frame))
        .route(
            "/api/workspace-browser/sessions/{id}/command",
            post(command),
        )
        .layer(axum::extract::DefaultBodyLimit::max(100_000))
}
pub(crate) fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace-browser/mcp", post(mcp::handle))
        .layer(axum::extract::DefaultBodyLimit::max(100_000))
}
fn owner(state: &AppState, user: &AuthenticatedUser) -> Owner {
    (state.config().data_dir.clone(), user.user_id.clone())
}
fn unavailable(error: impl Into<String>) -> ApiError {
    ApiError {
        status: axum::http::StatusCode::SERVICE_UNAVAILABLE,
        message: error.into(),
    }
}

struct Worker {
    child: Child,
    tree: crate::process_tree::ProcessTree,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    touched: Instant,
    closed: bool,
    sequence: u64,
    pending_output: Vec<u8>,
    last_state: Value,
}
impl Worker {
    async fn launch() -> Result<Self, ApiError> {
        let runtime = crate::browser_runtime::resolve().map_err(unavailable)?;
        let mut command = Command::new(&runtime.node);
        command
            .arg("-e")
            .arg(format!(
                "const V4_IMAGE_INVENTORY = {};\n{HELPER}\nmain().catch(() => process.exit(1));",
                serde_json::to_string(IMAGE_INVENTORY)
                    .map_err(|_| unavailable("Browser image inventory unavailable"))?
            ))
            .current_dir(&runtime.root)
            .env("TERMINAL_V4_BROWSER_RUNTIME_DIR", &runtime.root)
            .env("WORKSPACE_BROWSER_BIN", &runtime.chromium)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| {
            unavailable(
                "Unable to start the bundled browser runtime. Repair or reinstall Terminal v4.",
            )
        })?;
        #[cfg(unix)]
        let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child);
        #[cfg(not(unix))]
        let tree = crate::process_tree::ProcessTree::attach(&child);
        let tree = tree.map_err(|_| unavailable("Unable to track the browser process."))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| unavailable("Browser input is unavailable."))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| unavailable("Browser output is unavailable."))?,
        );
        let mut worker = Self {
            child,
            tree,
            input,
            output,
            touched: Instant::now(),
            closed: false,
            sequence: 0,
            pending_output: Vec::new(),
            last_state: Value::Null,
        };
        if let Err(error) = worker.read(0).await {
            let _ = worker.close().await;
            return Err(error);
        }
        Ok(worker)
    }
    async fn read(&mut self, expected: u64) -> Result<Value, ApiError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let remaining = 8_000_001u64.saturating_sub(self.pending_output.len() as u64);
            let result = tokio::time::timeout_at(
                deadline,
                (&mut self.output)
                    .take(remaining)
                    .read_until(b'\n', &mut self.pending_output),
            )
            .await;
            if !matches!(result, Ok(Ok(count)) if count > 0)
                || self.pending_output.len() > 8_000_000
                || self.pending_output.last() != Some(&b'\n')
            {
                self.closed = true;
                let _ = self.tree.stop(Duration::from_millis(200)).await;
                return Err(unavailable(
                    "Browser connection stopped. End this browser session, then open it again.",
                ));
            }
            let line = std::mem::take(&mut self.pending_output);
            let response: Value = serde_json::from_slice(&line)
                .map_err(|_| unavailable("Invalid browser response."))?;
            let id = response["id"]
                .as_u64()
                .ok_or_else(|| unavailable("Browser response identity is missing."))?;
            if id < expected {
                continue;
            }
            if id != expected {
                self.closed = true;
                return Err(unavailable("Browser response identity is invalid."));
            }
            if response["state"]["tabs"].is_array() {
                self.last_state = response["state"].clone();
            }
            if response["ok"] != true {
                return Err(ApiError::bad_request(
                    response["error"]
                        .as_str()
                        .unwrap_or("Browser action failed."),
                ));
            }
            return Ok(response["value"].clone());
        }
    }
    async fn call(&mut self, value: Value) -> Result<Value, ApiError> {
        if self.closed {
            return Err(unavailable(
                "This browser session has ended. Close and reopen the browser.",
            ));
        }
        self.touched = Instant::now();
        self.sequence = self
            .sequence
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or_else(|| unavailable("Browser request limit reached."))?;
        let id = self.sequence;
        let bytes = format!("{}\n", json!({"id":id,"command":value}));
        if !matches!(
            tokio::time::timeout(
                Duration::from_secs(5),
                self.input.write_all(bytes.as_bytes())
            )
            .await,
            Ok(Ok(()))
        ) || !matches!(
            tokio::time::timeout(Duration::from_secs(5), self.input.flush()).await,
            Ok(Ok(()))
        ) {
            self.closed = true;
            let _ = self.tree.stop(Duration::from_millis(200)).await;
            return Err(unavailable("Browser input is unavailable."));
        }
        self.read(id).await
    }
    async fn close(&mut self) -> Result<(), ApiError> {
        self.closed = true;
        let _ = self.input.shutdown().await;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        self.tree
            .stop(Duration::from_millis(200))
            .await
            .map_err(|_| unavailable("Browser cleanup needs another attempt."))?;
        tokio::time::timeout(Duration::from_secs(3), self.tree.wait(&mut self.child))
            .await
            .map_err(|_| unavailable("Browser cleanup is still pending."))?
            .map_err(|_| unavailable("Unable to confirm browser shutdown."))?;
        Ok(())
    }
}
async fn entry(state: &AppState, user: &AuthenticatedUser, id: Uuid) -> Result<Entry, ApiError> {
    SESSIONS
        .lock()
        .await
        .get(&owner(state, user))
        .filter(|entry| entry.id == id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("Browser session not found."))
}
async fn ensure_entry(key: Owner, require_new: bool) -> Result<Entry, ApiError> {
    let mut registry = SESSIONS.lock().await;
    let entry = if let Some(entry) = registry.get(&key) {
        if require_new {
            return Err(ApiError::bad_request(
                "The reviewed browser session changed; request fresh approval",
            ));
        }
        entry.clone()
    } else {
        if registry.len() >= 8 {
            return Err(unavailable(
                "All browser slots are in use. End an unused browser session first.",
            ));
        }
        let entry = Entry {
            id: Uuid::new_v4(),
            worker: Arc::new(Mutex::new(Worker::launch().await?)),
            control: Arc::new(StdMutex::new(BrowserControl::Available)),
            last_state: Arc::new(StdMutex::new(
                json!({"tabs":[],"activeTabId":null,"dialog":null}),
            )),
            generation: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            keyboard_inflight: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            keyboard_lease: Arc::new(StdMutex::new(None)),
        };
        registry.insert(key.clone(), entry.clone());
        let id = entry.id;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let found = SESSIONS
                    .lock()
                    .await
                    .get(&key)
                    .filter(|entry| entry.id == id)
                    .cloned();
                let Some(found) = found else {
                    break;
                };
                if found.worker.lock().await.touched.elapsed() >= IDLE {
                    let _ = close_key(&key).await;
                    break;
                }
            }
        });
        entry
    };
    drop(registry);
    Ok(entry)
}
async fn start(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<Value>, ApiError> {
    let entry = ensure_entry(owner(&state, &user), false).await?;
    let value = entry
        .call(json!({"type":"state"}), Caller::Observer)
        .await?;
    Ok(Json(json!({"id":entry.id,"state":entry.decorate(value)?})))
}
async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let entry = entry(&state, &user, id).await?;
    let value = entry
        .call(json!({"type":"state"}), Caller::Observer)
        .await?;
    Ok(Json(entry.decorate(value)?))
}
async fn command(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
    Json(mut value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if value["type"] == "dialog"
        && value["dialogId"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .is_none()
    {
        return Err(ApiError::bad_request(
            "Choose the current browser dialog before responding.",
        ));
    }
    if value["type"] == "control" {
        let entry = entry(&state, &user, id).await?;
        let requested = match value["owner"].as_str() {
            Some("human") => BrowserControl::Human,
            Some("agents") => BrowserControl::Available,
            _ => return Err(ApiError::bad_request("Choose human or agents control.")),
        };
        let generation = {
            let mut control = entry
                .control
                .lock()
                .map_err(|_| unavailable("Browser control unavailable"))?;
            #[cfg(test)]
            if matches!(*control, BrowserControl::HumanPending) && value["owner"] == "agents" {
                return Err(ApiError::bad_request(
                    "Finish browser takeover before returning control to agents.",
                ));
            }
            #[cfg(test)]
            let requested = if matches!(requested, BrowserControl::Human)
                && entry.keyboard_inflight.load(Ordering::SeqCst)
            {
                BrowserControl::HumanPending
            } else {
                requested
            };
            *control = requested;
            entry.generation.fetch_add(1, Ordering::SeqCst) + 1
        };
        mcp::cancel_owner(&owner(&state, &user));
        if value["owner"] == "human" {
            let state = entry
                .call(
                    json!({"type":"control","owner":"human","human":true}),
                    Caller::Human(generation),
                )
                .await?;
            return Ok(Json(entry.decorate(state)?));
        }
        let current = entry
            .call(json!({"type":"state"}), Caller::Observer)
            .await?;
        return Ok(Json(entry.decorate(current)?));
    }
    if !matches!(
        value["type"].as_str(),
        Some(
            "navigate"
                | "back"
                | "forward"
                | "reload"
                | "newTab"
                | "switchTab"
                | "closeTab"
                | "resize"
                | "pointer"
                | "wheel"
                | "key"
                | "text"
                | "dialog"
        )
    ) {
        return Err(ApiError::bad_request("Unsupported browser command."));
    }
    let entry = entry(&state, &user, id).await?;
    if value["type"] != "resize" {
        entry.human_input(value["type"] == "dialog")?;
    }
    let caller = if value["type"] == "resize" {
        Caller::Observer
    } else {
        Caller::Human(entry.generation.load(Ordering::SeqCst))
    };
    if value["type"] != "resize" {
        value["human"] = json!(true);
    }
    let result = entry.call(value, caller).await?;
    Ok(Json(entry.decorate(result)?))
}
async fn frame(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<([(axum::http::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let entry = entry(&state, &user, id).await?;
    let result = entry
        .call(json!({"type":"frame"}), Caller::Observer)
        .await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(entry.decorate(result)?),
    ))
}
async fn stop(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<axum::http::StatusCode, ApiError> {
    let selected = entry(&state, &user, id).await?;
    mcp::cancel_owner(&owner(&state, &user));
    close_selected(&owner(&state, &user), selected).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
async fn close_selected_authorized(
    key: &Owner,
    selected: Entry,
    mut caller: Caller,
) -> Result<(), ApiError> {
    let _lifetime = track_call(&mut caller);
    let key = key.clone();
    tokio::spawn(async move {
        {
            let mut worker = selected.worker.lock().await;
            selected.authorize(&caller)?;
            selected.generation.fetch_add(1, Ordering::SeqCst);
            worker.close().await?;
            #[cfg(test)]
            selected.settle_takeover(&json!({"keyboardRelease":null}))?;
        }
        mcp::cancel_owner(&key);
        let mut registry = SESSIONS.lock().await;
        if registry
            .get(&key)
            .is_some_and(|current| current.id == selected.id)
        {
            registry.remove(&key);
        }
        Ok(())
    })
    .await
    .map_err(|_| unavailable("Browser cleanup task stopped unexpectedly"))?
}
async fn close_selected(key: &Owner, entry: Entry) -> Result<(), ApiError> {
    close_selected_authorized(key, entry, Caller::Observer).await
}
async fn close_key(key: &Owner) -> Result<(), ApiError> {
    let entry = SESSIONS.lock().await.get(key).cloned();
    if let Some(entry) = entry {
        close_selected(key, entry).await?;
    }
    Ok(())
}
pub(crate) async fn close_owner(state: &AppState, owner: &str) {
    mcp::cancel_owner(&(state.config().data_dir.clone(), owner.to_owned()));
    if let Ok(mut caps) = CAPABILITIES.lock() {
        caps.retain(|_, cap| {
            let keep = cap.owner != (state.config().data_dir.clone(), owner.to_owned());
            if !keep {
                cap.active.store(false, Ordering::SeqCst);
            }
            keep
        });
    }
    if let Err(error) = close_key(&(state.config().data_dir.clone(), owner.to_owned())).await {
        tracing::warn!(message = %error.message, "Workspace browser cleanup pending");
    }
}

#[cfg(test)]
pub(crate) async fn hold_session_registry_for_test(
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
) {
    let _guard = SESSIONS.lock().await;
    let _ = entered.send(());
    let _ = release.await;
}

pub(crate) async fn release_shared_agent(
    data: &FsPath,
    owner: &str,
    label: &str,
) -> Result<(), String> {
    let entry = SESSIONS
        .lock()
        .await
        .get(&(data.to_path_buf(), owner.to_owned()))
        .cloned();
    if let Some(entry) = entry {
        let label = label.to_owned();
        tokio::spawn(async move {
            let mut worker = entry.worker.lock().await;
            worker
                .call(json!({"type":"releaseAgent","label":label}))
                .await
                .map_err(|error| error.message)?;
            if worker.last_state["tabs"].is_array() {
                *entry
                    .last_state
                    .lock()
                    .map_err(|_| "Browser state unavailable")? = worker.last_state.clone();
            }
            let mut control = entry
                .control
                .lock()
                .map_err(|_| "Browser control unavailable")?;
            if matches!(&*control, BrowserControl::Agent(current) if current == &label) {
                *control = BrowserControl::Available;
                entry.generation.fetch_add(1, Ordering::SeqCst);
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "Browser release stopped unexpectedly")??;
    }
    Ok(())
}

fn check_agent_url(value: &str, origins: &[String]) -> Result<(), String> {
    if value == "about:blank" {
        return Ok(());
    }
    let parsed = url::Url::parse(value).map_err(|_| "Invalid browser URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !origins.contains(&parsed.origin().ascii_serialization())
    {
        return Err("This browser origin is not allowed. Ask the user to allow it in Settings → Agent browser.".into());
    }
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewTarget {
    session_id: Option<Uuid>,
    tab_id: Option<String>,
    document_id: Option<String>,
    generation: Option<u64>,
    url: Option<String>,
}
pub(crate) fn review_target(
    data: &FsPath,
    owner: &str,
    name: &str,
    input: &Value,
) -> Result<ReviewTarget, String> {
    let registry = SESSIONS
        .try_lock()
        .map_err(|_| "Browser session is changing; request the action again")?;
    let Some(entry) = registry.get(&(data.to_path_buf(), owner.to_owned())) else {
        return Ok(ReviewTarget {
            session_id: None,
            tab_id: None,
            document_id: None,
            generation: None,
            url: None,
        });
    };
    let generation = Some(entry.generation.load(Ordering::SeqCst));
    if name == "browser_open"
        || (name == "browser_close" || name == "browser_tabs") && input.get("tabId").is_none()
    {
        return Ok(ReviewTarget {
            session_id: Some(entry.id),
            tab_id: None,
            document_id: None,
            generation,
            url: None,
        });
    }
    let state = entry
        .last_state
        .lock()
        .map_err(|_| "Browser target state unavailable")?;
    let tab_id = input["tabId"]
        .as_str()
        .or_else(|| state["activeTabId"].as_str())
        .ok_or("Open a browser tab before requesting this action")?;
    let tab = state["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"] == tab_id))
        .ok_or("Browser tab is no longer available")?;
    let document = tab["documentId"]
        .as_str()
        .ok_or("Browser document identity is not ready; request the action again")?;
    Ok(ReviewTarget {
        session_id: Some(entry.id),
        tab_id: Some(tab_id.to_owned()),
        document_id: Some(document.to_owned()),
        generation,
        url: tab["url"].as_str().map(str::to_owned),
    })
}
pub(crate) async fn shared_agent_action_reviewed(
    data: &FsPath,
    owner: &str,
    label: &str,
    name: &str,
    input: &Value,
    allowed_origins: &[String],
    reviewed: &ReviewTarget,
) -> Result<Value, String> {
    shared_agent_action_guarded(
        &(data.to_path_buf(), owner.to_owned()),
        label,
        name,
        input,
        allowed_origins,
        reviewed,
        ActionPermit::default(),
    )
    .await
}
async fn shared_agent_action_guarded(
    key: &Owner,
    label: &str,
    name: &str,
    input: &Value,
    allowed_origins: &[String],
    reviewed: &ReviewTarget,
    permit: ActionPermit,
) -> Result<Value, String> {
    shared_agent_action_cancellable(
        key,
        label,
        name,
        input,
        allowed_origins,
        reviewed,
        permit,
        crate::v4_agent::interaction::Cancellation::default(),
    )
    .await
}

pub(crate) async fn shared_agent_press_reviewed(
    data: &FsPath,
    owner: &str,
    label: &str,
    input: &Value,
    allowed_origins: &[String],
    reviewed: &ReviewTarget,
    cancellation: crate::v4_agent::interaction::Cancellation,
) -> Result<Value, String> {
    shared_agent_action_cancellable(
        &(data.to_path_buf(), owner.to_owned()),
        label,
        "browser_press",
        input,
        allowed_origins,
        reviewed,
        ActionPermit::default(),
        cancellation,
    )
    .await
}

async fn shared_agent_action_cancellable(
    key: &Owner,
    label: &str,
    name: &str,
    input: &Value,
    allowed_origins: &[String],
    reviewed: &ReviewTarget,
    permit: ActionPermit,
    cancellation: crate::v4_agent::interaction::Cancellation,
) -> Result<Value, String> {
    let (data, owner) = key;
    crate::v4_agent::browser::validate_arguments(name, input)?;
    permit.check()?;
    if let Some(target) = input["url"].as_str() {
        check_agent_url(target, allowed_origins)?;
    }
    if reviewed.session_id.is_none() {
        if name == "browser_close" {
            return Ok(json!({"closed":false}));
        }
        if name == "browser_tabs" && input.get("tabId").is_none() {
            return Ok(json!({"tabs":[],"activeTabId":null}));
        }
        if name != "browser_open" {
            return Err("Open the shared browser with browser_open first".into());
        }
    }
    let config = crate::v4_agent::browser::load_config(data, owner)?;
    if !config.enabled || config.allowed_origins != allowed_origins {
        return Err("Browser settings changed; request fresh action approval.".into());
    }
    let configuration = serde_json::to_vec(&config).map_err(|_| "Browser settings unavailable")?;
    let key = (data.to_path_buf(), owner.to_owned());
    let entry = if name == "browser_open" && reviewed.session_id.is_none() {
        ensure_entry(key.clone(), true)
            .await
            .map_err(|error| error.message)?
    } else {
        SESSIONS
            .lock()
            .await
            .get(&key)
            .filter(|entry| Some(entry.id) == reviewed.session_id)
            .cloned()
            .ok_or("The reviewed browser session changed; request fresh approval")?
    };
    if reviewed
        .generation
        .is_some_and(|generation| entry.generation.load(Ordering::SeqCst) != generation)
    {
        return Err("Browser control changed; request fresh action approval".into());
    }
    let read = matches!(
        name,
        "browser_snapshot" | "browser_get_images" | "browser_screenshot" | "browser_wait"
    ) || name == "browser_tabs" && input.get("tabId").is_none();
    let generation = reviewed.generation.unwrap_or(0);
    let caller = Caller::Agent {
        label: label.into(),
        read,
        generation,
        permit,
        configuration: Some((key.clone(), configuration)),
    };
    if name == "browser_close" && input.get("tabId").is_none() {
        close_selected_authorized(&key, entry, caller)
            .await
            .map_err(|error| error.message)?;
        return Ok(json!({"closed":true}));
    }
    let timeout = input["timeoutMs"].as_u64().unwrap_or(15000);
    if name == "browser_wait" && !(1..=60000).contains(&timeout) {
        return Err("Browser wait timeout must be 1-60000 ms".into());
    }
    let deadline = Instant::now() + Duration::from_millis(timeout.min(60000));
    loop {
        let human_reading = read
            && matches!(
                *entry
                    .control
                    .lock()
                    .map_err(|_| "Browser control unavailable")?,
                BrowserControl::Human
            );
        let target = reviewed
            .tab_id
            .as_ref()
            .map(|tab| json!({"tabId":tab,"documentId":reviewed.document_id}));
        let command = json!({"type":"agent","label":label,"name":name,"input":input,"allowedOrigins":allowed_origins,"humanReading":human_reading,"target":target});
        let result = if name == "browser_press" {
            entry
                .call_press(command, caller.clone(), cancellation.clone())
                .await
        } else {
            entry.call(command, caller.clone()).await
        }
        .map_err(|error| error.message)?;
        if name != "browser_wait" || result["matched"] == true {
            return Ok(result);
        }
        if Instant::now() >= deadline {
            return Err("Browser wait timed out".into());
        }
        if matches!(
            *entry
                .control
                .lock()
                .map_err(|_| "Browser control unavailable")?,
            BrowserControl::Human
        ) {
            return Err("The user took browser control; the wait was cancelled".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}
pub(crate) async fn shutdown(state: &AppState) {
    if let Ok(mut hosts) = HOSTS.lock() {
        hosts.remove(&state.config().data_dir);
    }
    if let Ok(mut caps) = CAPABILITIES.lock() {
        caps.retain(|_, cap| {
            let keep = cap.owner.0 != state.config().data_dir;
            if !keep {
                cap.active.store(false, Ordering::SeqCst);
            }
            keep
        });
    }
    mcp::cancel_root(&state.config().data_dir);
    let keys: Vec<_> = SESSIONS
        .lock()
        .await
        .keys()
        .filter(|key| key.0 == state.config().data_dir)
        .cloned()
        .collect();
    for key in keys {
        if let Err(error) = close_key(&key).await {
            tracing::warn!(message = %error.message, "Workspace browser shutdown pending");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    #[tokio::test]
    async fn browser_routes_require_auth_and_do_not_start_a_browser_for_unowned_ids() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: dir.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let protected = crate::app(state.clone());
        let response = protected
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/workspace-browser/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let user = AuthenticatedUser {
            user_id: "browser-fixture".into(),
            username: "browser-fixture".into(),
        };
        let app = routes().layer(Extension(user)).with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/workspace-browser/sessions/{}",
                        Uuid::new_v4()
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
