use crate::{
    auth::{self, AuthenticatedUser},
    remote_permissions::Capabilities,
    state::{AppState, HistoryQuery},
    terminal::TerminalSubscriptionEvent,
    ApiError,
};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/collaboration/invitations", get(list).post(create))
        .route(
            "/api/collaboration/invitations/{id}",
            axum::routing::delete(revoke),
        )
}
pub(crate) fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/collaboration/guest/exchange", post(exchange))
        .route("/api/collaboration/guest/{session}/history", get(history))
        .route("/api/collaboration/guest/{session}/ws", get(upgrade))
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
fn secret() -> String {
    let mut b = [0; 32];
    rand::rng().fill_bytes(&mut b);
    hex::encode(b)
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn denied() -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Guest access is invalid, expired, or revoked".into(),
    }
}
fn db(state: &AppState) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, ApiError> {
    let connection = state.lock_db().map_err(ApiError::internal)?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS collaboration_invitations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,workspace TEXT NOT NULL,session TEXT NOT NULL,role TEXT NOT NULL,hash TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,max_uses INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked INTEGER);CREATE TABLE IF NOT EXISTS collaboration_guests(id TEXT PRIMARY KEY,invitation TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,joined INTEGER NOT NULL,last_seen INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS collaboration_guest_invitation ON collaboration_guests(invitation);").map_err(|_|ApiError::internal("Collaboration storage unavailable"))?;
    Ok(connection)
}
fn owner(state: &AppState, headers: &HeaderMap) -> Result<AuthenticatedUser, ApiError> {
    let credential = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(denied)?;
    auth::authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        credential,
    )
    .map_err(|_| denied())
}
fn workspace(value: &str) -> Result<String, ApiError> {
    let path = std::fs::canonicalize(value)
        .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    Ok(path.to_string_lossy().into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    workspace_path: String,
    session_id: String,
    role: String,
    expires_in_seconds: i64,
    max_uses: i64,
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Create>,
) -> Result<Json<Value>, ApiError> {
    let owner = owner(&state, &headers)?;
    if !matches!(body.role.as_str(), "observer" | "controller")
        || !(60..=86400).contains(&body.expires_in_seconds)
        || !(1..=8).contains(&body.max_uses)
    {
        return Err(ApiError::bad_request(
            "Choose observer/controller access, expiry 1 minute to 24 hours, and 1 to 8 guests",
        ));
    }
    let path = workspace(&body.workspace_path)?;
    let selected = state
        .terminal_manager()
        .list_sessions(&owner.user_id)
        .await
        .map_err(ApiError::internal)?
        .into_iter()
        .find(|s| s.id == body.session_id)
        .ok_or_else(|| ApiError::not_found("Terminal session not found"))?;
    if workspace(&selected.cwd)? != path || !selected.is_active {
        return Err(ApiError::bad_request(
            "Select an active terminal in this workspace",
        ));
    }
    let connection = db(&state)?;
    let active:i64=connection.query_row("SELECT COUNT(*) FROM collaboration_invitations WHERE owner=?1 AND revoked IS NULL AND expires>?2",params![owner.user_id,now()],|r|r.get(0)).map_err(|_|ApiError::internal("Invitation lookup failed"))?;
    if active >= 100 {
        return Err(ApiError::bad_request(
            "Revoke an existing invitation before creating another",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let secret = secret();
    let expires = now() + body.expires_in_seconds;
    connection.execute("INSERT INTO collaboration_invitations(id,owner,workspace,session,role,hash,created,expires,max_uses) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,owner.user_id,path,body.session_id,body.role,hash(&secret),now(),expires,body.max_uses]).map_err(|_|ApiError::internal("Invitation could not be saved"))?;
    Ok(Json(
        json!({"id":id,"secret":secret,"expiresAt":expires,"role":body.role,"sessionId":body.session_id,"maxUses":body.max_uses}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    workspace_path: Option<String>,
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let owner = owner(&state, &headers)?;
    let path = query
        .workspace_path
        .filter(|p| !p.is_empty())
        .map(|p| workspace(&p))
        .transpose()?;
    let connection = db(&state)?;
    let mut statement=connection.prepare("SELECT id,workspace,session,role,created,expires,max_uses,uses,revoked FROM collaboration_invitations WHERE owner=?1 AND (?2 IS NULL OR workspace=?2) ORDER BY created DESC LIMIT 200").map_err(|_|ApiError::internal("Invitation audit unavailable"))?;
    let rows=statement.query_map(params![owner.user_id,path],|row|Ok(json!({"id":row.get::<_,String>(0)?,"workspacePath":row.get::<_,String>(1)?,"sessionId":row.get::<_,String>(2)?,"role":row.get::<_,String>(3)?,"createdAt":row.get::<_,i64>(4)?,"expiresAt":row.get::<_,i64>(5)?,"maxUses":row.get::<_,i64>(6)?,"uses":row.get::<_,i64>(7)?,"revokedAt":row.get::<_,Option<i64>>(8)?}))).map_err(|_|ApiError::internal("Invitation audit unavailable"))?;
    let mut items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ApiError::internal("Invitation audit unavailable"))?;
    for item in &mut items {
        let mut guests=connection.prepare("SELECT id,name,joined,last_seen FROM collaboration_guests WHERE invitation=?1 ORDER BY joined").map_err(|_|ApiError::internal("Participant audit unavailable"))?;
        let participants=guests.query_map([item["id"].as_str().unwrap_or_default()],|row|Ok(json!({"id":row.get::<_,String>(0)?,"displayName":row.get::<_,String>(1)?,"joinedAt":row.get::<_,i64>(2)?,"lastSeenAt":row.get::<_,i64>(3)?}))).map_err(|_|ApiError::internal("Participant audit unavailable"))?.collect::<Result<Vec<_>,_>>().map_err(|_|ApiError::internal("Participant audit unavailable"))?;
        item["participants"] = json!(participants);
    }
    Ok(Json(json!({"invitations":items})))
}
async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let owner = owner(&state, &headers)?;
    if db(&state)?.execute("UPDATE collaboration_invitations SET revoked=COALESCE(revoked,?1) WHERE id=?2 AND owner=?3",params![now(),id,owner.user_id]).map_err(|_|ApiError::internal("Invitation revocation failed"))?==0{return Err(ApiError::not_found("Invitation not found"));}
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exchange {
    id: String,
    secret: String,
    display_name: String,
}
async fn exchange(
    State(state): State<AppState>,
    Json(body): Json<Exchange>,
) -> Result<Json<Value>, ApiError> {
    if body.id.len() > 64
        || body.secret.len() != 64
        || body.display_name.trim().is_empty()
        || body.display_name.chars().count() > 80
        || body.display_name.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request("Invalid invitation or guest name"));
    }
    let mut connection = db(&state)?;
    let transaction = connection
        .transaction()
        .map_err(|_| ApiError::internal("Invitation exchange unavailable"))?;
    let found=transaction.query_row("SELECT session,role,expires,uses,max_uses FROM collaboration_invitations WHERE id=?1 AND hash=?2 AND expires>?3 AND revoked IS NULL",params![body.id,hash(&body.secret),now()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?,row.get::<_,i64>(4)?))).optional().map_err(|_|ApiError::internal("Invitation lookup unavailable"))?.ok_or_else(denied)?;
    if found.3 >= found.4 {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: "Invitation guest limit reached".into(),
        });
    }
    let credential = format!("tv4guest.{}", secret());
    let guest_id = uuid::Uuid::new_v4().to_string();
    transaction
        .execute(
            "UPDATE collaboration_invitations SET uses=uses+1 WHERE id=?1",
            [&body.id],
        )
        .map_err(|_| ApiError::internal("Invitation exchange unavailable"))?;
    transaction.execute("INSERT INTO collaboration_guests(id,invitation,hash,name,joined,last_seen) VALUES (?1,?2,?3,?4,?5,?5)",params![guest_id,body.id,hash(&credential),body.display_name.trim(),now()]).map_err(|_|ApiError::internal("Participant could not be saved"))?;
    transaction
        .commit()
        .map_err(|_| ApiError::internal("Invitation exchange unavailable"))?;
    Ok(Json(
        json!({"credential":credential,"sessionId":found.0,"role":found.1,"expiresAt":found.2,"participantId":guest_id}),
    ))
}
#[derive(Clone)]
struct Guest {
    id: String,
    owner: String,
    session: String,
    role: String,
}
fn authorize(state: &AppState, credential: &str, session: &str) -> Result<Guest, ApiError> {
    if !credential.starts_with("tv4guest.") || credential.len() != 73 {
        return Err(denied());
    }
    let connection = db(state)?;
    let guest=connection.query_row("SELECT g.id,i.owner,i.session,i.role FROM collaboration_guests g JOIN collaboration_invitations i ON g.invitation=i.id WHERE g.hash=?1 AND i.session=?2 AND i.expires>?3 AND i.revoked IS NULL",params![hash(credential),session,now()],|row|Ok(Guest{id:row.get(0)?,owner:row.get(1)?,session:row.get(2)?,role:row.get(3)?})).optional().map_err(|_|ApiError::internal("Guest authorization unavailable"))?.ok_or_else(denied)?;
    connection
        .execute(
            "UPDATE collaboration_guests SET last_seen=?1 WHERE id=?2 AND last_seen<?3",
            params![now(), guest.id, now() - 5],
        )
        .map_err(|_| ApiError::internal("Guest audit unavailable"))?;
    Ok(guest)
}
fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(denied)
}
async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let guest = authorize(&state, bearer(&headers)?, &session)?;
    let snapshot = state
        .terminal_manager()
        .get_session_history(
            &guest.owner,
            &guest.session,
            &HistoryQuery {
                max_history_chars: Some(500000),
                max_history_events: Some(1000),
                ..Default::default()
            },
        )
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("Shared terminal no longer exists"))?;
    Ok(Json(
        json!({"id":session,"title":snapshot.title,"history":snapshot.history}),
    ))
}
async fn upgrade(
    State(state): State<AppState>,
    Path(session): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.max_message_size(70000)
        .on_upgrade(move |socket| socket_session(state, session, socket))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SocketAuth {
    #[serde(rename = "type")]
    kind: String,
    credential: String,
}
async fn frame(socket: &mut WebSocket, message: Message) -> Result<(), ()> {
    tokio::time::timeout(Duration::from_secs(2), socket.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}
async fn send(socket: &mut WebSocket, value: Value) -> Result<(), ()> {
    frame(socket, Message::Text(value.to_string().into())).await
}
async fn socket_session(state: AppState, session: String, mut socket: WebSocket) {
    let credential = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<SocketAuth>(&text)
            .ok()
            .filter(|v| v.kind == "auth")
            .map(|v| v.credential),
        _ => None,
    };
    let Some(credential) = credential else {
        let _ = frame(&mut socket, Message::Close(None)).await;
        return;
    };
    let Ok(guest) = authorize(&state, &credential, &session) else {
        let _ = frame(
            &mut socket,
            Message::Close(Some(CloseFrame {
                code: 4401,
                reason: "Invitation expired or revoked".into(),
            })),
        )
        .await;
        return;
    };
    stream(&state, &credential, &guest, &mut socket).await;
    let _ = frame(&mut socket, Message::Close(None)).await;
}
async fn stream(state: &AppState, credential: &str, guest: &Guest, socket: &mut WebSocket) {
    let terminal = state.terminal_manager();
    let Ok(mut receiver) = terminal.subscribe(&guest.owner, &guest.session).await else {
        return;
    };
    let Ok(Some(snapshot)) = terminal
        .get_session_history(
            &guest.owner,
            &guest.session,
            &HistoryQuery {
                max_history_chars: Some(500000),
                max_history_events: Some(1000),
                ..Default::default()
            },
        )
        .await
    else {
        return;
    };
    if send(socket, json!({"type":"ready","role":guest.role}))
        .await
        .is_err()
    {
        return;
    }
    let mut cursor = 0;
    for item in snapshot.history {
        cursor = cursor.max(item.seq.unwrap_or(0));
        if send(socket, json!({"type":"output","text":item.text}))
            .await
            .is_err()
        {
            return;
        }
    }
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                if authorize(state, credential, &guest.session).is_err() {
                    let _ = frame(socket, Message::Close(Some(CloseFrame {
                        code: 4401,
                        reason: "Invitation expired or revoked".into(),
                    }))).await;
                    break;
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(message) = serde_json::from_str::<Value>(&text) else {
                        break;
                    };
                    let kind = message["type"].as_str().unwrap_or_default();
                    let mut caps = Capabilities::observer();
                    caps.terminal_input = guest.role == "controller";
                    if authorize(state, credential, &guest.session).is_err() {
                        break;
                    }
                    if !caps.allows_terminal_message(kind) || !matches!(kind, "ping" | "input") {
                        let _ = send(socket, json!({
                            "type": "error",
                            "error": "Guest cannot perform this action",
                        })).await;
                        break;
                    }
                    if kind == "input" {
                        let Some(input) = message["text"].as_str().filter(|v| v.len() <= 65536) else {
                            break;
                        };
                        if terminal.write(&guest.owner, &guest.session, input).await.is_err() {
                            break;
                        }
                    } else if send(socket, json!({"type": "pong"})).await.is_err() {
                        break;
                    }
                },
                Some(Ok(Message::Ping(bytes))) => {
                    if frame(socket, Message::Pong(bytes)).await.is_err() {
                        break;
                    }
                },
                Some(Ok(Message::Pong(_))) => {},
                _ => break,
            },
            event = receiver.recv() => match event {
                Ok(TerminalSubscriptionEvent::Output(item)) => {
                    if item.seq.is_some_and(|seq| seq <= cursor) {
                        continue;
                    }
                    cursor = cursor.max(item.seq.unwrap_or(0));
                    if authorize(state, credential, &guest.session).is_err() {
                        break;
                    }
                    if send(socket, json!({"type": "output", "text": item.text})).await.is_err() {
                        break;
                    }
                },
                _ => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use terminal_v4_core::AppConfig;
    struct ServerGuard {
        state: AppState,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for ServerGuard {
        fn drop(&mut self) {
            self.task.abort();
            let state = self.state.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    if let Ok(sessions) = state.terminal_manager().list_sessions("owner").await {
                        for session in sessions {
                            let _ = state.terminal_manager().close("owner", &session.id).await;
                        }
                    }
                });
            }
        }
    }
    async fn fixture() -> (AppState, tempfile::TempDir, String, ServerGuard) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new_with_external_auth(
            AppConfig {
                data_dir: dir.path().into(),
                jwt_secret: uuid::Uuid::new_v4().to_string(),
                ..AppConfig::default()
            },
            None,
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = crate::app(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let guard = ServerGuard {
            state: state.clone(),
            task,
        };
        (state, dir, url, guard)
    }
    fn jwt(state: &AppState, owner: &str) -> String {
        crate::auth::issue_access_token(&state.config().jwt_secret, owner, owner)
    }
    async fn terminal(state: &AppState, path: &std::path::Path) -> String {
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            state.terminal_manager().create_session(
                "owner",
                crate::terminal::TerminalCreateOptions {
                    cwd: Some(path.to_string_lossy().into()),
                    title: Some("Shared terminal".into()),
                    shell: None,
                    cols: None,
                    rows: None,
                    sandbox_mode: None,
                    sandbox_workspace_root: None,
                    initial_command: None,
                },
            ),
        )
        .await
        .expect("PTY startup timed out")
        .unwrap()
        .id
    }
    async fn body(response: reqwest::Response) -> Value {
        let status = response.status();
        let body = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        serde_json::from_str(&body).unwrap()
    }
    #[tokio::test]
    async fn invitation_is_single_use_session_scoped_and_revocation_closes_live_socket() {
        use futures_util::{FutureExt, SinkExt, StreamExt};
        let (state, dir, url, task) = fixture().await;
        let outcome=std::panic::AssertUnwindSafe(async {
        let session = terminal(&state, dir.path()).await;
        let other = terminal(&state, dir.path()).await;
        let client = reqwest::Client::builder().no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let issued=body(client.post(format!("{url}/api/collaboration/invitations")).bearer_auth(jwt(&state,"owner")).json(&json!({"workspacePath":dir.path(),"sessionId":session,"role":"observer","expiresInSeconds":600,"maxUses":1})).send().await.unwrap()).await;
        let id = issued["id"].as_str().unwrap();
        let exchange = json!({"id":id,"secret":issued["secret"],"displayName":"Visitor"});
        let guest = body(
            client
                .post(format!("{url}/api/collaboration/guest/exchange"))
                .json(&exchange)
                .send()
                .await
                .unwrap(),
        )
        .await;
        let credential = guest["credential"].as_str().unwrap();
        assert_eq!(
            client
                .post(format!("{url}/api/collaboration/guest/exchange"))
                .json(&exchange)
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        assert_eq!(
            client
                .get(format!("{url}/api/terminal/{session}/history"))
                .bearer_auth(credential)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(format!("{url}/api/collaboration/guest/{other}/history"))
                .bearer_auth(credential)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let history = body(
            client
                .get(format!("{url}/api/collaboration/guest/{session}/history"))
                .bearer_auth(credential)
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(history["id"], session);
        assert_eq!(
            client
                .get(format!("{url}/api/collaboration/invitations"))
                .bearer_auth(jwt(&state, "stranger"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "{}/api/collaboration/guest/{session}/ws",
            url.replace("http://", "ws://")
        ))
        .await
        .unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"type":"auth","credential":credential})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let first = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(first.is_text());
        let audit = body(
            client
                .get(format!(
                    "{url}/api/collaboration/invitations?workspacePath={}",
                    dir.path().to_string_lossy()
                ))
                .bearer_auth(jwt(&state, "owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            audit["invitations"][0]["participants"][0]["displayName"],
            "Visitor"
        );
        assert!(!audit.to_string().contains(credential));
        assert_eq!(
            client
                .delete(format!("{url}/api/collaboration/invitations/{id}"))
                .bearer_auth(jwt(&state, "stranger"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .delete(format!("{url}/api/collaboration/invitations/{id}"))
                .bearer_auth(jwt(&state, "owner"))
                .send()
                .await
                .unwrap()
                .status(),
            204
        );
        let closed = tokio::time::timeout(std::time::Duration::from_secs(4), async {
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap();
        assert!(closed);
        assert_eq!(
            client
                .get(format!("{url}/api/collaboration/guest/{session}/history"))
                .bearer_auth(credential)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        state
            .terminal_manager()
            .close("owner", &session)
            .await
            .unwrap();
        state
            .terminal_manager()
            .close("owner", &other)
            .await
            .unwrap();
        }).catch_unwind().await;
        if let Ok(sessions) = state.terminal_manager().list_sessions("owner").await {
            for session in sessions {
                let _ = state.terminal_manager().close("owner", &session.id).await;
            }
        }
        task.task.abort();
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    }

    #[tokio::test]
    async fn controller_input_and_observer_denial_are_checked_live_and_expiry_invalidates_tokens() {
        use futures_util::{FutureExt, SinkExt, StreamExt};
        let (state, dir, url, task) = fixture().await;
        let outcome=std::panic::AssertUnwindSafe(async {
  let session=terminal(&state,dir.path()).await;
  let client=reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap();
  let mut credentials=Vec::new();
  for role in ["controller","observer"] {
   let issued=body(client.post(format!("{url}/api/collaboration/invitations")).bearer_auth(jwt(&state,"owner")).json(&json!({"workspacePath":dir.path(),"sessionId":session,"role":role,"expiresInSeconds":600,"maxUses":1})).send().await.unwrap()).await;
   let guest=body(client.post(format!("{url}/api/collaboration/guest/exchange")).json(&json!({"id":issued["id"],"secret":issued["secret"],"displayName":role})).send().await.unwrap()).await;
   credentials.push((issued["id"].as_str().unwrap().to_string(),guest["credential"].as_str().unwrap().to_string()));
  }
  let endpoint=format!("{}/api/collaboration/guest/{session}/ws",url.replace("http://","ws://"));
  let (mut controller,_)=tokio::time::timeout(Duration::from_secs(5),tokio_tungstenite::connect_async(&endpoint)).await.unwrap().unwrap();
  controller.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"auth","credential":credentials[0].1}).to_string().into())).await.unwrap();
  let ready=tokio::time::timeout(Duration::from_secs(3),controller.next()).await.unwrap().unwrap().unwrap();assert!(ready.is_text());
  controller.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"input","text":"echo COLLABORATION_INPUT_MARKER\r"}).to_string().into())).await.unwrap();
  let output=tokio::time::timeout(std::time::Duration::from_secs(15),async{let mut output=String::new();while let Some(Ok(message))=controller.next().await{if let Ok(text)=message.to_text(){let event:Value=serde_json::from_str(text).unwrap();output.push_str(event["text"].as_str().unwrap_or_default());if output.contains("COLLABORATION_INPUT_MARKER"){return output;}}}output}).await.unwrap();
  assert!(output.contains("COLLABORATION_INPUT_MARKER"));
  let (mut observer,_)=tokio::time::timeout(Duration::from_secs(5),tokio_tungstenite::connect_async(&endpoint)).await.unwrap().unwrap();
  observer.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"auth","credential":credentials[1].1}).to_string().into())).await.unwrap();
  let _=tokio::time::timeout(Duration::from_secs(3),observer.next()).await.unwrap().unwrap().unwrap();
  observer.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"input","text":"echo FORBIDDEN_GUEST_INPUT\r"}).to_string().into())).await.unwrap();
  let denied=tokio::time::timeout(std::time::Duration::from_secs(3),async{while let Some(Ok(message))=observer.next().await{if let Ok(text)=message.to_text(){let event:Value=serde_json::from_str(text).unwrap();if event["type"]=="error"{return event["error"].as_str().unwrap().to_string();}}}String::new()}).await.unwrap();
  assert_eq!(denied,"Guest cannot perform this action");
  state.lock_db().unwrap().execute("UPDATE collaboration_invitations SET expires=0 WHERE id=?1",[&credentials[0].0]).unwrap();
  let closed=tokio::time::timeout(std::time::Duration::from_secs(3),async{while let Some(Ok(message))=controller.next().await{if message.is_close(){return true;}}false}).await.unwrap();assert!(closed);
  assert_eq!(client.get(format!("{url}/api/collaboration/guest/{session}/history")).bearer_auth(&credentials[0].1).send().await.unwrap().status(),401);
  let listing=body(client.get(format!("{url}/api/collaboration/invitations")).bearer_auth(jwt(&state,"stranger")).send().await.unwrap()).await;
  assert_eq!(listing,json!({"invitations":[]}));
  let hashes=state.lock_db().unwrap().prepare("SELECT hash FROM collaboration_guests").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
  let expected=credentials.iter().map(|(_,value)|hash(value)).collect::<std::collections::BTreeSet<_>>();
  assert_eq!(hashes.into_iter().collect::<std::collections::BTreeSet<_>>(),expected);
  state.terminal_manager().close("owner",&session).await.unwrap();}).catch_unwind().await;
        if let Ok(sessions) = state.terminal_manager().list_sessions("owner").await {
            for session in sessions {
                let _ = state.terminal_manager().close("owner", &session.id).await;
            }
        }
        task.task.abort();
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    }
}
