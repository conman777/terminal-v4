//! V4-owned browser tools. Only new processes and private, disposable profiles are supported.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

const MAX_MESSAGE: usize = 8 * 1024 * 1024;
const MAX_ARGUMENTS: usize = 65_536;
const MAX_PENDING: usize = 64;
const MAX_TABS: usize = 8;
const MAX_TARGETS: usize = 64;
const MAX_ID: u64 = 1_000_000;
const WORLD: &str = "terminal-v4-owned-browser-tools";
const IMAGE_INVENTORY: &str = include_str!("../browser_image_inventory.js");
pub(crate) const SETTINGS_BUSY: &str =
    "Browser settings are busy with an active action or pending cleanup; stop the agent or retry shortly";
tokio::task_local! {
    static ACTION_SETTINGS_LEASE: Arc<std::fs::File>;
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default = "default_headless")]
    pub headless: bool,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}
fn default_headless() -> bool {
    true
}
fn default_timeout() -> u64 {
    15
}
impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            executable: None,
            headless: true,
            timeout_seconds: 15,
            allowed_origins: Vec::new(),
        }
    }
}
fn check_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
        Err("Invalid browser account scope".into())
    } else {
        Ok(())
    }
}
fn origin(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value).map_err(|_| "Invalid browser origin")?;
    if value.len() > 2048
        || value.chars().any(char::is_control)
        || parsed.host_str().is_none_or(|h| h.contains('*'))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(
            "Browser origins must be exact HTTP or HTTPS origins, without credentials or paths"
                .into(),
        );
    }
    Ok(parsed.origin().ascii_serialization())
}
impl BrowserConfig {
    fn validate_stored(&self) -> Result<(), String> {
        if !(1..=60).contains(&self.timeout_seconds) {
            return Err("Browser timeout must be 1-60 seconds".into());
        }
        if self.allowed_origins.len() > 64 {
            return Err("At most 64 browser origins may be approved".into());
        }
        for value in &self.allowed_origins {
            origin(value)?;
        }
        if let Some(executable) = &self.executable {
            if !Path::new(executable).is_absolute()
                || executable.len() > 4096
                || executable.chars().any(char::is_control)
            {
                return Err(
                    "Browser executable must be an absolute path without control characters".into(),
                );
            }
        }
        Ok(())
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.validate_stored()?;
        if let Some(executable) = &self.executable {
            check_executable(Path::new(executable))?;
        }
        Ok(())
    }
    pub(crate) fn normalized(&self) -> Result<Self, String> {
        self.validate()?;
        self.normalized_stored()
    }
    fn normalized_stored(&self) -> Result<Self, String> {
        self.validate_stored()?;
        let mut output = self.clone();
        output.allowed_origins.clear();
        for value in &self.allowed_origins {
            let value = origin(value)?;
            if !output.allowed_origins.contains(&value) {
                output.allowed_origins.push(value);
            }
        }
        Ok(output)
    }
    fn permits(&self, value: &str) -> bool {
        if value == "about:blank" {
            return true;
        }
        let Ok(parsed) = url::Url::parse(value) else {
            return false;
        };
        value.len() <= 4096
            && !value.chars().any(char::is_control)
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && matches!(parsed.scheme(), "http" | "https")
            && self
                .allowed_origins
                .iter()
                .filter_map(|v| origin(v).ok())
                .any(|v| v == parsed.origin().ascii_serialization())
    }
}
fn config_directory(data: &Path, owner: &str) -> Result<PathBuf, String> {
    check_owner(owner)?;
    Ok(data
        .join("v4-browser")
        .join(hex::encode(Sha256::digest(owner.as_bytes()))))
}
fn private_directory(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Browser data directory must not be a symlink".into());
    }
    std::fs::create_dir_all(path).map_err(|_| "Cannot prepare private browser storage")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect browser storage")?;
    }
    Ok(())
}
fn settings_lease(data: &Path, owner: &str, shared: bool) -> Result<std::fs::File, String> {
    let directory = config_directory(data, owner)?;
    private_directory(&data.join("v4-browser"))?;
    private_directory(&directory)?;
    let path = directory.join("settings.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options
        .open(&path)
        .map_err(|_| "Browser settings lock is unavailable")?;
    let opened = file
        .metadata()
        .map_err(|_| "Browser settings lock is unavailable")?;
    let current =
        std::fs::symlink_metadata(&path).map_err(|_| "Browser settings lock is unavailable")?;
    if !opened.is_file() || !current.is_file() || current.file_type().is_symlink() {
        return Err("Browser settings lock is unavailable".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Browser settings lock is unavailable".into());
        }
    }
    let locked = if shared {
        file.try_lock_shared()
    } else {
        file.try_lock()
    };
    match locked {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Err(SETTINGS_BUSY.into()),
        Err(std::fs::TryLockError::Error(_)) => {
            return Err("Browser settings lock is unavailable".into())
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current =
            std::fs::symlink_metadata(&path).map_err(|_| "Browser settings lock is unavailable")?;
        if !current.is_file()
            || current.file_type().is_symlink()
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        {
            return Err("Browser settings lock is unavailable".into());
        }
    }
    Ok(file)
}
pub(crate) fn browser_settings_lease(data: &Path, owner: &str) -> Result<std::fs::File, String> {
    settings_lease(data, owner, true)
}
pub(super) fn settings_revision(data: &Path, owner: &str) -> Result<Option<uuid::Uuid>, String> {
    let path = config_directory(data, owner)?.join("settings.revision");
    let _current = match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata)
            if metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() == 36 =>
        {
            metadata
        }
        _ => return Err("Browser settings revision is unavailable".into()),
    };
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "Browser settings revision is unavailable")?;
    let opened = file
        .metadata()
        .map_err(|_| "Browser settings revision is unavailable")?;
    if !opened.is_file() || opened.len() != 36 {
        return Err("Browser settings revision is unavailable".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || (opened.dev(), opened.ino()) != (_current.dev(), _current.ino())
        {
            return Err("Browser settings revision is unavailable".into());
        }
    }
    let mut contents = String::new();
    (&mut file)
        .take(37)
        .read_to_string(&mut contents)
        .map_err(|_| "Browser settings revision is unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let after = file
            .metadata()
            .map_err(|_| "Browser settings revision is unavailable")?;
        let current = std::fs::symlink_metadata(&path)
            .map_err(|_| "Browser settings revision is unavailable")?;
        if !current.is_file()
            || current.file_type().is_symlink()
            || after.nlink() != 1
            || (
                after.dev(),
                after.ino(),
                after.len(),
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec(),
            ) != (
                opened.dev(),
                opened.ino(),
                opened.len(),
                opened.mtime(),
                opened.mtime_nsec(),
                opened.ctime(),
                opened.ctime_nsec(),
            )
            || (current.dev(), current.ino()) != (opened.dev(), opened.ino())
        {
            return Err("Browser settings revision is unavailable".into());
        }
    }
    let revision =
        uuid::Uuid::parse_str(&contents).map_err(|_| "Browser settings revision is invalid")?;
    Ok(Some(revision))
}
pub(crate) fn load_config(data: &Path, owner: &str) -> Result<BrowserConfig, String> {
    let dir = config_directory(data, owner)?;
    if std::fs::symlink_metadata(data.join("v4-browser")).is_ok_and(|m| m.file_type().is_symlink())
        || std::fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("Browser configuration directory must not be a symlink".into());
    }
    let path = dir.join("config.json");
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BrowserConfig::default()),
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= 32_768 => {}
        _ => return Err("Invalid browser configuration file".into()),
    }
    let mut contents = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "Cannot read browser configuration")?
        .take(32_769)
        .read_to_end(&mut contents)
        .map_err(|_| "Cannot read browser configuration")?;
    if contents.len() > 32_768 {
        return Err("Browser configuration exceeds its limit".into());
    }
    let config: BrowserConfig =
        serde_json::from_slice(&contents).map_err(|_| "Invalid browser configuration")?;
    config.normalized_stored()
}
pub(crate) fn save_config(data: &Path, owner: &str, config: &BrowserConfig) -> Result<(), String> {
    let config = config.normalized()?;
    let _lease = settings_lease(data, owner, false)?;
    let directory = config_directory(data, owner)?;
    private_directory(&data.join("v4-browser"))?;
    private_directory(&directory)?;
    let mut revision = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "Cannot prepare browser settings revision")?;
    revision
        .write_all(uuid::Uuid::new_v4().to_string().as_bytes())
        .and_then(|_| revision.as_file().sync_all())
        .map_err(|_| "Cannot save browser settings revision")?;
    revision
        .persist(directory.join("settings.revision"))
        .map_err(|_| "Cannot save browser settings revision")?;
    #[cfg(unix)]
    std::fs::File::open(&directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Cannot sync browser settings revision")?;
    let mut file = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "Cannot prepare browser configuration")?;
    let bytes = serde_json::to_vec(&config).map_err(|_| "Cannot encode browser configuration")?;
    if bytes.len() > 32_768 {
        return Err("Browser configuration exceeds its limit".into());
    }
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot save browser configuration")?;
    file.persist(directory.join("config.json"))
        .map_err(|_| "Cannot save browser configuration")?;
    Ok(())
}
fn check_executable(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() || path.to_string_lossy().contains('\0') {
        return Err("Browser executable must be an existing absolute executable path".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(path)
            .map_err(|_| "Browser executable is unavailable")?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("Browser executable is not executable".into());
        }
    }
    #[cfg(windows)]
    {
        if !path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("exe"))
        {
            return Err("Browser executable must be an .exe file".into());
        }
    }
    Ok(())
}
pub(crate) fn discover_executable(config: &BrowserConfig) -> Result<PathBuf, String> {
    if let Some(path) = &config.executable {
        let path = PathBuf::from(path);
        check_executable(&path)?;
        return Ok(path);
    }
    let executable = crate::browser_runtime::resolve()?.chromium;
    check_executable(&executable)?;
    Ok(executable)
}

struct Request {
    method: String,
    params: Value,
    session: Option<String>,
    response: oneshot::Sender<Result<Value, String>>,
    lease: Option<Arc<std::fs::File>>,
}
#[derive(Clone, Debug, Default)]
struct Attached {
    session: String,
    page: bool,
    ready: bool,
    error: Option<String>,
    main_contexts: HashMap<String, MainContext>,
    console: VecDeque<ConsoleEntry>,
    dialogs: VecDeque<DialogEntry>,
    dialog_policy: Option<DialogPolicy>,
}
#[derive(Clone, Debug)]
struct ConsoleEntry {
    context: u64,
    level: String,
    text: String,
}
#[derive(Clone, Debug)]
struct DialogPolicy {
    accept: bool,
    prompt: Option<String>,
    origin: String,
    expires: tokio::time::Instant,
}
#[derive(Clone, Debug)]
struct DialogEntry {
    origin: String,
    kind: String,
    message: String,
    accepted: bool,
}
const MAX_CONSOLE_ENTRIES: usize = 200;
const MAX_CONSOLE_TEXT: usize = 500;
const MAX_CONSOLE_RETURN: u64 = 100;
const MAX_DIALOG_ENTRIES: usize = 10;
const DIALOG_POLICY_TTL: Duration = Duration::from_secs(60);

fn clip(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
fn console_argument(arg: &Value) -> String {
    match arg.get("value") {
        Some(Value::String(text)) => clip(text, MAX_CONSOLE_TEXT),
        Some(Value::Null) | None => arg["description"]
            .as_str()
            .or_else(|| arg["type"].as_str())
            .map(|text| clip(text, MAX_CONSOLE_TEXT))
            .unwrap_or_default(),
        Some(other) => clip(&other.to_string(), MAX_CONSOLE_TEXT),
    }
}
fn console_entry_from_api(params: &Value) -> Option<ConsoleEntry> {
    let text = params["args"]
        .as_array()?
        .iter()
        .take(8)
        .map(console_argument)
        .collect::<Vec<_>>()
        .join(" ");
    Some(ConsoleEntry {
        context: params["executionContextId"].as_u64()?,
        level: match params["type"].as_str()? {
            "warning" => "warning".into(),
            "error" | "assert" => "error".into(),
            "debug" => "debug".into(),
            "info" => "info".into(),
            _ => "log".into(),
        },
        text: clip(&text, MAX_CONSOLE_TEXT),
    })
}
fn console_entry_from_exception(params: &Value) -> Option<ConsoleEntry> {
    let details = &params["exceptionDetails"];
    let text = details["exception"]["description"]
        .as_str()
        .or_else(|| details["text"].as_str())
        .unwrap_or("Uncaught exception");
    Some(ConsoleEntry {
        context: details["executionContextId"].as_u64()?,
        level: "error".into(),
        text: clip(text, MAX_CONSOLE_TEXT),
    })
}
fn record_console(attached: &mut Attached, entry: ConsoleEntry) {
    attached.console.push_back(entry);
    while attached.console.len() > MAX_CONSOLE_ENTRIES {
        attached.console.pop_front();
    }
}
fn redact_console(text: &str) -> String {
    use std::sync::OnceLock;
    static PAIR: OnceLock<regex_lite::Regex> = OnceLock::new();
    static BEARER: OnceLock<regex_lite::Regex> = OnceLock::new();
    static OPAQUE: OnceLock<regex_lite::Regex> = OnceLock::new();
    let pair = PAIR.get_or_init(|| {
        regex_lite::Regex::new(r#"(?i)((?:pass(?:word|wd)?|secret|token|api[_-]?key|auth(?:orization)?|cookie|session(?:id)?|credential|private[_-]?key)["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"'&,;}]+"#).unwrap()
    });
    let bearer = BEARER.get_or_init(|| {
        regex_lite::Regex::new(r"(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+").unwrap()
    });
    let opaque = OPAQUE.get_or_init(|| regex_lite::Regex::new(r"[A-Za-z0-9_\-+/=.]{32,}").unwrap());
    let text = pair.replace_all(text, "${1}[redacted]");
    let text = bearer.replace_all(&text, "${1} [redacted]");
    opaque
        .replace_all(&text, |found: &regex_lite::Captures| {
            let word = &found[0];
            if word.bytes().any(|b| b.is_ascii_digit())
                && word.bytes().any(|b| b.is_ascii_alphabetic())
            {
                "[redacted]".to_owned()
            } else {
                word.to_owned()
            }
        })
        .into_owned()
}
fn page_origin(url: &str) -> String {
    if url == "about:blank" {
        return "null".into();
    }
    url::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default()
}
fn record_dialog(
    attached: &mut Attached,
    params: &Value,
    now: tokio::time::Instant,
) -> (bool, Option<String>) {
    let origin = page_origin(params["url"].as_str().unwrap_or(""));
    let kind = params["type"].as_str().unwrap_or("alert");
    if attached
        .dialog_policy
        .as_ref()
        .is_some_and(|policy| policy.expires <= now)
    {
        attached.dialog_policy = None;
    }
    let decision = if attached
        .dialog_policy
        .as_ref()
        .is_some_and(|policy| !origin.is_empty() && policy.origin == origin)
    {
        attached.dialog_policy.take()
    } else {
        None
    };
    let accepted = decision.as_ref().is_some_and(|policy| policy.accept);
    attached.dialogs.push_back(DialogEntry {
        origin,
        kind: clip(kind, 32),
        message: clip(params["message"].as_str().unwrap_or(""), MAX_CONSOLE_TEXT),
        accepted,
    });
    while attached.dialogs.len() > MAX_DIALOG_ENTRIES {
        attached.dialogs.pop_front();
    }
    let prompt = if accepted && kind == "prompt" {
        decision.and_then(|policy| policy.prompt)
    } else {
        None
    };
    (accepted, prompt)
}
#[derive(Clone, Debug)]
struct MainContext {
    id: u64,
    unique_id: String,
}
type Targets = Arc<Mutex<HashMap<String, Attached>>>;
struct Cdp {
    requests: mpsc::Sender<Request>,
    targets: Targets,
    changed: Arc<Notify>,
    actor: tokio::task::JoinHandle<()>,
    timeout: Duration,
    failed: Arc<AtomicBool>,
    // Unanswered commands retain their leases until owned-browser cleanup confirms process exit.
    _inflight_settings: Arc<Mutex<HashMap<u64, Arc<std::fs::File>>>>,
}
impl Drop for Cdp {
    fn drop(&mut self) {
        self.actor.abort();
    }
}
enum Reply {
    User(
        oneshot::Sender<Result<Value, String>>,
        Option<Arc<std::fs::File>>,
    ),
    Setup {
        target: String,
        session: String,
        steps: VecDeque<(&'static str, Value)>,
    },
    Internal,
}
struct Pending {
    reply: Reply,
    deadline: tokio::time::Instant,
}
struct Outgoing {
    method: String,
    params: Value,
    session: Option<String>,
    reply: Reply,
}
impl Cdp {
    async fn connect(endpoint: &str, config: BrowserConfig) -> Result<Self, String> {
        let timeout = Duration::from_secs(config.timeout_seconds);
        let socket_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (socket, _) = tokio::time::timeout(
            timeout,
            tokio_tungstenite::connect_async_with_config(endpoint, Some(socket_config), true),
        )
        .await
        .map_err(|_| "Browser protocol connection timed out")?
        .map_err(|_| "Cannot connect to the V4 browser")?;
        let (requests, receiver) = mpsc::channel(32);
        let targets = Arc::new(Mutex::new(HashMap::new()));
        let changed = Arc::new(Notify::new());
        let failed = Arc::new(AtomicBool::new(false));
        let inflight_settings = Arc::new(Mutex::new(HashMap::new()));
        let actor = tokio::spawn(cdp_actor(
            socket,
            receiver,
            targets.clone(),
            changed.clone(),
            config,
            failed.clone(),
            inflight_settings.clone(),
        ));
        Ok(Self {
            requests,
            targets,
            changed,
            actor,
            timeout,
            failed,
            _inflight_settings: inflight_settings,
        })
    }
    async fn request(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let lease = ACTION_SETTINGS_LEASE.try_with(Arc::clone).ok();
        self.request_guarded(method, params, session, lease).await
    }
    async fn request_guarded(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        lease: Option<Arc<std::fs::File>>,
    ) -> Result<Value, String> {
        let (response, receiver) = oneshot::channel();
        let request = Request {
            method: method.into(),
            params,
            session: session.map(str::to_owned),
            response,
            lease,
        };
        match tokio::time::timeout(self.timeout, async {
            self.requests
                .send(request)
                .await
                .map_err(|_| "Browser connection is closed")?;
            receiver.await.map_err(|_| "Browser connection is closed")?
        })
        .await
        {
            Ok(result) => result,
            Err(_) => {
                self.failed.store(true, Ordering::Release);
                self.actor.abort();
                Err("Browser request timed out; the isolated connection was closed".into())
            }
        }
    }
    async fn session(&self, target: &str) -> Result<String, String> {
        let result = tokio::time::timeout(self.timeout, async {
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(attached) = self
                    .targets
                    .lock()
                    .map_err(|_| "Browser state unavailable")?
                    .get(target)
                    .cloned()
                {
                    if let Some(error) = attached.error {
                        return Err(error);
                    }
                    if attached.ready {
                        return Ok(attached.session);
                    }
                }
                if self.actor.is_finished() {
                    return Err("Browser connection is closed".into());
                }
                notified.await;
            }
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                self.failed.store(true, Ordering::Release);
                self.actor.abort();
                Err(
                    "Browser tab initialization timed out; the isolated connection was closed"
                        .into(),
                )
            }
        }
    }
}
fn setup_steps(kind: &str) -> VecDeque<(&'static str, Value)> {
    // Popup renderers can withhold Runtime/Network enable replies until resumed.
    // Browser-side Fetch interception must be configured before resuming them.
    let mut steps = VecDeque::new();
    steps.push_back((
        "Fetch.enable",
        json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}],"handleAuthRequests":true}),
    ));
    steps.push_back((
        "Target.setAutoAttach",
        json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
    ));
    steps.push_back(("Runtime.runIfWaitingForDebugger", json!({})));
    steps.push_back(("Network.enable", json!({})));
    steps.push_back(("Network.setBypassServiceWorker", json!({"bypass":true})));
    if matches!(kind, "page" | "iframe") {
        steps.push_back(("Page.enable", json!({})));
    }
    steps.push_back(("Runtime.enable", json!({})));
    steps
}
async fn cdp_actor(
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut requests: mpsc::Receiver<Request>,
    targets: Targets,
    changed: Arc<Notify>,
    config: BrowserConfig,
    failed: Arc<AtomicBool>,
    inflight_settings: Arc<Mutex<HashMap<u64, Arc<std::fs::File>>>>,
) {
    let (mut output, mut input) = socket.split();
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    let mut queue: VecDeque<Outgoing> = VecDeque::new();
    let mut sequence = 0u64;
    let timeout = Duration::from_secs(config.timeout_seconds);
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let mut failure = "Browser connection is closed".to_owned();
    loop {
        if let Some(request) = queue.pop_front() {
            sequence = sequence.saturating_add(1);
            if sequence > MAX_ID || pending.len() >= MAX_PENDING {
                failure = "Browser protocol request limit exceeded".into();
                break;
            }
            if let Reply::User(_, Some(lease)) = &request.reply {
                match inflight_settings.lock() {
                    Ok(mut leases) => {
                        leases.insert(sequence, lease.clone());
                    }
                    Err(_) => {
                        failure = "Browser action ownership is unavailable".into();
                        break;
                    }
                }
            }
            let mut message =
                json!({"id":sequence,"method":request.method,"params":request.params});
            if let Some(session) = request.session {
                message["sessionId"] = json!(session);
            }
            let result = tokio::time::timeout(
                timeout,
                output.send(Message::Text(message.to_string().into())),
            )
            .await;
            if !matches!(result, Ok(Ok(()))) {
                failure = "Browser protocol write failed".into();
                break;
            }
            pending.insert(
                sequence,
                Pending {
                    reply: request.reply,
                    deadline: tokio::time::Instant::now() + timeout,
                },
            );
        }
        tokio::select! {
            request=requests.recv(),if pending.len()<MAX_PENDING && queue.len()<MAX_PENDING=>{
                let Some(request)=request else{break};
                queue.push_back(Outgoing{method:request.method,params:request.params,session:request.session,reply:Reply::User(request.response,request.lease)});
            },
            message=input.next()=>{
                let Some(Ok(message))=message else{break};
                let text=match message{Message::Text(text)=>text,Message::Ping(data)=>{if output.send(Message::Pong(data)).await.is_err(){break;}continue},Message::Close(_)=>break,_=>{failure="Unexpected browser protocol frame".into();break;}};
                let Ok(value)=serde_json::from_str::<Value>(&text) else{failure="Invalid browser protocol JSON".into();break};
                if let Some(id)=value.get("id"){
                    let Some(id)=id.as_u64().filter(|id|*id>0 && *id<=sequence) else{failure="Invalid browser protocol response ID".into();break};
                    if value.get("error").is_none() && value.get("result").is_none() {failure="Browser protocol response has no result".into();break;}
                    let Some(request)=pending.remove(&id) else{failure="Unknown browser protocol response ID".into();break};
                    if let Ok(mut leases) = inflight_settings.lock() { leases.remove(&id); }
                    else { failure="Browser action ownership is unavailable".into(); break; }
                    let result=if value.get("error").is_some(){Err(format!("Browser protocol operation failed: {}",value["error"]["message"].as_str().unwrap_or("unknown error").chars().take(300).collect::<String>()))}else if let Some(result)=value.get("result"){Ok(result.clone())}else{Err("Browser protocol response has no result".into())};
                    match request.reply {
                        Reply::User(response, _lease)=>{let _=response.send(result);},
                        Reply::Setup{target,session,mut steps}=>{
                            if let Err(error)=result {if let Ok(mut map)=targets.lock(){if let Some(value)=map.get_mut(&target){value.error=Some(error);}}changed.notify_waiters();queue.push_back(Outgoing{method:"Target.closeTarget".into(),params:json!({"targetId":target}),session:None,reply:Reply::Internal});}
                            else if let Some((method,params))=steps.pop_front(){queue.push_back(Outgoing{method:method.into(),params,session:Some(session.clone()),reply:Reply::Setup{target,session,steps}});}
                            else {if let Ok(mut map)=targets.lock(){if let Some(value)=map.get_mut(&target){value.ready=true;}}changed.notify_waiters();}
                        },
                        Reply::Internal=>{if result.is_err(){failure="Browser request isolation failed".into();break;}}
                    }
                }else if let Some(method)=value["method"].as_str(){
                    let session=value["sessionId"].as_str().map(str::to_owned);
                    match method {
                        "Target.attachedToTarget"=>{
                            let params=&value["params"];let target=params["targetInfo"]["targetId"].as_str();let attached=params["sessionId"].as_str();
                            let (Some(target),Some(attached))=(target,attached) else{failure="Invalid browser tab event".into();break};
                            let kind=params["targetInfo"]["type"].as_str().unwrap_or("");
                            let too_many=targets.lock().map(|map|(map.len()>=MAX_TARGETS || kind=="page" && map.values().filter(|value|value.page).count()>=MAX_TABS) && !map.contains_key(target)).unwrap_or(true);
                            if too_many {queue.push_back(Outgoing{method:"Target.closeTarget".into(),params:json!({"targetId":target}),session:None,reply:Reply::Internal});continue;}
                            if let Ok(mut map)=targets.lock(){map.insert(target.into(),Attached{session:attached.into(),page:kind=="page",ready:false,error:None,main_contexts:HashMap::new(),..Default::default()});}
                            let mut steps=setup_steps(kind);let(method,params)=steps.pop_front().unwrap();queue.push_back(Outgoing{method:method.into(),params,session:Some(attached.into()),reply:Reply::Setup{target:target.into(),session:attached.into(),steps}});
                        },
                        "Target.detachedFromTarget"=>{let detached=value["params"]["sessionId"].as_str();if let Ok(mut map)=targets.lock(){map.retain(|_,v|Some(v.session.as_str())!=detached);}changed.notify_waiters();},
                        "Runtime.executionContextCreated"=>{
                            let context=&value["params"]["context"];
                            if context["auxData"]["isDefault"] == true {
                                if let (Some(session),Some(frame),Some(id),Some(unique_id))=(session.as_deref(),context["auxData"]["frameId"].as_str().filter(|v|v.len()<=256),context["id"].as_u64(),context["uniqueId"].as_str().filter(|v|!v.is_empty() && v.len()<=256)) {
                                    if let Ok(mut map)=targets.lock(){if let Some(attached)=map.values_mut().find(|v|v.session==session){if attached.main_contexts.len()<128 || attached.main_contexts.contains_key(frame){attached.main_contexts.insert(frame.into(),MainContext{id,unique_id:unique_id.into()});}}}
                                }
                            }
                        },
                        "Runtime.executionContextDestroyed"=>{
                            if let (Some(session),Some(id))=(session.as_deref(),value["params"]["executionContextId"].as_u64()) {
                                if let Ok(mut map)=targets.lock(){if let Some(attached)=map.values_mut().find(|v|v.session==session){attached.main_contexts.retain(|_,context|context.id!=id);}}
                            }
                        },
                        "Runtime.executionContextsCleared"=>{
                            if let Some(session)=session.as_deref(){if let Ok(mut map)=targets.lock(){if let Some(attached)=map.values_mut().find(|v|v.session==session){attached.main_contexts.clear();}}}
                        },
                        "Fetch.requestPaused"=>{
                            let params=&value["params"];let allowed=params["request"]["url"].as_str().is_some_and(|url|config.permits(url) || url.starts_with("data:") || url.starts_with("blob:"));
                            let method=if allowed{"Fetch.continueRequest"}else{"Fetch.failRequest"};let mut params=json!({"requestId":params["requestId"]});if !allowed{params["errorReason"]=json!("BlockedByClient");}
                            queue.push_back(Outgoing{method:method.into(),params,session,reply:Reply::Internal});
                        },
                        "Fetch.authRequired"=>queue.push_back(Outgoing{method:"Fetch.continueWithAuth".into(),params:json!({"requestId":value["params"]["requestId"],"authChallengeResponse":{"response":"CancelAuth"}}),session,reply:Reply::Internal}),
                        "Page.javascriptDialogOpening"=>{
                            let (accept,prompt)=session.as_deref().and_then(|current|targets.lock().ok().and_then(|mut map|map.values_mut().find(|v|v.session==current).map(|attached|record_dialog(attached,&value["params"],tokio::time::Instant::now())))).unwrap_or((false,None));
                            let mut params=json!({"accept":accept});
                            if let Some(prompt)=prompt{params["promptText"]=json!(prompt);}
                            queue.push_back(Outgoing{method:"Page.handleJavaScriptDialog".into(),params,session,reply:Reply::Internal});
                        },
                        "Runtime.consoleAPICalled"|"Runtime.exceptionThrown"=>{
                            let entry=if method=="Runtime.consoleAPICalled"{console_entry_from_api(&value["params"])}else{console_entry_from_exception(&value["params"])};
                            if let (Some(current),Some(entry))=(session.as_deref(),entry){if let Ok(mut map)=targets.lock(){if let Some(attached)=map.values_mut().find(|v|v.session==current){record_console(attached,entry);}}}
                        },
                        _=>{}
                    }
                    if queue.len()>MAX_PENDING {failure="Browser event rate exceeded its limit".into();break;}
                }else{failure="Invalid browser protocol message".into();break;}
            },
            _=interval.tick()=>{if pending.values().any(|request|request.deadline<=tokio::time::Instant::now()){failure="Browser request timed out; the isolated connection was closed".into();break;}}
        }
    }
    failed.store(true, Ordering::Release);
    for (_, request) in pending {
        if let Reply::User(response, _lease) = request.reply {
            let _ = response.send(Err(failure.clone()));
        }
    }
    for request in queue {
        if let Reply::User(response, _lease) = request.reply {
            let _ = response.send(Err(failure.clone()));
        }
    }
    if let Ok(mut map) = targets.lock() {
        for attached in map.values_mut() {
            attached.error = Some(failure.clone());
        }
    }
    changed.notify_waiters();
    let _ = tokio::time::timeout(Duration::from_millis(250), output.close()).await;
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ProfileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
impl ProfileIdentity {
    fn read(metadata: &std::fs::Metadata) -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            Err(
                "Checked isolated browser profile cleanup is currently supported only on Unix"
                    .into(),
            )
        }
    }
}

#[derive(Clone)]
struct OwnedProfile {
    path: PathBuf,
    parent: PathBuf,
    parent_identity: ProfileIdentity,
    leaf_identity: ProfileIdentity,
}
impl OwnedProfile {
    fn capture(path: &Path, expected_parent: &Path) -> Result<Self, String> {
        let parent = expected_parent
            .canonicalize()
            .map_err(|_| "Browser profile parent is unavailable")?;
        if path.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&parent) {
            return Err("Browser profile is outside its owned workspace parent".into());
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| n.starts_with("isolated-"))
            .ok_or("Invalid owned browser profile leaf")?;
        let path = parent.join(name);
        let parent_metadata = std::fs::symlink_metadata(&parent)
            .map_err(|_| "Cannot inspect browser profile parent")?;
        let leaf_metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "Cannot inspect browser profile leaf")?;
        if !parent_metadata.is_dir()
            || parent_metadata.file_type().is_symlink()
            || !leaf_metadata.is_dir()
            || leaf_metadata.file_type().is_symlink()
        {
            return Err("Browser profile parent and leaf must be owned directories".into());
        }
        Ok(Self {
            path,
            parent,
            parent_identity: ProfileIdentity::read(&parent_metadata)?,
            leaf_identity: ProfileIdentity::read(&leaf_metadata)?,
        })
    }
    #[cfg(test)]
    fn publish(profile: tempfile::TempDir) -> Self {
        let owned = Self::capture(profile.path(), profile.path().parent().unwrap()).unwrap();
        let _ = profile.keep();
        owned
    }
    fn path(&self) -> &Path {
        &self.path
    }
    fn remove_checked(&self) -> Result<(), String> {
        let parent = std::fs::symlink_metadata(&self.parent)
            .map_err(|_| "Browser profile parent cannot be confirmed")?;
        if !parent.is_dir()
            || parent.file_type().is_symlink()
            || ProfileIdentity::read(&parent)? != self.parent_identity
            || self
                .parent
                .canonicalize()
                .map_err(|_| "Browser profile parent cannot be resolved")?
                != self.parent
            || self.path.parent() != Some(self.parent.as_path())
        {
            return Err(
                "Browser profile parent identity changed; cleanup retained for retry".into(),
            );
        }
        let leaf = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("Browser profile leaf cannot be inspected".into()),
        };
        if !leaf.is_dir()
            || leaf.file_type().is_symlink()
            || ProfileIdentity::read(&leaf)? != self.leaf_identity
        {
            return Err(
                "Browser profile leaf identity changed; unrelated path was not deleted".into(),
            );
        }
        std::fs::remove_dir_all(&self.path)
            .map_err(|_| "Browser profile removal failed; ownership retained for retry")?;
        match std::fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err("Browser profile absence is unconfirmed; ownership retained for retry".into()),
        }
    }
}

#[derive(Default)]
struct CleanupJob {
    task: Option<tokio::task::JoinHandle<Result<(), String>>>,
    confirmed: bool,
}
impl CleanupJob {
    async fn wait(&mut self, deadline: tokio::time::Instant, phase: &str) -> Result<(), String> {
        if self.confirmed {
            return Ok(());
        }
        let task = self
            .task
            .as_mut()
            .ok_or_else(|| format!("Browser {phase} cleanup was not started"))?;
        let result = match tokio::time::timeout_at(deadline, task).await {
            Ok(result) => result,
            Err(_) => {
                return Err(format!(
                    "Browser {phase} cleanup is still pending; original worker retained for retry"
                ))
            }
        };
        self.task = None;
        result
            .map_err(|_| format!("Browser {phase} cleanup worker stopped; ownership retained"))??;
        self.confirmed = true;
        Ok(())
    }
}
#[derive(Default)]
struct BrowserCleanup {
    advisory_attempted: bool,
    stop: CleanupJob,
    reap: CleanupJob,
    profile: CleanupJob,
}

struct OwnedBrowser {
    identity: uuid::Uuid,
    cdp: Option<Cdp>,
    tree: Option<crate::process_tree::ProcessTree>,
    child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    _profile: OwnedProfile,
    cleanup: BrowserCleanup,
    ready: bool,
    retiring: bool,
    launch_error: Option<String>,
    #[cfg(all(test, unix))]
    cleanup_probe: Option<CleanupProbe>,
    active: Option<String>,
    has_opened: bool,
}
impl Drop for OwnedBrowser {
    fn drop(&mut self) {
        if let Some(reap) = self.cleanup.reap.task.take() {
            reap.abort();
        }
        drop(self.tree.take());
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
        // Only the async wait is cancelled on owner Drop; blocking stop/removal jobs retain their handles.
        // Releasing the wait's Child Arc permits kill_on_drop fallback, never a cleanup acknowledgement.
    }
}
impl OwnedBrowser {
    fn cdp(&self) -> Result<&Cdp, String> {
        self.cdp
            .as_ref()
            .ok_or_else(|| "Browser protocol is not ready; close the retained browser first".into())
    }
    fn spawn(
        data: &Path,
        owner: &str,
        workspace: &Path,
        config: &BrowserConfig,
        #[cfg(all(test, unix))] cleanup_probe: Option<CleanupProbe>,
    ) -> Result<Self, String> {
        if !config.enabled {
            return Err("Browser tools are disabled for this account".into());
        }
        let executable = discover_executable(config)?;
        let owner_directory = config_directory(data, owner)?;
        private_directory(&data.join("v4-browser"))?;
        private_directory(&owner_directory)?;
        let directory = owner_directory.join("profiles");
        private_directory(&directory)?;
        let directory = directory.join(hex::encode(Sha256::digest(
            workspace.to_string_lossy().as_bytes(),
        )));
        private_directory(&directory)?;
        let profile = tempfile::Builder::new()
            .prefix("isolated-")
            .tempdir_in(&directory)
            .map_err(|_| "Cannot create private browser profile")?;
        #[cfg(all(test, unix))]
        if let Some(probe) = &cleanup_probe {
            probe.set_profile(profile.path());
        }
        let owned_profile = OwnedProfile::capture(profile.path(), &directory)?;
        let home = profile.path().join("home");
        private_directory(&home)?;
        let temp = profile.path().join("tmp");
        private_directory(&temp)?;
        let mut command = tokio::process::Command::new(executable);
        command.args([
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-extensions",
            "--disable-breakpad",
            "--disable-features=MediaRouter,OptimizationHints",
            "--password-store=basic",
            "--use-mock-keychain",
            "--no-proxy-server",
            "--window-size=1280,900",
        ]);
        command.arg(format!("--user-data-dir={}", profile.path().display()));
        if config.headless {
            command.arg("--headless=new");
        }
        command.arg("about:blank");
        command
            .current_dir(profile.path())
            .env_clear()
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("TMPDIR", &temp)
            .env("TMP", &temp)
            .env("TEMP", &temp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in [
            "SystemRoot",
            "WINDIR",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|_| "Cannot launch the configured isolated browser")?;
        let _ = profile.keep();
        #[cfg(all(test, unix))]
        if let Some(probe) = &cleanup_probe {
            probe.record_spawn(child.id().unwrap());
        }
        let attached = crate::process_tree::ProcessTree::attach(&child);
        #[cfg(all(test, unix))]
        let attached = if cleanup_probe
            .as_ref()
            .is_some_and(|probe| probe.0.fail_attach.load(Ordering::SeqCst))
        {
            drop(attached);
            Err(std::io::Error::other(
                "Synthetic browser containment attach failure",
            ))
        } else {
            attached
        };
        let (tree, launch_error) = match attached {
            Ok(tree) => (Some(tree), None),
            Err(_) => (
                None,
                Some("Cannot contain the isolated browser process tree".to_owned()),
            ),
        };
        Ok(Self {
            identity: uuid::Uuid::new_v4(),
            cdp: None,
            tree,
            child: Arc::new(tokio::sync::Mutex::new(child)),
            _profile: owned_profile,
            cleanup: BrowserCleanup::default(),
            ready: false,
            retiring: false,
            launch_error,
            #[cfg(all(test, unix))]
            cleanup_probe,
            active: None,
            has_opened: false,
        })
    }
    async fn finish_launch(&mut self, config: &BrowserConfig) -> Result<(), String> {
        if let Some(error) = &self.launch_error {
            return Err(error.clone());
        }
        #[cfg(all(test, unix))]
        if let Some(probe) = &self.cleanup_probe {
            let pending = probe.0.launch_pending.lock().unwrap().clone();
            if let Some(pending) = pending {
                tokio::task::spawn_blocking(move || pending.wait_blocking())
                    .await
                    .map_err(|_| "Synthetic browser readiness worker stopped".to_owned())?;
            }
        }
        let endpoint = tokio::time::timeout(Duration::from_secs(config.timeout_seconds), async {
            loop {
                if self
                    .child
                    .lock()
                    .await
                    .try_wait()
                    .map_err(|_| "Cannot inspect browser process")?
                    .is_some()
                {
                    return Err::<String, String>(
                        "The isolated browser exited before it was ready".into(),
                    );
                }
                let path = self._profile.path().join("DevToolsActivePort");
                if let Ok(metadata) = std::fs::symlink_metadata(&path) {
                    if metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() < 1024
                    {
                        if let Ok(text) = tokio::fs::read_to_string(path).await {
                            if let Ok(endpoint) = parse_endpoint(&text) {
                                return Ok(endpoint);
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "Browser launch timed out")??;
        self.cdp = Some(Cdp::connect(&endpoint, config.clone()).await?);
        self.cdp()?
            .request(
                "Browser.setDownloadBehavior",
                json!({"behavior":"deny"}),
                None,
            )
            .await?;
        self.cdp()?
            .request(
                "Target.setAutoAttach",
                json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
                None,
            )
            .await?;
        let tabs = self.tabs().await?;
        if let Some(tab) = tabs.first().and_then(|v| v["id"].as_str()) {
            self.cdp()?.session(tab).await?;
            self.active = Some(tab.into());
        }
        self.ready = true;
        Ok(())
    }
    async fn tabs(&self) -> Result<Vec<Value>, String> {
        let result = self
            .cdp()?
            .request("Target.getTargets", json!({}), None)
            .await?;
        Ok(result["targetInfos"].as_array().ok_or("Invalid browser target list")?.iter().filter(|target|target["type"]=="page").take(MAX_TABS).map(|target|json!({"id":target["targetId"],"url":target["url"],"title":target["title"],"active":target["targetId"].as_str()==self.active.as_deref()})).collect())
    }
    async fn active_session(&mut self, input: &Value) -> Result<String, String> {
        if let Some(tab) = input.get("tabId") {
            let tab = tab
                .as_str()
                .filter(|tab| valid_tab(tab))
                .ok_or("Invalid tab ID")?;
            if !self.tabs().await?.iter().any(|row| row["id"] == tab) {
                return Err("Tab is unavailable in this isolated browser".into());
            }
            self.cdp()?
                .request("Target.activateTarget", json!({"targetId":tab}), None)
                .await?;
            self.active = Some(tab.into());
        }
        let tab = self.active.as_deref().ok_or("No browser tab is open")?;
        self.cdp()?.session(tab).await
    }
    async fn evaluate(&self, session: &str, script: &str, isolated: bool) -> Result<Value, String> {
        let mut params = json!({"expression":script,"returnByValue":true,"awaitPromise":true,"userGesture":true,"timeout":5000});
        if isolated {
            let tree = self
                .cdp()?
                .request("Page.getFrameTree", json!({}), Some(session))
                .await?;
            let frame = tree["frameTree"]["frame"]["id"]
                .as_str()
                .ok_or("Browser document is unavailable")?;
            let world = self
                .cdp()?
                .request(
                    "Page.createIsolatedWorld",
                    json!({"frameId":frame,"worldName":WORLD}),
                    Some(session),
                )
                .await?;
            params["contextId"] = world["executionContextId"].clone();
        }
        let result = self
            .cdp()?
            .request("Runtime.evaluate", params, Some(session))
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err(format!(
                "Browser script failed: {}",
                result["exceptionDetails"]["exception"]["description"]
                    .as_str()
                    .or_else(|| result["exceptionDetails"]["text"].as_str())
                    .unwrap_or("unknown exception")
                    .chars()
                    .take(500)
                    .collect::<String>()
            ));
        }
        Ok(result["result"]
            .get("value")
            .cloned()
            .unwrap_or(Value::Null))
    }
    async fn ready(&self, session: &str, timeout: Duration) -> Result<(), String> {
        tokio::time::timeout(timeout, async {
            loop {
                if self
                    .evaluate(session, "document.readyState !== 'loading'", false)
                    .await
                    .unwrap_or(json!(false))
                    == true
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| "Browser document wait timed out")?
    }
    async fn navigate(&self, session: &str, url: &str) -> Result<Value, String> {
        let result = self
            .cdp()?
            .request("Page.navigate", json!({"url":url}), Some(session))
            .await?;
        if let Some(error) = result["errorText"].as_str() {
            return Err(format!(
                "Browser navigation failed: {}",
                error.chars().take(200).collect::<String>()
            ));
        }
        self.ready(session, self.cdp()?.timeout).await?;
        self.evaluate(session, "({url:location.href,title:document.title})", true)
            .await
    }
    fn start_reap(&mut self) {
        if self.cleanup.reap.confirmed || self.cleanup.reap.task.is_some() {
            return;
        }
        let child = self.child.clone();
        #[cfg(all(test, unix))]
        let probe = self.cleanup_probe.clone();
        self.cleanup.reap.task = Some(tokio::spawn(async move {
            let outcome = child
                .lock()
                .await
                .wait()
                .await
                .map(|_| ())
                .map_err(|_| "Browser root process could not be reaped".to_owned());
            #[cfg(all(test, unix))]
            let outcome = cleanup_probe_result(&probe, CleanupPhase::Reap, outcome).await;
            outcome
        }));
    }
    async fn close(&mut self) -> Result<(), String> {
        self.retiring = true;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1800);
        if !self.cleanup.advisory_attempted {
            self.cleanup.advisory_attempted = true;
            if let Some(cdp) = &self.cdp {
                let _ = tokio::time::timeout(
                    Duration::from_millis(500),
                    cdp.request("Browser.close", json!({}), None),
                )
                .await;
            }
        }
        let Some(tree) = &self.tree else {
            if let Ok(mut child) = self.child.try_lock() {
                let _ = child.start_kill();
            }
            self.start_reap();
            let root = self.cleanup.reap.wait(deadline, "root wait").await;
            return Err(match root {
                Ok(())=>"Browser process containment is unavailable; retained launch cleanup remains unconfirmed".into(),
                Err(error)=>format!("Browser process containment is unavailable; retained launch cleanup remains unconfirmed; {error}"),
            });
        };
        if !self.cleanup.stop.confirmed && self.cleanup.stop.task.is_none() {
            let tree = tree.clone();
            #[cfg(all(test, unix))]
            let probe = self.cleanup_probe.clone();
            self.cleanup.stop.task = Some(tokio::spawn(async move {
                let outcome = tree
                    .stop(Duration::from_millis(250))
                    .await
                    .map_err(|_| "Browser process tree could not be confirmed stopped".to_owned());
                #[cfg(all(test, unix))]
                let outcome = cleanup_probe_result(&probe, CleanupPhase::Tree, outcome).await;
                outcome
            }));
        }
        if let Err(error) = self.cleanup.stop.wait(deadline, "process tree").await {
            // Attempt useful root cleanup after the guarded stop attempt, without spending a new budget.
            if let Ok(mut child) = self.child.try_lock() {
                let _ = child.start_kill();
            }
            self.start_reap();
            let root = self.cleanup.reap.wait(deadline, "root wait").await;
            return Err(match root {
                Ok(()) => error,
                Err(root) => format!("{error}; root cleanup remains unconfirmed: {root}"),
            });
        }
        self.start_reap();
        self.cleanup.reap.wait(deadline, "root wait").await?;
        if let Some(cdp) = self.cdp.as_mut() {
            cdp.actor.abort();
            let _ = tokio::time::timeout_at(deadline, &mut cdp.actor)
                .await
                .map_err(|_| {
                    "Browser protocol cleanup is still pending; original owner retained for retry"
                })?;
        }
        self.cdp = None;
        if !self.cleanup.profile.confirmed && self.cleanup.profile.task.is_none() {
            let profile = self._profile.clone();
            #[cfg(all(test, unix))]
            let probe = self.cleanup_probe.clone();
            self.cleanup.profile.task = Some(tokio::spawn(async move {
                #[cfg(all(test, unix))]
                cleanup_probe_result(&probe, CleanupPhase::Profile, Ok(())).await?;
                tokio::task::spawn_blocking(move || profile.remove_checked())
                    .await
                    .map_err(|_| {
                        "Browser profile cleanup worker stopped; ownership retained".to_owned()
                    })?
            }));
        }
        self.cleanup.profile.wait(deadline, "profile removal").await
    }
}
fn parse_endpoint(value: &str) -> Result<String, String> {
    let mut lines = value.lines();
    let port = lines
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .ok_or("Invalid browser debug port")?;
    let path = lines.next().ok_or("Invalid browser debug path")?;
    if !path.starts_with("/devtools/browser/")
        || path.len() > 128
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_".contains(&b))
        || lines.any(|l| !l.is_empty())
    {
        return Err("Invalid browser debug endpoint".into());
    }
    Ok(format!("ws://127.0.0.1:{port}{path}"))
}
fn valid_tab(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

fn key_parameters(value: &str) -> Result<(Value, Value), String> {
    if value.len() > 80 || !value.is_ascii() {
        return Err("Unsupported browser key".into());
    }
    let mut parts: Vec<_> = value.split('+').collect();
    let base = parts.pop().ok_or("Unsupported browser key")?;
    let mut modifiers = 0u8;
    for part in parts {
        let mask = match part {
            "Alt" => 1,
            "Control" => 2,
            "Meta" => 4,
            "Shift" => 8,
            _ => return Err("Unsupported browser key".into()),
        };
        if modifiers & mask != 0 {
            return Err("Unsupported browser key".into());
        }
        modifiers |= mask;
    }
    let (key, code, virtual_key, mut text) = if base.len() == 1
        && base.as_bytes()[0].is_ascii_alphabetic()
    {
        let letter = base.as_bytes()[0];
        let key = if modifiers & 8 != 0 {
            (letter as char).to_ascii_uppercase()
        } else {
            letter as char
        };
        (
            key.to_string(),
            format!("Key{}", (letter as char).to_ascii_uppercase()),
            letter.to_ascii_uppercase() as u32,
            key.to_string(),
        )
    } else if base.len() == 1 && base.as_bytes()[0].is_ascii_digit() {
        let digit = base.as_bytes()[0];
        let key = if modifiers & 8 != 0 {
            b")!@#$%^&*("[(digit - b'0') as usize] as char
        } else {
            digit as char
        };
        (
            key.to_string(),
            format!("Digit{}", digit as char),
            digit as u32,
            key.to_string(),
        )
    } else {
        let (code, vk, text) = match base {
            "Enter" => ("Enter", 13, "\r"),
            "Tab" => ("Tab", 9, ""),
            "Escape" => ("Escape", 27, ""),
            "Backspace" => ("Backspace", 8, ""),
            "Delete" => ("Delete", 46, ""),
            "Space" => ("Space", 32, " "),
            "ArrowLeft" => ("ArrowLeft", 37, ""),
            "ArrowUp" => ("ArrowUp", 38, ""),
            "ArrowRight" => ("ArrowRight", 39, ""),
            "ArrowDown" => ("ArrowDown", 40, ""),
            "Home" => ("Home", 36, ""),
            "End" => ("End", 35, ""),
            "PageUp" => ("PageUp", 33, ""),
            "PageDown" => ("PageDown", 34, ""),
            _ => {
                let Some(number) = base
                    .strip_prefix('F')
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|number| (1..=12).contains(number) && base == format!("F{number}"))
                else {
                    return Err("Unsupported browser key".into());
                };
                return Ok((
                    json!({"type":"rawKeyDown","key":base,"code":base,"windowsVirtualKeyCode":111+number,"modifiers":modifiers,"text":"","unmodifiedText":""}),
                    json!({"type":"keyUp","key":base,"code":base,"windowsVirtualKeyCode":111+number,"modifiers":modifiers,"text":"","unmodifiedText":""}),
                ));
            }
        };
        (
            if base == "Space" { " " } else { base }.to_string(),
            code.to_string(),
            vk,
            text.to_string(),
        )
    };
    if modifiers & 7 != 0 {
        text.clear();
    }
    let down = json!({"type":if text.is_empty(){"rawKeyDown"}else{"keyDown"},"key":key,"code":code,"windowsVirtualKeyCode":virtual_key,"modifiers":modifiers,"text":text,"unmodifiedText":text});
    let mut up = down.clone();
    up["type"] = json!("keyUp");
    up["text"] = json!("");
    up["unmodifiedText"] = json!("");
    Ok((down, up))
}

pub(crate) fn definitions() -> Vec<Value> {
    let string = || json!({"type":"string"});
    let tab = || json!({"type":"string","description":"Optional tab ID from browser_tabs; defaults to the active V4 tab"});
    let rows=vec![
        ("browser_open","Open a new tab in V4's own disposable browser. A fresh browser process is launched on first use. Only configured origins are allowed. Requires user approval.",json!({"url":string()}),vec![]),
        ("browser_navigate","Navigate a V4 tab to an approved origin. Requires user approval.",json!({"url":string(),"tabId":tab()}),vec!["url"]),
        ("browser_snapshot","Read visible document text and labeled elements with stable refs. Password values are redacted. Requires user approval.",json!({"tabId":tab()}),vec![]),
        ("browser_get_images","List image URLs and alternative text from the current page, including non-visible images. URLs may contain sensitive query values. Does not fetch images. Requires user approval.",json!({"tabId":tab()}),vec![]),
        ("browser_console","Read recent console messages and uncaught errors from the reviewed page document (bounded, secrets heuristically redacted, read-only). Message text is untrusted page content. Isolated V4 browser only. Requires user approval.",json!({"level":string(),"limit":{"type":"integer"},"tabId":tab()}),vec![]),
        ("browser_dialog","Arm a one-time decision for the next JavaScript dialog (alert/confirm/prompt/beforeunload) opened by the reviewed page: action accept or dismiss, optional promptText when accepting. Dialogs are otherwise dismissed automatically and cannot be reversed. Expires after 60 seconds. Isolated V4 browser only. Requires user approval of the exact decision.",json!({"action":string(),"promptText":string(),"tabId":tab()}),vec!["action"]),
        ("browser_click","Click an element ref from the latest document snapshot. Stale or hidden refs are rejected. Requires user approval.",json!({"ref":string(),"tabId":tab()}),vec!["ref"]),
        ("browser_type","Type text into an editable element ref, replacing its existing value unless clear=false. Does not submit automatically. Requires user approval.",json!({"ref":string(),"text":string(),"clear":{"type":"boolean"},"tabId":tab()}),vec!["ref","text"]),
        ("browser_select","Select one option by value in a select element ref. Requires user approval.",json!({"ref":string(),"value":string(),"tabId":tab()}),vec!["ref","value"]),
        ("browser_scroll","Scroll the page or an element ref using pixel deltas (maximum 10000 per axis). Requires user approval.",json!({"ref":string(),"deltaX":{"type":"integer"},"deltaY":{"type":"integer"},"tabId":tab()}),vec!["deltaY"]),
        ("browser_wait","Wait for visible text or an element ref (optionally hidden=true), or for document readiness. Maximum 60 seconds. Requires user approval.",json!({"ref":string(),"text":string(),"hidden":{"type":"boolean"},"timeoutMs":{"type":"integer"},"tabId":tab()}),vec![]),
        ("browser_back","Navigate one entry back in the V4 tab history. Requires user approval.",json!({"tabId":tab()}),vec![]),
        ("browser_forward","Navigate one entry forward in the V4 tab history. Requires user approval.",json!({"tabId":tab()}),vec![]),
        ("browser_screenshot","Capture only the active V4 browser tab viewport as a PNG image. Requires user approval.",json!({"tabId":tab()}),vec![]),
        ("browser_evaluate","Evaluate JavaScript in a V4 tab. May mutate the page or access services on approved origins; requires user approval of the exact script.",json!({"script":string(),"tabId":tab()}),vec!["script"]),
        ("browser_tabs","List V4-owned tabs or switch active tab with tabId. Never accesses the user's browser. Requires user approval.",json!({"tabId":tab()}),vec![]),
        ("browser_close","Close one V4 tab using tabId, or close the V4 browser process and delete its private profile. Requires user approval.",json!({"tabId":tab()}),vec![]),
    ];
    rows.into_iter().map(|(name,description,properties,required)|json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
pub(crate) fn is_document_tool(name: &str) -> bool {
    matches!(
        name,
        "browser_get_images"
            | "browser_snapshot"
            | "browser_select"
            | "browser_wait"
            | "browser_evaluate"
            | "browser_console"
            | "browser_dialog"
    )
}
pub(crate) fn isolated_only(name: &str) -> bool {
    matches!(name, "browser_console" | "browser_dialog")
}
pub(crate) fn handles(name: &str) -> bool {
    definitions().iter().any(|row| row["name"] == name) || cfg!(test) && name == "browser_press"
}
fn text<'a>(input: &'a Value, name: &str, max: usize) -> Result<&'a str, String> {
    input[name]
        .as_str()
        .filter(|value| value.len() <= max && !value.contains('\0'))
        .ok_or_else(|| format!("Invalid browser argument: {name}"))
}
fn reference(input: &Value) -> Result<&str, String> {
    let value = text(input, "ref", 64)?;
    if !value.starts_with('e')
        || value.len() < 35
        || !value.is_ascii()
        || !value[1..33].bytes().all(|b| b.is_ascii_hexdigit())
        || value.as_bytes().get(33) != Some(&b'_')
        || !value[34..].bytes().all(|b| b.is_ascii_digit())
    {
        return Err("Invalid browser element ref".into());
    }
    Ok(value)
}
fn ref_expression(input: &Value) -> Result<String, String> {
    Ok(format!("(()=>{{const e=globalThis.__v4refs?.byRef.get({});if(!e?.isConnected)throw Error('Stale element ref; take another snapshot');return e;}})()",serde_json::to_string(reference(input)?).unwrap()))
}
pub(crate) fn validate_arguments(name: &str, input: &Value) -> Result<(), String> {
    let schema = definitions()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .or_else(|| (cfg!(test) && name == "browser_press").then(|| json!({"name":"browser_press","parameters":{"type":"object","properties":{"ref":{"type":"string"},"key":{"type":"string"},"tabId":{"type":"string"}},"required":["ref","key"],"additionalProperties":false}})))
        .ok_or("Unknown browser tool")?;
    let object = input
        .as_object()
        .ok_or("Browser arguments must be an object")?;
    if serde_json::to_vec(input)
        .map_err(|_| "Invalid browser arguments")?
        .len()
        > MAX_ARGUMENTS
        || object
            .keys()
            .any(|key| schema["parameters"]["properties"].get(key).is_none())
    {
        return Err("Unexpected browser arguments or argument limit exceeded".into());
    }
    for key in schema["parameters"]["required"].as_array().unwrap() {
        if !object.contains_key(key.as_str().unwrap()) {
            return Err(format!(
                "Missing browser argument: {}",
                key.as_str().unwrap()
            ));
        }
    }
    for (key, value) in object {
        let kind = schema["parameters"]["properties"][key]["type"]
            .as_str()
            .unwrap();
        let valid = match kind {
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some(),
            "boolean" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid browser argument type: {key}"));
        }
    }
    if name == "browser_dialog" {
        let action = text(input, "action", 16)?;
        if !matches!(action, "accept" | "dismiss") {
            return Err("Dialog action must be accept or dismiss".into());
        }
        if input.get("promptText").is_some() {
            if action != "accept" {
                return Err("promptText is only valid when accepting".into());
            }
            text(input, "promptText", 1000)?;
        }
    }
    if name == "browser_console" {
        if let Some(level) = input.get("level") {
            if !matches!(
                level.as_str(),
                Some("all" | "error" | "warning" | "info" | "log" | "debug")
            ) {
                return Err("Console level must be all, error, warning, info, log or debug".into());
            }
        }
        if let Some(limit) = input.get("limit") {
            if !limit
                .as_u64()
                .is_some_and(|limit| (1..=MAX_CONSOLE_RETURN).contains(&limit))
            {
                return Err("Console limit must be 1-100".into());
            }
        }
    }
    if name == "browser_press" {
        reference(input)?;
        key_parameters(text(input, "key", 80)?)?;
    }
    Ok(())
}
// This prototype must not be registered: CDP key events target the focused page,
// not an element. Focus can change after a check or during keydown.
#[cfg(test)]
#[derive(Default)]
struct KeyState {
    pressed: bool,
    lease: Option<Arc<std::fs::File>>,
}
#[cfg(test)]
struct KeySupervisor {
    requests: mpsc::Sender<Request>,
    #[cfg(test)]
    gate: Arc<tokio::sync::Mutex<KeyState>>,
    timeout: Duration,
}
#[cfg(test)]
struct KeyCaller {
    alive: Arc<Mutex<bool>>,
    stopped: Arc<Notify>,
}
#[cfg(test)]
impl Drop for KeyCaller {
    fn drop(&mut self) {
        if let Ok(mut alive) = self.alive.lock() {
            *alive = false;
        }
        self.stopped.notify_one();
    }
}
#[cfg(test)]
impl KeySupervisor {
    #[cfg(test)]
    fn new(requests: mpsc::Sender<Request>, timeout: Duration) -> Self {
        Self {
            requests,
            gate: Arc::new(tokio::sync::Mutex::new(KeyState::default())),
            timeout,
        }
    }
    #[cfg(test)]
    async fn press(
        &self,
        session: &str,
        down: Value,
        up: Value,
        cancel: crate::v4_agent::interaction::Cancellation,
    ) -> Result<(), String> {
        let gate = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("Keyboard action cancelled before admission".into()),
            gate = self.gate.clone().lock_owned() => gate,
        };
        if gate.pressed {
            return Err(
                "Keyboard release is unconfirmed; close the browser before further input".into(),
            );
        }
        self.press_locked(gate, session, down, up, cancel, None)
            .await
    }

    async fn press_locked(
        &self,
        mut gate: tokio::sync::OwnedMutexGuard<KeyState>,
        session: &str,
        down: Value,
        up: Value,
        cancel: crate::v4_agent::interaction::Cancellation,
        lease: Option<Arc<std::fs::File>>,
    ) -> Result<(), String> {
        if gate.pressed {
            return Err(
                "Keyboard release is unconfirmed; close the browser before further input".into(),
            );
        }
        let alive = Arc::new(Mutex::new(true));
        let stopped = Arc::new(Notify::new());
        let _caller = KeyCaller {
            alive: alive.clone(),
            stopped: stopped.clone(),
        };
        let requests = self.requests.clone();
        let session = session.to_owned();
        let timeout = self.timeout;
        let action = tokio::spawn(async move {
            let (response, mut down_result) = oneshot::channel();
            cancel.admit(|| {
                let live = alive
                    .try_lock()
                    .map_err(|_| "Keyboard admission unavailable")?;
                if !*live {
                    return Err("Keyboard action caller stopped".into());
                }
                requests
                    .try_send(Request {
                        method: "Input.dispatchKeyEvent".into(),
                        params: down,
                        session: Some(session.clone()),
                        response,
                        lease: lease.clone(),
                    })
                    .map_err(|_| "Keyboard admission unavailable")?;
                gate.pressed = true;
                gate.lease = lease.clone();
                Ok(())
            })?;
            let mut down_replied = false;
            let mut down_closed = false;
            let outcome = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err("Keyboard action cancelled after admission".to_string()),
                _ = stopped.notified() => Err("Keyboard action caller stopped after admission".to_string()),
                result = tokio::time::timeout(timeout, &mut down_result) => match result {
                    Ok(Ok(result)) => { down_replied = true; result.map(|_| ()) },
                    Ok(Err(_)) => { down_closed = true; Err("Keyboard action outcome is unconfirmed; inspect the page before retrying".into()) },
                    Err(_) => Err("Keyboard action outcome is unconfirmed; inspect the page before retrying".into()),
                },
            };
            let (response, released) = oneshot::channel();
            let release = Request {
                method: "Input.dispatchKeyEvent".into(),
                params: up,
                session: Some(session),
                response,
                lease: lease.clone(),
            };
            if !matches!(
                tokio::time::timeout(timeout, requests.send(release)).await,
                Ok(Ok(()))
            ) || !matches!(tokio::time::timeout(timeout, released).await, Ok(Ok(Ok(_))))
            {
                return Err(
                    "Keyboard release is unconfirmed; close the browser before further input"
                        .into(),
                );
            }
            if !down_replied
                && (down_closed
                    || !matches!(tokio::time::timeout(timeout, down_result).await, Ok(Ok(_))))
            {
                return Err("Keyboard action outcome is unconfirmed; close the browser before further input".into());
            }
            gate.pressed = false;
            gate.lease = None;
            outcome
        });
        action.await.map_err(|_| {
            "Keyboard action stopped; close the browser before further input".to_string()
        })?
    }
}

#[derive(Default)]
struct MouseState {
    pressed: bool,
    lease: Option<Arc<std::fs::File>>,
}
struct MouseCaller {
    alive: Arc<Mutex<bool>>,
    stopped: Arc<Notify>,
}
impl Drop for MouseCaller {
    fn drop(&mut self) {
        if let Ok(mut alive) = self.alive.lock() {
            *alive = false;
        }
        self.stopped.notify_one();
    }
}
async fn supervised_mouse_click(
    requests: mpsc::Sender<Request>,
    mut gate: tokio::sync::OwnedMutexGuard<MouseState>,
    session: &str,
    x: f64,
    y: f64,
    timeout: Duration,
    cancel: crate::v4_agent::interaction::Cancellation,
    lease: Option<Arc<std::fs::File>>,
) -> Result<(), String> {
    let alive = Arc::new(Mutex::new(true));
    let stopped = Arc::new(Notify::new());
    let _caller = MouseCaller {
        alive: alive.clone(),
        stopped: stopped.clone(),
    };
    let session = session.to_owned();
    let action = tokio::spawn(async move {
        let (response, mut down_result) = oneshot::channel();
        cancel.admit(|| {
            let live = alive
                .try_lock()
                .map_err(|_| "Mouse admission unavailable")?;
            if !*live {
                return Err("Mouse action caller stopped".into());
            }
            requests.try_send(Request {
                method: "Input.dispatchMouseEvent".into(),
                params: json!({"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1}),
                session: Some(session.clone()), response, lease: lease.clone(),
            }).map_err(|_| "Mouse admission unavailable")?;
            gate.pressed = true;
            gate.lease = lease.clone();
            Ok(())
        })?;
        let mut down_replied = false;
        let mut down_closed = false;
        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Mouse action cancelled after admission".to_owned()),
            _ = stopped.notified() => Err("Mouse action caller stopped after admission".to_owned()),
            result = tokio::time::timeout(timeout, &mut down_result) => match result {
                Ok(Ok(result)) => { down_replied = true; result.map(|_| ()) },
                Ok(Err(_)) => { down_closed = true; Err("Mouse press outcome is unconfirmed; inspect the page before retrying".into()) },
                Err(_) => Err("Mouse press outcome is unconfirmed; inspect the page before retrying".into()),
            },
        };
        let (response, release_result) = oneshot::channel();
        let release = Request {
            method: "Input.dispatchMouseEvent".into(),
            params: json!({"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1}),
            session: Some(session),
            response,
            lease: lease.clone(),
        };
        if !matches!(
            tokio::time::timeout(timeout, requests.send(release)).await,
            Ok(Ok(()))
        ) || !matches!(
            tokio::time::timeout(timeout, release_result).await,
            Ok(Ok(Ok(_)))
        ) {
            return Err(
                "Mouse release is unconfirmed; close the browser before further actions".into(),
            );
        }
        if !down_replied
            && (down_closed
                || !matches!(tokio::time::timeout(timeout, down_result).await, Ok(Ok(_))))
        {
            return Err(
                "Mouse press outcome is unconfirmed; close the browser before further actions"
                    .into(),
            );
        }
        gate.pressed = false;
        gate.lease = None;
        outcome
    });
    action
        .await
        .map_err(|_| "Mouse action stopped; close the browser before further actions".to_owned())?
}

pub(super) struct IsolatedDocumentReview {
    browser: uuid::Uuid,
    session: String,
    context: u64,
    marker: String,
    main_context: Option<String>,
    pub(super) tab: String,
    pub(super) origin: String,
}

async fn reviewed_main_context(
    cdp: &Cdp,
    tab: &str,
    session: &str,
    frame: &str,
    isolated_context: u64,
    marker: &str,
    origin: &str,
) -> Result<String, String> {
    let main = cdp
        .targets
        .lock()
        .map_err(|_| "Browser state unavailable")?
        .get(tab)
        .filter(|attached| attached.session == session)
        .and_then(|attached| attached.main_contexts.get(frame))
        .cloned()
        .ok_or(
            "The browser page's main execution context is unavailable; request fresh approval",
        )?;
    let group = format!("v4-review-{}", uuid::Uuid::new_v4());
    let result = async {
        let marker = serde_json::to_string(marker).map_err(|_| "Invalid browser review")?;
        let origin = serde_json::to_string(origin).map_err(|_| "Invalid browser review")?;
        let isolated = cdp.request("Runtime.evaluate", json!({"expression":format!("globalThis.__v4DocumentReviews?.includes({marker}) && location.origin === {origin} ? document : null"),"contextId":isolated_context,"objectGroup":group}), Some(session)).await?;
        let main_document = cdp.request("Runtime.evaluate", json!({"expression":"document","uniqueContextId":main.unique_id,"objectGroup":group}), Some(session)).await?;
        let mut nodes = Vec::new();
        for result in [&isolated, &main_document] {
            let object = result["result"]["objectId"].as_str().filter(|_| result.get("exceptionDetails").is_none()).ok_or("The reviewed browser document changed; request fresh approval")?;
            let node = cdp.request("DOM.describeNode", json!({"objectId":object}), Some(session)).await?;
            nodes.push(node["node"]["backendNodeId"].as_u64().ok_or("The reviewed browser document is unavailable")?);
        }
        if nodes[0] != nodes[1] { return Err("The reviewed browser document changed; request fresh approval".into()); }
        Ok(main.unique_id.clone())
    }.await;
    let _ = cdp
        .request(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup":group}),
            Some(session),
        )
        .await;
    result
}

pub(crate) struct BrowserClient {
    config: BrowserConfig,
    data: PathBuf,
    owner: String,
    workspace: PathBuf,
    browser: Option<OwnedBrowser>,
    mouse_gate: Arc<tokio::sync::Mutex<MouseState>>,
    #[cfg(test)]
    key_gate: Arc<tokio::sync::Mutex<KeyState>>,
    #[cfg(all(test, unix))]
    cleanup_probe: Option<CleanupProbe>,
}
impl BrowserClient {
    pub(crate) fn new(
        data: &Path,
        owner: &str,
        workspace: &Path,
        config: BrowserConfig,
    ) -> Result<Self, String> {
        let config = config.normalized()?;
        check_owner(owner)?;
        let workspace = workspace
            .canonicalize()
            .map_err(|_| "Browser workspace is unavailable")?;
        if !workspace.is_dir() {
            return Err("Browser workspace must be a directory".into());
        }
        Ok(Self {
            config,
            data: data.into(),
            owner: owner.into(),
            workspace,
            browser: None,
            mouse_gate: Arc::new(tokio::sync::Mutex::new(MouseState::default())),
            #[cfg(test)]
            key_gate: Arc::new(tokio::sync::Mutex::new(KeyState::default())),
            #[cfg(all(test, unix))]
            cleanup_probe: None,
        })
    }
    pub(super) fn is_retiring(&self) -> bool {
        self.browser
            .as_ref()
            .is_some_and(|browser| browser.retiring || !browser.ready)
    }
    pub(super) fn matches_scope(&self, data: &Path, owner: &str, workspace: &Path) -> bool {
        self.data == data
            && self.owner == owner
            && workspace
                .canonicalize()
                .is_ok_and(|path| path == self.workspace)
    }
    async fn review_document(
        &self,
        name: &str,
        input: &Value,
    ) -> Result<IsolatedDocumentReview, String> {
        let gate = self.mouse_gate.lock().await;
        if gate.pressed {
            return Err(
                "Mouse release is unconfirmed; close the browser before further actions".into(),
            );
        }
        #[cfg(test)]
        let _key = {
            let key = self.key_gate.lock().await;
            if key.pressed {
                return Err(
                    "Keyboard release is unconfirmed; close the browser before further input"
                        .into(),
                );
            }
            key
        };
        validate_arguments(name, input)?;
        if !self.config.enabled || self.is_retiring() {
            return Err("Browser is unavailable for document review".into());
        }
        let browser = self
            .browser
            .as_ref()
            .ok_or("Open the V4 browser before requesting document review")?;
        let tab = input
            .get("tabId")
            .and_then(Value::as_str)
            .or(browser.active.as_deref())
            .ok_or("No browser tab is open")?
            .to_owned();
        if !browser.tabs().await?.iter().any(|row| row["id"] == tab) {
            return Err("Browser tab is no longer available".into());
        }
        let cdp = browser.cdp()?;
        let session = cdp.session(&tab).await?;
        let tree = cdp
            .request("Page.getFrameTree", json!({}), Some(&session))
            .await?;
        let frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or("Browser document is unavailable")?;
        let world = cdp
            .request(
                "Page.createIsolatedWorld",
                json!({"frameId":frame,"worldName":WORLD}),
                Some(&session),
            )
            .await?;
        let context = world["executionContextId"]
            .as_u64()
            .ok_or("Browser document is unavailable")?;
        let marker = uuid::Uuid::new_v4().to_string();
        let expression = format!(
            "(()=>{{const reviews=globalThis.__v4DocumentReviews??=[];reviews.push({});if(reviews.length>128)reviews.shift();return location.href;}})()",
            serde_json::to_string(&marker).map_err(|_| "Cannot prepare browser review")?
        );
        let result = cdp.request("Runtime.evaluate", json!({"expression":expression,"contextId":context,"returnByValue":true,"timeout":5000}), Some(&session)).await?;
        if result.get("exceptionDetails").is_some() {
            return Err("Browser document changed; request a fresh approval".into());
        }
        let url = result["result"]["value"]
            .as_str()
            .ok_or("Browser document is unavailable")?;
        if !self.config.permits(url) {
            return Err("The selected page is outside the agent allowed origins".into());
        }
        let origin = if url == "about:blank" {
            "null".to_owned()
        } else {
            url::Url::parse(url)
                .map_err(|_| "Browser page URL is unavailable")?
                .origin()
                .ascii_serialization()
        };
        let main_context = if matches!(name, "browser_evaluate" | "browser_console") {
            Some(
                reviewed_main_context(cdp, &tab, &session, frame, context, &marker, &origin)
                    .await?,
            )
        } else {
            None
        };
        Ok(IsolatedDocumentReview {
            browser: browser.identity,
            session,
            context,
            marker,
            main_context,
            tab,
            origin,
        })
    }
    #[cfg(test)]
    async fn review_images(&self, input: &Value) -> Result<IsolatedDocumentReview, String> {
        self.review_document("browser_get_images", input).await
    }
    pub(super) async fn review_document_with_settings_lease(
        &self,
        name: &str,
        input: &Value,
        lease: Arc<std::fs::File>,
    ) -> Result<IsolatedDocumentReview, String> {
        ACTION_SETTINGS_LEASE
            .scope(lease, self.review_document(name, input))
            .await
    }
    pub(super) async fn execute_reviewed_document(
        &mut self,
        name: &str,
        input: &Value,
        review: &IsolatedDocumentReview,
        lease: Arc<std::fs::File>,
    ) -> Result<Value, String> {
        let result = {
            let gate = self.mouse_gate.lock().await;
            if gate.pressed {
                return Err(
                    "Mouse release is unconfirmed; close the browser before further actions".into(),
                );
            }
            #[cfg(test)]
            let _key = {
                let key = self.key_gate.lock().await;
                if key.pressed {
                    return Err(
                        "Keyboard release is unconfirmed; close the browser before further input"
                            .into(),
                    );
                }
                key
            };
            self.execute_reviewed_document_inner(name, input, review, lease)
                .await
        };
        if result.is_err()
            && self.browser.as_ref().is_some_and(|browser| {
                !browser.retiring
                    && browser
                        .cdp
                        .as_ref()
                        .is_some_and(|cdp| cdp.failed.load(Ordering::Acquire))
            })
        {
            if let Err(cleanup) = self.close().await {
                return Err(format!(
                    "{}; browser cleanup is unconfirmed: {cleanup}",
                    result.unwrap_err()
                ));
            }
        }
        result
    }
    async fn execute_reviewed_document_inner(
        &self,
        name: &str,
        input: &Value,
        review: &IsolatedDocumentReview,
        lease: Arc<std::fs::File>,
    ) -> Result<Value, String> {
        validate_arguments(name, input)?;
        if name == "browser_evaluate" {
            let script = text(input, "script", 32_768)?;
            if script.trim().is_empty() {
                return Err("Browser script must not be empty".into());
            }
            let browser = self
                .browser
                .as_ref()
                .filter(|browser| {
                    browser.identity == review.browser && browser.ready && !browser.retiring
                })
                .ok_or("The reviewed browser session changed; request fresh approval")?;
            let context = review
                .main_context
                .as_deref()
                .ok_or("A reviewed browser main context is required")?;
            let result = browser.cdp()?.request_guarded("Runtime.evaluate", json!({"expression":script,"uniqueContextId":context,"returnByValue":true,"awaitPromise":true,"userGesture":true,"timeout":5000}), Some(&review.session), Some(lease)).await
                .map_err(|_| "The reviewed browser document changed or is unavailable; request fresh approval")?;
            if result.get("exceptionDetails").is_some() {
                let detail = result["exceptionDetails"]["exception"]["description"]
                    .as_str()
                    .or_else(|| result["exceptionDetails"]["text"].as_str())
                    .unwrap_or("unknown exception");
                return Err(format!(
                    "Browser script failed: {}",
                    detail.chars().take(500).collect::<String>()
                ));
            }
            let value = result["result"]
                .get("value")
                .cloned()
                .unwrap_or(Value::Null);
            if serde_json::to_vec(&value)
                .map_err(|_| "Cannot encode browser result")?
                .len()
                > 65_536
            {
                return Err("Browser script result exceeds 64 KB".into());
            }
            return Ok(value);
        }
        if matches!(name, "browser_console" | "browser_dialog") {
            self.evaluate_reviewed_document(review, "true", lease)
                .await?;
            return self.observe_reviewed_document(name, input, review);
        }
        let script = match name {
            "browser_get_images" => IMAGE_INVENTORY.to_owned(),
            "browser_snapshot" => {
                SNAPSHOT.replace("$V4_REF_PREFIX", &uuid::Uuid::new_v4().simple().to_string())
            }
            "browser_select" => {
                let element = ref_expression(input)?;
                let value = serde_json::to_string(text(input, "value", 10_000)?)
                    .map_err(|_| "Invalid browser value")?;
                format!("(()=>{{const e={element};if(!(e instanceof HTMLSelectElement)||e.matches(':disabled')||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden')throw Error('Ref is not a visible enabled select');const value={value};if(!Array.from(e.options).some(o=>o.value===value&&!o.disabled&&!o.closest('optgroup')?.disabled))throw Error('Option is unavailable');e.value=value;e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));return {{selected:e.value}};}})()")
            }
            "browser_wait" => {
                if input.get("ref").is_some() && input.get("text").is_some() {
                    return Err("Wait for either ref or text, not both".into());
                }
                let timeout = input
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.config.timeout_seconds * 1000);
                if !(1..=60_000).contains(&timeout) {
                    return Err("Browser wait timeout must be 1-60000 ms".into());
                }
                let hidden = input
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let condition = if input.get("ref").is_some() {
                    let element = ref_expression(input)?;
                    format!("(()=>{{try{{const e={element};return !!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');}}catch{{return false;}}}})()")
                } else if input.get("text").is_some() {
                    format!(
                        "(document.body?.innerText||'').includes({})",
                        serde_json::to_string(text(input, "text", 2000)?)
                            .map_err(|_| "Invalid browser text")?
                    )
                } else {
                    "document.readyState !== 'loading'".into()
                };
                return tokio::time::timeout(Duration::from_millis(timeout), async {
                    loop {
                        if self
                            .evaluate_reviewed_document(review, &condition, lease.clone())
                            .await?
                            == json!(!hidden)
                        {
                            return Ok(json!({"matched":true}));
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                })
                .await
                .map_err(|_| "Browser condition wait timed out".to_owned())?;
            }
            _ => return Err("Unsupported reviewed document action".into()),
        };
        self.evaluate_reviewed_document(review, &script, lease)
            .await
    }
    fn observe_reviewed_document(
        &self,
        name: &str,
        input: &Value,
        review: &IsolatedDocumentReview,
    ) -> Result<Value, String> {
        let browser = self
            .browser
            .as_ref()
            .filter(|browser| {
                browser.identity == review.browser && browser.ready && !browser.retiring
            })
            .ok_or("The reviewed browser session changed; request fresh approval")?;
        let mut targets = browser
            .cdp()?
            .targets
            .lock()
            .map_err(|_| "Browser state unavailable")?;
        let attached = targets
            .get_mut(&review.tab)
            .filter(|attached| attached.session == review.session)
            .ok_or("The reviewed browser tab changed; request fresh approval")?;
        if name == "browser_dialog" {
            let accept = text(input, "action", 16)? == "accept";
            attached.dialog_policy = Some(DialogPolicy {
                accept,
                prompt: input
                    .get("promptText")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                origin: review.origin.clone(),
                expires: tokio::time::Instant::now() + DIALOG_POLICY_TTL,
            });
            return Ok(
                json!({"armed":true,"action":if accept{"accept"}else{"dismiss"},"expiresInSeconds":DIALOG_POLICY_TTL.as_secs(),"note":"Applies once to the next JavaScript dialog from this reviewed page origin; a dialog already shown was dismissed automatically."}),
            );
        }
        let main = review
            .main_context
            .as_deref()
            .and_then(|unique| {
                attached
                    .main_contexts
                    .values()
                    .find(|context| context.unique_id == unique)
            })
            .map(|context| context.id)
            .ok_or("The reviewed browser document changed; request fresh approval")?;
        let level = input.get("level").and_then(Value::as_str).unwrap_or("all");
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .min(MAX_CONSOLE_RETURN) as usize;
        let matching: Vec<_> = attached
            .console
            .iter()
            .filter(|entry| entry.context == main && (level == "all" || entry.level == level))
            .collect();
        let skipped = matching.len().saturating_sub(limit);
        let messages: Vec<Value> = matching
            .into_iter()
            .skip(skipped)
            .map(|entry| json!({"level":entry.level,"text":redact_console(&entry.text)}))
            .collect();
        let dialogs: Vec<Value> = attached
            .dialogs
            .iter()
            .filter(|dialog| dialog.origin == review.origin)
            .map(|dialog| json!({"type":dialog.kind,"message":redact_console(&clip(&dialog.message, 300)),"accepted":dialog.accepted}))
            .collect();
        Ok(
            json!({"messages":messages,"olderOmitted":skipped,"dialogs":dialogs,"note":"Console text is untrusted page content; secret-looking values are redacted heuristically."}),
        )
    }
    async fn evaluate_reviewed_document(
        &self,
        review: &IsolatedDocumentReview,
        script: &str,
        lease: Arc<std::fs::File>,
    ) -> Result<Value, String> {
        let browser = self
            .browser
            .as_ref()
            .filter(|browser| {
                browser.identity == review.browser && browser.ready && !browser.retiring
            })
            .ok_or("The reviewed browser session changed; request fresh approval")?;
        let marker = serde_json::to_string(&review.marker).map_err(|_| "Invalid browser review")?;
        let origin = serde_json::to_string(&review.origin).map_err(|_| "Invalid browser review")?;
        let expression = format!("(()=>{{if(!globalThis.__v4DocumentReviews?.includes({marker})||location.origin!=={origin})throw Error('__v4_reviewed_document_changed__');return {script};}})()");
        let result = browser.cdp()?.request_guarded("Runtime.evaluate", json!({"expression":expression,"contextId":review.context,"returnByValue":true,"timeout":5000}), Some(&review.session), Some(lease)).await
            .map_err(|_| "The reviewed browser document changed or is unavailable; request fresh approval")?;
        if result.get("exceptionDetails").is_some() {
            let detail = result["exceptionDetails"]["exception"]["description"]
                .as_str()
                .or_else(|| result["exceptionDetails"]["text"].as_str())
                .unwrap_or("unknown exception");
            if detail.contains("__v4_reviewed_document_changed__") {
                return Err("The reviewed browser document changed or is unavailable; request fresh approval".into());
            }
            return Err(format!(
                "Browser script failed: {}",
                detail.chars().take(500).collect::<String>()
            ));
        }
        result["result"]
            .get("value")
            .cloned()
            .ok_or_else(|| "Browser document result is unavailable".into())
    }
    #[cfg(test)]
    async fn execute_review_for_test(
        &mut self,
        name: &str,
        input: &Value,
        review: &IsolatedDocumentReview,
    ) -> Result<Value, String> {
        let lease = Arc::new(browser_settings_lease(&self.data, &self.owner)?);
        self.execute_reviewed_document(name, input, review, lease)
            .await
    }
    #[cfg(test)]
    async fn read_reviewed_images_for_test(
        &mut self,
        review: &IsolatedDocumentReview,
    ) -> Result<Value, String> {
        let lease = Arc::new(browser_settings_lease(&self.data, &self.owner)?);
        self.execute_reviewed_document("browser_get_images", &json!({}), review, lease)
            .await
    }
    pub(crate) async fn close(&mut self) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1800);
        if let Some(browser) = self.browser.as_mut() {
            browser.close().await?;
        }
        let mut mouse = tokio::time::timeout_at(deadline, self.mouse_gate.lock())
            .await
            .map_err(|_| {
                "Mouse cleanup is still pending; original browser owner retained for retry"
            })?;
        mouse.pressed = false;
        mouse.lease = None;
        drop(mouse);
        #[cfg(test)]
        {
            let mut key = tokio::time::timeout_at(deadline, self.key_gate.lock())
                .await
                .map_err(|_| {
                    "Keyboard cleanup is still pending; original browser owner retained for retry"
                })?;
            key.pressed = false;
            key.lease = None;
        }
        self.browser = None;
        Ok(())
    }
    #[cfg(test)]
    fn enabled(&self) -> bool {
        self.config.enabled
    }
    #[cfg(test)]
    pub(crate) async fn dispatch(
        &mut self,
        name: &str,
        input: &Value,
        approved: bool,
    ) -> Result<Value, String> {
        if matches!(
            name,
            "browser_snapshot" | "browser_select" | "browser_wait" | "browser_evaluate"
        ) && approved
        {
            let target = self.review_document(name, input).await?;
            let lease = Arc::new(browser_settings_lease(&self.data, &self.owner)?);
            return self
                .execute_reviewed_document(name, input, &target, lease)
                .await;
        }
        self.dispatch_cancellable(
            name,
            input,
            approved,
            &crate::v4_agent::interaction::Cancellation::default(),
        )
        .await
    }
    async fn dispatch_cancellable(
        &mut self,
        name: &str,
        input: &Value,
        approved: bool,
        cancellation: &crate::v4_agent::interaction::Cancellation,
    ) -> Result<Value, String> {
        let mouse_guard = if name == "browser_close" && input.get("tabId").is_none() {
            None
        } else {
            let guard = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err("Browser action cancelled before admission".into()),
                guard = self.mouse_gate.clone().lock_owned() => guard,
            };
            if guard.pressed {
                return Err(
                    "Mouse release is unconfirmed; close the browser before further actions".into(),
                );
            }
            Some(guard)
        };
        #[cfg(test)]
        let gate = if name == "browser_close" && input.get("tabId").is_none() {
            None
        } else {
            let guard = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err("Browser action cancelled before admission".into()),
                guard = self.key_gate.clone().lock_owned() => guard,
            };
            if guard.pressed {
                return Err(
                    "Keyboard release is unconfirmed; close the browser before further input"
                        .into(),
                );
            }
            Some(guard)
        };
        #[cfg(not(test))]
        let gate = None;
        let result = self
            .dispatch_inner(name, input, approved, gate, mouse_guard, cancellation)
            .await;
        if result.is_err()
            && self.browser.as_ref().is_some_and(|browser| {
                !browser.retiring
                    && browser
                        .cdp
                        .as_ref()
                        .is_some_and(|cdp| cdp.failed.load(Ordering::Acquire))
            })
        {
            if let Err(cleanup) = self.close().await {
                return Err(format!(
                    "{}; browser cleanup is unconfirmed: {cleanup}",
                    result.unwrap_err()
                ));
            }
        }
        result
    }
    pub(super) async fn dispatch_with_settings_lease(
        &mut self,
        name: &str,
        input: &Value,
        approved: bool,
        cancellation: &crate::v4_agent::interaction::Cancellation,
        lease: Arc<std::fs::File>,
    ) -> Result<Value, String> {
        ACTION_SETTINGS_LEASE
            .scope(
                lease,
                self.dispatch_cancellable(name, input, approved, cancellation),
            )
            .await
    }
    async fn dispatch_inner(
        &mut self,
        name: &str,
        input: &Value,
        approved: bool,
        #[cfg(test)] mut key_guard: Option<tokio::sync::OwnedMutexGuard<KeyState>>,
        #[cfg(not(test))] _key_guard: Option<()>,
        mut mouse_guard: Option<tokio::sync::OwnedMutexGuard<MouseState>>,
        cancellation: &crate::v4_agent::interaction::Cancellation,
    ) -> Result<Value, String> {
        #[cfg(not(test))]
        let _ = cancellation;
        validate_arguments(name, input)?;
        if !self.config.enabled {
            return Err("Browser tools are disabled for this account".into());
        }
        if !approved {
            return Err("User approval is required for this exact browser action. Unattended tasks cannot approve browser access.".into());
        }
        if self.is_retiring() && (name != "browser_close" || input.get("tabId").is_some()) {
            return Err(
                "Browser cleanup is pending; retry browser_close without tabId before another action"
                    .into(),
            );
        }
        if is_document_tool(name) {
            return Err("A reviewed browser document is required for this action".into());
        }
        if name == "browser_close" && input.get("tabId").is_none() {
            self.close().await?;
            return Ok(json!({"closed":true,"profileDeleted":true}));
        }
        if name == "browser_tabs" && self.browser.is_none() {
            return Ok(json!({"tabs":[],"running":false}));
        }
        if name == "browser_open" {
            let url = input
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("about:blank");
            if !self.config.permits(url) {
                return Err(
                    "URL origin is not approved in this account's browser configuration".into(),
                );
            }
            if self.browser.is_none() {
                self.browser = Some(OwnedBrowser::spawn(
                    &self.data,
                    &self.owner,
                    &self.workspace,
                    &self.config,
                    #[cfg(all(test, unix))]
                    self.cleanup_probe.clone(),
                )?);
                if let Err(error) = self
                    .browser
                    .as_mut()
                    .unwrap()
                    .finish_launch(&self.config)
                    .await
                {
                    return match self.close().await {
                        Ok(()) => Err(error),
                        Err(cleanup) => Err(format!(
                            "{error}; browser launch cleanup is unconfirmed: {cleanup}"
                        )),
                    };
                }
            }
            let browser = self.browser.as_mut().unwrap();
            if browser.tabs().await?.len() >= MAX_TABS {
                return Err("At most eight V4 browser tabs may be open".into());
            }
            let target = if !browser.has_opened && browser.active.is_some() {
                browser.active.clone().unwrap()
            } else {
                let result = browser
                    .cdp()?
                    .request("Target.createTarget", json!({"url":"about:blank"}), None)
                    .await?;
                result["targetId"]
                    .as_str()
                    .ok_or("Browser tab was not created")?
                    .to_owned()
            };
            let session = browser.cdp()?.session(&target).await?;
            browser.active = Some(target.clone());
            browser.has_opened = true;
            let page = browser.navigate(&session, url).await?;
            return Ok(json!({"tabId":target,"page":page}));
        }
        #[cfg(test)]
        let key_gate = self.key_gate.clone();
        let browser = self
            .browser
            .as_mut()
            .ok_or("Open the V4 browser with browser_open first")?;
        if name == "browser_tabs" {
            if input.get("tabId").is_some() {
                browser.active_session(input).await?;
            }
            return Ok(json!({"tabs":browser.tabs().await?,"running":true}));
        }
        if name == "browser_close" {
            let target = text(input, "tabId", 128)?;
            browser.active_session(input).await?;
            if browser.tabs().await?.len() == 1 {
                drop(mouse_guard.take());
                #[cfg(test)]
                drop(key_guard.take());
                self.close().await?;
                return Ok(
                    json!({"closed":true,"tabId":target,"browserClosed":true,"profileDeleted":true}),
                );
            }
            browser
                .cdp()?
                .request("Target.closeTarget", json!({"targetId":target}), None)
                .await?;
            if browser.active.as_deref() == Some(target) {
                browser.active = browser
                    .tabs()
                    .await?
                    .first()
                    .and_then(|v| v["id"].as_str())
                    .map(str::to_owned);
            }
            return Ok(json!({"closed":true,"tabId":target}));
        }
        let session = browser.active_session(input).await?;
        match name {
            #[cfg(test)]
            "browser_press" => {
                let element = ref_expression(input)?;
                let (down, up) = key_parameters(text(input, "key", 80)?)?;
                cancellation.run(browser.evaluate(&session,&format!("(()=>{{const e={element};if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||e instanceof HTMLInputElement&&e.type==='file')throw Error('Element input is unavailable');e.scrollIntoView({{block:'center'}});e.focus();if(document.activeElement!==e&&e.getRootNode().activeElement!==e)throw Error('Element could not receive focus');return true;}})()"),true)).await?;
                let cdp = browser.cdp()?;
                let supervisor = KeySupervisor {
                    requests: cdp.requests.clone(),
                    #[cfg(test)]
                    gate: key_gate,
                    timeout: cdp.timeout,
                };
                supervisor
                    .press_locked(
                        key_guard.take().ok_or("Keyboard admission unavailable")?,
                        &session,
                        down,
                        up,
                        cancellation.clone(),
                        ACTION_SETTINGS_LEASE.try_with(Arc::clone).ok(),
                    )
                    .await?;
                Ok(json!({"pressed":input["key"]}))
            }
            "browser_navigate" => {
                let url = text(input, "url", 4096)?;
                if !self.config.permits(url) {
                    return Err(
                        "URL origin is not approved in this account's browser configuration".into(),
                    );
                }
                browser.navigate(&session, url).await
            }
            _ if is_document_tool(name) => {
                Err("A reviewed browser document is required for this action".into())
            }
            "browser_screenshot" => {
                let value = browser
                    .cdp()?
                    .request(
                        "Page.captureScreenshot",
                        json!({"format":"png","captureBeyondViewport":false,"fromSurface":true}),
                        Some(&session),
                    )
                    .await?;
                let data = value["data"]
                    .as_str()
                    .filter(|data| data.len() <= MAX_MESSAGE - 1024)
                    .ok_or("Browser screenshot exceeds its limit")?;
                Ok(json!({"mimeType":"image/png","format":"base64","data":data}))
            }
            "browser_click" | "browser_type" | "browser_scroll" => {
                let element = if input.get("ref").is_some() {
                    Some(ref_expression(input)?)
                } else {
                    None
                };
                if name == "browser_type" {
                    let element = element.ok_or("Element ref required")?;
                    let value = text(input, "text", 32_768)?;
                    let clear = input.get("clear").and_then(Value::as_bool).unwrap_or(true);
                    let encoded_value =
                        serde_json::to_string(value).map_err(|_| "Invalid browser text")?;
                    cancellation.run(browser.evaluate(&session,&format!("(()=>{{const e={element};if(e.matches(':disabled')||e.readOnly||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||!(e instanceof HTMLTextAreaElement||e.isContentEditable||e instanceof HTMLInputElement&&['text','search','url','tel','email','password','number'].includes(e.type)))throw Error('Ref is not visible and editable');e.scrollIntoView({{block:'center',inline:'center'}});e.focus();if(document.activeElement!==e&&e.getRootNode().activeElement!==e)throw Error('Element could not receive focus');if({clear}){{if(e.isContentEditable){{const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);}}else e.select();}}return true;}})()"),true)).await?;
                    cancellation.check()?;
                    browser.evaluate(&session,&format!("(()=>{{const e={element};if(e.matches(':disabled')||e.readOnly||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||!(e instanceof HTMLTextAreaElement||e.isContentEditable||e instanceof HTMLInputElement&&['text','search','url','tel','email','password','number'].includes(e.type))||document.activeElement!==e&&e.getRootNode().activeElement!==e)throw Error('Element lost focus or is no longer editable; review before retrying');if(!document.execCommand('insertText',false,{encoded_value}))throw Error('Text insertion failed');return true;}})()"),true).await?;
                    return Ok(json!({"typedCharacters":value.chars().count()}));
                }
                let script = if let Some(element) = element {
                    format!("(()=>{{const e={element};if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true')throw Error('Element is disabled');if(e instanceof HTMLInputElement&&e.type==='file')throw Error('File picker access is not supported by browser_click');e.scrollIntoView({{block:'center',inline:'center'}});const r=e.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden')throw Error('Element is not visible');const x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2)),top=document.elementFromPoint(x,y);if(top!==e&&!e.contains(top)&&!top?.shadowRoot?.contains(e))throw Error('Element is covered by another element');return {{x,y}};}})()")
                } else {
                    "({x:innerWidth/2,y:innerHeight/2})".into()
                };
                let point = browser.evaluate(&session, &script, true).await?;
                let x = point["x"]
                    .as_f64()
                    .ok_or("Element coordinates unavailable")?;
                let y = point["y"]
                    .as_f64()
                    .ok_or("Element coordinates unavailable")?;
                if name == "browser_scroll" {
                    let dy = input["deltaY"]
                        .as_i64()
                        .filter(|v| v.unsigned_abs() <= 10_000)
                        .ok_or("Scroll deltaY must be -10000 to 10000")?;
                    let dx = input.get("deltaX").and_then(Value::as_i64).unwrap_or(0);
                    if dx.unsigned_abs() > 10_000 {
                        return Err("Scroll deltaX must be -10000 to 10000".into());
                    }
                    browser
                        .cdp()?
                        .request(
                            "Input.dispatchMouseEvent",
                            json!({"type":"mouseWheel","x":x,"y":y,"deltaX":dx,"deltaY":dy}),
                            Some(&session),
                        )
                        .await?;
                } else {
                    cancellation
                        .run(browser.cdp()?.request(
                            "Input.dispatchMouseEvent",
                            json!({"type":"mouseMoved","x":x,"y":y}),
                            Some(&session),
                        ))
                        .await?;
                    let cdp = browser.cdp()?;
                    let lease = ACTION_SETTINGS_LEASE.try_with(Arc::clone).ok();
                    supervised_mouse_click(
                        cdp.requests.clone(),
                        mouse_guard.take().ok_or("Mouse admission unavailable")?,
                        &session,
                        x,
                        y,
                        cdp.timeout,
                        cancellation.clone(),
                        lease,
                    )
                    .await?;
                }
                Ok(json!({"ok":true}))
            }
            "browser_back" | "browser_forward" => {
                let history = browser
                    .cdp()?
                    .request("Page.getNavigationHistory", json!({}), Some(&session))
                    .await?;
                let index = history["currentIndex"]
                    .as_i64()
                    .ok_or("Navigation history unavailable")?
                    + if name == "browser_back" { -1 } else { 1 };
                let entry = history["entries"]
                    .as_array()
                    .and_then(|entries| usize::try_from(index).ok().and_then(|i| entries.get(i)))
                    .ok_or("No navigation entry in that direction")?;
                if !self.config.permits(entry["url"].as_str().unwrap_or("")) {
                    return Err("History entry origin is not approved".into());
                }
                browser
                    .cdp()?
                    .request(
                        "Page.navigateToHistoryEntry",
                        json!({"entryId":entry["id"]}),
                        Some(&session),
                    )
                    .await?;
                browser.ready(&session, browser.cdp()?.timeout).await?;
                browser
                    .evaluate(&session, "({url:location.href,title:document.title})", true)
                    .await
            }
            _ => Err("Unknown browser tool".into()),
        }
    }
}
const SNAPSHOT: &str = r#"(()=>{
  const state=globalThis.__v4refs||(globalThis.__v4refs={next:1,prefix:'$V4_REF_PREFIX',byNode:new WeakMap(),byRef:new Map()});
  for(const [ref,node] of state.byRef)if(!node.isConnected)state.byRef.delete(ref);
  const visible=e=>{const s=getComputedStyle(e);return e.getClientRects().length&&s.visibility!=='hidden'&&s.display!=='none'&&e.getAttribute('aria-hidden')!=='true';};
  const clean=(s,n=300)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,n);
  const rows=[];let visited=0,truncated=false;
  const visit=root=>{for(const e of root.children||[]){if(++visited>5000||rows.length>=300){truncated=true;return;}if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))continue;
    if(visible(e)){
      let role=e.getAttribute('role')||({A:'link',BUTTON:'button',INPUT:e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':'textbox',TEXTAREA:'textbox',SELECT:'combobox',IMG:'img',IFRAME:'iframe',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',LI:'listitem',TABLE:'table',TH:'columnheader',TD:'cell'}[e.tagName]);
      if(role||e.tabIndex>=0||e.isContentEditable){let ref=state.byNode.get(e);if(!ref){ref='e'+state.prefix+'_'+state.next++;state.byNode.set(e,ref);}state.byRef.set(ref,e);
        const labelled=e.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ');
        const name=clean(e.getAttribute('aria-label')||labelled||Array.from(e.labels||[]).map(l=>l.textContent).join(' ')||e.alt||e.title||e.placeholder||e.innerText);
        const row={ref,role:role||'generic',tag:e.tagName.toLowerCase(),name,disabled:!!e.disabled};
        if(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement)row.value=e.type==='password'?'[redacted]':clean(e.value,500);
        if(e.type==='checkbox'||e.type==='radio')row.checked=!!e.checked;
        if(e instanceof HTMLSelectElement)row.options=Array.from(e.options).slice(0,100).map(o=>({value:clean(o.value),label:clean(o.label),disabled:o.disabled}));
        if(e.tagName==='IFRAME')row.src=clean(e.src,2048);if(e.tagName==='A')row.href=clean(e.href,2048);if(/^H[1-6]$/.test(e.tagName))row.level=Number(e.tagName[1]);rows.push(row);
      }
      if(e.shadowRoot)visit(e.shadowRoot);visit(e);
    }
  }};
  visit(document.body||document.documentElement);
  const result={url:location.href.slice(0,4096),title:document.title.slice(0,300),text:(document.body?.innerText||'').slice(0,12000),elements:rows,truncated,limits:{elements:300,visited:5000,text:12000},frames:'Frame contents require their own approved tab'};while(new TextEncoder().encode(JSON.stringify(result)).length>60000&&rows.length){rows.pop();result.truncated=true;}return result;
})()"#;

#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug)]
pub(crate) enum CleanupPhase {
    Tree,
    Reap,
    Profile,
}
#[cfg(all(test, unix))]
impl CleanupPhase {
    fn index(self) -> usize {
        match self {
            Self::Tree => 0,
            Self::Reap => 1,
            Self::Profile => 2,
        }
    }
    fn message(self) -> &'static str {
        match self {
            Self::Tree => "synthetic browser tree failure",
            Self::Reap => "synthetic browser reap failure",
            Self::Profile => "synthetic browser profile failure",
        }
    }
}
#[cfg(all(test, unix))]
struct CleanupPendingGate {
    released: Mutex<bool>,
    wake: std::sync::Condvar,
    entered: std::sync::atomic::AtomicUsize,
    finished: std::sync::atomic::AtomicUsize,
    active: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
    changed: tokio::sync::Notify,
}
#[cfg(all(test, unix))]
impl CleanupPendingGate {
    fn release(&self) {
        *self
            .released
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = true;
        self.wake.notify_all();
    }
    fn wait_blocking(&self) {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        self.changed.notify_waiters();
        let mut released = self
            .released
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while !*released {
            released = self
                .wake
                .wait(released)
                .unwrap_or_else(|error| error.into_inner());
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.finished.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
}
#[cfg(all(test, unix))]
pub(crate) struct CleanupPendingControl(Arc<CleanupPendingGate>);
#[cfg(all(test, unix))]
impl Drop for CleanupPendingControl {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[cfg(all(test, unix))]
impl CleanupPendingControl {
    fn new() -> Self {
        Self(Arc::new(CleanupPendingGate {
            released: Mutex::new(false),
            wake: std::sync::Condvar::new(),
            entered: std::sync::atomic::AtomicUsize::new(0),
            finished: std::sync::atomic::AtomicUsize::new(0),
            active: std::sync::atomic::AtomicUsize::new(0),
            peak: std::sync::atomic::AtomicUsize::new(0),
            changed: tokio::sync::Notify::new(),
        }))
    }
    pub(crate) fn release(&self) {
        self.0.release();
    }
    pub(crate) fn entered(&self) -> usize {
        self.0.entered.load(Ordering::SeqCst)
    }
    pub(crate) fn active(&self) -> usize {
        self.0.active.load(Ordering::SeqCst)
    }
    pub(crate) fn peak(&self) -> usize {
        self.0.peak.load(Ordering::SeqCst)
    }
    pub(crate) async fn wait_entered(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let changed = self.0.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.entered() > 0 && self.active() > 0 {
                    break;
                }
                changed.await;
            }
        })
        .await
        .is_ok()
    }
    pub(crate) async fn wait_finished(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let changed = self.0.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.active() == 0 && self.0.finished.load(Ordering::SeqCst) == self.entered() {
                    break;
                }
                changed.await;
            }
        })
        .await
        .is_ok()
    }
}
#[cfg(all(test, unix))]
impl CleanupProbe {
    pub(crate) fn hold(&self, phase: CleanupPhase) -> CleanupPendingControl {
        let control = CleanupPendingControl::new();
        self.0.pending.lock().unwrap()[phase.index()] = Some(control.0.clone());
        control
    }
    fn hold_launch(&self) -> CleanupPendingControl {
        let control = CleanupPendingControl::new();
        *self.0.launch_pending.lock().unwrap() = Some(control.0.clone());
        control
    }
    pub(crate) fn ordinary_requests(&self) -> Vec<String> {
        self.0
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|method| method.as_str() != "Browser.close")
            .cloned()
            .collect()
    }
    pub(crate) async fn owned_processes_gone(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if self
                    .0
                    .pids
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|pid| unsafe { libc::kill(*pid as i32, 0) } != 0)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok()
    }
}

#[cfg(all(test, unix))]
struct CleanupProbeInner {
    fail: std::sync::atomic::AtomicUsize,
    fail_attach: std::sync::atomic::AtomicBool,
    pending: Mutex<[Option<Arc<CleanupPendingGate>>; 3]>,
    launch_pending: Mutex<Option<Arc<CleanupPendingGate>>>,
    requests: Arc<Mutex<Vec<String>>>,
    calls: [std::sync::atomic::AtomicUsize; 3],
    spawns: std::sync::atomic::AtomicUsize,
    profile: Mutex<Option<PathBuf>>,
    pids: Mutex<Vec<u32>>,
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
#[cfg(all(test, unix))]
impl Drop for CleanupProbeInner {
    fn drop(&mut self) {
        if let Ok(server) = self.server.get_mut() {
            if let Some(server) = server.take() {
                server.abort();
            }
        }
    }
}
#[cfg(all(test, unix))]
#[derive(Clone)]
pub(crate) struct CleanupProbe(Arc<CleanupProbeInner>);
#[cfg(all(test, unix))]
impl CleanupProbe {
    fn new() -> Self {
        Self(Arc::new(CleanupProbeInner {
            fail: std::sync::atomic::AtomicUsize::new(usize::MAX),
            fail_attach: std::sync::atomic::AtomicBool::new(false),
            pending: Mutex::new(std::array::from_fn(|_| None)),
            launch_pending: Mutex::new(None),
            requests: Arc::new(Mutex::new(Vec::new())),
            calls: std::array::from_fn(|_| std::sync::atomic::AtomicUsize::new(0)),
            spawns: std::sync::atomic::AtomicUsize::new(0),
            profile: Mutex::new(None),
            pids: Mutex::new(Vec::new()),
            server: Mutex::new(None),
        }))
    }
    pub(crate) fn fail(&self, phase: Option<CleanupPhase>) {
        self.0.fail.store(
            phase.map_or(usize::MAX, CleanupPhase::index),
            Ordering::SeqCst,
        );
    }
    pub(crate) fn profile(&self) -> PathBuf {
        self.0.profile.lock().unwrap().clone().unwrap()
    }
    fn set_profile(&self, profile: &Path) {
        *self.0.profile.lock().unwrap() = Some(profile.into());
    }
    fn record_spawn(&self, pid: u32) {
        self.0.spawns.fetch_add(1, Ordering::SeqCst);
        self.0.pids.lock().unwrap().push(pid);
    }
    pub(crate) fn spawns(&self) -> usize {
        self.0.spawns.load(Ordering::SeqCst)
    }
    pub(crate) fn calls(&self, phase: CleanupPhase) -> usize {
        self.0.calls[phase.index()].load(Ordering::SeqCst)
    }
}
#[cfg(all(test, unix))]
async fn cleanup_probe_result<T: Send>(
    probe: &Option<CleanupProbe>,
    phase: CleanupPhase,
    actual: Result<T, String>,
) -> Result<T, String> {
    if let Some(probe) = probe {
        probe.0.calls[phase.index()].fetch_add(1, Ordering::SeqCst);
        // Test-only observation delay after actual I/O; this worker survives waiter cancellation.
        let pending = probe.0.pending.lock().unwrap()[phase.index()].clone();
        if let Some(pending) = pending {
            tokio::task::spawn_blocking(move || pending.wait_blocking())
                .await
                .map_err(|_| "Synthetic cleanup pending worker stopped".to_owned())?;
        }
        if probe.0.fail.load(Ordering::SeqCst) == phase.index() {
            return Err(phase.message().into());
        }
    }
    actual
}
#[cfg(all(test, unix))]
async fn cleanup_test_socket(probe: &CleanupProbe, fail_setup: bool) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = probe.0.requests.clone();
    let server = tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        while let Some(Ok(message)) = socket.next().await {
            let Ok(text) = message.to_text() else {
                continue;
            };
            let Ok(request) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            seen.lock()
                .unwrap()
                .push(request["method"].as_str().unwrap_or("").to_owned());
            let response = if fail_setup && request["method"] == "Browser.setDownloadBehavior" {
                json!({"id":request["id"],"error":{"code":-32000,"message":"Synthetic launch setup failure"}})
            } else {
                let result = if request["method"] == "Target.getTargets" {
                    json!({"targetInfos":[{"type":"page","targetId":"cleanup-tab","url":"about:blank","title":"Synthetic"}]})
                } else {
                    json!({})
                };
                json!({"id":request["id"],"result":result})
            };
            if socket
                .send(Message::Text(response.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    *probe.0.server.lock().unwrap() = Some(server);
    port
}
#[cfg(all(test, unix))]
pub(crate) async fn cleanup_test_client(
    data: &Path,
    owner: &str,
    workspace: &Path,
) -> (BrowserClient, CleanupProbe) {
    let probe = CleanupProbe::new();
    let config = BrowserConfig {
        enabled: true,
        timeout_seconds: 1,
        ..Default::default()
    };
    save_config(data, owner, &config).unwrap();
    let mut client = BrowserClient::new(data, owner, workspace, config.clone()).unwrap();
    let port = cleanup_test_socket(&probe, false).await;
    let cdp = Cdp::connect(&format!("ws://127.0.0.1:{port}"), config)
        .await
        .unwrap();
    cdp.targets.lock().unwrap().insert(
        "cleanup-tab".into(),
        Attached {
            session: "cleanup-session".into(),
            page: true,
            ready: true,
            error: None,
            main_contexts: HashMap::new(),
            ..Default::default()
        },
    );
    let directory = config_directory(data, owner).unwrap().join("profiles");
    private_directory(&directory).unwrap();
    let canonical_workspace = workspace.canonicalize().unwrap();
    let directory = directory.join(hex::encode(Sha256::digest(
        canonical_workspace.to_string_lossy().as_bytes(),
    )));
    private_directory(&directory).unwrap();
    let profile = tempfile::Builder::new()
        .prefix("isolated-")
        .tempdir_in(directory)
        .unwrap();
    probe.set_profile(profile.path());
    std::fs::write(
        profile.path().join("synthetic-marker"),
        b"owned cleanup fixture",
    )
    .unwrap();
    let mut command = tokio::process::Command::new("/bin/sleep");
    command
        .arg("30")
        .process_group(0)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().unwrap();
    probe.record_spawn(child.id().unwrap());
    let tree = crate::process_tree::ProcessTree::attach(&child).unwrap();
    client.browser = Some(OwnedBrowser {
        identity: uuid::Uuid::new_v4(),
        cdp: Some(cdp),
        tree: Some(tree),
        child: Arc::new(tokio::sync::Mutex::new(child)),
        _profile: OwnedProfile::publish(profile),
        cleanup: BrowserCleanup::default(),
        ready: true,
        retiring: false,
        launch_error: None,
        cleanup_probe: Some(probe.clone()),
        active: Some("cleanup-tab".into()),
        has_opened: true,
    });
    client.cleanup_probe = Some(probe.clone());
    (client, probe)
}
#[cfg(all(test, unix))]
impl BrowserClient {
    pub(crate) fn cleanup_test_config(&self) -> BrowserConfig {
        self.config.clone()
    }
    pub(crate) fn cleanup_test_has_owner(&self) -> bool {
        self.browser.is_some()
    }
    fn cleanup_test_break_cdp(&mut self) {
        let browser = self.browser.as_mut().unwrap();
        browser
            .cdp
            .as_ref()
            .unwrap()
            .failed
            .store(true, Ordering::SeqCst);
        browser.cdp.as_ref().unwrap().actor.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    mod checked_cleanup_red {
        use super::*;
        #[tokio::test]
        async fn browser_checked_cleanup_healthy_control_uses_real_stop_and_drop() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-healthy", workspace.path()).await;
            let expected_parent = config_directory(data.path(), "checked-healthy")
                .unwrap()
                .join("profiles")
                .join(hex::encode(Sha256::digest(
                    workspace
                        .path()
                        .canonicalize()
                        .unwrap()
                        .to_string_lossy()
                        .as_bytes(),
                )));
            assert_eq!(probe.profile().parent(), Some(expected_parent.as_path()));
            assert!(probe.profile().join("synthetic-marker").exists());
            assert_eq!(
                client
                    .dispatch("browser_close", &json!({}), true)
                    .await
                    .unwrap(),
                json!({"closed":true,"profileDeleted":true})
            );
            assert!(!client.cleanup_test_has_owner());
            assert!(!probe.profile().exists());
            assert_eq!(probe.spawns(), 1);
            assert!(probe
                .0
                .pids
                .lock()
                .unwrap()
                .iter()
                .all(|pid| unsafe { libc::kill(*pid as i32, 0) } != 0));
        }
        async fn assert_close_failure_and_retry(phase: CleanupPhase) {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-owner", workspace.path()).await;
            let profile = probe.profile();
            probe.fail(Some(phase));
            let result = client.dispatch("browser_close", &json!({}), true).await;
            assert!(
                probe.calls(phase) > 0,
                "Close must attempt the targeted {phase:?} phase"
            );
            assert!(
                result.is_err(),
                "Unchecked {phase:?} failure became a successful close: {result:?}"
            );
            assert!(
                client.cleanup_test_has_owner(),
                "Failed close discarded retry ownership"
            );
            assert!(
                profile.join("synthetic-marker").exists(),
                "Unconfirmed close deleted the retained profile"
            );
            probe.fail(None);
            assert_eq!(
                client
                    .dispatch("browser_close", &json!({}), true)
                    .await
                    .unwrap(),
                json!({"closed":true,"profileDeleted":true})
            );
            assert!(!client.cleanup_test_has_owner());
            assert!(!profile.exists());
            assert_eq!(probe.spawns(), 1);
            assert!(probe.calls(phase) >= 2);
        }
        #[tokio::test]
        async fn browser_checked_cleanup_tree_error_retains_owner_and_retries() {
            assert_close_failure_and_retry(CleanupPhase::Tree).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_reap_error_retains_owner_and_retries() {
            assert_close_failure_and_retry(CleanupPhase::Reap).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_profile_error_retains_owner_and_retries() {
            assert_close_failure_and_retry(CleanupPhase::Profile).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_client_close_retains_failed_owner() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-client", workspace.path()).await;
            probe.fail(Some(CleanupPhase::Profile));
            let _ = client.close().await;
            assert!(
                probe.calls(CleanupPhase::Profile) > 0,
                "Client close must attempt checked profile cleanup"
            );
            assert!(
                client.cleanup_test_has_owner(),
                "Client close discarded unconfirmed ownership"
            );
            assert!(probe.profile().exists());
            probe.fail(None);
            let _ = client.close().await;
            assert!(!client.cleanup_test_has_owner());
            assert!(!probe.profile().exists());
            assert_eq!(probe.spawns(), 1);
        }
        #[tokio::test]
        async fn browser_checked_cleanup_last_tab_does_not_report_deleted_on_failure() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-last-tab", workspace.path()).await;
            probe.fail(Some(CleanupPhase::Profile));
            let result = client
                .dispatch("browser_close", &json!({"tabId":"cleanup-tab"}), true)
                .await;
            assert!(
                probe.calls(CleanupPhase::Profile) > 0,
                "Last-tab close must attempt checked profile cleanup"
            );
            assert!(result.is_err());
            assert!(client.cleanup_test_has_owner());
            assert!(probe.profile().exists());
            probe.fail(None);
            client
                .dispatch("browser_close", &json!({}), true)
                .await
                .unwrap();
            assert!(!probe.profile().exists());
        }
        #[tokio::test]
        async fn browser_checked_cleanup_cdp_failure_retains_failed_cleanup_owner() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-cdp", workspace.path()).await;
            probe.fail(Some(CleanupPhase::Profile));
            client.cleanup_test_break_cdp();
            assert!(client
                .dispatch("browser_tabs", &json!({}), true)
                .await
                .is_err());
            assert!(
                probe.calls(CleanupPhase::Profile) > 0,
                "CDP failure must attempt checked profile cleanup"
            );
            assert!(
                client.cleanup_test_has_owner(),
                "CDP error discarded the browser cleanup owner"
            );
            assert!(probe.profile().exists());
            probe.fail(None);
            let _ = client.close().await;
            assert!(!probe.profile().exists());
        }
        async fn launch_failure_retains_profile(fail_setup: bool) {
            use std::os::unix::fs::PermissionsExt;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let probe = CleanupProbe::new();
            let port = if fail_setup {
                Some(cleanup_test_socket(&probe, true).await)
            } else {
                None
            };
            let executable = workspace.path().join("synthetic-browser.sh");
            let endpoint = port
                .map(|port| {
                    format!(
                        r#"for argument in "$@"; do
case "$argument" in --user-data-dir=*) profile=${{argument#--user-data-dir=}};; esac
done
printf '%s\n%s\n' '{port}' '/devtools/browser/cleanup-fixture' > "$profile/DevToolsActivePort"
"#
                    )
                })
                .unwrap_or_default();
            std::fs::write(
                &executable,
                format!("#!/bin/sh\n{endpoint}exec /bin/sleep 30\n"),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let config = BrowserConfig {
                enabled: true,
                executable: Some(executable.to_string_lossy().into_owned()),
                timeout_seconds: 1,
                ..Default::default()
            };
            let mut client =
                BrowserClient::new(data.path(), "checked-launch", workspace.path(), config)
                    .unwrap();
            client.cleanup_probe = Some(probe.clone());
            probe.fail(Some(CleanupPhase::Profile));
            assert!(client
                .dispatch("browser_open", &json!({}), true)
                .await
                .is_err());
            assert!(
                probe.calls(CleanupPhase::Profile) > 0,
                "Failed launch/setup must attempt checked rollback profile cleanup"
            );
            assert!(
                client.cleanup_test_has_owner(),
                "Failed launch/setup discarded unconfirmed cleanup ownership"
            );
            assert!(probe.profile().exists());
            probe.fail(None);
            let _ = client.close().await;
            assert!(!probe.profile().exists());
            assert_eq!(probe.spawns(), 1);
        }
        #[tokio::test]
        async fn browser_checked_cleanup_pre_ready_launch_failure_retains_owner() {
            launch_failure_retains_profile(false).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_setup_failure_retains_owner() {
            launch_failure_retains_profile(true).await;
        }
    }

    #[cfg(unix)]
    mod checked_cleanup_extended_red {
        use super::*;

        fn own_fake_executable(client: &mut BrowserClient, workspace: &Path) {
            use std::os::unix::fs::PermissionsExt;
            let executable = workspace.join("never-ready-owned-browser.sh");
            std::fs::write(&executable, b"#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            client.config.executable = Some(executable.to_string_lossy().into_owned());
        }

        async fn assert_pending_phase_is_bounded_and_one_flight(phase: CleanupPhase) {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-pending", workspace.path()).await;
            own_fake_executable(&mut client, workspace.path());
            let original_profile = probe.profile();
            let gate = probe.hold(phase);
            let first = tokio::time::timeout(
                Duration::from_millis(2400),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let first_bounded_error = matches!(first, Ok(Err(_)));
            let entered = gate.wait_entered().await;
            let first_retained = client.cleanup_test_has_owner();
            let first_profile_retained = original_profile.join("synthetic-marker").exists();
            let requests_before_actions = probe.ordinary_requests();
            let ordinary_action = tokio::time::timeout(
                Duration::from_secs(1),
                client.dispatch("browser_tabs", &json!({}), true),
            )
            .await;
            let replacement_action = tokio::time::timeout(
                Duration::from_millis(1400),
                client.dispatch("browser_open", &json!({}), true),
            )
            .await;
            let second = tokio::time::timeout(
                Duration::from_millis(2400),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let second_bounded_error = matches!(second, Ok(Err(_)));
            let retained_on_retry = client.cleanup_test_has_owner();
            let pending_workers = (gate.entered(), gate.active(), gate.peak());
            let pending_calls = probe.calls(phase);
            let spawns_before_release = probe.spawns();
            let requests_after_actions = probe.ordinary_requests();
            gate.release();
            let workers_finished = gate.wait_finished().await;
            let final_close = tokio::time::timeout(
                Duration::from_secs(3),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let processes_gone = probe.owned_processes_gone().await;
            assert!(
                entered && workers_finished,
                "Synthetic pending gate did not enter/finish"
            );
            assert!(first_bounded_error && second_bounded_error, "Close must itself return a bounded pending error, rather than needing caller cancellation");
            assert!(
                first_retained && retained_on_retry && first_profile_retained,
                "Pending cleanup lost its owner/profile"
            );
            assert!(
                matches!(ordinary_action, Ok(Err(_))) && matches!(replacement_action, Ok(Err(_))),
                "Retiring browser accepted or blocked an ordinary/replacement action"
            );
            assert_eq!(
                pending_workers,
                (1, 1, 1),
                "Retry detached or duplicated the pending worker"
            );
            assert_eq!(
                pending_calls, 1,
                "Retry repeated the same pending cleanup phase"
            );
            assert_eq!(
                spawns_before_release, 1,
                "A retiring browser launched a replacement"
            );
            assert_eq!(
                requests_after_actions, requests_before_actions,
                "Retiring browser issued an ordinary CDP request before rejecting the action"
            );
            assert!(matches!(final_close, Ok(Ok(_))) && processes_gone);
            assert!(!client.cleanup_test_has_owner() && !original_profile.exists());
            assert_eq!(probe.spawns(), 1);
        }
        #[tokio::test]
        async fn browser_checked_cleanup_tree_pending_is_bounded_and_single_flight() {
            assert_pending_phase_is_bounded_and_one_flight(CleanupPhase::Tree).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_reap_pending_is_bounded_and_single_flight() {
            assert_pending_phase_is_bounded_and_one_flight(CleanupPhase::Reap).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_profile_pending_is_bounded_and_single_flight() {
            assert_pending_phase_is_bounded_and_one_flight(CleanupPhase::Profile).await;
        }

        #[tokio::test]
        async fn browser_checked_cleanup_cancelled_client_waiter_retains_pending_owner() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-waiter", workspace.path()).await;
            let profile = probe.profile();
            let gate = probe.hold(CleanupPhase::Profile);
            let input = json!({});
            let mut closing = Box::pin(client.dispatch("browser_close", &input, true));
            let entered = tokio::select! { entered = gate.wait_entered() => entered, _ = &mut closing => false };
            drop(closing);
            let retained = client.cleanup_test_has_owner();
            let marker = profile.join("synthetic-marker").exists();
            let active = gate.active();
            gate.release();
            let finished = gate.wait_finished().await;
            let retry = tokio::time::timeout(
                Duration::from_secs(3),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let gone = probe.owned_processes_gone().await;
            assert!(
                entered && finished && gone,
                "Owned synthetic gate/process did not settle"
            );
            assert!(
                retained && marker,
                "Cancelling only the waiter discarded cleanup ownership"
            );
            assert_eq!(active, 1);
            assert_eq!(gate.peak(), 1);
            assert_eq!(gate.entered(), 1);
            assert!(
                matches!(retry, Ok(Ok(_))) && !client.cleanup_test_has_owner() && !profile.exists()
            );
            assert_eq!(probe.spawns(), 1);
        }

        async fn assert_unsafe_profile_is_not_removed(symlink: bool) {
            use std::os::unix::fs::{symlink as create_symlink, MetadataExt};
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let foreign = tempfile::tempdir().unwrap();
            std::fs::write(
                foreign.path().join("foreign-marker"),
                b"owned foreign fixture",
            )
            .unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-identity", workspace.path()).await;
            let profile = probe.profile();
            let original = std::fs::symlink_metadata(&profile).unwrap();
            let parked = profile.with_file_name("parked-original-owned-profile");
            std::fs::rename(&profile, &parked).unwrap();
            if symlink {
                create_symlink(foreign.path(), &profile).unwrap();
            } else {
                std::fs::create_dir(&profile).unwrap();
                std::fs::write(
                    profile.join("replacement-marker"),
                    b"owned replacement fixture",
                )
                .unwrap();
            }
            let replacement = std::fs::symlink_metadata(&profile).unwrap();
            let first = client.dispatch("browser_close", &json!({}), true).await;
            let retained = client.cleanup_test_has_owner();
            let leaf_untouched = std::fs::symlink_metadata(&profile)
                .is_ok_and(|now| now.dev() == replacement.dev() && now.ino() == replacement.ino());
            let foreign_untouched = foreign.path().join("foreign-marker").exists();
            let parked_untouched = parked.join("synthetic-marker").exists();
            // Restore only this fixture's replacement, then retry the original dev/inode.
            if let Ok(now) = std::fs::symlink_metadata(&profile) {
                assert_eq!(
                    (now.dev(), now.ino()),
                    (replacement.dev(), replacement.ino())
                );
                if symlink {
                    std::fs::remove_file(&profile).unwrap();
                } else {
                    std::fs::remove_dir_all(&profile).unwrap();
                }
            }
            std::fs::rename(&parked, &profile).unwrap();
            let restored = std::fs::symlink_metadata(&profile).unwrap();
            let retry = client.dispatch("browser_close", &json!({}), true).await;
            let gone = probe.owned_processes_gone().await;
            assert!(
                first.is_err() && retained,
                "Unsafe profile identity was acknowledged/released"
            );
            assert!(
                leaf_untouched && foreign_untouched && parked_untouched,
                "Cleanup removed a replaced/symlink leaf or unrelated marker"
            );
            assert_eq!(
                (restored.dev(), restored.ino()),
                (original.dev(), original.ino())
            );
            assert!(retry.is_ok() && gone && !profile.exists() && !client.cleanup_test_has_owner());
            assert!(foreign.path().join("foreign-marker").exists());
            assert_eq!(probe.spawns(), 1);
        }
        #[tokio::test]
        async fn browser_checked_cleanup_symlink_leaf_is_not_deleted() {
            assert_unsafe_profile_is_not_removed(true).await;
        }
        #[tokio::test]
        async fn browser_checked_cleanup_replaced_inode_is_not_deleted() {
            assert_unsafe_profile_is_not_removed(false).await;
        }

        #[tokio::test]
        async fn browser_checked_cleanup_cdp_failure_forces_all_checked_phases_when_healthy() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-forced", workspace.path()).await;
            let profile = probe.profile();
            client.cleanup_test_break_cdp();
            let action = client.dispatch("browser_tabs", &json!({}), true).await;
            let phases = [
                CleanupPhase::Tree,
                CleanupPhase::Reap,
                CleanupPhase::Profile,
            ]
            .map(|phase| probe.calls(phase));
            let owner = client.cleanup_test_has_owner();
            let absent = !profile.exists();
            let _ = client.close().await;
            let gone = probe.owned_processes_gone().await;
            assert!(action.is_err() && gone);
            assert_eq!(
                phases,
                [1, 1, 1],
                "CDP dispatch failure skipped checked forced cleanup"
            );
            assert!(!owner && absent);
            assert_eq!(probe.spawns(), 1);
        }

        #[tokio::test]
        async fn browser_checked_cleanup_healthy_failed_cdp_close_and_repeated_close_are_idempotent(
        ) {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-repeat", workspace.path()).await;
            client.cleanup_test_break_cdp();
            let first = client.dispatch("browser_close", &json!({}), true).await;
            let phases = [
                CleanupPhase::Tree,
                CleanupPhase::Reap,
                CleanupPhase::Profile,
            ]
            .map(|phase| probe.calls(phase));
            let second = client.dispatch("browser_close", &json!({}), true).await;
            assert_eq!(first.unwrap(), json!({"closed":true,"profileDeleted":true}));
            assert_eq!(
                second.unwrap(),
                json!({"closed":true,"profileDeleted":true})
            );
            assert_eq!(phases, [1, 1, 1]);
            assert_eq!(
                [
                    CleanupPhase::Tree,
                    CleanupPhase::Reap,
                    CleanupPhase::Profile
                ]
                .map(|phase| probe.calls(phase)),
                phases
            );
            assert!(
                !client.cleanup_test_has_owner()
                    && !probe.profile().exists()
                    && probe.owned_processes_gone().await
            );
            assert_eq!(probe.spawns(), 1);
        }

        #[tokio::test]
        async fn browser_checked_cleanup_failed_tree_attach_retains_unconfirmed_launch_capsule() {
            use std::os::unix::fs::PermissionsExt;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let probe = CleanupProbe::new();
            let executable = workspace.path().join("attach-failure-owned-browser.sh");
            std::fs::write(&executable, b"#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let config = BrowserConfig {
                enabled: true,
                executable: Some(executable.to_string_lossy().into_owned()),
                timeout_seconds: 1,
                ..Default::default()
            };
            let mut client =
                BrowserClient::new(data.path(), "checked-attach", workspace.path(), config)
                    .unwrap();
            client.cleanup_probe = Some(probe.clone());
            probe.0.fail_attach.store(true, Ordering::SeqCst);
            probe.fail(Some(CleanupPhase::Profile));
            let opened = client.dispatch("browser_open", &json!({}), true).await;
            let retained = client.cleanup_test_has_owner();
            let profile_retained = probe.profile().exists();
            probe.0.fail_attach.store(false, Ordering::SeqCst);
            probe.fail(None);
            let retry = client.dispatch("browser_close", &json!({}), true).await;
            let still_unconfirmed = client.cleanup_test_has_owner() && probe.profile().exists();
            // Clearing injection is not a containment witness. Drop is fixture fallback only.
            drop(client);
            let gone = probe.owned_processes_gone().await;
            assert!(opened.is_err() && gone);
            assert!(
                retained && profile_retained,
                "Failed containment attach discarded unconfirmed launch ownership"
            );
            assert!(retry.is_err()&&still_unconfirmed,"Missing containment guard was falsely recovered from root exit or a cleared test flag");
            assert_eq!(
                probe.calls(CleanupPhase::Profile),
                0,
                "Profile deletion was attempted without containment confirmation"
            );
            assert_eq!(probe.spawns(), 1);
        }

        #[tokio::test]
        async fn browser_checked_cleanup_drop_does_not_delete_replaced_profile_leaf() {
            use std::os::unix::fs::MetadataExt;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-drop-identity", workspace.path()).await;
            let profile = probe.profile();
            let parked = profile.with_file_name("parked-drop-owned-profile");
            std::fs::rename(&profile, &parked).unwrap();
            std::fs::create_dir(&profile).unwrap();
            std::fs::write(
                profile.join("replacement-marker"),
                b"owned unrelated replacement",
            )
            .unwrap();
            let replacement = std::fs::symlink_metadata(&profile).unwrap();
            let result = client.dispatch("browser_close", &json!({}), true).await;
            let retained = client.cleanup_test_has_owner();
            let before_drop = profile.join("replacement-marker").exists();
            drop(client);
            let after_drop = profile.join("replacement-marker").exists();
            let same_inode = std::fs::symlink_metadata(&profile).is_ok_and(|metadata| {
                (metadata.dev(), metadata.ino()) == (replacement.dev(), replacement.ino())
            });
            let original_untouched = parked.join("synthetic-marker").exists();
            let gone = probe.owned_processes_gone().await;
            // Both paths are this fixture's TempDir children; remove only after recording the observation.
            if same_inode {
                std::fs::remove_dir_all(&profile).unwrap();
            }
            std::fs::remove_dir_all(&parked).unwrap();
            assert!(
                result.is_err() && retained,
                "Replaced profile was acknowledged before Drop"
            );
            assert!(
                before_drop && after_drop && same_inode && original_untouched,
                "Drop deleted a replacement path it did not own"
            );
            assert!(gone);
            assert_eq!(probe.spawns(), 1);
        }

        #[tokio::test]
        async fn browser_checked_cleanup_cancelled_pre_ready_launch_keeps_client_owned_capsule() {
            use std::os::unix::fs::PermissionsExt;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let probe = CleanupProbe::new();
            let executable = workspace.path().join("cancel-launch-owned-browser.sh");
            std::fs::write(&executable, b"#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let config = BrowserConfig {
                enabled: true,
                executable: Some(executable.to_string_lossy().into_owned()),
                timeout_seconds: 1,
                ..Default::default()
            };
            let mut client = BrowserClient::new(
                data.path(),
                "checked-launch-cancel",
                workspace.path(),
                config,
            )
            .unwrap();
            client.cleanup_probe = Some(probe.clone());
            let gate = probe.hold_launch();
            let input = json!({});
            let mut launching = Box::pin(client.dispatch("browser_open", &input, true));
            let entered =
                tokio::select! {entered=gate.wait_entered()=>entered,_=&mut launching=>false};
            drop(launching);
            let retained = client.cleanup_test_has_owner();
            let profile = probe.profile();
            let retained_profile = profile.exists();
            gate.release();
            let finished = gate.wait_finished().await;
            let retry = tokio::time::timeout(
                Duration::from_secs(3),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let gone = probe.owned_processes_gone().await;
            assert!(entered && finished && gone);
            assert!(
                retained && retained_profile,
                "Cancelled launch kept ownership only in the dropped launch future"
            );
            assert!(
                matches!(retry, Ok(Ok(_))) && !client.cleanup_test_has_owner() && !profile.exists()
            );
            assert_eq!(gate.entered(), 1);
            assert_eq!(probe.spawns(), 1);
        }
        #[tokio::test]
        async fn browser_checked_cleanup_retiring_tab_close_is_prompt_and_issues_no_cdp() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, probe) =
                cleanup_test_client(data.path(), "checked-retiring-tab", workspace.path()).await;
            let profile = probe.profile();
            let gate = probe.hold(CleanupPhase::Profile);
            let first = tokio::time::timeout(
                Duration::from_millis(2400),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let entered = gate.wait_entered().await;
            let owner_retained = client.cleanup_test_has_owner() && profile.exists();
            let before = probe.ordinary_requests();
            let tab_close = tokio::time::timeout(
                Duration::from_secs(1),
                client.dispatch("browser_close", &json!({"tabId":"cleanup-tab"}), true),
            )
            .await;
            let after = probe.ordinary_requests();
            gate.release();
            let finished = gate.wait_finished().await;
            let full_retry = tokio::time::timeout(
                Duration::from_secs(3),
                client.dispatch("browser_close", &json!({}), true),
            )
            .await;
            let gone = probe.owned_processes_gone().await;
            assert!(
                entered && finished && gone && owner_retained && matches!(first, Ok(Err(_))),
                "Pending fixture must retain its original browser owner before tab close"
            );
            assert_eq!(
                after, before,
                "Retiring tab-specific close issued ordinary CDP work before rejection"
            );
            assert!(
                matches!(tab_close, Ok(Err(_))),
                "Retiring tab close must reject promptly and direct full-close retry"
            );
            assert!(
                matches!(full_retry, Ok(Ok(_)))
                    && !client.cleanup_test_has_owner()
                    && !profile.exists()
            );
            assert_eq!(gate.entered(), 1);
            assert_eq!(probe.spawns(), 1);
        }
    }

    #[test]
    fn configuration_is_disabled_by_default_and_rejects_unsafe_origins() {
        let config: BrowserConfig = serde_json::from_value(json!({})).unwrap();
        assert!(!config.enabled);
        config.validate().unwrap();
        for origin in [
            "file:///tmp/private",
            "https://user:password@example.com",
            "https://example.com/path",
            "https://example.com?token=secret",
            "ftp://example.com",
            "https://*.example.com",
        ] {
            let config = BrowserConfig {
                allowed_origins: vec![origin.into()],
                ..BrowserConfig::default()
            };
            assert!(config.validate().is_err(), "{origin}");
        }
    }
    #[test]
    fn configuration_is_scoped_to_owner_and_secrets_cannot_be_imported() {
        let data = tempfile::tempdir().unwrap();
        let config = BrowserConfig {
            enabled: true,
            allowed_origins: vec!["https://example.com".into()],
            ..BrowserConfig::default()
        };
        save_config(data.path(), "owner-a", &config).unwrap();
        assert!(load_config(data.path(), "owner-a").unwrap().enabled);
        assert!(!load_config(data.path(), "owner-b").unwrap().enabled);
        assert!(serde_json::from_value::<BrowserConfig>(
            json!({"enabled":true,"profile":"/Users/user/Chrome"})
        )
        .is_err());
        assert!(
            serde_json::from_value::<BrowserConfig>(json!({"enabled":true,"cookies":[]})).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn image_read_lease_excludes_settings_writes_across_processes() {
        if let Some(path) = std::env::var_os("V4_IMAGE_SETTINGS_LOCK_TEST") {
            let expected = std::env::var("V4_IMAGE_SETTINGS_LOCK_EXPECT").unwrap();
            let saved = save_config(Path::new(&path), "fixture-owner", &BrowserConfig::default());
            assert_eq!(saved.is_ok(), expected == "allowed");
            return;
        }
        let data = tempfile::tempdir().unwrap();
        let initial = BrowserConfig {
            enabled: true,
            ..Default::default()
        };
        save_config(data.path(), "fixture-owner", &initial).unwrap();
        let lease = browser_settings_lease(data.path(), "fixture-owner").unwrap();
        let run = |expected: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "v4_agent::browser::tests::image_read_lease_excludes_settings_writes_across_processes"])
            .env("V4_IMAGE_SETTINGS_LOCK_TEST", data.path())
            .env("V4_IMAGE_SETTINGS_LOCK_EXPECT", expected)
            .output().unwrap()
        };
        assert!(run("blocked").status.success());
        assert!(load_config(data.path(), "fixture-owner").unwrap().enabled);
        save_config(data.path(), "other-owner", &BrowserConfig::default()).unwrap();
        drop(lease);
        assert!(run("allowed").status.success());
        assert!(!load_config(data.path(), "fixture-owner").unwrap().enabled);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn unconfirmed_browser_cleanup_keeps_uncertain_action_lease() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (mut client, probe) =
            cleanup_test_client(data.path(), "retained-owner", workspace.path()).await;
        let lease = Arc::new(browser_settings_lease(data.path(), "retained-owner").unwrap());
        client
            .browser
            .as_ref()
            .unwrap()
            .cdp
            .as_ref()
            .unwrap()
            ._inflight_settings
            .lock()
            .unwrap()
            .insert(999, lease);
        probe.fail(Some(CleanupPhase::Tree));
        assert!(client.close().await.is_err());
        assert!(save_config(data.path(), "retained-owner", &BrowserConfig::default()).is_err());
        probe.fail(None);
        client.close().await.unwrap();
        assert!(save_config(data.path(), "retained-owner", &BrowserConfig::default()).is_ok());
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stalled_protocol_cleanup_is_bounded_and_keeps_its_owner() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (mut client, _) =
            cleanup_test_client(data.path(), "stalled-owner", workspace.path()).await;
        let lease = Arc::new(browser_settings_lease(data.path(), "stalled-owner").unwrap());
        let gate = CleanupPendingControl::new();
        let cdp = client.browser.as_mut().unwrap().cdp.as_mut().unwrap();
        cdp._inflight_settings.lock().unwrap().insert(999, lease);
        cdp.actor.abort();
        let blocked = gate.0.clone();
        cdp.actor = tokio::spawn(async move {
            blocked.wait_blocking();
        });
        assert!(gate.wait_entered().await);
        let result = tokio::time::timeout(Duration::from_millis(2500), client.close()).await;
        assert!(
            matches!(result, Ok(Err(_))),
            "A stalled protocol actor must not make close wait indefinitely"
        );
        assert!(
            client.browser.as_ref().unwrap().cdp.is_some(),
            "The pending actor must retain its owner for retry"
        );
        assert!(save_config(data.path(), "stalled-owner", &BrowserConfig::default()).is_err());
        gate.release();
        assert!(gate.wait_finished().await);
        client.close().await.unwrap();
        assert!(save_config(data.path(), "stalled-owner", &BrowserConfig::default()).is_ok());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn mouse_cleanup_shares_the_browser_close_deadline() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (mut client, probe) =
            cleanup_test_client(data.path(), "mouse-deadline", workspace.path()).await;
        let mouse = client.mouse_gate.clone().lock_owned().await;
        let gate = probe.hold(CleanupPhase::Tree);
        let release = tokio::spawn(async move {
            assert!(gate.wait_entered().await);
            tokio::time::sleep(Duration::from_millis(1100)).await;
            gate.release();
        });
        let result = tokio::time::timeout(Duration::from_millis(2500), client.close()).await;
        assert!(
            matches!(result, Ok(Err(_))),
            "Mouse cleanup must share the browser close deadline"
        );
        assert!(client.browser.is_some());
        drop(mouse);
        release.await.unwrap();
        client.close().await.unwrap();
    }

    #[test]
    fn popup_interception_is_configured_before_renderer_startup() {
        let names = setup_steps("page")
            .into_iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>();
        let position = |name| names.iter().position(|value| *value == name).unwrap();
        assert!(position("Fetch.enable") < position("Runtime.runIfWaitingForDebugger"));
        assert!(position("Runtime.runIfWaitingForDebugger") < position("Runtime.enable"));
        assert!(position("Runtime.runIfWaitingForDebugger") < position("Network.enable"));
    }
    #[test]
    fn debugger_endpoint_cannot_redirect_to_another_process_or_service() {
        assert_eq!(
            parse_endpoint("32123\n/devtools/browser/abcd-123\n").unwrap(),
            "ws://127.0.0.1:32123/devtools/browser/abcd-123"
        );
        for input in [
            "0\n/devtools/browser/abc",
            "65536\n/devtools/browser/abc",
            "3037\nhttp://example.com",
            "3037\n/devtools/browser/abc?token=secret",
            "3037\n/devtools/browser/../private",
            "3037\n/devtools/browser/abc\nextra",
        ] {
            assert!(parse_endpoint(input).is_err(), "{input}");
        }
    }
    #[test]
    fn origins_and_tool_arguments_are_exact_and_bounded() {
        let config = BrowserConfig {
            allowed_origins: vec!["https://example.com".into(), "http://127.0.0.1:3000".into()],
            ..BrowserConfig::default()
        };
        for url in [
            "https://example.com/path?q=a#anchor",
            "http://127.0.0.1:3000/fixture",
            "about:blank",
        ] {
            assert!(config.permits(url));
        }
        for url in [
            "https://example.com.evil.test",
            "http://example.com",
            "https://example.com:444/",
            "http://127.0.0.1:3001/",
            "https://a:b@example.com/",
            "file:///tmp/private",
            "javascript:alert(1)",
        ] {
            assert!(!config.permits(url), "{url}");
        }
        assert!(
            validate_arguments("browser_evaluate", &json!({"script":"1+1","cookies":[]})).is_err()
        );
        assert!(validate_arguments("browser_click", &json!({})).is_err());
        assert!(validate_arguments(
            "browser_type",
            &json!({"ref":"e1","text":"ok","clear":"true"})
        )
        .is_err());
        assert!(!handles("browser_nonexistent"));
        assert!(handles("browser_snapshot"));
        assert!(handles("browser_get_images"));
        assert!(
            validate_arguments("browser_get_images", &json!({"tabId":"synthetic-tab"})).is_ok()
        );
        assert!(validate_arguments(
            "browser_get_images",
            &json!({"tabId":"synthetic-tab","includeCookies":true})
        )
        .is_err());
        for name in definitions()
            .iter()
            .map(|row| row["name"].as_str().unwrap())
        {
            assert!(name.starts_with("browser_"));
        }
        for value in [
            "e1",
            "e💥_1",
            "e00000000000000000000000000000000_",
            "e00000000000000000000000000000000_1';alert(1)",
        ] {
            assert!(reference(&json!({"ref":value})).is_err());
        }
    }
    #[tokio::test]
    async fn disabled_and_unapproved_browser_calls_never_launch_a_process() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut client = BrowserClient::new(
            data.path(),
            "owner",
            workspace.path(),
            BrowserConfig::default(),
        )
        .unwrap();
        assert!(!client.enabled());
        assert!(client
            .dispatch("browser_open", &json!({}), true)
            .await
            .unwrap_err()
            .contains("disabled"));
        client.config.enabled = true;
        assert!(client
            .dispatch("browser_open", &json!({}), false)
            .await
            .unwrap_err()
            .contains("approval"));
        assert!(client
            .dispatch("browser_open", &json!({"url":"https://example.com"}), true)
            .await
            .unwrap_err()
            .contains("origin"));
        assert!(client.browser.is_none());
        assert!(!data.path().join("v4-browser").exists());
    }
    #[cfg(unix)]
    #[test]
    fn configuration_rejects_symlinked_files_and_protects_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let data = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let directory = config_directory(data.path(), "owner").unwrap();
        save_config(data.path(), "owner", &BrowserConfig::default()).unwrap();
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(directory.join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::fs::remove_file(directory.join("config.json")).unwrap();
        symlink(other.path().join("private"), directory.join("config.json")).unwrap();
        assert!(load_config(data.path(), "owner").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn browser_settings_lease_rejects_symlinked_lock_and_invalid_revision() {
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        save_config(data.path(), "owner", &BrowserConfig::default()).unwrap();
        let directory = config_directory(data.path(), "owner").unwrap();
        let revision = directory.join("settings.revision");
        let revision_target = other.path().join("synthetic-revision");
        std::fs::write(&revision_target, uuid::Uuid::new_v4().to_string()).unwrap();
        std::fs::remove_file(&revision).unwrap();
        std::fs::hard_link(&revision_target, &revision).unwrap();
        assert!(settings_revision(data.path(), "owner").is_err());
        std::fs::remove_file(&revision).unwrap();
        std::fs::write(&revision, "invalid").unwrap();
        assert!(settings_revision(data.path(), "owner").is_err());
        let lock = directory.join("settings.lock");
        std::fs::remove_file(&lock).unwrap();
        let target = other.path().join("untouched");
        std::fs::write(&target, "sentinel").unwrap();
        symlink(&target, &lock).unwrap();
        assert!(browser_settings_lease(data.path(), "owner").is_err());
        assert!(save_config(data.path(), "owner", &BrowserConfig::default()).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "sentinel");
    }
    mod console_and_dialog {
        use super::*;

        fn api(context: u64, kind: &str, args: Value) -> Value {
            json!({"executionContextId":context,"type":kind,"args":args})
        }

        #[test]
        fn redact_console_hides_credentials_and_opaque_tokens() {
            let cases = [
                ("login password=hunter2 ok", "login password=[redacted] ok"),
                (
                    "Authorization: Bearer abc.def-123",
                    "Authorization: [redacted]",
                ),
                ("{\"api_key\":\"k-9\"}", "{\"api_key\":\"[redacted]\"}"),
                ("GET /x?token=abc&page=2", "GET /x?token=[redacted]&page=2"),
                (
                    "id 0123456789abcdef0123456789abcdef0123 end",
                    "id [redacted] end",
                ),
                ("plain message about forms", "plain message about forms"),
            ];
            for (input, expected) in cases {
                assert_eq!(redact_console(input), expected, "{input}");
            }
        }

        #[test]
        fn console_entries_are_bounded_and_keyed_by_execution_context() {
            let long = "x".repeat(MAX_CONSOLE_TEXT * 3);
            let entry = console_entry_from_api(&api(
                7,
                "warning",
                json!([{"type":"string","value":long},{"type":"number","value":4},{"type":"object","description":"Object"}]),
            ))
            .unwrap();
            assert_eq!(
                (
                    entry.context,
                    entry.level.as_str(),
                    entry.text.chars().count()
                ),
                (7, "warning", MAX_CONSOLE_TEXT)
            );
            let exception = console_entry_from_exception(&json!({"exceptionDetails":{"executionContextId":9,"text":"Uncaught","exception":{"description":"Error: boom\n at x"}}})).unwrap();
            assert_eq!(
                (
                    exception.context,
                    exception.level.as_str(),
                    exception.text.as_str()
                ),
                (9, "error", "Error: boom\n at x")
            );
            assert!(console_entry_from_api(&json!({"type":"log","args":[]})).is_none());
            let mut attached = Attached::default();
            for index in 0..MAX_CONSOLE_ENTRIES + 5 {
                record_console(
                    &mut attached,
                    ConsoleEntry {
                        context: 1,
                        level: "log".into(),
                        text: index.to_string(),
                    },
                );
            }
            assert_eq!(
                (
                    attached.console.len(),
                    attached.console.front().unwrap().text.as_str()
                ),
                (MAX_CONSOLE_ENTRIES, "5")
            );
        }

        fn dialog(url: &str, kind: &str) -> Value {
            json!({"url":url,"type":kind,"message":"Proceed?"})
        }
        fn armed(
            accept: bool,
            prompt: Option<&str>,
            expires: tokio::time::Instant,
        ) -> Option<DialogPolicy> {
            Some(DialogPolicy {
                accept,
                prompt: prompt.map(str::to_owned),
                origin: "http://127.0.0.1:1".into(),
                expires,
            })
        }

        #[test]
        fn dialogs_default_to_dismiss_and_armed_decisions_are_one_shot_for_the_reviewed_origin() {
            let now = tokio::time::Instant::now();
            let later = now + Duration::from_secs(30);
            let mut attached = Attached::default();
            assert_eq!(
                record_dialog(
                    &mut attached,
                    &dialog("http://127.0.0.1:1/a", "confirm"),
                    now
                ),
                (false, None)
            );
            attached.dialog_policy = armed(true, Some("typed"), later);
            assert_eq!(
                record_dialog(
                    &mut attached,
                    &dialog("http://127.0.0.1:2/a", "prompt"),
                    now
                ),
                (false, None)
            );
            assert!(attached.dialog_policy.is_some());
            assert_eq!(
                record_dialog(
                    &mut attached,
                    &dialog("http://127.0.0.1:1/b", "prompt"),
                    now
                ),
                (true, Some("typed".into()))
            );
            assert!(attached.dialog_policy.is_none());
            attached.dialog_policy = armed(true, Some("typed"), later);
            assert_eq!(
                record_dialog(
                    &mut attached,
                    &dialog("http://127.0.0.1:1/b", "confirm"),
                    now
                ),
                (true, None)
            );
            attached.dialog_policy = armed(true, None, now);
            assert_eq!(
                record_dialog(
                    &mut attached,
                    &dialog("http://127.0.0.1:1/b", "confirm"),
                    now + Duration::from_secs(1)
                ),
                (false, None)
            );
            assert!(attached.dialog_policy.is_none());
            for _ in 0..MAX_DIALOG_ENTRIES + 3 {
                record_dialog(&mut attached, &dialog("http://127.0.0.1:1/b", "alert"), now);
            }
            assert_eq!(attached.dialogs.len(), MAX_DIALOG_ENTRIES);
        }

        #[test]
        fn argument_validation_rejects_unsupported_console_and_dialog_inputs() {
            for (name, input) in [
                ("browser_console", json!({})),
                (
                    "browser_console",
                    json!({"level":"error","limit":100,"tabId":"t"}),
                ),
                (
                    "browser_dialog",
                    json!({"action":"accept","promptText":"x"}),
                ),
                ("browser_dialog", json!({"action":"dismiss"})),
            ] {
                assert_eq!(validate_arguments(name, &input), Ok(()), "{name} {input}");
            }
            for (name, input) in [
                ("browser_console", json!({"level":"trace"})),
                ("browser_console", json!({"limit":0})),
                ("browser_console", json!({"limit":101})),
                ("browser_console", json!({"ref":"x"})),
                ("browser_dialog", json!({})),
                ("browser_dialog", json!({"action":"maybe"})),
                (
                    "browser_dialog",
                    json!({"action":"dismiss","promptText":"x"}),
                ),
                (
                    "browser_dialog",
                    json!({"action":"accept","promptText":"x".repeat(1001)}),
                ),
            ] {
                assert!(validate_arguments(name, &input).is_err(), "{name} {input}");
            }
        }

        #[test]
        fn new_tools_are_isolated_document_tools_and_never_available_to_read_only_children() {
            for name in ["browser_console", "browser_dialog"] {
                assert!(
                    handles(name) && is_document_tool(name) && isolated_only(name),
                    "{name}"
                );
                assert!(
                    !crate::v4_agent::ToolPolicy::ReadOnlyChild.allows(name),
                    "{name}"
                );
            }
            assert!(!isolated_only("browser_snapshot"));
            for tool in definitions() {
                assert!(
                    !crate::v4_agent::ToolPolicy::ReadOnlyChild
                        .allows(tool["name"].as_str().unwrap()),
                    "{tool}"
                );
            }
        }
    }
    mod protocol_io {
        use super::*;

        #[cfg(unix)]
        #[tokio::test]
        async fn closed_mouse_press_response_remains_fenced_without_panicking() {
            let gate = Arc::new(tokio::sync::Mutex::new(MouseState::default()));
            let guard = gate.clone().lock_owned().await;
            let (requests, mut receiver) = mpsc::channel(4);
            let action = tokio::spawn(supervised_mouse_click(
                requests,
                guard,
                "session",
                20.0,
                30.0,
                Duration::from_secs(1),
                crate::v4_agent::interaction::Cancellation::default(),
                None,
            ));
            let down = receiver.recv().await.unwrap();
            drop(down.response);
            let release = receiver.recv().await.unwrap();
            release.response.send(Ok(json!({}))).unwrap();
            let error = action.await.unwrap().unwrap_err();
            assert!(
                error.contains("Mouse press outcome is unconfirmed"),
                "{error}"
            );
            assert!(gate.lock().await.pressed);
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn unconfirmed_mouse_input_fences_browser_and_settings_until_cleanup() {
            for missing_press_reply in [false, true] {
                let data = tempfile::tempdir().unwrap();
                let workspace = tempfile::tempdir().unwrap();
                let (mut client, _probe) =
                    cleanup_test_client(data.path(), "mouse-owner", workspace.path()).await;
                let lease = Arc::new(browser_settings_lease(data.path(), "mouse-owner").unwrap());
                let gate = client.mouse_gate.clone().lock_owned().await;
                let (requests, mut receiver) = mpsc::channel(4);
                let action = tokio::spawn(supervised_mouse_click(
                    requests,
                    gate,
                    "synthetic-session",
                    20.0,
                    30.0,
                    Duration::from_millis(150),
                    crate::v4_agent::interaction::Cancellation::default(),
                    Some(lease),
                ));
                let down = receiver.recv().await.unwrap();
                assert_eq!(down.params["type"], "mousePressed");
                let mut pending_down = Some(down.response);
                drop(down.lease);
                if !missing_press_reply {
                    pending_down.take().unwrap().send(Ok(json!({}))).unwrap();
                }
                let release = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(release.params["type"], "mouseReleased");
                release
                    .response
                    .send(if missing_press_reply {
                        Ok(json!({}))
                    } else {
                        Err("synthetic release failure".into())
                    })
                    .unwrap();
                drop(release.lease);
                assert!(action.await.unwrap().is_err());
                assert!(client
                    .dispatch("browser_tabs", &json!({}), true)
                    .await
                    .unwrap_err()
                    .contains("unconfirmed"));
                assert!(client
                    .review_images(&json!({}))
                    .await
                    .err()
                    .unwrap()
                    .contains("unconfirmed"));
                assert!(
                    save_config(data.path(), "mouse-owner", &BrowserConfig::default()).is_err()
                );
                drop(pending_down);
                client.close().await.unwrap();
                assert!(save_config(data.path(), "mouse-owner", &BrowserConfig::default()).is_ok());
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn mouse_click_cancelled_before_admission_sends_no_input() {
            let data = tempfile::tempdir().unwrap();
            save_config(data.path(), "mouse-owner", &BrowserConfig::default()).unwrap();
            let lease = Arc::new(browser_settings_lease(data.path(), "mouse-owner").unwrap());
            let gate = Arc::new(tokio::sync::Mutex::new(MouseState::default()));
            let guard = gate.clone().lock_owned().await;
            let (requests, mut receiver) = mpsc::channel(2);
            let cancel = crate::v4_agent::interaction::Cancellation::default();
            cancel.cancel();
            assert!(supervised_mouse_click(
                requests,
                guard,
                "session",
                20.0,
                30.0,
                Duration::from_secs(1),
                cancel,
                Some(lease)
            )
            .await
            .is_err());
            assert!(receiver.try_recv().is_err());
            assert!(!gate.lock().await.pressed);
            assert!(save_config(data.path(), "mouse-owner", &BrowserConfig::default()).is_ok());
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn closing_browser_clears_unconfirmed_mouse_after_supervisor_stops() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, _probe) =
                cleanup_test_client(data.path(), "mouse-owner", workspace.path()).await;
            let lease = Arc::new(browser_settings_lease(data.path(), "mouse-owner").unwrap());
            let guard = client.mouse_gate.clone().lock_owned().await;
            let (requests, mut receiver) = mpsc::channel(4);
            let action = tokio::spawn(supervised_mouse_click(
                requests,
                guard,
                "session",
                20.0,
                30.0,
                Duration::from_millis(100),
                crate::v4_agent::interaction::Cancellation::default(),
                Some(lease),
            ));
            let down = receiver.recv().await.unwrap();
            let pending_down = down.response;
            drop(down.lease);
            let drain = tokio::spawn(async move {
                drop(receiver.recv().await);
            });
            tokio::time::timeout(Duration::from_secs(3), client.close())
                .await
                .unwrap()
                .unwrap();
            assert!(action.await.unwrap().is_err());
            drain.await.unwrap();
            drop(pending_down);
            assert!(save_config(data.path(), "mouse-owner", &BrowserConfig::default()).is_ok());
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn cancelled_click_releases_mouse_and_fences_followup_until_acknowledged() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let (mut client, _probe) =
                cleanup_test_client(data.path(), "click-owner", workspace.path()).await;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (pressed_tx, pressed_rx) = oneshot::channel();
            let (released_tx, released_rx) = oneshot::channel();
            let (allow_tx, allow_rx) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let mut pressed_tx = Some(pressed_tx);
                let mut released_tx = Some(released_tx);
                let mut allow_rx = Some(allow_rx);
                let mut press_id = None;
                while let Some(Ok(message)) = socket.next().await {
                    if !message.is_text() {
                        break;
                    }
                    let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                    let method = request["method"].as_str().unwrap();
                    let result = match method {
                        "Page.getFrameTree" => json!({"frameTree":{"frame":{"id":"frame"}}}),
                        "Page.createIsolatedWorld" => json!({"executionContextId":1}),
                        "Runtime.evaluate" => json!({"result":{"value":{"x":30,"y":40}}}),
                        "Target.getTargets" => {
                            json!({"targetInfos":[{"type":"page","targetId":"cleanup-tab","url":"about:blank","title":"Fixture"}]})
                        }
                        "Input.dispatchMouseEvent"
                            if request["params"]["type"] == "mousePressed" =>
                        {
                            press_id = Some(request["id"].clone());
                            pressed_tx.take().unwrap().send(()).unwrap();
                            continue;
                        }
                        "Input.dispatchMouseEvent"
                            if request["params"]["type"] == "mouseReleased" =>
                        {
                            released_tx.take().unwrap().send(()).unwrap();
                            allow_rx.take().unwrap().await.unwrap();
                            socket
                                .send(Message::Text(
                                    json!({"id":press_id.take().unwrap(),"result":{}})
                                        .to_string()
                                        .into(),
                                ))
                                .await
                                .unwrap();
                            json!({})
                        }
                        _ => json!({}),
                    };
                    socket
                        .send(Message::Text(
                            json!({"id":request["id"],"result":result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
            });
            let cdp = Cdp::connect(&format!("ws://{address}"), client.config.clone())
                .await
                .unwrap();
            cdp.targets.lock().unwrap().insert(
                "cleanup-tab".into(),
                Attached {
                    session: "cleanup-session".into(),
                    page: true,
                    ready: true,
                    error: None,
                    main_contexts: HashMap::new(),
                    ..Default::default()
                },
            );
            client.browser.as_mut().unwrap().cdp = Some(cdp);
            let client = Arc::new(tokio::sync::Mutex::new(client));
            let lease = Arc::new(browser_settings_lease(data.path(), "click-owner").unwrap());
            let click = {
                let client = client.clone();
                tokio::spawn(async move {
                    client
                        .lock()
                        .await
                        .dispatch_with_settings_lease(
                            "browser_click",
                            &json!({"ref":format!("e{}_1", "a".repeat(32))}),
                            true,
                            &crate::v4_agent::interaction::Cancellation::default(),
                            lease,
                        )
                        .await
                })
            };
            tokio::time::timeout(Duration::from_secs(2), pressed_rx)
                .await
                .unwrap()
                .unwrap();
            click.abort();
            assert!(click.await.unwrap_err().is_cancelled());
            tokio::time::timeout(Duration::from_secs(2), released_rx)
                .await
                .expect("Cancellation must issue a mouse release")
                .expect("Browser closed before issuing a mouse release");
            assert!(
                save_config(data.path(), "click-owner", &BrowserConfig::default()).is_err(),
                "Settings cannot change while mouse release is unconfirmed"
            );
            let followup = {
                let client = client.clone();
                tokio::spawn(async move {
                    client
                        .lock()
                        .await
                        .dispatch("browser_tabs", &json!({}), true)
                        .await
                })
            };
            tokio::task::yield_now().await;
            assert!(
                !followup.is_finished(),
                "A later browser action must wait for mouse release"
            );
            allow_tx.send(()).unwrap();
            assert!(tokio::time::timeout(Duration::from_secs(2), followup)
                .await
                .unwrap()
                .unwrap()
                .is_ok());
            client.lock().await.close().await.unwrap();
            assert!(save_config(data.path(), "click-owner", &BrowserConfig::default()).is_ok());
            server.abort();
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn cancelled_standalone_command_retains_settings_until_its_reply() {
            let data = tempfile::tempdir().unwrap();
            save_config(data.path(), "owner", &BrowserConfig::default()).unwrap();
            let lease = Arc::new(browser_settings_lease(data.path(), "owner").unwrap());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (seen, arrived) = oneshot::channel();
            let (respond, response_allowed) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(request["method"], "Page.navigate");
                seen.send(()).unwrap();
                response_allowed.await.unwrap();
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":{}}).to_string().into(),
                    ))
                    .await
                    .unwrap();
            });
            let cdp = Arc::new(
                Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                    .await
                    .unwrap(),
            );
            let operation = {
                let cdp = cdp.clone();
                tokio::spawn(async move {
                    ACTION_SETTINGS_LEASE
                        .scope(lease, cdp.request("Page.navigate", json!({}), None))
                        .await
                })
            };
            arrived.await.unwrap();
            operation.abort();
            assert!(operation.await.unwrap_err().is_cancelled());
            assert!(save_config(data.path(), "owner", &BrowserConfig::default()).is_err());
            respond.send(()).unwrap();
            server.await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if save_config(data.path(), "owner", &BrowserConfig::default()).is_ok() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("The acknowledged command kept its settings lease");
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn lost_browser_connection_keeps_uncertain_action_settings_until_cleanup() {
            let data = tempfile::tempdir().unwrap();
            save_config(data.path(), "owner", &BrowserConfig::default()).unwrap();
            let lease = Arc::new(browser_settings_lease(data.path(), "owner").unwrap());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let _ = socket.next().await.unwrap().unwrap();
                socket.close(None).await.unwrap();
            });
            let cdp = Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                .await
                .unwrap();
            assert!(ACTION_SETTINGS_LEASE
                .scope(lease, cdp.request("Page.navigate", json!({}), None))
                .await
                .is_err());
            server.await.unwrap();
            assert!(
                save_config(data.path(), "owner", &BrowserConfig::default()).is_err(),
                "An unconfirmed browser action must retain its settings lease"
            );
            drop(cdp);
            assert!(save_config(data.path(), "owner", &BrowserConfig::default()).is_ok());
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn malformed_browser_reply_keeps_uncertain_action_settings_until_cleanup() {
            let data = tempfile::tempdir().unwrap();
            save_config(data.path(), "owner", &BrowserConfig::default()).unwrap();
            let lease = Arc::new(browser_settings_lease(data.path(), "owner").unwrap());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                socket
                    .send(Message::Text(
                        json!({"id":request["id"]}).to_string().into(),
                    ))
                    .await
                    .unwrap();
            });
            let cdp = Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                .await
                .unwrap();
            assert!(ACTION_SETTINGS_LEASE
                .scope(lease, cdp.request("Page.navigate", json!({}), None))
                .await
                .is_err());
            server.await.unwrap();
            assert!(save_config(data.path(), "owner", &BrowserConfig::default()).is_err());
            drop(cdp);
            assert!(save_config(data.path(), "owner", &BrowserConfig::default()).is_ok());
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn dropped_image_request_retains_settings_lease_until_browser_replies() {
            let data = tempfile::tempdir().unwrap();
            save_config(data.path(), "fixture-owner", &BrowserConfig::default()).unwrap();
            let lease = Arc::new(browser_settings_lease(data.path(), "fixture-owner").unwrap());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (seen, arrived) = oneshot::channel();
            let (respond, response_allowed) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                seen.send(()).unwrap();
                response_allowed.await.unwrap();
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":{}}).to_string().into(),
                    ))
                    .await
                    .unwrap();
            });
            let cdp = Arc::new(
                Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                    .await
                    .unwrap(),
            );
            let operation = {
                let cdp = cdp.clone();
                tokio::spawn(async move {
                    cdp.request_guarded("Runtime.evaluate", json!({}), None, Some(lease))
                        .await
                })
            };
            arrived.await.unwrap();
            operation.abort();
            assert!(operation.await.unwrap_err().is_cancelled());
            assert!(save_config(data.path(), "fixture-owner", &BrowserConfig::default()).is_err());
            respond.send(()).unwrap();
            server.await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if save_config(data.path(), "fixture-owner", &BrowserConfig::default()).is_ok()
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("The settings lease was not released after the browser replied");
        }

        #[tokio::test]
        async fn unconfirmed_isolated_key_release_blocks_browser_actions_until_confirmed_close() {
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "fixture-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    ..Default::default()
                },
            )
            .unwrap();
            client.key_gate.lock().await.pressed = true;
            assert!(client
                .dispatch("browser_tabs", &json!({}), true)
                .await
                .unwrap_err()
                .contains("release"));
            assert_eq!(
                client
                    .dispatch("browser_close", &json!({}), true)
                    .await
                    .unwrap()["closed"],
                true
            );
            assert_eq!(
                client
                    .dispatch("browser_tabs", &json!({}), true)
                    .await
                    .unwrap()["running"],
                false
            );
        }

        #[test]
        fn browser_key_parameters_match_allowed_key_and_modifier_semantics() {
            let (down, up) = key_parameters("Control+Enter").unwrap();
            assert_eq!(
                down,
                json!({"type":"rawKeyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"modifiers":2,"text":"","unmodifiedText":""})
            );
            assert_eq!(
                up,
                json!({"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"modifiers":2,"text":"","unmodifiedText":""})
            );
            assert_eq!(key_parameters("Shift+1").unwrap().0["key"], "!");
            for key in [
                "",
                "Control+Control+A",
                "F13",
                "Ctrl+A",
                "__proto__",
                "A+B",
                "Control+",
            ] {
                assert!(key_parameters(key).is_err(), "{key}");
            }
        }

        #[tokio::test]
        async fn supervised_key_action_never_admits_when_already_cancelled() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = KeySupervisor::new(sender, Duration::from_secs(1));
            let cancel = crate::v4_agent::interaction::Cancellation::default();
            cancel.cancel();
            assert!(supervisor
                .press(
                    "fixture",
                    json!({"type":"rawKeyDown","key":"Enter"}),
                    json!({"type":"keyUp","key":"Enter"}),
                    cancel
                )
                .await
                .is_err());
            assert!(receiver.try_recv().is_err());
        }

        #[tokio::test]
        async fn supervised_key_action_cancels_while_waiting_for_the_gate() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = Arc::new(KeySupervisor::new(sender, Duration::from_secs(1)));
            let gate = supervisor.gate.lock().await;
            let cancellation = crate::v4_agent::interaction::Cancellation::default();
            let action = {
                let supervisor = supervisor.clone();
                let cancel = cancellation.clone();
                tokio::spawn(async move {
                    supervisor
                        .press(
                            "fixture",
                            json!({"type":"rawKeyDown","key":"Enter"}),
                            json!({"type":"keyUp","key":"Enter"}),
                            cancel,
                        )
                        .await
                })
            };
            cancellation.cancel();
            let result = tokio::time::timeout(Duration::from_millis(300), action)
                .await
                .expect("Cancellation must not wait for a different action's key release");
            assert!(result.unwrap().is_err());
            assert!(receiver.try_recv().is_err());
            drop(gate);
        }

        #[tokio::test]
        async fn supervised_key_actions_are_serialized_until_release_is_acknowledged() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = Arc::new(KeySupervisor::new(sender, Duration::from_secs(2)));
            let start = |key: &'static str| {
                let supervisor = supervisor.clone();
                tokio::spawn(async move {
                    supervisor
                        .press(
                            "fixture",
                            json!({"type":"rawKeyDown","key":key}),
                            json!({"type":"keyUp","key":key}),
                            crate::v4_agent::interaction::Cancellation::default(),
                        )
                        .await
                })
            };
            let first = start("Enter");
            let down = receiver.recv().await.unwrap();
            down.response.send(Ok(json!({}))).unwrap();
            let release = receiver.recv().await.unwrap();
            let second = start("Tab");
            assert!(
                tokio::time::timeout(Duration::from_millis(100), receiver.recv())
                    .await
                    .is_err()
            );
            release.response.send(Ok(json!({}))).unwrap();
            let down = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(down.params["key"], "Tab");
            down.response.send(Ok(json!({}))).unwrap();
            let up = receiver.recv().await.unwrap();
            up.response.send(Ok(json!({}))).unwrap();
            assert!(first.await.unwrap().is_ok());
            assert!(second.await.unwrap().is_ok());
        }

        #[tokio::test]
        async fn supervised_key_action_releases_after_caller_drop_before_down_ack() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = Arc::new(KeySupervisor::new(sender, Duration::from_secs(1)));
            let action = {
                let supervisor = supervisor.clone();
                tokio::spawn(async move {
                    supervisor
                        .press(
                            "fixture",
                            json!({"type":"rawKeyDown","key":"Enter"}),
                            json!({"type":"keyUp","key":"Enter"}),
                            crate::v4_agent::interaction::Cancellation::default(),
                        )
                        .await
                })
            };
            let down = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(down.params["type"], "rawKeyDown");
            action.abort();
            assert!(action.await.unwrap_err().is_cancelled());
            let up = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(up.params["type"], "keyUp");
            up.response.send(Ok(json!({}))).unwrap();
            down.response.send(Ok(json!({}))).unwrap();
            let guard = tokio::time::timeout(Duration::from_secs(2), supervisor.gate.lock())
                .await
                .unwrap();
            assert!(!guard.pressed);
        }

        #[tokio::test]
        async fn supervised_key_action_waits_for_late_down_reply_before_unfencing() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = Arc::new(KeySupervisor::new(sender, Duration::from_secs(2)));
            let cancel = crate::v4_agent::interaction::Cancellation::default();
            let mut action = {
                let supervisor = supervisor.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    supervisor
                        .press(
                            "fixture",
                            json!({"type":"rawKeyDown","key":"Enter"}),
                            json!({"type":"keyUp","key":"Enter"}),
                            cancel,
                        )
                        .await
                })
            };
            let down = receiver.recv().await.unwrap();
            cancel.cancel();
            let up = receiver.recv().await.unwrap();
            up.response.send(Ok(json!({}))).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), &mut action)
                    .await
                    .is_err()
            );
            down.response.send(Ok(json!({}))).unwrap();
            assert!(action.await.unwrap().unwrap_err().contains("cancelled"));
            assert!(!supervisor.gate.lock().await.pressed);
        }

        #[tokio::test]
        async fn closed_key_down_response_keeps_the_browser_fenced() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = Arc::new(KeySupervisor::new(sender, Duration::from_millis(150)));
            let action = {
                let supervisor = supervisor.clone();
                tokio::spawn(async move {
                    supervisor
                        .press(
                            "fixture",
                            json!({"type":"rawKeyDown","key":"Enter"}),
                            json!({"type":"keyUp","key":"Enter"}),
                            crate::v4_agent::interaction::Cancellation::default(),
                        )
                        .await
                })
            };
            let down = receiver.recv().await.unwrap();
            drop(down.response);
            let up = receiver.recv().await.unwrap();
            up.response.send(Ok(json!({}))).unwrap();
            assert!(action.await.unwrap().unwrap_err().contains("unconfirmed"));
            assert!(supervisor.gate.lock().await.pressed);
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn unconfirmed_key_input_retains_settings_and_fences_review_until_cleanup() {
            for missing_down_reply in [false, true] {
                let data = tempfile::tempdir().unwrap();
                let workspace = tempfile::tempdir().unwrap();
                let (mut client, _) =
                    cleanup_test_client(data.path(), "key-owner", workspace.path()).await;
                let lease = Arc::new(browser_settings_lease(data.path(), "key-owner").unwrap());
                let (sender, mut receiver) = mpsc::channel(4);
                let supervisor = Arc::new(KeySupervisor {
                    requests: sender,
                    gate: client.key_gate.clone(),
                    timeout: Duration::from_millis(150),
                });
                let guard = client.key_gate.clone().lock_owned().await;
                let action = {
                    let supervisor = supervisor.clone();
                    tokio::spawn(async move {
                        supervisor
                            .press_locked(
                                guard,
                                "synthetic-session",
                                json!({"type":"rawKeyDown","key":"Enter"}),
                                json!({"type":"keyUp","key":"Enter"}),
                                crate::v4_agent::interaction::Cancellation::default(),
                                Some(lease),
                            )
                            .await
                    })
                };
                let down = receiver.recv().await.unwrap();
                let mut pending_down = Some(down.response);
                drop(down.lease);
                if !missing_down_reply {
                    pending_down.take().unwrap().send(Ok(json!({}))).unwrap();
                }
                let up = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                    .await
                    .unwrap()
                    .unwrap();
                up.response
                    .send(if missing_down_reply {
                        Ok(json!({}))
                    } else {
                        Err("synthetic release failure".into())
                    })
                    .unwrap();
                drop(up.lease);
                assert!(action.await.unwrap().is_err());
                assert!(client
                    .dispatch("browser_tabs", &json!({}), true)
                    .await
                    .unwrap_err()
                    .contains("unconfirmed"));
                assert!(client
                    .review_images(&json!({}))
                    .await
                    .err()
                    .unwrap()
                    .contains("unconfirmed"));
                assert!(save_config(data.path(), "key-owner", &BrowserConfig::default()).is_err());
                assert!(save_config(data.path(), "other-owner", &BrowserConfig::default()).is_ok());
                drop(pending_down);
                client.close().await.unwrap();
                assert!(save_config(data.path(), "key-owner", &BrowserConfig::default()).is_ok());
            }
        }

        #[tokio::test]
        async fn supervised_key_action_fences_input_when_release_is_unconfirmed() {
            let (sender, mut receiver) = mpsc::channel(4);
            let supervisor = Arc::new(KeySupervisor::new(sender, Duration::from_secs(1)));
            let action = {
                let supervisor = supervisor.clone();
                tokio::spawn(async move {
                    supervisor
                        .press(
                            "fixture",
                            json!({"type":"rawKeyDown","key":"Enter"}),
                            json!({"type":"keyUp","key":"Enter"}),
                            crate::v4_agent::interaction::Cancellation::default(),
                        )
                        .await
                })
            };
            let down = receiver.recv().await.unwrap();
            down.response.send(Ok(json!({}))).unwrap();
            let up = receiver.recv().await.unwrap();
            up.response
                .send(Err("fixture release failure".into()))
                .unwrap();
            assert!(action.await.unwrap().unwrap_err().contains("release"));
            assert!(supervisor
                .press(
                    "fixture",
                    json!({"type":"rawKeyDown"}),
                    json!({"type":"keyUp"}),
                    crate::v4_agent::interaction::Cancellation::default()
                )
                .await
                .is_err());
            assert!(receiver.try_recv().is_err());
        }

        #[tokio::test]
        async fn dropping_unshielded_keyboard_action_can_omit_key_up() {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (seen, arrived) = tokio::sync::oneshot::channel();
            let (respond, response_allowed) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let down: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(down["method"], "Input.dispatchKeyEvent");
                assert_eq!(down["params"]["type"], "rawKeyDown");
                seen.send(()).unwrap();
                response_allowed.await.unwrap();
                socket
                    .send(Message::Text(
                        json!({"id":down["id"],"result":{}}).to_string().into(),
                    ))
                    .await
                    .unwrap();
                assert!(
                    tokio::time::timeout(Duration::from_millis(250), socket.next())
                        .await
                        .is_err(),
                    "A dropped future must not be mistaken for a confirmed key release"
                );
            });
            let cdp = Arc::new(
                Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                    .await
                    .unwrap(),
            );
            let action = {
                let cdp = cdp.clone();
                tokio::spawn(async move {
                    cdp.request(
                        "Input.dispatchKeyEvent",
                        json!({"type":"rawKeyDown","key":"Shift"}),
                        Some("fixture-session"),
                    )
                    .await?;
                    cdp.request(
                        "Input.dispatchKeyEvent",
                        json!({"type":"keyUp","key":"Shift"}),
                        Some("fixture-session"),
                    )
                    .await
                })
            };
            tokio::time::timeout(Duration::from_secs(2), arrived)
                .await
                .unwrap()
                .unwrap();
            action.abort();
            assert!(action.await.unwrap_err().is_cancelled());
            respond.send(()).unwrap();
            server.await.unwrap();
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn browser_close_is_bounded_when_the_protocol_stops_answering() {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let _ = socket.next().await;
                tokio::time::sleep(Duration::from_secs(30)).await;
            });
            let config = BrowserConfig {
                timeout_seconds: 60,
                ..Default::default()
            };
            let cdp = Cdp::connect(&format!("ws://{address}"), config)
                .await
                .unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .args(["-c", "sleep 30"])
                .kill_on_drop(true)
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let child = command.spawn().unwrap();
            let tree = crate::process_tree::ProcessTree::attach(&child).unwrap();
            let mut browser = OwnedBrowser {
                identity: uuid::Uuid::new_v4(),
                cdp: Some(cdp),
                tree: Some(tree),
                child: Arc::new(tokio::sync::Mutex::new(child)),
                _profile: OwnedProfile::publish(
                    tempfile::Builder::new()
                        .prefix("isolated-")
                        .tempdir()
                        .unwrap(),
                ),
                cleanup: BrowserCleanup::default(),
                ready: true,
                retiring: false,
                launch_error: None,
                cleanup_probe: None,
                active: None,
                has_opened: false,
            };
            tokio::time::timeout(Duration::from_secs(2), browser.close())
                .await
                .expect("Browser close must not wait for the configured 60-second action timeout")
                .unwrap();
            assert!(browser.child.lock().await.try_wait().unwrap().is_some());
            server.abort();
        }
        #[tokio::test]
        async fn correlates_out_of_order_responses_while_processing_async_events() {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let first: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                let second: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                socket
                    .send(Message::Text(
                        json!({"method":"Runtime.consoleAPICalled","params":{"type":"log"}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                for request in [second, first] {
                    socket
                        .send(Message::Text(
                            json!({"id":request["id"],"result":{"method":request["method"]}})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            });
            let cdp = Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                .await
                .unwrap();
            let (a, b) = tokio::join!(
                cdp.request("First", json!({}), None),
                cdp.request("Second", json!({}), None)
            );
            assert_eq!(
                (a.unwrap(), b.unwrap()),
                (json!({"method":"First"}), json!({"method":"Second"}))
            );
            server.await.unwrap();
        }
        #[tokio::test]
        async fn rejects_unknown_response_ids_and_times_out_unanswered_requests() {
            for wrong_id in [true, false] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let _ = socket.next().await;
                    if wrong_id {
                        let _ = socket
                            .send(Message::Text(
                                json!({"id":999,"result":{}}).to_string().into(),
                            ))
                            .await;
                    }
                    tokio::time::sleep(Duration::from_millis(1300)).await;
                });
                let config = BrowserConfig {
                    timeout_seconds: 1,
                    ..BrowserConfig::default()
                };
                let cdp = Cdp::connect(&format!("ws://{address}"), config)
                    .await
                    .unwrap();
                let result = cdp.request("Test", json!({}), None).await.unwrap_err();
                assert!(
                    result.contains(if wrong_id { "response ID" } else { "timed out" }),
                    "{result}"
                );
                server.await.unwrap();
            }
        }
        #[tokio::test]
        async fn blocks_unapproved_http_requests_and_cancels_authentication_challenges() {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                for event in [
                    json!({"method":"Fetch.requestPaused","sessionId":"test-session","params":{"requestId":"blocked","request":{"url":"https://unapproved.example/private"}}}),
                    json!({"method":"Fetch.authRequired","sessionId":"test-session","params":{"requestId":"auth"}}),
                ] {
                    socket
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .unwrap();
                    let response: Value = serde_json::from_str(
                        socket.next().await.unwrap().unwrap().to_text().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(response["sessionId"], "test-session");
                    if response["method"] == "Fetch.failRequest" {
                        assert_eq!(
                            response["params"],
                            json!({"requestId":"blocked","errorReason":"BlockedByClient"})
                        );
                    } else {
                        assert_eq!(response["method"], "Fetch.continueWithAuth");
                        assert_eq!(
                            response["params"]["authChallengeResponse"]["response"],
                            "CancelAuth"
                        );
                    }
                    socket
                        .send(Message::Text(
                            json!({"id":response["id"],"result":{}}).to_string().into(),
                        ))
                        .await
                        .unwrap();
                }
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":{"ok":true}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            });
            let cdp = Cdp::connect(&format!("ws://{address}"), BrowserConfig::default())
                .await
                .unwrap();
            assert_eq!(
                cdp.request("Test", json!({}), None).await.unwrap(),
                json!({"ok":true})
            );
            server.await.unwrap();
        }
    }
    mod chromium_io {
        use super::*;
        fn executable() -> Option<String> {
            let configured = std::env::var("V4_TEST_BROWSER_BIN").ok();
            configured.or_else(||{let path="/Users/conordart/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";Path::new(path).is_file().then(||path.into())})
        }
        async fn fixture() -> (String, tokio::task::JoinHandle<()>, tokio::net::TcpListener) {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let blocked = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let blocked_address = blocked.local_addr().unwrap();
            let server = tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        break;
                    };
                    tokio::spawn(async move {
                        let mut bytes = [0; 8192];
                        let count = stream.read(&mut bytes).await.unwrap_or(0);
                        let second =
                            String::from_utf8_lossy(&bytes[..count]).starts_with("GET /second ");
                        let title = if second {
                            "Second fixture"
                        } else {
                            "V4 browser fixture"
                        };
                        let body = format!(
                            r#"<!doctype html><html><head><title>{title}</title></head><body><h1>{title}</h1><label>Name<input id="name"></label><label>Quantity<input id="quantity" type="number" value="12"></label><label>Password<input id="password" type="password" value="fixture-secret"></label><button id="increment" onclick="this.textContent='Count '+(++window.count)">Count 0</button><select id="choice" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><a href="/second">Next page</a><a href="/second" target="_blank">Popup</a><img src="http://{blocked_address}/blocked"><div style="height:2000px">Long page</div><script>window.count=0</script></body></html>"#
                        );
                        let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                    });
                }
            });
            (format!("http://{address}"), server, blocked)
        }
        #[tokio::test]
        async fn console_and_dialog_tools_are_bound_to_the_reviewed_document() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "console-review-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            let result: Result<(), String> = async {
                client.dispatch("browser_open", &json!({"url":format!("{origin}/")}), true).await?;
                client.dispatch("browser_evaluate", &json!({"script":"console.log('hello', 3, 'password=hunter2');console.error('bad thing');setTimeout(()=>{throw new Error('later boom')},0);true"}), true).await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
                let input = json!({});
                let review = client.review_document("browser_console", &input).await?;
                let read = client.execute_review_for_test("browser_console", &input, &review).await?;
                let texts: Vec<_> = read["messages"].as_array().unwrap().iter().map(|row| (row["level"].as_str().unwrap(), row["text"].as_str().unwrap().lines().next().unwrap().to_owned())).collect();
                assert_eq!(
                    texts,
                    vec![
                        ("log", "hello 3 password=[redacted]".to_owned()),
                        ("error", "bad thing".to_owned()),
                        ("error", "Error: later boom".to_owned()),
                    ]
                );
                let errors = client.execute_review_for_test("browser_console", &json!({"level":"error","limit":1}), &review).await?;
                assert_eq!((errors["messages"].as_array().unwrap().len(), errors["olderOmitted"].clone()), (1, json!(1)));

                let dismissed = client.dispatch("browser_evaluate", &json!({"script":"confirm('Proceed?')"}), true).await?;
                assert_eq!(dismissed, json!(false));
                let dialog_review = client.review_document("browser_dialog", &json!({"action":"accept"})).await?;
                let armed = client.execute_review_for_test("browser_dialog", &json!({"action":"accept"}), &dialog_review).await?;
                assert_eq!(armed["armed"], json!(true));
                assert_eq!(client.dispatch("browser_evaluate", &json!({"script":"confirm('Proceed?')"}), true).await?, json!(true));
                assert_eq!(client.dispatch("browser_evaluate", &json!({"script":"confirm('Again?')"}), true).await?, json!(false));
                let logged = client.execute_review_for_test("browser_console", &input, &review).await?;
                let dialogs: Vec<_> = logged["dialogs"].as_array().unwrap().iter().map(|row| (row["message"].as_str().unwrap().to_owned(), row["accepted"].as_bool().unwrap())).collect();
                assert_eq!(
                    dialogs,
                    vec![("Proceed?".to_owned(), false), ("Proceed?".to_owned(), true), ("Again?".to_owned(), false)]
                );

                client.dispatch("browser_navigate", &json!({"url":format!("{origin}/second")}), true).await?;
                assert!(client.execute_review_for_test("browser_console", &input, &review).await.is_err());
                assert!(client.execute_review_for_test("browser_dialog", &json!({"action":"accept"}), &dialog_review).await.is_err());
                let fresh = client.review_document("browser_console", &input).await?;
                let after = client.execute_review_for_test("browser_console", &input, &fresh).await?;
                assert_eq!(after["messages"], json!([]));
                Ok(())
            }.await;
            client.close().await.unwrap();
            server.abort();
            result.unwrap();
        }
        #[tokio::test]
        async fn image_review_is_bound_to_the_isolated_document() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "image-review-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            client
                .dispatch("browser_open", &json!({"url":format!("{origin}/")}), true)
                .await
                .unwrap();
            let review = client.review_images(&json!({})).await.unwrap();
            assert_eq!(
                client
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"typeof globalThis.__v4DocumentReview"}),
                        true
                    )
                    .await
                    .unwrap(),
                json!("undefined")
            );
            let first = client.read_reviewed_images_for_test(&review).await.unwrap();
            assert_eq!(first["images"].as_array().unwrap().len(), 1);
            client
                .dispatch(
                    "browser_evaluate",
                    &json!({"script":"history.pushState({}, '', '/same-document'); true"}),
                    true,
                )
                .await
                .unwrap();
            assert_eq!(
                client.read_reviewed_images_for_test(&review).await.unwrap()["images"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            client
                .dispatch(
                    "browser_navigate",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            assert!(
                client.read_reviewed_images_for_test(&review).await.is_err(),
                "A replacement document must require a fresh approval"
            );
            let next = client.review_images(&json!({})).await.unwrap();
            assert_eq!(
                client.read_reviewed_images_for_test(&next).await.unwrap()["images"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            client.close().await.unwrap();
            assert!(client.read_reviewed_images_for_test(&next).await.is_err());
            client
                .dispatch("browser_open", &json!({"url":format!("{origin}/")}), true)
                .await
                .unwrap();
            assert!(
                client.read_reviewed_images_for_test(&next).await.is_err(),
                "A replacement browser must not inherit an old review"
            );
            client.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn isolated_image_integration_rejects_denial_and_stale_review() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "isolated-image-integration";
            let session = uuid::Uuid::new_v4().to_string();
            save_config(
                data.path(),
                owner,
                &BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            let mut state = crate::v4_agent::integrations::Integrations::default();
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/")}),
                    true,
                )
                .await
                .unwrap();
            let input = json!({});
            let review = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_get_images",
                    &input,
                )
                .await
                .unwrap();
            assert!(review.description.contains(&origin));
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_get_images",
                    &input,
                    false,
                    Some(&review)
                )
                .await
                .is_err());
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_navigate",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_get_images",
                    &input,
                    true,
                    Some(&review)
                )
                .await
                .is_err());
            let fresh = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_get_images",
                    &input,
                )
                .await
                .unwrap();
            let other_workspace = tempfile::tempdir().unwrap();
            assert!(state
                .prepare_review(
                    data.path(),
                    owner,
                    other_workspace.path(),
                    "browser_get_images",
                    &input
                )
                .await
                .is_err());
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_get_images",
                    &json!({"tabId":"forged"}),
                    true,
                    Some(&fresh)
                )
                .await
                .is_err());
            let result = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_get_images",
                    &input,
                    true,
                    Some(&fresh),
                )
                .await
                .unwrap();
            assert!(result.text.contains("images"));
            let previous = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_get_images",
                    &input,
                )
                .await
                .unwrap();
            let original = load_config(data.path(), owner).unwrap();
            let mut disabled = original.clone();
            disabled.enabled = false;
            save_config(data.path(), owner, &disabled).unwrap();
            save_config(data.path(), owner, &original).unwrap();
            assert!(
                state
                    .dispatch_reviewed(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_get_images",
                        &input,
                        true,
                        Some(&previous)
                    )
                    .await
                    .is_err(),
                "A revoked approval must not revive when settings return to their previous values"
            );
            state.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn isolated_navigation_approval_does_not_survive_settings_revocation() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "navigation-review-owner";
            let session = uuid::Uuid::new_v4().to_string();
            let original = BrowserConfig {
                enabled: true,
                executable: Some(executable),
                allowed_origins: vec![origin.clone()],
                ..Default::default()
            };
            save_config(data.path(), owner, &original).unwrap();
            let mut state = crate::v4_agent::integrations::Integrations::default();
            let input = json!({"url":format!("{origin}/")});
            let review = state
                .prepare_review(data.path(), owner, workspace.path(), "browser_open", &input)
                .await
                .unwrap();
            let mut revoked = original.clone();
            revoked.enabled = false;
            save_config(data.path(), owner, &revoked).unwrap();
            save_config(data.path(), owner, &original).unwrap();
            assert!(
                state
                    .dispatch_reviewed(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_open",
                        &input,
                        true,
                        Some(&review)
                    )
                    .await
                    .is_err(),
                "A revoked navigation approval must not revive when settings are restored"
            );
            let fresh = state
                .prepare_review(data.path(), owner, workspace.path(), "browser_open", &input)
                .await
                .unwrap();
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &input,
                    true,
                    Some(&fresh)
                )
                .await
                .is_ok());
            let other_owner = "other-navigation-owner";
            save_config(data.path(), other_owner, &original).unwrap();
            let tabs = json!({});
            let foreign = state
                .prepare_review(
                    data.path(),
                    other_owner,
                    workspace.path(),
                    "browser_tabs",
                    &tabs,
                )
                .await
                .unwrap();
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    other_owner,
                    workspace.path(),
                    &session,
                    "browser_tabs",
                    &tabs,
                    true,
                    Some(&foreign)
                )
                .await
                .is_err());
            let other_workspace = tempfile::tempdir().unwrap();
            let wrong_workspace = state
                .prepare_review(
                    data.path(),
                    owner,
                    other_workspace.path(),
                    "browser_tabs",
                    &tabs,
                )
                .await
                .unwrap();
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    other_workspace.path(),
                    &session,
                    "browser_tabs",
                    &tabs,
                    true,
                    Some(&wrong_workspace)
                )
                .await
                .is_err());
            assert!(
                state
                    .dispatch(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_tabs",
                        &tabs,
                        true
                    )
                    .await
                    .is_ok(),
                "A foreign request must not close the original browser"
            );
            state.close().await.unwrap();
            server.abort();
        }

        #[tokio::test]
        async fn isolated_snapshot_approval_cannot_read_replacement_document() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "snapshot-review-owner";
            let session = uuid::Uuid::new_v4().to_string();
            save_config(
                data.path(),
                owner,
                &BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            let mut state = crate::v4_agent::integrations::Integrations::default();
            let opened = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/")}),
                    true,
                )
                .await
                .unwrap();
            let first_tab = serde_json::from_str::<Value>(&opened.text).unwrap()["tabId"]
                .as_str()
                .unwrap()
                .to_owned();
            let input = json!({});
            let review = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_snapshot",
                    &input,
                )
                .await
                .unwrap();
            assert!(state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_snapshot",
                    &input,
                    false,
                    Some(&review)
                )
                .await
                .is_err());
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            let original = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_snapshot",
                    &input,
                    true,
                    Some(&review),
                )
                .await
                .unwrap();
            assert!(
                original.text.contains("V4 browser fixture"),
                "Changing the active tab must not retarget the reviewed read"
            );
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_navigate",
                    &json!({"url":format!("{origin}/second"),"tabId":first_tab}),
                    true,
                )
                .await
                .unwrap();
            assert!(
                state
                    .dispatch_reviewed(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_snapshot",
                        &input,
                        true,
                        Some(&review)
                    )
                    .await
                    .is_err(),
                "A reviewed snapshot must not read a replacement document"
            );
            let fresh = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_snapshot",
                    &input,
                )
                .await
                .unwrap();
            let result = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_snapshot",
                    &input,
                    true,
                    Some(&fresh),
                )
                .await
                .unwrap();
            assert!(result.text.contains("Second fixture"));
            state.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn isolated_script_approval_is_bound_to_the_original_document() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "script-review-owner";
            let session = uuid::Uuid::new_v4().to_string();
            save_config(
                data.path(),
                owner,
                &BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            let mut state = crate::v4_agent::integrations::Integrations::default();
            let opened = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/")}),
                    true,
                )
                .await
                .unwrap();
            let first_tab = serde_json::from_str::<Value>(&opened.text).unwrap()["tabId"]
                .as_str()
                .unwrap()
                .to_owned();
            let input = json!({"script":"window.v4ApprovalTarget = document.title; document.body.innerText.includes('V4 browser fixture')"});
            let review = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_evaluate",
                    &input,
                )
                .await
                .unwrap();
            assert!(
                state
                    .dispatch_reviewed(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_evaluate",
                        &json!({"script":"window.v4ApprovalTarget = 'changed'"}),
                        true,
                        Some(&review)
                    )
                    .await
                    .is_err(),
                "Approval must not authorize a different script"
            );
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            let result = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_evaluate",
                    &input,
                    true,
                    Some(&review),
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&result.text).unwrap(),
                json!(true),
                "The script must run in the reviewed tab"
            );
            let active = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_evaluate",
                    &json!({"script":"typeof window.v4ApprovalTarget"}),
                    true,
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&active.text).unwrap(),
                json!("undefined"),
                "The other tab must remain unchanged"
            );
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_navigate",
                    &json!({"url":format!("{origin}/second"),"tabId":first_tab}),
                    true,
                )
                .await
                .unwrap();
            assert!(
                state
                    .dispatch_reviewed(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_evaluate",
                        &input,
                        true,
                        Some(&review)
                    )
                    .await
                    .is_err(),
                "The script must not run in a replacement document"
            );
            state.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn standalone_document_actions_without_review_are_rejected() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "unreviewed-snapshot-owner";
            let config = BrowserConfig {
                enabled: true,
                executable: Some(executable),
                allowed_origins: vec![origin.clone()],
                ..Default::default()
            };
            save_config(data.path(), owner, &config).unwrap();
            let mut client =
                BrowserClient::new(data.path(), owner, workspace.path(), config).unwrap();
            client
                .dispatch("browser_open", &json!({"url":format!("{origin}/")}), true)
                .await
                .unwrap();
            for (name, input) in [
                ("browser_snapshot", json!({})),
                ("browser_get_images", json!({})),
                ("browser_select", json!({"ref":"missing","value":"a"})),
                ("browser_wait", json!({"text":"fixture"})),
                ("browser_evaluate", json!({"script":"true"})),
            ] {
                let lease = Arc::new(browser_settings_lease(data.path(), owner).unwrap());
                let error = client
                    .dispatch_with_settings_lease(
                        name,
                        &input,
                        true,
                        &crate::v4_agent::interaction::Cancellation::default(),
                        lease,
                    )
                    .await
                    .unwrap_err();
                assert!(
                    error.contains("reviewed browser document"),
                    "{name}: {error}"
                );
            }
            client.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn isolated_select_stays_on_reviewed_tab_after_active_tab_changes() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "select-review-owner";
            let session = uuid::Uuid::new_v4().to_string();
            save_config(
                data.path(),
                owner,
                &BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            let mut state = crate::v4_agent::integrations::Integrations::default();
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/")}),
                    true,
                )
                .await
                .unwrap();
            let snapshot = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_snapshot",
                    &json!({}),
                    true,
                )
                .await
                .unwrap();
            let rows: Value = serde_json::from_str(&snapshot.text).unwrap();
            let reference = rows["elements"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == "Choice")
                .unwrap()["ref"]
                .clone();
            let input = json!({"ref":reference,"value":"b"});
            let review = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_select",
                    &input,
                )
                .await
                .unwrap();
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            let selected = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_select",
                    &input,
                    true,
                    Some(&review),
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&selected.text).unwrap(),
                json!({"selected":"b"})
            );
            let other = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_evaluate",
                    &json!({"script":"document.querySelector('#choice').value"}),
                    true,
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&other.text).unwrap(),
                json!("a")
            );
            let snapshot = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_snapshot",
                    &json!({}),
                    true,
                )
                .await
                .unwrap();
            let rows: Value = serde_json::from_str(&snapshot.text).unwrap();
            let reference = rows["elements"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == "Choice")
                .unwrap()["ref"]
                .clone();
            let error = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_select",
                    &json!({"ref":reference,"value":"missing"}),
                    true,
                )
                .await
                .err()
                .unwrap();
            assert!(error.contains("Option is unavailable"), "{error}");
            state.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn isolated_wait_uses_reviewed_document_after_active_tab_changes() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let (origin, server, _blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let owner = "wait-review-owner";
            let session = uuid::Uuid::new_v4().to_string();
            save_config(
                data.path(),
                owner,
                &BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    allowed_origins: vec![origin.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
            let mut state = crate::v4_agent::integrations::Integrations::default();
            let opened = state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/")}),
                    true,
                )
                .await
                .unwrap();
            let tab = serde_json::from_str::<Value>(&opened.text).unwrap()["tabId"]
                .as_str()
                .unwrap()
                .to_owned();
            let input = json!({"text":"V4 browser fixture","timeoutMs":500});
            let review = state
                .prepare_review(data.path(), owner, workspace.path(), "browser_wait", &input)
                .await
                .unwrap();
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_open",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            let result = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_wait",
                    &input,
                    true,
                    Some(&review),
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&result.text).unwrap(),
                json!({"matched":true})
            );
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_navigate",
                    &json!({"url":format!("{origin}/second"),"tabId":tab}),
                    true,
                )
                .await
                .unwrap();
            assert!(
                state
                    .dispatch_reviewed(
                        data.path(),
                        owner,
                        workspace.path(),
                        &session,
                        "browser_wait",
                        &input,
                        true,
                        Some(&review)
                    )
                    .await
                    .is_err(),
                "A replacement document must invalidate the wait approval"
            );
            state
                .dispatch(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_navigate",
                    &json!({"url":format!("{origin}/"),"tabId":tab}),
                    true,
                )
                .await
                .unwrap();
            state.dispatch(data.path(), owner, workspace.path(), &session, "browser_evaluate", &json!({"script":"setTimeout(() => location.href='/second', 1200); true","tabId":tab}), true).await.unwrap();
            let waiting = json!({"text":"Second fixture","timeoutMs":5000,"tabId":tab});
            let waiting_review = state
                .prepare_review(
                    data.path(),
                    owner,
                    workspace.path(),
                    "browser_wait",
                    &waiting,
                )
                .await
                .unwrap();
            let error = state
                .dispatch_reviewed(
                    data.path(),
                    owner,
                    workspace.path(),
                    &session,
                    "browser_wait",
                    &waiting,
                    true,
                    Some(&waiting_review),
                )
                .await
                .err()
                .unwrap();
            assert!(error.contains("reviewed browser document"), "{error}");
            state.close().await.unwrap();
            server.abort();
        }
        #[tokio::test]
        async fn typed_text_stays_with_reviewed_element_after_focus_microtask() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "synthetic-type-focus-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    ..Default::default()
                },
            )
            .unwrap();
            let result: Result<(), String> = async {
                client.dispatch("browser_open", &json!({}), true).await?;
                client.dispatch("browser_evaluate", &json!({"script":"document.body.innerHTML='<input aria-label=Reviewed><input aria-label=Other>';const [a,b]=document.querySelectorAll('input');a.addEventListener('focus',()=>queueMicrotask(()=>b.focus()));true"}), true).await?;
                let snapshot = client.dispatch("browser_snapshot", &json!({}), true).await?;
                let reference = snapshot["elements"].as_array().unwrap().iter().find(|row| row["name"] == "Reviewed").unwrap()["ref"].clone();
                let typed = client.dispatch("browser_type", &json!({"ref":reference,"text":"approved"}), true).await;
                let values = client.dispatch("browser_evaluate", &json!({"script":"Array.from(document.querySelectorAll('input'), e => e.value)"}), true).await?;
                assert_eq!(values, if typed.is_ok() { json!(["approved", ""]) } else { json!(["", ""]) });
                Ok(())
            }.await;
            client.close().await.unwrap();
            result.unwrap();
        }

        #[tokio::test]
        async fn disabled_keyboard_prototype_can_retarget_after_focus_microtask() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "synthetic-focus-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    ..Default::default()
                },
            )
            .unwrap();
            let result: Result<(), String> = async {
                client.dispatch("browser_open", &json!({}), true).await?;
                client.dispatch("browser_evaluate", &json!({"script":"document.body.innerHTML='<input aria-label=Reviewed><input aria-label=Other>';window.keyTargets=[];const [a,b]=document.querySelectorAll('input');a.addEventListener('focus',()=>queueMicrotask(()=>b.focus()));for(const e of [a,b])e.addEventListener('keydown',()=>window.keyTargets.push(e.getAttribute('aria-label')));true"}), true).await?;
                let snapshot = client.dispatch("browser_snapshot", &json!({}), true).await?;
                let reference = snapshot["elements"].as_array().unwrap().iter().find(|row| row["name"] == "Reviewed").unwrap()["ref"].clone();
                client.dispatch("browser_press", &json!({"ref":reference,"key":"Enter"}), true).await?;
                assert_eq!(client.dispatch("browser_evaluate", &json!({"script":"window.keyTargets"}), true).await?, json!(["Other"]));
                Ok(())
            }.await;
            client.close().await.unwrap();
            result.unwrap();
        }
        #[tokio::test]
        async fn isolated_keyboard_press_uses_the_reviewed_element_and_releases_the_key() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN");
                return;
            };
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "synthetic-key-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    ..Default::default()
                },
            )
            .unwrap();
            save_config(data.path(), "synthetic-key-owner", &client.config).unwrap();
            let result: Result<(), String> = async {
                client.dispatch("browser_open", &json!({}), true).await?;
                client.dispatch("browser_evaluate", &json!({"script":"document.body.innerHTML='<input aria-label=Target>';window.events=[];const e=document.querySelector('input');for(const type of ['keydown','keyup'])e.addEventListener(type,x=>events.push([type,x.key,x.ctrlKey]));true"}), true).await?;
                let snapshot = client.dispatch("browser_snapshot", &json!({}), true).await?;
                let reference = snapshot["elements"][0]["ref"].clone();
                assert!(client.dispatch("browser_press", &json!({"ref":reference,"key":"Control+Enter"}), false).await.is_err());
                assert!(client.dispatch("browser_press", &json!({"ref":reference,"key":"Control+Control+Enter"}), true).await.is_err());
                let pressed = client.dispatch("browser_press", &json!({"ref":reference,"key":"Control+Enter"}), true).await?;
                assert_eq!(pressed, json!({"pressed":"Control+Enter"}));
                assert_eq!(client.dispatch("browser_evaluate", &json!({"script":"window.events"}), true).await?, json!([["keydown","Enter",true],["keyup","Enter",true]]));
                client.dispatch("browser_evaluate", &json!({"script":"document.querySelector('input').remove();true"}), true).await?;
                assert!(client.dispatch("browser_press", &json!({"ref":reference,"key":"Enter"}), true).await.is_err());
                Ok(())
            }.await;
            client.close().await.unwrap();
            result.unwrap();
        }
        #[tokio::test]
        async fn repair_t4_reinserted_node_snapshot_ref_resolves() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN to an isolated test Chromium executable");
                return;
            };
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let mut client = BrowserClient::new(
                data.path(),
                "synthetic-ref-owner",
                workspace.path(),
                BrowserConfig {
                    enabled: true,
                    executable: Some(executable),
                    ..Default::default()
                },
            )
            .unwrap();
            let result: Result<(), String> = async {
                client.dispatch("browser_open", &json!({}), true).await?;
                client.dispatch("browser_evaluate", &json!({"script":"document.body.innerHTML='<button>Fixture</button>';window.retained=document.querySelector('button');window.clicks=0;retained.onclick=()=>clicks++;true"}), true).await?;
                let initial = client.dispatch("browser_snapshot", &json!({}), true).await?;
                let reference = initial["elements"][0]["ref"].clone();
                client.dispatch("browser_evaluate", &json!({"script":"retained.remove();document.body.append(retained);true"}), true).await?;
                client.dispatch("browser_click", &json!({"ref":reference}), true).await?;
                client.dispatch("browser_evaluate", &json!({"script":"retained.remove();true"}), true).await?;
                let absent = client.dispatch("browser_snapshot", &json!({}), true).await?;
                assert_eq!(absent["elements"], json!([]));
                assert!(client.dispatch("browser_click", &json!({"ref":reference}), true).await.is_err());
                client.dispatch("browser_evaluate", &json!({"script":"document.body.append(retained);true"}), true).await?;
                for _ in 0..2 {
                    let current = client.dispatch("browser_snapshot", &json!({}), true).await?;
                    assert_eq!(current["elements"][0]["ref"], reference);
                    client.dispatch("browser_click", &json!({"ref":current["elements"][0]["ref"]}), true).await?;
                }
                let clicks = client.dispatch("browser_evaluate", &json!({"script":"window.clicks"}), true).await?;
                assert_eq!(clicks, 3);
                Ok(())
            }.await;
            client.close().await.unwrap();
            result.unwrap();
        }
        #[tokio::test]
        async fn real_chromium_tools_use_only_a_new_isolated_process_and_profile() {
            let Some(executable) = executable() else {
                eprintln!("V4 browser fixture skipped: set V4_TEST_BROWSER_BIN to an isolated test Chromium executable");
                return;
            };
            let (origin, server, blocked) = fixture().await;
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let config = BrowserConfig {
                enabled: true,
                executable: Some(executable.clone()),
                allowed_origins: vec![origin.clone()],
                ..BrowserConfig::default()
            };
            let mut client = BrowserClient::new(
                data.path(),
                "fixture-owner",
                workspace.path(),
                config.clone(),
            )
            .unwrap();
            let opened = client
                .dispatch("browser_open", &json!({"url":format!("{origin}/")}), true)
                .await
                .unwrap();
            assert_eq!(opened["page"]["title"], "V4 browser fixture");
            assert!(client
                .dispatch("browser_get_images", &json!({}), false)
                .await
                .is_err());
            assert!(client
                .dispatch("browser_get_images", &json!({}), true)
                .await
                .is_err());
            let review = client.review_images(&json!({})).await.unwrap();
            let images = client.read_reviewed_images_for_test(&review).await.unwrap();
            assert_eq!(
                images["images"],
                json!([{"url":format!("http://{}/blocked", blocked.local_addr().unwrap()),"alt":"","inline":false}])
            );
            assert_eq!(images["truncated"], false);
            let profile = client.browser.as_ref().unwrap()._profile.path().to_owned();
            assert!(profile.starts_with(
                config_directory(data.path(), "fixture-owner")
                    .unwrap()
                    .canonicalize()
                    .unwrap()
            ));
            assert!(profile.is_dir());
            let snapshot = client
                .dispatch("browser_snapshot", &json!({}), true)
                .await
                .unwrap();
            let repeated = client
                .dispatch("browser_snapshot", &json!({}), true)
                .await
                .unwrap();
            assert_eq!(snapshot["elements"], repeated["elements"]);
            let element = |name: &str| {
                snapshot["elements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["name"] == name)
                    .unwrap()["ref"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            };
            let button = element("Count 0");
            let input = element("Name");
            let choice = element("Choice");
            assert_eq!(
                snapshot["elements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["name"] == "Password")
                    .unwrap()["value"],
                "[redacted]"
            );
            client
                .dispatch("browser_click", &json!({"ref":button}), true)
                .await
                .unwrap();
            client
                .dispatch(
                    "browser_wait",
                    &json!({"text":"Count 1","timeoutMs":2000}),
                    true,
                )
                .await
                .unwrap();
            client
                .dispatch(
                    "browser_type",
                    &json!({"ref":input,"text":"Original V4 ✓ 'quoted'"}),
                    true,
                )
                .await
                .unwrap();
            client
                .dispatch("browser_select", &json!({"ref":choice,"value":"b"}), true)
                .await
                .unwrap();
            assert_eq!(client.dispatch("browser_evaluate",&json!({"script":"({name:document.querySelector('#name').value,choice:document.querySelector('#choice').value})"}),true).await.unwrap(),json!({"name":"Original V4 ✓ 'quoted'","choice":"b"}));
            client.dispatch("browser_evaluate",&json!({"script":"document.querySelector('#name').style.display='none';document.querySelector('#password').focus();true"}),true).await.unwrap();
            assert!(
                client
                    .dispatch(
                        "browser_type",
                        &json!({"ref":input,"text":"must-not-enter-password"}),
                        true
                    )
                    .await
                    .is_err(),
                "Hidden input ref must never type into a different focused control"
            );
            assert_eq!(
                client
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"document.querySelector('#password').value"}),
                        true
                    )
                    .await
                    .unwrap(),
                "fixture-secret"
            );
            client
                .dispatch(
                    "browser_evaluate",
                    &json!({"script":"document.querySelector('#name').style.display='';true"}),
                    true,
                )
                .await
                .unwrap();
            client
                .dispatch("browser_type", &json!({"ref":input,"text":""}), true)
                .await
                .unwrap();
            assert_eq!(
                client
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"document.querySelector('#name').value"}),
                        true
                    )
                    .await
                    .unwrap(),
                ""
            );
            let quantity = element("Quantity");
            client
                .dispatch("browser_type", &json!({"ref":quantity,"text":"42"}), true)
                .await
                .unwrap();
            assert_eq!(
                client
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"document.querySelector('#quantity').value"}),
                        true
                    )
                    .await
                    .unwrap(),
                "42"
            );
            client
                .dispatch("browser_type", &json!({"ref":quantity,"text":""}), true)
                .await
                .unwrap();
            assert_eq!(
                client
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"document.querySelector('#quantity').value"}),
                        true
                    )
                    .await
                    .unwrap(),
                ""
            );
            let screenshot = client
                .dispatch("browser_screenshot", &json!({}), true)
                .await
                .unwrap();
            assert_eq!(screenshot["mimeType"], "image/png");
            assert!(screenshot["data"]
                .as_str()
                .unwrap()
                .starts_with("iVBORw0KGgo"));
            client
                .dispatch("browser_scroll", &json!({"deltaY":400}), true)
                .await
                .unwrap();
            client
                .dispatch("browser_wait", &json!({"text":"Long page"}), true)
                .await
                .unwrap();
            let scroll=client.dispatch("browser_evaluate",&json!({"script":"new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(scrollY))))"}),true).await.unwrap();
            assert!(
                scroll.as_f64().unwrap() > 0.0,
                "Wheel input did not scroll the document"
            );
            assert!(client
                .dispatch("browser_scroll", &json!({"deltaY":i64::MIN}), true)
                .await
                .is_err());
            let second = client
                .dispatch(
                    "browser_navigate",
                    &json!({"url":format!("{origin}/second")}),
                    true,
                )
                .await
                .unwrap();
            assert_eq!(second["title"], "Second fixture");
            client
                .dispatch("browser_snapshot", &json!({}), true)
                .await
                .unwrap();
            assert!(client
                .dispatch("browser_click", &json!({"ref":button}), true)
                .await
                .unwrap_err()
                .contains("Stale"));
            assert_eq!(
                client
                    .dispatch("browser_back", &json!({}), true)
                    .await
                    .unwrap()["title"],
                "V4 browser fixture"
            );
            assert_eq!(
                client
                    .dispatch("browser_forward", &json!({}), true)
                    .await
                    .unwrap()["title"],
                "Second fixture"
            );
            let current = client
                .dispatch("browser_snapshot", &json!({}), true)
                .await
                .unwrap();
            let popup_ref = current["elements"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == "Popup")
                .unwrap()["ref"]
                .as_str()
                .unwrap();
            client
                .dispatch("browser_click", &json!({"ref":popup_ref}), true)
                .await
                .unwrap();
            let popup_id = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let tabs = client
                        .dispatch("browser_tabs", &json!({}), true)
                        .await
                        .unwrap();
                    if let Some(tab) = tabs["tabs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|tab| tab["id"] != opened["tabId"])
                    {
                        break tab["id"].as_str().unwrap().to_owned();
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .unwrap();
            let popup_snapshot = client
                .dispatch("browser_snapshot", &json!({"tabId":popup_id}), true)
                .await
                .unwrap();
            assert_eq!(popup_snapshot["title"], "Second fixture");
            client
                .dispatch("browser_close", &json!({"tabId":popup_id}), true)
                .await
                .unwrap();
            let other = client
                .dispatch("browser_open", &json!({}), true)
                .await
                .unwrap();
            assert_eq!(other["page"]["url"], "about:blank");
            assert_eq!(
                client
                    .dispatch("browser_tabs", &json!({}), true)
                    .await
                    .unwrap()["tabs"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
            client
                .dispatch("browser_close", &json!({"tabId":other["tabId"]}), true)
                .await
                .unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), blocked.accept())
                    .await
                    .is_err(),
                "Unapproved subresource origin reached the network"
            );
            let mut independent =
                BrowserClient::new(data.path(), "second-owner", workspace.path(), config).unwrap();
            independent
                .dispatch("browser_open", &json!({"url":format!("{origin}/")}), true)
                .await
                .unwrap();
            assert_ne!(
                independent.browser.as_ref().unwrap()._profile.path(),
                profile
            );
            assert_eq!(
                independent
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"localStorage.getItem('v4Fixture')"}),
                        true
                    )
                    .await
                    .unwrap(),
                Value::Null
            );
            client
                .dispatch(
                    "browser_evaluate",
                    &json!({"script":"localStorage.setItem('v4Fixture','private-fixture')"}),
                    true,
                )
                .await
                .unwrap();
            assert_eq!(
                independent
                    .dispatch(
                        "browser_evaluate",
                        &json!({"script":"localStorage.getItem('v4Fixture')"}),
                        true
                    )
                    .await
                    .unwrap(),
                Value::Null
            );
            independent
                .dispatch("browser_close", &json!({}), true)
                .await
                .unwrap();
            let active_id = client.browser.as_ref().unwrap().active.clone().unwrap();
            client
                .dispatch("browser_close", &json!({"tabId":active_id}), true)
                .await
                .unwrap();
            assert!(client.browser.is_none());
            assert!(!profile.exists());
            client
                .dispatch("browser_open", &json!({}), true)
                .await
                .unwrap();
            client
                .dispatch("browser_close", &json!({}), true)
                .await
                .unwrap();
            assert!(!profile.exists());
            server.abort();
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn dropping_browser_stops_owned_descendants_and_retains_unconfirmed_profile() {
            let Some(executable) = executable() else {
                return;
            };
            let data = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let config = BrowserConfig {
                enabled: true,
                executable: Some(executable),
                ..Default::default()
            };
            let mut client =
                BrowserClient::new(data.path(), "drop-fixture", workspace.path(), config).unwrap();
            client
                .dispatch("browser_open", &json!({}), true)
                .await
                .unwrap();
            let browser = client.browser.as_ref().unwrap();
            let profile = browser._profile.path().to_owned();
            let processes = browser
                .cdp()
                .unwrap()
                .request("SystemInfo.getProcessInfo", json!({}), None)
                .await
                .unwrap();
            let ids: Vec<i32> = processes["processInfo"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["id"].as_i64().unwrap() as i32)
                .collect();
            assert!(!ids.is_empty());
            let profile_owner = browser._profile.clone();
            drop(client);
            assert!(profile.exists());
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if ids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .expect("Owned browser descendants survived dropping the client");
            assert!(profile.exists());
            profile_owner.remove_checked().unwrap();
            assert!(!profile.exists());
        }
    }
}
