use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
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
            authenticate_token(
                &state.config().jwt_secret,
                state.config().allowed_username.as_deref(),
                token,
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

    request.extensions_mut().insert(user);

    next.run(request).await
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
