use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceAuthInput {
    target_path: String,
    root: Option<String>,
}

fn request_controller_origin(headers: &HeaderMap) -> Option<String> {
    let mut origins = headers.get_all(axum::http::header::ORIGIN).iter();
    let origin = super::auth_urls::normalized_controller_origin(origins.next()?.to_str().ok()?)?;
    if origins.next().is_some() {
        return None;
    }
    let mut forwarded = headers
        .get_all("x-terminal-preview-controller-origin")
        .iter();
    let Some(value) = forwarded.next() else {
        return Some(origin);
    };
    let origin = super::auth_urls::normalized_controller_origin(value.to_str().ok()?)?;
    forwarded.next().is_none().then_some(origin)
}

pub(crate) async fn issue_resource_auth(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    headers: HeaderMap,
    Json(input): Json<ResourceAuthInput>,
) -> Result<Json<Value>, ApiError> {
    let owner_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .filter(|token| {
            crate::auth::authenticate_local_token(&state, token)
                .is_ok_and(|owner| owner.user_id == user.user_id)
        })
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "A direct owner login is required to authorize a preview resource".into(),
        })?;
    let raw_path = input
        .target_path
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    if input.target_path.len() > 64 * 1024
        || input.target_path.chars().any(char::is_control)
        || raw_path.contains('\\')
        || raw_path.split('/').any(|part| {
            matches!(
                part.to_ascii_lowercase().as_str(),
                "." | ".." | "%2e" | ".%2e" | "%2e." | "%2e%2e"
            )
        })
    {
        return Err(ApiError::bad_request("Invalid preview target path"));
    }
    let target_path =
        super::auth_urls::sanitized_target(&state, &input.target_path).ok_or_else(|| {
            ApiError::bad_request("Preview target must be an application-relative path")
        })?;
    let target = url::Url::parse("http://preview.invalid")
        .unwrap()
        .join(&target_path)
        .map_err(|_| ApiError::bad_request("Invalid preview target"))?;
    let (environment, path) = if let Some(rest) = target.path().strip_prefix("/api/environments/") {
        let (id, path) = rest
            .split_once("/proxy")
            .filter(|(id, path)| !id.is_empty() && !id.contains('/') && path.starts_with('/'))
            .ok_or_else(|| ApiError::bad_request("Invalid paired preview target"))?;
        (Some(id), path)
    } else {
        (None, target.path())
    };
    let mut root = None;
    let prefix = if let Some((port, _)) =
        super::extract_port_from_path(path).filter(|(port, _)| *port != 0)
    {
        if input.root.is_some() {
            return Err(ApiError::bad_request(
                "Port previews do not accept a project root",
            ));
        }
        format!("/preview/{port}")
    } else if path == "/api/preview" {
        let roots = target
            .query_pairs()
            .filter(|(name, _)| name == "path")
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>();
        if roots.len() != 1 || roots[0].is_empty() {
            return Err(ApiError::bad_request(
                "Static preview requires one project path",
            ));
        }
        if input.root.as_deref().is_some_and(|root| root != roots[0]) {
            return Err(ApiError::bad_request(
                "Preview project root does not match the target",
            ));
        }
        if environment.is_none() {
            super::static_files::validate_preview_root(&roots[0])
                .await
                .map_err(ApiError::bad_request)?;
        }
        root = Some(roots[0].clone());
        "/api/preview".into()
    } else if path == "/api/proxy-external" {
        if environment.is_some() {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                message: "External website previews are unavailable through paired environments"
                    .into(),
            });
        }
        let urls = target
            .query_pairs()
            .filter(|(name, _)| name == "url")
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>();
        if urls.len() != 1 {
            return Err(ApiError::bad_request(
                "External preview requires one target URL",
            ));
        }
        let normalized =
            super::external_proxy::normalized_target(&urls[0]).map_err(ApiError::bad_request)?;
        if let Some(explicit) = input.root.as_deref() {
            if super::external_proxy::normalized_target(explicit).map_err(ApiError::bad_request)?
                != normalized
            {
                return Err(ApiError::bad_request(
                    "External preview URL does not match the target",
                ));
            }
        }
        root = Some(normalized);
        "/api/proxy-external".into()
    } else {
        return Err(ApiError::bad_request("Unsupported preview resource target"));
    };
    let prefix = if let Some(id) = environment {
        crate::paired_environments::authorize_resource_target(&state, &user, id, path)?;
        format!("/api/environments/{id}/proxy{prefix}")
    } else {
        prefix
    };
    let controller_origin = request_controller_origin(&headers);
    let controller_port = super::extract_port_from_path(path).map(|(port, _)| port);
    let controller_allowed = controller_port.is_some_and(|port| {
        environment.is_none_or(|id| {
            crate::paired_environments::resource_controller_allowed(&state, &user, id, port)
        })
    });
    let token = if let Some(origin) = controller_origin.as_deref().filter(|_| controller_allowed) {
        super::auth_urls::controller_resource_token(&state, owner_token, &prefix, origin)
    } else {
        super::auth_urls::resource_token_for_root(&state, owner_token, &prefix, root.as_deref())
    }
    .ok_or_else(|| ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "Preview authorization expired".into(),
    })?;
    Ok(Json(
        json!({ "previewToken": token, "expiresAt": super::auth_urls::expires_at(&state, &token), "targetPath": target_path }),
    ))
}
