//! Explicit unavailable adapter until platform-private lease storage is ported.
use crate::state::AppState;
use axum::{
    http::{header, StatusCode},
    response::IntoResponse,
    routing::any,
    Json, Router,
};
use serde_json::json;
#[derive(Clone)]
pub struct ProviderConnectionManager;
impl ProviderConnectionManager {
    pub(crate) fn request_drain(&self) {}
    pub fn new(_: &std::path::Path) -> Result<Self, String> {
        Ok(Self)
    }
    pub async fn shutdown(&self) -> bool {
        true
    }
}
async fn unavailable() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(
            json!({"code":"provider_connections_unavailable","error":"Provider connection profiles are not available on this platform yet."}),
        ),
    )
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/connections", any(unavailable))
        .route("/api/agent/connections/{profile}", any(unavailable))
        .route(
            "/api/agent/connections/{profile}/operations/{operation}",
            any(unavailable),
        )
        .route(
            "/api/agent/connections/{profile}/discoveries",
            any(unavailable),
        )
        .route(
            "/api/agent/connection-discoveries/{request}",
            any(unavailable),
        )
        .route(
            "/api/agent/connections/{profile}/discoveries/{request}/cancel",
            any(unavailable),
        )
}
