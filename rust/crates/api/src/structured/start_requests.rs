//! Durable at-most-once claims for structured session creation.

use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    request_id: String,
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    service_tier: Option<String>,
    title: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    cwd: String,
    provider: String,
    model: Option<String>,
    reasoning: Option<String>,
    service_tier: Option<String>,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    request_id: String,
    status: &'static str,
    selection: Selection,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/structured/start-requests", post(create))
        .route("/api/structured/start-requests/{request_id}", get(retrieve))
}

fn request_id(value: &str) -> Result<String, ApiError> {
    let id =
        Uuid::parse_str(value).map_err(|_| ApiError::bad_request("Invalid start request ID"))?;
    if id.is_nil() {
        return Err(ApiError::bad_request("Invalid start request ID"));
    }
    Ok(id.to_string())
}

fn receipt(claim: Claim, request_id: String, selection: Selection) -> (StatusCode, Json<Receipt>) {
    match claim {
        Claim::Pending | Claim::New => (
            StatusCode::ACCEPTED,
            Json(Receipt {
                request_id,
                status: "pending",
                selection,
                session_id: None,
            }),
        ),
        Claim::Created(session) => (
            StatusCode::OK,
            Json(Receipt {
                request_id,
                status: "created",
                selection,
                session_id: Some(session),
            }),
        ),
    }
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<Input>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    #[cfg(not(unix))]
    return Err(ApiError::bad_request(
        "Durable start requests are unavailable on this platform",
    ));
    #[cfg(unix)]
    {
        let id = request_id(&input.request_id)?;
        crate::validate_string(&input.cwd, 1, 4096, "cwd")?;
        if let Some(value) = &input.provider {
            crate::validate_string(value, 1, 1024, "provider")?;
        }
        if let Some(value) = &input.model {
            crate::validate_string(value, 1, 200, "model")?;
        }
        if let Some(value) = &input.reasoning {
            crate::validate_string(value, 1, 40, "reasoning")?;
        }
        if let Some(value) = &input.title {
            crate::validate_string(value, 1, 80, "title")?;
        }
        if let Some(value) = &input.service_tier {
            crate::validate_string(value, 1, 40, "serviceTier")?;
        }
        let provider = input
            .provider
            .as_deref()
            .unwrap_or("claude")
            .trim()
            .to_owned();
        let manager = state.structured_session_manager();
        let own = crate::v4_agent::supports(&provider);
        if !own && !manager.inner.providers.contains_key(&provider) {
            return Err(ApiError::bad_request("Unknown provider"));
        }
        if input.service_tier.as_deref().is_some_and(|value| {
            provider != "codex" || !matches!(value, "default" | "fast" | "ultrafast")
        }) {
            return Err(ApiError::bad_request("Unsupported Codex speed setting"));
        }
        if provider == "claude"
            && input
                .reasoning
                .as_deref()
                .is_some_and(|value| !super::CLAUDE_EFFORT_LEVELS.contains(&value))
        {
            return Err(ApiError::bad_request("Unsupported Claude effort level"));
        }
        if !own && provider != "codex" && provider != "claude" && input.reasoning.is_some() {
            return Err(ApiError::bad_request(
                "This native structured adapter does not support reasoning selection",
            ));
        }
        let model = if own {
            Some(
                crate::v4_agent::resolve_selection(
                    &provider,
                    input.model.as_deref(),
                    input.reasoning.as_deref(),
                )
                .map_err(ApiError::bad_request)?,
            )
        } else {
            input.model
        };
        let selection = Selection {
            cwd: super::normalize_structured_cwd(&input.cwd).map_err(ApiError::bad_request)?,
            title: super::normalize_structured_title(input.title.as_deref(), &provider),
            provider,
            model,
            reasoning: input.reasoning,
            service_tier: input.service_tier,
        };
        let encoded = serde_json::to_vec(&selection)
            .map_err(|_| ApiError::internal("Cannot encode start request"))?;
        let claim = {
            let mut db = state.lock_db().map_err(ApiError::internal)?;
            require_durable_database(&db).map_err(ApiError::internal)?;
            claim(&mut db, &user.user_id, &id, &encoded).map_err(|error| {
                if error == "This start request belongs to different inputs" {
                    ApiError {
                        status: StatusCode::CONFLICT,
                        message: error,
                    }
                } else {
                    ApiError::internal(error)
                }
            })?
        };
        if claim != Claim::New {
            return Ok(receipt(claim, id, selection));
        }
        let snapshot = manager
            .create_with_options(
                &user.user_id,
                &selection.cwd,
                Some(&selection.provider),
                selection.model.as_deref(),
                selection.reasoning.as_deref(),
                selection.service_tier.as_deref(),
                Some(&selection.title),
            )
            .await
            .map_err(|_| {
                ApiError::internal(
                    "Conversation creation is unconfirmed; review this start request",
                )
            })?;
        confirm_and_complete(&manager, &state, &user.user_id, &id, &snapshot)
            .await
            .map_err(|_| {
                ApiError::internal(
                    "Conversation creation is unconfirmed; review this start request",
                )
            })?;
        Ok(receipt(Claim::Created(snapshot.id), id, selection))
    }
}

async fn retrieve(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(request): Path<String>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    let id = request_id(&request)?;
    let db = state.lock_db().map_err(ApiError::internal)?;
    let (status, encoded) = lookup(&db, &user.user_id, &id)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("Start request not found"))?;
    let selection = serde_json::from_slice(&encoded)
        .map_err(|_| ApiError::internal("Start request storage is invalid"))?;
    Ok(receipt(status, id, selection))
}

#[cfg(unix)]
async fn confirm_and_complete(
    manager: &super::StructuredSessionManager,
    app: &AppState,
    owner: &str,
    request: &str,
    snapshot: &terminal_v4_core::StructuredSessionSnapshot,
) -> Result<(), String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let session = manager
        .owned_session(owner, &snapshot.id)
        .await?
        .ok_or("Created session is unavailable")?;
    let _lifecycle = session.lifecycle.lock().await;
    let state = session.state.lock().await;
    if state.user_id != owner
        || state.id != snapshot.id
        || state.deleting
        || state.session_incarnation.is_none()
    {
        return Err("Created session is unavailable".into());
    }
    let directory = super::structured_user_dir(&manager.inner.config, owner);
    let path = super::structured_session_path(&manager.inner.config, owner, &snapshot.id);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "Created session is unavailable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Created session is unavailable")?;
    if !metadata.is_file() || metadata.len() > super::MAX_STRUCTURED_FILE_BYTES as u64 {
        return Err("Created session is invalid".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(super::MAX_STRUCTURED_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Created session is unavailable")?;
    let stored = super::storage::decode(&bytes)?;
    if stored.owner_id != owner
        || stored.snapshot.id != state.id
        || stored.session_incarnation != state.session_incarnation
    {
        return Err("Created session identity changed".into());
    }
    file.sync_all().map_err(|_| "Cannot sync created session")?;
    for path in [
        &directory,
        &manager.inner.config.data_dir.join("structured-sessions"),
        &manager.inner.config.data_dir,
    ] {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Cannot inspect session directory")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Session directory is unsafe".into());
        }
        std::fs::File::open(path)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "Cannot sync session directory")?;
    }
    let mut db = app.lock_db()?;
    require_durable_database(&db)?;
    complete(&mut db, owner, request, &snapshot.id)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Claim {
    New,
    Pending,
    Created(String),
}

fn schema(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS structured_start_requests (owner TEXT NOT NULL, request_id TEXT NOT NULL, input_digest BLOB NOT NULL, input_json BLOB NOT NULL, session_id TEXT, PRIMARY KEY(owner, request_id))")
        .map_err(|_| "Start request storage is unavailable".into())
}

fn require_durable_database(db: &Connection) -> Result<(), String> {
    let sync: i64 = db
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(|_| "Cannot verify start request durability")?;
    let mode: String = db
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| "Cannot verify start request durability")?;
    if sync < 2 || matches!(mode.to_ascii_lowercase().as_str(), "off" | "memory") {
        return Err(
            "Start requests require durable SQLite journal and synchronous settings".into(),
        );
    }
    Ok(())
}

pub(super) fn claim(
    db: &mut Connection,
    owner: &str,
    request: &str,
    encoded: &[u8],
) -> Result<Claim, String> {
    schema(db)?;
    let digest = Sha256::digest(encoded);
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "Start request storage is unavailable")?;
    let existing: Option<(Vec<u8>, Vec<u8>, Option<String>)> = tx.query_row(
        "SELECT input_digest,input_json,session_id FROM structured_start_requests WHERE owner=?1 AND request_id=?2",
        params![owner, request], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|_| "Start request storage is unavailable")?;
    let result = if let Some((stored, stored_input, session)) = existing {
        if stored != digest.as_slice() || stored_input != encoded {
            return Err("This start request belongs to different inputs".into());
        }
        session.map_or(Claim::Pending, Claim::Created)
    } else {
        let count: u64 = tx
            .query_row(
                "SELECT count(*) FROM structured_start_requests WHERE owner=?1",
                [owner],
                |row| row.get(0),
            )
            .map_err(|_| "Start request storage is unavailable")?;
        if count >= 100_000 {
            return Err("Start request storage is full".into());
        }
        tx.execute("INSERT INTO structured_start_requests (owner,request_id,input_digest,input_json) VALUES (?1,?2,?3,?4)", params![owner, request, digest.as_slice(), encoded])
            .map_err(|_| "Cannot reserve start request")?;
        Claim::New
    };
    tx.commit().map_err(|_| "Cannot commit start request")?;
    Ok(result)
}

pub(super) fn complete(
    db: &mut Connection,
    owner: &str,
    request: &str,
    session: &str,
) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "Start request storage is unavailable")?;
    let changed = tx.execute("UPDATE structured_start_requests SET session_id=?3 WHERE owner=?1 AND request_id=?2 AND session_id IS NULL", params![owner, request, session])
        .map_err(|_| "Cannot record start request")?;
    if changed != 1 {
        return Err("Start request is no longer pending".into());
    }
    tx.commit()
        .map_err(|_| "Cannot commit start receipt".into())
}

pub(super) fn lookup(
    db: &Connection,
    owner: &str,
    request: &str,
) -> Result<Option<(Claim, Vec<u8>)>, String> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='structured_start_requests')", [], |row| row.get(0))
        .map_err(|_| "Start request storage is unavailable")?;
    if !exists {
        return Ok(None);
    }
    let result: Option<(Option<String>, Vec<u8>, Vec<u8>)> = db
        .query_row(
            "SELECT session_id,input_json,input_digest FROM structured_start_requests WHERE owner=?1 AND request_id=?2",
            params![owner, request],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| "Start request storage is unavailable")?;
    result
        .map(|(session, encoded, digest)| {
            if encoded.len() > 16_384 || digest != Sha256::digest(&encoded).as_slice() {
                return Err("Start request storage is invalid".into());
            }
            Ok((session.map_or(Claim::Pending, Claim::Created), encoded))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    #[ignore = "invoked by the start-request subprocess race test"]
    fn claim_process_fixture() {
        let root = std::path::PathBuf::from(std::env::var_os("V4_START_RACE_ROOT").unwrap());
        let slot = std::env::var("V4_START_RACE_SLOT").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !root.join("go").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "start signal timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let mut db = Connection::open(root.join("ledger.sqlite")).unwrap();
        db.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        let result = claim(&mut db, "owner", "request", b"canonical-input").unwrap();
        std::fs::write(root.join(slot), format!("{result:?}")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn independent_processes_reserve_only_once_and_pending_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let db = Connection::open(root.path().join("ledger.sqlite")).unwrap();
        schema(&db).unwrap();
        drop(db);
        let executable = std::env::current_exe().unwrap();
        let mut children: Vec<_> = (0..4)
            .map(|i| {
                std::process::Command::new(&executable)
                    .args([
                        "--ignored",
                        "--exact",
                        "structured::start_requests::tests::claim_process_fixture",
                    ])
                    .env("V4_START_RACE_ROOT", root.path())
                    .env("V4_START_RACE_SLOT", format!("result-{i}"))
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        std::fs::write(root.path().join("go"), "go").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        for child in &mut children {
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("claim process timed out");
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        let results: Vec<_> = (0..4)
            .map(|i| std::fs::read_to_string(root.path().join(format!("result-{i}"))).unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|value| value.as_str() == "New")
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|value| value.as_str() == "Pending")
                .count(),
            3
        );
        let mut reopened = Connection::open(root.path().join("ledger.sqlite")).unwrap();
        assert_eq!(
            claim(&mut reopened, "owner", "request", b"canonical-input").unwrap(),
            Claim::Pending
        );
        assert!(claim(&mut reopened, "owner", "request", b"changed").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authenticated_routes_keep_one_receipt_across_retry_conflict_and_deletion() {
        use axum::{body::Body, http::Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().to_owned(),
            jwt_secret: "start-request-test-secret".into(),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let app = crate::app(state.clone());
        let token = crate::auth::issue_access_token("start-request-test-secret", "alice", "alice");
        let other = crate::auth::issue_access_token("start-request-test-secret", "bob", "bob");
        let request = Uuid::new_v4().to_string();
        let input = serde_json::json!({"requestId":request,"cwd":workspace.path(),"provider":"deepseek","model":"deepseek-chat"});
        let call = |method: &str, path: &str, token: &str, input: Option<serde_json::Value>| {
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(input.map_or(String::new(), |v| v.to_string())))
                .unwrap()
        };
        let no_auth = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/structured/start-requests/{request}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        let first = app
            .clone()
            .oneshot(call(
                "POST",
                "/api/structured/start-requests",
                &token,
                Some(input.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.headers().get("cache-control").unwrap(),
            "private, no-store"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&first.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(value["status"], "created");
        assert_eq!(value["requestId"], request);
        assert_eq!(
            value["selection"]["cwd"],
            workspace
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(value["selection"]["provider"], "deepseek");
        assert_eq!(value["selection"]["model"], "deepseek-chat");
        let id = value["sessionId"].as_str().unwrap().to_owned();
        let retry = app
            .clone()
            .oneshot(call(
                "POST",
                "/api/structured/start-requests",
                &token,
                Some(input.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &retry.into_body().collect().await.unwrap().to_bytes()
            )
            .unwrap(),
            value
        );
        let mut changed = input.clone();
        changed["title"] = "different".into();
        assert_eq!(
            app.clone()
                .oneshot(call(
                    "POST",
                    "/api/structured/start-requests",
                    &token,
                    Some(changed)
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            app.clone()
                .oneshot(call(
                    "GET",
                    &format!("/api/structured/start-requests/{request}"),
                    &other,
                    None
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let retrieved = app
            .clone()
            .oneshot(call(
                "GET",
                &format!("/api/structured/start-requests/{request}"),
                &token,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &retrieved.into_body().collect().await.unwrap().to_bytes()
            )
            .unwrap(),
            value
        );
        state
            .structured_session_manager()
            .delete_session("alice", &id)
            .await
            .unwrap();
        let after = app
            .clone()
            .oneshot(call(
                "POST",
                "/api/structured/start-requests",
                &token,
                Some(input),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &after.into_body().collect().await.unwrap().to_bytes()
            )
            .unwrap(),
            value
        );
        assert!(state
            .structured_session_manager()
            .get_session("alice", &id)
            .await
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pending_claim_is_never_replayed_by_a_later_authenticated_request() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().to_owned(),
            jwt_secret: "start-request-test-secret".into(),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let request = Uuid::new_v4().to_string();
        let cwd = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let selection = Selection {
            cwd: cwd.clone(),
            provider: "deepseek".into(),
            model: Some("deepseek-chat".into()),
            reasoning: None,
            service_tier: None,
            title: super::super::normalize_structured_title(None, "deepseek"),
        };
        let encoded = serde_json::to_vec(&selection).unwrap();
        claim(&mut state.lock_db().unwrap(), "alice", &request, &encoded).unwrap();
        let created = state
            .structured_session_manager()
            .create_with_options(
                "alice",
                &cwd,
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
                None,
                None,
            )
            .await
            .unwrap();
        drop(state);
        let state = AppState::new(config).unwrap();
        let token = crate::auth::issue_access_token("start-request-test-secret", "alice", "alice");
        let app = crate::app(state.clone());
        let body = serde_json::json!({"requestId":request,"cwd":cwd,"provider":"deepseek","model":"deepseek-chat"});
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/structured/start-requests")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let sessions = state
            .structured_session_manager()
            .list_sessions("alice")
            .await
            .unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|session| &session.id)
                .collect::<Vec<_>>(),
            vec![&created.id]
        );
    }

    #[test]
    fn claim_is_bound_to_owner_request_and_exact_input_and_keeps_completed_tombstone() {
        let mut db = Connection::open_in_memory().unwrap();
        assert_eq!(
            claim(&mut db, "alice", "request", b"input").unwrap(),
            Claim::New
        );
        assert_eq!(
            claim(&mut db, "alice", "request", b"input").unwrap(),
            Claim::Pending
        );
        assert!(claim(&mut db, "alice", "request", b"changed").is_err());
        assert_eq!(
            claim(&mut db, "bob", "request", b"input").unwrap(),
            Claim::New
        );
        complete(&mut db, "alice", "request", "ss-original").unwrap();
        assert_eq!(
            claim(&mut db, "alice", "request", b"input").unwrap(),
            Claim::Created("ss-original".into())
        );
        assert!(complete(&mut db, "alice", "request", "ss-different").is_err());
    }

    #[test]
    fn receipt_lookup_does_not_create_storage_and_rejects_changed_input() {
        let mut db = Connection::open_in_memory().unwrap();
        assert!(lookup(&db, "alice", "request").unwrap().is_none());
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='structured_start_requests')", [], |row| row.get(0)).unwrap();
        assert!(!exists);
        claim(&mut db, "alice", "request", b"input").unwrap();
        db.execute(
            "UPDATE structured_start_requests SET input_json=?1",
            [b"changed".as_slice()],
        )
        .unwrap();
        assert!(lookup(&db, "alice", "request").is_err());
    }

    #[test]
    fn production_ledger_requires_a_durable_journal_and_synchronous_mode() {
        let directory = tempfile::tempdir().unwrap();
        let db = Connection::open(directory.path().join("ledger.sqlite")).unwrap();
        require_durable_database(&db).unwrap();
        db.pragma_update(None, "synchronous", "OFF").unwrap();
        assert!(require_durable_database(&db).is_err());
        db.pragma_update(None, "synchronous", "FULL").unwrap();
        db.pragma_update(None, "journal_mode", "OFF").unwrap();
        assert!(require_durable_database(&db).is_err());
    }
}
