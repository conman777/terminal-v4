use crate::{
    auth::AuthenticatedUser,
    collaboration::structured_stream::{project_page, Cursor},
    state::AppState,
    ApiError,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    routing::{delete, get, post},
    Extension, Json, Router,
};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

const CREDENTIAL_PREFIX: &str = "tv4share.";
const DEFAULT_EXPIRY_SECONDS: i64 = 86_400;
const MIN_EXPIRY_SECONDS: i64 = 60;
const MAX_ACTIVE_PER_SESSION: i64 = 5;
const MAX_ACTIVE_PER_OWNER: i64 = 20;
const MAX_PENDING_PROPOSALS: i64 = 10;
const MAX_PROPOSAL_CHARS: usize = 4000;
const RETENTION_SECONDS: i64 = 30 * 86_400;
const SWEEP_INTERVAL_SECONDS: i64 = 30;
const PRIVATE: &str = "no-store";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/structured/sessions/{id}/shares",
            get(list).post(create),
        )
        .route(
            "/api/structured/sessions/{id}/shares/{share}",
            delete(revoke),
        )
        .route(
            "/api/structured/sessions/{id}/shares/{share}/proposals/{proposal}",
            post(decide),
        )
}

#[cfg(unix)]
pub(crate) fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/structured-share/exchange", post(exchange))
        .route(
            "/api/structured-share/guest/{session}/messages",
            get(messages),
        )
        .route(
            "/api/structured-share/guest/{session}/proposals",
            post(propose),
        )
}

#[cfg(not(unix))]
pub(crate) fn public_routes() -> Router<AppState> {
    unsupported_guest_routes()
}

#[cfg(any(test, not(unix)))]
fn unsupported_guest_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/structured-share/exchange",
            post(unsupported_guest_access),
        )
        .route(
            "/api/structured-share/guest/{session}/messages",
            get(unsupported_guest_access),
        )
        .route(
            "/api/structured-share/guest/{session}/proposals",
            post(unsupported_guest_access),
        )
}

#[cfg(any(test, not(unix)))]
async fn unsupported_guest_access() -> ApiError {
    unsupported_guest_platform()
}

#[cfg(any(test, not(unix)))]
fn unsupported_guest_platform() -> ApiError {
    ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: "Guest sharing is unavailable on this platform until secure authorization support is added".into(),
    }
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn denied() -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Share link is invalid, expired, or revoked".into(),
    }
}

fn limited() -> ApiError {
    ApiError {
        status: StatusCode::TOO_MANY_REQUESTS,
        message: "Too many requests. Wait a minute and try again".into(),
    }
}

fn storage<E>(_: E) -> ApiError {
    ApiError::internal("Share storage is unavailable")
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS structured_shares(
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL, incarnation TEXT NOT NULL,
  secret_hash TEXT NOT NULL, credential_hash TEXT UNIQUE, guest_name TEXT,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, redeemed INTEGER, last_seen INTEGER,
  revoked INTEGER, swept INTEGER, allow_messages INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS structured_shares_owner_session ON structured_shares(owner, session);
CREATE TABLE IF NOT EXISTS structured_share_proposals(
  id TEXT PRIMARY KEY, share TEXT NOT NULL, owner TEXT NOT NULL, session TEXT NOT NULL,
  guest_name TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
  status TEXT NOT NULL, decided INTEGER);
CREATE INDEX IF NOT EXISTS structured_share_proposals_share ON structured_share_proposals(share);
CREATE TABLE IF NOT EXISTS structured_share_audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, share TEXT NOT NULL, owner TEXT NOT NULL,
  session TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS structured_share_audit_owner ON structured_share_audit(owner, session);
";

fn db(state: &AppState) -> Result<std::sync::MutexGuard<'_, Connection>, ApiError> {
    let connection = state.lock_db().map_err(ApiError::internal)?;
    connection.execute_batch(SCHEMA).map_err(storage)?;
    Ok(connection)
}

struct ExchangeDb<'a> {
    connection: std::sync::MutexGuard<'a, Connection>,
    timeout_ms: u64,
}

impl std::ops::Deref for ExchangeDb<'_> {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl std::ops::DerefMut for ExchangeDb<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.connection
    }
}

impl Drop for ExchangeDb<'_> {
    fn drop(&mut self) {
        let _ = self
            .connection
            .busy_timeout(std::time::Duration::from_millis(self.timeout_ms));
    }
}

fn try_exchange_db(state: &AppState) -> Result<ExchangeDb<'_>, ApiError> {
    let connection = state.try_lock_db().map_err(|_| unavailable())?;
    let timeout_ms: u64 = connection
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .map_err(storage)?;
    connection
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(storage)?;
    let guard = ExchangeDb {
        connection,
        timeout_ms,
    };
    guard.execute_batch(SCHEMA).map_err(|_| unavailable())?;
    Ok(guard)
}

fn audit(
    db: &Connection,
    share: &str,
    owner: &str,
    session: &str,
    at: i64,
    kind: &str,
    detail: &str,
) {
    let detail: String = detail.chars().take(80).collect();
    let _ = db.execute(
        "INSERT INTO structured_share_audit(share,owner,session,at,kind,detail) VALUES (?1,?2,?3,?4,?5,?6)",
        params![share, owner, session, at, kind, detail],
    );
}

static LIMITS: LazyLock<Mutex<HashMap<String, (i64, u32)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn allow(key: &str, limit: u32, window: i64, at: i64) -> bool {
    let mut map = LIMITS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if map.len() > 4096 {
        map.retain(|_, (start, _)| at - *start < 3600);
    }
    let entry = map.entry(key.to_owned()).or_insert((at, 0));
    if at - entry.0 >= window {
        *entry = (at, 0);
    }
    if entry.1 >= limit {
        return false;
    }
    entry.1 += 1;
    true
}

pub(crate) fn sweep(db: &Connection, at: i64) -> rusqlite::Result<usize> {
    let expired: Vec<(String, String, String)> = {
        let mut statement = db.prepare(
            "SELECT id,owner,session FROM structured_shares WHERE expires<=?1 AND swept IS NULL",
        )?;
        let rows = statement.query_map([at], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, owner, session) in &expired {
        db.execute(
            "UPDATE structured_shares SET credential_hash=NULL, secret_hash='', swept=?2 WHERE id=?1",
            params![id, at],
        )?;
        db.execute(
            "UPDATE structured_share_proposals SET status='expired', decided=?2 WHERE share=?1 AND status='pending'",
            params![id, at],
        )?;
        audit(db, id, owner, session, at, "expired", "");
    }
    let cutoff = at - RETENTION_SECONDS;
    db.execute(
        "DELETE FROM structured_share_proposals WHERE share IN (SELECT id FROM structured_shares WHERE expires<?1)",
        [cutoff],
    )?;
    db.execute("DELETE FROM structured_shares WHERE expires<?1", [cutoff])?;
    db.execute("DELETE FROM structured_share_audit WHERE at<?1", [cutoff])?;
    Ok(expired.len())
}

fn maybe_sweep(db: &Connection, at: i64) {
    static LAST: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    let last = LAST.load(std::sync::atomic::Ordering::Relaxed);
    if at - last >= SWEEP_INTERVAL_SECONDS
        && LAST
            .compare_exchange(
                last,
                at,
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    {
        let _ = sweep(db, at);
    }
}

fn revoke_row(db: &Connection, share: &str, at: i64) -> rusqlite::Result<usize> {
    let changed = db.execute(
        "UPDATE structured_shares SET revoked=?2, credential_hash=NULL, secret_hash='' WHERE id=?1 AND revoked IS NULL",
        params![share, at],
    )?;
    db.execute(
        "UPDATE structured_share_proposals SET status='expired', decided=?2 WHERE share=?1 AND status='pending'",
        params![share, at],
    )?;
    Ok(changed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    expires_in_seconds: Option<i64>,
    allow_guest_messages: Option<bool>,
}

fn create_in_session(
    connection: &Connection,
    owner: &str,
    id: &str,
    incarnation: &str,
    seconds: i64,
    allow_messages: bool,
) -> Result<Json<Value>, ApiError> {
    let at = now();
    maybe_sweep(connection, at);
    let (per_session, per_owner): (i64, i64) = connection
        .query_row(
            "SELECT COALESCE(SUM(session=?2),0), COUNT(*) FROM structured_shares WHERE owner=?1 AND revoked IS NULL AND expires>?3",
            params![owner, id, at],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage)?;
    if per_session >= MAX_ACTIVE_PER_SESSION || per_owner >= MAX_ACTIVE_PER_OWNER {
        return Err(ApiError::bad_request(
            "Revoke an existing share link before creating another",
        ));
    }
    let share = uuid::Uuid::new_v4().to_string();
    let secret = token();
    let expires = at + seconds;
    connection
        .execute(
            "INSERT INTO structured_shares(id,owner,session,incarnation,secret_hash,created,expires,allow_messages) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![share, owner, id, incarnation, hash(&secret), at, expires, allow_messages],
        )
        .map_err(storage)?;
    audit(
        connection,
        &share,
        owner,
        id,
        at,
        "created",
        if allow_messages {
            "guest messages need approval"
        } else {
            "read only"
        },
    );
    Ok(Json(json!({
        "id": share, "secret": secret, "sessionId": id, "expiresAt": expires,
        "allowGuestMessages": allow_messages,
    })))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, ApiError> {
    let seconds = body.expires_in_seconds.unwrap_or(DEFAULT_EXPIRY_SECONDS);
    if !(MIN_EXPIRY_SECONDS..=DEFAULT_EXPIRY_SECONDS).contains(&seconds) {
        return Err(ApiError::bad_request(
            "Choose an expiry from 1 minute to 24 hours",
        ));
    }
    check_owner_scope(
        &local,
        &paired,
        "POST",
        &format!("/api/structured/sessions/{id}/shares"),
    )?;
    let owner = &user.user_id;
    load_owner_session(&state, owner, &local, &paired).await?;
    #[cfg(test)]
    if let Some(signal) = CREATE_WAITING.lock().unwrap().remove(&id) {
        let _ = signal.send(());
    }
    state
        .structured_session_manager()
        .with_cached_guest_view(owner, &id, |view| {
            with_share_authority(&state, owner, &local, &paired, |connection| {
                create_in_session(
                    connection,
                    owner,
                    &id,
                    &view.incarnation,
                    seconds,
                    body.allow_guest_messages.unwrap_or(false),
                )
            })
        })
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(|| ApiError::not_found("Conversation not found"))?
}

fn share_state(revoked: Option<i64>, expires: i64, redeemed: Option<i64>, at: i64) -> &'static str {
    if revoked.is_some() {
        "revoked"
    } else if expires <= at {
        "expired"
    } else if redeemed.is_some() {
        "active"
    } else {
        "unredeemed"
    }
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    Path(id): Path<String>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    check_owner_scope(
        &local,
        &paired,
        "GET",
        &format!("/api/structured/sessions/{id}/shares"),
    )?;
    with_share_authority(&state, &user.user_id, &local, &paired, |connection| {
        let at = now();
        maybe_sweep(connection, at);
        let mut statement = connection
        .prepare("SELECT id,created,expires,redeemed,guest_name,last_seen,revoked,allow_messages FROM structured_shares WHERE owner=?1 AND session=?2 ORDER BY created DESC LIMIT 50")
        .map_err(storage)?;
        let mut shares: Vec<Value> = statement
            .query_map(params![user.user_id, id], |row| {
                let revoked: Option<i64> = row.get(6)?;
                let expires: i64 = row.get(2)?;
                let redeemed: Option<i64> = row.get(3)?;
                Ok(json!({
                    "id": row.get::<_, String>(0)?, "createdAt": row.get::<_, i64>(1)?,
                    "expiresAt": expires, "redeemedAt": redeemed,
                    "guestName": row.get::<_, Option<String>>(4)?,
                    "lastSeenAt": row.get::<_, Option<i64>>(5)?, "revokedAt": revoked,
                    "allowGuestMessages": row.get::<_, i64>(7)? != 0,
                    "state": share_state(revoked, expires, redeemed, at),
                }))
            })
            .map_err(storage)?
            .collect::<Result<_, _>>()
            .map_err(storage)?;
        for share in &mut shares {
            let mut proposals = connection
            .prepare("SELECT id,guest_name,body,created,status FROM structured_share_proposals WHERE share=?1 AND owner=?2 ORDER BY created DESC LIMIT 50")
            .map_err(storage)?;
            let rows: Vec<Value> = proposals
                .query_map(
                    params![share["id"].as_str().unwrap_or_default(), user.user_id],
                    |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?, "guestName": row.get::<_, String>(1)?,
                            "text": row.get::<_, String>(2)?, "createdAt": row.get::<_, i64>(3)?,
                            "status": row.get::<_, String>(4)?,
                        }))
                    },
                )
                .map_err(storage)?
                .collect::<Result<_, _>>()
                .map_err(storage)?;
            share["proposals"] = json!(rows);
        }
        let mut trail = connection
        .prepare("SELECT share,at,kind,detail FROM structured_share_audit WHERE owner=?1 AND session=?2 ORDER BY seq DESC LIMIT 100")
        .map_err(storage)?;
        let audit_rows: Vec<Value> = trail
            .query_map(params![user.user_id, id], |row| {
                Ok(json!({
                    "shareId": row.get::<_, String>(0)?, "at": row.get::<_, i64>(1)?,
                    "kind": row.get::<_, String>(2)?, "detail": row.get::<_, String>(3)?,
                }))
            })
            .map_err(storage)?
            .collect::<Result<_, _>>()
            .map_err(storage)?;
        Ok((
            [(header::CACHE_CONTROL, PRIVATE)],
            Json(json!({"shares": shares, "audit": audit_rows})),
        ))
    })
}

async fn revoke(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    Path((id, share)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    check_owner_scope(
        &local,
        &paired,
        "DELETE",
        &format!("/api/structured/sessions/{id}/shares/{share}"),
    )?;
    with_share_authority(&state, &user.user_id, &local, &paired, |connection| {
        let at = now();
        let exists = connection
            .query_row(
                "SELECT 1 FROM structured_shares WHERE id=?1 AND owner=?2 AND session=?3",
                params![share, user.user_id, id],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        if !exists {
            return Err(ApiError::not_found("Share link not found"));
        }
        if revoke_row(connection, &share, at).map_err(storage)? == 1 {
            audit(connection, &share, &user.user_id, &id, at, "revoked", "");
        }
        Ok(StatusCode::NO_CONTENT)
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecideBody {
    decision: String,
}

#[cfg(test)]
static CREATE_WAITING: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
static DECIDE_WAITING: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn decide_in_session(
    connection: &Connection,
    owner: &str,
    id: &str,
    share: &str,
    proposal: &str,
    status: &str,
    incarnation: &str,
) -> Result<Json<Value>, ApiError> {
    let found: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT p.body,p.status,s.incarnation FROM structured_share_proposals p LEFT JOIN structured_shares s ON s.id=p.share AND s.owner=p.owner AND s.session=p.session WHERE p.id=?1 AND p.share=?2 AND p.owner=?3 AND p.session=?4",
            params![proposal, share, owner, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(storage)?;
    let Some((text, current, saved_incarnation)) = found else {
        return Err(ApiError::not_found("Guest message not found"));
    };
    if current != "pending" || saved_incarnation.as_deref() != Some(incarnation) {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: "This guest message was already handled or expired".into(),
        });
    }
    let at = now();
    let changed = connection
        .execute(
            "UPDATE structured_share_proposals SET status=?2, decided=?3 WHERE id=?1 AND share=?4 AND owner=?5 AND session=?6 AND status='pending' AND EXISTS (SELECT 1 FROM structured_shares WHERE id=?4 AND owner=?5 AND session=?6 AND incarnation=?7 AND expires>CAST(strftime('%s','now') AS INTEGER) AND revoked IS NULL AND swept IS NULL)",
            params![proposal, status, at, share, owner, id, incarnation],
        )
        .map_err(storage)?;
    if changed != 1 {
        connection
            .execute(
                "UPDATE structured_share_proposals SET status='expired', decided=?2 WHERE id=?1 AND share=?3 AND owner=?4 AND session=?5 AND status='pending' AND NOT EXISTS (SELECT 1 FROM structured_shares WHERE id=?3 AND owner=?4 AND session=?5 AND expires>CAST(strftime('%s','now') AS INTEGER) AND revoked IS NULL AND swept IS NULL)",
                params![proposal, at, share, owner, id],
            )
            .map_err(storage)?;
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            message: "This guest message was already handled or expired".into(),
        });
    }
    audit(connection, share, owner, id, at, status, "");
    Ok(Json(json!({
        "id": proposal, "status": status,
        "text": if status == "approved" { Value::String(text) } else { Value::Null },
    })))
}

fn owner_auth_error() -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Owner authorization expired or was revoked".into(),
    }
}

fn unavailable() -> ApiError {
    ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: "Owner authorization is temporarily unavailable".into(),
    }
}

fn check_owner_scope(
    local: &Option<Extension<crate::auth::LocalAuthority>>,
    paired: &Option<Extension<crate::auth::PairedInputAuthority>>,
    method: &str,
    expected: &str,
) -> Result<(), ApiError> {
    if local.is_some() == paired.is_some() {
        return Err(owner_auth_error());
    }
    if let Some(Extension(authority)) = paired {
        if authority.method != method || authority.path != expected {
            return Err(owner_auth_error());
        }
    }
    Ok(())
}

async fn load_owner_session(
    state: &AppState,
    owner: &str,
    local: &Option<Extension<crate::auth::LocalAuthority>>,
    paired: &Option<Extension<crate::auth::PairedInputAuthority>>,
) -> Result<(), ApiError> {
    state
        .structured_session_manager()
        .load_guest_owner_authorized(
            owner,
            state,
            local.as_ref().map(|Extension(a)| a),
            paired.as_ref().map(|Extension(a)| a),
        )
        .await
        .map_err(|e| {
            if e.contains("Credential") || e.contains("revoked") || e.contains("expired") {
                owner_auth_error()
            } else {
                unavailable()
            }
        })
}

fn with_share_authority<T>(
    state: &AppState,
    owner: &str,
    local: &Option<Extension<crate::auth::LocalAuthority>>,
    paired: &Option<Extension<crate::auth::PairedInputAuthority>>,
    action: impl FnOnce(&Connection) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    #[cfg(unix)]
    {
        let review = |tx: &rusqlite::Transaction<'_>, check: &dyn Fn() -> Result<(), String>| {
            check()?;
            let result = tx
                .execute_batch(SCHEMA)
                .map_err(storage)
                .and_then(|_| action(tx));
            check()?;
            Ok(result)
        };
        let result = if let Some(Extension(authority)) = local {
            state.try_with_owner_review(owner, authority, review)
        } else if let Some(Extension(authority)) = paired {
            state.try_with_paired_owner_review(owner, authority, review)
        } else {
            return Err(owner_auth_error());
        };
        result.map_err(|e| {
            if e.contains("Credential is invalid")
                || e.contains("Credential has been revoked")
                || e.contains("Paired grant expired")
                || e.contains("Paired grant does not authorize")
            {
                owner_auth_error()
            } else {
                unavailable()
            }
        })?
    }
    #[cfg(not(unix))]
    {
        let _ = (state, owner, local, paired, action);
        Err(unsupported_guest_platform())
    }
}

async fn decide(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    Path((id, share, proposal)): Path<(String, String, String)>,
    Json(body): Json<DecideBody>,
) -> Result<Json<Value>, ApiError> {
    let status = match body.decision.as_str() {
        "approve" => "approved",
        "dismiss" => "dismissed",
        _ => return Err(ApiError::bad_request("Decision must be approve or dismiss")),
    };
    check_owner_scope(
        &local,
        &paired,
        "POST",
        &format!("/api/structured/sessions/{id}/shares/{share}/proposals/{proposal}"),
    )?;
    let owner = &user.user_id;
    load_owner_session(&state, owner, &local, &paired).await?;
    #[cfg(test)]
    if let Some(signal) = DECIDE_WAITING.lock().unwrap().remove(&id) {
        let _ = signal.send(());
    }
    state
        .structured_session_manager()
        .with_cached_guest_view(owner, &id, |view| {
            with_share_authority(&state, owner, &local, &paired, |connection| {
                decide_in_session(
                    connection,
                    owner,
                    &id,
                    &share,
                    &proposal,
                    status,
                    &view.incarnation,
                )
            })
        })
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(|| ApiError::not_found("Conversation not found"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExchangeBody {
    id: String,
    secret: String,
    display_name: Option<String>,
}

fn clean_name(value: Option<&str>) -> String {
    let cleaned: String = value
        .unwrap_or("Guest")
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Guest".into()
    } else {
        trimmed.into()
    }
}

#[derive(Clone)]
struct Claim {
    owner: String,
    session: String,
    expires: i64,
    allow_messages: bool,
    incarnation: String,
    name: String,
    credential: String,
}

#[cfg(test)]
static FAIL_CLAIM_READ_ONCE: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

fn claim(state: &AppState, body: &ExchangeBody, at: i64) -> Result<Claim, ApiError> {
    let at = now().max(at);
    let credential = format!("{CREDENTIAL_PREFIX}{}", token());
    let name = clean_name(body.display_name.as_deref());
    let mut connection = try_exchange_db(state)?;
    maybe_sweep(&connection, at);
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| unavailable())?;
    let claimed = transaction
        .execute(
            "UPDATE structured_shares SET credential_hash=?3, redeemed=?4, last_seen=?4, guest_name=?5 WHERE id=?1 AND secret_hash=?2 AND expires>?4 AND revoked IS NULL AND credential_hash IS NULL AND swept IS NULL",
            params![body.id, hash(&body.secret), hash(&credential), at, name],
        )
        .map_err(storage)?;
    #[cfg(test)]
    if FAIL_CLAIM_READ_ONCE.lock().unwrap().remove(&body.id) {
        return Err(unavailable());
    }
    let row: Option<(String, String, i64, i64, String)> = transaction
        .query_row(
            "SELECT owner,session,expires,allow_messages,incarnation FROM structured_shares WHERE id=?1",
            [&body.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(storage)?;
    let Some((owner, session, expires, allow_messages, incarnation)) = row else {
        return Err(denied());
    };
    if claimed != 1 {
        audit(
            &transaction,
            &body.id,
            &owner,
            &session,
            at,
            "exchange_denied",
            "",
        );
        transaction.commit().map_err(storage)?;
        return Err(denied());
    }
    transaction.commit().map_err(storage)?;
    Ok(Claim {
        owner,
        session,
        expires,
        allow_messages: allow_messages != 0,
        incarnation,
        name,
        credential,
    })
}

#[cfg(test)]
static FAIL_SETTLE_ONCE: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

fn settle(
    state: &AppState,
    id: &str,
    claim: &Claim,
    title: Option<String>,
    at: i64,
) -> Result<String, ApiError> {
    #[cfg(test)]
    if FAIL_SETTLE_ONCE.lock().unwrap().remove(id) {
        return Err(unavailable());
    }
    let mut connection = try_exchange_db(state)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| unavailable())?;
    confirm_share_active(&transaction, id, &hash(&claim.credential), now())?;
    let Some(title) = title else {
        revoke_row(&transaction, id, at).map_err(storage)?;
        audit(
            &transaction,
            id,
            &claim.owner,
            &claim.session,
            at,
            "session_unavailable",
            "",
        );
        transaction.commit().map_err(storage)?;
        return Err(denied());
    };
    audit(
        &transaction,
        id,
        &claim.owner,
        &claim.session,
        at,
        "redeemed",
        &claim.name,
    );
    transaction.commit().map_err(storage)?;
    Ok(title)
}

fn release_transient_claim(state: &AppState, id: &str, claim: &Claim) -> Result<(), ApiError> {
    let connection = db(state)?;
    let released = connection.execute(
        "UPDATE structured_shares SET credential_hash=NULL, redeemed=NULL, last_seen=NULL, guest_name=NULL WHERE id=?1 AND credential_hash=?2 AND revoked IS NULL AND swept IS NULL AND expires>?3",
        params![id, hash(&claim.credential), now()],
    ).map_err(storage)?;
    if released != 1 {
        return Err(denied());
    }
    Ok(())
}

const GUEST_CLEANUP_CAPACITY: usize = 64;

struct GuestCleanupRequest {
    state: AppState,
    id: String,
    claim: Claim,
}

struct GuestCleanupQueue {
    sender: std::sync::mpsc::SyncSender<GuestCleanupRequest>,
    #[cfg(test)]
    started: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl GuestCleanupQueue {
    fn new(capacity: usize) -> Self {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<GuestCleanupRequest>(capacity);
        #[cfg(test)]
        let started = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        #[cfg(test)]
        let worker_started = started.clone();
        let _ = std::thread::Builder::new()
            .name("guest-claim-cleanup".into())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    #[cfg(test)]
                    worker_started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    for attempt in 0..5 {
                        match release_transient_claim(&request.state, &request.id, &request.claim) {
                            Ok(()) => break,
                            Err(error) if error.status == StatusCode::UNAUTHORIZED => break,
                            Err(_) if attempt < 4 => {
                                std::thread::sleep(std::time::Duration::from_millis(100))
                            }
                            Err(_) => {
                                tracing::warn!("Guest claim cleanup failed; link remains consumed");
                                break;
                            }
                        }
                    }
                }
            });
        Self {
            sender,
            #[cfg(test)]
            started,
        }
    }

    fn try_submit(&self, request: GuestCleanupRequest) -> bool {
        self.sender.try_send(request).is_ok()
    }
}

static GUEST_CLEANUP: LazyLock<GuestCleanupQueue> =
    LazyLock::new(|| GuestCleanupQueue::new(GUEST_CLEANUP_CAPACITY));

struct PendingExchangeClaim {
    state: AppState,
    id: String,
    claim: Claim,
    armed: bool,
}

impl Drop for PendingExchangeClaim {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let request = GuestCleanupRequest {
            state: self.state.clone(),
            id: self.id.clone(),
            claim: self.claim.clone(),
        };
        if !GUEST_CLEANUP.try_submit(request) {
            tracing::warn!("Guest claim cleanup is unavailable or full; link remains consumed");
        }
    }
}

#[cfg(test)]
static EXCHANGE_CLAIMED: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn exchange(
    State(state): State<AppState>,
    Json(body): Json<ExchangeBody>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let at = now();
    if body.id.len() > 64
        || body.secret.len() != 64
        || !body.secret.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    if !allow("exchange", 240, 60, at) || !allow(&format!("exchange:{}", body.id), 10, 60, at) {
        return Err(limited());
    }
    let claimed = claim(&state, &body, at)?;
    let mut pending = PendingExchangeClaim {
        state: state.clone(),
        id: body.id.clone(),
        claim: claimed.clone(),
        armed: true,
    };
    #[cfg(test)]
    if let Some(signal) = EXCHANGE_CLAIMED.lock().unwrap().remove(&body.id) {
        let _ = signal.send(());
    }
    let incarnation = claimed.incarnation.clone();
    let title = match state
        .structured_session_manager()
        .with_guest_view(&claimed.owner, &claimed.session, |view| {
            (view.incarnation == incarnation).then(|| view.title.to_owned())
        })
        .await
    {
        Ok(view) => view.flatten(),
        Err(_) => {
            return Err(ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "Conversation is temporarily unavailable; check the share with its owner before retrying".into(),
            });
        }
    };
    let title = settle(&state, &body.id, &claimed, title, at)?;
    // After this point a lost response is ambiguous; do not make the link reusable.
    pending.armed = false;
    Ok((
        [(header::CACHE_CONTROL, PRIVATE)],
        Json(json!({
            "credential": claimed.credential, "sessionId": claimed.session, "expiresAt": claimed.expires,
            "allowGuestMessages": claimed.allow_messages,
            "title": crate::session_search::safe_history_text(&title).chars().take(200).collect::<String>(),
        })),
    ))
}

struct Guest {
    share: String,
    owner: String,
    session: String,
    incarnation: String,
    allow_messages: bool,
    name: String,
    credential_hash: String,
}

fn confirm_share_active(
    connection: &Connection,
    share: &str,
    credential_hash: &str,
    at: i64,
) -> Result<(), ApiError> {
    let active = connection
        .query_row(
            "SELECT 1 FROM structured_shares WHERE id=?1 AND credential_hash=?2 AND expires>?3 AND revoked IS NULL AND swept IS NULL",
            params![share, credential_hash, at],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage)?;
    active.ok_or_else(denied)
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    session: &str,
    at: i64,
) -> Result<Guest, ApiError> {
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| {
            value.len() == CREDENTIAL_PREFIX.len() + 64
                && value.starts_with(CREDENTIAL_PREFIX)
                && value[CREDENTIAL_PREFIX.len()..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or_else(denied)?;
    let credential_hash = hash(credential);
    let connection = db(state)?;
    maybe_sweep(&connection, at);
    let guest = connection
        .query_row(
            "SELECT id,owner,session,incarnation,allow_messages,COALESCE(guest_name,'Guest'),last_seen FROM structured_shares WHERE credential_hash=?1 AND session=?2 AND expires>?3 AND revoked IS NULL AND swept IS NULL",
            params![credential_hash, session, at],
            |row| {
                Ok((
                    Guest {
                        share: row.get(0)?,
                        owner: row.get(1)?,
                        session: row.get(2)?,
                        incarnation: row.get(3)?,
                        allow_messages: row.get::<_, i64>(4)? != 0,
                        name: row.get(5)?,
                        credential_hash: credential_hash.clone(),
                    },
                    row.get::<_, Option<i64>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(storage)?
        .ok_or_else(denied)?;
    if guest.1.is_none_or(|seen| at - seen >= 5) {
        let _ = connection.execute(
            "UPDATE structured_shares SET last_seen=?2 WHERE id=?1",
            params![guest.0.share, at],
        );
    }
    Ok(guest.0)
}

#[derive(Deserialize)]
struct MessagesQuery {
    after: Option<i64>,
    generation: Option<String>,
}

async fn messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let at = now();
    let guest = authorize(&state, &headers, &session, at)?;
    if !allow(&format!("read:{}", guest.share), 120, 60, at) {
        return Err(limited());
    }
    let after = query.after.unwrap_or(0).max(0);
    let requested = query.generation;
    let incarnation = guest.incarnation.clone();
    let outcome = state
        .structured_session_manager()
        .with_guest_view(&guest.owner, &guest.session, move |view| {
            if view.incarnation != incarnation {
                return Err("replaced");
            }
            let generation = requested.as_deref().unwrap_or(&view.incarnation);
            let page = project_page(
                view.events,
                &view.incarnation,
                Cursor { generation, seq: after },
                100,
                128 * 1024,
            )
            .map_err(|reason| if reason.contains("snapshot") { "snapshot" } else { "cursor" })?;
            let last = view.events.last().map_or(0, |event| event.seq());
            Ok(json!({
                "generation": view.incarnation,
                "cursor": page.cursor.seq,
                "messages": page.messages,
                "omitted": page.omitted,
                "caughtUp": page.cursor.seq >= last,
                "title": crate::session_search::safe_history_text(view.title).chars().take(200).collect::<String>(),
            }))
        })
        .await
        .map_err(|_| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "The conversation is temporarily unavailable".into(),
        })?;
    let connection = db(&state)?;
    confirm_share_active(&connection, &guest.share, &guest.credential_hash, now())?;
    let mut value = match outcome {
        Some(Ok(value)) => value,
        Some(Err("cursor")) => {
            return Err(ApiError {
                status: StatusCode::CONFLICT,
                message: "The conversation changed. Reload to continue".into(),
            })
        }
        Some(Err("snapshot")) => {
            return Err(ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "This conversation cannot be shown right now".into(),
            })
        }
        Some(Err(_)) | None => {
            if revoke_row(&connection, &guest.share, at).map_err(storage)? == 1 {
                audit(
                    &connection,
                    &guest.share,
                    &guest.owner,
                    &guest.session,
                    at,
                    "session_unavailable",
                    "",
                );
            }
            return Err(denied());
        }
    };
    let mut statement = connection
        .prepare("SELECT id,status FROM structured_share_proposals WHERE share=?1 ORDER BY created DESC LIMIT 20")
        .map_err(storage)?;
    let proposals: Vec<Value> = statement
        .query_map([&guest.share], |row| {
            Ok(json!({"id": row.get::<_, String>(0)?, "status": row.get::<_, String>(1)?}))
        })
        .map_err(storage)?
        .collect::<Result<_, _>>()
        .map_err(storage)?;
    value["allowGuestMessages"] = json!(guest.allow_messages);
    value["proposals"] = json!(proposals);
    Ok(([(header::CACHE_CONTROL, PRIVATE)], Json(value)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeBody {
    text: String,
}

fn insert_guest_proposal(
    connection: &Connection,
    guest: &Guest,
    id: &str,
    text: &str,
    at: i64,
) -> Result<(), ApiError> {
    let inserted = connection
        .execute(
            "INSERT INTO structured_share_proposals(id,share,owner,session,guest_name,body,created,status) SELECT ?1,id,owner,session,?5,?6,?7,'pending' FROM structured_shares WHERE id=?2 AND owner=?3 AND session=?4 AND incarnation=?8 AND credential_hash=?9 AND expires>?7 AND revoked IS NULL AND swept IS NULL AND allow_messages<>0",
            params![id, guest.share, guest.owner, guest.session, guest.name, text, at, guest.incarnation, guest.credential_hash],
        )
        .map_err(storage)?;
    if inserted != 1 {
        return Err(denied());
    }
    Ok(())
}

async fn propose(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session): Path<String>,
    Json(body): Json<ProposeBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let at = now();
    let guest = authorize(&state, &headers, &session, at)?;
    if !guest.allow_messages {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "This share link is read-only".into(),
        });
    }
    if !allow(&format!("propose:{}", guest.share), 6, 60, at) {
        return Err(limited());
    }
    let text = body.text.trim();
    if text.is_empty()
        || text.chars().count() > MAX_PROPOSAL_CHARS
        || text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(ApiError::bad_request(
            "Write a message of up to 4000 characters without control characters",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    state
        .structured_session_manager()
        .with_guest_view(&guest.owner, &guest.session, |view| {
            if view.incarnation != guest.incarnation {
                return Err(denied());
            }
            let connection = db(&state)?;
            let pending: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM structured_share_proposals WHERE share=?1 AND status='pending'",
                    [&guest.share],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if pending >= MAX_PENDING_PROPOSALS {
                return Err(limited());
            }
            let committed_at = now();
            insert_guest_proposal(&connection, &guest, &id, text, committed_at)?;
            audit(
                &connection,
                &guest.share,
                &guest.owner,
                &guest.session,
                committed_at,
                "message_proposed",
                &guest.name,
            );
            Ok(())
        })
        .await
        .map_err(|_| ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "The conversation is temporarily unavailable".into(),
        })?
        .ok_or_else(denied)??;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id": id, "status": "pending"})),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use terminal_v4_core::{AppConfig, StructuredSessionEvent};
    use tower::ServiceExt;

    struct Fixture {
        state: AppState,
        app: Router,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
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
        Fixture {
            app: crate::app(state.clone()),
            state,
            _dir: dir,
        }
    }

    fn jwt(f: &Fixture, owner: &str) -> String {
        crate::auth::issue_access_token(&f.state.config().jwt_secret, owner, owner)
    }

    async fn call(
        f: &Fixture,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = bearer {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let payload = match body {
            Some(value) => {
                request = request.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            f.app.clone().oneshot(request.body(payload).unwrap()),
        )
        .await
        .expect("request timed out")
        .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn conversation(f: &Fixture, owner: &str) -> String {
        let dir = f._dir.path().to_str().unwrap().to_owned();
        f.state
            .structured_session_manager()
            .create_session(owner, &dir, Some("claude"), None, None)
            .await
            .unwrap()
            .id
    }

    fn event(value: Value) -> StructuredSessionEvent {
        serde_json::from_value(value).unwrap()
    }

    async fn seed(f: &Fixture, owner: &str, id: &str) {
        let manager = f.state.structured_session_manager();
        for value in [
            json!({"type":"user_message_accepted","ts":1,"seq":1,"requestId":"r","turnId":"t","messageId":"u1","content":"first question"}),
            json!({"type":"tool_output","ts":2,"seq":2,"toolName":"Bash","output":"PRIVATE-TOOL-OUTPUT"}),
            json!({"type":"message_completed","ts":3,"seq":3,"role":"assistant","messageId":"a1","turnId":"t","content":"first answer"}),
            json!({"type":"message_completed","ts":4,"seq":4,"role":"assistant","messageId":"a2","turnId":"t","content":"second answer"}),
        ] {
            manager.push_event_for_test(owner, id, event(value)).await;
        }
    }

    async fn share(f: &Fixture, owner: &str, id: &str, body: Value) -> Value {
        let (status, value) = call(
            f,
            "POST",
            &format!("/api/structured/sessions/{id}/shares"),
            Some(&jwt(f, owner)),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }

    async fn redeem(f: &Fixture, issued: &Value) -> (StatusCode, Value) {
        call(
            f,
            "POST",
            "/api/structured-share/exchange",
            None,
            Some(json!({"id": issued["id"], "secret": issued["secret"], "displayName": "Visitor"})),
        )
        .await
    }

    async fn read(
        f: &Fixture,
        credential: &str,
        session: &str,
        query: &str,
    ) -> (StatusCode, Value) {
        call(
            f,
            "GET",
            &format!("/api/structured-share/guest/{session}/messages{query}"),
            Some(credential),
            None,
        )
        .await
    }

    #[tokio::test]
    async fn guest_reads_only_conversation_text_and_revocation_applies_to_the_next_request() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        seed(&f, "owner", &id).await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (status, guest) = redeem(&f, &issued).await;
        assert_eq!(status, StatusCode::OK);
        let credential = guest["credential"].as_str().unwrap().to_owned();
        let (status, page) = read(&f, &credential, &id, "").await;
        assert_eq!(status, StatusCode::OK);
        let texts: Vec<_> = page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["role"].as_str().unwrap().to_owned(),
                    m["text"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                ("user".into(), "first question".into()),
                ("assistant".into(), "first answer".into()),
                ("assistant".into(), "second answer".into())
            ]
        );
        assert!(!page.to_string().contains("PRIVATE-TOOL-OUTPUT"));
        assert_eq!(page["caughtUp"], json!(true));
        let (_, later) = read(&f, &credential, &id, "?after=3").await;
        assert_eq!(later["messages"].as_array().unwrap().len(), 1);
        let (status, _) = call(
            &f,
            "DELETE",
            &format!(
                "/api/structured/sessions/{id}/shares/{}",
                issued["id"].as_str().unwrap()
            ),
            Some(&jwt(&f, "owner")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            read(&f, &credential, &id, "").await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn guest_reads_mask_a_private_key_whose_markers_span_new_messages() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let manager = f.state.structured_session_manager();
        manager
            .push_event_for_test(
                "owner",
                &id,
                event(json!({
                    "type":"message_completed", "ts":1, "seq":1,
                    "role":"assistant", "messageId":"a1", "content":"-----BEGIN PRI",
                })),
            )
            .await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (_, credentials) = redeem(&f, &issued).await;
        let credential = credentials["credential"].as_str().unwrap();
        let (status, first) = read(&f, credential, &id, "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["cursor"], json!(1));

        for value in [
            json!({"type":"message_completed", "ts":2, "seq":2, "role":"assistant", "messageId":"a2", "content":"VATE KEY-----\nprivate-fragment\n-----END PRI"}),
            json!({"type":"message_completed", "ts":3, "seq":3, "role":"assistant", "messageId":"a3", "content":"VATE KEY-----\nprivate-tail"}),
            json!({"type":"message_completed", "ts":4, "seq":4, "role":"assistant", "messageId":"a4", "content":"ordinary answer"}),
        ] {
            manager
                .push_event_for_test("owner", &id, event(value))
                .await;
        }
        let (status, next) = read(&f, credential, &id, "?after=1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            next["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["[redacted]", "[redacted]", "ordinary answer"],
        );
    }

    #[tokio::test]
    async fn revoked_guest_cannot_read_a_page_waiting_on_the_conversation() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        seed(&f, "owner", &id).await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (_, guest) = redeem(&f, &issued).await;
        let credential = guest["credential"].as_str().unwrap().to_owned();
        let share_id = issued["id"].as_str().unwrap().to_owned();
        f.state
            .lock_db()
            .unwrap()
            .execute(
                "UPDATE structured_shares SET last_seen=0 WHERE id=?1",
                [&share_id],
            )
            .unwrap();

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let manager = f.state.structured_session_manager();
        let held_id = id.clone();
        let holder = tokio::spawn(async move {
            manager
                .hold_guest_view_for_test("owner", &held_id, entered_tx, release_rx)
                .await;
        });
        entered_rx.await.unwrap();

        let app = f.app.clone();
        let guest_id = id.clone();
        let waiting = tokio::spawn(async move {
            let request = Request::builder()
                .uri(format!("/api/structured-share/guest/{guest_id}/messages"))
                .header("authorization", format!("Bearer {credential}"))
                .body(Body::empty())
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let seen: i64 = f
                    .state
                    .lock_db()
                    .unwrap()
                    .query_row(
                        "SELECT last_seen FROM structured_shares WHERE id=?1",
                        [&share_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                if seen > 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("guest read did not reach authorization");
        assert_eq!(
            call(
                &f,
                "DELETE",
                &format!("/api/structured/sessions/{id}/shares/{share_id}"),
                Some(&jwt(&f, "owner")),
                None,
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        release_tx.send(()).unwrap();
        holder.await.unwrap();
        assert_eq!(waiting.await.unwrap(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revoked_link_cannot_exchange_while_waiting_on_the_conversation() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let share_id = issued["id"].as_str().unwrap().to_owned();
        let secret = issued["secret"].as_str().unwrap().to_owned();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let manager = f.state.structured_session_manager();
        let held_id = id.clone();
        let holder = tokio::spawn(async move {
            manager
                .hold_guest_view_for_test("owner", &held_id, entered_tx, release_rx)
                .await;
        });
        entered_rx.await.unwrap();
        let app = f.app.clone();
        let waiting_id = share_id.clone();
        let waiting = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri("/api/structured-share/exchange")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"id": waiting_id, "secret": secret}).to_string(),
                ))
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let redeemed: Option<i64> = f
                    .state
                    .lock_db()
                    .unwrap()
                    .query_row(
                        "SELECT redeemed FROM structured_shares WHERE id=?1",
                        [&share_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                if redeemed.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("exchange did not claim the share");
        assert_eq!(
            call(
                &f,
                "DELETE",
                &format!("/api/structured/sessions/{id}/shares/{share_id}"),
                Some(&jwt(&f, "owner")),
                None,
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        release_tx.send(()).unwrap();
        holder.await.unwrap();
        assert_eq!(waiting.await.unwrap(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn claim_read_failure_rolls_back_provisional_redemption() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        FAIL_CLAIM_READ_ONCE
            .lock()
            .unwrap()
            .insert(issued["id"].as_str().unwrap().into());
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_does_not_wait_on_the_shared_database_mutex() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let locked_state = f.state.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = locked_state.lock_db().unwrap();
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(std::time::Duration::from_secs(4));
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(4))
            .unwrap();
        let app = f.app.clone();
        let request = Request::builder()
            .method("POST")
            .uri("/api/structured-share/exchange")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"id": issued["id"], "secret": issued["secret"]}).to_string(),
            ))
            .unwrap();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            tokio::spawn(app.oneshot(request)),
        )
        .await;
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(
            response
                .expect("exchange blocked on the shared database mutex")
                .unwrap()
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_does_not_wait_for_another_sqlite_writer_and_restores_timeout() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        f.state
            .lock_db()
            .unwrap()
            .busy_timeout(std::time::Duration::from_millis(4200))
            .unwrap();
        let db_path = f.state.config().data_dir.join("terminal.db");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let connection = Connection::open(db_path).unwrap();
            connection.execute_batch("BEGIN IMMEDIATE").unwrap();
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(std::time::Duration::from_secs(4));
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(4))
            .unwrap();
        let started = std::time::Instant::now();
        let status = redeem(&f, &issued).await.0;
        let elapsed = started.elapsed();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "exchange waited {elapsed:?}"
        );
        let timeout_ms: i64 = f
            .state
            .lock_db()
            .unwrap()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout_ms, 4200);
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settlement_does_not_wait_on_the_shared_database_mutex() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let manager = f.state.structured_session_manager();
        let held_id = id.clone();
        let (view_entered, view_ready) = tokio::sync::oneshot::channel();
        let (view_release, release_view) = tokio::sync::oneshot::channel();
        let holder = tokio::spawn(async move {
            manager
                .hold_guest_view_for_test("owner", &held_id, view_entered, release_view)
                .await
        });
        view_ready.await.unwrap();
        let (claim_signal, claim_ready) = tokio::sync::oneshot::channel();
        EXCHANGE_CLAIMED
            .lock()
            .unwrap()
            .insert(issued["id"].as_str().unwrap().into(), claim_signal);
        let app = f.app.clone();
        let request = Request::builder()
            .method("POST")
            .uri("/api/structured-share/exchange")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"id": issued["id"], "secret": issued["secret"]}).to_string(),
            ))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
        tokio::time::timeout(std::time::Duration::from_secs(3), claim_ready)
            .await
            .unwrap()
            .unwrap();
        let locked_state = f.state.clone();
        let (db_entered, db_ready) = std::sync::mpsc::channel();
        let (db_release, release_db) = std::sync::mpsc::channel();
        let lock_holder = std::thread::spawn(move || {
            let _guard = locked_state.lock_db().unwrap();
            db_entered.send(()).unwrap();
            let _ = release_db.recv_timeout(std::time::Duration::from_secs(4));
        });
        db_ready
            .recv_timeout(std::time::Duration::from_secs(4))
            .unwrap();
        view_release.send(()).unwrap();
        holder.await.unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), pending).await;
        db_release.send(()).unwrap();
        lock_holder.join().unwrap();
        assert_eq!(
            response
                .expect("settlement blocked on the shared database mutex")
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let credential: Option<String> = db(&f.state)
                    .unwrap()
                    .query_row(
                        "SELECT credential_hash FROM structured_shares WHERE id=?1",
                        [issued["id"].as_str().unwrap()],
                        |row| row.get(0),
                    )
                    .unwrap();
                if credential.is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn transient_guest_lookup_releases_only_the_provisional_claim() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        f.state
            .structured_session_manager()
            .fail_guest_view_once_for_test(&id, entered_tx, release_rx);
        let app = f.app.clone();
        let request = Request::builder()
            .method("POST")
            .uri("/api/structured-share/exchange")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"id":issued["id"], "secret":issued["secret"]}).to_string(),
            ))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap().status() });
        entered_rx.await.unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(pending.await.unwrap(), StatusCode::SERVICE_UNAVAILABLE);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let credential: Option<String> = db(&f.state)
                    .unwrap()
                    .query_row(
                        "SELECT credential_hash FROM structured_shares WHERE id=?1",
                        [issued["id"].as_str().unwrap()],
                        |row| row.get(0),
                    )
                    .unwrap();
                if credential.is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("lookup failure did not release its claim");
        let status = redeem(&f, &issued).await.0;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn transient_release_cannot_clear_a_replaced_or_expired_claim() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        for mode in ["replaced", "expired"] {
            let issued = share(&f, "owner", &id, json!({})).await;
            let share_id = issued["id"].as_str().unwrap();
            let input = ExchangeBody {
                id: share_id.into(),
                secret: issued["secret"].as_str().unwrap().into(),
                display_name: None,
            };
            let claimed = claim(&f.state, &input, now()).unwrap();
            let connection = db(&f.state).unwrap();
            if mode == "replaced" {
                connection
                    .execute(
                        "UPDATE structured_shares SET credential_hash='replacement' WHERE id=?1",
                        [share_id],
                    )
                    .unwrap();
            } else {
                connection
                    .execute(
                        "UPDATE structured_shares SET expires=0 WHERE id=?1",
                        [share_id],
                    )
                    .unwrap();
            }
            drop(connection);
            assert_eq!(
                release_transient_claim(&f.state, share_id, &claimed)
                    .unwrap_err()
                    .status,
                StatusCode::UNAUTHORIZED
            );
            let saved: (Option<String>, Option<i64>) = db(&f.state)
                .unwrap()
                .query_row(
                    "SELECT credential_hash, redeemed FROM structured_shares WHERE id=?1",
                    [share_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!(saved.0.is_some(), "{mode} claim was cleared");
            assert!(saved.1.is_some(), "{mode} redemption was cleared");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cleanup_queue_saturates_without_spawning_more_workers_or_releasing_overflow() {
        use std::sync::atomic::Ordering;
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let mut claims = Vec::new();
        for _ in 0..4 {
            let issued = share(&f, "owner", &id, json!({})).await;
            let input = ExchangeBody {
                id: issued["id"].as_str().unwrap().into(),
                secret: issued["secret"].as_str().unwrap().into(),
                display_name: None,
            };
            let claim = claim(&f.state, &input, now()).unwrap();
            claims.push((input.id, claim));
        }
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let locked_state = f.state.clone();
        let holder = std::thread::spawn(move || {
            let _guard = locked_state.lock_db().unwrap();
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(std::time::Duration::from_secs(5));
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let queue = GuestCleanupQueue::new(2);
        let submit = |index: usize| {
            queue.try_submit(GuestCleanupRequest {
                state: f.state.clone(),
                id: claims[index].0.clone(),
                claim: claims[index].1.clone(),
            })
        };
        assert!(submit(0));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while queue.started.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("cleanup worker did not start");
        let admitted = [submit(1), submit(2), submit(3)];
        let started_while_locked = queue.started.load(Ordering::SeqCst);
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(admitted, [true, true, false]);
        assert_eq!(started_while_locked, 1);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let connection = db(&f.state).unwrap();
                let cleared: i64 = connection.query_row("SELECT COUNT(*) FROM structured_shares WHERE id IN (?1,?2,?3) AND credential_hash IS NULL", params![claims[0].0, claims[1].0, claims[2].0], |row| row.get(0)).unwrap();
                drop(connection);
                if cleared == 3 { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("queued cleanup did not complete");
        let overflow: Option<String> = db(&f.state)
            .unwrap()
            .query_row(
                "SELECT credential_hash FROM structured_shares WHERE id=?1",
                [&claims[3].0],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            overflow.is_some(),
            "queue overflow must leave its link consumed"
        );
    }

    #[tokio::test]
    async fn cancelled_exchange_releases_its_active_provisional_claim() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (_release_tx, release_rx) = tokio::sync::oneshot::channel();
        f.state
            .structured_session_manager()
            .fail_guest_view_once_for_test(&id, entered_tx, release_rx);
        let app = f.app.clone();
        let request = Request::builder()
            .method("POST")
            .uri("/api/structured-share/exchange")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"id": issued["id"], "secret": issued["secret"]}).to_string(),
            ))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
        entered_rx.await.unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let credential: Option<String> = db(&f.state)
                    .unwrap()
                    .query_row(
                        "SELECT credential_hash FROM structured_shares WHERE id=?1",
                        [issued["id"].as_str().unwrap()],
                        |row| row.get(0),
                    )
                    .unwrap();
                if credential.is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled exchange did not release its claim");
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn cancellation_after_revocation_does_not_restore_the_link() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (_release_tx, release_rx) = tokio::sync::oneshot::channel();
        f.state
            .structured_session_manager()
            .fail_guest_view_once_for_test(&id, entered_tx, release_rx);
        let app = f.app.clone();
        let request = Request::builder()
            .method("POST")
            .uri("/api/structured-share/exchange")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"id": issued["id"], "secret": issued["secret"]}).to_string(),
            ))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
        entered_rx.await.unwrap();
        assert_eq!(
            call(
                &f,
                "DELETE",
                &format!(
                    "/api/structured/sessions/{id}/shares/{}",
                    issued["id"].as_str().unwrap()
                ),
                Some(&jwt(&f, "owner")),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::UNAUTHORIZED);
        let revoked: Option<i64> = db(&f.state)
            .unwrap()
            .query_row(
                "SELECT revoked FROM structured_shares WHERE id=?1",
                [issued["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(revoked.is_some());
    }

    #[tokio::test]
    async fn transient_settlement_failure_releases_the_claim_for_retry() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        FAIL_SETTLE_ONCE
            .lock()
            .unwrap()
            .insert(issued["id"].as_str().unwrap().into());
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::SERVICE_UNAVAILABLE);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let credential: Option<String> = db(&f.state)
                    .unwrap()
                    .query_row(
                        "SELECT credential_hash FROM structured_shares WHERE id=?1",
                        [issued["id"].as_str().unwrap()],
                        |row| row.get(0),
                    )
                    .unwrap();
                if credential.is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("settlement failure did not release its claim");
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn transient_guest_lookup_does_not_undo_a_concurrent_revocation() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        f.state
            .structured_session_manager()
            .fail_guest_view_once_for_test(&id, entered_tx, release_rx);
        let app = f.app.clone();
        let request = Request::builder()
            .method("POST")
            .uri("/api/structured-share/exchange")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"id":issued["id"], "secret":issued["secret"]}).to_string(),
            ))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap().status() });
        entered_rx.await.unwrap();
        assert_eq!(
            call(
                &f,
                "DELETE",
                &format!(
                    "/api/structured/sessions/{id}/shares/{}",
                    issued["id"].as_str().unwrap()
                ),
                Some(&jwt(&f, "owner")),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        release_tx.send(()).unwrap();
        assert_eq!(pending.await.unwrap(), StatusCode::SERVICE_UNAVAILABLE);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                match redeem(&f, &issued).await.0 {
                    StatusCode::UNAUTHORIZED => break,
                    StatusCode::SERVICE_UNAVAILABLE => {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await
                    }
                    status => panic!("revoked link returned {status}"),
                }
            }
        })
        .await
        .expect("revoked link remained busy");
    }

    #[tokio::test]
    async fn link_is_one_use_and_replay_is_audited_without_new_access() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (_, first) = redeem(&f, &issued).await;
        assert_eq!(redeem(&f, &issued).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            read(&f, first["credential"].as_str().unwrap(), &id, "")
                .await
                .0,
            StatusCode::OK
        );
        let (_, listing) = call(
            &f,
            "GET",
            &format!("/api/structured/sessions/{id}/shares"),
            Some(&jwt(&f, "owner")),
            None,
        )
        .await;
        let kinds: Vec<_> = listing["audit"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(kinds, vec!["exchange_denied", "redeemed", "created"]);
        assert_eq!(listing["shares"][0]["state"], json!("active"));
    }

    #[tokio::test]
    async fn expiry_invalidates_link_and_credential_and_sweep_removes_stored_hashes() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let unredeemed = share(&f, "owner", &id, json!({"expiresInSeconds": 60})).await;
        let redeemed = share(&f, "owner", &id, json!({})).await;
        let (_, guest) = redeem(&f, &redeemed).await;
        let credential = guest["credential"].as_str().unwrap();
        {
            let connection = f.state.lock_db().unwrap();
            connection
                .execute("UPDATE structured_shares SET expires=?1", [now() - 1])
                .unwrap();
        }
        assert_eq!(redeem(&f, &unredeemed).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            read(&f, credential, &id, "").await.0,
            StatusCode::UNAUTHORIZED
        );
        {
            let connection = f.state.lock_db().unwrap();
            sweep(&connection, now()).unwrap();
            let expired_entries: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM structured_share_audit WHERE kind='expired'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(expired_entries, 2);
            let live: i64 = connection.query_row("SELECT COUNT(*) FROM structured_shares WHERE credential_hash IS NOT NULL OR secret_hash<>''", [], |r| r.get(0)).unwrap();
            assert_eq!(live, 0);
            assert_eq!(sweep(&connection, now()).unwrap(), 0);
            sweep(&connection, now() + RETENTION_SECONDS + 10).unwrap();
            let rows: i64 = connection
                .query_row("SELECT COUNT(*) FROM structured_shares", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 0);
        }
    }

    #[tokio::test]
    async fn default_expiry_is_24_hours_and_out_of_range_values_are_rejected() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let before = now();
        let issued = share(&f, "owner", &id, json!({})).await;
        let expires = issued["expiresAt"].as_i64().unwrap();
        assert!((before + 86_400..=now() + 86_400).contains(&expires));
        for seconds in [0, 59, 86_401] {
            let (status, _) = call(
                &f,
                "POST",
                &format!("/api/structured/sessions/{id}/shares"),
                Some(&jwt(&f, "owner")),
                Some(json!({"expiresInSeconds": seconds})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{seconds}");
        }
    }

    #[tokio::test]
    async fn a_share_cannot_read_another_conversation_or_be_managed_by_another_owner() {
        let f = fixture();
        let a = conversation(&f, "owner").await;
        let b = conversation(&f, "owner").await;
        let other = conversation(&f, "stranger").await;
        seed(&f, "owner", &b).await;
        let issued = share(&f, "owner", &a, json!({})).await;
        let (_, guest) = redeem(&f, &issued).await;
        let credential = guest["credential"].as_str().unwrap();
        assert_eq!(
            read(&f, credential, &b, "").await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            read(&f, credential, &other, "").await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(read(&f, credential, &a, "").await.0, StatusCode::OK);
        let stranger = jwt(&f, "stranger");
        let (status, _) = call(
            &f,
            "POST",
            &format!("/api/structured/sessions/{a}/shares"),
            Some(&stranger),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, listing) = call(
            &f,
            "GET",
            &format!("/api/structured/sessions/{a}/shares"),
            Some(&stranger),
            None,
        )
        .await;
        assert_eq!(listing["shares"], json!([]));
        let (status, _) = call(
            &f,
            "DELETE",
            &format!(
                "/api/structured/sessions/{a}/shares/{}",
                issued["id"].as_str().unwrap()
            ),
            Some(&stranger),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(read(&f, credential, &a, "").await.0, StatusCode::OK);
        let (status, _) = call(
            &f,
            "POST",
            &format!("/api/structured/sessions/{other}/shares"),
            Some(&jwt(&f, "owner")),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn secrets_and_credentials_are_stored_only_as_hashes() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (_, guest) = redeem(&f, &issued).await;
        let connection = f.state.lock_db().unwrap();
        let mut dump = String::new();
        let mut statement = connection.prepare("SELECT id,owner,session,incarnation,secret_hash,COALESCE(credential_hash,''),COALESCE(guest_name,'') FROM structured_shares").unwrap();
        let rows = statement
            .query_map([], |row| {
                (0..7)
                    .map(|i| row.get::<_, String>(i))
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        for row in rows {
            dump.push_str(&row.unwrap().join("|"));
        }
        let secret = issued["secret"].as_str().unwrap();
        let credential = guest["credential"].as_str().unwrap();
        assert!(!dump.contains(secret) && !dump.contains(credential));
        assert!(dump.contains(&hash(credential)));
    }

    #[tokio::test]
    async fn guest_messages_require_an_enabled_share_and_stay_pending_until_the_owner_decides() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let readonly = share(&f, "owner", &id, json!({})).await;
        let (_, ro_guest) = redeem(&f, &readonly).await;
        let (status, _) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            Some(ro_guest["credential"].as_str().unwrap()),
            Some(json!({"text":"hello"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let credential = guest["credential"].as_str().unwrap();
        for bad in ["", "   ", "bad\u{0}nul"] {
            let (status, _) = call(
                &f,
                "POST",
                &format!("/api/structured-share/guest/{id}/proposals"),
                Some(credential),
                Some(json!({"text": bad})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        let (status, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            Some(credential),
            Some(json!({"text":"  please also check tests  "})),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let proposal_id = proposal["id"].as_str().unwrap();
        let events_before = f
            .state
            .structured_session_manager()
            .with_guest_view("owner", &id, |v| v.events.len())
            .await
            .unwrap()
            .unwrap();
        let path = format!(
            "/api/structured/sessions/{id}/shares/{}/proposals/{proposal_id}",
            open["id"].as_str().unwrap()
        );
        let (status, _) = call(
            &f,
            "POST",
            &path,
            Some(credential),
            Some(json!({"decision":"approve"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (_, listing) = call(
            &f,
            "GET",
            &format!("/api/structured/sessions/{id}/shares"),
            Some(&jwt(&f, "owner")),
            None,
        )
        .await;
        let listed: Vec<_> = listing["shares"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|s| s["proposals"].as_array().unwrap().clone())
            .collect();
        assert_eq!(
            (listed[0]["status"].clone(), listed[0]["text"].clone()),
            (json!("pending"), json!("please also check tests"))
        );
        let stranger = jwt(&f, "stranger");
        assert_eq!(
            call(
                &f,
                "POST",
                &path,
                Some(&stranger),
                Some(json!({"decision":"approve"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (status, approved) = call(
            &f,
            "POST",
            &path,
            Some(&jwt(&f, "owner")),
            Some(json!({"decision":"approve"})),
        )
        .await;
        assert_eq!(
            (status, approved["text"].clone()),
            (StatusCode::OK, json!("please also check tests"))
        );
        assert_eq!(
            call(
                &f,
                "POST",
                &path,
                Some(&jwt(&f, "owner")),
                Some(json!({"decision":"dismiss"}))
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let events_after = f
            .state
            .structured_session_manager()
            .with_guest_view("owner", &id, |v| v.events.len())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(events_before, events_after);
        let (_, page) = read(&f, credential, &id, "").await;
        assert_eq!(page["proposals"][0]["status"], json!("approved"));
    }

    #[tokio::test]
    async fn revocation_dismisses_pending_guest_messages() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let credential = guest["credential"].as_str().unwrap();
        let (_, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            Some(credential),
            Some(json!({"text":"hello"})),
        )
        .await;
        call(
            &f,
            "DELETE",
            &format!(
                "/api/structured/sessions/{id}/shares/{}",
                open["id"].as_str().unwrap()
            ),
            Some(&jwt(&f, "owner")),
            None,
        )
        .await;
        let path = format!(
            "/api/structured/sessions/{id}/shares/{}/proposals/{}",
            open["id"].as_str().unwrap(),
            proposal["id"].as_str().unwrap()
        );
        assert_eq!(
            call(
                &f,
                "POST",
                &path,
                Some(&jwt(&f, "owner")),
                Some(json!({"decision":"approve"}))
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &f,
                "POST",
                &format!("/api/structured-share/guest/{id}/proposals"),
                Some(credential),
                Some(json!({"text":"again"}))
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn owner_cannot_approve_an_expired_unswept_guest_message() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let (_, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            guest["credential"].as_str(),
            Some(json!({"text":"expired proposal"})),
        )
        .await;
        {
            let connection = db(&f.state).unwrap();
            connection
                .execute(
                    "UPDATE structured_shares SET expires=?2 WHERE id=?1",
                    params![open["id"].as_str().unwrap(), now() - 1],
                )
                .unwrap();
        }
        let (status, response) = call(
            &f,
            "POST",
            &format!(
                "/api/structured/sessions/{id}/shares/{}/proposals/{}",
                open["id"].as_str().unwrap(),
                proposal["id"].as_str().unwrap()
            ),
            Some(&jwt(&f, "owner")),
            Some(json!({"decision":"approve"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(response.get("text").is_none());
        let connection = db(&f.state).unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM structured_share_proposals WHERE id=?1",
                [proposal["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "expired");
    }

    #[tokio::test]
    async fn owner_cannot_approve_guest_message_after_conversation_deletion() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let (_, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            guest["credential"].as_str(),
            Some(json!({"text":"proposal for deleted conversation"})),
        )
        .await;
        f.state
            .structured_session_manager()
            .delete_session("owner", &id)
            .await
            .unwrap();
        let (status, response) = call(
            &f,
            "POST",
            &format!(
                "/api/structured/sessions/{id}/shares/{}/proposals/{}",
                open["id"].as_str().unwrap(),
                proposal["id"].as_str().unwrap()
            ),
            Some(&jwt(&f, "owner")),
            Some(json!({"decision":"approve"})),
        )
        .await;
        assert_ne!(status, StatusCode::OK);
        assert!(response.get("text").is_none());
        let connection = db(&f.state).unwrap();
        let saved: String = connection
            .query_row(
                "SELECT status FROM structured_share_proposals WHERE id=?1",
                [proposal["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(saved, "approved");
    }

    #[tokio::test]
    async fn owner_cannot_approve_guest_message_for_an_old_incarnation() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let (_, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            guest["credential"].as_str(),
            Some(json!({"text":"proposal for old incarnation"})),
        )
        .await;
        db(&f.state)
            .unwrap()
            .execute(
                "UPDATE structured_shares SET incarnation='old-incarnation' WHERE id=?1",
                [open["id"].as_str().unwrap()],
            )
            .unwrap();
        let (status, response) = call(
            &f,
            "POST",
            &format!(
                "/api/structured/sessions/{id}/shares/{}/proposals/{}",
                open["id"].as_str().unwrap(),
                proposal["id"].as_str().unwrap()
            ),
            Some(&jwt(&f, "owner")),
            Some(json!({"decision":"approve"})),
        )
        .await;
        assert_ne!(status, StatusCode::OK);
        assert!(response.get("text").is_none());
    }

    #[tokio::test]
    async fn owner_logout_while_decision_waits_does_not_approve_guest_message() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let (_, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            guest["credential"].as_str(),
            Some(json!({"text":"waiting proposal"})),
        )
        .await;
        let proposal_id = proposal["id"].as_str().unwrap().to_owned();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let manager = f.state.structured_session_manager();
        let held_id = id.clone();
        let holder = tokio::spawn(async move {
            manager
                .hold_guest_view_for_test("owner", &held_id, held_tx, release_rx)
                .await;
        });
        held_rx.await.unwrap();
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        DECIDE_WAITING
            .lock()
            .unwrap()
            .insert(id.clone(), waiting_tx);
        let app = f.app.clone();
        let token = jwt(&f, "owner");
        let path = format!(
            "/api/structured/sessions/{id}/shares/{}/proposals/{proposal_id}",
            open["id"].as_str().unwrap(),
        );
        let waiting = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"decision":"approve"}).to_string()))
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), waiting_rx)
            .await
            .unwrap()
            .unwrap();
        f.state.logout_user("owner").unwrap();
        release_tx.send(()).unwrap();
        holder.await.unwrap();
        assert_eq!(waiting.await.unwrap(), StatusCode::UNAUTHORIZED);
        let saved: String = db(&f.state)
            .unwrap()
            .query_row(
                "SELECT status FROM structured_share_proposals WHERE id=?1",
                [&proposal_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved, "pending");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn owner_list_does_not_wait_for_the_shared_database_mutex() {
        let f = fixture();
        let state = f.state.clone();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = state.lock_db().unwrap();
            held_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(std::time::Duration::from_secs(5));
        });
        held_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let app = Router::new()
            .route("/api/structured/sessions/{id}/shares", get(list))
            .layer(Extension(authority))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            }))
            .with_state(f.state.clone());
        let request = Request::builder()
            .uri("/api/structured/sessions/test/shares")
            .body(Body::empty())
            .unwrap();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            tokio::spawn(app.oneshot(request)),
        )
        .await;
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(
            response
                .expect("owner list blocked on the shared database mutex")
                .unwrap()
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    #[cfg(not(unix))]
    #[test]
    fn owner_share_mutations_fail_closed_without_a_revocation_fence() {
        let f = fixture();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let ran = std::sync::atomic::AtomicBool::new(false);
        let result = with_share_authority(
            &f.state,
            "owner",
            &Some(Extension(authority)),
            &None,
            |_| {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        );
        let error = result.unwrap_err();
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(error.message.contains("unavailable on this platform"));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[test]
    fn owner_review_fails_promptly_when_authorization_is_busy() {
        let f = fixture();
        let guard = f.state.hold_auth_admission_for_test().unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let local = Some(Extension(authority));
        let started = std::time::Instant::now();
        let result = with_share_authority(&f.state, "owner", &local, &None, |_| Ok(()));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(result.unwrap_err().status, StatusCode::SERVICE_UNAVAILABLE);
        drop(guard);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn guest_owner_load_fails_promptly_when_authorization_is_busy() {
        let f = fixture();
        let _id = conversation(&f, "owner").await;
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let guard = f.state.hold_auth_admission_for_test().unwrap();
        let started = std::time::Instant::now();
        let result = f
            .state
            .structured_session_manager()
            .load_guest_owner_authorized("owner", &f.state, Some(&authority), None)
            .await;
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(result.is_err());
        drop(guard);
    }

    #[cfg(unix)]
    #[test]
    fn paired_owner_review_rechecks_revocation_and_expiry() {
        let f = fixture();
        let (grant, token) = crate::paired_environments::synthetic_input_grant(&f.state, "owner");
        let authority = crate::auth::PairedInputAuthority {
            token,
            method: "POST".into(),
            path: "/api/structured/sessions/example/shares".into(),
        };
        let paired = Some(Extension(authority));
        let result = with_share_authority(&f.state, "owner", &None, &paired, |_| Ok(()));
        assert!(result.is_ok());
        f.state
            .lock_db()
            .unwrap()
            .execute("UPDATE paired_grants SET expires=0 WHERE id=?1", [&grant])
            .unwrap();
        let result = with_share_authority(&f.state, "owner", &None, &paired, |_| Ok(()));
        assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
        f.state
            .lock_db()
            .unwrap()
            .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
            .unwrap();
        let result = with_share_authority(&f.state, "owner", &None, &paired, |_| Ok(()));
        assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn owner_logout_while_create_waits_for_live_conversation_creates_no_share() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let manager = f.state.structured_session_manager();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let held_id = id.clone();
        let holder = tokio::spawn(async move {
            manager
                .hold_guest_view_for_test("owner", &held_id, held_tx, release_rx)
                .await;
        });
        held_rx.await.unwrap();
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        CREATE_WAITING
            .lock()
            .unwrap()
            .insert(id.clone(), waiting_tx);
        let app = f.app.clone();
        let token = jwt(&f, "owner");
        let path = format!("/api/structured/sessions/{id}/shares");
        let waiting = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), waiting_rx)
            .await
            .unwrap()
            .unwrap();
        f.state.logout_user("owner").unwrap();
        release_tx.send(()).unwrap();
        holder.await.unwrap();
        assert_eq!(waiting.await.unwrap(), StatusCode::UNAUTHORIZED);
        let count: i64 = db(&f.state)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM structured_shares WHERE owner='owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn owner_can_decide_guest_message_after_a_cold_session_load() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let open = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &open).await;
        let (_, proposal) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            guest["credential"].as_str(),
            Some(json!({"text":"recover me"})),
        )
        .await;
        f.state
            .structured_session_manager()
            .clear_cached_guest_session_for_test("owner", &id)
            .await;
        let (status, response) = call(
            &f,
            "POST",
            &format!(
                "/api/structured/sessions/{id}/shares/{}/proposals/{}",
                open["id"].as_str().unwrap(),
                proposal["id"].as_str().unwrap()
            ),
            Some(&jwt(&f, "owner")),
            Some(json!({"decision":"approve"})),
        )
        .await;
        assert_eq!(
            (status, response["text"].clone()),
            (StatusCode::OK, json!("recover me"))
        );
    }

    #[tokio::test]
    async fn owner_logout_while_create_waits_for_cold_load_creates_no_share() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let manager = f.state.structured_session_manager();
        manager
            .clear_cached_guest_session_for_test("owner", &id)
            .await;
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let holding_manager = manager.clone();
        let holder = tokio::spawn(async move {
            holding_manager
                .hold_guest_load_for_test(held_tx, release_rx)
                .await
        });
        held_rx.await.unwrap();
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        manager.notify_guest_load_for_test(waiting_tx);
        let app = f.app.clone();
        let token = jwt(&f, "owner");
        let path = format!("/api/structured/sessions/{id}/shares");
        let waiting = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), waiting_rx)
            .await
            .unwrap()
            .unwrap();
        f.state.logout_user("owner").unwrap();
        release_tx.send(()).unwrap();
        holder.await.unwrap();
        assert_eq!(waiting.await.unwrap(), StatusCode::UNAUTHORIZED);
        let count: i64 = db(&f.state)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM structured_shares", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn proposal_commit_rechecks_the_share_after_authorization() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        for expired in [false, true] {
            let issued = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
            let (_, credentials) = redeem(&f, &issued).await;
            let credential = credentials["credential"].as_str().unwrap();
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {credential}").parse().unwrap(),
            );
            let guest = authorize(&f.state, &headers, &id, now()).unwrap();
            let connection = db(&f.state).unwrap();
            if expired {
                connection
                    .execute(
                        "UPDATE structured_shares SET expires=?2 WHERE id=?1",
                        params![guest.share, now() - 1],
                    )
                    .unwrap();
            } else {
                revoke_row(&connection, &guest.share, now()).unwrap();
            }
            let result =
                insert_guest_proposal(&connection, &guest, "late-message", "not delivered", now());
            assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM structured_share_proposals WHERE share=?1",
                    [&guest.share],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[tokio::test]
    async fn deleted_conversation_rejects_new_guest_proposals() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, credentials) = redeem(&f, &issued).await;
        f.state
            .structured_session_manager()
            .delete_session("owner", &id)
            .await
            .unwrap();
        let (status, _) = call(
            &f,
            "POST",
            &format!("/api/structured-share/guest/{id}/proposals"),
            Some(credentials["credential"].as_str().unwrap()),
            Some(json!({"text":"after deletion"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let count: i64 = f
            .state
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM structured_share_proposals WHERE share=?1",
                [issued["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn revoked_guest_cannot_propose_after_waiting_on_the_conversation() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, credentials) = redeem(&f, &issued).await;
        let credential = credentials["credential"].as_str().unwrap().to_owned();
        let share_id = issued["id"].as_str().unwrap().to_owned();
        f.state
            .lock_db()
            .unwrap()
            .execute(
                "UPDATE structured_shares SET last_seen=0 WHERE id=?1",
                [&share_id],
            )
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let manager = f.state.structured_session_manager();
        let held_id = id.clone();
        let holder = tokio::spawn(async move {
            manager
                .hold_guest_view_for_test("owner", &held_id, entered_tx, release_rx)
                .await;
        });
        entered_rx.await.unwrap();
        let app = f.app.clone();
        let waiting_id = id.clone();
        let waiting = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/structured-share/guest/{waiting_id}/proposals"
                ))
                .header("authorization", format!("Bearer {credential}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"text":"late message"}).to_string()))
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let seen: i64 = f
                    .state
                    .lock_db()
                    .unwrap()
                    .query_row(
                        "SELECT last_seen FROM structured_shares WHERE id=?1",
                        [&share_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                if seen > 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("proposal did not reach authorization");
        assert_eq!(
            call(
                &f,
                "DELETE",
                &format!("/api/structured/sessions/{id}/shares/{share_id}"),
                Some(&jwt(&f, "owner")),
                None,
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        release_tx.send(()).unwrap();
        holder.await.unwrap();
        assert_eq!(waiting.await.unwrap(), StatusCode::UNAUTHORIZED);
        let count: i64 = f
            .state
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM structured_share_proposals WHERE share=?1",
                [&share_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rate_limit_blocks_after_the_limit_and_resets_with_the_window() {
        let key = format!("test:{}", uuid::Uuid::new_v4());
        let results: Vec<_> = (0..4).map(|i| allow(&key, 3, 60, 1000 + i)).collect();
        assert_eq!(results, vec![true, true, true, false]);
        assert!(allow(&key, 3, 60, 1061));
    }

    #[tokio::test]
    async fn exchange_attempts_for_one_link_are_rate_limited() {
        let f = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let attempt = json!({"id": id, "secret": "a".repeat(64)});
        let mut statuses = Vec::new();
        for _ in 0..12 {
            statuses.push(
                call(
                    &f,
                    "POST",
                    "/api/structured-share/exchange",
                    None,
                    Some(attempt.clone()),
                )
                .await
                .0,
            );
        }
        assert_eq!(
            statuses
                .iter()
                .filter(|s| **s == StatusCode::TOO_MANY_REQUESTS)
                .count(),
            2
        );
        assert!(statuses[..10]
            .iter()
            .all(|s| *s == StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn guest_credentials_and_owner_tokens_do_not_cross_over() {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({})).await;
        let (_, guest) = redeem(&f, &issued).await;
        let owner = jwt(&f, "owner");
        assert_eq!(read(&f, &owner, &id, "").await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            read(
                &f,
                &format!("{CREDENTIAL_PREFIX}{}", "0".repeat(64)),
                &id,
                ""
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &f,
                "GET",
                &format!("/api/structured-share/guest/{id}/messages"),
                None,
                None
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let _ = guest;
    }

    fn route_paths() -> Vec<String> {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let pattern = regex_lite::Regex::new(r#"\.route\(\s*"(/[^"]*)""#).unwrap();
        let mut paths = std::collections::BTreeSet::new();
        for file in files {
            let source = std::fs::read_to_string(file).unwrap();
            for capture in pattern.captures_iter(&source) {
                let path = capture[1].to_owned();
                let concrete = regex_lite::Regex::new(r"\{\*?[^}]*\}")
                    .unwrap()
                    .replace_all(&path, "x")
                    .into_owned();
                paths.insert(concrete);
            }
        }
        paths.into_iter().collect()
    }

    #[tokio::test]
    async fn guest_credential_gets_the_same_response_as_no_credential_on_every_route_outside_the_share_api(
    ) {
        let f = fixture();
        let id = conversation(&f, "owner").await;
        let issued = share(&f, "owner", &id, json!({"allowGuestMessages": true})).await;
        let (_, guest) = redeem(&f, &issued).await;
        let credential = guest["credential"].as_str().unwrap().to_owned();
        let paths = route_paths();
        assert!(paths.len() > 100, "route enumeration found {}", paths.len());
        let mut protected = 0;
        for path in &paths {
            if path.starts_with("/api/structured-share/") || path.starts_with("/api/auth/") {
                continue;
            }
            for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
                let body = (method != "GET" && method != "DELETE").then(|| json!({}));
                let anonymous = call(&f, method, path, None, body.clone()).await.0;
                let guest_status = call(&f, method, path, Some(&credential), body).await.0;
                assert_eq!(guest_status, anonymous, "{method} {path}");
                assert!(
                    !guest_status.is_success() || anonymous.is_success(),
                    "{method} {path}"
                );
                if anonymous == StatusCode::UNAUTHORIZED {
                    protected += 1;
                }
            }
        }
        assert!(
            protected > 150,
            "only {protected} protected route methods exercised"
        );
        for path in [
            format!("/api/structured/sessions/{id}"),
            format!("/api/structured/sessions/{id}/queue"),
            format!("/api/structured/sessions/{id}/shares"),
            "/api/terminal/sessions".to_owned(),
            "/api/collaboration/invitations".to_owned(),
        ] {
            assert_eq!(
                call(&f, "GET", &path, Some(&credential), None).await.0,
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
        assert_eq!(
            call(
                &f,
                "GET",
                &format!("/api/structured/sessions/{id}"),
                Some(&jwt(&f, "owner")),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
    }
}

#[cfg(test)]
mod unsupported_platform_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    #[tokio::test]
    async fn existing_share_cannot_be_exchanged_read_or_used_to_propose() {
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
        let now = now();
        let conn = db(&state).unwrap();
        conn.execute("INSERT INTO structured_shares(id, owner, session, incarnation, secret_hash, credential_hash, created, expires, allow_messages) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)", params!["persisted-share", "owner", "session", "legacy", hash("old-secret"), hash("old-credential"), now, now + 3600]).unwrap();
        drop(conn);
        let app = unsupported_guest_routes().with_state(state.clone());
        for (method, path, body) in [
            (
                "POST",
                "/api/structured-share/exchange",
                r#"{"id":"persisted-share","secret":"old-secret"}"#,
            ),
            ("GET", "/api/structured-share/guest/session/messages", ""),
            (
                "POST",
                "/api/structured-share/guest/session/proposals",
                r#"{"text":"old message"}"#,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("authorization", "Bearer tv4share.old-credential")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "{method} {path}"
            );
        }
        let conn = db(&state).unwrap();
        let unchanged: (Option<i64>, Option<i64>, i64) = conn.query_row(
            "SELECT redeemed, revoked, (SELECT COUNT(*) FROM structured_share_proposals) FROM structured_shares WHERE id='persisted-share'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!(unchanged, (None, None, 0));
    }
}
