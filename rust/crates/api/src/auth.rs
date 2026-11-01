use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user_id: String,
    pub username: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LocalAuthority {
    owner: String,
    generation: i64,
    expires_at_ms: i64,
    session_id: Option<String>,
    auth_protocol: i64,
}

impl LocalAuthority {
    #[cfg(test)]
    pub(crate) fn generation_for(&self, owner: &str) -> Option<i64> {
        (self.owner == owner).then_some(self.generation)
    }

    pub(crate) fn valid_for(&self, owner: &str, now_ms: i64) -> Option<(i64, i64)> {
        (self.owner == owner && now_ms < self.expires_at_ms)
            .then_some((self.generation, self.expires_at_ms))
    }

    #[cfg(unix)]
    pub(crate) fn from_verified_queue(
        proof: crate::followup_queue::VerifiedQueueAuthority,
    ) -> Result<Self, String> {
        match proof {
            crate::followup_queue::VerifiedQueueAuthority::Local {
                owner,
                generation,
                expires_at_ms,
                auth_protocol,
                auth_session_id,
            } => {
                let valid_session = match (auth_protocol, auth_session_id.as_deref()) {
                    (0, None) => true,
                    (1, Some(value)) => uuid::Uuid::parse_str(value)
                        .is_ok_and(|id| !id.is_nil() && id.to_string() == value),
                    _ => false,
                };
                if !valid_session {
                    return Err("Invalid persisted queue authority".into());
                }
                Ok(Self {
                    owner,
                    generation,
                    expires_at_ms,
                    session_id: auth_session_id,
                    auth_protocol,
                })
            }
            crate::followup_queue::VerifiedQueueAuthority::Paired(_) => {
                Err("Paired queued authority is not supported by this dispatch path".into())
            }
        }
    }

    #[cfg(unix)]
    pub(crate) fn from_persisted_queue_claims(
        owner: &str,
        generation: i64,
        expires_at_ms: i64,
    ) -> Result<Self, String> {
        if owner.is_empty()
            || owner.len() > 256
            || owner.chars().any(char::is_control)
            || generation < 0
            || expires_at_ms <= 0
        {
            return Err("Invalid persisted queue authority".into());
        }
        Ok(Self {
            owner: owner.into(),
            generation,
            expires_at_ms,
            session_id: None,
            auth_protocol: 0,
        })
    }

    #[cfg(unix)]
    pub(crate) fn from_persisted_session_claims(
        owner: &str,
        generation: i64,
        expires_at_ms: i64,
        session_id: &str,
    ) -> Result<Self, String> {
        let id =
            uuid::Uuid::parse_str(session_id).map_err(|_| "Invalid persisted session authority")?;
        if id.is_nil() || id.to_string() != session_id {
            return Err("Invalid persisted session authority".into());
        }
        let mut authority = Self::from_persisted_queue_claims(owner, generation, expires_at_ms)?;
        authority.auth_protocol = 1;
        authority.session_id = Some(session_id.into());
        Ok(authority)
    }

    #[cfg(test)]
    pub(crate) fn for_test(owner: &str, generation: i64, expires_at_ms: i64) -> Self {
        Self {
            owner: owner.into(),
            generation,
            expires_at_ms,
            session_id: None,
            auth_protocol: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_session(
        owner: &str,
        generation: i64,
        expires_at_ms: i64,
        session: &str,
    ) -> Self {
        Self {
            owner: owner.into(),
            generation,
            expires_at_ms,
            session_id: Some(session.into()),
            auth_protocol: 1,
        }
    }

    pub(crate) fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub(crate) fn auth_protocol(&self) -> i64 {
        self.auth_protocol
    }
}

#[derive(Clone)]
pub(crate) struct PairedInputAuthority {
    pub(crate) token: String,
    pub(crate) path: String,
    pub(crate) method: String,
}

#[derive(Clone, Copy)]
pub(crate) struct QueryAccessTokenUsed;

enum StreamCredential {
    Access(String),
    Preview(String),
}

impl StreamCredential {
    fn is_valid(&self, state: &AppState, method: &str, path: &str) -> bool {
        match self {
            Self::Access(token) => authenticate_runtime_request(state, token, method, path).is_ok(),
            Self::Preview(token) => {
                authenticate_runtime_preview_token(state, token, path).is_ok()
                    || crate::preview::auth_urls::authenticate_resource_token(
                        state, token, method, path,
                    )
                    .is_ok()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    username: String,
    exp: usize,
    iat: usize,
    #[serde(default = "default_token_kind")]
    token_kind: String,
    #[serde(default)]
    generation: i64,
    #[serde(default)]
    auth_protocol: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pair: Option<i64>,
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let mut query_access_used = false;
    let mut runtime_credential = None;
    let mut local_authority = None;
    let user = match access_token(&request)
        .and_then(|token| {
            authenticate_runtime_with_authority(
                &state,
                token,
                request.method().as_str(),
                request.uri().path(),
            )
            .ok()
            .map(|(user, authority)| {
                query_access_used = bearer_token(&request).is_none();
                runtime_credential = Some(StreamCredential::Access(token.to_owned()));
                local_authority = authority;
                user
            })
        })
        .or_else(|| {
            preview_token(&request).and_then(|token| {
                authenticate_runtime_preview_token(&state, token, request.uri().path())
                    .ok()
                    .or_else(|| {
                        crate::preview::auth_urls::authenticate_resource_token(
                            &state,
                            token,
                            request.method().as_str(),
                            request.uri().path(),
                        )
                        .ok()
                    })
                    .map(|user| {
                        runtime_credential = Some(StreamCredential::Preview(token.to_owned()));
                        user
                    })
            })
        }) {
        Some(user) => user,
        None => return auth_error(StatusCode::UNAUTHORIZED, "Unauthorized"),
    };

    if user
        .user_id
        .starts_with(crate::local_testing::ACCOUNT_PREFIX)
        && !crate::local_testing::enabled(&state)
    {
        return auth_error(StatusCode::UNAUTHORIZED, "Local testing is disabled");
    }
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    if let Some(StreamCredential::Access(token)) = &runtime_credential {
        if token.starts_with("tv4pair.") {
            request.extensions_mut().insert(PairedInputAuthority {
                token: token.clone(),
                path: path.clone(),
                method: method.clone(),
            });
        }
    }
    if let Some(authority) = local_authority {
        request.extensions_mut().insert(authority);
    }
    request.extensions_mut().insert(user);
    if query_access_used {
        request.extensions_mut().insert(QueryAccessTokenUsed);
    }
    let response = next.run(request).await;
    if let Some(token) = runtime_credential {
        if response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"))
        {
            return guard_runtime_event_stream(state, token, method, path, response);
        }
    }
    response
}

fn guard_runtime_event_stream(
    state: AppState,
    token: StreamCredential,
    method: String,
    path: String,
    response: Response,
) -> Response {
    let (parts, body) = response.into_parts();
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    tokio::spawn(async move {
        let mut stream = body.into_data_stream();
        let mut pending = None;
        let mut authorization_check = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            tokio::select! {
                _=sender.closed()=>break,
                _=authorization_check.tick()=>{
                    if !token.is_valid(&state,&method,&path){break;}
                },
                permit=sender.reserve(),if pending.is_some()=>{
                    if !token.is_valid(&state,&method,&path){break;}
                    match permit {Ok(permit)=>permit.send(pending.take().expect("Pending body chunk exists")),Err(_)=>break,}
                },
                chunk=stream.next(),if pending.is_none()=>{
                    match chunk {Some(chunk)=>pending=Some(chunk),None=>break,}
                },
            }
        }
    });
    Response::from_parts(
        parts,
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receiver)),
    )
}

pub(crate) fn authenticate_runtime_request(
    state: &AppState,
    token: &str,
    method: &str,
    path: &str,
) -> Result<AuthenticatedUser, String> {
    authenticate_runtime_with_authority(state, token, method, path).map(|(user, _)| user)
}

pub(crate) fn authenticate_runtime_with_authority(
    state: &AppState,
    token: &str,
    method: &str,
    path: &str,
) -> Result<(AuthenticatedUser, Option<LocalAuthority>), String> {
    if token.starts_with("tv4pair.") {
        let user = crate::paired_environments::authorize_request(state, token, method, path)
            .ok_or("Invalid, expired, revoked or unauthorized token")?;
        return Ok((runtime_identity(state, user)?, None));
    }
    let (user, authority) = authenticate_local_with_authority(state, token)?;
    Ok((runtime_identity(state, user)?, Some(authority)))
}

pub(crate) fn runtime_identity(
    state: &AppState,
    user: AuthenticatedUser,
) -> Result<AuthenticatedUser, String> {
    if user
        .user_id
        .starts_with(crate::local_testing::ACCOUNT_PREFIX)
        && !crate::local_testing::enabled(state)
    {
        Err("Local testing is disabled".into())
    } else {
        Ok(user)
    }
}

pub(crate) fn authenticate_local_token(
    state: &AppState,
    token: &str,
) -> Result<AuthenticatedUser, String> {
    authenticate_local_with_authority(state, token).map(|(user, _)| user)
}

pub(crate) fn authenticate_local_with_authority(
    state: &AppState,
    token: &str,
) -> Result<(AuthenticatedUser, LocalAuthority), String> {
    authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        token,
    )
    .and_then(|user| {
        let claims = decode_claims(&state.config().jwt_secret, token)?;
        state.validate_access_claims(
            &user.user_id,
            claims.generation,
            claims.auth_protocol,
            claims.session_id.as_deref(),
            claims.pair,
        )?;
        let user = runtime_identity(state, user)?;
        let authority = LocalAuthority {
            owner: user.user_id.clone(),
            generation: claims.generation,
            expires_at_ms: i64::try_from(claims.exp)
                .ok()
                .and_then(|seconds| seconds.checked_mul(1000))
                .ok_or("Invalid token expiration")?,
            session_id: claims.session_id,
            auth_protocol: claims.auth_protocol,
        };
        Ok((user, authority))
    })
}

pub(crate) fn authenticate_runtime_preview_token(
    state: &AppState,
    token: &str,
    path: &str,
) -> Result<AuthenticatedUser, String> {
    authenticate_preview_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        token,
        path,
    )
    .and_then(|user| {
        let claims = decode_claims(&state.config().jwt_secret, token)?;
        state.validate_auth_claims(
            &user.user_id,
            claims.generation,
            claims.auth_protocol,
            claims.session_id.as_deref(),
        )?;
        runtime_identity(state, user)
    })
}
pub(crate) fn authenticate_runtime_token(
    state: &AppState,
    token: &str,
    path: &str,
) -> Result<AuthenticatedUser, String> {
    authenticate_runtime_request(state, token, "GET", path)
}
pub(crate) fn runtime_message_allowed(
    state: &AppState,
    token: &str,
    structured: bool,
    kind: &str,
) -> bool {
    if token.starts_with("tv4pair.") {
        return crate::paired_environments::capabilities_for_token(state, token).is_some_and(
            |caps| {
                if structured {
                    caps.allows_structured_message(kind)
                } else {
                    caps.allows_terminal_message(kind)
                }
            },
        );
    }
    authenticate_local_token(state, token).is_ok()
}

pub fn authenticate_token(
    secret: &str,
    allowed_username: Option<&str>,
    token: &str,
) -> Result<AuthenticatedUser, String> {
    let claims = decode_claims(secret, token)?;

    if claims.token_kind != "access" {
        return Err("Invalid or expired token".to_string());
    }

    validate_allowed_username(allowed_username, &claims.username)?;

    Ok(AuthenticatedUser {
        user_id: claims.sub,
        username: claims.username,
    })
}

pub fn authenticate_preview_token(
    secret: &str,
    allowed_username: Option<&str>,
    token: &str,
    request_path: &str,
) -> Result<AuthenticatedUser, String> {
    if !is_preview_route(request_path) {
        return Err("Unauthorized".to_string());
    }

    let claims = decode_claims(secret, token)?;

    if claims.token_kind != "preview" {
        return Err("Invalid or expired token".to_string());
    }

    validate_allowed_username(allowed_username, &claims.username)?;

    Ok(AuthenticatedUser {
        user_id: claims.sub,
        username: claims.username,
    })
}

fn decode_claims(secret: &str, token: &str) -> Result<Claims, String> {
    let decoded = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| "Invalid or expired token".to_string())?;

    Ok(decoded.claims)
}

pub(crate) fn validate_allowed_username(
    allowed_username: Option<&str>,
    username: &str,
) -> Result<(), String> {
    if let Some(allowed_username) = allowed_username {
        if username != allowed_username {
            return Err("Unauthorized".to_string());
        }
    }

    Ok(())
}

fn access_token(request: &Request) -> Option<&str> {
    bearer_token(request).or_else(|| query_token(request, "token"))
}

fn preview_token(request: &Request) -> Option<&str> {
    preview_cookie_token(request)
        .or_else(|| bearer_token(request))
        .or_else(|| query_token(request, "previewToken"))
}

fn bearer_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn preview_cookie_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookie_header| {
            cookie_header.split(';').find_map(|segment| {
                let (name, value) = segment.trim().split_once('=')?;
                if name == "terminal_preview_token" {
                    Some(value)
                } else {
                    None
                }
            })
        })
}

fn query_token<'a>(request: &'a Request, key_name: &str) -> Option<&'a str> {
    request.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key == key_name {
                Some(value)
            } else {
                None
            }
        })
    })
}

fn auth_error(status: StatusCode, message: &str) -> Response<Body> {
    (status, axum::Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
pub fn issue_access_token(secret: &str, user_id: &str, username: &str) -> String {
    issue_access_token_for_generation(secret, user_id, username, 0)
}

#[cfg(test)]
pub fn issue_preview_token(secret: &str, user_id: &str, username: &str) -> String {
    issue_token(secret, user_id, username, "preview", 900, 0, 0, None)
}

#[cfg(test)]
pub(crate) fn issue_access_token_for_generation(
    secret: &str,
    user_id: &str,
    username: &str,
    generation: i64,
) -> String {
    issue_access_token_for_protocol(secret, user_id, username, generation, 0, None)
}

pub(crate) fn issue_access_token_for_protocol(
    secret: &str,
    user_id: &str,
    username: &str,
    generation: i64,
    auth_protocol: i64,
    session_id: Option<&str>,
) -> String {
    issue_access_token_for_pair(
        secret,
        user_id,
        username,
        generation,
        auth_protocol,
        session_id,
        None,
    )
}

pub(crate) fn issue_access_token_for_pair(
    secret: &str,
    user_id: &str,
    username: &str,
    generation: i64,
    auth_protocol: i64,
    session_id: Option<&str>,
    pair: Option<i64>,
) -> String {
    issue_token_for_pair(
        secret,
        user_id,
        username,
        "access",
        3600,
        generation,
        auth_protocol,
        session_id,
        pair,
    )
}

/// Identity and pair binding of an access token, read without enforcing expiry.
/// The signature is still verified; only a refresh request uses this, to prove
/// the presented access token belongs to the same pair as the refresh token.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AccessPairClaims {
    pub(crate) owner: String,
    pub(crate) session_id: Option<String>,
    pub(crate) pair: Option<i64>,
}

pub(crate) fn access_pair_claims(secret: &str, token: &str) -> Option<AccessPairClaims> {
    let mut validation = Validation::default();
    validation.validate_exp = false;
    validation.required_spec_claims.clear();
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    (claims.token_kind == "access").then_some(AccessPairClaims {
        owner: claims.sub,
        session_id: claims.session_id,
        pair: claims.pair,
    })
}

pub(crate) fn preview_token_for_access(state: &AppState, access: &str) -> Result<String, String> {
    let user = authenticate_local_token(state, access)?;
    let claims = decode_claims(&state.config().jwt_secret, access)?;
    Ok(issue_token(
        &state.config().jwt_secret,
        &user.user_id,
        &user.username,
        "preview",
        900,
        claims.generation,
        claims.auth_protocol,
        claims.session_id.as_deref(),
    ))
}

fn issue_token(
    secret: &str,
    user_id: &str,
    username: &str,
    token_kind: &str,
    ttl_seconds: usize,
    generation: i64,
    auth_protocol: i64,
    session_id: Option<&str>,
) -> String {
    issue_token_for_pair(
        secret,
        user_id,
        username,
        token_kind,
        ttl_seconds,
        generation,
        auth_protocol,
        session_id,
        None,
    )
}

fn issue_token_for_pair(
    secret: &str,
    user_id: &str,
    username: &str,
    token_kind: &str,
    ttl_seconds: usize,
    generation: i64,
    auth_protocol: i64,
    session_id: Option<&str>,
    pair: Option<i64>,
) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_secs() as usize;

    encode(
        &Header::default(),
        &Claims {
            sub: user_id.to_string(),
            username: username.to_string(),
            iat: now,
            exp: now + ttl_seconds,
            token_kind: token_kind.to_string(),
            generation,
            auth_protocol,
            session_id: session_id.map(str::to_owned),
            pair,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("token should encode")
}

fn default_token_kind() -> String {
    "access".to_string()
}

fn is_preview_route(path: &str) -> bool {
    path.starts_with("/api/preview")
        || path.starts_with("/api/proxy-external")
        || path.starts_with("/preview/")
}

#[cfg(test)]
mod revocation_tests {
    use super::*;
    use axum::{http::Request, middleware, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn losing_a_transitioned_user_row_does_not_reenable_legacy_tokens() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "protocol-loss-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        {
            let db = state.lock_db().unwrap();
            db.execute(
                "UPDATE users SET auth_protocol_min=1 WHERE id=?",
                [&login.user.id],
            )
            .unwrap();
            db.execute("DELETE FROM users WHERE id=?", [&login.user.id])
                .unwrap();
        }
        assert!(authenticate_local_token(&state, &login.tokens.access_token).is_err());
    }

    #[tokio::test]
    async fn account_protocol_rejects_legacy_tokens_after_transition_and_preserves_preview_version()
    {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "protocol-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        {
            let db = state.lock_db().unwrap();
            let has_column: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('users') WHERE name='auth_protocol_min')", [], |row| row.get(0)).unwrap();
            if !has_column {
                db.execute_batch(
                    "ALTER TABLE users ADD COLUMN auth_protocol_min INTEGER NOT NULL DEFAULT 0",
                )
                .unwrap();
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let session_id = uuid::Uuid::new_v4().to_string();
        state
            .lock_db()
            .unwrap()
            .execute(
                "INSERT INTO auth_sessions (id,user_id,generation,logout_capability_hash,revoked_at,created_at) VALUES (?1,?2,0,'unused',NULL,'2026-01-01T00:00:00Z')",
                rusqlite::params![session_id, login.user.id],
            )
            .unwrap();
        let upgraded = encode(&Header::default(), &json!({
            "sub": login.user.id, "username": login.user.username, "exp": now + 3600, "iat": now,
            "token_kind": "access", "generation": 0, "auth_protocol": 1, "session_id": session_id
        }), &EncodingKey::from_secret(state.config().jwt_secret.as_bytes())).unwrap();
        let legacy_without_protocol = encode(&Header::default(), &json!({
            "sub": login.user.id, "username": login.user.username, "exp": now + 3600, "iat": now,
            "token_kind": "access", "generation": 0
        }), &EncodingKey::from_secret(state.config().jwt_secret.as_bytes())).unwrap();
        assert!(authenticate_local_token(&state, &login.tokens.access_token).is_ok());
        assert!(authenticate_local_token(&state, &legacy_without_protocol).is_ok());
        assert!(authenticate_local_token(&state, &upgraded).is_err());
        let old_preview = preview_token_for_access(&state, &legacy_without_protocol).unwrap();
        let old_resource =
            crate::preview::auth_urls::resource_token(&state, &old_preview, "/preview/").unwrap();
        state
            .lock_db()
            .unwrap()
            .execute(
                "UPDATE users SET auth_protocol_min = 1 WHERE id = ?",
                [&login.user.id],
            )
            .unwrap();
        assert!(authenticate_local_token(&state, &login.tokens.access_token).is_err());
        assert!(authenticate_local_token(&state, &legacy_without_protocol).is_err());
        assert!(authenticate_runtime_preview_token(&state, &old_preview, "/preview/").is_err());
        assert!(crate::preview::auth_urls::authenticate_resource_token(
            &state,
            &old_resource,
            "GET",
            "/preview/"
        )
        .is_err());
        assert!(authenticate_local_token(&state, &upgraded).is_ok());
        let preview = preview_token_for_access(&state, &upgraded).unwrap();
        let preview_claims = decode::<serde_json::Value>(
            &preview,
            &DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .unwrap()
        .claims;
        assert_eq!(preview_claims["auth_protocol"], 1);
        let resource =
            crate::preview::auth_urls::resource_token(&state, &preview, "/preview/").unwrap();
        let claims = decode::<serde_json::Value>(
            &resource,
            &DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .unwrap()
        .claims;
        assert_eq!(claims["auth_protocol"], 1);
        assert!(crate::preview::auth_urls::authenticate_resource_token(
            &state,
            &resource,
            "GET",
            "/preview/"
        )
        .is_ok());
    }

    #[test]
    fn local_authority_expires_at_the_token_deadline_and_is_owner_bound() {
        let authority = LocalAuthority::for_test("alice", 4, 10_000);
        assert_eq!(authority.valid_for("alice", 9_999), Some((4, 10_000)));
        assert_eq!(authority.valid_for("alice", 10_000), None);
        assert_eq!(authority.valid_for("bob", 9_999), None);
    }

    #[cfg(unix)]
    #[test]
    fn verified_queue_authority_preserves_owner_generation_and_expiry() {
        use crate::followup_queue::{
            IdleBoundary, Mutation, QueueOperation, QueueScope, QueueStore,
        };
        use uuid::Uuid;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let scope = QueueScope::new(
            "alice",
            workspace.path(),
            &format!("ss-{}", Uuid::new_v4().simple()),
        )
        .unwrap();
        let store = QueueStore::new(data.path(), Uuid::new_v4());
        let expiration = crate::v4_agent::interaction::now_ms() + 60_000;
        let original = LocalAuthority::for_test("alice", 4, expiration);
        let incarnation = Uuid::new_v4();
        store
            .mutate_authorized(
                &scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "Inspect".into(),
                        run_when_idle: true,
                    },
                },
                &original,
            )
            .unwrap();
        let reservation = store
            .reserve_next(&scope, 1, IdleBoundary { turn_epoch: 7 })
            .unwrap()
            .unwrap();
        let proof = store
            .verify_reservation_authority(&scope, incarnation, &reservation)
            .unwrap()
            .unwrap();
        let restored = LocalAuthority::from_verified_queue(proof).unwrap();
        assert_eq!(
            restored.valid_for("alice", expiration - 1),
            Some((4, expiration))
        );
        assert_eq!(restored.valid_for("alice", expiration), None);
        assert_eq!(restored.valid_for("bob", expiration - 1), None);
    }

    #[tokio::test]
    async fn local_authority_keeps_the_token_generation_and_rejects_foreign_or_revoked_credentials()
    {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "authority-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let initial = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (user, authority) =
            authenticate_local_with_authority(&state, &initial.tokens.access_token).unwrap();
        assert_eq!(user.user_id, initial.user.id);
        assert_eq!(authority.generation_for(&user.user_id), Some(0));
        assert_eq!(authority.generation_for("different-owner"), None);
        let preview = preview_token_for_access(&state, &initial.tokens.access_token).unwrap();
        assert!(authenticate_local_with_authority(&state, &preview).is_err());
        state.logout_user(&user.user_id).unwrap();
        assert!(authenticate_local_with_authority(&state, &initial.tokens.access_token).is_err());
        let fresh = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (_, fresh_authority) =
            authenticate_local_with_authority(&state, &fresh.tokens.access_token).unwrap();
        assert_eq!(authority.generation_for(&user.user_id), Some(0));
        assert_eq!(fresh_authority.generation_for(&user.user_id), Some(1));
        assert!(authenticate_local_with_authority(&state, "tv4pair.invalid").is_err());
    }

    #[tokio::test]
    async fn middleware_attaches_local_authority_only_for_access_credentials() {
        use axum::{Extension, Json};
        async fn inspect(
            Extension(user): Extension<AuthenticatedUser>,
            authority: Option<Extension<LocalAuthority>>,
        ) -> Json<serde_json::Value> {
            Json(
                json!({"generation": authority.and_then(|Extension(value)| value.generation_for(&user.user_id))}),
            )
        }
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "authority-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let preview = preview_token_for_access(&state, &login.tokens.access_token).unwrap();
        let router = Router::new()
            .route("/inspect", get(inspect))
            .route("/api/preview/inspect", get(inspect))
            .layer(middleware::from_fn_with_state(state.clone(), require_auth));
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/inspect")
                    .header(
                        "Authorization",
                        format!("Bearer {}", login.tokens.access_token),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &response.into_body().collect().await.unwrap().to_bytes()
            )
            .unwrap(),
            json!({"generation": 0})
        );
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/preview/inspect")
                    .header("Cookie", format!("terminal_preview_token={preview}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &response.into_body().collect().await.unwrap().to_bytes()
            )
            .unwrap(),
            json!({"generation": null})
        );
    }

    #[tokio::test]
    async fn runtime_authentication_distinguishes_local_and_paired_credentials() {
        use sha2::Digest;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "credential-classification-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let path = "/api/structured/sessions/example/ws";
        let (local, authority) =
            authenticate_runtime_with_authority(&state, &login.tokens.access_token, "GET", path)
                .unwrap();
        assert_eq!(local.user_id, login.user.id);
        assert_eq!(authority.unwrap().generation_for(&local.user_id), Some(0));

        let paired = format!("tv4pair.{}", "a".repeat(64));
        assert!(crate::paired_environments::capabilities_for_token(&state, &paired).is_none());
        let hash = hex::encode(sha2::Sha256::digest(paired.as_bytes()));
        state.lock_db().unwrap().execute(
            "INSERT INTO paired_grants(id,hash,owner,username,label,created,expires,capabilities) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params!["fixture-grant", hash, login.user.id, "fixture", "fixture", 0_i64, i64::MAX, r#"{"agentExecute":true}"#],
        ).unwrap();
        let (paired_user, paired_authority) =
            authenticate_runtime_with_authority(&state, &paired, "GET", path).unwrap();
        assert_eq!(paired_user.user_id, local.user_id);
        assert!(paired_authority.is_none());
        state.logout_user(&local.user_id).unwrap();
        assert!(authenticate_runtime_with_authority(
            &state,
            &login.tokens.access_token,
            "GET",
            path
        )
        .is_err());
        assert!(
            authenticate_runtime_with_authority(&state, "tv4pair.invalid", "GET", path).is_err()
        );
        assert!(authenticate_runtime_with_authority(&state, &paired, "GET", path).is_ok());
    }

    #[tokio::test]
    async fn logout_closes_an_existing_owner_event_stream() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "stream-revocation-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let auth = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let event = || async {
            (
                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                Body::from_stream(futures_util::stream::pending::<
                    Result<axum::body::Bytes, std::convert::Infallible>,
                >()),
            )
        };
        let router = Router::new()
            .route("/events", get(event))
            .route("/api/preview/events", get(event))
            .layer(middleware::from_fn_with_state(state.clone(), require_auth));
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/events")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {}", auth.tokens.access_token),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let preview = preview_token_for_access(&state, &auth.tokens.access_token).unwrap();
        let preview_response = router
            .oneshot(
                Request::builder()
                    .uri("/api/preview/events")
                    .header(
                        axum::http::header::COOKIE,
                        format!("terminal_preview_token={preview}"),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preview_response.status(), StatusCode::OK);
        state.logout_user(&auth.user.id).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            response.into_body().collect(),
        )
        .await
        .expect("revoked event stream must close")
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            preview_response.into_body().collect(),
        )
        .await
        .expect("revoked preview event stream must close")
        .unwrap();
    }
}
