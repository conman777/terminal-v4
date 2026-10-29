use crate::{
    auth::AuthenticatedUser,
    state::AppState,
    v4_agent::mcp::{ClientPolicy, McpClient, ServerConfig, TransportConfig},
    ApiError,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_SERVERS: usize = 20;
const MAX_CONFIG: usize = 262_144;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/mcp", axum::routing::get(get).put(put))
        .route("/api/agent/mcp/{id}/probe", axum::routing::post(probe))
        .route(
            "/api/agent/mcp/{id}/probes/{probe_id}",
            axum::routing::get(probe_status).delete(cancel_probe),
        )
        .layer(DefaultBodyLimit::max(MAX_CONFIG))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationInput {
    servers: Vec<ServerInput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerInput {
    id: String,
    name: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
    transport: TransportInput,
}
fn default_timeout() -> u64 {
    30
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TransportInput {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        env: Option<BTreeMap<String, String>>,
        #[serde(default)]
        env_keys: Option<Vec<String>>,
    },
    Http {
        url: String,
        bearer_token: Option<String>,
        #[serde(default)]
        clear_bearer_token: bool,
        #[serde(default)]
        bearer_token_set: Option<bool>,
    },
}
fn merge_input(
    input: ConfigurationInput,
    previous: &[ServerConfig],
) -> Result<Vec<ServerConfig>, String> {
    if input.servers.len() > MAX_SERVERS {
        return Err("At most 20 MCP servers may be configured per account".into());
    }
    let mut ids = HashSet::new();
    let mut servers = Vec::new();
    for input in input.servers {
        if !ids.insert(input.id.clone()) {
            return Err("MCP server IDs must be unique".into());
        }
        let old = previous.iter().find(|server| server.id == input.id);
        let transport = match input.transport {
            TransportInput::Stdio {
                command,
                args,
                env,
                env_keys,
            } => {
                if env_keys
                    .as_ref()
                    .is_some_and(|keys| keys.len() > 64 || keys.iter().any(|key| key.len() > 128))
                {
                    return Err("MCP environment names exceed their limit".into());
                }
                let env=match env {
                    Some(env)=>env,
                    None=>match old.map(|server|&server.transport) {
                        Some(TransportConfig::Stdio{command:old_command,args:old_args,env}) if old_command==&command && old_args==&args=>env.clone(),
                        Some(TransportConfig::Stdio{env,..}) if !env.is_empty()=>return Err("Changing the MCP command or arguments requires explicitly replacing or clearing its environment".into()),
                        _=>BTreeMap::new()
                    }
                };
                TransportConfig::Stdio { command, args, env }
            }
            TransportInput::Http {
                url,
                bearer_token,
                clear_bearer_token,
                bearer_token_set,
            } => {
                let _ = bearer_token_set;
                if clear_bearer_token && bearer_token.is_some() {
                    return Err("Provide a bearer token or clear it, not both".into());
                }
                let bearer_token = if clear_bearer_token {
                    None
                } else if bearer_token.is_some() {
                    bearer_token
                } else {
                    match old.map(|server|&server.transport) {
                        Some(TransportConfig::Http{url:old_url,bearer_token}) if old_url==&url=>bearer_token.clone(),
                        Some(TransportConfig::Http{bearer_token:Some(_),..})=>return Err("Changing the MCP URL requires explicitly replacing or clearing its bearer token".into()),
                        _=>None
                    }
                };
                TransportConfig::Http { url, bearer_token }
            }
        };
        let server = ServerConfig {
            id: input.id,
            name: input.name,
            enabled: input.enabled,
            timeout_seconds: input.timeout_seconds,
            transport,
        };
        server.validate()?;
        servers.push(server);
    }
    if serde_json::to_vec(&servers)
        .map_err(|_| "Invalid MCP configuration")?
        .len()
        > MAX_CONFIG
    {
        return Err("MCP account configuration exceeds its limit".into());
    }
    Ok(servers)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredConfiguration {
    version: u8,
    owner: String,
    servers: Vec<ServerConfig>,
}
fn private_directory(data_dir: &FsPath) -> Result<PathBuf, String> {
    let directory = data_dir.join("agent-mcp");
    if std::fs::symlink_metadata(&directory)
        .is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir())
    {
        return Err("MCP configuration directory is unsafe".into());
    }
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare private MCP configuration")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect MCP configuration")?;
    }
    Ok(directory)
}
fn read_private(path: &FsPath, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Cannot read MCP configuration")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("MCP configuration file is unsafe or exceeds its limit".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "Cannot open MCP configuration")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read MCP configuration")?;
    if bytes.len() as u64 > limit {
        return Err("MCP configuration exceeds its limit".into());
    }
    Ok(bytes)
}
fn encryption_key(directory: &FsPath, create: bool) -> Result<String, String> {
    let path = directory.join("encryption-key");
    if !path.exists() && create {
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let key = hex::encode(random);
        let mut temporary = tempfile::NamedTempFile::new_in(directory)
            .map_err(|_| "Cannot prepare MCP encryption key")?;
        temporary
            .write_all(key.as_bytes())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Cannot save MCP encryption key")?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Cannot save MCP encryption key".into()),
        };
    }
    let key =
        String::from_utf8(read_private(&path, 64)?).map_err(|_| "MCP encryption key is invalid")?;
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("MCP encryption key is invalid".into());
    }
    Ok(key)
}
pub(crate) fn load_servers(data_dir: &FsPath, owner: &str) -> Result<Vec<ServerConfig>, String> {
    let path = config_path(data_dir, owner);
    if std::fs::symlink_metadata(&path)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(Vec::new());
    }
    let directory = private_directory(data_dir)?;
    let encrypted = String::from_utf8(read_private(&path, (MAX_CONFIG * 2 + 512) as u64)?)
        .map_err(|_| "Invalid MCP configuration")?;
    let valid_cipher = encrypted
        .strip_prefix("enc:v1:")
        .and_then(|value| value.split_once(':'))
        .is_some_and(|(iv, cipher)| {
            iv.len() == 24
                && iv.bytes().all(|b| b.is_ascii_hexdigit())
                && cipher.len() >= 32
                && cipher.len() % 2 == 0
                && cipher.bytes().all(|b| b.is_ascii_hexdigit())
        });
    if !valid_cipher {
        return Err("MCP configuration encryption format is invalid".into());
    }
    let plaintext = crate::vault::decrypt_secret(&encrypted, &encryption_key(&directory, false)?)
        .map_err(|_| "Cannot decrypt MCP configuration")?;
    if plaintext.len() > MAX_CONFIG + 2048 {
        return Err("MCP configuration exceeds its limit".into());
    }
    let stored: StoredConfiguration =
        serde_json::from_str(&plaintext).map_err(|_| "Invalid MCP configuration")?;
    if stored.version != 1 || stored.owner != owner || stored.servers.len() > MAX_SERVERS {
        return Err("MCP configuration account binding is invalid".into());
    }
    let mut ids = HashSet::new();
    for server in &stored.servers {
        server.validate_stored()?;
        if !ids.insert(&server.id) {
            return Err("MCP configuration has duplicate server IDs".into());
        }
    }
    // The encrypted configuration is authoritative; an advisory cache failure must not change settings success.
    let _ = refresh_declaration_metadata(data_dir, owner, encrypted.as_bytes(), &stored.servers);
    Ok(stored.servers)
}
fn save_servers(data_dir: &FsPath, owner: &str, servers: &[ServerConfig]) -> Result<(), String> {
    if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
        return Err("Invalid MCP account".into());
    }
    let directory = private_directory(data_dir)?;
    let key = encryption_key(&directory, true)?;
    let plaintext = serde_json::to_string(&StoredConfiguration {
        version: 1,
        owner: owner.into(),
        servers: servers.to_vec(),
    })
    .map_err(|_| "Cannot encode MCP configuration")?;
    let encrypted = crate::vault::encrypt_secret(&plaintext, &key)
        .map_err(|_| "Cannot encrypt MCP configuration")?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "Cannot prepare MCP configuration")?;
    temporary
        .write_all(encrypted.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Cannot save MCP configuration")?;
    temporary
        .persist(config_path(data_dir, owner))
        .map_err(|_| "Cannot save MCP configuration")?;
    let _ = refresh_declaration_metadata(data_dir, owner, encrypted.as_bytes(), servers);
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeclarationMetadata {
    version: u8,
    owner: String,
    encrypted_config_hash: String,
    any_enabled: bool,
}
fn declaration_cache_path(data: &FsPath, owner: &str) -> PathBuf {
    data.join("agent-mcp").join(format!(
        "{}.declarations.json",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(owner.as_bytes()))
    ))
}
fn declaration_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
        return Err("Invalid MCP account".into());
    }
    Ok(())
}
// Reads only existing, regular private files. No key access, decryption, repair, or mkdir.
fn declaration_file(data: &FsPath, name: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
    #[cfg(unix)]
    let file = {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        };
        let root = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(data)
            .map_err(|_| "MCP metadata storage is unsafe")?;
        let name_dir = std::ffi::CString::new("agent-mcp").unwrap();
        let fd = unsafe {
            libc::openat(
                root.as_raw_fd(),
                name_dir.as_ptr(),
                libc::O_RDONLY
                    | libc::O_DIRECTORY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err("MCP metadata directory is unsafe".into());
        }
        let directory = unsafe { std::fs::File::from_raw_fd(fd) };
        use std::os::unix::fs::PermissionsExt;
        if directory
            .metadata()
            .map_err(|_| "Cannot inspect MCP metadata directory")?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err("MCP metadata directory is not private".into());
        }
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid MCP metadata name")?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err("MCP metadata file is unsafe".into());
        }
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let file = {
        for path in [data.to_path_buf(), data.join("agent-mcp")] {
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                    return Err("MCP metadata directory is unsafe".into())
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("Cannot inspect MCP metadata directory".into()),
            }
        }
        let path = data.join("agent-mcp").join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("MCP metadata file is unsafe".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot inspect MCP metadata file".into()),
        };
        std::fs::File::open(path).map_err(|_| "Cannot read MCP metadata file")?
    };
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect MCP metadata file")?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("MCP metadata file exceeds its limit or is unsafe".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("MCP metadata file is not private".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read MCP metadata file")?;
    if bytes.len() > limit {
        return Err("MCP metadata file exceeds its limit".into());
    }
    Ok(Some(bytes))
}
pub(crate) fn declaration_metadata(data: &FsPath, owner: &str) -> Result<bool, String> {
    declaration_owner(owner)?;
    let config_name = config_path(data, owner)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let Some(encrypted) = declaration_file(data, &config_name, MAX_CONFIG * 2 + 512)? else {
        return Ok(false);
    };
    let cache_name = declaration_cache_path(data, owner)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let cached = declaration_file(data, &cache_name, 2048)?
        .ok_or("MCP declaration metadata needs an explicit settings refresh")?;
    let metadata: DeclarationMetadata =
        serde_json::from_slice(&cached).map_err(|_| "MCP declaration metadata is invalid")?;
    let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&encrypted));
    if metadata.version != 1 || metadata.owner != owner || metadata.encrypted_config_hash != digest
    {
        return Err("MCP declaration metadata is unavailable for this configuration".into());
    }
    if declaration_file(data, &config_name, MAX_CONFIG * 2 + 512)?.as_ref() != Some(&encrypted) {
        return Err("MCP configuration changed during the context read".into());
    }
    Ok(metadata.any_enabled)
}
fn refresh_declaration_metadata(
    data: &FsPath,
    owner: &str,
    encrypted: &[u8],
    servers: &[ServerConfig],
) -> Result<(), String> {
    declaration_owner(owner)?;
    let directory = private_directory(data)?;
    let metadata = DeclarationMetadata {
        version: 1,
        owner: owner.into(),
        encrypted_config_hash: hex::encode(<sha2::Sha256 as sha2::Digest>::digest(encrypted)),
        any_enabled: servers.iter().any(|server| server.enabled),
    };
    let bytes =
        serde_json::to_vec(&metadata).map_err(|_| "Cannot encode MCP declaration metadata")?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "Cannot prepare MCP declaration metadata")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Cannot save MCP declaration metadata")?;
    temporary
        .persist(declaration_cache_path(data, owner))
        .map_err(|_| "Cannot save MCP declaration metadata")?;
    Ok(())
}

fn config_path(data_dir: &FsPath, owner: &str) -> PathBuf {
    data_dir.join("agent-mcp").join(format!(
        "{}.json.enc",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(owner.as_bytes()))
    ))
}
fn redacted(servers: &[ServerConfig]) -> Value {
    json!({"servers":servers.iter().map(|server|{
        let transport=match &server.transport {
            TransportConfig::Stdio{command,args,env}=>json!({"type":"stdio","command":command,"args":args,"envKeys":env.keys().collect::<Vec<_>>()}),
            TransportConfig::Http{url,bearer_token}=>json!({"type":"http","url":url,"bearerTokenSet":bearer_token.is_some()}),
        };
        json!({"id":server.id,"name":server.name,"enabled":server.enabled,"timeoutSeconds":server.timeout_seconds,"transport":transport})
    }).collect::<Vec<_>>()})
}
async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let servers =
        load_servers(&state.config().data_dir, &user.user_id).map_err(ApiError::internal)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(redacted(&servers)),
    ))
}
async fn put(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<ConfigurationInput>,
) -> Result<Response, ApiError> {
    let previous =
        load_servers(&state.config().data_dir, &user.user_id).map_err(ApiError::internal)?;
    let servers = merge_input(input, &previous).map_err(ApiError::bad_request)?;
    let changed = serde_json::to_value(&previous)
        .map_err(|error| ApiError::internal(error.to_string()))?
        != serde_json::to_value(&servers).map_err(|error| ApiError::internal(error.to_string()))?;
    save_servers(&state.config().data_dir, &user.user_id, &servers).map_err(ApiError::internal)?;
    let cleanup_state = state.clone();
    let cleanup_owner = user.user_id.clone();
    let cleanup = tokio::spawn(async move {
        let manager = cleanup_state.structured_session_manager();
        let (probes, apps, agents) = tokio::join!(
            close_owner_checked(&cleanup_state.config().data_dir, &cleanup_owner),
            crate::agent_mcp_apps::revoke_changed(&cleanup_state.config().data_dir, &cleanup_owner),
            async {
                if changed {
                    manager.close_owner(&cleanup_owner).await
                } else {
                    manager.retry_owner_cleanup(&cleanup_owner).await
                }
            },
        );
        let errors: Vec<_> = [probes, apps, agents]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    })
    .await
    .unwrap_or_else(|_| Err("MCP configuration cleanup worker stopped".into()));
    let config = redacted(&servers);
    if let Err(error) = cleanup {
        return Ok((StatusCode::SERVICE_UNAVAILABLE,[(header::CACHE_CONTROL,"private, no-store")],Json(json!({"error":format!("MCP configuration saved, but agent cleanup could not be confirmed: {error}"),"settingsSaved":true,"cleanupConfirmed":false,"config":config}))).into_response());
    }
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(config)).into_response())
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeInput {
    #[serde(default)]
    background: bool,
    probe_id: Option<uuid::Uuid>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProbeStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReceipt {
    probe_id: uuid::Uuid,
    status: ProbeStatus,
    cleanup_confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct ProbeKey {
    data: PathBuf,
    owner: String,
    server: String,
    id: uuid::Uuid,
}
struct ProbeJob {
    created: Instant,
    cancel: tokio::sync::watch::Sender<bool>,
    receipt: tokio::sync::watch::Sender<ProbeReceipt>,
    cleanup: tokio::sync::Mutex<Option<McpClient>>,
}
fn jobs() -> &'static Mutex<HashMap<ProbeKey, Arc<ProbeJob>>> {
    static JOBS: OnceLock<Mutex<HashMap<ProbeKey, Arc<ProbeJob>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn probe_key(
    state: &AppState,
    user: &AuthenticatedUser,
    id: String,
    probe_id: uuid::Uuid,
) -> ProbeKey {
    ProbeKey {
        data: state.config().data_dir.clone(),
        owner: user.user_id.clone(),
        server: id,
        id: probe_id,
    }
}
fn reserve_job(key: ProbeKey, cancelled: bool) -> Result<(Arc<ProbeJob>, bool), ApiError> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| ApiError::internal("MCP probe registry is unavailable"))?;
    jobs.retain(|_, job| {
        !job.receipt.borrow().cleanup_confirmed || job.created.elapsed() < Duration::from_secs(600)
    });
    if let Some(job) = jobs.get(&key) {
        return Ok((job.clone(), false));
    }
    if jobs.len() >= 512 {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "MCP probe receipts are full; retry after older receipts expire".into(),
        });
    }
    if !cancelled
        && jobs.iter().any(|(candidate, job)| {
            let receipt = job.receipt.borrow();
            candidate.data == key.data
                && candidate.owner == key.owner
                && receipt.status != ProbeStatus::Running
                && !receipt.cleanup_confirmed
        })
    {
        return Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "MCP probe cleanup is unconfirmed; retry cancellation or save the configuration to retry cleanup before starting another connection".into(),
        });
    }
    if !cancelled
        && jobs
            .iter()
            .filter(|(candidate, job)| {
                candidate.data == key.data
                    && candidate.owner == key.owner
                    && job.receipt.borrow().status == ProbeStatus::Running
            })
            .count()
            >= 4
    {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "At most four MCP probes may run for this account".into(),
        });
    }
    let (cancel, _) = tokio::sync::watch::channel(cancelled);
    let (receipt, _) = tokio::sync::watch::channel(ProbeReceipt {
        probe_id: key.id,
        status: if cancelled {
            ProbeStatus::Cancelled
        } else {
            ProbeStatus::Running
        },
        cleanup_confirmed: cancelled,
        result: None,
        error: None,
    });
    let job = Arc::new(ProbeJob {
        created: Instant::now(),
        cancel,
        receipt,
        cleanup: tokio::sync::Mutex::new(None),
    });
    jobs.insert(key, job.clone());
    Ok((job, true))
}
fn lookup_job(key: &ProbeKey) -> Result<Option<Arc<ProbeJob>>, ApiError> {
    Ok(jobs()
        .lock()
        .map_err(|_| ApiError::internal("MCP probe registry is unavailable"))?
        .get(key)
        .cloned())
}
async fn wait_job(job: &ProbeJob) -> Result<ProbeReceipt, ApiError> {
    let mut receipt = job.receipt.subscribe();
    loop {
        let current = receipt.borrow_and_update().clone();
        if current.status != ProbeStatus::Running {
            return Ok(current);
        }
        receipt
            .changed()
            .await
            .map_err(|_| ApiError::internal("MCP probe stopped without a receipt"))?;
    }
}
async fn cancelled(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
async fn probe_result(client: &mut McpClient, server: &ServerConfig) -> Result<Value, String> {
    client.initialize().await?;
    let tools = client.list_tools().await?;
    let resources = client.list_resources().await?;
    let resource_templates = match client.list_resource_templates().await {
        Ok(templates) => templates,
        Err(error) if error.contains("JSON-RPC code -32601") => Vec::new(),
        Err(error) => return Err(error),
    };
    let prompts = client.list_prompts().await?;
    let mut response =
        serde_json::to_value(client.info()).map_err(|_| "Cannot encode MCP server information")?;
    response["server"] = json!({"id":server.id,"name":server.name});
    response["tools"] = json!(tools);
    response["resources"] = json!(resources);
    response["resourceTemplates"] = json!(resource_templates);
    response["prompts"] = json!(prompts);
    Ok(response)
}
async fn run_probe(job: Arc<ProbeJob>, server: ServerConfig) {
    let mut cancellation = job.cancel.subscribe();
    let id = job.receipt.borrow().probe_id;
    if *cancellation.borrow() {
        job.receipt.send_replace(ProbeReceipt {
            probe_id: id,
            status: ProbeStatus::Cancelled,
            cleanup_confirmed: true,
            result: None,
            error: None,
        });
        return;
    }
    let mut client =
        match McpClient::prepare_with_policy(&server, ClientPolicy::default().with_apps()) {
            Ok(client) => client,
            Err(error) => {
                job.receipt.send_replace(ProbeReceipt {
                    probe_id: id,
                    status: ProbeStatus::Failed,
                    cleanup_confirmed: true,
                    result: None,
                    error: Some(error),
                });
                return;
            }
        };
    let result = tokio::select! {
        biased;
        _=cancelled(&mut cancellation)=>Err("cancelled".to_owned()),
        _=tokio::time::sleep(Duration::from_secs(server.timeout_seconds))=>Err("MCP probe timed out".to_owned()),
        result=probe_result(&mut client,&server)=>result,
    };
    let closed = client.close().await;
    if closed.is_err() {
        *job.cleanup.lock().await = Some(client);
    }
    let was_cancelled = *job.cancel.borrow();
    let receipt = match (result, closed, was_cancelled) {
        (_, Err(error), _) => ProbeReceipt {
            probe_id: id,
            status: ProbeStatus::Failed,
            cleanup_confirmed: false,
            result: None,
            error: Some(format!("MCP probe cleanup failed: {error}")),
        },
        (_, Ok(()), true) => ProbeReceipt {
            probe_id: id,
            status: ProbeStatus::Cancelled,
            cleanup_confirmed: true,
            result: None,
            error: None,
        },
        (Ok(result), Ok(()), false) => ProbeReceipt {
            probe_id: id,
            status: ProbeStatus::Completed,
            cleanup_confirmed: true,
            result: Some(result),
            error: None,
        },
        (Err(error), Ok(()), false) => ProbeReceipt {
            probe_id: id,
            status: ProbeStatus::Failed,
            cleanup_confirmed: true,
            result: None,
            error: Some(error),
        },
    };
    job.receipt.send_replace(receipt);
}
async fn retry_cleanup(job: &ProbeJob) {
    let mut owned = job.cleanup.lock().await;
    let Some(client) = owned.as_mut() else {
        return;
    };
    let mut receipt = job.receipt.borrow().clone();
    match client.close().await {
        Ok(()) => {
            owned.take();
            receipt.status = ProbeStatus::Cancelled;
            receipt.cleanup_confirmed = true;
            receipt.error = None;
        }
        Err(error) => {
            receipt.status = ProbeStatus::Failed;
            receipt.cleanup_confirmed = false;
            receipt.error = Some(format!("MCP probe cleanup failed: {error}"));
        }
    }
    job.receipt.send_replace(receipt);
}
async fn stop_job(job: Arc<ProbeJob>) -> Result<(), String> {
    job.cancel.send_replace(true);
    let _ = tokio::time::timeout(Duration::from_secs(8), wait_job(&job)).await;
    retry_cleanup(&job).await;
    if job.cleanup.lock().await.is_some() {
        return Err(job
            .receipt
            .borrow()
            .error
            .clone()
            .unwrap_or_else(|| "MCP probe cleanup is unconfirmed".into()));
    }
    if job.receipt.borrow().status == ProbeStatus::Running {
        return Err("MCP probe cancellation is still running".into());
    }
    Ok(())
}
async fn stop_jobs(data: &FsPath, owner: Option<&str>) -> Result<(), String> {
    let jobs = jobs()
        .lock()
        .map_err(|_| "MCP probe registry is unavailable")?
        .iter()
        .filter(|(key, _)| key.data == data && owner.is_none_or(|owner| owner == key.owner))
        .map(|(_, job)| job.clone())
        .collect::<Vec<_>>();
    let errors: Vec<_> = futures_util::future::join_all(jobs.into_iter().map(stop_job))
        .await
        .into_iter()
        .filter_map(Result::err)
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
pub(crate) async fn close_owner_checked(data: &FsPath, owner: &str) -> Result<(), String> {
    stop_jobs(data, Some(owner)).await
}
pub(crate) async fn close_owner(data: &FsPath, owner: &str) {
    if let Err(error) = close_owner_checked(data, owner).await {
        tracing::warn!(%error,"MCP probe owner cleanup remains unconfirmed");
    }
}
pub(crate) async fn shutdown(data: &FsPath) {
    if let Err(error) = stop_jobs(data, None).await {
        tracing::warn!(%error,"MCP probe shutdown cleanup remains unconfirmed");
    }
}
async fn probe(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
    input: Option<Json<Value>>,
) -> Result<Response, ApiError> {
    let input = match input {
        None | Some(Json(Value::Null)) => ProbeInput::default(),
        Some(Json(value)) => serde_json::from_value(value)
            .map_err(|_| ApiError::bad_request("Invalid MCP probe options"))?,
    };
    let server = load_servers(&state.config().data_dir, &user.user_id)
        .map_err(ApiError::internal)?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "MCP server is unavailable for this account".into(),
        })?;
    let key = probe_key(
        &state,
        &user,
        id,
        input.probe_id.unwrap_or_else(uuid::Uuid::new_v4),
    );
    let (job, start) = reserve_job(key, false)?;
    if start {
        tokio::spawn(run_probe(job.clone(), server));
    }
    if input.background {
        let receipt = job.receipt.borrow().clone();
        return Ok((
            StatusCode::ACCEPTED,
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(receipt),
        )
            .into_response());
    }
    let receipt = wait_job(&job).await?;
    match receipt.status {
        ProbeStatus::Completed => Ok((
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(receipt.result.unwrap_or(Value::Null)),
        )
            .into_response()),
        ProbeStatus::Cancelled => Ok((
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(receipt),
        )
            .into_response()),
        _ => Err(ApiError::bad_request(
            receipt
                .error
                .unwrap_or_else(|| "MCP probe did not complete".into()),
        )),
    }
}
async fn probe_status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, probe_id)): Path<(String, uuid::Uuid)>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<ProbeReceipt>), ApiError> {
    let key = probe_key(&state, &user, id, probe_id);
    let job = lookup_job(&key)?.ok_or(ApiError {
        status: StatusCode::NOT_FOUND,
        message: "MCP probe is unavailable for this account".into(),
    })?;
    let receipt = job.receipt.borrow().clone();
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(receipt),
    ))
}
async fn cancel_probe(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, probe_id)): Path<(String, uuid::Uuid)>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<ProbeReceipt>), ApiError> {
    let key = probe_key(&state, &user, id.clone(), probe_id);
    let job = match lookup_job(&key)? {
        Some(job) => job,
        None => {
            if !load_servers(&state.config().data_dir, &user.user_id)
                .map_err(ApiError::internal)?
                .iter()
                .any(|server| server.id == id)
            {
                return Err(ApiError {
                    status: StatusCode::NOT_FOUND,
                    message: "MCP probe is unavailable for this account".into(),
                });
            }
            reserve_job(key, true)?.0
        }
    };
    if job.receipt.borrow().status == ProbeStatus::Running {
        job.cancel.send_replace(true);
    }
    let _ = tokio::time::timeout(Duration::from_secs(8), wait_job(&job))
        .await
        .map_err(|_| ApiError {
            status: StatusCode::GATEWAY_TIMEOUT,
            message: "MCP probe cancellation is still finishing cleanup; check its status".into(),
        })??;
    retry_cleanup(&job).await;
    let receipt = job.receipt.borrow().clone();
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(receipt),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{issue_access_token, require_auth};
    use axum::{body::Body, http::Request, middleware};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;
    fn setup() -> (tempfile::TempDir, AppState, Router) {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(AppConfig {
            data_dir: directory.path().to_path_buf(),
            jwt_secret: "mcp-fixture-only".into(),
            ..Default::default()
        })
        .unwrap();
        let app = routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state.clone());
        (directory, state, app)
    }
    fn request(method: &str, path: &str, owner: Option<&str>, body: Value) -> Request<Body> {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(owner) = owner {
            request = request.header(
                "authorization",
                format!(
                    "Bearer {}",
                    issue_access_token("mcp-fixture-only", owner, owner)
                ),
            );
        }
        request.body(Body::from(body.to_string())).unwrap()
    }
    async fn json(response: axum::response::Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1_048_576)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    fn config() -> Value {
        json!({"servers":[{"id":"fixture","name":"Synthetic server","enabled":false,"timeoutSeconds":3,"transport":{"type":"http","url":"https://mcp.example.test/mcp","bearerToken":"synthetic-secret"}}]})
    }
    #[tokio::test]
    async fn configuration_is_encrypted_account_scoped_and_secrets_survive_redacted_roundtrip() {
        let (directory, _state, app) = setup();
        let response = app
            .clone()
            .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), config()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut public = json(response).await;
        assert!(!public.to_string().contains("synthetic-secret"));
        assert_eq!(public["servers"][0]["transport"]["bearerTokenSet"], true);
        let bytes = std::fs::read(config_path(directory.path(), "owner")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("synthetic-secret"));
        public["servers"][0]["name"] = json!("Renamed");
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), public))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let stored = load_servers(directory.path(), "owner").unwrap();
        assert!(
            matches!(&stored[0].transport,TransportConfig::Http{bearer_token:Some(token),..} if token=="synthetic-secret")
        );
        assert_eq!(
            json(
                app.clone()
                    .oneshot(request("GET", "/api/agent/mcp", Some("other"), Value::Null))
                    .await
                    .unwrap()
            )
            .await,
            json!({"servers":[]})
        );
        assert_eq!(
            app.oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/probe",
                Some("other"),
                Value::Null
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::NOT_FOUND
        );
    }
    #[tokio::test]
    async fn mcp_configuration_and_probe_require_authentication() {
        let (_directory, _state, app) = setup();
        for (method, path) in [
            ("GET", "/api/agent/mcp"),
            ("PUT", "/api/agent/mcp"),
            ("POST", "/api/agent/mcp/fixture/probe"),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(request(method, path, None, config()))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    #[test]
    fn changed_targets_cannot_inherit_previous_secrets_and_explicit_clear_works() {
        let previous = merge_input(serde_json::from_value(config()).unwrap(), &[]).unwrap();
        let mut input = redacted(&previous);
        input["servers"][0]["transport"]["url"] = json!("https://different.example.test/mcp");
        assert!(merge_input(serde_json::from_value(input.clone()).unwrap(), &previous).is_err());
        input["servers"][0]["transport"]["clearBearerToken"] = json!(true);
        let output = merge_input(serde_json::from_value(input).unwrap(), &previous).unwrap();
        assert!(matches!(
            output[0].transport,
            TransportConfig::Http {
                bearer_token: None,
                ..
            }
        ));
    }
    #[test]
    fn rejects_duplicate_servers_and_invalid_urls_without_writing_config() {
        let mut input = config();
        let duplicate = input["servers"][0].clone();
        input["servers"].as_array_mut().unwrap().push(duplicate);
        assert!(merge_input(serde_json::from_value(input).unwrap(), &[]).is_err());
        for url in [
            "http://10.0.0.1/mcp",
            "https://secret@example.test/mcp",
            "https://example.test/mcp?token=secret",
        ] {
            let mut input = config();
            input["servers"][0]["transport"]["url"] = json!(url);
            assert!(merge_input(serde_json::from_value(input).unwrap(), &[]).is_err());
        }
    }
    #[test]
    fn stored_owner_binding_rejects_copying_another_accounts_encrypted_file() {
        let directory = tempfile::tempdir().unwrap();
        let servers = merge_input(serde_json::from_value(config()).unwrap(), &[]).unwrap();
        save_servers(directory.path(), "owner-a", &servers).unwrap();
        std::fs::copy(
            config_path(directory.path(), "owner-a"),
            config_path(directory.path(), "owner-b"),
        )
        .unwrap();
        assert!(load_servers(directory.path(), "owner-b").is_err());
    }
    #[test]
    fn malformed_encrypted_configuration_fails_without_panicking() {
        let directory = tempfile::tempdir().unwrap();
        let servers = merge_input(serde_json::from_value(config()).unwrap(), &[]).unwrap();
        save_servers(directory.path(), "owner", &servers).unwrap();
        std::fs::write(config_path(directory.path(), "owner"), "enc:v1:00:00").unwrap();
        let result = std::panic::catch_unwind(|| load_servers(directory.path(), "owner"));
        assert!(result.is_ok(), "Corrupt configuration must not panic");
        assert!(result.unwrap().is_err());
    }

    #[test]
    fn stdio_environment_secrets_are_preserved_or_explicitly_cleared() {
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let input = json!({"servers":[{"id":"local","name":"Synthetic stdio","transport":{"type":"stdio","command":executable,"env":{"FIXTURE_SECRET":"secret-value"}}}]});
        let original = merge_input(serde_json::from_value(input).unwrap(), &[]).unwrap();
        let mut public = redacted(&original);
        assert!(!public.to_string().contains("secret-value"));
        let preserved =
            merge_input(serde_json::from_value(public.clone()).unwrap(), &original).unwrap();
        assert!(
            matches!(&preserved[0].transport,TransportConfig::Stdio{env,..} if env.get("FIXTURE_SECRET").is_some_and(|value|value=="secret-value"))
        );
        public["servers"][0]["transport"]["args"] = json!(["different"]);
        assert!(merge_input(serde_json::from_value(public.clone()).unwrap(), &original).is_err());
        public["servers"][0]["transport"]["env"] = json!({});
        let cleared = merge_input(serde_json::from_value(public).unwrap(), &original).unwrap();
        assert!(matches!(&cleared[0].transport,TransportConfig::Stdio{env,..} if env.is_empty()));
    }
    #[cfg(unix)]
    #[test]
    fn configuration_files_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let servers = merge_input(serde_json::from_value(config()).unwrap(), &[]).unwrap();
        save_servers(directory.path(), "owner", &servers).unwrap();
        assert_eq!(
            std::fs::metadata(directory.path().join("agent-mcp"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for path in [
            config_path(directory.path(), "owner"),
            directory.path().join("agent-mcp/encryption-key"),
        ] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let other = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(other.path().join("agent-mcp")).unwrap();
        symlink(
            config_path(directory.path(), "owner"),
            config_path(other.path(), "owner"),
        )
        .unwrap();
        assert!(load_servers(other.path(), "owner").is_err());
    }
    #[tokio::test]
    async fn only_explicit_probe_connects_and_returns_discovered_tools() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let endpoint=axum::Router::new().route("/mcp",axum::routing::any(move |request:Request<Body>|{let requests=observed.clone();async move {
            requests.fetch_add(1,Ordering::SeqCst);let method=request.method().clone();let bytes=axum::body::to_bytes(request.into_body(),1_048_576).await.unwrap();
            if method=="DELETE"{return axum::http::Response::builder().status(StatusCode::NO_CONTENT).body(Body::empty()).unwrap();}
            let input:Value=serde_json::from_slice(&bytes).unwrap();if input.get("id").is_none(){return axum::http::Response::builder().status(StatusCode::ACCEPTED).body(Body::empty()).unwrap();}
            let result=if input["method"]=="initialize"{json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"Synthetic probe","version":"1"},"capabilities":{"tools":{}}})}else{json!({"tools":[{"name":"echo","inputSchema":{"type":"object"}}]})};
            axum::http::Response::builder().header("content-type","application/json").header("mcp-session-id","synthetic-probe-session").body(Body::from(json!({"jsonrpc":"2.0","id":input["id"],"result":result}).to_string())).unwrap()
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, endpoint).await.unwrap();
        });
        let (_directory, _state, app) = setup();
        let input = json!({"servers":[{"id":"fixture","name":"Synthetic probe","enabled":false,"timeoutSeconds":3,"transport":{"type":"http","url":format!("http://{address}/mcp")}}]});
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), input))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(request("GET", "/api/agent/mcp", Some("owner"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        let response = app
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/probe",
                Some("owner"),
                Value::Null,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json(response).await;
        assert_eq!(body["server"]["id"], "fixture");
        assert_eq!(body["tools"][0]["name"], "echo");
        assert_eq!(requests.load(Ordering::SeqCst), 4);
        server.abort();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn background_probe_cancellation_stops_stdio_and_is_owner_scoped() {
        let (directory, _state, app) = setup();
        let script = directory.path().join("hanging.py");
        let pidfile = directory.path().join("fixture-pid");
        std::fs::write(&script,"import sys,os,time\nopen(sys.argv[1],'w').write(str(os.getpid()))\nfor line in sys.stdin: time.sleep(60)\n").unwrap();
        let input = json!({"servers":[{"id":"hanging","name":"Synthetic hanging process","timeoutSeconds":30,"transport":{"type":"stdio","command":"/usr/bin/python3","args":["-u",script,pidfile],"env":{}}}]});
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), input))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let id = uuid::Uuid::new_v4().to_string();
        let path = format!("/api/agent/mcp/hanging/probes/{id}");
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            app.clone().oneshot(request(
                "POST",
                "/api/agent/mcp/hanging/probe",
                Some("owner"),
                json!({"background":true,"probeId":id}),
            )),
        )
        .await
        .expect("Background probe must return immediately")
        .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let mut observed_pid = None;
        for _ in 0..200 {
            observed_pid = std::fs::read_to_string(&pidfile)
                .ok()
                .and_then(|text| text.parse::<libc::pid_t>().ok());
            if observed_pid.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let pid = observed_pid.expect("Synthetic probe must publish its complete PID");
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        for method in ["GET", "DELETE"] {
            assert_eq!(
                app.clone()
                    .oneshot(request(method, &path, Some("other"), Value::Null))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            app.clone()
                .oneshot(request("DELETE", &path, Some("owner"), Value::Null)),
        )
        .await
        .expect("Cancellation must finish cleanup")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await["status"], "cancelled");
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(
            json(
                app.clone()
                    .oneshot(request("GET", &path, Some("owner"), Value::Null))
                    .await
                    .unwrap()
            )
            .await["status"],
            "cancelled"
        );
        assert_eq!(
            json(
                app.oneshot(request("DELETE", &path, Some("owner"), Value::Null))
                    .await
                    .unwrap()
            )
            .await["status"],
            "cancelled"
        );
    }
    #[tokio::test]
    async fn cancellation_before_probe_registration_prevents_connection() {
        let (_directory, _state, app) = setup();
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), config()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let id = uuid::Uuid::new_v4().to_string();
        let path = format!("/api/agent/mcp/fixture/probes/{id}");
        let response = app
            .clone()
            .oneshot(request("DELETE", &path, Some("owner"), Value::Null))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await["status"], "cancelled");
        let response = app
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/probe",
                Some("owner"),
                json!({"background":true,"probeId":id}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(json(response).await["status"], "cancelled");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn removed_stdio_executable_does_not_lock_the_owner_out_of_settings() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, _state, app) = setup();
        let executable = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        std::fs::set_permissions(executable.path(), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let input = json!({"servers":[{"id":"removed","name":"Removed synthetic executable","transport":{"type":"stdio","command":executable.path(),"env":{}}}]});
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), input))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        drop(executable);
        assert_eq!(
            app.clone()
                .oneshot(request("GET", "/api/agent/mcp", Some("owner"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.oneshot(request(
                "PUT",
                "/api/agent/mcp",
                Some("owner"),
                json!({"servers":[]})
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::OK
        );
    }
    #[tokio::test]
    async fn repair_t4_failed_probe_cleanup_retains_identity_and_blocks_admission_until_retry() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let allow = Arc::new(AtomicBool::new(false));
        let initializes = Arc::new(AtomicUsize::new(0));
        let permission = allow.clone();
        let observed = initializes.clone();
        let endpoint = Router::new().route("/mcp", axum::routing::any(move |request: Request<Body>| {
            let allow = permission.clone(); let initializes = observed.clone();
            async move {
                if request.method() == "DELETE" {
                    return axum::http::Response::builder().status(if allow.load(Ordering::SeqCst) { StatusCode::NO_CONTENT } else { StatusCode::SERVICE_UNAVAILABLE }).body(Body::empty()).unwrap();
                }
                let bytes = axum::body::to_bytes(request.into_body(), 1048576).await.unwrap();
                let input: Value = serde_json::from_slice(&bytes).unwrap();
                if input.get("id").is_none() { return axum::http::Response::builder().status(StatusCode::ACCEPTED).body(Body::empty()).unwrap(); }
                let result = if input["method"] == "initialize" {
                    initializes.fetch_add(1, Ordering::SeqCst);
                    json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"synthetic","version":"1"},"capabilities":{}})
                } else { json!({"tools":[],"resources":[],"resourceTemplates":[],"prompts":[]}) };
                axum::http::Response::builder().header("content-type", "application/json").header("mcp-session-id", "synthetic-cleanup-session").body(Body::from(json!({"jsonrpc":"2.0","id":input["id"],"result":result}).to_string())).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, endpoint).await.unwrap() });
        let (data, _state, app) = setup();
        let config = json!({"servers":[{"id":"fixture","name":"Synthetic cleanup probe","enabled":false,"timeoutSeconds":2,"transport":{"type":"http","url":format!("http://{address}/mcp")}}]});
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), config))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let id = uuid::Uuid::new_v4();
        let response = app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/probe",
                Some("owner"),
                json!({"background":true,"probeId":id}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let key = ProbeKey {
            data: data.path().into(),
            owner: "owner".into(),
            server: "fixture".into(),
            id,
        };
        let job = lookup_job(&key).unwrap().unwrap();
        let failed = tokio::time::timeout(Duration::from_secs(5), wait_job(&job))
            .await
            .unwrap()
            .unwrap();
        let public = serde_json::to_value(failed).unwrap();
        assert_eq!(public["status"], "failed");
        assert_eq!(public["cleanupConfirmed"], false);
        assert!(job.cleanup.lock().await.is_some());
        let job = Arc::new(ProbeJob {
            created: Instant::now() - Duration::from_secs(601),
            cancel: job.cancel.clone(),
            receipt: job.receipt.clone(),
            cleanup: tokio::sync::Mutex::new(job.cleanup.lock().await.take()),
        });
        jobs().lock().unwrap().insert(key.clone(), job.clone());
        let path = format!("/api/agent/mcp/fixture/probes/{id}");
        let failed = json(
            app.clone()
                .oneshot(request("DELETE", &path, Some("owner"), Value::Null))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(failed["probeId"], id.to_string());
        assert_eq!(failed["cleanupConfirmed"], false);
        let blocked = app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/probe",
                Some("owner"),
                json!({"background":true}),
            ))
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(initializes.load(Ordering::SeqCst), 1);
        let duplicate = json(
            app.clone()
                .oneshot(request(
                    "POST",
                    "/api/agent/mcp/fixture/probe",
                    Some("owner"),
                    json!({"background":true,"probeId":id}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(duplicate["probeId"], id.to_string());
        assert_eq!(duplicate["cleanupConfirmed"], false);
        allow.store(true, Ordering::SeqCst);
        let cancelled = json(
            app.clone()
                .oneshot(request("DELETE", &path, Some("owner"), Value::Null))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            cancelled,
            json!({"probeId":id,"status":"cancelled","cleanupConfirmed":true})
        );
        assert!(job.cleanup.lock().await.is_none());
        let next = app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/probe",
                Some("owner"),
                json!({"background":true}),
            ))
            .await
            .unwrap();
        assert_eq!(next.status(), StatusCode::ACCEPTED);
        close_owner_checked(data.path(), "owner").await.unwrap();
        server.abort();
    }
    #[tokio::test]
    async fn settings_save_reports_retained_probe_cleanup_and_retries_the_same_saved_config() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let allow = Arc::new(AtomicBool::new(false));
        let deletes = Arc::new(AtomicUsize::new(0));
        let permission = allow.clone();
        let observed = deletes.clone();
        let endpoint=Router::new().route("/mcp",axum::routing::any(move|request:Request<Body>|{let allow=permission.clone();let deletes=observed.clone();async move{
            if request.method()=="DELETE"{deletes.fetch_add(1,Ordering::SeqCst);return axum::http::Response::builder().status(if allow.load(Ordering::SeqCst){StatusCode::NO_CONTENT}else{StatusCode::INTERNAL_SERVER_ERROR}).body(Body::empty()).unwrap();}
            let bytes=axum::body::to_bytes(request.into_body(),1048576).await.unwrap();let input:Value=serde_json::from_slice(&bytes).unwrap();if input.get("id").is_none(){return axum::http::Response::builder().status(StatusCode::ACCEPTED).body(Body::empty()).unwrap();}
            axum::http::Response::builder().header("content-type","application/json").header("mcp-session-id","synthetic-retained-session").body(Body::from(json!({"jsonrpc":"2.0","id":input["id"],"result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"synthetic","version":"1"},"capabilities":{}}}).to_string())).unwrap()
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, endpoint).await.unwrap() });
        let (data, _state, app) = setup();
        let config = json!({"servers":[{"id":"fixture","name":"retained probe fixture","enabled":false,"timeoutSeconds":2,"transport":{"type":"http","url":format!("http://{address}/mcp"),"bearerToken":"synthetic-private-token"}}]});
        let configs = merge_input(serde_json::from_value(config.clone()).unwrap(), &[]).unwrap();
        let client = McpClient::connect(&configs[0]).await.unwrap();
        let key = ProbeKey {
            data: data.path().into(),
            owner: "owner".into(),
            server: "fixture".into(),
            id: uuid::Uuid::new_v4(),
        };
        let (job, _) = reserve_job(key, false).unwrap();
        *job.cleanup.lock().await = Some(client);
        job.receipt
            .send_modify(|receipt| receipt.status = ProbeStatus::Failed);
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "PUT",
                    "/api/agent/mcp",
                    Some("other"),
                    json!({"servers":[]})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(deletes.load(Ordering::SeqCst), 0);
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(request(
                    "PUT",
                    "/api/agent/mcp",
                    Some("owner"),
                    config.clone(),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let public = json(response).await;
            assert_eq!(public["settingsSaved"], true);
            assert_eq!(public["cleanupConfirmed"], false);
            assert_eq!(
                public["config"]["servers"][0]["transport"]["bearerTokenSet"],
                true
            );
            assert!(!public.to_string().contains("synthetic-private-token"));
        }
        assert_eq!(load_servers(data.path(), "owner").unwrap().len(), 1);
        allow.store(true, Ordering::SeqCst);
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), config))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(job.cleanup.lock().await.is_none());
        assert_eq!(deletes.load(Ordering::SeqCst), 3);
        server.abort();
    }
    fn declaration_cache_path(data: &FsPath, owner: &str) -> PathBuf {
        data.join("agent-mcp").join(format!(
            "{}.declarations.json",
            hex::encode(<sha2::Sha256 as sha2::Digest>::digest(owner.as_bytes()))
        ))
    }
    fn synthetic_metadata(data: &FsPath, owner: &str, bound_owner: &str, enabled: bool) {
        let encrypted = std::fs::read(config_path(data, owner)).unwrap();
        let body = json!({"version":1,"owner":bound_owner,"encryptedConfigHash":hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&encrypted)),"anyEnabled":enabled});
        std::fs::write(declaration_cache_path(data, owner), body.to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                declaration_cache_path(data, owner),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
    }
    fn declaration_server() -> ServerConfig {
        ServerConfig {
            id: "fixture".into(),
            name: "Synthetic only".into(),
            enabled: true,
            timeout_seconds: 3,
            transport: TransportConfig::Http {
                url: "https://mcp.example.test/mcp".into(),
                bearer_token: Some("SYNTHETIC-PRIVATE-TOKEN".into()),
            },
        }
    }
    #[test]
    fn declaration_metadata_absent_configuration_is_false_and_does_not_create() {
        let data = tempfile::tempdir().unwrap();
        assert!(!declaration_metadata(data.path(), "owner").unwrap());
        assert!(!data.path().join("agent-mcp").exists());
    }
    #[test]
    fn declaration_metadata_explicit_save_refreshes_minimal_private_owner_bound_cache() {
        let data = tempfile::tempdir().unwrap();
        save_servers(data.path(), "owner", &[declaration_server()]).unwrap();
        let cache = std::fs::read(declaration_cache_path(data.path(), "owner")).unwrap();
        let public: Value = serde_json::from_slice(&cache).unwrap();
        assert_eq!(public.as_object().unwrap().len(), 4);
        assert_eq!(public["version"], 1);
        assert_eq!(public["owner"], "owner");
        assert_eq!(public["anyEnabled"], true);
        assert!(!String::from_utf8_lossy(&cache).contains("SYNTHETIC-PRIVATE-TOKEN"));
        assert!(declaration_metadata(data.path(), "owner").unwrap());
    }
    #[test]
    fn declaration_metadata_fresh_cache_does_not_read_or_recreate_encryption_key() {
        let data = tempfile::tempdir().unwrap();
        save_servers(data.path(), "owner", &[declaration_server()]).unwrap();
        synthetic_metadata(data.path(), "owner", "owner", true);
        let key = data.path().join("agent-mcp/encryption-key");
        std::fs::remove_file(&key).unwrap();
        std::fs::create_dir(&key).unwrap();
        let config = std::fs::read(config_path(data.path(), "owner")).unwrap();
        let cache = std::fs::read(declaration_cache_path(data.path(), "owner")).unwrap();
        assert!(declaration_metadata(data.path(), "owner").unwrap());
        assert!(key.is_dir());
        assert_eq!(
            std::fs::read(config_path(data.path(), "owner")).unwrap(),
            config
        );
        assert_eq!(
            std::fs::read(declaration_cache_path(data.path(), "owner")).unwrap(),
            cache
        );
    }
    #[test]
    fn declaration_metadata_missing_stale_corrupt_and_foreign_cache_fail_without_repair() {
        let data = tempfile::tempdir().unwrap();
        save_servers(data.path(), "owner", &[declaration_server()]).unwrap();
        let path = declaration_cache_path(data.path(), "owner");
        let _ = std::fs::remove_file(&path);
        assert!(declaration_metadata(data.path(), "owner").is_err());
        assert!(!path.exists());
        synthetic_metadata(data.path(), "owner", "foreign", true);
        let foreign = std::fs::read(&path).unwrap();
        assert!(declaration_metadata(data.path(), "owner").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), foreign);
        synthetic_metadata(data.path(), "owner", "owner", true);
        let config = config_path(data.path(), "owner");
        let mut bytes = std::fs::read(&config).unwrap();
        bytes.push(b' ');
        std::fs::write(&config, &bytes).unwrap();
        assert!(declaration_metadata(data.path(), "owner").is_err());
        assert_eq!(std::fs::read(&config).unwrap(), bytes);
        std::fs::write(&path, b"broken").unwrap();
        assert!(declaration_metadata(data.path(), "owner").is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"broken");
    }
    #[cfg(unix)]
    #[test]
    fn declaration_metadata_rejects_config_cache_and_parent_symlinks() {
        use std::os::unix::fs::symlink;
        for target in ["cache", "config", "directory"] {
            let data = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            save_servers(data.path(), "owner", &[declaration_server()]).unwrap();
            synthetic_metadata(data.path(), "owner", "owner", true);
            if target == "directory" {
                let path = data.path().join("agent-mcp");
                std::fs::rename(&path, outside.path().join("owned")).unwrap();
                symlink(outside.path().join("owned"), path).unwrap();
            } else {
                let path = if target == "cache" {
                    declaration_cache_path(data.path(), "owner")
                } else {
                    config_path(data.path(), "owner")
                };
                std::fs::rename(&path, outside.path().join("owned")).unwrap();
                symlink(outside.path().join("owned"), path).unwrap();
            }
            assert!(
                declaration_metadata(data.path(), "owner").is_err(),
                "{target}"
            );
        }
    }
}
