use crate::{auth::AuthenticatedUser, remote_permissions::Capabilities, state::AppState, ApiError};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        FromRequestParts, Path, Request, State,
    },
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{any, get},
    Extension, Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use uuid::Uuid;
const CHUNK: usize = 65536;
const BODY_LIMIT: usize = 32 * 1024 * 1024;
const FRAME_LIMIT: usize = CHUNK + 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Control {
    Register {
        key: String,
        secret: String,
    },
    Registered,
    Open {
        id: Uuid,
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        websocket: bool,
    },
    Opened {
        id: Uuid,
        status: u16,
        headers: Vec<(String, String)>,
    },
    End {
        id: Uuid,
    },
    Close {
        id: Uuid,
    },
}
#[derive(Debug)]
enum Event {
    Opened(u16, Vec<(String, String)>),
    Data(u8, Vec<u8>),
    End,
    Close,
}
#[derive(Clone)]
struct HostPeer {
    generation: Uuid,
    tx: mpsc::Sender<Message>,
    streams: Arc<Mutex<HashMap<Uuid, mpsc::Sender<Event>>>>,
    permits: Arc<Semaphore>,
    stop: Arc<tokio::sync::Notify>,
}
#[derive(Default)]
struct RelayRuntime {
    hosts: Mutex<HashMap<String, HostPeer>>,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    connected: AtomicBool,
    stopping: AtomicBool,
    config_error: Mutex<Option<String>>,
    server_key: Mutex<Option<String>>,
}
fn runtime(state: &AppState) -> Arc<RelayRuntime> {
    static STATES: OnceLock<Mutex<HashMap<std::path::PathBuf, Arc<RelayRuntime>>>> =
        OnceLock::new();
    STATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(state.config().data_dir.clone())
        .or_default()
        .clone()
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/relay/status", get(status))
}
pub(crate) fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/relay/hosts/{device}/register", get(register))
        .route("/api/relay/devices/{device}/{*rest}", any(proxy))
}
async fn status(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rt = runtime(&state);
    Ok(Json(
        json!({"deviceId":crate::paired_environments::device_identity(&state)?,"configured":std::env::var("TERMINAL_V4_RELAY_URL").is_ok(),"connected":rt.connected.load(Ordering::Acquire),"brokerEnabled":rt.server_key.lock().unwrap_or_else(|e|e.into_inner()).is_some(),"error":rt.config_error.lock().unwrap_or_else(|e|e.into_inner()).clone()}),
    ))
}
fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn secure_equal(a: &str, b: &str) -> bool {
    let a = Sha256::digest(a.as_bytes());
    let b = Sha256::digest(b.as_bytes());
    a.iter().zip(b.iter()).fold(0u8, |n, (x, y)| n | (x ^ y)) == 0
}
fn allowed(method: &str, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    if matches!(
        (method, path),
        (
            "POST",
            "/api/environments/exchange" | "/api/environments/release"
        ) | ("GET", "/api/environments/check")
    ) {
        return true;
    }
    Capabilities {
        terminal_input: true,
        file_write: true,
        agent_execute: true,
        tunnels: true,
        desktop_view: true,
        desktop_control: true,
        transfer: true,
        recordings: true,
    }
    .allows_http(method, path)
}
fn relay_origin(value: &str) -> Result<String, String> {
    let url =
        url::Url::parse(value).map_err(|_| "Enter an absolute relay HTTPS URL".to_string())?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
    {
        return Err(
            "The relay requires HTTPS except on loopback, with no path or credentials".into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
pub(crate) fn device_destination(origin: &str, device: &str) -> Result<String, String> {
    let id = Uuid::parse_str(device).map_err(|_| "Enter a valid device UUID".to_string())?;
    Ok(format!("{}/api/relay/devices/{id}", relay_origin(origin)?))
}
fn control(value: Control) -> Message {
    Message::Text(
        serde_json::to_string(&value)
            .expect("Relay control serialization")
            .into(),
    )
}
fn binary(id: Uuid, kind: u8, bytes: &[u8]) -> Message {
    let mut data = Vec::with_capacity(17 + bytes.len());
    data.extend_from_slice(id.as_bytes());
    data.push(kind);
    data.extend_from_slice(bytes);
    Message::Binary(data.into())
}
fn decode(message: Message) -> Option<(Uuid, Event)> {
    match message {
        Message::Text(text) if text.len() <= 16384 => {
            match serde_json::from_str::<Control>(&text).ok()? {
                Control::Opened {
                    id,
                    status,
                    headers,
                } => Some((id, Event::Opened(status, headers))),
                Control::End { id } => Some((id, Event::End)),
                Control::Close { id } => Some((id, Event::Close)),
                _ => None,
            }
        }
        Message::Binary(data) if data.len() >= 17 && data.len() <= FRAME_LIMIT => Some((
            Uuid::from_slice(&data[..16]).ok()?,
            Event::Data(data[16], data[17..].to_vec()),
        )),
        _ => None,
    }
}
async fn send(tx: &mpsc::Sender<Message>, message: Message) -> Result<(), ()> {
    tokio::time::timeout(Duration::from_secs(10), tx.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}
async fn send_socket(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(10), socket.send(message)).await,
        Ok(Ok(()))
    )
}
async fn send_host<S>(socket: &mut S, message: tungstenite::Message) -> bool
where
    S: futures_util::Sink<tungstenite::Message> + Unpin,
{
    matches!(
        tokio::time::timeout(Duration::from_secs(10), socket.send(message)).await,
        Ok(Ok(()))
    )
}
fn release_peer(rt: &RelayRuntime, id: &str, peer: &HostPeer) {
    let mut hosts = rt.hosts.lock().unwrap_or_else(|error| error.into_inner());
    if hosts
        .get(id)
        .is_some_and(|current| current.generation == peer.generation)
    {
        hosts.remove(id);
    }
    peer.streams
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}
async fn deliver(
    streams: &Mutex<HashMap<Uuid, mpsc::Sender<Event>>>,
    id: Uuid,
    event: Event,
) -> bool {
    let channel = streams
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned();
    match channel {
        Some(channel) => matches!(
            tokio::time::timeout(Duration::from_secs(5), channel.send(event)).await,
            Ok(Ok(()))
        ),
        None => true,
    }
}
fn headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "authorization"
                    | "content-type"
                    | "accept"
                    | "range"
                    | "if-none-match"
                    | "if-modified-since"
                    | "content-disposition"
                    | "content-range"
                    | "accept-ranges"
                    | "etag"
                    | "last-modified"
                    | "cache-control"
                    | "x-terminal-v4-framing"
                    | "sec-websocket-protocol"
            )
        })
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .take(24)
        .collect()
}
fn valid_headers(values: &[(String, String)]) -> bool {
    values.len() <= 24
        && values.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() <= 8192
        && values.iter().all(|(k, v)| {
            axum::http::HeaderName::try_from(k.as_str()).is_ok()
                && axum::http::HeaderValue::try_from(v.as_str()).is_ok()
        })
}
fn target_auth(method: &str, path: &str, headers: &[(String, String)]) -> bool {
    if !allowed(method, path) || !valid_headers(headers) {
        return false;
    }
    if method == "POST" && path == "/api/environments/exchange" {
        return true;
    }
    headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("authorization")
            && value.starts_with("Bearer tv4pair.")
            && value.len() == 79
    })
}
fn clean_path(rest: &str, query: Option<&str>) -> Result<String, ApiError> {
    let path = format!("/{rest}");
    if path.contains('%')
        || path.contains('\\')
        || path.contains("//")
        || path.split('/').any(|p| matches!(p, "." | ".."))
    {
        return Err(ApiError::bad_request("Invalid relay path"));
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
        if !matches!(key.as_ref(), "token" | "previewToken") {
            serializer.append_pair(&key, &value);
        }
    }
    let query = serializer.finish();
    Ok(if query.is_empty() {
        path
    } else {
        format!("{path}?{query}")
    })
}
async fn register(
    State(state): State<AppState>,
    Path(device): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let id = Uuid::parse_str(&device)
        .map_err(|_| ApiError::bad_request("Invalid device UUID"))?
        .to_string();
    if runtime(&state)
        .server_key
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_none()
    {
        return Err(ApiError::not_found("Relay broker disabled"));
    }
    Ok(upgrade
        .max_message_size(FRAME_LIMIT)
        .max_frame_size(FRAME_LIMIT)
        .on_upgrade(move |socket| register_socket(state, id, socket)))
}
fn pin(state: &AppState, id: &str, secret: &str) -> Result<bool, ApiError> {
    if secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let db = state.lock_db().map_err(ApiError::internal)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS relay_devices (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL)",
    )
    .map_err(|_| ApiError::internal("Relay identity storage unavailable"))?;
    db.execute(
        "INSERT OR IGNORE INTO relay_devices(id,secret_hash) VALUES (?1,?2)",
        rusqlite::params![id, digest(secret)],
    )
    .map_err(|_| ApiError::internal("Relay identity storage unavailable"))?;
    let hash: String = db
        .query_row(
            "SELECT secret_hash FROM relay_devices WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| ApiError::internal("Relay identity storage unavailable"))?;
    Ok(secure_equal(&hash, &digest(secret)))
}
async fn register_socket(state: AppState, id: String, mut socket: WebSocket) {
    let Ok(Some(Ok(Message::Text(text)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    if text.len() > 1024 {
        return;
    }
    let Ok(Control::Register { key, secret }) = serde_json::from_str(&text) else {
        return;
    };
    let rt = runtime(&state);
    let configured = rt
        .server_key
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if !configured.is_some_and(|expected| secure_equal(&key, &expected))
        || !pin(&state, &id, &secret).unwrap_or(false)
    {
        let _ = tokio::time::timeout(Duration::from_secs(3), socket.close()).await;
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Message>(128);
    let peer = HostPeer {
        generation: Uuid::new_v4(),
        tx,
        streams: Default::default(),
        permits: Arc::new(Semaphore::new(32)),
        stop: Default::default(),
    };
    {
        let mut hosts = rt.hosts.lock().unwrap_or_else(|e| e.into_inner());
        if rt.stopping.load(Ordering::Acquire) || (hosts.len() >= 128 && !hosts.contains_key(&id)) {
            return;
        }
        if let Some(previous) = hosts.insert(id.clone(), peer.clone()) {
            previous.stop.notify_one();
        }
    }
    if !send_socket(&mut socket, control(Control::Registered)).await {
        release_peer(&rt, &id, &peer);
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = peer.stop.notified() => break,
            message = rx.recv() => {
                let Some(message) = message else { break; };
                if !send_socket(&mut socket,message).await { break; }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break; };
                last = tokio::time::Instant::now();
                if matches!(message,Message::Close(_)) { break; }
                if let Some((stream,event)) = decode(message) {
                    if !deliver(&peer.streams,stream,event).await {
                        peer.streams.lock().unwrap_or_else(|e|e.into_inner()).remove(&stream);
                        let _=peer.tx.try_send(control(Control::Close { id:stream }));
                    }
                }
            }
            _ = heartbeat.tick() => {
                if last.elapsed() > Duration::from_secs(50) || !send_socket(&mut socket,Message::Ping(Vec::new().into())).await { break; }
            }
        }
    }
    release_peer(&rt, &id, &peer);
}
struct StreamGuard {
    peer: HostPeer,
    id: Uuid,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.peer
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
        let message = control(Control::Close { id: self.id });
        if let Err(mpsc::error::TrySendError::Full(message)) = self.peer.tx.try_send(message) {
            let sender = self.peer.tx.clone();
            tokio::spawn(async move {
                let _ = send(&sender, message).await;
            });
        }
    }
}
async fn proxy(
    State(state): State<AppState>,
    Path((device, rest)): Path<(String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    let device = Uuid::parse_str(&device)
        .map_err(|_| ApiError::bad_request("Invalid device UUID"))?
        .to_string();
    let path = clean_path(&rest, request.uri().query())?;
    let method = request.method().as_str().to_string();
    let incoming_headers = headers(request.headers());
    if !target_auth(&method, &path, &incoming_headers) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Only paired runtime requests can use the relay".into(),
        });
    }
    let peer = runtime(&state)
        .hosts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&device)
        .cloned()
        .ok_or_else(|| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Device is offline".into(),
        })?;
    let permit = peer
        .permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "Device relay is busy".into(),
        })?;
    let id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel(8);
    peer.streams
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, tx);
    let guard = StreamGuard {
        peer: peer.clone(),
        id,
        _permit: permit,
    };
    let (mut parts, body) = request.into_parts();
    let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &state)
        .await
        .ok();
    send(
        &peer.tx,
        control(Control::Open {
            id,
            method,
            path,
            headers: incoming_headers,
            websocket: upgrade.is_some(),
        }),
    )
    .await
    .map_err(|_| ApiError::bad_request("Relay connection unavailable"))?;
    if upgrade.is_none() {
        let bytes = tokio::time::timeout(Duration::from_secs(30), to_bytes(body, BODY_LIMIT))
            .await
            .map_err(|_| ApiError::bad_request("Relay upload timed out"))?
            .map_err(|_| ApiError::bad_request("Relay request exceeds 32 MiB"))?;
        for chunk in bytes.chunks(CHUNK) {
            send(&peer.tx, binary(id, 0, chunk))
                .await
                .map_err(|_| ApiError::bad_request("Relay upload interrupted"))?;
        }
        send(&peer.tx, control(Control::End { id }))
            .await
            .map_err(|_| ApiError::bad_request("Relay connection unavailable"))?;
    }
    let event = tokio::time::timeout(Duration::from_secs(30), rx.recv())
        .await
        .map_err(|_| ApiError::bad_request("Device response timed out"))?;
    let Some(Event::Opened(code, response_headers)) = event else {
        return Err(ApiError::bad_request(
            "Device relay closed before responding",
        ));
    };
    if let Some(upgrade) = upgrade {
        if code != 101 {
            return Err(ApiError {
                status: StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
                message: "Remote WebSocket rejected".into(),
            });
        }
        return Ok(upgrade
            .max_message_size(CHUNK)
            .on_upgrade(move |socket| client_socket(socket, rx, guard)));
    }
    if !valid_headers(&response_headers) {
        return Err(ApiError::bad_request("Invalid relayed headers"));
    }
    let stream = futures_util::stream::unfold((rx, Some(guard)), |(mut rx, guard)| async move {
        guard.as_ref()?;
        match rx.recv().await {
            Some(Event::Data(1, data)) => Some((
                Ok::<_, std::io::Error>(axum::body::Bytes::from(data)),
                (rx, guard),
            )),
            Some(Event::End) => None,
            _ => Some((
                Err(std::io::Error::other("Relay stream interrupted")),
                (rx, None),
            )),
        }
    });
    let mut response = Response::builder().status(code);
    for (name, value) in response_headers {
        response = response.header(name, value);
    }
    response
        .body(Body::from_stream(stream))
        .map_err(|_| ApiError::internal("Invalid relay response"))
}
async fn client_socket(mut socket: WebSocket, mut rx: mpsc::Receiver<Event>, guard: StreamGuard) {
    loop {
        tokio::select! {
            event = rx.recv() => {
                let message = match event {
                    Some(Event::Data(2,data)) => match String::from_utf8(data) { Ok(text)=>Message::Text(text.into()),Err(_)=>break },
                    Some(Event::Data(3,data)) => Message::Binary(data.into()),
                    _ => break,
                };
                if !send_socket(&mut socket,message).await { break; }
            }
            message = socket.recv() => {
                let message = match message {
                    Some(Ok(Message::Text(text))) => binary(guard.id,2,text.as_bytes()),
                    Some(Ok(Message::Binary(bytes))) => binary(guard.id,3,&bytes),
                    Some(Ok(Message::Ping(bytes))) => {if !send_socket(&mut socket,Message::Pong(bytes)).await{break;}continue;}
                    Some(Ok(Message::Pong(_))) => continue,
                    _ => break,
                };
                if send(&guard.peer.tx,message).await.is_err() { break; }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), socket.close()).await;
}
fn host_secret(state: &AppState) -> Result<String, String> {
    let db = state.lock_db()?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS relay_host_secret (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL)").map_err(|e|e.to_string())?;
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut bytes);
    db.execute(
        "INSERT OR IGNORE INTO relay_host_secret(id,secret) VALUES (1,?1)",
        [hex::encode(bytes)],
    )
    .map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT secret FROM relay_host_secret WHERE id=1",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(crate) fn start(state: &AppState) {
    let rt = runtime(state);
    rt.stopping.store(false, Ordering::Release);
    if let Ok(key) = std::env::var("TERMINAL_V4_RELAY_SERVER_KEY") {
        if key.len() >= 32 && key.len() <= 256 {
            *rt.server_key.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
        } else {
            *rt.config_error.lock().unwrap_or_else(|e| e.into_inner()) =
                Some("Relay server key must contain 32 to 256 characters".into());
        }
    }
    let Ok(origin) = std::env::var("TERMINAL_V4_RELAY_URL") else {
        return;
    };
    let settings = (|| {
        let origin = relay_origin(&origin)?;
        let key = std::env::var("TERMINAL_V4_RELAY_KEY")
            .map_err(|_| "Relay host key missing".to_string())?;
        if key.len() < 32 || key.len() > 256 {
            return Err("Relay host key must contain 32 to 256 characters".into());
        }
        let id = crate::paired_environments::device_identity(state).map_err(|e| e.message)?;
        let secret = host_secret(state)?;
        Ok((origin, key, id, secret))
    })();
    let (origin, key, id, secret) = match settings {
        Ok(settings) => settings,
        Err(error) => {
            *rt.config_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
            return;
        }
    };
    let address = if state.config().host.is_unspecified() {
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    } else {
        state.config().host
    };
    let local = format!(
        "http://{}",
        std::net::SocketAddr::new(address, state.config().port)
    );
    start_host(state, origin, key, id, secret, local);
}
fn start_host(
    state: &AppState,
    origin: String,
    key: String,
    id: String,
    secret: String,
    local: String,
) {
    let rt = runtime(state);
    let mut worker = rt.worker.lock().unwrap_or_else(|e| e.into_inner());
    if worker.is_some() {
        return;
    }
    let rt_worker = rt.clone();
    *worker = Some(tokio::spawn(async move {
        let mut delay = 1u64;
        loop {
            let connected = host_connection(&origin, &key, &id, &secret, &local, &rt_worker).await;
            rt_worker.connected.store(false, Ordering::Release);
            if connected {
                delay = 1;
            }
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = (delay * 2).min(30);
        }
    }));
}
pub(crate) async fn shutdown(state: &AppState) {
    let rt = runtime(state);
    rt.stopping.store(true, Ordering::Release);
    rt.server_key
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let handle = rt.worker.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(handle) = handle {
        handle.abort();
        let _ = handle.await;
    }
    rt.connected.store(false, Ordering::Release);
    rt.hosts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .for_each(|(_, host)| host.stop.notify_one());
}
async fn host_connection(
    origin: &str,
    key: &str,
    id: &str,
    secret: &str,
    local: &str,
    rt: &RelayRuntime,
) -> bool {
    let mut url = match url::Url::parse(&format!("{origin}/api/relay/hosts/{id}/register")) {
        Ok(url) => url,
        Err(_) => return false,
    };
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    if url.set_scheme(scheme).is_err() {
        return false;
    }
    let Ok(Ok((mut socket, _))) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(
            url.as_str(),
            Some(
                tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(Some(FRAME_LIMIT))
                    .max_frame_size(Some(FRAME_LIMIT)),
            ),
            false,
        ),
    )
    .await
    else {
        return false;
    };
    let register = serde_json::to_string(&Control::Register {
        key: key.into(),
        secret: secret.into(),
    })
    .unwrap();
    if !send_host(&mut socket, tungstenite::Message::Text(register.into())).await {
        return false;
    }
    let Ok(Some(Ok(tungstenite::Message::Text(text)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.next()).await
    else {
        return false;
    };
    if !matches!(
        serde_json::from_str::<Control>(&text),
        Ok(Control::Registered)
    ) {
        return false;
    }
    rt.connected.store(true, Ordering::Release);
    let (tx, mut rx) = mpsc::channel::<Message>(128);
    let streams: Arc<Mutex<HashMap<Uuid, mpsc::Sender<Event>>>> = Default::default();
    let permits = Arc::new(Semaphore::new(32));
    let mut children = tokio::task::JoinSet::new();
    let mut last = tokio::time::Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break; };
                let outgoing = match message {
                    Message::Text(text) => tungstenite::Message::Text(text.to_string().into()),
                    Message::Binary(data) => tungstenite::Message::Binary(data),
                    _ => continue,
                };
                if !send_host(&mut socket,outgoing).await { break; }
            }
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break; };
                last = tokio::time::Instant::now();
                match message {
                    tungstenite::Message::Text(text) if text.len() <= 16384 => {
                        match serde_json::from_str::<Control>(&text) {
                            Ok(Control::Open { id, method, path, headers, websocket }) => {
                                let permit = permits.clone().try_acquire_owned();
                                let rejection = if !target_auth(&method,&path,&headers) { Some(403) }
                                    else if permit.is_err() { Some(429) }
                                    else if streams.lock().unwrap_or_else(|e|e.into_inner()).contains_key(&id) { Some(409) }
                                    else { None };
                                if let Some(status) = rejection {
                                    let _=send(&tx,control(Control::Opened { id,status,headers:vec![] })).await;
                                    let _=send(&tx,control(Control::End { id })).await;
                                    continue;
                                }
                                let Ok(permit) = permit else { continue; };
                                let (stream_tx,stream_rx) = mpsc::channel(8);
                                streams.lock().unwrap_or_else(|e|e.into_inner()).insert(id,stream_tx);
                                let (output,streams,local) = (tx.clone(),streams.clone(),local.to_string());
                                children.spawn(async move {
                                    let _permit = permit;
                                    if websocket { host_socket(id,&local,&path,headers,output.clone(),stream_rx).await; }
                                    else { host_http(id,&local,&method,&path,headers,output.clone(),stream_rx).await; }
                                    streams.lock().unwrap_or_else(|e|e.into_inner()).remove(&id);
                                    let _=send(&output,control(Control::Close { id })).await;
                                });
                            }
                            Ok(value @ (Control::End { .. } | Control::Close { .. })) => {
                                let (id,event) = match value {
                                    Control::End { id } => (id,Event::End),
                                    Control::Close { id } => (id,Event::Close),
                                    _ => unreachable!(),
                                };
                                if !deliver(&streams,id,event).await { streams.lock().unwrap_or_else(|e|e.into_inner()).remove(&id); }
                            }
                            _ => break,
                        }
                    }
                    tungstenite::Message::Binary(data) if data.len() <= FRAME_LIMIT => {
                        if let Some((id,event)) = decode(Message::Binary(data)) {
                            if !deliver(&streams,id,event).await {
                                streams.lock().unwrap_or_else(|e|e.into_inner()).remove(&id);
                                let _=tx.try_send(control(Control::Close { id }));
                            }
                        }
                    }
                    tungstenite::Message::Ping(data) => { if !send_host(&mut socket,tungstenite::Message::Pong(data)).await { break; } }
                    tungstenite::Message::Pong(_) => {}
                    _ => break,
                }
            }
            _ = heartbeat.tick() => {
                if last.elapsed() > Duration::from_secs(50) || !send_host(&mut socket,tungstenite::Message::Ping(Vec::new().into())).await { break; }
            }
            _ = children.join_next(), if !children.is_empty() => {}
        }
    }
    children.abort_all();
    true
}
async fn host_http(
    id: Uuid,
    local: &str,
    method: &str,
    path: &str,
    request_headers: Vec<(String, String)>,
    output: mpsc::Sender<Message>,
    mut incoming: mpsc::Receiver<Event>,
) {
    let mut body = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(30), incoming.recv()).await {
            Ok(Some(Event::Data(0, data))) if body.len() + data.len() <= BODY_LIMIT => {
                body.extend(data)
            }
            Ok(Some(Event::End)) => break,
            _ => return,
        }
    }
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let method = match reqwest::Method::from_bytes(method.as_bytes()) {
        Ok(method) => method,
        Err(_) => return,
    };
    let mut request = client.request(method, format!("{local}{path}"));
    for (name, value) in request_headers {
        request = request.header(name, value);
    }
    let response =
        match tokio::time::timeout(Duration::from_secs(25), request.body(body).send()).await {
            Ok(Ok(response)) => response,
            _ => {
                let _ = send(
                    &output,
                    control(Control::Opened {
                        id,
                        status: 502,
                        headers: vec![],
                    }),
                )
                .await;
                let _ = send(&output, control(Control::End { id })).await;
                return;
            }
        };
    if send(
        &output,
        control(Control::Opened {
            id,
            status: response.status().as_u16(),
            headers: headers(response.headers()),
        }),
    )
    .await
    .is_err()
    {
        return;
    }
    let mut chunks = response.bytes_stream();
    let mut total = 0usize;
    loop {
        tokio::select! {
            chunk = tokio::time::timeout(Duration::from_secs(60),chunks.next()) => {
                let bytes = match chunk {
                    Ok(Some(Ok(bytes))) => bytes,
                    Ok(None) => break,
                    _ => return,
                };
                total += bytes.len();
                if total > 1024*1024*1024 { return; }
                for chunk in bytes.chunks(CHUNK) {
                    if send(&output,binary(id,1,chunk)).await.is_err() { return; }
                }
            }
            event = incoming.recv() => { if !matches!(event,Some(Event::End)) { return; } }
        }
    }
    let _ = send(&output, control(Control::End { id })).await;
}
async fn host_socket(
    id: Uuid,
    local: &str,
    path: &str,
    request_headers: Vec<(String, String)>,
    output: mpsc::Sender<Message>,
    mut incoming: mpsc::Receiver<Event>,
) {
    let mut url = match url::Url::parse(&format!("{local}{path}")) {
        Ok(url) => url,
        Err(_) => return,
    };
    if url.set_scheme("ws").is_err() {
        return;
    }
    let Ok(mut request) = url.as_str().into_client_request() else {
        return;
    };
    let authorization = request_headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    for (name, value) in request_headers {
        if name == "authorization" || name == "x-terminal-v4-framing" {
            let (Ok(name), Ok(value)) = (
                tungstenite::http::HeaderName::try_from(name),
                tungstenite::http::HeaderValue::try_from(value),
            ) else {
                return;
            };
            request.headers_mut().insert(name, value);
        }
    }
    let Ok(Ok((mut socket, _))) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    else {
        let _ = send(
            &output,
            control(Control::Opened {
                id,
                status: 502,
                headers: vec![],
            }),
        )
        .await;
        return;
    };
    if send(
        &output,
        control(Control::Opened {
            id,
            status: 101,
            headers: vec![],
        }),
    )
    .await
    .is_err()
    {
        return;
    }
    let mut grant_check = tokio::time::interval(Duration::from_secs(2));
    let client = reqwest::Client::new();
    loop {
        tokio::select! {
            event = incoming.recv() => {
                let message = match event {
                    Some(Event::Data(2,data)) => match String::from_utf8(data) {Ok(text)=>tungstenite::Message::Text(text.into()),Err(_)=>break},
                    Some(Event::Data(3,data)) => tungstenite::Message::Binary(data.into()),
                    _ => break,
                };
                if !send_host(&mut socket,message).await {break;}
            }
            event = socket.next() => {
                let message = match event {
                    Some(Ok(tungstenite::Message::Text(text))) if text.len()<=CHUNK => binary(id,2,text.as_bytes()),
                    Some(Ok(tungstenite::Message::Binary(data))) if data.len()<=CHUNK => binary(id,3,&data),
                    Some(Ok(tungstenite::Message::Ping(data))) => {if !send_host(&mut socket,tungstenite::Message::Pong(data)).await{break;}continue;},
                    Some(Ok(tungstenite::Message::Pong(_))) => continue,
                    _ => break,
                };
                if send(&output,message).await.is_err(){break;}
            }
            _=grant_check.tick()=> {
                let alive=client.get(format!("{local}/api/environments/check")).header("authorization",&authorization).timeout(Duration::from_secs(2)).send().await;
                if !alive.is_ok_and(|response|response.status().is_success()){break;}
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), socket.close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_has_a_narrow_runtime_boundary() {
        assert!(allowed("POST", "/api/environments/exchange"));
        assert!(allowed("GET", "/api/terminal/session/ws"));
        for path in [
            "/api/auth/login",
            "/api/vault",
            "/api/relay/status",
            "/api/environments",
            "/api/terminal/../auth",
            "/api/terminal/%2e%2e/auth",
        ] {
            assert!(!allowed("GET", path), "{path}");
        }
    }
    #[test]
    fn relay_frames_preserve_binary_and_strip_home_query_tokens() {
        let id = Uuid::new_v4();
        let Some((decoded, Event::Data(kind, bytes))) = decode(binary(id, 3, &[0, 255, 42])) else {
            panic!("Missing relay frame");
        };
        assert_eq!((decoded, kind, bytes), (id, 3, vec![0, 255, 42]));
        assert!(decode(binary(id, 3, &vec![0; FRAME_LIMIT])).is_none());
        assert_eq!(
            clean_path(
                "api/terminal/a/ws",
                Some("token=home-secret&framed=1&previewToken=preview-secret")
            )
            .unwrap(),
            "/api/terminal/a/ws?framed=1"
        );
        assert!(!target_auth(
            "GET",
            "/api/terminal",
            &[("authorization".into(), "Bearer home.jwt.token".into())]
        ));
    }
    #[test]
    fn relay_configuration_requires_tls_outside_loopback() {
        assert_eq!(
            relay_origin("https://relay.example.test/"),
            Ok("https://relay.example.test".into())
        );
        assert!(relay_origin("http://relay.example.test").is_err());
        assert!(relay_origin("https://relay.example.test/path").is_err());
        assert!(relay_origin("https://user:secret@relay.example.test").is_err());
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use terminal_v4_core::AppConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    struct Server {
        state: AppState,
        directory: tempfile::TempDir,
        url: String,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
            if let Some(worker) = runtime(&self.state)
                .worker
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
            {
                worker.abort();
            }
        }
    }
    async fn server() -> Server {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = AppState::new_with_external_auth(
            AppConfig {
                data_dir: directory.path().into(),
                port: address.port(),
                jwt_secret: Uuid::new_v4().to_string(),
                ..AppConfig::default()
            },
            None,
        )
        .unwrap();
        let router = crate::app(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Server {
            state,
            directory,
            url: format!("http://{address}"),
            task,
        }
    }
    fn token(server: &Server, owner: &str) -> String {
        crate::auth::issue_access_token(&server.state.config().jwt_secret, owner, owner)
    }
    async fn json(response: reqwest::Response) -> serde_json::Value {
        let status = response.status();
        let body = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        serde_json::from_str(&body).unwrap()
    }
    async fn host(broker: &Server, target: &Server, key: &str) -> String {
        let id = crate::paired_environments::device_identity(&target.state).unwrap();
        start_host(
            &target.state,
            broker.url.clone(),
            key.into(),
            id.clone(),
            host_secret(&target.state).unwrap(),
            target.url.clone(),
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if runtime(&target.state).connected.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        id
    }
    #[tokio::test]
    async fn device_id_routes_real_http_download_and_pty_websocket_then_revokes() {
        let broker = server().await;
        let target = server().await;
        let home = server().await;
        let key = "relay-key-for-three-host-test-32-characters";
        *runtime(&broker.state).server_key.lock().unwrap() = Some(key.into());
        let device = host(&broker, &target, key).await;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();
        let local_token = token(&home, "home-owner");
        let pairing = json(
            client
                .post(format!("{}/api/environments/pairing-code", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .json(&json!({"label":"Relay test","profile":"custom","capabilities":{"terminalInput":true,"transfer":true,"tunnels":true}}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let connected=json(client.post(format!("{}/api/environments/connect",home.url)).bearer_auth(&local_token).json(&json!({"relayUrl":broker.url,"deviceId":device,"code":pairing["code"],"label":"Relay builder"})).send().await.unwrap()).await;
        assert_eq!(connected["deviceId"], device);
        assert!(!connected.to_string().contains("tv4pair."));
        let id = connected["id"].as_str().unwrap();
        let proxy = format!("{}/api/environments/{id}/proxy", home.url);
        let remote=json(client.post(format!("{proxy}/api/terminal")).bearer_auth(&local_token).json(&json!({"cwd":target.directory.path().to_string_lossy(),"title":"Relayed PTY","shell":if cfg!(windows){"cmd.exe"}else{"/bin/sh"}})).send().await.unwrap()).await;
        let session = remote["session"]["id"].as_str().unwrap();
        let own = json(
            client
                .get(format!("{}/api/terminal", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert!(own.to_string().contains(session));
        let unrelated = json(
            client
                .get(format!("{}/api/terminal", home.url))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert!(!unrelated.to_string().contains(session));
        let bytes = (0..1024 * 1024)
            .map(|n| (n % 251) as u8)
            .collect::<Vec<_>>();
        let file = target.directory.path().join("relay-transfer.bin");
        std::fs::write(&file, &bytes).unwrap();
        let download = client
            .get(format!("{proxy}/api/files/download"))
            .bearer_auth(&local_token)
            .query(&[("path", file.to_str().unwrap())])
            .send()
            .await
            .unwrap();
        assert!(download.status().is_success());
        assert_eq!(download.bytes().await.unwrap().as_ref(), bytes.as_slice());
        assert_eq!(
            client
                .get(format!(
                    "{}/api/relay/devices/{device}/api/terminal",
                    broker.url
                ))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!(
                    "{}/api/relay/devices/{device}/api/vault",
                    broker.url
                ))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "{}/api/terminal/{session}/ws?framed=1",
            proxy.replacen("http://", "ws://", 1)
        ))
        .await
        .unwrap();
        socket
            .send(tungstenite::Message::Text(
                json!({"type":"auth","token":local_token})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(8), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            !first.is_close(),
            "Relayed PTY closed before events: {first:?}"
        );
        socket
            .send(tungstenite::Message::Text(
                "echo RELAY_PTY_VERIFIED\r".into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                if String::from_utf8_lossy(message.into_data().as_ref())
                    .contains("RELAY_PTY_VERIFIED")
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let echo_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = echo_listener.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            let (mut stream, _) = echo_listener.accept().await.unwrap();
            let (mut reader, mut writer) = stream.split();
            let _ = tokio::io::copy(&mut reader, &mut writer).await;
        });
        let tunnel = json(
            client
                .post(format!("{}/api/tunnels", home.url))
                .bearer_auth(&local_token)
                .json(&json!({"environmentId":id,"targetPort":target_port}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let local_port = tunnel["localPort"].as_u64().unwrap() as u16;
        let mut tunnel_stream =
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, local_port))
                .await
                .unwrap();
        let payload = (0..256 * 1024).map(|n| (n % 251) as u8).collect::<Vec<_>>();
        let mut echoed = vec![0; payload.len()];
        tokio::time::timeout(Duration::from_secs(10), async {
            let (mut reader, mut writer) = tunnel_stream.split();
            let (write, read) =
                tokio::join!(writer.write_all(&payload), reader.read_exact(&mut echoed));
            write.unwrap();
            read.unwrap();
        })
        .await
        .unwrap();
        assert_eq!(echoed, payload);
        let grants = json(
            client
                .get(format!("{}/api/environments", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let grant = grants["grants"][0]["id"].as_str().unwrap();
        assert_eq!(
            client
                .delete(format!("{}/api/environments/grants/{grant}", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        tokio::time::timeout(Duration::from_secs(8), async {
            while let Some(message) = socket.next().await {
                if message.is_err() || message.unwrap().is_close() {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(8), tunnel_stream.read(&mut [0; 1]))
            .await
            .unwrap();
        assert!(
            closed.is_err() || closed.unwrap() == 0,
            "Grant revocation left the relayed TCP stream open"
        );
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, local_port))
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        echo_task.abort();
        let status = json(
            client
                .get(format!("{}/api/environments/{id}/status", home.url))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status["connected"], false);
        let _ = client
            .delete(format!("{}/api/terminal/{session}", target.url))
            .bearer_auth(token(&target, "remote-owner"))
            .send()
            .await;
        crate::remote_tunnels::shutdown(&home.state);
        crate::remote_tunnels::shutdown(&target.state);
        shutdown(&broker.state).await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while runtime(&target.state).connected.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(runtime(&broker.state).hosts.lock().unwrap().is_empty());
        shutdown(&target.state).await;
    }
    #[tokio::test]
    async fn broker_pins_registration_secret_and_rejects_shared_key_mismatch() {
        let broker = server().await;
        let key = "relay-key-for-device-registration-test-32";
        *runtime(&broker.state).server_key.lock().unwrap() = Some(key.into());
        let id = Uuid::new_v4().to_string();
        let url = format!(
            "{}/api/relay/hosts/{id}/register",
            broker.url.replacen("http://", "ws://", 1)
        );
        let (mut good, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        good.send(tungstenite::Message::Text(
            serde_json::to_string(&Control::Register {
                key: key.into(),
                secret: "a".repeat(64),
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
        let reply = good.next().await.unwrap().unwrap();
        assert!(matches!(
            serde_json::from_str::<Control>(reply.to_text().unwrap()),
            Ok(Control::Registered)
        ));
        for (supplied_key, secret) in [("incorrect", "a".repeat(64)), (key, "b".repeat(64))] {
            let (mut rejected, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            rejected
                .send(tungstenite::Message::Text(
                    serde_json::to_string(&Control::Register {
                        key: supplied_key.into(),
                        secret,
                    })
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(2), rejected.next())
                .await
                .unwrap();
            assert!(
                !reply.is_some_and(|r| r.is_ok_and(|m| m.to_text().is_ok_and(|t| matches!(
                    serde_json::from_str::<Control>(t),
                    Ok(Control::Registered)
                ))))
            );
        }
        good.close(None).await.unwrap();
        shutdown(&broker.state).await;
    }
}
