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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    username: String,
    exp: usize,
    iat: usize,
    #[serde(default = "default_token_kind")]
    token_kind: String,
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let user = match access_token(&request)
        .and_then(|token| {
            authenticate_runtime_request(
                &state,
                token,
                request.method().as_str(),
                request.uri().path(),
            )
            .ok()
        })
        .or_else(|| {
            preview_token(&request).and_then(|token| {
                authenticate_preview_token(
                    &state.config().jwt_secret,
                    state.config().allowed_username.as_deref(),
                    token,
                    request.uri().path(),
                )
                .ok()
            })
        }) {
        Some(user) => user,
        None => return auth_error(StatusCode::UNAUTHORIZED, "Unauthorized"),
    };

    let delegated = access_token(&request)
        .filter(|token| token.starts_with("tv4pair."))
        .map(str::to_owned);
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    request.extensions_mut().insert(user);
    let response = next.run(request).await;
    if let Some(token) = delegated {
        if response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"))
        {
            return guard_paired_event_stream(state, token, method, path, response);
        }
    }
    response
}

fn guard_paired_event_stream(
    state: AppState,
    token: String,
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
                    if authenticate_runtime_request(&state,&token,&method,&path).is_err(){break;}
                },
                permit=sender.reserve(),if pending.is_some()=>{
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
    authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        token,
    )
    .or_else(|_| {
        crate::paired_environments::authorize_request(state, token, method, path)
            .ok_or_else(|| "Invalid, expired, revoked or unauthorized token".into())
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
    authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        token,
    )
    .is_ok()
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

fn validate_allowed_username(allowed_username: Option<&str>, username: &str) -> Result<(), String> {
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

pub fn issue_access_token(secret: &str, user_id: &str, username: &str) -> String {
    issue_token(secret, user_id, username, "access", 3600)
}

pub fn issue_preview_token(secret: &str, user_id: &str, username: &str) -> String {
    issue_token(secret, user_id, username, "preview", 900)
}

fn issue_token(
    secret: &str,
    user_id: &str,
    username: &str,
    token_kind: &str,
    ttl_seconds: usize,
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
