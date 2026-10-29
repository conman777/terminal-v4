use crate::{
    auth::{self, AuthenticatedUser},
    state::AppState,
    ApiError,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{delete, get},
    Extension, Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use uuid::Uuid;

const HALF_CLOSE_HEADER: &str = "x-terminal-v4-tcp-half-close";
const FRAME: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_LIFETIME: Duration = Duration::from_secs(8 * 3600);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tunnel {
    id: Uuid,
    environment_id: Uuid,
    target_port: u16,
    local_port: u16,
}
struct Entry {
    owner: String,
    view: Tunnel,
    stop: watch::Sender<bool>,
}
type Registry = HashMap<(PathBuf, Uuid), Entry>;
fn registry() -> &'static Mutex<Registry> {
    static ITEMS: OnceLock<Mutex<Registry>> = OnceLock::new();
    ITEMS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn target_stops() -> &'static Mutex<HashMap<PathBuf, watch::Sender<bool>>> {
    static STOPS: OnceLock<Mutex<HashMap<PathBuf, watch::Sender<bool>>>> = OnceLock::new();
    STOPS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn target_stop(state: &AppState) -> Result<watch::Receiver<bool>, ApiError> {
    let mut stops = target_stops()
        .lock()
        .map_err(|_| ApiError::internal("Tunnel shutdown registry unavailable"))?;
    Ok(stops
        .entry(state.config().data_dir.clone())
        .or_insert_with(|| watch::channel(false).0)
        .subscribe())
}
fn target_slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(64))).clone()
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tunnels", get(list).post(create))
        .route("/api/tunnels/{id}", delete(stop))
}
pub(crate) fn public_routes() -> Router<AppState> {
    Router::new().route("/api/tunnels/connect", get(connect))
}
pub(crate) fn shutdown(state: &AppState) {
    if let Ok(mut stops) = target_stops().lock() {
        if let Some(stop) = stops.remove(&state.config().data_dir) {
            let _ = stop.send(true);
        }
    }
    if let Ok(mut items) = registry().lock() {
        items.retain(|(path, _), entry| {
            if path == &state.config().data_dir {
                let _ = entry.stop.send(true);
                false
            } else {
                true
            }
        });
    }
}
fn validate_port(state: &AppState, port: u16) -> Result<(), ApiError> {
    if port == 0 || port == state.config().port {
        return Err(ApiError::bad_request(
            "Choose a service port other than the Terminal API port",
        ));
    }
    Ok(())
}
fn bearer(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Bearer authorization required".into(),
        })
}
fn direct_owner(
    state: &AppState,
    headers: &HeaderMap,
    user: &AuthenticatedUser,
) -> Result<String, ApiError> {
    let token = bearer(headers)?;
    let actual = crate::auth::authenticate_local_token(&state, &token).map_err(|_| ApiError {
        status: StatusCode::FORBIDDEN,
        message: "Manage tunnels from the home server with a direct login".into(),
    })?;
    if actual.user_id != user.user_id {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Tunnel owner mismatch".into(),
        });
    }
    Ok(token)
}
async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    direct_owner(&state, &headers, &user)?;
    let items = registry()
        .lock()
        .map_err(|_| ApiError::internal("Tunnel registry unavailable"))?;
    let views: Vec<_> = items
        .iter()
        .filter(|((path, _), e)| path == &state.config().data_dir && e.owner == user.user_id)
        .map(|(_, e)| e.view.clone())
        .collect();
    Ok(Json(serde_json::json!({"tunnels":views})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    environment_id: Uuid,
    target_port: u16,
    local_port: Option<u16>,
}
async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
    Json(input): Json<Create>,
) -> Result<Json<Tunnel>, ApiError> {
    let token = direct_owner(&state, &headers, &user)?;
    if input.target_port == 0 {
        return Err(ApiError::bad_request(
            "Remote service port must be between 1 and 65535",
        ));
    }
    if input.local_port == Some(0) {
        return Err(ApiError::bad_request(
            "Omit localPort to choose an available port",
        ));
    }
    let (origin, credential) = crate::paired_environments::tunnel_destination(
        &state,
        &user,
        &input.environment_id.to_string(),
    )?;
    if !remote_live(&origin, &credential).await {
        return Err(ApiError::bad_request(
            "Remote device is offline or its grant was revoked",
        ));
    }
    let listener =
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, input.local_port.unwrap_or(0)))
            .await
            .map_err(|_| ApiError::bad_request("Home local port is unavailable"))?;
    let view = Tunnel {
        id: Uuid::new_v4(),
        environment_id: input.environment_id,
        target_port: input.target_port,
        local_port: listener
            .local_addr()
            .map_err(|_| ApiError::internal("Unable to inspect local port"))?
            .port(),
    };
    let (stop, receiver) = watch::channel(false);
    {
        let mut items = registry()
            .lock()
            .map_err(|_| ApiError::internal("Tunnel registry unavailable"))?;
        if items
            .iter()
            .filter(|((path, _), e)| path == &state.config().data_dir && e.owner == user.user_id)
            .count()
            >= 8
        {
            return Err(ApiError::bad_request(
                "Stop an existing tunnel before opening more than eight",
            ));
        }
        items.insert(
            (state.config().data_dir.clone(), view.id),
            Entry {
                owner: user.user_id.clone(),
                view: view.clone(),
                stop: stop.clone(),
            },
        );
    }
    let task_view = view.clone();
    tokio::spawn(async move {
        run_listener(
            state, user, token, origin, credential, task_view, listener, stop, receiver,
        )
        .await;
    });
    Ok(Json(view))
}
async fn stop(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    direct_owner(&state, &headers, &user)?;
    let mut items = registry()
        .lock()
        .map_err(|_| ApiError::internal("Tunnel registry unavailable"))?;
    let key = (state.config().data_dir.clone(), id);
    if items.get(&key).is_none_or(|e| e.owner != user.user_id) {
        return Err(ApiError::not_found("Tunnel not found"));
    }
    if let Some(entry) = items.remove(&key) {
        let _ = entry.stop.send(true);
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn remote_live(origin: &str, credential: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    client
        .get(format!("{origin}/api/environments/check"))
        .bearer_auth(credential)
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}
#[allow(clippy::too_many_arguments)]
async fn run_listener(
    state: AppState,
    user: AuthenticatedUser,
    token: String,
    origin: String,
    credential: String,
    view: Tunnel,
    listener: TcpListener,
    stop: watch::Sender<bool>,
    mut receiver: watch::Receiver<bool>,
) {
    let slots = Arc::new(Semaphore::new(16));
    let mut heartbeat = tokio::time::interval(IO_TIMEOUT);
    let deadline = tokio::time::sleep(MAX_LIFETIME);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
        _=&mut deadline=>break,
        _=receiver.changed()=>break,
        _=heartbeat.tick()=>{
         let valid=crate::auth::authenticate_local_token(&state,&token).is_ok() && crate::paired_environments::tunnel_destination(&state,&user,&view.environment_id.to_string()).is_ok_and(|(url,key)|url==origin&&key==credential);
         if !valid || !remote_live(&origin,&credential).await {break;}
        },
        accepted=listener.accept()=>{let Ok((stream,_))=accepted else{break;};let Ok(permit)=slots.clone().try_acquire_owned() else{drop(stream);continue;};let url=origin.clone();let key=credential.clone();let rx=receiver.clone();let port=view.target_port;tokio::spawn(async move{let _permit=permit;forward(stream,&url,&key,port,rx).await;});}
        }
    }
    let _ = stop.send(true);
    if let Ok(mut items) = registry().lock() {
        items.remove(&(state.config().data_dir.clone(), view.id));
    }
}
async fn forward(
    mut stream: TcpStream,
    origin: &str,
    credential: &str,
    port: u16,
    mut stop: watch::Receiver<bool>,
) {
    let Ok(mut url) = url::Url::parse(origin) else {
        return;
    };
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    if url.set_scheme(scheme).is_err() {
        return;
    }
    let path = format!("{}/api/tunnels/connect", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url.set_query(Some(&format!("targetPort={port}")));
    let Ok(mut request) = url.as_str().into_client_request() else {
        return;
    };
    let Ok(header) = format!("Bearer {credential}").parse() else {
        return;
    };
    request.headers_mut().insert("authorization", header);
    request
        .headers_mut()
        .insert(HALF_CLOSE_HEADER, "1".parse().unwrap());
    let connected = tokio::select! {_=stop.changed()=>return,result=tokio::time::timeout(Duration::from_secs(5),tokio_tungstenite::connect_async(request))=>result};
    let Ok(Ok((mut socket, response))) = connected else {
        return;
    };
    let half_close = response
        .headers()
        .get(HALF_CLOSE_HEADER)
        .is_some_and(|v| v == "1");
    let mut reading = true;
    let mut writing = true;
    let mut bytes = vec![0; FRAME];
    while reading || writing {
        tokio::select! {
        _=stop.changed()=>break,
        read=stream.read(&mut bytes), if reading=>match read {
            Ok(0) if half_close=>{reading=false;if !matches!(tokio::time::timeout(IO_TIMEOUT,socket.send(tungstenite::Message::Binary(Vec::new().into()))).await,Ok(Ok(()))){break;}},
            Ok(0)|Err(_)=>break,Ok(size)=>{if !matches!(tokio::time::timeout(IO_TIMEOUT,socket.send(tungstenite::Message::Binary(bytes[..size].to_vec().into()))).await,Ok(Ok(()))){break;}}},
        incoming=socket.next()=>match incoming {Some(Ok(tungstenite::Message::Binary(body))) if half_close && body.is_empty() && writing=>{writing=false;if !matches!(tokio::time::timeout(IO_TIMEOUT,stream.shutdown()).await,Ok(Ok(()))){break;}},
        Some(Ok(tungstenite::Message::Binary(body))) if writing && body.len()<=FRAME=>{if !matches!(tokio::time::timeout(IO_TIMEOUT,stream.write_all(&body)).await,Ok(Ok(()))){break;}},Some(Ok(tungstenite::Message::Ping(body)))=>{if !matches!(tokio::time::timeout(IO_TIMEOUT,socket.send(tungstenite::Message::Pong(body))).await,Ok(Ok(()))){break;}},Some(Ok(tungstenite::Message::Pong(_)))=>{},_=>break}
        }
    }
    let _ = stream.shutdown().await;
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connect {
    target_port: u16,
}
async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<Connect>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    validate_port(&state, input.target_port)?;
    let token = bearer(&headers)?;
    auth::authenticate_runtime_request(&state, &token, "GET", "/api/tunnels/connect").map_err(
        |_| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "A valid Service tunnels grant is required".into(),
        },
    )?;
    let permit = target_slots()
        .try_acquire_owned()
        .map_err(|_| ApiError::bad_request("Tunnel connection limit reached"))?;
    let stream = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, input.target_port)),
    )
    .await
    .map_err(|_| ApiError::bad_request("Remote service timed out"))?
    .map_err(|_| ApiError::bad_request("Remote service is unavailable"))?;
    let stop = target_stop(&state)?;
    let half_close = headers.get(HALF_CLOSE_HEADER).is_some_and(|v| v == "1");
    let mut response = upgrade
        .max_frame_size(FRAME)
        .max_message_size(FRAME)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            serve_stream(state, token, socket, stream, stop, half_close).await;
        });
    if half_close {
        response
            .headers_mut()
            .insert(HALF_CLOSE_HEADER, "1".parse().unwrap());
    }
    Ok(response)
}
async fn serve_stream(
    state: AppState,
    token: String,
    mut socket: WebSocket,
    mut stream: TcpStream,
    mut stop: watch::Receiver<bool>,
    half_close: bool,
) {
    let mut reading = true;
    let mut writing = true;
    let mut bytes = vec![0; FRAME];
    let mut heartbeat = tokio::time::interval(IO_TIMEOUT);
    let deadline = tokio::time::sleep(MAX_LIFETIME);
    tokio::pin!(deadline);
    while reading || writing {
        tokio::select! {
        _=&mut deadline=>break,
        _=stop.changed()=>break,
        _=heartbeat.tick()=>if auth::authenticate_runtime_request(&state,&token,"GET","/api/tunnels/connect").is_err(){break;},
        read=stream.read(&mut bytes), if reading=>match read{
            Ok(0) if half_close=>{reading=false;if !matches!(tokio::time::timeout(IO_TIMEOUT,socket.send(Message::Binary(Vec::new().into()))).await,Ok(Ok(()))){break;}},
            Ok(0)|Err(_)=>break,Ok(size)=>{if !matches!(tokio::time::timeout(IO_TIMEOUT,socket.send(Message::Binary(bytes[..size].to_vec().into()))).await,Ok(Ok(()))){break;}}},
        incoming=socket.next()=>match incoming{Some(Ok(Message::Binary(body))) if half_close && body.is_empty() && writing=>{writing=false;if !matches!(tokio::time::timeout(IO_TIMEOUT,stream.shutdown()).await,Ok(Ok(()))){break;}},
        Some(Ok(Message::Binary(body))) if writing && body.len()<=FRAME=>{if !matches!(tokio::time::timeout(IO_TIMEOUT,stream.write_all(&body)).await,Ok(Ok(()))){break;}},Some(Ok(Message::Ping(body)))=>{if !matches!(tokio::time::timeout(IO_TIMEOUT,socket.send(Message::Pong(body))).await,Ok(Ok(()))){break;}},Some(Ok(Message::Pong(_)))=>{},_=>break}
        }
    }
    let _ = stream.shutdown().await;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tunnel_ports_reject_api_and_zero_but_allow_services() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: dir.path().into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(validate_port(&state, 0).is_err());
        assert!(validate_port(&state, state.config().port).is_err());
        assert!(validate_port(&state, 5432).is_ok());
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use serde_json::{json, Value};
    struct Server {
        state: AppState,
        _directory: tempfile::TempDir,
        url: String,
        handle: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            shutdown(&self.state);
            self.handle.abort();
        }
    }
    async fn server() -> Server {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: directory.path().into(),
                port,
                jwt_secret: Uuid::new_v4().to_string(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let app = crate::app(state.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Server {
            state,
            _directory: directory,
            url: format!("http://127.0.0.1:{port}"),
            handle,
        }
    }
    fn token(server: &Server, owner: &str) -> String {
        auth::issue_access_token(&server.state.config().jwt_secret, owner, owner)
    }
    async fn value(response: reqwest::Response) -> Value {
        let status = response.status();
        let text = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {text}");
        serde_json::from_str(&text).unwrap()
    }
    async fn pair(
        client: &reqwest::Client,
        home: &Server,
        target: &Server,
        tunnels: bool,
    ) -> Value {
        let code=value(client.post(format!("{}/api/environments/pairing-code",target.url)).bearer_auth(token(target,"remote-owner")).json(&json!({"label":"Tunnel test","profile":"custom","capabilities":{"tunnels":tunnels}})).send().await.unwrap()).await;
        value(
            client
                .post(format!("{}/api/environments/connect", home.url))
                .bearer_auth(token(home, "owner"))
                .json(&json!({"url":target.url,"code":code["code"],"label":"Remote"}))
                .send()
                .await
                .unwrap(),
        )
        .await
    }
    #[tokio::test]
    async fn tcp_half_close_preserves_eof_delimited_response() {
        let home = server().await;
        let target = server().await;
        let client = reqwest::Client::new();
        let environment = pair(&client, &home, &target, true).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = listener.local_addr().unwrap().port();
        let service = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            assert_eq!(request, b"request until EOF");
            stream.write_all(b"response after EOF").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let tunnel = value(
            client
                .post(format!("{}/api/tunnels", home.url))
                .bearer_auth(token(&home, "owner"))
                .json(&json!({"environmentId":environment["id"],"targetPort":target_port}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let mut stream = TcpStream::connect((
            std::net::Ipv4Addr::LOCALHOST,
            tunnel["localPort"].as_u64().unwrap() as u16,
        ))
        .await
        .unwrap();
        stream.write_all(b"request until EOF").await.unwrap();
        stream.shutdown().await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        service.await.unwrap();
        assert_eq!(response, b"response after EOF");
    }
    #[tokio::test]
    async fn tcp_binary_forward_is_owner_scoped_and_revocation_closes_streams_and_listener() {
        let home = server().await;
        let target = server().await;
        let client = reqwest::Client::new();
        let environment = pair(&client, &home, &target, true).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = listener.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let (mut read, mut write) = stream.split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });
        let tunnel = value(
            client
                .post(format!("{}/api/tunnels", home.url))
                .bearer_auth(token(&home, "owner"))
                .json(&json!({"environmentId":environment["id"],"targetPort":target_port}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let (_, paired_credential) = crate::paired_environments::tunnel_destination(
            &home.state,
            &AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            },
            environment["id"].as_str().unwrap(),
        )
        .unwrap();
        let denied_nested_listener = client
            .get(format!("{}/api/tunnels", target.url))
            .bearer_auth(paired_credential)
            .send()
            .await
            .unwrap();
        assert_eq!(denied_nested_listener.status(), StatusCode::FORBIDDEN);
        assert!(!tunnel.to_string().contains("credential"));
        let local = tunnel["localPort"].as_u64().unwrap() as u16;
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, local))
            .await
            .unwrap();
        let payload: Vec<u8> = (0..384 * 1024).map(|i| (i % 251) as u8).collect();
        let expected = payload.clone();
        let (mut read, mut write) = stream.split();
        let write_task = async {
            write.write_all(&payload).await.unwrap();
        };
        let mut output = vec![0; expected.len()];
        let read_task = async {
            read.read_exact(&mut output).await.unwrap();
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(write_task, read_task);
        })
        .await
        .unwrap();
        assert_eq!(output, expected);
        let hidden = value(
            client
                .get(format!("{}/api/tunnels", home.url))
                .bearer_auth(token(&home, "other"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(hidden, json!({"tunnels":[]}));
        assert_eq!(
            client
                .delete(format!(
                    "{}/api/tunnels/{}",
                    home.url,
                    tunnel["id"].as_str().unwrap()
                ))
                .bearer_auth(token(&home, "other"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let grants = value(
            client
                .get(format!("{}/api/environments", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let grant = grants["grants"][0]["id"].as_str().unwrap();
        assert!(client
            .delete(format!("{}/api/environments/grants/{grant}", target.url))
            .bearer_auth(token(&target, "remote-owner"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        let mut end = [0];
        let closed = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut end))
            .await
            .unwrap();
        assert!(closed.is_err() || closed.unwrap() == 0);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, local))
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap();
        echo.abort();
    }
    #[tokio::test]
    async fn tunnel_grant_is_explicit_and_terminal_api_port_cannot_be_targeted() {
        let home = server().await;
        let target = server().await;
        let client = reqwest::Client::new();
        let environment = pair(&client, &home, &target, false).await;
        let denied = client
            .post(format!("{}/api/tunnels", home.url))
            .bearer_auth(token(&home, "owner"))
            .json(&json!({"environmentId":environment["id"],"targetPort":5432}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let mut url = url::Url::parse(&target.url).unwrap();
        url.set_scheme("ws").unwrap();
        let path = format!("{}/api/tunnels/connect", url.path().trim_end_matches('/'));
        url.set_path(&path);
        url.set_query(Some(&format!("targetPort={}", target.state.config().port)));
        let mut request = url.as_str().into_client_request().unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", token(&target, "remote-owner"))
                .parse()
                .unwrap(),
        );
        let error = tokio_tungstenite::connect_async(request).await.unwrap_err();
        match error {
            tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::BAD_REQUEST)
            }
            other => panic!("{other}"),
        }
    }
}
