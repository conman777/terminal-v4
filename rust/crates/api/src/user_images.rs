//! Account-authenticated image routes; paired capabilities are denied separately.
use crate::{auth::AuthenticatedUser, state::AppState, structured_control_error, ApiError};
use axum::{
    body::Body,
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use axum_extra::extract::Multipart;
use serde::Deserialize;
use serde_json::json;
use terminal_v4_core::ImageAttachment;
const MAX_IMAGE: usize = 8 * 1024 * 1024;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/structured/sessions/{id}/attachments", post(upload))
        .route("/api/structured/sessions/{id}/attachments/send", post(send))
        .route(
            "/api/structured/sessions/{id}/attachments/{attachment}",
            get(metadata).delete(cancel),
        )
        .route(
            "/api/structured/sessions/{id}/attachments/{attachment}/content",
            get(content),
        )
        .layer(DefaultBodyLimit::max(MAX_IMAGE + 65_536))
}
fn private(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
}
async fn upload(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    let manager = state.structured_session_manager();
    manager
        .get_session(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    let mut upload_id = None;
    let mut image = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|error| ApiError {
        status: error.status(),
        message: "Invalid or oversized image multipart body".into(),
    })? {
        match field.name() {
            Some("uploadId") if upload_id.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|error| ApiError {
                    status: error.status(),
                    message: "Invalid upload identity".into(),
                })? {
                    if bytes.len() + chunk.len() > 36 {
                        return Err(ApiError::bad_request("uploadId must be a UUID"));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value = String::from_utf8(bytes)
                    .map_err(|_| ApiError::bad_request("uploadId must be a UUID"))?;
                let value = uuid::Uuid::parse_str(&value)
                    .map_err(|_| ApiError::bad_request("uploadId must be a UUID"))?
                    .to_string();
                upload_id = Some(value);
            }
            Some("image") if image.is_none() => {
                let name = field
                    .file_name()
                    .ok_or_else(|| ApiError::bad_request("An image filename is required"))?
                    .to_owned();
                let mime = field
                    .content_type()
                    .ok_or_else(|| ApiError::bad_request("An image MIME type is required"))?
                    .to_owned();
                if name.is_empty()
                    || name.len() > 255
                    || name
                        .chars()
                        .any(|c| c.is_control() || matches!(c, '/' | '\\'))
                {
                    return Err(ApiError::bad_request("Invalid image filename"));
                }
                if !matches!(
                    mime.as_str(),
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                ) {
                    return Err(ApiError::bad_request("Unsupported image MIME type"));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|error| ApiError {
                    status: error.status(),
                    message: "Invalid or oversized image upload".into(),
                })? {
                    if bytes.len() + chunk.len() > MAX_IMAGE {
                        return Err(ApiError {
                            status: StatusCode::PAYLOAD_TOO_LARGE,
                            message: "Images may contain at most8MiB of uploaded bytes".into(),
                        });
                    }
                    bytes.extend_from_slice(&chunk);
                }
                image = Some((mime, name, bytes));
            }
            _ => {
                return Err(ApiError::bad_request(
                    "Only one uploadId and one image field are accepted",
                ))
            }
        }
    }
    let upload_id = upload_id.ok_or_else(|| ApiError::bad_request("uploadId is required"))?;
    let (mime, name, bytes) =
        image.ok_or_else(|| ApiError::bad_request("One image is required"))?;
    let (attachment, expires_at, created) = manager
        .upload_image(&user.user_id, &id, &upload_id, &mime, &name, bytes)
        .await
        .map_err(structured_control_error)?;
    let mut response = (
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(json!({"status":"ready","attachment":attachment,"expiresAt":expires_at})),
    )
        .into_response();
    private(&mut response);
    Ok(response)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Send {
    request_id: String,
    text: String,
    attachments: Vec<ImageAttachment>,
}
async fn send(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    Path(id): Path<String>,
    input: Result<Json<Send>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(input) = input.map_err(|_| ApiError::bad_request("Invalid image send body"))?;
    let receipt = state
        .structured_session_manager()
        .submit_images_authorized(
            &user.user_id,
            &id,
            &input.text,
            &input.request_id,
            &input.attachments,
            authority.as_ref().map(|Extension(value)| value),
            &state,
        )
        .await
        .map_err(structured_control_error)?;
    let mut response = (StatusCode::ACCEPTED, Json(json!(receipt))).into_response();
    private(&mut response);
    Ok(response)
}
async fn metadata(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, attachment)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let (attachment, _, expires_at) = state
        .structured_session_manager()
        .read_user_image(&user.user_id, &id, &attachment)
        .await
        .map_err(structured_control_error)?;
    let mut response =
        Json(json!({"status":"ready","attachment":attachment,"expiresAt":expires_at}))
            .into_response();
    private(&mut response);
    Ok(response)
}
async fn content(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, attachment)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let (attachment, bytes, _) = state
        .structured_session_manager()
        .read_user_image(&user.user_id, &id, &attachment)
        .await
        .map_err(structured_control_error)?;
    let mut response = Body::from(bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        attachment
            .mime_type
            .parse()
            .map_err(|_| ApiError::internal("Invalid stored image MIME type"))?,
    );
    private(&mut response);
    Ok(response)
}
async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((id, attachment)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    state
        .structured_session_manager()
        .cancel_user_image(&user.user_id, &id, &attachment)
        .await
        .map_err(structured_control_error)?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    private(&mut response);
    Ok(response)
}
