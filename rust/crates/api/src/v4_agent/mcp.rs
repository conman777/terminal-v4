//! V4's own bounded MCP tools client. Configuration is opt-in and account scoped.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

pub(crate) const PROTOCOL_VERSION: &str = "2025-11-25";
const MAX_MESSAGE: usize = 1_048_576;
const MAX_RESPONSE: usize = 2_097_152;
const MAX_TOOLS: usize = 200;
const SUPPORTED_VERSIONS: &[&str] = &[PROTOCOL_VERSION, "2025-06-18", "2025-03-26"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    pub transport: TransportConfig,
}
fn default_timeout() -> u64 {
    30
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum TransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default, rename = "bearerToken")]
        bearer_token: Option<String>,
    },
}
impl ServerConfig {
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.validate_with_availability(true)
    }
    pub(crate) fn validate_stored(&self) -> Result<(), String> {
        self.validate_with_availability(false)
    }
    fn validate_with_availability(&self, require_executable: bool) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(
                "MCP server ID must contain 1-64 letters, digits, underscores or hyphens".into(),
            );
        }
        if self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err("MCP server name must contain 1-80 printable characters".into());
        }
        if !(1..=120).contains(&self.timeout_seconds) {
            return Err("MCP request timeout must be 1-120 seconds".into());
        }
        if serde_json::to_vec(self)
            .map_err(|_| "Invalid MCP configuration")?
            .len()
            > 65_536
        {
            return Err("MCP configuration exceeds its limit".into());
        }
        match &self.transport {
            TransportConfig::Http { url, bearer_token } => {
                validate_url(url)?;
                if bearer_token.as_ref().is_some_and(|token| {
                    token.is_empty()
                        || token.len() > 8192
                        || !token.bytes().all(|b| (0x21..=0x7e).contains(&b))
                }) {
                    return Err(
                        "MCP bearer token must contain 1-8192 visible ASCII characters".into(),
                    );
                }
            }
            TransportConfig::Stdio { command, args, env } => {
                let path = Path::new(command);
                if !path.is_absolute()
                    || (require_executable && !path.is_file())
                    || command.contains('\0')
                {
                    return Err("MCP command must be an existing absolute executable path".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if require_executable
                        && std::fs::metadata(path)
                            .map_err(|_| "MCP executable is unavailable")?
                            .permissions()
                            .mode()
                            & 0o111
                            == 0
                    {
                        return Err("MCP command is not executable".into());
                    }
                }
                #[cfg(windows)]
                {
                    if !path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                        e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("com")
                    }) {
                        return Err("MCP command must be a native executable; shell scripts need an explicitly configured interpreter".into());
                    }
                }
                if args.len() > 100 || args.iter().any(|a| a.len() > 4096 || a.contains('\0')) {
                    return Err("MCP arguments exceed their limit or contain NUL".into());
                }
                if env.len() > 64
                    || env.iter().any(|(name, value)| {
                        name.is_empty()
                            || name.len() > 128
                            || !name.bytes().enumerate().all(|(i, b)| {
                                b == b'_'
                                    || b.is_ascii_alphabetic()
                                    || (i > 0 && b.is_ascii_digit())
                            })
                            || value.len() > 16_384
                            || value.contains('\0')
                    })
                {
                    return Err(
                        "MCP environment contains an invalid name or exceeds its limit".into(),
                    );
                }
            }
        }
        Ok(())
    }
}
pub(crate) fn validate_url(value: &str) -> Result<url::Url, String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("Invalid MCP URL".into());
    }
    let url = url::Url::parse(value).map_err(|_| "Invalid MCP URL")?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("MCP URL must use HTTPS or literal loopback HTTP, without credentials, query or fragment".into());
    }
    Ok(url)
}

#[derive(Clone, Deserialize, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerInfo {
    pub protocol_version: String,
    pub server_info: Value,
    pub capabilities: Value,
    pub instructions: Option<String>,
}

#[async_trait::async_trait]
pub(crate) trait HostRequestHandler: Send + Sync {
    async fn handle(&self, method: &str, params: &Value) -> Result<Value, String>;
}
#[derive(Clone, Default)]
pub(crate) struct ClientPolicy {
    roots: Option<Vec<Value>>,
    sampling: Option<std::sync::Arc<dyn HostRequestHandler>>,
    elicitation: Option<std::sync::Arc<dyn HostRequestHandler>>,
    apps: bool,
}
impl ClientPolicy {
    pub(crate) fn with_apps(mut self) -> Self {
        self.apps = true;
        self
    }
    #[cfg(test)]
    pub(crate) fn with_approved_roots(
        mut self,
        paths: &[std::path::PathBuf],
    ) -> Result<Self, String> {
        if paths.len() > 20 {
            return Err("At most20 approved MCP roots may be shared".into());
        }
        let mut roots = Vec::new();
        let mut unique = HashSet::new();
        for path in paths {
            let path = path
                .canonicalize()
                .map_err(|_| "Approved MCP root is unavailable")?;
            if !path.is_dir() {
                return Err("Approved MCP root must be a directory".into());
            }
            let uri = url::Url::from_directory_path(&path)
                .map_err(|_| "Invalid approved MCP root")?
                .to_string();
            if unique.insert(uri.clone()) {
                roots.push(json!({"uri":uri,"name":path.file_name().and_then(|s|s.to_str()).unwrap_or("Workspace")}));
            }
        }
        self.roots = Some(roots);
        Ok(self)
    }
    #[cfg(test)]
    pub(crate) fn with_sampling_handler(
        mut self,
        handler: std::sync::Arc<dyn HostRequestHandler>,
    ) -> Self {
        self.sampling = Some(handler);
        self
    }
    #[cfg(test)]
    pub(crate) fn with_elicitation_handler(
        mut self,
        handler: std::sync::Arc<dyn HostRequestHandler>,
    ) -> Self {
        self.elicitation = Some(handler);
        self
    }
    fn capabilities(&self) -> Value {
        let mut value = json!({});
        if self.apps {
            value["extensions"] =
                json!({"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}});
        }
        if self.roots.is_some() {
            value["roots"] = json!({"listChanged":false});
        }
        if self.sampling.is_some() {
            value["sampling"] = json!({});
        }
        if self.elicitation.is_some() {
            value["elicitation"] = json!({"form":{}});
        }
        value
    }
    async fn server_result(&self, method: &str, params: &Value) -> Result<Value, i64> {
        match method {
            "ping" => Ok(json!({})),
            "roots/list" => self
                .roots
                .as_ref()
                .map(|roots| json!({"roots":roots}))
                .ok_or(-32601),
            "sampling/createMessage" => {
                let handler = self.sampling.as_ref().ok_or(-32601)?;
                let result = handler.handle(method, params).await.map_err(|_| -32000)?;
                if !matches!(result["role"].as_str(), Some("user" | "assistant"))
                    || !result["model"].is_string()
                    || !(result["content"].is_object() || result["content"].is_array())
                {
                    return Err(-32603);
                }
                Ok(result)
            }
            "elicitation/create" if params["mode"].as_str().is_none_or(|mode| mode == "form") => {
                let handler = self.elicitation.as_ref().ok_or(-32601)?;
                let result = handler.handle(method, params).await.map_err(|_| -32000)?;
                if !matches!(
                    result["action"].as_str(),
                    Some("accept" | "decline" | "cancel")
                ) {
                    return Err(-32603);
                }
                Ok(result)
            }
            _ => Err(-32601),
        }
    }
}

struct Stdio {
    child: tokio::process::Child,
    input: Option<tokio::process::ChildStdin>,
    output: tokio::io::BufReader<tokio::process::ChildStdout>,
    tree: Option<crate::process_tree::ProcessTree>,
}
impl Drop for Stdio {
    fn drop(&mut self) {
        self.tree.take();
        let _ = self.child.start_kill();
    }
}

struct Http {
    client: reqwest::Client,
    url: url::Url,
    token: Option<String>,
    session: Option<String>,
    version: Option<String>,
}
impl Http {
    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, self.url.clone())
            .header("Accept", "application/json, text/event-stream");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = &self.session {
            request = request.header("MCP-Session-Id", session);
        }
        if let Some(version) = &self.version {
            request = request.header("MCP-Protocol-Version", version);
        }
        request
    }
    async fn send_message(&self, message: &Value) -> Result<(), String> {
        let response = self
            .request(reqwest::Method::POST)
            .json(message)
            .send()
            .await
            .map_err(|_| "MCP HTTP connection failed")?;
        if response.status() != reqwest::StatusCode::ACCEPTED {
            return Err(format!(
                "MCP notification rejected (HTTP {})",
                response.status().as_u16()
            ));
        }
        Ok(())
    }
    async fn exchange(
        &mut self,
        message: &Value,
        id: u64,
        policy: &ClientPolicy,
    ) -> Result<Value, String> {
        let mut response = self
            .request(reqwest::Method::POST)
            .json(message)
            .send()
            .await
            .map_err(|_| "MCP HTTP connection failed")?;
        if message["method"] == "initialize" {
            if let Some(value) = response.headers().get("mcp-session-id") {
                let value = value.to_str().map_err(|_| "Invalid MCP session header")?;
                if value.is_empty()
                    || value.len() > 1024
                    || !value.bytes().all(|b| (0x21..=0x7e).contains(&b))
                {
                    return Err("Invalid MCP session header".into());
                }
                self.session = Some(value.to_owned());
            }
        }
        let mut total = 0usize;
        let mut cursor = None;
        let mut retry = Duration::from_millis(100);
        for resume in 0..=2 {
            if !response.status().is_success() {
                return Err(
                    if response.status() == reqwest::StatusCode::NOT_FOUND && self.session.is_some()
                    {
                        "MCP session expired; reconnect before continuing".into()
                    } else {
                        format!("MCP request failed (HTTP {})", response.status().as_u16())
                    },
                );
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_owned();
            if content_type == "application/json" {
                let bytes = bounded_body(response, MAX_MESSAGE).await?;
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP JSON response")?;
                return match classify(value, id, policy).await? {
                    Incoming::Result(result) => Ok(result),
                    _ => Err("MCP JSON response did not match its request".into()),
                };
            }
            if content_type != "text/event-stream" {
                return Err("MCP response must be JSON or an event stream".into());
            }
            let mut stream = response.bytes_stream();
            let mut decoder = SseDecoder::default();
            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(_) => break,
                };
                total = total.saturating_add(chunk.len());
                if total > MAX_RESPONSE {
                    return Err("MCP response exceeds its limit".into());
                }
                for event in decoder.push(&chunk)? {
                    if let Some(id) = event.id {
                        cursor = if id.is_empty() { None } else { Some(id) };
                    }
                    if let Some(milliseconds) = event.retry {
                        retry = Duration::from_millis(milliseconds.clamp(10, 5000));
                    }
                    if event.data.is_empty() {
                        continue;
                    }
                    let value = serde_json::from_slice(&event.data)
                        .map_err(|_| "Invalid MCP event JSON")?;
                    match classify(value, id, policy).await? {
                        Incoming::Result(result) => return Ok(result),
                        Incoming::Reply(reply) => self.send_message(&reply).await?,
                        Incoming::Ignore => {}
                    }
                }
            }
            if resume == 2 || cursor.is_none() {
                return Err("MCP event stream ended before its response".into());
            }
            tokio::time::sleep(retry).await;
            response = self
                .request(reqwest::Method::GET)
                .header("Accept", "text/event-stream")
                .header("Last-Event-ID", cursor.as_deref().unwrap())
                .send()
                .await
                .map_err(|_| "MCP event stream could not resume")?;
        }
        Err("MCP event stream did not complete".into())
    }
    async fn close(&mut self) -> Result<(), String> {
        if self.session.is_none() {
            return Ok(());
        }
        let response = self
            .request(reqwest::Method::DELETE)
            .send()
            .await
            .map_err(|_| "MCP session cleanup failed")?;
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            self.session = None;
            Ok(())
        } else if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            Err("MCP server does not support explicit session termination; remote cleanup is unconfirmed".into())
        } else {
            Err("MCP session cleanup rejected; retry closing the session".into())
        }
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        if self.session.is_none() {
            return;
        }
        let request = self.request(reqwest::Method::DELETE);
        self.session = None;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(2), request.send()).await;
            });
        }
    }
}
async fn bounded_body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("MCP response exceeds its limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read MCP response")?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("MCP response exceeds its limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[derive(Default)]
struct SseEvent {
    data: Vec<u8>,
    id: Option<String>,
    retry: Option<u64>,
}
#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    event: SseEvent,
    last_cr: bool,
    first_line_seen: bool,
}
impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, String> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.last_cr && byte == b'\n' {
                self.last_cr = false;
                continue;
            }
            self.last_cr = byte == b'\r';
            if byte == b'\r' || byte == b'\n' {
                let mut line = std::mem::take(&mut self.line);
                if !self.first_line_seen {
                    self.first_line_seen = true;
                    if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                        line.drain(..3);
                    }
                }
                if line.is_empty() {
                    events.push(std::mem::take(&mut self.event));
                    continue;
                }
                if line[0] == b':' {
                    continue;
                }
                let colon = line.iter().position(|b| *b == b':').unwrap_or(line.len());
                let mut value = if colon < line.len() {
                    &line[colon + 1..]
                } else {
                    &[]
                };
                if value.first() == Some(&b' ') {
                    value = &value[1..];
                }
                match &line[..colon] {
                    b"data" => {
                        if !self.event.data.is_empty() {
                            self.event.data.push(b'\n');
                        }
                        self.event.data.extend_from_slice(value);
                    }
                    b"id" => {
                        let id = std::str::from_utf8(value).map_err(|_| "Invalid MCP event ID")?;
                        if id.len() > 1024 || id.chars().any(char::is_control) {
                            return Err("Invalid MCP event ID".into());
                        }
                        self.event.id = Some(id.into());
                    }
                    b"retry" => {
                        self.event.retry =
                            std::str::from_utf8(value).ok().and_then(|s| s.parse().ok());
                    }
                    _ => {}
                }
            } else {
                self.line.push(byte);
            }
            if self.line.len().saturating_add(self.event.data.len()) > MAX_MESSAGE {
                return Err("MCP event exceeds its limit".into());
            }
        }
        Ok(events)
    }
}
enum Incoming {
    Result(Value),
    Reply(Value),
    Ignore,
}
async fn classify(value: Value, id: u64, policy: &ClientPolicy) -> Result<Incoming, String> {
    if !value.is_object() || value["jsonrpc"] != "2.0" {
        return Err("Invalid MCP JSON-RPC message".into());
    }
    if let Some(method) = value.get("method") {
        if !method.is_string() {
            return Err("Invalid MCP method".into());
        }
        if let Some(server_id) = value.get("id") {
            if !(server_id.is_number() || server_id.as_str().is_some_and(|s| s.len() <= 200)) {
                return Err("Invalid MCP server request ID".into());
            }
            let result = policy
                .server_result(
                    method.as_str().unwrap_or(""),
                    value.get("params").unwrap_or(&Value::Null),
                )
                .await;
            return Ok(Incoming::Reply(match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":server_id,"result":result}),
                Err(code) => {
                    json!({"jsonrpc":"2.0","id":server_id,"error":{"code":code,"message":if code == -32601{"V4 did not advertise this client capability"}else{"V4 host did not approve or complete this request"}}})
                }
            }));
        }
        return Ok(Incoming::Ignore);
    }
    if value["id"] != id {
        return Ok(Incoming::Ignore);
    }
    if let Some(error) = value.get("error") {
        return Err(format!(
            "MCP request failed (JSON-RPC code {})",
            error["code"].as_i64().unwrap_or(-32603)
        ));
    }
    value
        .get("result")
        .cloned()
        .map(Incoming::Result)
        .ok_or_else(|| "MCP response has no result".into())
}
enum Transport {
    Stdio(Stdio),
    Http(Http),
    Closed,
}
impl Transport {
    async fn send_message(&mut self, message: &Value) -> Result<(), String> {
        match self {
            Self::Stdio(io) => {
                let mut bytes = serde_json::to_vec(message).map_err(|_| "Invalid MCP message")?;
                bytes.push(b'\n');
                let input = io.input.as_mut().ok_or("MCP connection is closed")?;
                input
                    .write_all(&bytes)
                    .await
                    .map_err(|_| "Could not write MCP request")?;
                input
                    .flush()
                    .await
                    .map_err(|_| "Could not flush MCP request".to_owned())
            }
            Self::Http(http) => http.send_message(message).await,
            Self::Closed => Err("MCP connection is closed".into()),
        }
    }
    async fn exchange(
        &mut self,
        message: &Value,
        id: u64,
        policy: &ClientPolicy,
    ) -> Result<Value, String> {
        if let Self::Http(http) = self {
            return http.exchange(message, id, policy).await;
        }
        self.send_message(message).await?;
        let Self::Stdio(io) = self else {
            return Err("MCP connection is closed".into());
        };
        let mut total = 0usize;
        loop {
            let mut line = Vec::new();
            let read = (&mut io.output)
                .take((MAX_MESSAGE + 1) as u64)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|_| "Could not read MCP output")?;
            if read == 0 {
                return Err("MCP server closed its output".into());
            }
            total = total.saturating_add(read);
            if line.len() > MAX_MESSAGE || total > MAX_RESPONSE {
                return Err("MCP output exceeds its limit".into());
            }
            if line.last() != Some(&b'\n') {
                return Err("MCP server emitted an incomplete message".into());
            }
            let value =
                serde_json::from_slice(&line).map_err(|_| "MCP server emitted invalid JSON")?;
            match classify(value, id, policy).await? {
                Incoming::Result(result) => return Ok(result),
                Incoming::Reply(reply) => {
                    let mut bytes =
                        serde_json::to_vec(&reply).map_err(|_| "Invalid MCP response")?;
                    bytes.push(b'\n');
                    let input = io.input.as_mut().ok_or("MCP connection is closed")?;
                    input
                        .write_all(&bytes)
                        .await
                        .map_err(|_| "Could not answer MCP server")?;
                    input
                        .flush()
                        .await
                        .map_err(|_| "Could not flush MCP response")?;
                }
                Incoming::Ignore => {}
            }
        }
    }
}
#[derive(Clone)]
struct PendingRequest {
    id: u64,
    initialize: bool,
}
pub(crate) struct McpClient {
    transport: Transport,
    info: ServerInfo,
    timeout: Duration,
    next_id: u64,
    tools: Vec<Tool>,
    policy: ClientPolicy,
    pending: Option<PendingRequest>,
    interrupted: bool,
}
impl McpClient {
    #[cfg(test)]
    pub(crate) async fn connect(config: &ServerConfig) -> Result<Self, String> {
        Self::connect_with_policy(config, ClientPolicy::default()).await
    }
    #[cfg(test)]
    pub(crate) async fn connect_with_policy(
        config: &ServerConfig,
        policy: ClientPolicy,
    ) -> Result<Self, String> {
        let mut client = Self::prepare_with_policy(config, policy)?;
        client.initialize().await?;
        Ok(client)
    }
    pub(crate) fn prepare(config: &ServerConfig) -> Result<Self, String> {
        Self::prepare_with_policy(config, ClientPolicy::default())
    }
    pub(crate) fn prepare_with_policy(
        config: &ServerConfig,
        policy: ClientPolicy,
    ) -> Result<Self, String> {
        config.validate()?;
        let transport = match &config.transport {
            TransportConfig::Http { url, bearer_token } => Transport::Http(Http {
                client: reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|_| "Could not create MCP HTTP client")?,
                url: validate_url(url)?,
                token: bearer_token.clone(),
                session: None,
                version: None,
            }),
            TransportConfig::Stdio { command, args, env } => {
                let mut command = tokio::process::Command::new(command);
                command
                    .args(args)
                    .env_clear()
                    .envs(env)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true);
                #[cfg(unix)]
                command.process_group(0);
                let mut child = command
                    .spawn()
                    .map_err(|_| "Could not launch configured MCP executable")?;
                let tree = crate::process_tree::ProcessTree::attach(&child)
                    .map_err(|_| "Could not contain MCP process tree")?;
                let input = child.stdin.take().ok_or("MCP stdin is unavailable")?;
                let output = child.stdout.take().ok_or("MCP stdout is unavailable")?;
                Transport::Stdio(Stdio {
                    tree: Some(tree),
                    child,
                    input: Some(input),
                    output: tokio::io::BufReader::new(output),
                })
            }
        };
        Ok(Self {
            transport,
            info: ServerInfo {
                protocol_version: String::new(),
                server_info: Value::Null,
                capabilities: Value::Null,
                instructions: None,
            },
            timeout: Duration::from_secs(config.timeout_seconds),
            next_id: 1,
            tools: Vec::new(),
            policy,
            pending: None,
            interrupted: false,
        })
    }
    pub(crate) async fn initialize(&mut self) -> Result<(), String> {
        if !self.info.protocol_version.is_empty() {
            return Err("MCP client was already initialized".into());
        }
        let initialized=self.request("initialize",json!({"protocolVersion":PROTOCOL_VERSION,"capabilities":self.policy.capabilities(),"clientInfo":{"name":"terminal-v4","version":env!("CARGO_PKG_VERSION")}})).await?;
        let version = initialized["protocolVersion"]
            .as_str()
            .filter(|v| SUPPORTED_VERSIONS.contains(v))
            .ok_or("MCP server selected an unsupported protocol version")?;
        if !initialized["capabilities"].is_object() || !initialized["serverInfo"].is_object() {
            return Err("Invalid MCP initialization result".into());
        }
        self.info = ServerInfo {
            protocol_version: version.into(),
            server_info: initialized["serverInfo"].clone(),
            capabilities: initialized["capabilities"].clone(),
            instructions: initialized["instructions"]
                .as_str()
                .filter(|v| v.len() <= 16_384)
                .map(str::to_owned),
        };
        if let Transport::Http(http) = &mut self.transport {
            http.version = Some(version.into());
        }
        tokio::time::timeout(
            self.timeout,
            self.transport
                .send_message(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
        )
        .await
        .map_err(|_| "MCP initialization notification timed out")??;
        Ok(())
    }
    pub(crate) fn info(&self) -> &ServerInfo {
        &self.info
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if self.pending.is_some() || self.interrupted {
            return Err(
                "MCP previous request was interrupted; close and reconnect before continuing"
                    .into(),
            );
        }
        if matches!(self.transport, Transport::Closed) {
            return Err("MCP connection is closed".into());
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("MCP request ID limit reached")?;
        let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        if serde_json::to_vec(&message)
            .map_err(|_| "Invalid MCP request")?
            .len()
            > MAX_MESSAGE
        {
            return Err("MCP request exceeds its limit".into());
        }
        let policy = if method == "initialize" {
            ClientPolicy::default()
        } else {
            self.policy.clone()
        };
        self.pending = Some(PendingRequest {
            id,
            initialize: method == "initialize",
        });
        match tokio::time::timeout(self.timeout, self.transport.exchange(&message, id, &policy))
            .await
        {
            Ok(result) => {
                self.pending = None;
                if result
                    .as_ref()
                    .is_err_and(|error| !error.contains("JSON-RPC code"))
                {
                    self.interrupted = true;
                }
                result
            }
            Err(_) => {
                self.interrupted = true;
                self.cancel_pending(Duration::from_millis(250)).await;
                Err("MCP request timed out".into())
            }
        }
    }
    pub(crate) async fn list_tools(&mut self) -> Result<Vec<Tool>, String> {
        if self.info.capabilities.get("tools").is_none() {
            self.tools.clear();
            return Ok(Vec::new());
        }
        let mut tools = Vec::new();
        let mut names = HashSet::new();
        let mut cursors = HashSet::new();
        let mut cursor = None;
        for _ in 0..20 {
            let page = self
                .request(
                    "tools/list",
                    cursor
                        .as_ref()
                        .map(|c| json!({"cursor":c}))
                        .unwrap_or(json!({})),
                )
                .await?;
            let entries = page["tools"]
                .as_array()
                .ok_or("MCP tools list is invalid")?;
            for entry in entries {
                if tools.len() >= MAX_TOOLS
                    || serde_json::to_vec(entry)
                        .map_err(|_| "Invalid MCP tool")?
                        .len()
                        > 65_536
                {
                    return Err("MCP tools list exceeds its limit".into());
                }
                let tool: Tool = serde_json::from_value(entry.clone())
                    .map_err(|_| "Invalid MCP tool definition")?;
                if tool.name.is_empty()
                    || tool.name.len() > 128
                    || tool.name.chars().any(char::is_control)
                    || !names.insert(tool.name.clone())
                    || !tool.input_schema.is_object()
                    || tool.input_schema["type"] != "object"
                    || tool.description.as_ref().is_some_and(|d| d.len() > 16_384)
                {
                    return Err("Invalid or duplicate MCP tool definition".into());
                }
                tools.push(tool);
            }
            match page.get("nextCursor") {
                None | Some(Value::Null) => {
                    self.tools = tools.clone();
                    return Ok(tools);
                }
                Some(Value::String(next))
                    if !next.is_empty() && next.len() <= 4096 && cursors.insert(next.clone()) =>
                {
                    cursor = Some(next.clone())
                }
                _ => return Err("MCP tools pagination cursor is invalid or repeated".into()),
            }
        }
        Err("MCP tools pagination exceeds its limit".into())
    }
    async fn list_collection(
        &mut self,
        capability: &str,
        method: &str,
        field: &str,
        identity: &str,
    ) -> Result<Vec<Value>, String> {
        if self.info.capabilities.get(capability).is_none() {
            return Ok(Vec::new());
        }
        let mut result = Vec::new();
        let mut identities = HashSet::new();
        let mut cursors = HashSet::new();
        let mut cursor = None;
        let mut total = 0usize;
        for _ in 0..20 {
            let page = self
                .request(
                    method,
                    cursor
                        .as_ref()
                        .map(|cursor| json!({"cursor":cursor}))
                        .unwrap_or(json!({})),
                )
                .await?;
            let entries = page[field].as_array().ok_or("Invalid MCP collection")?;
            for entry in entries {
                let size = serde_json::to_vec(entry)
                    .map_err(|_| "Invalid MCP collection item")?
                    .len();
                total = total.saturating_add(size);
                let name = entry["name"]
                    .as_str()
                    .ok_or("MCP collection item has no name")?;
                let key = entry[identity]
                    .as_str()
                    .ok_or("MCP collection item has no identifier")?;
                if result.len() >= 200
                    || size > 65_536
                    || total > MAX_RESPONSE
                    || name.is_empty()
                    || name.len() > 256
                    || name.chars().any(char::is_control)
                    || key.is_empty()
                    || key.len() > 8192
                    || key.chars().any(char::is_control)
                    || !identities.insert(key.to_owned())
                {
                    return Err("MCP collection is invalid or exceeds its limit".into());
                }
                result.push(entry.clone());
            }
            match page.get("nextCursor") {
                None | Some(Value::Null) => return Ok(result),
                Some(Value::String(next))
                    if !next.is_empty() && next.len() <= 4096 && cursors.insert(next.clone()) =>
                {
                    cursor = Some(next.clone())
                }
                _ => return Err("MCP collection cursor is invalid or repeated".into()),
            }
        }
        Err("MCP collection pagination exceeds its limit".into())
    }
    pub(crate) async fn list_resources(&mut self) -> Result<Vec<Value>, String> {
        self.list_collection("resources", "resources/list", "resources", "uri")
            .await
    }
    pub(crate) async fn list_resource_templates(&mut self) -> Result<Vec<Value>, String> {
        self.list_collection(
            "resources",
            "resources/templates/list",
            "resourceTemplates",
            "uriTemplate",
        )
        .await
    }
    pub(crate) async fn read_resource(&mut self, uri: &str) -> Result<Value, String> {
        if self.info.capabilities.get("resources").is_none() {
            return Err("MCP server did not advertise resources".into());
        }
        if uri.len() > 8192 || uri.chars().any(char::is_control) || url::Url::parse(uri).is_err() {
            return Err("Invalid MCP resource URI".into());
        }
        let result = self.request("resources/read", json!({"uri":uri})).await?;
        let contents = result["contents"]
            .as_array()
            .ok_or("Invalid MCP resource result")?;
        if contents.len() > 100
            || contents.iter().any(|content| {
                !content.is_object()
                    || !content["uri"].is_string()
                    || (content["text"].is_string() == content["blob"].is_string())
            })
        {
            return Err("Invalid MCP resource contents".into());
        }
        Ok(result)
    }
    pub(crate) async fn list_prompts(&mut self) -> Result<Vec<Value>, String> {
        self.list_collection("prompts", "prompts/list", "prompts", "name")
            .await
    }
    pub(crate) async fn get_prompt(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        if self.info.capabilities.get("prompts").is_none() {
            return Err("MCP server did not advertise prompts".into());
        }
        if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err("Invalid MCP prompt name".into());
        }
        let args = arguments
            .as_object()
            .ok_or("MCP prompt arguments must be an object")?;
        if args.len() > 100
            || args.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 128
                    || key.chars().any(char::is_control)
                    || !value.as_str().is_some_and(|value| value.len() <= 16_384)
            })
        {
            return Err("MCP prompt argument names and string values exceed their limit".into());
        }
        let result = self
            .request("prompts/get", json!({"name":name,"arguments":arguments}))
            .await?;
        let messages = result["messages"]
            .as_array()
            .ok_or("Invalid MCP prompt result")?;
        if messages.len() > 100
            || messages.iter().any(|message| {
                !matches!(message["role"].as_str(), Some("user" | "assistant"))
                    || !message["content"].is_object()
                    || !message["content"]["type"].is_string()
            })
        {
            return Err("Invalid MCP prompt messages".into());
        }
        Ok(result)
    }
    pub(crate) async fn call_tool(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        if !self.tools.iter().any(|tool| tool.name == name) {
            return Err("MCP tool must be discovered before calling it".into());
        }
        if !arguments.is_object() {
            return Err("MCP tool arguments must be an object".into());
        }
        let result = self
            .request("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        if !result.is_object() || !result["content"].is_array() {
            return Err("Invalid MCP tool result".into());
        }
        Ok(result)
    }
    async fn cancel_pending(&mut self, budget: Duration) {
        let Some(pending) = self.pending.clone() else {
            return;
        };
        if pending.initialize {
            self.pending = None;
            return;
        }
        let notification = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":pending.id,"reason":"V4 client request cancelled"}});
        if matches!(
            tokio::time::timeout(budget, self.transport.send_message(&notification)).await,
            Ok(Ok(()))
        ) {
            self.pending = None;
        }
    }
    pub(crate) async fn close(&mut self) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        self.cancel_pending(Duration::from_millis(250)).await;
        let result = tokio::time::timeout_at(deadline, async {
            match &mut self.transport {
                Transport::Http(http) => http.close().await,
                Transport::Stdio(io) => {
                    io.input.take();
                    let _ = tokio::time::timeout(Duration::from_millis(200), io.child.wait()).await;
                    let tree = io
                        .tree
                        .as_ref()
                        .ok_or("MCP process containment is unavailable")?;
                    let (stopped, waited) =
                        tokio::join!(tree.stop(Duration::from_millis(200)), io.child.wait());
                    stopped.map_err(|_| "MCP process tree did not stop".to_owned())?;
                    waited.map_err(|_| "MCP process could not be reaped".to_owned())?;
                    Ok(())
                }
                Transport::Closed => Ok(()),
            }
        })
        .await
        .map_err(|_| "MCP cleanup timed out; live transport retained for retry".to_owned())?;
        if result.is_ok() {
            self.transport = Transport::Closed;
            self.pending = None;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn http_urls_require_https_or_literal_loopback_and_no_embedded_credentials() {
        for url in [
            "https://mcp.example.test/v1",
            "http://127.0.0.1:3009/mcp",
            "http://[::1]:3009/mcp",
        ] {
            assert!(validate_url(url).is_ok(), "{url}");
        }
        for url in [
            "file:///tmp/mcp",
            "http://192.168.1.2/mcp",
            "http://localhost.evil.test/mcp",
            "http://localhost/mcp",
            "https://user:secret@example.test/mcp",
            "https://example.test/mcp#fragment",
            "https://example.test/mcp?token=secret",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn sse_decoder_handles_fragmented_utf8_line_endings_comments_and_invalid_ids() {
        let wire =
            "\u{feff}: comment\rdata: {\rdata: \"message\":\"café 😃\"}\rid: cursor\rretry: 50\r\r";
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        for byte in wire.as_bytes() {
            events.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 1);
        assert_eq!(
            serde_json::from_slice::<Value>(&events[0].data).unwrap(),
            json!({"message":"café 😃"})
        );
        assert_eq!(events[0].id.as_deref(), Some("cursor"));
        assert_eq!(events[0].retry, Some(50));
        assert!(SseDecoder::default().push(b"id: invalid\0id\n\n").is_err());
        assert!(SseDecoder::default()
            .push(&vec![b'x'; MAX_MESSAGE + 1])
            .is_err());
    }
    #[test]
    fn sse_decoder_strips_a_fragmented_stream_bom_before_the_first_data_field() {
        let expected = json!({"jsonrpc":"2.0","id":7,"result":{"text":"café 😃"}});
        let wire = format!("\u{feff}data: {expected}\r\n\r\n");
        for fragment_size in [1, 2, 3, 4, 11, 1024] {
            let mut decoder = SseDecoder::default();
            let mut events = Vec::new();
            for fragment in wire.as_bytes().chunks(fragment_size) {
                events.extend(decoder.push(fragment).unwrap());
            }
            assert_eq!(events.len(), 1, "fragment size {fragment_size}");
            assert_eq!(
                serde_json::from_slice::<Value>(&events[0].data).unwrap(),
                expected
            );
        }
        let mut decoder = SseDecoder::default();
        let events = decoder
            .push("data: \"\u{feff}inside\"\n\n".as_bytes())
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&events[0].data).unwrap(),
            json!("\u{feff}inside")
        );
    }
    #[test]
    fn host_capabilities_are_denied_by_default_and_approved_roots_are_explicit() {
        assert_eq!(ClientPolicy::default().capabilities(), json!({}));
        let directory = tempfile::tempdir().unwrap();
        let policy = ClientPolicy::default()
            .with_approved_roots(&[directory.path().to_path_buf()])
            .unwrap();
        assert_eq!(
            policy.capabilities(),
            json!({"roots":{"listChanged":false}})
        );
        assert_eq!(
            policy.roots.as_ref().unwrap()[0]["uri"],
            url::Url::from_directory_path(directory.path().canonicalize().unwrap())
                .unwrap()
                .to_string()
        );
        assert!(ClientPolicy::default()
            .with_approved_roots(&[directory.path().join("missing")])
            .is_err());
    }
    struct SyntheticHost;
    #[async_trait::async_trait]
    impl HostRequestHandler for SyntheticHost {
        async fn handle(&self, method: &str, _params: &Value) -> Result<Value, String> {
            match method {
                "sampling/createMessage" => Ok(
                    json!({"role":"assistant","model":"synthetic-no-inference","content":{"type":"text","text":"Synthetic approved response"}}),
                ),
                "elicitation/create" => Ok(json!({"action":"decline"})),
                _ => Err("Unapproved request".into()),
            }
        }
    }
    #[tokio::test]
    async fn host_requests_default_deny_and_only_use_explicitly_registered_handlers() {
        let denied = ClientPolicy::default();
        for method in ["roots/list", "sampling/createMessage", "elicitation/create"] {
            assert_eq!(
                denied.server_result(method, &json!({})).await.unwrap_err(),
                -32601
            );
        }
        let policy = ClientPolicy::default()
            .with_sampling_handler(std::sync::Arc::new(SyntheticHost))
            .with_elicitation_handler(std::sync::Arc::new(SyntheticHost));
        assert_eq!(
            policy.capabilities(),
            json!({"sampling":{},"elicitation":{"form":{}}})
        );
        assert_eq!(
            policy
                .server_result("sampling/createMessage", &json!({}))
                .await
                .unwrap()["model"],
            "synthetic-no-inference"
        );
        assert_eq!(
            policy
                .server_result("elicitation/create", &json!({"mode":"form"}))
                .await
                .unwrap(),
            json!({"action":"decline"})
        );
        assert_eq!(
            policy
                .server_result(
                    "elicitation/create",
                    &json!({"mode":"url","url":"https://example.test"})
                )
                .await
                .unwrap_err(),
            -32601
        );
    }
    #[test]
    fn stdio_configuration_requires_explicit_absolute_executable_and_bounded_environment() {
        let mut server = ServerConfig {
            id: "fixture".into(),
            name: "Synthetic fixture".into(),
            enabled: true,
            timeout_seconds: 5,
            transport: TransportConfig::Stdio {
                command: "python3".into(),
                args: vec![],
                env: BTreeMap::new(),
            },
        };
        assert!(server.validate().is_err());
        if let TransportConfig::Stdio { command, .. } = &mut server.transport {
            *command = std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned();
        }
        assert!(server.validate().is_ok());
        if let TransportConfig::Stdio { env, .. } = &mut server.transport {
            env.insert("INVALID=NAME".into(), "value".into());
        }
        assert!(server.validate().is_err());
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use axum::{
        body::Body,
        extract::State,
        http::{Request, Response, StatusCode},
        routing::any,
        Router,
    };
    use std::{
        future::IntoFuture,
        sync::{Arc, Mutex},
    };
    use tokio::sync::oneshot;

    #[cfg(unix)]
    fn stdio_fixture(timeout_seconds: u64) -> (tempfile::TempDir, ServerConfig) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fixture.py");
        std::fs::write(&script, r#"import sys,json,os,time
ready=False
for line in sys.stdin:
 r=json.loads(line); method=r.get('method')
 if method=='notifications/initialized': ready=True; continue
 if 'id' not in r: continue
 if method=='initialize': result={'protocolVersion':'2099-01-01' if os.environ.get('FIXTURE_MODE')=='version' else '2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'V4 synthetic fixture','version':'1'}}
 elif method=='tools/list':
  assert ready
  mode=os.environ.get('FIXTURE_MODE')
  if mode=='limit': result={'tools':[{'name':'tool'+str(i),'inputSchema':{'type':'object'}} for i in range(201)]}
  elif mode=='duplicate': result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]*2}
  elif mode=='repeat': result={'tools':[],'nextCursor':'repeat'}
  else: result={'tools':[{'name':'echo','description':'Synthetic echo','inputSchema':{'type':'object'}}], 'nextCursor':'page2'} if not r.get('params',{}).get('cursor') else {'tools':[{'name':'hang','inputSchema':{'type':'object'}},{'name':'failure','inputSchema':{'type':'object'}},{'name':'oversize','inputSchema':{'type':'object'}}]}
 elif method=='tools/call':
  name=r['params']['name']
  if name=='hang': time.sleep(60)
  if name=='oversize': sys.stdout.write('x'*1100000+'\n');sys.stdout.flush();continue
  if name=='failure': sys.stdout.write(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32000,'message':'untrusted secret must not be reflected'}})+'\n');sys.stdout.flush();continue
  result={'content':[{'type':'text','text':json.dumps({'arguments':r['params']['arguments'],'secret':os.environ.get('FIXTURE_SECRET'),'inheritedHome':os.environ.get('HOME')})}]}
 else: continue
 message=json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result})+'\n'
 for piece in [message[:2],message[2:7],message[7:]]: sys.stdout.write(piece);sys.stdout.flush()
"#).unwrap();
        let python = ["/usr/bin/python3", "/opt/homebrew/bin/python3"]
            .into_iter()
            .find(|p| Path::new(p).is_file())
            .expect("Synthetic fixture needs Python 3");
        (
            directory,
            ServerConfig {
                id: "fixture".into(),
                name: "Synthetic stdio".into(),
                enabled: true,
                timeout_seconds,
                transport: TransportConfig::Stdio {
                    command: python.into(),
                    args: vec!["-u".into(), script.to_string_lossy().into_owned()],
                    env: BTreeMap::from([("FIXTURE_SECRET".into(), "synthetic-only".into())]),
                },
            },
        )
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_initializes_paginates_calls_and_does_not_inherit_home() {
        let (_directory, config) = stdio_fixture(3);
        let mut client = McpClient::connect(&config).await.unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(
            tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["echo", "hang", "failure", "oversize"]
        );
        assert!(client.call_tool("unknown", json!({})).await.is_err());
        let result = client
            .call_tool("echo", json!({"message":"hello"}))
            .await
            .unwrap();
        let text: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            text,
            json!({"arguments":{"message":"hello"},"secret":"synthetic-only","inheritedHome":null})
        );
        let error = client.call_tool("failure", json!({})).await.unwrap_err();
        assert!(error.contains("-32000"));
        assert!(!error.contains("secret"));
        client.close().await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_bounds_lines_and_drops_running_process_on_cancellation() {
        let (_directory, config) = stdio_fixture(2);
        let mut client = McpClient::connect(&config).await.unwrap();
        client.list_tools().await.unwrap();
        assert!(client
            .call_tool("oversize", json!({}))
            .await
            .unwrap_err()
            .contains("limit"));
        client.close().await.unwrap();
        let mut client = McpClient::connect(&config).await.unwrap();
        client.list_tools().await.unwrap();
        let pid = match &client.transport {
            Transport::Stdio(io) => io.child.id().unwrap(),
            _ => unreachable!(),
        };
        assert!(tokio::time::timeout(
            Duration::from_millis(100),
            client.call_tool("hang", json!({}))
        )
        .await
        .is_err());
        drop(client);
        #[cfg(unix)]
        {
            for _ in 0..100 {
                if unsafe { libc::kill(pid as i32, 0) } != 0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("MCP fixture process remained alive after drop");
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_rejects_unsupported_versions_duplicate_tools_limits_and_repeated_cursors() {
        for mode in ["version", "limit", "duplicate", "repeat"] {
            let (_directory, mut config) = stdio_fixture(3);
            if let TransportConfig::Stdio { env, .. } = &mut config.transport {
                env.insert("FIXTURE_MODE".into(), mode.into());
            }
            if mode == "version" {
                assert!(McpClient::connect(&config).await.is_err());
                continue;
            }
            let mut client = McpClient::connect(&config).await.unwrap();
            assert!(client.list_tools().await.is_err(), "{mode}");
            client.close().await.unwrap();
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_request_timeout_is_bounded_and_reports_cancellation() {
        let (_directory, config) = stdio_fixture(1);
        let mut client = McpClient::connect(&config).await.unwrap();
        client.list_tools().await.unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            client.call_tool("hang", json!({})).await.unwrap_err(),
            "MCP request timed out"
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        client.close().await.unwrap();
    }
    #[derive(Clone)]
    struct HttpFixture {
        requests: Arc<Mutex<Vec<Value>>>,
        sse: bool,
        behavior: &'static str,
    }
    async fn http_handler(
        State(state): State<HttpFixture>,
        request: Request<Body>,
    ) -> Response<Body> {
        let method = request.method().clone();
        let headers = request.headers().clone();
        let bytes = axum::body::to_bytes(request.into_body(), MAX_RESPONSE)
            .await
            .unwrap();
        let message: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        state.requests.lock().unwrap().push(json!({"method":method.as_str(),"session":headers.get("mcp-session-id").and_then(|s|s.to_str().ok()),"version":headers.get("mcp-protocol-version").and_then(|s|s.to_str().ok()),"authorization":headers.get("authorization").and_then(|s|s.to_str().ok()),"lastEventId":headers.get("last-event-id").and_then(|s|s.to_str().ok()),"message":message}));
        if state.behavior == "close-budget"
            && (method == "DELETE" || message["method"] == "notifications/cancelled")
        {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        if method == "DELETE" {
            let status = if state.behavior == "delete-unsupported" {
                StatusCode::METHOD_NOT_ALLOWED
            } else if state.behavior == "delete-retry"
                && state
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|request| request["method"] == "DELETE")
                    .count()
                    == 1
            {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::NO_CONTENT
            };
            return Response::builder()
                .status(status)
                .body(Body::empty())
                .unwrap();
        }
        if method == "GET" && state.behavior == "resume" {
            let original = state
                .requests
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|record| record["message"]["method"] == "tools/call")
                .unwrap()["message"]
                .clone();
            let result = json!({"jsonrpc":"2.0","id":original["id"],"result":{"content":[{"type":"text","text":"resumed once"}]}});
            return Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from(format!("data: {result}\n\n")))
                .unwrap();
        }
        if message.get("id").is_none() || message.get("method").is_none() {
            return Response::builder()
                .status(StatusCode::ACCEPTED)
                .body(Body::empty())
                .unwrap();
        }
        let result = match message["method"].as_str().unwrap() {
            "initialize" => {
                json!({"protocolVersion":PROTOCOL_VERSION,"capabilities":{"tools":{},"resources":{},"prompts":{}},"serverInfo":{"name":"Synthetic HTTP","version":"1"}})
            }
            "tools/list" => {
                json!({"tools":[{"name":"echo","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":"ui://fixture/app.html"}}}]})
            }
            "resources/list" => {
                if message["params"]["cursor"] == "next" {
                    json!({"resources":[{"uri":"fixture://second","name":"Second","size":3}]})
                } else {
                    json!({"resources":[{"uri":"ui://fixture/app.html","name":"Fixture app","mimeType":"text/html;profile=mcp-app","annotations":{"audience":["user"]},"_meta":{"ui":{"csp":{"resourceDomains":[]}}}}],"nextCursor":"next"})
                }
            }
            "resources/templates/list" => {
                json!({"resourceTemplates":[{"uriTemplate":"fixture://item/{id}","name":"Fixture items","_meta":{"fixture":"metadata"}}]})
            }
            "resources/read" => {
                json!({"contents":[{"uri":message["params"]["uri"],"mimeType":"text/html;profile=mcp-app","text":"<main>synthetic app</main>","_meta":{"ui":{"permissions":{}}}}]})
            }
            "prompts/list" => {
                json!({"prompts":[{"name":"fixture_prompt","description":"Synthetic prompt","arguments":[{"name":"topic","required":true}],"_meta":{"fixture":"metadata"}}]})
            }
            "prompts/get" => {
                json!({"description":"Synthetic prompt","messages":[{"role":"user","content":{"type":"resource_link","uri":"fixture://reference","name":"Reference"}},{"role":"assistant","content":{"type":"text","text":message["params"]["arguments"]["topic"]}}]})
            }
            "tools/call" => {
                json!({"content":[{"type":"text","text":message["params"]["arguments"].to_string()}]})
            }
            _ => panic!("Unexpected synthetic method"),
        };
        if state.behavior == "resume" && message["method"] == "tools/call" {
            return Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from("id: resume-cursor\nretry: 10\ndata:\n\n"))
                .unwrap();
        }
        if (state.behavior == "hang-tool" && message["method"] == "tools/call")
            || (state.behavior == "hang-initialize" && message["method"] == "initialize")
        {
            return Response::builder()
                .header("mcp-session-id", "fixture-session")
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(futures_util::stream::pending::<
                    Result<Vec<u8>, std::io::Error>,
                >()))
                .unwrap();
        }
        let response = json!({"jsonrpc":"2.0","id":message["id"],"result":result});
        let mut builder = Response::builder().header("mcp-session-id", "fixture-session");
        let body = if state.sse && message["method"] != "initialize" {
            builder = builder.header("content-type", "text/event-stream");
            let wire=format!(": keepalive\r\nid: cursor-one\r\ndata:\r\n\r\nevent: message\r\ndata: {response}\r\n\r\n");
            let pieces: Vec<_> = wire
                .into_bytes()
                .chunks(3)
                .map(|c| Ok::<_, std::io::Error>(c.to_vec()))
                .collect();
            Body::from_stream(futures_util::stream::iter(pieces))
        } else {
            builder = builder.header("content-type", "application/json");
            Body::from(response.to_string())
        };
        builder.body(body).unwrap()
    }
    #[tokio::test]
    async fn http_json_and_fragmented_sse_negotiate_session_and_cleanup() {
        for sse in [false, true] {
            let fixture = HttpFixture {
                requests: Arc::default(),
                sse,
                behavior: "normal",
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = oneshot::channel::<()>();
            let server = tokio::spawn(
                axum::serve(
                    listener,
                    Router::new()
                        .route("/mcp", any(http_handler))
                        .with_state(fixture.clone()),
                )
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .into_future(),
            );
            let config = ServerConfig {
                id: "http".into(),
                name: "Synthetic HTTP".into(),
                enabled: true,
                timeout_seconds: 3,
                transport: TransportConfig::Http {
                    url: format!("http://{address}/mcp"),
                    bearer_token: Some("fake-token".into()),
                },
            };
            let mut client = McpClient::connect(&config).await.unwrap();
            assert_eq!(client.info().protocol_version, PROTOCOL_VERSION);
            assert_eq!(client.list_tools().await.unwrap()[0].name, "echo");
            assert_eq!(
                client
                    .call_tool("echo", json!({"utf8":"café 😃"}))
                    .await
                    .unwrap()["content"][0]["text"],
                json!({"utf8":"café 😃"}).to_string()
            );
            client.close().await.unwrap();
            let requests = fixture.requests.lock().unwrap().clone();
            assert_eq!(requests[0]["session"], Value::Null);
            for request in &requests[1..] {
                assert_eq!(request["session"], "fixture-session");
                assert_eq!(request["version"], PROTOCOL_VERSION);
                assert_eq!(request["authorization"], "Bearer fake-token");
            }
            assert_eq!(requests.last().unwrap()["method"], "DELETE");
            let _ = stop.send(());
            server.await.unwrap().unwrap();
        }
    }
    #[tokio::test]
    async fn http_resumes_disconnected_sse_without_repeating_a_tool_call() {
        let fixture = HttpFixture {
            requests: Arc::default(),
            sse: false,
            behavior: "resume",
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/mcp", any(http_handler))
                    .with_state(fixture.clone()),
            )
            .into_future(),
        );
        let config = ServerConfig {
            id: "resume".into(),
            name: "Synthetic resume".into(),
            enabled: true,
            timeout_seconds: 3,
            transport: TransportConfig::Http {
                url: format!("http://{address}/mcp"),
                bearer_token: None,
            },
        };
        let mut client = McpClient::connect(&config).await.unwrap();
        client.list_tools().await.unwrap();
        assert_eq!(
            client.call_tool("echo", json!({})).await.unwrap()["content"][0]["text"],
            "resumed once"
        );
        client.close().await.unwrap();
        let requests = fixture.requests.lock().unwrap().clone();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["message"]["method"] == "tools/call")
                .count(),
            1
        );
        let resumed = requests.iter().find(|r| r["method"] == "GET").unwrap();
        assert_eq!(resumed["lastEventId"], "resume-cursor");
        assert_eq!(resumed["session"], "fixture-session");
        assert_eq!(resumed["version"], PROTOCOL_VERSION);
        server.abort();
    }
    #[tokio::test]
    async fn resources_templates_prompts_and_mcp_app_metadata_roundtrip() {
        let fixture = HttpFixture {
            requests: Arc::default(),
            sse: true,
            behavior: "normal",
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/mcp", any(http_handler))
                    .with_state(fixture),
            )
            .into_future(),
        );
        let config = ServerConfig {
            id: "resources".into(),
            name: "Synthetic resources".into(),
            enabled: true,
            timeout_seconds: 3,
            transport: TransportConfig::Http {
                url: format!("http://{address}/mcp"),
                bearer_token: None,
            },
        };
        let mut client = McpClient::connect(&config).await.unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(
            serde_json::to_value(&tools[0]).unwrap()["_meta"]["ui"]["resourceUri"],
            "ui://fixture/app.html"
        );
        let resources = client.list_resources().await.unwrap();
        assert_eq!(resources.len(), 2);
        assert_eq!(
            resources[0]["_meta"]["ui"]["csp"],
            json!({"resourceDomains":[]})
        );
        assert_eq!(resources[0]["annotations"]["audience"], json!(["user"]));
        assert_eq!(
            client.list_resource_templates().await.unwrap()[0]["uriTemplate"],
            "fixture://item/{id}"
        );
        let content = client.read_resource("ui://fixture/app.html").await.unwrap();
        assert_eq!(
            content["contents"][0]["_meta"]["ui"]["permissions"],
            json!({})
        );
        assert_eq!(content["contents"][0]["text"], "<main>synthetic app</main>");
        assert!(client.read_resource("invalid uri\0").await.is_err());
        assert_eq!(
            client.list_prompts().await.unwrap()[0]["arguments"][0]["required"],
            true
        );
        assert!(client
            .get_prompt("fixture_prompt", json!({"topic":4}))
            .await
            .is_err());
        let prompt = client
            .get_prompt("fixture_prompt", json!({"topic":"V4"}))
            .await
            .unwrap();
        assert_eq!(prompt["messages"][0]["content"]["type"], "resource_link");
        assert_eq!(prompt["messages"][1]["content"]["text"], "V4");
        client.close().await.unwrap();
        server.abort();
    }
    #[tokio::test]
    async fn failed_http_cleanup_retains_session_for_retry_and_unsupported_delete_is_honest() {
        for behavior in ["delete-retry", "delete-unsupported"] {
            let fixture = HttpFixture {
                requests: Arc::default(),
                sse: false,
                behavior,
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(
                axum::serve(
                    listener,
                    Router::new()
                        .route("/mcp", any(http_handler))
                        .with_state(fixture.clone()),
                )
                .into_future(),
            );
            let config = ServerConfig {
                id: "cleanup".into(),
                name: "Synthetic cleanup".into(),
                enabled: true,
                timeout_seconds: 3,
                transport: TransportConfig::Http {
                    url: format!("http://{address}/mcp"),
                    bearer_token: None,
                },
            };
            let mut client = McpClient::connect(&config).await.unwrap();
            assert!(client.close().await.is_err());
            assert!(
                matches!(&client.transport,Transport::Http(http) if http.session.as_deref()==Some("fixture-session"))
            );
            if behavior == "delete-retry" {
                client.close().await.unwrap();
            } else {
                assert!(client
                    .close()
                    .await
                    .unwrap_err()
                    .contains("does not support"));
            }
            assert_eq!(
                fixture
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|request| request["method"] == "DELETE")
                    .count(),
                2
            );
            drop(client);
            server.abort();
        }
    }
    #[tokio::test]
    async fn close_cancels_interrupted_rpc_but_never_sends_initialize_cancellation() {
        for behavior in ["hang-tool", "hang-initialize"] {
            let fixture = HttpFixture {
                requests: Arc::default(),
                sse: false,
                behavior,
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(
                axum::serve(
                    listener,
                    Router::new()
                        .route("/mcp", any(http_handler))
                        .with_state(fixture.clone()),
                )
                .into_future(),
            );
            let config = ServerConfig {
                id: "pending".into(),
                name: "Synthetic pending request".into(),
                enabled: true,
                timeout_seconds: 3,
                transport: TransportConfig::Http {
                    url: format!("http://{address}/mcp"),
                    bearer_token: None,
                },
            };
            let mut client = McpClient::prepare(&config).unwrap();
            if behavior == "hang-tool" {
                client.initialize().await.unwrap();
                client.list_tools().await.unwrap();
                assert!(tokio::time::timeout(
                    Duration::from_millis(50),
                    client.call_tool("echo", json!({}))
                )
                .await
                .is_err());
            } else {
                assert!(
                    tokio::time::timeout(Duration::from_millis(50), client.initialize())
                        .await
                        .is_err()
                );
            }
            assert!(client.pending.is_some());
            client.close().await.unwrap();
            let requests = fixture.requests.lock().unwrap().clone();
            let cancellations: Vec<_> = requests
                .iter()
                .filter(|record| record["message"]["method"] == "notifications/cancelled")
                .collect();
            if behavior == "hang-initialize" {
                assert!(cancellations.is_empty());
            } else {
                assert_eq!(cancellations.len(), 1);
                let call = requests
                    .iter()
                    .find(|record| record["message"]["method"] == "tools/call")
                    .unwrap();
                assert_eq!(
                    cancellations[0]["message"]["params"]["requestId"],
                    call["message"]["id"]
                );
            }
            assert_eq!(requests.last().unwrap()["method"], "DELETE");
            server.abort();
        }
    }
    #[tokio::test]
    async fn close_has_one_total_deadline_and_retains_a_slow_http_session_for_retry() {
        let fixture = HttpFixture {
            requests: Arc::default(),
            sse: false,
            behavior: "close-budget",
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/mcp", any(http_handler))
                    .with_state(fixture.clone()),
            )
            .into_future(),
        );
        let config = ServerConfig {
            id: "close-budget".into(),
            name: "Synthetic cleanup deadline".into(),
            enabled: true,
            timeout_seconds: 10,
            transport: TransportConfig::Http {
                url: format!("http://{address}/mcp"),
                bearer_token: None,
            },
        };
        let mut client = McpClient::connect(&config).await.unwrap();
        client.pending = Some(PendingRequest {
            id: 42,
            initialize: false,
        });
        let start = tokio::time::Instant::now();
        let error = client.close().await.unwrap_err();
        assert!(
            start.elapsed() < Duration::from_millis(2600),
            "Cancellation plus cleanup must share the2second deadline"
        );
        assert!(error.contains("cleanup timed out"));
        assert!(
            matches!(&client.transport,Transport::Http(http) if http.session.as_deref()==Some("fixture-session"))
        );
        assert!(client.pending.is_some());
        let requests = fixture.requests.lock().unwrap().clone();
        assert!(requests
            .iter()
            .any(|request| request["message"]["method"] == "notifications/cancelled"));
        assert!(requests.iter().any(|request| request["method"] == "DELETE"));
        drop(client);
        server.abort();
    }
}
