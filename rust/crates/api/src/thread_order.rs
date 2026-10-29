use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, StatusCode},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_THREADS_PER_PROJECT: usize = 500;
const MAX_PROJECTS: usize = 200;
const MAX_ID: usize = 256;
const MAX_PATH: usize = 1024;
const MAX_BODY: usize = 128 * 1024;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/thread-order",
            axum::routing::get(read_order).put(write_order),
        )
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    owner: String,
    revision: u64,
    projects: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    project_path: String,
    order: Vec<String>,
    expected_revision: u64,
}

enum Failure {
    Invalid(&'static str),
    Stale(Stored),
    Storage(&'static str),
}

fn file_path(data: &Path, owner: &str) -> PathBuf {
    data.join("thread-order").join(format!(
        "{}.json",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(owner.as_bytes()))
    ))
}

fn load(data: &Path, owner: &str) -> Result<Stored, Failure> {
    let path = file_path(data, owner);
    let fresh = Stored {
        version: 1,
        owner: owner.into(),
        revision: 0,
        projects: BTreeMap::new(),
    };
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(fresh),
        Err(_) => return Err(Failure::Storage("Thread order storage is unavailable")),
        Ok(meta) if !meta.is_file() || meta.len() > MAX_BODY as u64 * 8 => {
            return Err(Failure::Storage("Thread order storage is unsafe"))
        }
        Ok(_) => {}
    }
    let bytes = std::fs::read(&path)
        .map_err(|_| Failure::Storage("Thread order storage is unavailable"))?;
    let stored: Stored = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::Storage("Thread order storage is invalid"))?;
    if stored.version != 1 || stored.owner != owner {
        return Err(Failure::Storage("Thread order storage owner mismatch"));
    }
    Ok(stored)
}

fn save(data: &Path, stored: &Stored) -> Result<(), Failure> {
    let directory = data.join("thread-order");
    std::fs::create_dir_all(&directory)
        .map_err(|_| Failure::Storage("Cannot prepare thread order storage"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
    }
    let bytes =
        serde_json::to_vec(stored).map_err(|_| Failure::Storage("Cannot encode thread order"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| Failure::Storage("Cannot prepare thread order"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| Failure::Storage("Cannot save thread order"))?;
    temporary
        .persist(file_path(data, &stored.owner))
        .map_err(|_| Failure::Storage("Cannot save thread order"))?;
    Ok(())
}

fn validate(update: &Update) -> Result<(), Failure> {
    if update.project_path.is_empty()
        || update.project_path.len() > MAX_PATH
        || update.project_path.chars().any(char::is_control)
    {
        return Err(Failure::Invalid("Invalid project path"));
    }
    if update.order.len() > MAX_THREADS_PER_PROJECT {
        return Err(Failure::Invalid("Too many threads in one project order"));
    }
    let mut seen = HashSet::new();
    for id in &update.order {
        if id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control) {
            return Err(Failure::Invalid("Invalid thread id"));
        }
        if !seen.insert(id) {
            return Err(Failure::Invalid("Thread ids must be unique"));
        }
    }
    Ok(())
}

fn apply(data: &Path, owner: &str, update: Update) -> Result<Stored, Failure> {
    validate(&update)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut stored = load(data, owner)?;
    if stored.revision != update.expected_revision {
        return Err(Failure::Stale(stored));
    }
    if !stored.projects.contains_key(&update.project_path) && stored.projects.len() >= MAX_PROJECTS
    {
        return Err(Failure::Invalid("Too many projects with a saved order"));
    }
    if update.order.is_empty() {
        stored.projects.remove(&update.project_path);
    } else {
        stored.projects.insert(update.project_path, update.order);
    }
    stored.revision += 1;
    save(data, &stored)?;
    Ok(stored)
}

fn view(stored: &Stored) -> Value {
    json!({"revision": stored.revision, "projects": stored.projects})
}

fn fail(failure: Failure) -> ApiError {
    match failure {
        Failure::Invalid(message) => ApiError::bad_request(message),
        Failure::Storage(message) => ApiError::internal(message),
        Failure::Stale(_) => ApiError {
            status: StatusCode::CONFLICT,
            message: "Thread order changed elsewhere".into(),
        },
    }
}

async fn read_order(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let data = state.config().data_dir.clone();
    let stored = tokio::task::spawn_blocking(move || load(&data, &user.user_id))
        .await
        .map_err(|_| ApiError::internal("Thread order worker stopped"))?
        .map_err(fail)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(view(&stored)),
    ))
}

async fn write_order(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(update): Json<Update>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let data = state.config().data_dir.clone();
    let result = tokio::task::spawn_blocking(move || apply(&data, &user.user_id, update))
        .await
        .map_err(|_| ApiError::internal("Thread order worker stopped"))?;
    match result {
        Ok(stored) => Ok((
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(view(&stored)),
        )
            .into_response()),
        Err(Failure::Stale(current)) => Ok((
            StatusCode::CONFLICT,
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(json!({"error": "Thread order changed elsewhere", "current": view(&current)})),
        )
            .into_response()),
        Err(other) => Err(fail(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{issue_access_token, require_auth};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
    };
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    fn state() -> AppState {
        AppState::new(AppConfig {
            data_dir: tempfile::tempdir().unwrap().keep(),
            jwt_secret: "order-test".into(),
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
            .uri("/api/thread-order")
            .header("content-type", "application/json");
        if let Some(user) = user {
            builder = builder.header(
                "authorization",
                format!("Bearer {}", issue_access_token("order-test", user, user)),
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
    fn put_body(project: &str, order: &[&str], revision: u64) -> String {
        json!({"projectPath": project, "order": order, "expectedRevision": revision}).to_string()
    }

    #[tokio::test]
    async fn requires_authentication() {
        let app = router(state());
        for method in ["GET", "PUT"] {
            let response = app
                .clone()
                .oneshot(request(method, None, &put_body("/p", &["a"], 0)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[tokio::test]
    async fn saved_order_is_written_to_disk_and_survives_a_new_router() {
        let state = state();
        let saved = router(state.clone())
            .oneshot(request(
                "PUT",
                Some("owner"),
                &put_body("/p", &["b", "a"], 0),
            ))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(
            json_of(saved).await,
            json!({"revision": 1, "projects": {"/p": ["b", "a"]}})
        );
        let on_disk = load(&state.config().data_dir, "owner").ok().unwrap();
        assert_eq!(
            on_disk.projects["/p"],
            vec!["b".to_string(), "a".to_string()]
        );
        let reloaded = router(state)
            .oneshot(request("GET", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(
            json_of(reloaded).await,
            json!({"revision": 1, "projects": {"/p": ["b", "a"]}})
        );
    }

    #[tokio::test]
    async fn another_owner_sees_and_changes_only_their_own_order() {
        let state = state();
        router(state.clone())
            .oneshot(request(
                "PUT",
                Some("owner"),
                &put_body("/p", &["a", "b"], 0),
            ))
            .await
            .unwrap();
        let other = router(state.clone())
            .oneshot(request("GET", Some("other"), ""))
            .await
            .unwrap();
        assert_eq!(json_of(other).await, json!({"revision": 0, "projects": {}}));
        let other_write = router(state.clone())
            .oneshot(request("PUT", Some("other"), &put_body("/p", &["z"], 0)))
            .await
            .unwrap();
        assert_eq!(other_write.status(), StatusCode::OK);
        let owner = router(state)
            .oneshot(request("GET", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(
            json_of(owner).await,
            json!({"revision": 1, "projects": {"/p": ["a", "b"]}})
        );
    }

    #[tokio::test]
    async fn stale_revision_is_rejected_with_the_current_order_and_changes_nothing() {
        let state = state();
        router(state.clone())
            .oneshot(request(
                "PUT",
                Some("owner"),
                &put_body("/p", &["a", "b"], 0),
            ))
            .await
            .unwrap();
        let stale = router(state.clone())
            .oneshot(request(
                "PUT",
                Some("owner"),
                &put_body("/p", &["b", "a"], 0),
            ))
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_of(stale).await["current"],
            json!({"revision": 1, "projects": {"/p": ["a", "b"]}})
        );
        let current = router(state)
            .oneshot(request("GET", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(
            json_of(current).await,
            json!({"revision": 1, "projects": {"/p": ["a", "b"]}})
        );
    }

    #[tokio::test]
    async fn only_one_of_two_concurrent_writes_at_the_same_revision_wins() {
        let state = state();
        let app = router(state);
        let first = app.clone().oneshot(request(
            "PUT",
            Some("owner"),
            &put_body("/p", &["a", "b"], 0),
        ));
        let second = app.clone().oneshot(request(
            "PUT",
            Some("owner"),
            &put_body("/p", &["b", "a"], 0),
        ));
        let (first, second) = tokio::join!(first, second);
        let mut statuses = vec![first.unwrap().status(), second.unwrap().status()];
        statuses.sort();
        assert_eq!(statuses, vec![StatusCode::OK, StatusCode::CONFLICT]);
    }

    #[tokio::test]
    async fn invalid_orders_are_refused() {
        let app = router(state());
        let too_many: Vec<String> = (0..=MAX_THREADS_PER_PROJECT)
            .map(|i| format!("t{i}"))
            .collect();
        let bodies = [
            put_body("/p", &["a", "a"], 0),
            put_body("/p", &[""], 0),
            put_body("", &["a"], 0),
            json!({"projectPath":"/p","order":too_many,"expectedRevision":0}).to_string(),
            json!({"projectPath":"/p","order":["a"],"expectedRevision":0,"extra":1}).to_string(),
        ];
        for body in bodies {
            let response = app
                .clone()
                .oneshot(request("PUT", Some("owner"), &body))
                .await
                .unwrap();
            assert!(
                response.status() == StatusCode::BAD_REQUEST
                    || response.status() == StatusCode::UNPROCESSABLE_ENTITY,
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn an_empty_order_clears_the_project() {
        let state = state();
        router(state.clone())
            .oneshot(request("PUT", Some("owner"), &put_body("/p", &["a"], 0)))
            .await
            .unwrap();
        let cleared = router(state)
            .oneshot(request("PUT", Some("owner"), &put_body("/p", &[], 1)))
            .await
            .unwrap();
        assert_eq!(
            json_of(cleared).await,
            json!({"revision": 2, "projects": {}})
        );
    }
}
