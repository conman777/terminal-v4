use crate::{auth::AuthenticatedUser, remote_permissions::Capabilities, state::AppState, ApiError};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        FromRequestParts, Path, Request, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Extension, Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

const GRANT_SECONDS: i64 = 30 * 24 * 3600;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/environments", get(list))
        .route("/api/environments/pairing-code", post(create_code))
        .route("/api/environments/connect", post(connect))
        .route(
            "/api/environments/{id}",
            axum::routing::delete(disconnect).patch(update_environment),
        )
        .route("/api/environments/{id}/status", get(status))
        .route(
            "/api/environments/grants/{id}",
            axum::routing::delete(revoke),
        )
}
pub(crate) fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/environments/exchange", post(exchange))
        .route("/api/environments/check", get(check))
        .route("/api/environments/release", post(release))
        .route("/api/environments/{id}/proxy/{*rest}", any(proxy))
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
fn random_secret() -> String {
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn fingerprint(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn unauthorized() -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Invalid, expired, or revoked environment credential".into(),
    }
}
fn storage(state: &AppState) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, ApiError> {
    let db = state
        .lock_db()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS paired_codes (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, username TEXT NOT NULL, label TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS paired_grants (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, username TEXT NOT NULL, label TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS paired_environments (id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL, credential TEXT NOT NULL, grant_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, insecure INTEGER NOT NULL);")
        .map_err(|_| ApiError::internal("Environment storage unavailable"))?;
    for table in ["paired_codes", "paired_grants", "paired_environments"] {
        for (column, definition) in [
            ("profile", "TEXT NOT NULL DEFAULT 'operator'"),
            (
                "capabilities",
                r#"TEXT NOT NULL DEFAULT '{"terminalInput":true,"fileWrite":true,"agentExecute":true,"transfer":true,"recordings":true}'"#,
            ),
        ] {
            let exists = db
                .prepare(&format!("PRAGMA table_info({table})"))
                .and_then(|mut q| {
                    q.query_map([], |r| r.get::<_, String>(1))?
                        .collect::<Result<Vec<_>, _>>()
                })
                .map_err(|_| ApiError::internal("Environment migration unavailable"))?
                .iter()
                .any(|name| name == column);
            if !exists {
                db.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN {column} {definition}"
                ))
                .map_err(|_| ApiError::internal("Environment migration unavailable"))?;
            }
        }
    }
    for (column, definition) in [
        ("favorite", "INTEGER NOT NULL DEFAULT 0"),
        ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("last_seen", "INTEGER"),
        ("last_used", "INTEGER"),
        ("last_workspace", "TEXT"),
        ("device_id", "TEXT NOT NULL DEFAULT ''"),
        ("hostname", "TEXT NOT NULL DEFAULT ''"),
        ("os", "TEXT NOT NULL DEFAULT ''"),
    ] {
        let exists = db
            .prepare("PRAGMA table_info(paired_environments)")
            .and_then(|mut q| {
                q.query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|_| ApiError::internal("Environment migration unavailable"))?
            .iter()
            .any(|name| name == column);
        if !exists {
            db.execute_batch(&format!(
                "ALTER TABLE paired_environments ADD COLUMN {column} {definition}"
            ))
            .map_err(|_| ApiError::internal("Environment migration unavailable"))?;
        }
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS paired_device (id TEXT PRIMARY KEY)")
        .map_err(|_| ApiError::internal("Device identity unavailable"))?;
    db.execute(
        "INSERT INTO paired_device SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM paired_device)",
        [uuid::Uuid::new_v4().to_string()],
    )
    .map_err(|_| ApiError::internal("Device identity unavailable"))?;
    Ok(db)
}
fn label(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "An environment name up to 80 characters is required",
        ));
    }
    Ok(value.into())
}
fn normalized_url(value: &str, allow_insecure: bool) -> Result<String, String> {
    let parsed = url::Url::parse(value)
        .map_err(|_| "Enter an absolute HTTP or HTTPS server origin".to_string())?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(
            "Enter only the server origin, without credentials, a path, query, or fragment".into(),
        );
    }
    let loopback = parsed.host_str().is_some_and(|h| {
        h == "localhost"
            || h.parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
            || h == "[::1]"
    });
    if parsed.scheme() == "http" && !loopback {
        let private_address = parsed
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|address| match address {
                std::net::IpAddr::V4(address) => address.is_private() || address.is_link_local(),
                std::net::IpAddr::V6(address) => {
                    address.is_unique_local() || address.is_unicast_link_local()
                }
            });
        if !allow_insecure || !private_address {
            return Err(
                "HTTPS is required. Explicit HTTP trust is limited to private network IP addresses"
                    .into(),
            );
        }
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}
fn normalized_destination(value: &str, allow_insecure: bool) -> Result<String, String> {
    let parsed = url::Url::parse(value).map_err(|_| "Invalid paired destination".to_string())?;
    if parsed.path() == "/" {
        return normalized_url(value, allow_insecure);
    }
    let segments = parsed
        .path()
        .trim_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if let ["api", "relay", "devices", device] = segments.as_slice() {
        let mut origin = parsed.clone();
        origin.set_path("/");
        if origin.query().is_some() || origin.fragment().is_some() {
            return Err("Invalid relay destination".into());
        }
        return crate::device_relay::device_destination(origin.as_str(), device);
    }
    Err("Invalid paired destination prefix".into())
}
pub(crate) fn device_identity(state: &AppState) -> Result<String, ApiError> {
    Ok(device_info(&*storage(state)?)?.0)
}
fn runtime_path(path: &str) -> bool {
    let full = Capabilities {
        terminal_input: true,
        file_write: true,
        agent_execute: true,
        tunnels: true,
        desktop_view: true,
        desktop_control: true,
        transfer: true,
        recordings: true,
    };
    ["GET", "POST", "PATCH", "PUT", "DELETE"]
        .iter()
        .any(|method| full.allows_http(method, path))
}
pub(crate) fn capabilities_for_token(state: &AppState, token: &str) -> Option<Capabilities> {
    if !token.starts_with("tv4pair.") || token.len() != 72 {
        return None;
    }
    let db = storage(state).ok()?;
    let encoded: Option<String> = db
        .query_row(
            "SELECT capabilities FROM paired_grants WHERE hash=?1 AND expires>?2",
            params![fingerprint(token), now()],
            |r| r.get(0),
        )
        .optional()
        .ok()?;
    serde_json::from_str(&encoded?).ok()
}
#[cfg(all(test, unix))]
pub(crate) fn synthetic_input_grant(state: &AppState, owner: &str) -> (String, String) {
    let token = format!("tv4pair.{}", random_secret());
    let id = uuid::Uuid::new_v4().to_string();
    let db = storage(state).unwrap();
    db.execute("INSERT INTO paired_grants (id,hash,owner,username,label,created,expires,profile,capabilities) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![id, fingerprint(&token), owner, "fixture", "synthetic", now(), now() + 3600, "operator", serde_json::to_string(&Capabilities::operator()).unwrap()]).unwrap();
    (id, token)
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Non-secret grant identity; a restored claim must first come from an
/// integrity-protected binding before it is passed to admission.
pub(crate) struct PairedGrantAuthority {
    owner: String,
    grant_id: uuid::Uuid,
    created: i64,
    expires_at_ms: i64,
    revision: String,
}

#[cfg(unix)]
impl PairedGrantAuthority {
    pub(crate) fn valid_binding_for(&self, owner: &str) -> bool {
        self.owner == owner
            && !owner.is_empty()
            && owner.len() <= 256
            && !owner.chars().any(char::is_control)
            && !self.grant_id.is_nil()
            && self.created > 0
            && self
                .created
                .checked_mul(1000)
                .is_some_and(|created| created < self.expires_at_ms)
            && self.expires_at_ms % 1000 == 0
            && self.revision.len() == 64
            && self
                .revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    pub(crate) fn valid_for(&self, owner: &str, current_time: i64) -> bool {
        self.valid_binding_for(owner)
            && current_time > 0
            && self
                .created
                .checked_mul(1000)
                .is_some_and(|created| created <= current_time)
            && self.expires_at_ms > current_time
    }

    pub(crate) fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }
}

#[cfg(unix)]
fn grant_revision(id: &str, hash: &str, created: i64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"terminal-v4-paired-grant-v1\0");
    digest.update(id.as_bytes());
    digest.update(b"\0");
    digest.update(hash.as_bytes());
    digest.update(b"\0");
    digest.update(created.to_be_bytes());
    hex::encode(digest.finalize())
}

#[cfg(unix)]
pub(crate) fn capture_paired_grant_with_connection(
    db: &rusqlite::Connection,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<PairedGrantAuthority, String> {
    if !authority.token.starts_with("tv4pair.") || authority.token.len() != 72 {
        return Err("Paired grant is invalid".into());
    }
    let token_hash = fingerprint(&authority.token);
    let record: Option<(String, String, String, i64, i64)> = db.query_row(
        "SELECT id,owner,capabilities,created,expires FROM paired_grants WHERE hash=?1 AND expires>?2",
        params![token_hash, now()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|_| "Paired grant storage unavailable")?;
    let (id, grant_owner, encoded, created, expires) =
        record.ok_or("Paired grant expired or revoked")?;
    let capabilities: Capabilities =
        serde_json::from_str(&encoded).map_err(|_| "Paired grant is invalid")?;
    if owner.is_empty()
        || owner.len() > 256
        || owner.chars().any(char::is_control)
        || grant_owner != owner
        || !capabilities.agent_execute
        || !capabilities.allows_http(&authority.method, &authority.path)
        || created <= 0
        || expires <= created
    {
        return Err("Paired grant does not authorize this input".into());
    }
    let grant_id = uuid::Uuid::parse_str(&id).map_err(|_| "Paired grant is invalid")?;
    if grant_id.is_nil() {
        return Err("Paired grant is invalid".into());
    }
    Ok(PairedGrantAuthority {
        owner: owner.into(),
        grant_id,
        created,
        expires_at_ms: expires
            .checked_mul(1000)
            .ok_or("Paired grant expiry is invalid")?,
        revision: grant_revision(&id, &token_hash, created),
    })
}

#[cfg(unix)]
pub(crate) fn capture_paired_grant(
    state: &AppState,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<PairedGrantAuthority, String> {
    let db = storage(state).map_err(|_| "Paired grant storage unavailable")?;
    capture_paired_grant_with_connection(&db, authority, owner)
}

#[cfg(unix)]
pub(crate) fn validate_paired_grant_with_connection(
    db: &rusqlite::Connection,
    grant: &PairedGrantAuthority,
    owner: &str,
) -> Result<(), String> {
    let current_time = crate::v4_agent::interaction::now_ms();
    if !grant.valid_for(owner, current_time) {
        return Err("Paired grant expired or revoked".into());
    }
    let id = grant.grant_id.to_string();
    let record: Option<(String, String, String, i64, i64)> = db
        .query_row(
            "SELECT owner,hash,capabilities,created,expires FROM paired_grants WHERE id=?1",
            [&id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "Paired grant storage unavailable")?;
    let (grant_owner, hash, encoded, created, expires) =
        record.ok_or("Paired grant expired or revoked")?;
    let capabilities: Capabilities =
        serde_json::from_str(&encoded).map_err(|_| "Paired grant is invalid")?;
    if grant_owner != owner
        || !capabilities.agent_execute
        || created != grant.created
        || expires.checked_mul(1000) != Some(grant.expires_at_ms)
        || grant_revision(&id, &hash, created) != grant.revision
    {
        return Err("Paired grant expired, changed or revoked".into());
    }
    Ok(())
}

pub(crate) fn validate_input_authority(
    state: &AppState,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<i64, String> {
    let db = storage(state).map_err(|_| "Paired grant storage unavailable")?;
    validate_input_authority_with_connection(&db, authority, owner)
}

pub(crate) fn validate_input_authority_with_connection(
    db: &rusqlite::Connection,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<i64, String> {
    let record: Option<(String, String, i64)> = db
        .query_row(
            "SELECT owner,capabilities,expires FROM paired_grants WHERE hash=?1 AND expires>?2",
            params![fingerprint(&authority.token), now()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| "Paired grant storage unavailable")?;
    let (grant_owner, encoded, expires) = record.ok_or("Paired grant expired or revoked")?;
    let capabilities: Capabilities =
        serde_json::from_str(&encoded).map_err(|_| "Paired grant is invalid")?;
    if grant_owner != owner || !capabilities.allows_http(&authority.method, &authority.path) {
        return Err("Paired grant does not authorize this input".into());
    }
    Ok(expires.saturating_mul(1000))
}

pub(crate) fn validate_message_authority(
    state: &AppState,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<i64, String> {
    let expires = validate_input_authority(state, authority, owner)?;
    if authority.method == "GET"
        && !crate::auth::runtime_message_allowed(state, &authority.token, true, "message")
    {
        return Err("Paired grant does not authorize messages".into());
    }
    Ok(expires)
}

pub(crate) fn validate_decision_authority(
    state: &AppState,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<i64, String> {
    let expires = validate_input_authority(state, authority, owner)?;
    if authority.method == "GET"
        && !crate::auth::runtime_message_allowed(state, &authority.token, true, "approve")
    {
        return Err("Paired grant does not authorize approvals".into());
    }
    Ok(expires)
}

#[cfg(unix)]
pub(crate) fn validate_stop_authority(
    state: &AppState,
    authority: &crate::auth::PairedInputAuthority,
    owner: &str,
) -> Result<i64, String> {
    let expires = validate_input_authority(state, authority, owner)?;
    if authority.method == "GET"
        && !crate::auth::runtime_message_allowed(state, &authority.token, true, "interrupt")
    {
        return Err("Paired grant does not authorize Stop".into());
    }
    Ok(expires)
}

pub(crate) fn authorize_request(
    state: &AppState,
    token: &str,
    method: &str,
    path: &str,
) -> Option<AuthenticatedUser> {
    if !capabilities_for_token(state, token)?.allows_http(method, path) {
        return None;
    }
    let db = storage(state).ok()?;
    db.query_row(
        "SELECT owner,username FROM paired_grants WHERE hash=?1 AND expires>?2",
        params![fingerprint(token), now()],
        |row| {
            Ok(AuthenticatedUser {
                user_id: row.get(0)?,
                username: row.get(1)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
    .filter(|user| {
        state
            .config()
            .allowed_username
            .as_ref()
            .is_none_or(|allowed| allowed == &user.username)
    })
}
pub(crate) fn authenticate_token(
    state: &AppState,
    token: &str,
    path: &str,
) -> Option<AuthenticatedUser> {
    authorize_request(state, token, "GET", path)
        .and_then(|user| crate::auth::runtime_identity(state, user).ok())
}
fn device_info(db: &rusqlite::Connection) -> Result<(String, String, String), ApiError> {
    let id = db
        .query_row("SELECT id FROM paired_device LIMIT 1", [], |r| r.get(0))
        .map_err(|_| ApiError::internal("Device identity unavailable"))?;
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Terminal v4 host".into())
        .chars()
        .filter(|c| !c.is_control())
        .take(255)
        .collect();
    Ok((id, host, std::env::consts::OS.into()))
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn local_user(state: &AppState, token: &str) -> Result<AuthenticatedUser, ApiError> {
    crate::auth::authenticate_local_token(&state, token).map_err(|_| unauthorized())
}
fn client() -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .no_proxy()
        .build()
        .map_err(|_| ApiError::internal("Remote transport unavailable"))
}
fn encryption_key(state: &AppState) -> String {
    format!(
        "{}:{}",
        crate::vault_encryption_key(),
        state.config().jwt_secret
    )
}
fn private_json(value: Value) -> Response {
    (
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LabelInput {
    label: String,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    capabilities: Option<Capabilities>,
}
fn profile(input: &LabelInput) -> Result<(String, Capabilities), ApiError> {
    match input.profile.as_deref().unwrap_or("operator") {
        "observer" if input.capabilities.is_none() => {
            Ok(("observer".into(), Capabilities::observer()))
        }
        "operator" if input.capabilities.is_none() => {
            Ok(("operator".into(), Capabilities::operator()))
        }
        "custom" => {
            let caps = input.capabilities.clone().unwrap_or_default();
            if caps.desktop_control && !caps.desktop_view {
                return Err(ApiError::bad_request(
                    "Desktop control requires desktop viewing",
                ));
            }
            Ok(("custom".into(), caps))
        }
        _ => Err(ApiError::bad_request(
            "Choose observer, operator, or custom permissions",
        )),
    }
}
async fn create_code(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<LabelInput>,
) -> Result<Response, ApiError> {
    let label = label(&input.label)?;
    let (profile, capabilities) = profile(&input)?;
    let code = random_secret();
    let expires = now() + 120;
    let db = storage(&state)?;
    db.execute("DELETE FROM paired_codes WHERE expires<=?1", [now()])
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM paired_codes WHERE owner=?1",
            [&user.user_id],
            |r| r.get(0),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if count >= 10 {
        return Err(ApiError::bad_request(
            "Wait for existing pairing codes to expire",
        ));
    }
    db.execute(
        "INSERT INTO paired_codes (hash,owner,username,label,expires,profile,capabilities) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            fingerprint(&code),
            user.user_id,
            user.username,
            label,
            expires, profile,serde_json::to_string(&capabilities).map_err(|_|ApiError::internal("Invalid capabilities"))?
        ],
    )
    .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(private_json(
        json!({"code":code,"expiresAt":expires,"profile":profile,"capabilities":capabilities}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeInput {
    code: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeResult {
    credential: String,
    grant_id: String,
    expires_at: i64,
    #[serde(default = "operator_profile")]
    profile: String,
    #[serde(default = "Capabilities::operator")]
    capabilities: Capabilities,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    os: String,
}
fn operator_profile() -> String {
    "operator".into()
}
async fn exchange(
    State(state): State<AppState>,
    Json(input): Json<ExchangeInput>,
) -> Result<Response, ApiError> {
    if input.code.len() != 64 || !input.code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(unauthorized());
    }
    let mut db = storage(&state)?;
    let tx = db
        .transaction()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let code: Option<(String, String, String,String,String)> = tx
        .query_row(
            "SELECT owner,username,label,profile,capabilities FROM paired_codes WHERE hash=?1 AND expires>?2",
            params![fingerprint(&input.code), now()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?,r.get(3)?,r.get(4)?)),
        )
        .optional()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let Some((owner, username, label, profile, capabilities)) = code else {
        return Err(unauthorized());
    };
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM paired_grants WHERE owner=?1 AND expires>?2",
            params![owner, now()],
            |r| r.get(0),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if count >= 50 {
        return Err(ApiError::bad_request(
            "Revoke an existing environment grant before pairing another client",
        ));
    }
    let credential = format!("tv4pair.{}", random_secret());
    let grant_id = uuid::Uuid::new_v4().to_string();
    let expires_at = now() + GRANT_SECONDS;
    tx.execute(
        "DELETE FROM paired_codes WHERE hash=?1",
        [fingerprint(&input.code)],
    )
    .map_err(|error| ApiError::internal(error.to_string()))?;
    tx.execute(
        "INSERT INTO paired_grants (id,hash,owner,username,label,created,expires,profile,capabilities) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            grant_id,
            fingerprint(&credential),
            owner,
            username,
            label,
            now(),
            expires_at,profile,capabilities
        ],
    )
    .map_err(|error| ApiError::internal(error.to_string()))?;
    let (device_id, hostname, os) = device_info(&tx)?;
    tx.commit()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(private_json(json!(ExchangeResult {
        credential,
        grant_id,
        expires_at,
        profile,
        capabilities: serde_json::from_str(&capabilities)
            .map_err(|_| ApiError::internal("Invalid stored permissions"))?,
        device_id,
        hostname,
        os
    })))
}
async fn check(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?;
    authenticate_token(&state, token, "/api/state").ok_or_else(unauthorized)?;
    let capabilities = capabilities_for_token(&state, token).ok_or_else(unauthorized)?;
    let (device_id, hostname, os) = device_info(&*storage(&state)?)?;
    Ok(private_json(
        json!({"connected":true,"capabilities":capabilities,"deviceId":device_id,"hostname":hostname,"os":os}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectInput {
    #[serde(default)]
    url: String,
    relay_url: Option<String>,
    device_id: Option<String>,
    code: String,
    label: String,
    #[serde(default)]
    allow_insecure_http: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    id: String,
    label: String,
    url: String,
    created_at: i64,
    expires_at: i64,
    insecure_transport: bool,
    profile: String,
    capabilities: Capabilities,
    favorite: bool,
    tags: Vec<String>,
    last_seen_at: Option<i64>,
    last_used_at: Option<i64>,
    last_workspace: Option<String>,
    device_id: String,
    hostname: String,
    os: String,
    #[serde(skip)]
    credential: String,
    #[serde(skip)]
    grant_id: String,
}
fn load_environment(
    state: &AppState,
    user: &AuthenticatedUser,
    id: &str,
) -> Result<Environment, ApiError> {
    let db = storage(state)?;
    let mut item = db.query_row("SELECT id,label,url,created,expires,insecure,credential,grant_id,profile,capabilities,favorite,tags,last_seen,last_used,last_workspace,device_id,hostname,os FROM paired_environments WHERE id=?1 AND owner=?2", params![id,user.user_id], environment_row).optional().map_err(|error| ApiError::internal(error.to_string()))?.ok_or_else(||ApiError::not_found("Environment not found"))?;
    if item.expires_at <= now() {
        return Err(unauthorized());
    }
    item.credential = crate::vault::decrypt_secret(&item.credential, &encryption_key(state))
        .map_err(|_| ApiError::internal("Unable to unlock paired environment credential"))?;
    normalized_destination(&item.url, item.insecure_transport).map_err(ApiError::bad_request)?;
    Ok(item)
}
pub(crate) fn tunnel_destination(
    state: &AppState,
    user: &AuthenticatedUser,
    environment_id: &str,
) -> Result<(String, String), ApiError> {
    let environment = load_environment(state, user, environment_id)?;
    if !environment.capabilities.tunnels {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Pair this device with the Service tunnels permission".into(),
        });
    }
    Ok((environment.url, environment.credential))
}
fn environment_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Environment> {
    let caps: String = r.get(9)?;
    let tags: String = r.get(11)?;
    Ok(Environment {
        id: r.get(0)?,
        label: r.get(1)?,
        url: r.get(2)?,
        created_at: r.get(3)?,
        expires_at: r.get(4)?,
        insecure_transport: r.get(5)?,
        credential: r.get(6)?,
        grant_id: r.get(7)?,
        profile: r.get(8)?,
        capabilities: serde_json::from_str(&caps).unwrap_or_default(),
        favorite: r.get(10)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        last_seen_at: r.get(12)?,
        last_used_at: r.get(13)?,
        last_workspace: r.get(14)?,
        device_id: r.get(15)?,
        hostname: r.get(16)?,
        os: r.get(17)?,
    })
}
async fn connect(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<ConnectInput>,
) -> Result<Response, ApiError> {
    let url = match (&input.relay_url, &input.device_id) {
        (Some(relay), Some(device)) if input.url.is_empty() => {
            crate::device_relay::device_destination(relay, device).map_err(ApiError::bad_request)?
        }
        (None, None) => {
            normalized_url(&input.url, input.allow_insecure_http).map_err(ApiError::bad_request)?
        }
        _ => {
            return Err(ApiError::bad_request(
                "Provide a server URL or a relay URL and device ID",
            ));
        }
    };
    let label = label(&input.label)?;
    if input.code.len() != 64 {
        return Err(ApiError::bad_request(
            "Paste a valid pairing code from the remote environment",
        ));
    }
    {
        let db = storage(&state)?;
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM paired_environments WHERE owner=?1",
                [&user.user_id],
                |r| r.get(0),
            )
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if count >= 50 {
            return Err(ApiError::bad_request(
                "Disconnect an environment before adding another",
            ));
        }
    }
    let response = client()?
        .post(format!("{url}/api/environments/exchange"))
        .json(&json!({"code":input.code}))
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| {
            ApiError::bad_request(
                "Cannot reach the remote environment. Check its address and TLS certificate",
            )
        })?;
    if !response.status().is_success() {
        return Err(ApiError::bad_request(
            "Remote environment rejected the pairing code",
        ));
    }
    let bytes = bounded_body(response, 4096).await?;
    let result: ExchangeResult = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid remote pairing response"))?;
    if input.device_id.as_ref().is_some_and(|id| {
        uuid::Uuid::parse_str(id).ok() != uuid::Uuid::parse_str(&result.device_id).ok()
    }) {
        return Err(ApiError::bad_request(
            "The relay returned a different device identity",
        ));
    }
    if result.credential.len() != 72
        || !result.credential.starts_with("tv4pair.")
        || result.expires_at <= now()
        || result.expires_at > now() + GRANT_SECONDS + 60
        || uuid::Uuid::parse_str(&result.grant_id).is_err()
    {
        return Err(ApiError::bad_request("Invalid remote pairing response"));
    }
    let environment = Environment {
        id: uuid::Uuid::new_v4().to_string(),
        label,
        url,
        created_at: now(),
        expires_at: result.expires_at,
        insecure_transport: input.allow_insecure_http,
        credential: crate::vault::encrypt_secret(&result.credential, &encryption_key(&state))
            .map_err(|error| ApiError::internal(error.to_string()))?,
        grant_id: result.grant_id,
        profile: result.profile,
        capabilities: result.capabilities,
        favorite: false,
        tags: vec![],
        last_seen_at: Some(now()),
        last_used_at: None,
        last_workspace: None,
        device_id: result.device_id,
        hostname: result.hostname,
        os: result.os,
    };
    let db = storage(&state)?;
    db.execute(
        "INSERT INTO paired_environments (id,owner,label,url,credential,grant_id,created,expires,insecure,profile,capabilities,device_id,hostname,os,last_seen) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            environment.id,
            user.user_id,
            environment.label,
            environment.url,
            environment.credential,
            environment.grant_id,
            environment.created_at,
            environment.expires_at,
            environment.insecure_transport, environment.profile,serde_json::to_string(&environment.capabilities).map_err(|_|ApiError::internal("Invalid permissions"))?,environment.device_id,environment.hostname,environment.os,environment.last_seen_at
        ],
    )
    .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(private_json(json!(environment)))
}
async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Response, ApiError> {
    let db = storage(&state)?;
    let mut stmt=db.prepare("SELECT id,label,url,created,expires,insecure,credential,grant_id,profile,capabilities,favorite,tags,last_seen,last_used,last_workspace,device_id,hostname,os FROM paired_environments WHERE owner=?1 ORDER BY favorite DESC,COALESCE(last_used,created) DESC,id").map_err(|error| ApiError::internal(error.to_string()))?;
    let environments = stmt
        .query_map([&user.user_id], environment_row)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut stmt=db.prepare("SELECT id,label,created,expires,profile,capabilities FROM paired_grants WHERE owner=?1 AND expires>?2 ORDER BY created,id").map_err(|error|ApiError::internal(error.to_string()))?;
    let grants=stmt.query_map(params![user.user_id,now()],|r|{let caps:String=r.get(5)?;Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"expiresAt":r.get::<_,i64>(3)?,"profile":r.get::<_,String>(4)?,"capabilities":serde_json::from_str::<Capabilities>(&caps).unwrap_or_default()}))}).map_err(|error|ApiError::internal(error.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|error|ApiError::internal(error.to_string()))?;
    Ok(private_json(
        json!({"environments":environments,"grants":grants}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvironmentPatch {
    label: Option<String>,
    favorite: Option<bool>,
    tags: Option<Vec<String>>,
    last_workspace: Option<String>,
}
async fn update_environment(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
    Json(input): Json<EnvironmentPatch>,
) -> Result<Response, ApiError> {
    let mut item = load_environment(&state, &user, &id)?;
    if let Some(value) = input.label {
        item.label = label(&value)?;
    }
    if let Some(value) = input.favorite {
        item.favorite = value;
    }
    if let Some(tags) = input.tags {
        if tags.len() > 12 {
            return Err(ApiError::bad_request("Use up to 12 tags"));
        }
        let mut normalized = Vec::new();
        for tag in tags {
            let tag = tag.trim();
            if tag.is_empty() || tag.chars().count() > 32 || tag.chars().any(char::is_control) {
                return Err(ApiError::bad_request(
                    "Tags must contain 1 to 32 visible characters",
                ));
            }
            if !normalized
                .iter()
                .any(|v: &String| v.eq_ignore_ascii_case(tag))
            {
                normalized.push(tag.to_string());
            }
        }
        item.tags = normalized;
    }
    if let Some(workspace) = input.last_workspace {
        if workspace.chars().count() > 4096 || workspace.chars().any(char::is_control) {
            return Err(ApiError::bad_request("Invalid last workspace"));
        }
        item.last_workspace = (!workspace.trim().is_empty()).then_some(workspace);
        item.last_used_at = Some(now());
    }
    let db = storage(&state)?;
    db.execute("UPDATE paired_environments SET label=?1,favorite=?2,tags=?3,last_workspace=?4,last_used=?5 WHERE id=?6 AND owner=?7",params![item.label,item.favorite,serde_json::to_string(&item.tags).map_err(|_|ApiError::internal("Invalid tags"))?,item.last_workspace,item.last_used_at,id,user.user_id]).map_err(|e|ApiError::internal(e.to_string()))?;
    Ok(private_json(json!(item)))
}
async fn revoke(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let changed = tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let _guard = {
            let guard = state
                .acquire_input_guard(&user.user_id)
                .map_err(ApiError::internal)?;
            state
                .verify_owner_input_guard(&guard)
                .map_err(ApiError::internal)?;
            guard
        };
        let db = storage(&state)?;
        db.execute(
            "DELETE FROM paired_grants WHERE id=?1 AND owner=?2",
            params![id, user.user_id],
        )
        .map_err(|error| ApiError::internal(error.to_string()))
    })
    .await
    .map_err(|_| ApiError::internal("Grant revocation unavailable"))??;
    if changed == 0 {
        return Err(ApiError::not_found("Grant not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn disconnect(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if let Ok(environment) = load_environment(&state, &user, &id) {
        if let Ok(client) = client() {
            let _ = client
                .post(format!("{}/api/environments/release", environment.url))
                .bearer_auth(&environment.credential)
                .timeout(Duration::from_secs(6))
                .send()
                .await;
        }
    }
    let db = storage(&state)?;
    if db
        .execute(
            "DELETE FROM paired_environments WHERE id=?1 AND owner=?2",
            params![id, user.user_id],
        )
        .map_err(|error| ApiError::internal(error.to_string()))?
        == 0
    {
        return Err(ApiError::not_found("Environment not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn remote_available(environment: &Environment) -> bool {
    let Ok(client) = client() else {
        return false;
    };
    client
        .get(format!("{}/api/environments/check", environment.url))
        .bearer_auth(&environment.credential)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}
async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let environment = load_environment(&state, &user, &id)?;
    let connected = remote_available(&environment).await;
    if connected {
        storage(&state)?
            .execute(
                "UPDATE paired_environments SET last_seen=?1 WHERE id=?2 AND owner=?3",
                params![now(), id, user.user_id],
            )
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    Ok(private_json(
        json!({"connected":connected,"profile":environment.profile,"capabilities":environment.capabilities,"deviceId":environment.device_id,"hostname":environment.hostname,"os":environment.os,"lastSeenAt":if connected{Some(now())}else{environment.last_seen_at},"error":if connected{Value::Null}else{json!("Remote environment unavailable, expired, or revoked")} }),
    ))
}

pub(crate) fn authorize_resource_target(
    state: &AppState,
    user: &AuthenticatedUser,
    id: &str,
    path: &str,
) -> Result<(), ApiError> {
    let environment = load_environment(state, user, id)?;
    if environment.capabilities.allows_http("GET", path) {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "This permission profile does not allow that preview target".into(),
        })
    }
}

pub(crate) fn resource_controller_allowed(
    state: &AppState,
    user: &AuthenticatedUser,
    id: &str,
    port: u16,
) -> bool {
    load_environment(state, user, id).is_ok_and(|environment| {
        environment
            .capabilities
            .allows_http("POST", &format!("/api/preview/{port}/client-operation"))
    })
}

async fn proxy(
    State(state): State<AppState>,
    Path((id, rest)): Path<(String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    let path = format!("/{rest}");
    if !runtime_path(&path) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "This route is not delegated to paired environments".into(),
        });
    }
    let query = request.uri().query().unwrap_or("").to_string();
    let query_token = url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned());
    let token = bearer(request.headers())
        .map(str::to_string)
        .or(query_token);
    let resource_query = url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "previewToken")
        .map(|(_, value)| value.into_owned());
    let full_path = format!("/api/environments/{id}/proxy{path}");
    let resource_user = resource_query.as_deref().and_then(|token| {
        crate::preview::auth_urls::authenticate_resource_token(
            &state,
            token,
            request.method().as_str(),
            &full_path,
        )
        .ok()
    });
    let resource_prefix = if path == "/api/preview" {
        Some(full_path.clone())
    } else {
        crate::preview::extract_port_from_path(&path)
            .map(|(port, _)| format!("/api/environments/{id}/proxy/preview/{port}"))
    };
    let document_url = format!(
        "{}{}",
        crate::request_origin(request.headers()).unwrap_or_else(|| "http://localhost:3020".into()),
        full_path
    );
    let preview = path.starts_with("/preview/") || path == "/api/preview";
    let preview_cookie_route = preview || path.starts_with("/api/preview/");
    let preview_cookie = if preview_cookie_route {
        request
            .headers()
            .get("cookie")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                value.split(';').find_map(|pair| {
                    let pair = pair.trim();
                    pair.strip_prefix("tv4_remote_preview=")
                        .or_else(|| pair.strip_prefix("terminal_preview_token="))
                })
            })
            .map(str::to_string)
    } else {
        None
    };
    let preview_user = preview_cookie.as_deref().and_then(|credential| {
        crate::auth::authenticate_runtime_preview_token(&state, credential, "/preview/").ok()
    });
    let websocket = request
        .headers()
        .get("upgrade")
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if websocket {
        if resource_query.is_some() {
            return Err(unauthorized());
        }

        let (mut parts, _) = request.into_parts();
        let ws = WebSocketUpgrade::from_request_parts(&mut parts, &state)
            .await
            .map_err(|_| ApiError::bad_request("Invalid WebSocket upgrade"))?;
        return Ok(ws
            .on_upgrade(move |socket| {
                proxy_socket(socket, state, id, path, query, token, preview_cookie)
            })
            .into_response());
    }
    let user = match token.as_deref() {
        Some(token) => local_user(&state, token)?,
        None if resource_query.is_some() => resource_user.ok_or_else(unauthorized)?,
        None if preview_cookie_route
            && ([axum::http::Method::GET, axum::http::Method::HEAD].contains(request.method())
                || (request.method() == axum::http::Method::POST
                    && path.starts_with("/api/preview/")
                    && (path.ends_with("/logs") || path.ends_with("/performance")))) =>
        {
            preview_user.ok_or_else(unauthorized)?
        }
        None => return Err(unauthorized()),
    };
    let preview_ticket = if preview && token.is_some() {
        Some(
            crate::auth::preview_token_for_access(
                &state,
                token.as_deref().ok_or_else(unauthorized)?,
            )
            .map_err(|_| unauthorized())?,
        )
    } else {
        None
    };
    let resource_root = (path == "/api/preview")
        .then(|| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(name, _)| name == "path")
                .map(|(_, value)| value.into_owned())
        })
        .flatten();
    if let (Some(token), Some(root)) = (resource_query.as_deref(), resource_root.as_deref()) {
        if !crate::preview::auth_urls::resource_root_allowed(&state, token, root) {
            return Err(unauthorized());
        }
    }
    let resource_ticket = resource_prefix.as_deref().and_then(|prefix| {
        resource_query
            .as_deref()
            .and_then(|token| {
                crate::preview::auth_urls::resource_token_for_root(
                    &state,
                    token,
                    prefix,
                    resource_root.as_deref(),
                )
            })
            .or_else(|| {
                preview_ticket
                    .as_deref()
                    .or(preview_cookie.as_deref())
                    .and_then(|parent| {
                        crate::preview::auth_urls::resource_token_for_root(
                            &state,
                            parent,
                            prefix,
                            resource_root.as_deref(),
                        )
                    })
            })
    });
    let environment = load_environment(&state, &user, &id)?;
    let method = request.method().clone();
    if !environment.capabilities.allows_http(method.as_str(), &path) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "This permission profile does not allow that action".into(),
        });
    }
    storage(&state)?
        .execute(
            "UPDATE paired_environments SET last_used=?1 WHERE id=?2 AND owner=?3",
            params![now(), id, user.user_id],
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let content_type = request.headers().get("content-type").cloned();
    let body = to_bytes(request.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::bad_request("Remote request exceeds 8 MiB"))?;
    let destination = destination(&environment, &path, &query, false)?;
    let mut outgoing = client()?
        .request(method, destination)
        .bearer_auth(&environment.credential)
        .body(body);
    if let Some(value) = content_type {
        outgoing = outgoing.header("content-type", value);
    }
    let remote = tokio::time::timeout(Duration::from_secs(20), outgoing.send())
        .await
        .map_err(|_| ApiError::bad_request("Remote environment timed out"))?
        .map_err(|_| ApiError::bad_request("Remote environment unavailable"))?;
    let mut response = Response::builder()
        .status(remote.status())
        .header("cache-control", "private, no-store");
    if preview {
        response = response.header("content-security-policy", crate::preview::DOCUMENT_SANDBOX);
    }
    if let Some(value) = remote.headers().get("content-type") {
        response = response.header("content-type", value);
    }
    if let Some(value) = remote.headers().get("content-disposition") {
        response = response.header("content-disposition", value);
    }
    if let Some(ticket) = &preview_ticket {
        response=response.header("set-cookie",format!("tv4_remote_preview={ticket}; HttpOnly; SameSite=Strict; Max-Age=900; Path=/api/environments/{id}/proxy/"));
    }
    let text_asset = preview
        && remote
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                ["text/html", "text/css", "javascript"]
                    .iter()
                    .any(|kind| value.contains(kind))
            });
    if text_asset {
        let bytes = bounded_body(remote, 8 * 1024 * 1024).await?;
        let content = String::from_utf8(bytes)
            .map_err(|_| ApiError::bad_request("Remote preview text is not UTF-8"))?;
        let prefix = format!("/api/environments/{id}/proxy");
        let content = rewrite_preview(&content, &prefix);
        let controller = crate::preview::extract_port_from_path(&path)
            .filter(|(port, _)| resource_controller_allowed(&state, &user, &id, *port))
            .and_then(|_| {
                crate::preview::auth_urls::resource_controller(
                    &state,
                    resource_ticket.as_deref()?,
                    resource_prefix.as_deref()?,
                )
            });
        let content = crate::preview::script_inject::bind_controller(&content, controller.as_ref());
        let content = if let (Some(ticket), Some(resource_prefix)) =
            (resource_ticket.as_deref(), resource_prefix.as_deref())
        {
            let content_type = response
                .headers_ref()
                .and_then(|headers| headers.get("content-type"))
                .and_then(|value| value.to_str().ok())
                .unwrap_or("text/html");
            crate::preview::auth_urls::authorize_resources(
                &content,
                content_type,
                &document_url,
                resource_prefix,
                ticket,
            )
        } else {
            content
        };

        return response
            .body(Body::from(content))
            .map_err(|_| ApiError::internal("Unable to forward remote preview"));
    }
    let event_stream = remote
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    let body = if event_stream {
        event_stream_body(remote, state, user, id, environment, token, preview_cookie)
    } else {
        Body::from_stream(remote.bytes_stream())
    };
    response
        .body(body)
        .map_err(|_| ApiError::internal("Unable to forward remote response"))
}
fn destination(
    environment: &Environment,
    path: &str,
    query: &str,
    websocket: bool,
) -> Result<url::Url, ApiError> {
    let mut url = url::Url::parse(&environment.url)
        .map_err(|_| ApiError::internal("Invalid paired environment origin"))?;
    let prefix = url.path().trim_end_matches('/');
    let target_path = format!("{prefix}{path}");
    url.set_path(&target_path);
    let filtered = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key != "token" && key != "previewToken")
        .collect::<Vec<_>>();
    {
        let mut parameters = url.query_pairs_mut();
        parameters.clear();
        for (key, value) in filtered {
            parameters.append_pair(&key, &value);
        }
    }
    if websocket {
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| ApiError::internal("Invalid remote socket scheme"))?;
    }
    Ok(url)
}
async fn proxy_socket(
    mut socket: WebSocket,
    state: AppState,
    id: String,
    path: String,
    query: String,
    token: Option<String>,
    preview_cookie: Option<String>,
) {
    let cookie_user = preview_cookie.as_deref().and_then(|credential| {
        crate::auth::authenticate_runtime_preview_token(&state, credential, "/preview/").ok()
    });
    let token = match token {
        Some(token) => token,
        None if cookie_user.is_some() => String::new(),
        None => {
            let message = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
            let Ok(Some(Ok(Message::Text(text)))) = message else {
                let _ = socket.close().await;
                return;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                return;
            };
            if value["type"] != "auth" {
                return;
            }
            match value["token"].as_str() {
                Some(token) => token.to_string(),
                None => return,
            }
        }
    };
    let user = match if token.is_empty() {
        cookie_user.ok_or_else(unauthorized)
    } else {
        local_user(&state, &token)
    } {
        Ok(user) => user,
        Err(_) => {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 4401,
                    reason: "Authentication required".into(),
                })))
                .await;
            return;
        }
    };
    let Ok(environment) = load_environment(&state, &user, &id) else {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "Environment unavailable".into(),
            })))
            .await;
        return;
    };
    if !environment.capabilities.allows_http("GET", &path) {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4403,
                reason: "Permission denied".into(),
            })))
            .await;
        return;
    }
    let Ok(url) = destination(&environment, &path, &query, true) else {
        return;
    };
    let Ok(mut request) = url.as_str().into_client_request() else {
        return;
    };
    let Ok(authorization) = format!("Bearer {}", environment.credential).parse() else {
        return;
    };
    request.headers_mut().insert("authorization", authorization);
    let Ok(Ok((mut remote, _))) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    else {
        return;
    };
    if path.starts_with("/api/terminal/")
        && remote
            .send(tungstenite::Message::Text(
                json!({"type":"auth","token":environment.credential})
                    .to_string()
                    .into(),
            ))
            .await
            .is_err()
    {
        return;
    }
    let mut forwarded_close = false;
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.tick().await;
    loop {
        tokio::select! {
            incoming=socket.recv()=>match incoming{
                Some(Ok(Message::Text(text)))=>{
                    let kind=serde_json::from_str::<Value>(&text).ok().and_then(|v|v["type"].as_str().map(str::to_string));
                    let allowed=if path.starts_with("/api/terminal/"){environment.capabilities.terminal_input || text=="__terminal_ping__" || serde_json::from_str::<Value>(&text).is_ok_and(|v|v["type"]=="ping" && v["source"]=="terminal-client")}else if path.starts_with("/api/structured/"){kind.as_deref().is_some_and(|kind|environment.capabilities.allows_structured_message(kind))}else{true};
                    if !allowed {let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4403,reason:"Permission denied".into()}))).await;break;}
                    if remote.send(tungstenite::Message::Text(text.to_string().into())).await.is_err(){break;}
                },
                Some(Ok(Message::Binary(bytes)))=>{
                    if (path.starts_with("/api/terminal/") && !environment.capabilities.terminal_input) || (path.starts_with("/api/structured/") && !environment.capabilities.agent_execute) {let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4403,reason:"Permission denied".into()}))).await;break;}
                    if remote.send(tungstenite::Message::Binary(bytes)).await.is_err(){break;}
                },
                Some(Ok(Message::Ping(bytes)))=>{let _=socket.send(Message::Pong(bytes)).await;},
                Some(Ok(Message::Pong(_)))=>{}, _=>break,
            },
            incoming=remote.next()=>match incoming{
                Some(Ok(tungstenite::Message::Text(text)))=>{if socket.send(Message::Text(text.to_string().into())).await.is_err(){break;}},
                Some(Ok(tungstenite::Message::Binary(bytes)))=>{if socket.send(Message::Binary(bytes)).await.is_err(){break;}},
                Some(Ok(tungstenite::Message::Ping(bytes)))=>{let _=remote.send(tungstenite::Message::Pong(bytes)).await;},
                Some(Ok(tungstenite::Message::Pong(_)))=>{},
                Some(Ok(tungstenite::Message::Close(frame)))=>{
                    forwarded_close = true;
                    let frame = frame.map(|frame| axum::extract::ws::CloseFrame {
                        code: frame.code.into(), reason: frame.reason.to_string().into(),
                    });
                    let _ = tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Close(frame))).await;
                    break;
                },
                _=>break,
            },
            _=interval.tick()=>{
                if (!token.is_empty() && local_user(&state,&token).is_err()) || (token.is_empty() && preview_cookie.as_deref().is_none_or(|credential|crate::auth::authenticate_runtime_preview_token(&state,credential,"/preview/").is_err())) || load_environment(&state,&user,&id).is_err() || !remote_available(&environment).await{let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:4401,reason:"Remote authorization expired or revoked".into()}))).await;break;}
            }
        }
    }
    let _ = remote.close(None).await;
    if !forwarded_close {
        let _ = socket.send(Message::Close(None)).await;
    }
}

async fn release(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers).ok_or_else(unauthorized)?.to_owned();
    let user = authenticate_token(&state, &token, "/api/state").ok_or_else(unauthorized)?;
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let _guard = {
            let guard = state
                .acquire_input_guard(&user.user_id)
                .map_err(ApiError::internal)?;
            state
                .verify_owner_input_guard(&guard)
                .map_err(ApiError::internal)?;
            guard
        };
        authenticate_token(&state, &token, "/api/state")
            .filter(|current| current.user_id == user.user_id)
            .ok_or_else(unauthorized)?;
        let db = storage(&state)?;
        db.execute(
            "DELETE FROM paired_grants WHERE hash=?1",
            [fingerprint(&token)],
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok::<_, ApiError>(())
    })
    .await
    .map_err(|_| ApiError::internal("Grant release unavailable"))??;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn paired_grant_claim_binds_owner_capability_and_original_grant_without_the_token() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE paired_grants (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, capabilities TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)").unwrap();
        let token = format!("tv4pair.{}", "a".repeat(64));
        let id = uuid::Uuid::new_v4().to_string();
        let created = now();
        let expires = created + 3600;
        db.execute(
            "INSERT INTO paired_grants VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                id,
                fingerprint(&token),
                "owner",
                serde_json::to_string(&Capabilities::operator()).unwrap(),
                created,
                expires
            ],
        )
        .unwrap();
        let authority = crate::auth::PairedInputAuthority {
            token: token.clone(),
            method: "POST".into(),
            path: "/api/structured/sessions/ss-fixture/message".into(),
        };
        let grant = capture_paired_grant_with_connection(&db, &authority, "owner").unwrap();
        assert_eq!(grant.grant_id.to_string(), id);
        assert!(!format!("{grant:?}").contains(&token));
        assert!(!format!("{grant:?}").contains(&fingerprint(&token)));
        let encoded = serde_json::to_string(&grant).unwrap();
        assert!(!encoded.contains(&token));
        assert!(!encoded.contains(&fingerprint(&token)));
        assert!(validate_paired_grant_with_connection(&db, &grant, "owner").is_ok());
        let mut malformed = grant.clone();
        malformed.revision = "g".repeat(64);
        assert!(!malformed.valid_for("owner", crate::v4_agent::interaction::now_ms()));
        assert!(validate_paired_grant_with_connection(&db, &grant, "other").is_err());
        assert!(capture_paired_grant_with_connection(&db, &authority, "other").is_err());

        db.execute(
            "UPDATE paired_grants SET capabilities=?1 WHERE id=?2",
            params![
                serde_json::to_string(&Capabilities::observer()).unwrap(),
                id
            ],
        )
        .unwrap();
        assert!(validate_paired_grant_with_connection(&db, &grant, "owner").is_err());
        assert!(capture_paired_grant_with_connection(&db, &authority, "owner").is_err());
        let observer_socket = crate::auth::PairedInputAuthority {
            token: token.clone(),
            method: "GET".into(),
            path: "/api/structured/sessions/ss-fixture/ws".into(),
        };
        assert!(capture_paired_grant_with_connection(&db, &observer_socket, "owner").is_err());
        db.execute(
            "UPDATE paired_grants SET capabilities=?1, expires=?2 WHERE id=?3",
            params![
                serde_json::to_string(&Capabilities::operator()).unwrap(),
                created,
                id
            ],
        )
        .unwrap();
        assert!(validate_paired_grant_with_connection(&db, &grant, "owner").is_err());
        db.execute(
            "UPDATE paired_grants SET expires=?1, created=?2 WHERE id=?3",
            params![expires, created + 1, id],
        )
        .unwrap();
        assert!(validate_paired_grant_with_connection(&db, &grant, "owner").is_err());
        db.execute(
            "UPDATE paired_grants SET created=?1, hash=?2 WHERE id=?3",
            params![created, fingerprint("replacement"), id],
        )
        .unwrap();
        assert!(validate_paired_grant_with_connection(&db, &grant, "owner").is_err());
        db.execute("DELETE FROM paired_grants WHERE id=?1", [&id])
            .unwrap();
        assert!(validate_paired_grant_with_connection(&db, &grant, "owner").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn paired_claim_admission_respects_owner_lock_and_revocation() {
        let data = tempfile::tempdir().unwrap();
        let app = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let (id, token) = synthetic_input_grant(&app, "owner");
        let authority = crate::auth::PairedInputAuthority {
            token,
            method: "POST".into(),
            path: "/api/structured/sessions/ss-fixture/message".into(),
        };
        let grant = {
            let db = app.lock_db().unwrap();
            capture_paired_grant_with_connection(&db, &authority, "owner").unwrap()
        };
        let admission = app.local_admission().unwrap();
        let locked = app.acquire_input_guard("owner").unwrap();
        assert!(admission
            .accept_paired("owner", &grant, |_check| Ok::<_, String>(()))
            .is_err());
        drop(locked);
        let (result, confirmed) = admission
            .accept_paired("owner", &grant, |check| {
                check()?;
                Ok::<_, String>("admitted")
            })
            .unwrap();
        assert_eq!((result.unwrap(), confirmed), ("admitted", true));
        app.lock_db()
            .unwrap()
            .execute("DELETE FROM paired_grants WHERE id=?1", [&id])
            .unwrap();
        assert!(admission
            .accept_paired("owner", &grant, |_check| Ok::<_, String>(()))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn paired_claim_expiry_during_publication_is_not_confirmed() {
        let data = tempfile::tempdir().unwrap();
        let app = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let (id, token) = synthetic_input_grant(&app, "owner");
        app.lock_db()
            .unwrap()
            .execute(
                "UPDATE paired_grants SET expires=?1 WHERE id=?2",
                params![now() + 2, id],
            )
            .unwrap();
        let authority = crate::auth::PairedInputAuthority {
            token,
            method: "POST".into(),
            path: "/api/structured/sessions/ss-fixture/message".into(),
        };
        let grant = {
            let db = app.lock_db().unwrap();
            capture_paired_grant_with_connection(&db, &authority, "owner").unwrap()
        };
        let admission = app.local_admission().unwrap();
        let (result, confirmed) = admission
            .accept_paired("owner", &grant, |_check| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while crate::v4_agent::interaction::now_ms() < grant.expires_at_ms {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "grant expiry clock did not advance"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Ok::<_, String>("published")
            })
            .unwrap();
        assert_eq!((result.unwrap(), confirmed), ("published", false));
    }
    #[test]
    fn destination_requires_a_secure_origin_or_explicit_lan_trust() {
        assert_eq!(
            normalized_url("http://127.0.0.1:3020/", false).unwrap(),
            "http://127.0.0.1:3020"
        );
        assert!(normalized_url("http://192.168.1.4:3020", false).is_err());
        assert_eq!(
            normalized_url("http://192.168.1.4:3020", true).unwrap(),
            "http://192.168.1.4:3020"
        );
        for url in [
            "https://user:secret@host",
            "https://host/path",
            "https://host?query",
            "https://host#fragment",
            "file:///tmp/file",
            "http://example.com",
            "http://8.8.8.8",
        ] {
            assert!(normalized_url(url, true).is_err(), "accepted {url}");
        }
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use terminal_v4_core::AppConfig;

    struct Server {
        state: AppState,
        directory: tempfile::TempDir,
        url: String,
        handle: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }
    async fn server() -> Server {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new_with_external_auth(
            AppConfig {
                data_dir: directory.path().to_path_buf(),
                jwt_secret: random_secret(),
                ..AppConfig::default()
            },
            None,
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = crate::app(state.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Server {
            state,
            directory,
            url,
            handle,
        }
    }
    fn token(server: &Server, user: &str) -> String {
        crate::auth::issue_access_token(&server.state.config().jwt_secret, user, user)
    }
    async fn json_response(response: reqwest::Response) -> Value {
        let status = response.status();
        let body = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        serde_json::from_str(&body).unwrap()
    }
    async fn code(client: &reqwest::Client, server: &Server, owner: &str) -> String {
        json_response(
            client
                .post(format!("{}/api/environments/pairing-code", server.url))
                .bearer_auth(token(server, owner))
                .json(&json!({"label":"Laptop client"}))
                .send()
                .await
                .unwrap(),
        )
        .await["code"]
            .as_str()
            .unwrap()
            .into()
    }

    #[tokio::test]
    async fn legacy_pairing_rows_migrate_to_operator_without_desktop_or_tunnels() {
        let host = server().await;
        let credential = format!("tv4pair.{}", random_secret());
        {
            let db = host.state.lock_db().unwrap();
            db.execute_batch("DROP TABLE IF EXISTS paired_codes;DROP TABLE IF EXISTS paired_grants;DROP TABLE IF EXISTS paired_environments;CREATE TABLE paired_grants (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, username TEXT NOT NULL, label TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)").unwrap();
            db.execute(
                "INSERT INTO paired_grants VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    fingerprint(&credential),
                    "owner",
                    "owner",
                    "Existing host",
                    now(),
                    now() + 3600
                ],
            )
            .unwrap();
        }
        assert_eq!(
            capabilities_for_token(&host.state, &credential),
            Some(Capabilities::operator())
        );
        assert!(authorize_request(&host.state, &credential, "POST", "/api/terminal").is_some());
        assert!(authorize_request(&host.state, &credential, "GET", "/api/desktop/frame").is_none());
        assert!(authorize_request(&host.state, &credential, "POST", "/api/tunnels").is_none());
        let (first, _, _) = device_info(&storage(&host.state).unwrap()).unwrap();
        let (second, _, _) = device_info(&storage(&host.state).unwrap()).unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn observer_grants_and_address_book_metadata_preserve_owner_boundaries() {
        let home = server().await;
        let target = server().await;
        let client = client().unwrap();
        let issued = json_response(
            client
                .post(format!("{}/api/environments/pairing-code", target.url))
                .bearer_auth(token(&target, "target-owner"))
                .json(&json!({"label":"Read only visitor","profile":"observer"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(issued["profile"], "observer");
        assert_eq!(issued["capabilities"], json!(Capabilities::observer()));
        let paired = json_response(
            client
                .post(format!("{}/api/environments/connect", home.url))
                .bearer_auth(token(&home, "home-owner"))
                .json(&json!({"url":target.url,"code":issued["code"],"label":"Remote laptop"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let id = paired["id"].as_str().unwrap();
        assert_eq!(paired["profile"], "observer");
        assert!(uuid::Uuid::parse_str(paired["deviceId"].as_str().unwrap()).is_ok());
        assert_eq!(paired["capabilities"], json!(Capabilities::observer()));
        let proxy = format!("{}/api/environments/{id}/proxy", home.url);
        let read = client
            .get(format!("{proxy}/api/terminal"))
            .bearer_auth(token(&home, "home-owner"))
            .send()
            .await
            .unwrap();
        assert!(read.status().is_success());
        let denied = client
            .post(format!("{proxy}/api/terminal"))
            .bearer_auth(token(&home, "home-owner"))
            .json(&json!({"cwd":target.directory.path().to_string_lossy()}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let denied = client
            .patch(format!("{}/api/environments/{id}", home.url))
            .bearer_auth(token(&home, "other-owner"))
            .json(&json!({"label":"Stolen"}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        let changed=json_response(client.patch(format!("{}/api/environments/{id}",home.url)).bearer_auth(token(&home,"home-owner")).json(&json!({"label":"Build machine","favorite":true,"tags":["Work","work","Linux"],"lastWorkspace":"/home/project"})).send().await.unwrap()).await;
        assert_eq!(
            (
                changed["label"].clone(),
                changed["favorite"].clone(),
                changed["tags"].clone(),
                changed["lastWorkspace"].clone()
            ),
            (
                json!("Build machine"),
                json!(true),
                json!(["Work", "Linux"]),
                json!("/home/project")
            )
        );
        assert!(changed["lastUsedAt"].as_i64().unwrap() > 0);
        let status = json_response(
            client
                .get(format!("{}/api/environments/{id}/status", home.url))
                .bearer_auth(token(&home, "home-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status["connected"], true);
        assert!(status["lastSeenAt"].as_i64().unwrap() > 0);
        assert!(!changed.to_string().contains("credential"));
        assert!(!changed.to_string().contains("tv4pair."));
        let malformed = client
            .post(format!("{}/api/environments/pairing-code", target.url))
            .bearer_auth(token(&target, "target-owner"))
            .json(&json!({"label":"Bad","profile":"custom","capabilities":{"desktopControl":true}}))
            .send()
            .await
            .unwrap();
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn paired_http_and_socket_reach_the_remote_owner_and_revocation_closes_transport() {
        let home = server().await;
        let target = server().await;
        let client = client().unwrap();
        let pairing_code = code(&client, &target, "remote-owner").await;
        let environment = json_response(
            client
                .post(format!("{}/api/environments/connect", home.url))
                .bearer_auth(token(&home, "local-owner"))
                .json(&json!({"url":target.url,"code":pairing_code,"label":"Build host"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let id = environment["id"].as_str().unwrap();
        let proxy = format!("{}/api/environments/{id}/proxy", home.url);
        let local_token = token(&home, "local-owner");
        let list = json_response(
            client
                .get(format!("{}/api/environments", home.url))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(list["environments"][0]["label"], "Build host");
        assert!(!list.to_string().contains("credential"));
        assert!(!list.to_string().contains("tv4pair."));
        let stored: String = storage(&home.state)
            .unwrap()
            .query_row(
                "SELECT credential FROM paired_environments WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(stored.starts_with("enc:v1:"));
        assert_eq!(
            client
                .get(format!("{proxy}/api/terminal"))
                .bearer_auth(token(&home, "other-owner"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(format!("{proxy}/api/vault"))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let remote_session=json_response(client.post(format!("{proxy}/api/terminal")).bearer_auth(&local_token).json(&json!({"cwd":target.directory.path().to_string_lossy(),"title":"Paired terminal","shell":if cfg!(windows){"cmd.exe"}else{"/bin/sh"}})).send().await.unwrap()).await;
        let session_id = remote_session["session"]["id"].as_str().unwrap();
        let target_sessions = json_response(
            client
                .get(format!("{}/api/terminal", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert!(target_sessions.to_string().contains(session_id));
        let home_sessions = json_response(
            client
                .get(format!("{}/api/terminal", home.url))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert!(!home_sessions.to_string().contains(session_id));
        let socket_url = format!(
            "{}/api/terminal/{session_id}/ws?framed=1",
            proxy.replacen("http://", "ws://", 1)
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(socket_url).await.unwrap();
        socket
            .send(tungstenite::Message::Text(
                json!({"type":"auth","token":local_token})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let message = tokio::time::timeout(Duration::from_secs(8), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            !message.is_close(),
            "remote session websocket closed before its first event"
        );
        let target_grants = json_response(
            client
                .get(format!("{}/api/environments", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let grant_id = target_grants["grants"][0]["id"].as_str().unwrap();
        assert_eq!(
            client
                .delete(format!("{}/api/environments/grants/{grant_id}", target.url))
                .bearer_auth(token(&target, "other-owner"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .delete(format!("{}/api/environments/grants/{grant_id}", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let status = json_response(
            client
                .get(format!("{}/api/environments/{id}/status", home.url))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status["connected"], false);
        let closed = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(message) = socket.next().await {
                if message.is_err() || message.unwrap().is_close() {
                    return true;
                }
            }
            true
        })
        .await
        .unwrap();
        assert!(closed);
        assert_eq!(
            client
                .get(format!("{proxy}/api/terminal"))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        client
            .delete(format!("{}/api/terminal/{session_id}", target.url))
            .bearer_auth(token(&target, "remote-owner"))
            .send()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn preview_assets_and_sockets_use_a_scoped_cookie_without_leaking_host_credentials() {
        let home = server().await;
        let target = server().await;
        let client = client().unwrap();
        async fn html(headers: HeaderMap) -> impl IntoResponse {
            assert!(headers.get("authorization").is_none());
            axum::response::Html(
                r#"<html><head></head><body><script src="/asset.js"></script></body></html>"#,
            )
        }
        async fn asset(headers: HeaderMap) -> impl IntoResponse {
            assert!(headers.get("authorization").is_none());
            (
                [(axum::http::header::CONTENT_TYPE, "application/javascript")],
                "export const remoteAsset = true;",
            )
        }
        async fn echo(ws: WebSocketUpgrade, headers: HeaderMap) -> impl IntoResponse {
            assert!(headers.get("authorization").is_none());
            ws.on_upgrade(|mut socket| async move {
                while let Some(Ok(message)) = socket.recv().await {
                    if socket.send(message).await.is_err() {
                        break;
                    }
                }
            })
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/", get(html))
                    .route("/asset.js", get(asset))
                    .route("/echo", get(echo)),
            )
            .await
            .unwrap();
        });
        let pairing_code = code(&client, &target, "remote-owner").await;
        let environment = json_response(
            client
                .post(format!("{}/api/environments/connect", home.url))
                .bearer_auth(token(&home, "local-owner"))
                .json(&json!({"url":target.url,"code":pairing_code,"label":"Preview host"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let id = environment["id"].as_str().unwrap();
        let prefix = format!("/api/environments/{id}/proxy");
        let home_token = token(&home, "local-owner");
        let response = client
            .get(format!("{}{prefix}/preview/{port}/", home.url))
            .query(&[("token", home_token)])
            .send()
            .await
            .unwrap();
        let response_status = response.status();
        let cookie = response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let html = response.text().await.unwrap();
        assert_eq!(response_status, StatusCode::OK, "{html}");
        assert!(
            html.contains(&format!("{prefix}/preview/{port}/asset.js")),
            "{html}"
        );
        assert!(html.contains("var apiOrigin = window.location.origin;"));
        let response = client
            .get(format!("{}{prefix}/preview/{port}/asset.js", home.url))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.text().await.unwrap().contains("remoteAsset"));
        assert_eq!(
            client
                .get(format!("{}{prefix}/api/terminal", home.url))
                .header("cookie", &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let url = format!(
            "{}{prefix}/preview/{port}/echo",
            home.url.replacen("http://", "ws://", 1)
        );
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("cookie", cookie.parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
            .send(tungstenite::Message::Text("remote preview echo".into()))
            .await
            .unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(echoed.into_text().unwrap(), "remote preview echo");
        let _ = socket.close(None).await;
        upstream.abort();
    }

    #[tokio::test]
    async fn static_query_preview_uses_scoped_remote_cookie_without_credentials_in_assets() {
        let home = server().await;
        let target = server().await;
        let client = client().unwrap();
        let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap()
            .to_path_buf();
        let fixture = tempfile::Builder::new()
            .prefix("remote-static-preview-")
            .tempdir_in(project_root)
            .unwrap();
        std::fs::write(fixture.path().join("index.html"), "<link href='style.css'>").unwrap();
        std::fs::write(fixture.path().join("style.css"), "body { color: red }").unwrap();
        let pairing_code = code(&client, &target, "remote-owner").await;
        let environment = json_response(
            client
                .post(format!("{}/api/environments/connect", home.url))
                .bearer_auth(token(&home, "local-owner"))
                .json(&json!({"url":target.url,"code":pairing_code,"label":"Static preview host"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let id = environment["id"].as_str().unwrap();
        let prefix = format!("/api/environments/{id}/proxy");
        let home_token = token(&home, "local-owner");
        let response = client
            .get(format!("{}{prefix}/api/preview", home.url))
            .query(&[
                ("path", fixture.path().to_str().unwrap()),
                ("token", home_token.as_str()),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let html = response.text().await.unwrap();
        assert!(!html.contains(&home_token));
        assert!(!html.contains("tv4pair."));
        let asset = html
            .split("href='")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap()
            .replace("&amp;", "&");
        assert!(
            asset.starts_with(&format!("{prefix}/api/preview?")),
            "{html}"
        );
        assert_eq!(
            client
                .get(format!("{}{}", home.url, asset))
                .header("cookie", &cookie)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "body { color: red }"
        );
        assert_eq!(
            client
                .get(format!("{}{}", home.url, asset))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let stripped = crate::preview::auth_urls::strip_preview_token(&asset);
        assert_eq!(
            client
                .get(format!("{}{}", home.url, stripped))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{}{prefix}/api/terminal", home.url))
                .header("cookie", &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{}{prefix}/api/preview", home.url))
                .bearer_auth(token(&home, "other-local-owner"))
                .query(&[("path", fixture.path().to_str().unwrap())])
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn revocation_closes_an_existing_remote_event_stream() {
        let home = server().await;
        let target = server().await;
        let client = client().unwrap();
        let pairing_code = code(&client, &target, "remote-owner").await;
        let environment = json_response(
            client
                .post(format!("{}/api/environments/connect", home.url))
                .bearer_auth(token(&home, "local-owner"))
                .json(&json!({"url":target.url,"code":pairing_code,"label":"Stream host"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let id = environment["id"].as_str().unwrap();
        let stream = client
            .get(format!(
                "{}/api/environments/{id}/proxy/api/preview/5173/log-stream",
                home.url
            ))
            .bearer_auth(token(&home, "local-owner"))
            .send()
            .await
            .unwrap();
        assert_eq!(stream.status(), StatusCode::OK);
        assert!(stream
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("text/event-stream"));
        let grants = json_response(
            client
                .get(format!("{}/api/environments", target.url))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        client
            .delete(format!(
                "{}/api/environments/grants/{}",
                target.url,
                grants["grants"][0]["id"].as_str().unwrap()
            ))
            .bearer_auth(token(&target, "remote-owner"))
            .send()
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(9), stream.bytes())
            .await
            .expect("revoked stream must close")
            .unwrap();
    }

    #[tokio::test]
    async fn codes_are_single_use_expire_and_grants_cannot_manage_access() {
        let target = server().await;
        let client = client().unwrap();
        let pairing_code = code(&client, &target, "owner").await;
        assert_eq!(
            client
                .post(format!("{}/api/environments/exchange", target.url))
                .json(&json!({"code":"0".repeat(64)}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let result = json_response(
            client
                .post(format!("{}/api/environments/exchange", target.url))
                .json(&json!({"code":pairing_code}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            client
                .post(format!("{}/api/environments/exchange", target.url))
                .json(&json!({"code":pairing_code}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let credential = result["credential"].as_str().unwrap();
        assert!(authenticate_token(&target.state, credential, "/api/terminal").is_some());
        assert!(
            authenticate_token(&target.state, credential, "/api/environments/pairing-code")
                .is_none()
        );
        assert!(authenticate_token(&target.state, credential, "/api/vault").is_none());
        assert!(
            authenticate_token(&target.state, credential, "/api/workspace/../environments")
                .is_none()
        );
        let expired = code(&client, &target, "owner").await;
        storage(&target.state)
            .unwrap()
            .execute(
                "UPDATE paired_codes SET expires=?1 WHERE hash=?2",
                params![now() - 1, fingerprint(&expired)],
            )
            .unwrap();
        assert_eq!(
            client
                .post(format!("{}/api/environments/exchange", target.url))
                .json(&json!({"code":expired}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!("{}/api/environments/release", target.url))
                .bearer_auth(credential)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert!(authenticate_token(&target.state, credential, "/api/terminal").is_none());
    }
}

async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, ApiError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::bad_request("Unable to read remote response"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ApiError::bad_request(
                "Remote response exceeds its size limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn rewrite_preview(content: &str, prefix: &str) -> String {
    let pattern = regex_lite::Regex::new(r"/(?:api/)?preview(?:/|\?)")
        .expect("static preview path expression");
    let origin = regex_lite::Regex::new(r#"var apiOrigin = "[^"]*";"#)
        .expect("static preview origin expression");
    let content = origin.replace_all(content, "var apiOrigin = window.location.origin;");
    pattern
        .replace_all(&content, |captures: &regex_lite::Captures<'_>| {
            format!("{prefix}{}", &captures[0])
        })
        .into_owned()
}
#[cfg(test)]
mod preview_tests {
    use super::*;
    #[test]
    fn remote_preview_assets_keep_their_environment_prefix_once() {
        assert_eq!(
            rewrite_preview(
                r#"<script src="/preview/5173/main.js"></script><a href="/api/preview/5173/storage">"#,
                "/api/environments/remote/proxy"
            ),
            r#"<script src="/api/environments/remote/proxy/preview/5173/main.js"></script><a href="/api/environments/remote/proxy/api/preview/5173/storage">"#
        );
    }
}

fn event_stream_body(
    remote: reqwest::Response,
    state: AppState,
    user: AuthenticatedUser,
    id: String,
    environment: Environment,
    token: Option<String>,
    cookie: Option<String>,
) -> Body {
    let interval = tokio::time::interval(Duration::from_secs(2));
    let stream = futures_util::stream::unfold(
        (
            remote.bytes_stream().boxed(),
            interval,
            state,
            user,
            id,
            environment,
            token,
            cookie,
        ),
        |(mut remote, mut interval, state, user, id, environment, token, cookie)| async move {
            loop {
                tokio::select! {
                    chunk=remote.next()=>{
                        return chunk.map(|chunk|(chunk,(remote,interval,state,user,id,environment,token,cookie)));
                    },
                    _=interval.tick()=>{
                        let valid=match token.as_deref(){
                            Some(token)=>local_user(&state,token).is_ok(),
                            None=>cookie.as_deref().is_some_and(|credential|crate::auth::authenticate_runtime_preview_token(&state,credential,"/preview/").is_ok()),
                        };
                        if !valid || load_environment(&state,&user,&id).is_err() || !remote_available(&environment).await{return None;}
                    }
                }
            }
        },
    );
    Body::from_stream(stream)
}
