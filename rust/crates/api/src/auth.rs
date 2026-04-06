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
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let token = bearer_token(&request).or_else(|| query_token(&request));
    let Some(token) = token else {
        return auth_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    let user = match authenticate_token(
        &state.config().jwt_secret,
        state.config().allowed_username.as_deref(),
        token,
    ) {
        Ok(user) => user,
        Err(message) => return auth_error(StatusCode::UNAUTHORIZED, &message),
    };

    request.extensions_mut().insert(user);

    next.run(request).await
}

pub fn authenticate_token(
    secret: &str,
    allowed_username: Option<&str>,
    token: &str,
) -> Result<AuthenticatedUser, String> {
    let decoded = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| "Invalid or expired token".to_string())?;

    if let Some(allowed_username) = allowed_username {
        if decoded.claims.username != allowed_username {
            return Err("Unauthorized".to_string());
        }
    }

    Ok(AuthenticatedUser {
        user_id: decoded.claims.sub,
        username: decoded.claims.username,
    })
}

fn bearer_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn query_token(request: &Request) -> Option<&str> {
    request.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key == "token" {
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
            exp: now + 3600,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("token should encode")
}
