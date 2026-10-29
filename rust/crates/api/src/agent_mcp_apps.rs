//! Owner-scoped MCP App sessions. External HTML is returned only after explicit opening.
use crate::{
    agent_mcp,
    auth::AuthenticatedUser,
    state::AppState,
    v4_agent::mcp::{ClientPolicy, McpClient, ServerConfig, Tool},
    ApiError,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;
const TTL: Duration = Duration::from_secs(600);
const MAX_HTML: usize = 524_288;
const MAX_REQUEST: usize = 65_536;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agent/mcp/{server_id}/apps/open",
            axum::routing::post(open),
        )
        .route(
            "/api/agent/mcp/apps/{session_id}",
            axum::routing::get(status).delete(close),
        )
        .route(
            "/api/agent/mcp/apps/{session_id}/requests",
            axum::routing::post(queue_request),
        )
        .route(
            "/api/agent/mcp/apps/{session_id}/requests/{request_id}",
            axum::routing::get(request_status),
        )
        .route(
            "/api/agent/mcp/apps/{session_id}/requests/{request_id}/decision",
            axum::routing::post(decide),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST))
}
fn unavailable() -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        message: "MCP App session is unavailable for this account".into(),
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Opening,
    Active,
    Closed,
    Failed,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppView {
    session_id: Uuid,
    server_id: String,
    server_info: Value,
    protocol_version: String,
    resource_uri: String,
    html: String,
    resource: Value,
    csp: Value,
    permissions: Value,
    tools: Vec<Tool>,
    expires_at: String,
}
#[derive(Clone)]
struct Receipt {
    status: Lifecycle,
    view: Option<Arc<AppView>>,
    error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestReceipt {
    request_id: Uuid,
    status: String,
    method: String,
    params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
struct AppRequest {
    decision: Mutex<()>,
    created: Instant,
    receipt: watch::Sender<RequestReceipt>,
}
struct AppSession {
    id: Uuid,
    data: PathBuf,
    owner: String,
    server_id: String,
    resource_uri: String,
    fingerprint: Vec<u8>,
    created: Instant,
    expires_at: String,
    cancel: watch::Sender<bool>,
    receipt: watch::Sender<Receipt>,
    client: AsyncMutex<Option<McpClient>>,
    requests: Mutex<HashMap<Uuid, Arc<AppRequest>>>,
}
fn registry() -> &'static Mutex<HashMap<Uuid, Arc<AppSession>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<Uuid, Arc<AppSession>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
fn fingerprint(server: &ServerConfig) -> Vec<u8> {
    Sha256::digest(serde_json::to_vec(server).unwrap_or_default()).to_vec()
}
fn expires_at() -> String {
    (time::OffsetDateTime::now_utc() + time::Duration::seconds(TTL.as_secs() as i64))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
fn session(id: Uuid, data: &FsPath, owner: &str) -> Result<Arc<AppSession>, ApiError> {
    let sessions = registry()
        .lock()
        .map_err(|_| ApiError::internal("MCP App registry is unavailable"))?;
    sessions
        .get(&id)
        .filter(|session| session.data == data && session.owner == owner)
        .cloned()
        .ok_or_else(unavailable)
}
fn needs_close(session: &AppSession) -> bool {
    matches!(
        session.receipt.borrow().status,
        Lifecycle::Opening | Lifecycle::Active
    ) || session
        .client
        .try_lock()
        .map(|client| client.is_some())
        .unwrap_or(true)
}
fn reserve(
    id: Uuid,
    data: &FsPath,
    owner: &str,
    server: Option<&ServerConfig>,
    resource_uri: Option<&str>,
) -> Result<(Arc<AppSession>, bool), ApiError> {
    let mut sessions = registry()
        .lock()
        .map_err(|_| ApiError::internal("MCP App registry is unavailable"))?;
    sessions.retain(|_, session| {
        matches!(
            session.receipt.borrow().status,
            Lifecycle::Opening | Lifecycle::Active
        ) || session.created.elapsed() < TTL
    });
    if let Some(existing) = sessions.get(&id) {
        if existing.data != data || existing.owner != owner {
            return Err(unavailable());
        }
        return Ok((existing.clone(), false));
    }
    if sessions.len() >= 512 {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "MCP App session receipts are full".into(),
        });
    }
    if server.is_some()
        && sessions
            .values()
            .filter(|session| {
                session.data == data && session.owner == owner && needs_close(session)
            })
            .count()
            >= 4
    {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "At most four MCP Apps may be open for this account".into(),
        });
    }
    if server.is_some()
        && sessions
            .values()
            .filter(|session| needs_close(session))
            .count()
            >= 64
    {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "MCP App connection limit reached".into(),
        });
    }
    let closed = server.is_none();
    let (cancel, _) = watch::channel(closed);
    let (receipt, _) = watch::channel(Receipt {
        status: if closed {
            Lifecycle::Closed
        } else {
            Lifecycle::Opening
        },
        view: None,
        error: None,
    });
    let session = Arc::new(AppSession {
        id,
        data: data.to_path_buf(),
        owner: owner.into(),
        server_id: server.map(|s| s.id.clone()).unwrap_or_default(),
        resource_uri: resource_uri.unwrap_or_default().to_owned(),
        fingerprint: server.map(fingerprint).unwrap_or_default(),
        created: Instant::now(),
        expires_at: expires_at(),
        cancel,
        receipt,
        client: AsyncMutex::new(None),
        requests: Mutex::new(HashMap::new()),
    });
    sessions.insert(id, session.clone());
    Ok((session, true))
}
async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
async fn close_session(session: &AppSession) -> Result<(), String> {
    session.cancel.send_replace(true);
    let closed = tokio::time::timeout(Duration::from_secs(6), async {
        let mut client = session.client.lock().await;
        let result = if let Some(client) = client.as_mut() {
            client.close().await
        } else {
            Ok(())
        };
        if result.is_ok() {
            client.take();
        }
        result
    })
    .await
    .map_err(|_| "MCP App cleanup is still running".to_owned())?;
    session.receipt.send_replace(Receipt {
        status: if closed.is_ok() {
            Lifecycle::Closed
        } else {
            Lifecycle::Failed
        },
        view: None,
        error: closed.as_ref().err().cloned(),
    });
    if let Ok(requests) = session.requests.lock() {
        for request in requests.values() {
            let mut receipt = request.receipt.borrow().clone();
            if matches!(receipt.status.as_str(), "pending" | "running") {
                receipt.status = "failed".into();
                receipt.error = Some("MCP App session closed".into());
                request.receipt.send_replace(receipt);
            }
        }
    }
    closed
}
fn unchanged(session: &AppSession) -> bool {
    agent_mcp::load_servers(&session.data, &session.owner)
        .ok()
        .and_then(|servers| {
            servers
                .into_iter()
                .find(|server| server.id == session.server_id)
        })
        .is_some_and(|server| server.enabled && fingerprint(&server) == session.fingerprint)
}
async fn active(session: &AppSession) -> Result<(), ApiError> {
    if !matches!(
        session.receipt.borrow().status,
        Lifecycle::Opening | Lifecycle::Active
    ) {
        return Err(unavailable());
    }
    if session.created.elapsed() >= TTL || !unchanged(session) {
        close_session(session).await.map_err(ApiError::internal)?;
        return Err(unavailable());
    }
    Ok(())
}
async fn close_matching(
    data: &FsPath,
    owner: Option<&str>,
    only_changed: bool,
) -> Result<(), String> {
    let sessions = registry()
        .lock()
        .map_err(|_| "MCP App registry is unavailable")?
        .values()
        .filter(|session| {
            session.data == data
                && owner.is_none_or(|owner| owner == session.owner)
                && needs_close(session)
        })
        .cloned()
        .collect::<Vec<_>>();
    let errors: Vec<_> = futures_util::future::join_all(
        sessions
            .into_iter()
            .filter(|session| !only_changed || !unchanged(session))
            .map(|session| async move { close_session(&session).await }),
    )
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
pub(crate) async fn revoke_changed(data: &FsPath, owner: &str) -> Result<(), String> {
    close_matching(data, Some(owner), true).await
}
pub(crate) async fn close_owner(data: &FsPath, owner: &str) {
    if let Err(error) = close_matching(data, Some(owner), false).await {
        tracing::warn!(%error,"MCP App owner cleanup remains unconfirmed");
    }
}
pub(crate) async fn shutdown(data: &FsPath) {
    if let Err(error) = close_matching(data, None, false).await {
        tracing::warn!(%error,"MCP App shutdown cleanup remains unconfirmed");
    }
}
fn ui_resource(tool: &Tool) -> Option<&str> {
    tool.metadata
        .as_ref()?
        .get("ui")?
        .get("resourceUri")?
        .as_str()
}
fn app_visible(tool: &Tool) -> bool {
    match tool
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("ui"))
        .and_then(|ui| ui.get("visibility"))
    {
        None => true,
        Some(Value::Array(visibility)) => visibility.iter().any(|entry| entry == "app"),
        _ => false,
    }
}
fn html_mime(mime: &str) -> bool {
    let mut parts = mime.split(';').map(str::trim);
    match parts.next() {
        Some(value) if value.eq_ignore_ascii_case("text/html+mcp") => parts.next().is_none(),
        Some(value) if value.eq_ignore_ascii_case("text/html") => parts.any(|part| {
            part.split_once('=').is_some_and(|(key, value)| {
                key.trim().eq_ignore_ascii_case("profile")
                    && value.trim().trim_matches('"') == "mcp-app"
            })
        }),
        _ => false,
    }
}
fn decode_html(blob: &str) -> Result<String, String> {
    let bytes: Vec<u8> = blob
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if bytes.len() % 4 != 0 || bytes.len() > ((MAX_HTML + 2) / 3) * 4 {
        return Err("MCP App HTML blob exceeds its limit or has invalid base64".into());
    }
    let mut result = Vec::new();
    let digit = |byte: u8| match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let a = digit(chunk[0]).ok_or("Invalid MCP App HTML base64")?;
        let b = digit(chunk[1]).ok_or("Invalid MCP App HTML base64")?;
        let last = index + 1 == bytes.len() / 4;
        result.push((a << 2) | (b >> 4));
        if chunk[2] == b'=' {
            if !last || chunk[3] != b'=' || b & 15 != 0 {
                return Err("Invalid MCP App HTML base64 padding".into());
            }
            continue;
        }
        let c = digit(chunk[2]).ok_or("Invalid MCP App HTML base64")?;
        result.push((b << 4) | (c >> 2));
        if chunk[3] == b'=' {
            if !last || c & 3 != 0 {
                return Err("Invalid MCP App HTML base64 padding".into());
            }
            continue;
        }
        let d = digit(chunk[3]).ok_or("Invalid MCP App HTML base64")?;
        result.push((c << 6) | d);
    }
    if result.len() > MAX_HTML {
        return Err("MCP App HTML exceeds its limit".into());
    }
    String::from_utf8(result).map_err(|_| "MCP App HTML is not UTF-8".into())
}
async fn app_view(
    client: &mut McpClient,
    session: &AppSession,
    input: &OpenInput,
) -> Result<AppView, String> {
    client.initialize().await?;
    let tools = client.list_tools().await?;
    if !tools.iter().any(|tool| {
        ui_resource(tool) == Some(input.resource_uri.as_str())
            && input
                .tool_name
                .as_ref()
                .is_none_or(|name| name == &tool.name)
    }) {
        return Err("MCP App URI is not declared by the selected server tool".into());
    }
    let result = client.read_resource(&input.resource_uri).await?;
    let contents = result["contents"]
        .as_array()
        .ok_or("MCP App resource has no contents")?;
    let mut matches = contents
        .iter()
        .filter(|content| content["uri"] == input.resource_uri);
    let resource = matches
        .next()
        .ok_or("MCP App resource URI did not match")?
        .clone();
    if matches.next().is_some() {
        return Err("MCP App resource contains duplicate matching entries".into());
    }
    if !resource["mimeType"].as_str().is_some_and(html_mime) {
        return Err("MCP App resource must have the MCP HTML MIME type".into());
    }
    let html = if let Some(text) = resource["text"].as_str() {
        text.to_owned()
    } else {
        decode_html(
            resource["blob"]
                .as_str()
                .ok_or("MCP App resource has no HTML")?,
        )?
    };
    if html.trim().is_empty() || html.len() > MAX_HTML || html.contains('\0') {
        return Err("MCP App HTML is empty, invalid, or exceeds its limit".into());
    }
    let ui = &resource["_meta"]["ui"];
    let csp = ui.get("csp").cloned().unwrap_or(json!({}));
    let permissions = ui.get("permissions").cloned().unwrap_or(json!({}));
    if !csp.is_object() || !permissions.is_object() {
        return Err("MCP App CSP and permissions metadata must be objects".into());
    }
    Ok(AppView {
        session_id: session.id,
        server_id: session.server_id.clone(),
        server_info: client.info().server_info.clone(),
        protocol_version: client.info().protocol_version.clone(),
        resource_uri: input.resource_uri.clone(),
        html,
        resource,
        csp,
        permissions,
        tools: tools.into_iter().filter(app_visible).collect(),
        expires_at: session.expires_at.clone(),
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenInput {
    resource_uri: String,
    tool_name: Option<String>,
    session_id: Option<Uuid>,
}
async fn start_open(session: Arc<AppSession>, server: ServerConfig, input: OpenInput) {
    let mut cancellation = session.cancel.subscribe();
    let mut owned = session.client.lock().await;
    if *cancellation.borrow() {
        return;
    }
    let client = match McpClient::prepare_with_policy(&server, ClientPolicy::default().with_apps())
    {
        Ok(client) => client,
        Err(error) => {
            session.receipt.send_replace(Receipt {
                status: Lifecycle::Failed,
                view: None,
                error: Some(error),
            });
            return;
        }
    };
    *owned = Some(client);
    let result = tokio::select! {biased;_=cancelled(&mut cancellation)=>Err("MCP App opening cancelled".to_owned()),_=tokio::time::sleep(Duration::from_secs(server.timeout_seconds))=>Err("MCP App opening timed out".to_owned()),result=app_view(owned.as_mut().unwrap(),&session,&input)=>result};
    match result {
        Ok(view) if !*session.cancel.borrow() => {
            session.receipt.send_replace(Receipt {
                status: Lifecycle::Active,
                view: Some(Arc::new(view)),
                error: None,
            });
        }
        result => {
            let mut error = result.err();
            let closed = owned.as_mut().unwrap().close().await;
            if closed.is_ok() {
                owned.take();
            } else {
                error = Some(format!(
                    "MCP App cleanup failed: {}",
                    closed.as_ref().unwrap_err()
                ));
            }
            session.receipt.send_replace(Receipt {
                status: if *session.cancel.borrow() && closed.is_ok() {
                    Lifecycle::Closed
                } else {
                    Lifecycle::Failed
                },
                view: None,
                error,
            });
        }
    }
}
async fn open(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(server_id): Path<String>,
    Json(input): Json<OpenInput>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<AppView>), ApiError> {
    if input.resource_uri.len() > 8192
        || !input.resource_uri.starts_with("ui://")
        || input.resource_uri.chars().any(char::is_control)
        || url::Url::parse(&input.resource_uri).is_err()
        || input.tool_name.as_ref().is_some_and(|name| {
            name.is_empty() || name.len() > 128 || name.chars().any(char::is_control)
        })
    {
        return Err(ApiError::bad_request("Invalid MCP App URI or tool name"));
    }
    let server = agent_mcp::load_servers(&state.config().data_dir, &user.user_id)
        .map_err(ApiError::internal)?
        .into_iter()
        .find(|server| server.id == server_id && server.enabled)
        .ok_or_else(|| {
            ApiError::bad_request("Enable this account's MCP server before opening its app")
        })?;
    let (session, start) = reserve(
        input.session_id.unwrap_or_else(Uuid::new_v4),
        &state.config().data_dir,
        &user.user_id,
        Some(&server),
        Some(&input.resource_uri),
    )?;
    if session.receipt.borrow().status != Lifecycle::Closed
        && (session.server_id != server_id || session.resource_uri != input.resource_uri)
    {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: "MCP App session ID is already bound to a different server or resource".into(),
        });
    }
    if session.server_id != server_id || session.receipt.borrow().status == Lifecycle::Closed {
        return Err(ApiError {
            status: StatusCode::GONE,
            message: "MCP App opening was cancelled".into(),
        });
    }
    if start {
        tokio::spawn(start_open(session.clone(), server, input));
        let expiry = session.clone();
        tokio::spawn(async move {
            let mut cancel = expiry.cancel.subscribe();
            tokio::select! {_=tokio::time::sleep(TTL)=>{let _=close_session(&expiry).await;},_=cancelled(&mut cancel)=>{}}
        });
    }
    let mut receipt = session.receipt.subscribe();
    loop {
        let current = receipt.borrow_and_update().clone();
        match current.status {
            Lifecycle::Opening => {}
            Lifecycle::Active => {
                return Ok((
                    [(header::CACHE_CONTROL, "private, no-store")],
                    Json((*current.view.unwrap()).clone()),
                ))
            }
            Lifecycle::Closed => {
                return Err(ApiError {
                    status: StatusCode::GONE,
                    message: "MCP App opening was cancelled".into(),
                })
            }
            Lifecycle::Failed => {
                return Err(ApiError::bad_request(
                    current
                        .error
                        .unwrap_or_else(|| "MCP App did not open".into()),
                ))
            }
        }
        receipt
            .changed()
            .await
            .map_err(|_| ApiError::internal("MCP App opening stopped"))?;
    }
}
async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let session = session(id, &state.config().data_dir, &user.user_id)?;
    active(&session).await?;
    let receipt = session.receipt.borrow();
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(
            json!({"sessionId":id,"serverId":session.server_id,"resourceUri":session.resource_uri,"status":if receipt.status==Lifecycle::Opening{"opening"}else{"active"},"expiresAt":session.expires_at}),
        ),
    ))
}
async fn close(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let (session, _) = reserve(id, &state.config().data_dir, &user.user_id, None, None)?;
    close_session(&session).await.map_err(ApiError::internal)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"sessionId":id,"status":"closed"})),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestInput {
    method: String,
    params: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    approved: bool,
}
fn validate_request(session: &AppSession, input: &RequestInput) -> Result<(), ApiError> {
    if !input.params.is_object()
        || serde_json::to_vec(&input.params)
            .map_err(|_| ApiError::bad_request("Invalid MCP App parameters"))?
            .len()
            > MAX_REQUEST
    {
        return Err(ApiError::bad_request(
            "MCP App parameters must be a bounded JSON object",
        ));
    }
    match input.method.as_str() {
        "tools/list" | "prompts/list" => {}
        "tools/call" => {
            let view = session
                .receipt
                .borrow()
                .view
                .clone()
                .ok_or_else(unavailable)?;
            let name = input.params["name"]
                .as_str()
                .ok_or_else(|| ApiError::bad_request("MCP App tool name is required"))?;
            if !view.tools.iter().any(|tool| tool.name == name)
                || !input.params["arguments"].is_object()
            {
                return Err(ApiError::bad_request(
                    "MCP App tool is not visible to this app or arguments are invalid",
                ));
            }
        }
        "resources/read" => {
            let uri = input.params["uri"]
                .as_str()
                .ok_or_else(|| ApiError::bad_request("MCP App resource URI is required"))?;
            if uri.len() > 8192
                || uri.chars().any(char::is_control)
                || url::Url::parse(uri).is_err()
            {
                return Err(ApiError::bad_request("Invalid MCP App resource URI"));
            }
        }
        "prompts/get" => {
            if !input.params["name"].is_string() || !input.params["arguments"].is_object() {
                return Err(ApiError::bad_request("Invalid MCP App prompt request"));
            }
        }
        _ => {
            return Err(ApiError::bad_request(
                "This MCP App request method is not supported",
            ))
        }
    }
    Ok(())
}
async fn queue_request(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
    Json(input): Json<RequestInput>,
) -> Result<
    (
        StatusCode,
        [(header::HeaderName, &'static str); 1],
        Json<RequestReceipt>,
    ),
    ApiError,
> {
    let session = session(id, &state.config().data_dir, &user.user_id)?;
    active(&session).await?;
    if session.receipt.borrow().status != Lifecycle::Active {
        return Err(ApiError::bad_request("MCP App is still opening"));
    }
    validate_request(&session, &input)?;
    let mut requests = session
        .requests
        .lock()
        .map_err(|_| ApiError::internal("MCP App request registry is unavailable"))?;
    requests.retain(|_, request| {
        matches!(
            request.receipt.borrow().status.as_str(),
            "pending" | "running"
        ) || request.created.elapsed() < Duration::from_secs(300)
    });
    if requests.len() >= 32
        || requests
            .values()
            .filter(|request| {
                matches!(
                    request.receipt.borrow().status.as_str(),
                    "pending" | "running"
                )
            })
            .count()
            >= 8
    {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "MCP App request limit reached; finish or deny pending requests".into(),
        });
    }
    let receipt = RequestReceipt {
        request_id: Uuid::new_v4(),
        status: "pending".into(),
        method: input.method,
        params: input.params,
        result: None,
        error: None,
    };
    let (tx, _) = watch::channel(receipt.clone());
    requests.insert(
        receipt.request_id,
        Arc::new(AppRequest {
            decision: Mutex::new(()),
            created: Instant::now(),
            receipt: tx,
        }),
    );
    Ok((
        StatusCode::ACCEPTED,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(receipt),
    ))
}
fn app_request(session: &AppSession, id: Uuid) -> Result<Arc<AppRequest>, ApiError> {
    session
        .requests
        .lock()
        .map_err(|_| ApiError::internal("MCP App request registry is unavailable"))?
        .get(&id)
        .cloned()
        .ok_or_else(unavailable)
}
async fn request_status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, request_id)): Path<(Uuid, Uuid)>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<RequestReceipt>,
    ),
    ApiError,
> {
    let session = session(id, &state.config().data_dir, &user.user_id)?;
    let request = app_request(&session, request_id)?;
    let receipt = request.receipt.borrow().clone();
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(receipt),
    ))
}
async fn refresh_app_tools(
    client: &mut McpClient,
    session: &AppSession,
) -> Result<Vec<Tool>, String> {
    let tools: Vec<Tool> = client
        .list_tools()
        .await?
        .into_iter()
        .filter(app_visible)
        .collect();
    if *session.cancel.borrow() {
        return Err("MCP App session closed during discovery".into());
    }
    let current = session.receipt.borrow().clone();
    if current.status != Lifecycle::Active {
        return Err("MCP App session is not active".into());
    }
    let mut view = (*current.view.ok_or("MCP App discovery is unavailable")?).clone();
    view.tools = tools.clone();
    session.receipt.send_replace(Receipt {
        status: Lifecycle::Active,
        view: Some(Arc::new(view)),
        error: None,
    });
    Ok(tools)
}
async fn execute(
    client: &mut McpClient,
    session: &AppSession,
    receipt: &RequestReceipt,
) -> Result<Value, String> {
    match receipt.method.as_str() {
        "tools/list" => Ok(json!({"tools":refresh_app_tools(client,session).await?})),
        "tools/call" => {
            let name = receipt.params["name"]
                .as_str()
                .ok_or("Invalid MCP App tool name")?;
            let tools = refresh_app_tools(client, session).await?;
            if !tools.iter().any(|tool| tool.name == name) {
                return Err(
                    "MCP App tool is no longer visible to apps; review updated discovery".into(),
                );
            }
            client
                .call_tool(name, receipt.params["arguments"].clone())
                .await
        }
        "resources/read" => {
            client
                .read_resource(
                    receipt.params["uri"]
                        .as_str()
                        .ok_or("Invalid MCP App resource URI")?,
                )
                .await
        }
        "prompts/list" => Ok(json!({"prompts":client.list_prompts().await?})),
        "prompts/get" => {
            client
                .get_prompt(
                    receipt.params["name"]
                        .as_str()
                        .ok_or("Invalid MCP App prompt name")?,
                    receipt.params["arguments"].clone(),
                )
                .await
        }
        _ => Err("Unsupported MCP App method".into()),
    }
}

async fn run_request(session: Arc<AppSession>, request: Arc<AppRequest>) {
    let mut receipt = request.receipt.borrow().clone();
    let mut cancellation = session.cancel.subscribe();
    let result=async{
        if *cancellation.borrow() || !unchanged(&session){return Err("MCP App configuration changed or session closed".into());}
        let mut client=session.client.lock().await;if *session.cancel.borrow(){return Err("MCP App session closed".into());}
        let client=client.as_mut().ok_or("MCP App client is unavailable")?;
        tokio::select!{biased;_=cancelled(&mut cancellation)=>Err("MCP App request cancelled".to_owned()),result=execute(client,&session,&receipt)=>result}
    }.await;
    match result {
        Ok(result) => {
            receipt.status = "completed".into();
            receipt.result = Some(result);
        }
        Err(error) => {
            receipt.status = "failed".into();
            receipt.error = Some(error);
        }
    }
    request.receipt.send_replace(receipt);
}
async fn decide(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, request_id)): Path<(Uuid, Uuid)>,
    Json(decision): Json<Decision>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<RequestReceipt>,
    ),
    ApiError,
> {
    let session = session(id, &state.config().data_dir, &user.user_id)?;
    active(&session).await?;
    let request = app_request(&session, request_id)?;
    let start = {
        let _decision = request
            .decision
            .lock()
            .map_err(|_| ApiError::internal("MCP App decision lock is unavailable"))?;
        let mut current = request.receipt.borrow().clone();
        if current.status == "pending" {
            if request.created.elapsed() > Duration::from_secs(120) {
                current.status = "failed".into();
                current.error = Some("MCP App approval expired; review a new request".into());
            } else {
                current.status = if decision.approved {
                    "running"
                } else {
                    "denied"
                }
                .into();
            }
            let start = current.status == "running";
            request.receipt.send_replace(current);
            start
        } else {
            false
        }
    };
    if start {
        tokio::spawn(run_request(session, request.clone()));
    }
    let mut receipt = request.receipt.subscribe();
    loop {
        let current = receipt.borrow_and_update().clone();
        if current.status != "running" {
            return Ok((
                [(header::CACHE_CONTROL, "private, no-store")],
                Json(current),
            ));
        }
        receipt
            .changed()
            .await
            .map_err(|_| ApiError::internal("MCP App request stopped without a receipt"))?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_mcp,
        auth::{issue_access_token, require_auth},
    };
    use axum::{
        body::Body,
        http::{Request, Response, StatusCode},
        middleware,
    };
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;
    struct Fixture {
        directory: tempfile::TempDir,
        state: AppState,
        app: Router,
        calls: Arc<Mutex<Vec<Value>>>,
        tools: Arc<Mutex<Vec<Value>>>,
        server: tokio::task::JoinHandle<()>,
        url: String,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
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
                    issue_access_token("apps-fixture-only", owner, owner)
                ),
            );
        }
        request.body(Body::from(body.to_string())).unwrap()
    }
    async fn body(response: axum::response::Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 2_097_152)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    async fn fixture() -> Fixture {
        let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
        let observed = calls.clone();
        let tools = Arc::new(Mutex::new(vec![
            json!({"name":"show_app","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":"ui://fixture/app","visibility":["model","app"]}}}),
            json!({"name":"echo","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}}),
            json!({"name":"model_only","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["model"]}}}),
        ]));
        let discovery = tools.clone();
        let endpoint=Router::new().route("/mcp",axum::routing::any(move |request:Request<Body>|{let calls=observed.clone();let tools=discovery.clone();async move {
            let method=request.method().clone();let bytes=axum::body::to_bytes(request.into_body(),1_048_576).await.unwrap();
            if method=="DELETE"{let mut calls=calls.lock().unwrap();calls.push(json!({"method":"DELETE"}));let fail=calls.iter().any(|call|call["syntheticDeleteFailure"]==true);return Response::builder().status(if fail{StatusCode::INTERNAL_SERVER_ERROR}else{StatusCode::NO_CONTENT}).body(Body::empty()).unwrap();}
            let input:Value=serde_json::from_slice(&bytes).unwrap();calls.lock().unwrap().push(input.clone());
            if input.get("id").is_none(){return Response::builder().status(StatusCode::ACCEPTED).body(Body::empty()).unwrap();}
            if input["method"]=="tools/call" && input["params"]["arguments"]["hang"]==true{return Response::builder().header("content-type","application/json").body(Body::from_stream(futures_util::stream::pending::<Result<Vec<u8>,std::io::Error>>())).unwrap();}
            let result=match input["method"].as_str().unwrap(){
                "initialize"=>json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"V4 synthetic Apps server","version":"1"},"capabilities":{"tools":{},"resources":{}}}),
                "tools/list"=>json!({"tools":tools.lock().unwrap().clone()}),
                "resources/read"=>json!({"contents":[{"uri":input["params"]["uri"],"mimeType":"text/html;profile=mcp-app","text":"<!DOCTYPE html><html><main>V4 own MCP App fixture</main></html>","_meta":{"ui":{"csp":{"connectDomains":[],"resourceDomains":[]},"permissions":{"camera":{}}}}}]}),
                "tools/call"=>json!({"content":[{"type":"text","text":"Synthetic approved tool result"}],"structuredContent":input["params"]["arguments"],"isError":false,"_meta":{"fixture":"preserved"}}),
                _=>panic!("Unexpected fixture method")
            };
            Response::builder().header("content-type","application/json").header("mcp-session-id","synthetic-app-session").body(Body::from(json!({"jsonrpc":"2.0","id":input["id"],"result":result}).to_string())).unwrap()
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, endpoint).await.unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(AppConfig {
            data_dir: directory.path().to_path_buf(),
            jwt_secret: "apps-fixture-only".into(),
            ..Default::default()
        })
        .unwrap();
        let app = agent_mcp::routes()
            .merge(routes())
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state.clone());
        let fixture = Fixture {
            directory,
            state,
            app,
            calls,
            tools,
            server,
            url: format!("http://{address}/mcp"),
        };
        save(&fixture, true).await;
        fixture
    }
    async fn save(fixture: &Fixture, enabled: bool) {
        let input = json!({"servers":[{"id":"fixture","name":"Synthetic Apps","enabled":enabled,"timeoutSeconds":3,"transport":{"type":"http","url":fixture.url,"bearerToken":"synthetic-only-secret"}}]});
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), input))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    async fn open(fixture: &Fixture) -> Value {
        let response = fixture
            .app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/apps/open",
                Some("owner"),
                json!({"resourceUri":"ui://fixture/app","toolName":"show_app"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        body(response).await
    }
    fn count(fixture: &Fixture, method: &str) -> usize {
        fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == method)
            .count()
    }
    #[tokio::test]
    async fn app_open_is_explicit_owner_bound_and_returns_only_declared_html_metadata() {
        let fixture = fixture().await;
        assert_eq!(fixture.calls.lock().unwrap().len(), 0);
        let response = fixture
            .app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/apps/open",
                None,
                json!({"resourceUri":"ui://fixture/app"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let opened = open(&fixture).await;
        assert!(opened["html"]
            .as_str()
            .unwrap()
            .contains("V4 own MCP App fixture"));
        assert_eq!(
            opened["csp"],
            json!({"connectDomains":[],"resourceDomains":[]})
        );
        assert_eq!(opened["permissions"], json!({"camera":{}}));
        assert!(!opened.to_string().contains("synthetic-only-secret"));
        let id = opened["sessionId"].as_str().unwrap();
        let path = format!("/api/agent/mcp/apps/{id}");
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("GET", &path, Some("other"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("DELETE", &path, Some("other"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            body(
                fixture
                    .app
                    .clone()
                    .oneshot(request("GET", &path, Some("owner"), Value::Null))
                    .await
                    .unwrap()
            )
            .await["status"],
            "active"
        );
        let response = fixture
            .app
            .clone()
            .oneshot(request("DELETE", &path, Some("owner"), Value::Null))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await["status"], "closed");
        assert_eq!(count(&fixture, "DELETE"), 1);
    }
    #[tokio::test]
    async fn app_requests_wait_for_separate_approval_and_execute_once_on_originating_server() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let path = format!(
            "/api/agent/mcp/apps/{}/requests",
            opened["sessionId"].as_str().unwrap()
        );
        let request_body = json!({"method":"tools/call","params":{"name":"echo","arguments":{"message":"approved"}}});
        let response = fixture
            .app
            .clone()
            .oneshot(request("POST", &path, Some("owner"), request_body.clone()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let pending = body(response).await;
        assert_eq!(pending["status"], "pending");
        assert_eq!(count(&fixture, "tools/call"), 0);
        let decision_path = format!("{path}/{}/decision", pending["requestId"].as_str().unwrap());
        let response = fixture
            .app
            .clone()
            .oneshot(request(
                "POST",
                &decision_path,
                Some("owner"),
                json!({"approved":false}),
            ))
            .await
            .unwrap();
        assert_eq!(body(response).await["status"], "denied");
        assert_eq!(count(&fixture, "tools/call"), 0);
        let pending = body(
            fixture
                .app
                .clone()
                .oneshot(request("POST", &path, Some("owner"), request_body))
                .await
                .unwrap(),
        )
        .await;
        let decision_path = format!("{path}/{}/decision", pending["requestId"].as_str().unwrap());
        for _ in 0..2 {
            let response = fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &decision_path,
                    Some("owner"),
                    json!({"approved":true}),
                ))
                .await
                .unwrap();
            let result = body(response).await;
            assert_eq!(result["status"], "completed");
            assert_eq!(result["result"]["structuredContent"]["message"], "approved");
            assert_eq!(result["result"]["_meta"]["fixture"], "preserved");
        }
        assert_eq!(count(&fixture, "tools/call"), 1);
        let hidden = json!({"method":"tools/call","params":{"name":"model_only","arguments":{}}});
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("POST", &path, Some("owner"), hidden))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        shutdown(&fixture.state.config().data_dir).await;
    }
    #[tokio::test]
    async fn changing_server_configuration_revokes_apps_and_pending_requests() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let path = format!(
            "/api/agent/mcp/apps/{}",
            opened["sessionId"].as_str().unwrap()
        );
        let pending = body(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &format!("{path}/requests"),
                    Some("owner"),
                    json!({"method":"tools/call","params":{"name":"echo","arguments":{}}}),
                ))
                .await
                .unwrap(),
        )
        .await;
        save(&fixture, false).await;
        assert_eq!(count(&fixture, "DELETE"), 1);
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("GET", &path, Some("owner"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let decision = format!(
            "{path}/requests/{}/decision",
            pending["requestId"].as_str().unwrap()
        );
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &decision,
                    Some("owner"),
                    json!({"approved":true})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(count(&fixture, "tools/call"), 0);
    }
    #[tokio::test]
    async fn app_cannot_read_arbitrary_undeclared_ui_resources() {
        let fixture = fixture().await;
        let response = fixture
            .app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/apps/open",
                Some("owner"),
                json!({"resourceUri":"ui://fixture/not-declared"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(count(&fixture, "resources/read"), 0);
    }
    #[test]
    fn mcp_app_html_mime_and_base64_are_bounded_and_validated() {
        for mime in [
            "text/html;profile=mcp-app",
            "text/html; profile=\"mcp-app\"; charset=utf-8",
            "text/html+mcp",
        ] {
            assert!(html_mime(mime));
        }
        for mime in [
            "text/html",
            "text/plain",
            "application/javascript",
            "text/html;profile=unknown",
        ] {
            assert!(!html_mime(mime));
        }
        assert_eq!(
            decode_html("PGh0bWw+PC9odG1sPg==").unwrap(),
            "<html></html>"
        );
        for blob in ["a", "abcd=", "=AAA", "AB==", "!!!!"] {
            assert!(decode_html(blob).is_err(), "{blob}");
        }
        assert!(decode_html(&"A".repeat(MAX_HTML * 2)).is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn closing_while_opening_stops_stdio_and_pre_open_delete_is_a_tombstone() {
        let fixture = fixture().await;
        let script = fixture.directory.path().join("hanging-app.py");
        let pidfile = fixture.directory.path().join("app-pid");
        std::fs::write(&script,"import os,sys,time\nopen(sys.argv[1],'w').write(str(os.getpid()))\nfor line in sys.stdin: time.sleep(60)\n").unwrap();
        let config = json!({"servers":[{"id":"hanging","name":"Synthetic hanging App","enabled":true,"timeoutSeconds":30,"transport":{"type":"stdio","command":"/usr/bin/python3","args":["-u",script,pidfile],"env":{}}}]});
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), config))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let id = Uuid::new_v4();
        let app = fixture.app.clone();
        let opening = tokio::spawn(async move {
            app.oneshot(request(
                "POST",
                "/api/agent/mcp/hanging/apps/open",
                Some("owner"),
                json!({"resourceUri":"ui://fixture/app","sessionId":id}),
            ))
            .await
            .unwrap()
        });
        let mut observed_pid = None;
        for _ in 0..200 {
            observed_pid = std::fs::read_to_string(&pidfile)
                .ok()
                .and_then(|text| text.parse::<libc::pid_t>().ok());
            if observed_pid.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid = observed_pid.expect("Synthetic App must publish its complete PID");
        let path = format!("/api/agent/mcp/apps/{id}");
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(
            body(
                fixture
                    .app
                    .clone()
                    .oneshot(request("GET", &path, Some("owner"), Value::Null))
                    .await
                    .unwrap()
            )
            .await["status"],
            "opening"
        );
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("DELETE", &path, Some("other"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let closed = tokio::time::timeout(
            Duration::from_secs(6),
            fixture
                .app
                .clone()
                .oneshot(request("DELETE", &path, Some("owner"), Value::Null)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(closed.status(), StatusCode::OK);
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(opening.await.unwrap().status(), StatusCode::GONE);
        std::fs::remove_file(&pidfile).unwrap();
        let id = Uuid::new_v4();
        let path = format!("/api/agent/mcp/apps/{id}");
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("DELETE", &path, Some("owner"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    "/api/agent/mcp/hanging/apps/open",
                    Some("owner"),
                    json!({"resourceUri":"ui://fixture/app","sessionId":id})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::GONE
        );
        assert!(!pidfile.exists());
    }
    #[tokio::test]
    async fn closing_an_app_cancels_pending_tool_before_deleting_http_session() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let path = format!(
            "/api/agent/mcp/apps/{}",
            opened["sessionId"].as_str().unwrap()
        );
        let queued=body(fixture.app.clone().oneshot(request("POST",&format!("{path}/requests"),Some("owner"),json!({"method":"tools/call","params":{"name":"echo","arguments":{"hang":true}}}))).await.unwrap()).await;
        let decision_path = format!(
            "{path}/requests/{}/decision",
            queued["requestId"].as_str().unwrap()
        );
        let app = fixture.app.clone();
        let decision = tokio::spawn(async move {
            app.oneshot(request(
                "POST",
                &decision_path,
                Some("owner"),
                json!({"approved":true}),
            ))
            .await
            .unwrap()
        });
        for _ in 0..100 {
            if count(&fixture, "tools/call") > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("DELETE", &path, Some("owner"), Value::Null))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(body(decision.await.unwrap()).await["status"], "failed");
        let calls = fixture.calls.lock().unwrap();
        let cancellation = calls
            .iter()
            .position(|call| call["method"] == "notifications/cancelled")
            .expect("Pending RPC needs cancellation notification");
        let deleted = calls
            .iter()
            .position(|call| call["method"] == "DELETE")
            .unwrap();
        assert!(cancellation < deleted);
    }
    #[tokio::test]
    async fn app_session_id_cannot_be_reused_for_a_different_resource() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let response = fixture
            .app
            .clone()
            .oneshot(request(
                "POST",
                "/api/agent/mcp/fixture/apps/open",
                Some("owner"),
                json!({"resourceUri":"ui://fixture/not-declared","sessionId":opened["sessionId"]}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        shutdown(&fixture.state.config().data_dir).await;
    }
    #[tokio::test]
    async fn approved_tool_refresh_denies_a_tool_that_became_app_invisible() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let path = format!(
            "/api/agent/mcp/apps/{}/requests",
            opened["sessionId"].as_str().unwrap()
        );
        let call = json!({"method":"tools/call","params":{"name":"echo","arguments":{"message":"reviewed before visibility changed"}}});
        let pending = body(
            fixture
                .app
                .clone()
                .oneshot(request("POST", &path, Some("owner"), call.clone()))
                .await
                .unwrap(),
        )
        .await;
        fixture
            .tools
            .lock()
            .unwrap()
            .iter_mut()
            .find(|tool| tool["name"] == "echo")
            .unwrap()["_meta"]["ui"]["visibility"] = json!(["model"]);
        let decision = format!("{path}/{}/decision", pending["requestId"].as_str().unwrap());
        let result = body(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &decision,
                    Some("owner"),
                    json!({"approved":true}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(result["status"], "failed");
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("no longer visible"));
        assert_eq!(count(&fixture, "tools/call"), 0);
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("POST", &path, Some("owner"), call))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        shutdown(&fixture.state.config().data_dir).await;
    }
    #[tokio::test]
    async fn approved_discovery_updates_the_snapshot_for_new_app_visible_tools() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let path = format!(
            "/api/agent/mcp/apps/{}/requests",
            opened["sessionId"].as_str().unwrap()
        );
        fixture.tools.lock().unwrap().push(json!({"name":"new_app_tool","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}}));
        let call = json!({"method":"tools/call","params":{"name":"new_app_tool","arguments":{"message":"newly discovered"}}});
        assert_eq!(
            fixture
                .app
                .clone()
                .oneshot(request("POST", &path, Some("owner"), call.clone()))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let pending = body(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &path,
                    Some("owner"),
                    json!({"method":"tools/list","params":{}}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let decision = format!("{path}/{}/decision", pending["requestId"].as_str().unwrap());
        let listed = body(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &decision,
                    Some("owner"),
                    json!({"approved":true}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(listed["status"], "completed");
        assert!(listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "new_app_tool"));
        let response = fixture
            .app
            .clone()
            .oneshot(request("POST", &path, Some("owner"), call))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let pending = body(response).await;
        let decision = format!("{path}/{}/decision", pending["requestId"].as_str().unwrap());
        let result = body(
            fixture
                .app
                .clone()
                .oneshot(request(
                    "POST",
                    &decision,
                    Some("owner"),
                    json!({"approved":true}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(result["status"], "completed");
        assert_eq!(count(&fixture, "tools/call"), 1);
        shutdown(&fixture.state.config().data_dir).await;
    }
    #[tokio::test]
    async fn settings_save_reports_app_cleanup_failure_and_same_config_retry_confirms_close() {
        let fixture = fixture().await;
        let opened = open(&fixture).await;
        let session_id = opened["sessionId"].as_str().unwrap();
        fixture
            .calls
            .lock()
            .unwrap()
            .push(json!({"syntheticDeleteFailure":true}));
        let config = json!({"servers":[{"id":"fixture","name":"Synthetic Apps","enabled":false,"timeoutSeconds":3,"transport":{"type":"http","url":fixture.url,"bearerToken":"synthetic-only-secret"}}]});
        for _ in 0..2 {
            let response = fixture
                .app
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
            let public = body(response).await;
            assert_eq!(public["settingsSaved"], true);
            assert_eq!(public["cleanupConfirmed"], false);
            assert!(!public.to_string().contains("synthetic-only-secret"));
        }
        assert_eq!(count(&fixture, "DELETE"), 2);
        fixture
            .calls
            .lock()
            .unwrap()
            .retain(|call| call["syntheticDeleteFailure"] != true);
        let response = fixture
            .app
            .clone()
            .oneshot(request("PUT", "/api/agent/mcp", Some("owner"), config))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(count(&fixture, "DELETE"), 3);
        let session = session(
            Uuid::parse_str(session_id).unwrap(),
            &fixture.state.config().data_dir,
            "owner",
        )
        .unwrap();
        assert!(session.client.lock().await.is_none());
    }
}
