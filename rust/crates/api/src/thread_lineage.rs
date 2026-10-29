use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, StatusCode},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_LINKS: usize = 5000;
const MAX_ID: usize = 256;
const MAX_BODY: usize = 4 * 1024;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/thread-lineage",
            axum::routing::get(read_links).put(write_link),
        )
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Link {
    parent_id: String,
    kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    owner: String,
    links: BTreeMap<String, Link>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    child_id: String,
    parent_id: String,
    kind: String,
}

enum Failure {
    Invalid(&'static str),
    Conflict(&'static str),
    Storage(&'static str),
}

fn file_path(data: &Path, owner: &str) -> PathBuf {
    data.join("thread-lineage").join(format!(
        "{}.json",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(owner.as_bytes()))
    ))
}

fn load(data: &Path, owner: &str) -> Result<Stored, Failure> {
    let path = file_path(data, owner);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Stored {
                version: 1,
                owner: owner.into(),
                links: BTreeMap::new(),
            })
        }
        Err(_) => return Err(Failure::Storage("Thread lineage storage is unavailable")),
        Ok(meta) if !meta.is_file() || meta.len() > 4 * 1024 * 1024 => {
            return Err(Failure::Storage("Thread lineage storage is unsafe"))
        }
        Ok(_) => {}
    }
    let bytes = std::fs::read(&path)
        .map_err(|_| Failure::Storage("Thread lineage storage is unavailable"))?;
    let stored: Stored = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::Storage("Thread lineage storage is invalid"))?;
    if stored.version != 1 || stored.owner != owner {
        return Err(Failure::Storage("Thread lineage storage owner mismatch"));
    }
    Ok(stored)
}

fn save(data: &Path, stored: &Stored) -> Result<(), Failure> {
    let directory = data.join("thread-lineage");
    std::fs::create_dir_all(&directory)
        .map_err(|_| Failure::Storage("Cannot prepare thread lineage storage"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
    }
    let bytes =
        serde_json::to_vec(stored).map_err(|_| Failure::Storage("Cannot encode thread lineage"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| Failure::Storage("Cannot prepare thread lineage"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| Failure::Storage("Cannot save thread lineage"))?;
    temporary
        .persist(file_path(data, &stored.owner))
        .map_err(|_| Failure::Storage("Cannot save thread lineage"))?;
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && !id.chars().any(char::is_control)
}

fn apply(data: &Path, owner: &str, input: Input) -> Result<Stored, Failure> {
    if !valid_id(&input.child_id) || !valid_id(&input.parent_id) {
        return Err(Failure::Invalid("Invalid thread id"));
    }
    if input.kind != "fork" && input.kind != "worktree" {
        return Err(Failure::Invalid("Unknown relationship kind"));
    }
    if input.child_id == input.parent_id {
        return Err(Failure::Invalid("A thread cannot be its own parent"));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut stored = load(data, owner)?;
    let link = Link {
        parent_id: input.parent_id.clone(),
        kind: input.kind,
    };
    match stored.links.get(&input.child_id) {
        Some(existing) if *existing == link => return Ok(stored),
        Some(_) => return Err(Failure::Conflict("Thread already has a different parent")),
        None => {}
    }
    let mut cursor = Some(input.parent_id.as_str());
    let mut hops = 0;
    while let Some(id) = cursor {
        if id == input.child_id || hops > MAX_LINKS {
            return Err(Failure::Invalid("Relationship would create a cycle"));
        }
        cursor = stored.links.get(id).map(|l| l.parent_id.as_str());
        hops += 1;
    }
    if stored.links.len() >= MAX_LINKS {
        return Err(Failure::Invalid("Too many saved thread relationships"));
    }
    stored.links.insert(input.child_id, link);
    save(data, &stored)?;
    Ok(stored)
}

fn view(stored: &Stored) -> Value {
    let links: Vec<Value> = stored
        .links
        .iter()
        .map(|(child, link)| json!({"childId": child, "parentId": link.parent_id, "kind": link.kind}))
        .collect();
    json!({"links": links})
}

fn fail(failure: Failure) -> ApiError {
    match failure {
        Failure::Invalid(message) => ApiError::bad_request(message),
        Failure::Storage(message) => ApiError::internal(message),
        Failure::Conflict(message) => ApiError {
            status: StatusCode::CONFLICT,
            message: message.into(),
        },
    }
}

async fn read_links(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let data = state.config().data_dir.clone();
    let stored = tokio::task::spawn_blocking(move || load(&data, &user.user_id))
        .await
        .map_err(|_| ApiError::internal("Thread lineage worker stopped"))?
        .map_err(fail)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(view(&stored)),
    ))
}

async fn write_link(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<Input>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let data = state.config().data_dir.clone();
    let stored = tokio::task::spawn_blocking(move || apply(&data, &user.user_id, input))
        .await
        .map_err(|_| ApiError::internal("Thread lineage worker stopped"))?
        .map_err(fail)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(view(&stored)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{issue_access_token, require_auth};
    use axum::{body::Body, http::Request, middleware};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    fn state() -> AppState {
        AppState::new(AppConfig {
            data_dir: tempfile::tempdir().unwrap().keep(),
            jwt_secret: "lineage-test".into(),
            ..Default::default()
        })
        .unwrap()
    }
    fn router(state: AppState) -> Router {
        routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state)
    }
    fn request(method: &str, user: Option<&str>, body: &str) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri("/api/thread-lineage")
            .header("content-type", "application/json");
        if let Some(user) = user {
            builder = builder.header(
                "authorization",
                format!("Bearer {}", issue_access_token("lineage-test", user, user)),
            );
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }
    async fn json_of(response: axum::response::Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    fn link(child: &str, parent: &str, kind: &str) -> String {
        json!({"childId": child, "parentId": parent, "kind": kind}).to_string()
    }

    #[tokio::test]
    async fn requires_authentication() {
        let response = router(state())
            .oneshot(request("GET", None, ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_recorded_fork_survives_reload_and_is_owner_scoped() {
        let state = state();
        let saved = router(state.clone())
            .oneshot(request(
                "PUT",
                Some("owner"),
                &link("child", "parent", "fork"),
            ))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let expected = json!({"links":[{"childId":"child","parentId":"parent","kind":"fork"}]});
        let reloaded = router(state.clone())
            .oneshot(request("GET", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(json_of(reloaded).await, expected);
        let other = router(state)
            .oneshot(request("GET", Some("other"), ""))
            .await
            .unwrap();
        assert_eq!(json_of(other).await, json!({"links": []}));
    }

    #[tokio::test]
    async fn recording_the_same_link_twice_is_idempotent_and_a_different_parent_conflicts() {
        let state = state();
        for _ in 0..2 {
            let response = router(state.clone())
                .oneshot(request("PUT", Some("owner"), &link("c", "p", "fork")))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        let conflict = router(state.clone())
            .oneshot(request("PUT", Some("owner"), &link("c", "q", "fork")))
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let current = router(state)
            .oneshot(request("GET", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(
            json_of(current).await,
            json!({"links":[{"childId":"c","parentId":"p","kind":"fork"}]})
        );
    }

    #[tokio::test]
    async fn self_parent_cycles_unknown_kinds_and_bad_ids_are_refused() {
        let state = state();
        router(state.clone())
            .oneshot(request("PUT", Some("owner"), &link("b", "a", "fork")))
            .await
            .unwrap();
        let bodies = [
            link("x", "x", "fork"),
            link("a", "b", "fork"),
            link("x", "y", "merge"),
            link("", "y", "fork"),
        ];
        for body in bodies {
            let response = router(state.clone())
                .oneshot(request("PUT", Some("owner"), &body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        }
    }
}
