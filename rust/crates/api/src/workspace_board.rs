#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn workspace_identity_detects_alias_retargeting() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let alias = root.path().join("alias");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        std::os::unix::fs::symlink(&first, &alias).unwrap();
        let input = alias.to_str().unwrap();
        let target = canonical(input).unwrap();
        let identity = WorkspaceIdentity::capture(input, &target).unwrap();
        assert!(identity.validate().is_ok());
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&second, &alias).unwrap();
        assert_eq!(
            identity.validate().unwrap_err().status,
            StatusCode::CONFLICT
        );
    }
    #[test]
    fn workspace_paths_require_existing_absolute_directories_and_resolve_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(
            canonical(path).unwrap(),
            canonical(&format!("{path}/.")).unwrap()
        );
        assert!(canonical("relative").is_err());
        assert!(canonical(&format!("{path}/missing")).is_err());
    }
    #[test]
    fn mutation_uses_the_callers_transaction_and_preserves_busy_timeout() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.busy_timeout(std::time::Duration::from_millis(137))
            .unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let body = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        mutate(&mut db, "owner", "/workspace", "POST", "", body).unwrap();
        let timeout: i64 = db
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 137);
        db.execute_batch("ROLLBACK").unwrap();
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_board_items')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!exists);
    }
    #[test]
    fn retry_revision_and_scope_are_transactional() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let create = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        let first = mutate(&mut db, "owner", "/workspace", "POST", "", create).unwrap();
        assert_eq!(
            first,
            mutate(&mut db, "owner", "/workspace", "POST", "", create).unwrap()
        );
        let id = first["id"].as_str().unwrap();
        let patch = br#"{"path":"/workspace","operationId":"22222222-2222-4222-8222-222222222222","expectedRevision":1,"status":"done"}"#;
        assert_eq!(
            mutate(&mut db, "owner", "/workspace", "PATCH", id, patch).unwrap()["revision"],
            2
        );
        let stale = br#"{"path":"/workspace","operationId":"33333333-3333-4333-8333-333333333333","expectedRevision":1,"title":"stale"}"#;
        assert_eq!(
            mutate(&mut db, "owner", "/workspace", "PATCH", id, stale)
                .unwrap_err()
                .status,
            axum::http::StatusCode::CONFLICT
        );
        assert_eq!(
            mutate(&mut db, "other", "/workspace", "PATCH", id, stale)
                .unwrap_err()
                .status,
            axum::http::StatusCode::NOT_FOUND
        );
    }
    #[test]
    fn operation_id_cannot_be_reused_in_another_workspace() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let body = br#"{"path":"/alias","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        mutate(&mut db, "owner", "/first", "POST", "", body).unwrap();
        assert_eq!(
            mutate(&mut db, "owner", "/second", "POST", "", body)
                .unwrap_err()
                .status,
            axum::http::StatusCode::CONFLICT
        );
        assert!(mutate(&mut db, "other", "/second", "POST", "", body).is_ok());
    }
    #[test]
    fn missing_receipt_table_does_not_allow_replaying_a_committed_mutation() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let body = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        mutate(&mut db, "owner", "/workspace", "POST", "", body).unwrap();
        db.execute_batch("DROP TABLE workspace_board_receipts")
            .unwrap();
        assert!(mutate(&mut db, "owner", "/workspace", "POST", "", body).is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM workspace_board_items", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1
        );
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='workspace_board_receipts'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
    #[test]
    fn missing_item_table_is_not_recreated_while_receipts_remain() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let body = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        mutate(&mut db, "owner", "/workspace", "POST", "", body).unwrap();
        db.execute_batch("DROP TABLE workspace_board_items")
            .unwrap();
        assert!(mutate(&mut db, "owner", "/workspace", "POST", "", body).is_err());
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='workspace_board_items'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
    #[test]
    fn conflicting_legacy_receipts_fail_closed() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE workspace_board_receipts (owner TEXT NOT NULL, workspace TEXT NOT NULL, operation TEXT NOT NULL, method TEXT NOT NULL, target TEXT NOT NULL, payload BLOB NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,workspace,operation)); INSERT INTO workspace_board_receipts VALUES ('owner','/first','11111111-1111-4111-8111-111111111111','POST','',X'00','{}'), ('owner','/second','11111111-1111-4111-8111-111111111111','POST','',X'00','{}');").unwrap();
        let body = br#"{"path":"/first","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        assert!(mutate(&mut db, "owner", "/first", "POST", "", body).is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM workspace_board_receipts", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            2
        );
    }
}

use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json, Router,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(unix)]
struct RequestCancellation(std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg(all(test, unix))]
static MUTATION_TEST_HOOK: std::sync::Mutex<
    Vec<(
        String,
        std::sync::mpsc::Sender<()>,
        std::sync::mpsc::Sender<()>,
    )>,
> = std::sync::Mutex::new(Vec::new());

#[cfg(all(test, unix))]
static BEFORE_COMMIT_TEST_HOOK: std::sync::Mutex<
    Vec<(
        String,
        std::sync::mpsc::Sender<()>,
        std::sync::mpsc::Receiver<()>,
    )>,
> = std::sync::Mutex::new(Vec::new());

#[cfg(unix)]
impl Drop for RequestCancellation {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
struct BoardQuery {
    path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardItem {
    id: String,
    title: String,
    description: String,
    status: String,
    blocked_reason: Option<String>,
    revision: i64,
    created_at: String,
    updated_at: String,
}

fn conflict(message: &str) -> ApiError {
    ApiError {
        status: StatusCode::CONFLICT,
        message: message.into(),
    }
}
fn storage_error(_: rusqlite::Error) -> ApiError {
    ApiError::internal("Board storage unavailable")
}
fn schema(db: &rusqlite::Connection) -> Result<(), ApiError> {
    db.execute_batch("SAVEPOINT workspace_board_schema")
        .map_err(storage_error)?;
    let result = (|| {
        let (items, receipts): (bool, bool) = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_board_items'), EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_board_receipts')",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(storage_error)?;
        if items != receipts {
            return Err(ApiError::internal("Board storage is incomplete"));
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS workspace_board_items (id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, item TEXT NOT NULL); CREATE INDEX IF NOT EXISTS workspace_board_scope ON workspace_board_items(owner,workspace); CREATE TABLE IF NOT EXISTS workspace_board_receipts (owner TEXT NOT NULL, workspace TEXT NOT NULL, operation TEXT NOT NULL, method TEXT NOT NULL, target TEXT NOT NULL, payload BLOB NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,workspace,operation)); CREATE UNIQUE INDEX IF NOT EXISTS workspace_board_receipt_owner_operation ON workspace_board_receipts(owner,operation);").map_err(storage_error)
    })();
    if result.is_err() {
        db.execute_batch("ROLLBACK TO workspace_board_schema; RELEASE workspace_board_schema")
            .map_err(storage_error)?;
        return result;
    }
    db.execute_batch("RELEASE workspace_board_schema")
        .map_err(storage_error)
}
fn canonical(path: &str) -> Result<String, ApiError> {
    if path.len() > 2048 || !std::path::Path::new(path).is_absolute() {
        return Err(ApiError::bad_request(
            "An absolute workspace directory is required",
        ));
    }
    let p = std::fs::canonicalize(path)
        .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
    if !p.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    let s = p
        .to_str()
        .ok_or_else(|| ApiError::bad_request("Workspace path is not UTF-8"))?;
    Ok(if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_owned()
    })
}

#[cfg(unix)]
struct WorkspaceIdentity {
    original: String,
    canonical: String,
    directory: std::fs::File,
}

#[cfg(unix)]
impl WorkspaceIdentity {
    fn capture(original: &str, canonical: &str) -> Result<Self, ApiError> {
        use std::os::unix::fs::OpenOptionsExt;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(canonical)
            .map_err(|_| conflict("Workspace changed; retry"))?;
        let identity = Self {
            original: original.into(),
            canonical: canonical.into(),
            directory,
        };
        identity.validate()?;
        Ok(identity)
    }
    fn validate(&self) -> Result<(), ApiError> {
        use std::os::unix::fs::MetadataExt;
        let changed = || conflict("Workspace changed; retry");
        let original = canonical(&self.original).map_err(|_| changed())?;
        let expected = self.directory.metadata().map_err(|_| changed())?;
        let current = std::fs::symlink_metadata(&self.canonical).map_err(|_| changed())?;
        if original != self.canonical
            || !current.is_dir()
            || current.file_type().is_symlink()
            || (expected.dev(), expected.ino()) != (current.dev(), current.ino())
        {
            return Err(changed());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn check_workspace(
    identity: &WorkspaceIdentity,
    error: &mut Option<ApiError>,
) -> Result<(), String> {
    match identity.validate() {
        Ok(()) => Ok(()),
        Err(e) => {
            *error = Some(e);
            Err("Workspace changed".into())
        }
    }
}
fn string_field<'a>(
    v: &'a Value,
    key: &str,
    max: usize,
    nonempty: bool,
) -> Result<&'a str, ApiError> {
    let s = v
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request(format!("Invalid {key}")))?;
    if s.len() > max || s.contains('\0') || (nonempty && s.trim().is_empty()) {
        return Err(ApiError::bad_request(format!("Invalid {key}")));
    }
    Ok(s)
}
fn parse(body: &[u8], method: &str) -> Result<Value, ApiError> {
    if body.len() > 40_000 {
        return Err(ApiError::bad_request("Board request too large"));
    }
    let v: Value =
        serde_json::from_slice(body).map_err(|_| ApiError::bad_request("Invalid board request"))?;
    let object = v
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Invalid board request"))?;
    let allowed: &[&str] = match method {
        "POST" => &["path", "operationId", "title", "description"],
        "PATCH" => &[
            "path",
            "operationId",
            "expectedRevision",
            "title",
            "description",
            "status",
            "blockedReason",
        ],
        _ => &["path", "operationId", "expectedRevision"],
    };
    if object.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ApiError::bad_request("Unknown board field"));
    }
    string_field(&v, "path", 2048, true)?;
    let operation = string_field(&v, "operationId", 36, true)?;
    if uuid::Uuid::parse_str(operation).is_err() {
        return Err(ApiError::bad_request("Invalid operationId"));
    }
    if method != "POST"
        && v.get("expectedRevision")
            .and_then(Value::as_i64)
            .filter(|n| *n > 0)
            .is_none()
    {
        return Err(ApiError::bad_request("Invalid expectedRevision"));
    }
    if method == "POST" || v.get("title").is_some() {
        string_field(&v, "title", 512, true)?;
    }
    if v.get("description").is_some() {
        string_field(&v, "description", 16_384, false)?;
    }
    if let Some(status) = v.get("status") {
        if !matches!(
            status.as_str(),
            Some("open" | "in_progress" | "blocked" | "review" | "done")
        ) {
            return Err(ApiError::bad_request("Invalid status"));
        }
    }
    if let Some(reason) = v.get("blockedReason") {
        if !reason.is_null() {
            string_field(&v, "blockedReason", 4096, false)?;
        }
    }
    if method == "PATCH"
        && !["title", "description", "status", "blockedReason"]
            .iter()
            .any(|k| v.get(k).is_some())
    {
        return Err(ApiError::bad_request("No changes supplied"));
    }
    Ok(v)
}

// Callers must establish owner authority and pass the canonical workspace before invoking this boundary.
pub(crate) fn mutate(
    db: &mut rusqlite::Connection,
    owner: &str,
    workspace: &str,
    method: &str,
    id: &str,
    body: &[u8],
) -> Result<Value, ApiError> {
    if db.is_autocommit() {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let result = mutate_in_transaction(&tx, owner, workspace, method, id, body)?;
        tx.commit().map_err(storage_error)?;
        return Ok(result);
    }
    let tx = db.savepoint().map_err(storage_error)?;
    let result = mutate_in_transaction(&tx, owner, workspace, method, id, body)?;
    tx.commit().map_err(storage_error)?;
    Ok(result)
}

fn mutate_in_transaction(
    tx: &rusqlite::Connection,
    owner: &str,
    workspace: &str,
    method: &str,
    id: &str,
    body: &[u8],
) -> Result<Value, ApiError> {
    if !matches!(method, "POST" | "PATCH" | "DELETE") || owner.is_empty() || workspace.is_empty() {
        return Err(ApiError::bad_request("Invalid board operation"));
    }
    let v = parse(body, method)?;
    let operation = uuid::Uuid::parse_str(v["operationId"].as_str().unwrap())
        .unwrap()
        .to_string();
    schema(tx)?;
    let receipt: Option<(String,String,String,Vec<u8>,String)> = tx.query_row("SELECT workspace,method,target,payload,result FROM workspace_board_receipts WHERE owner=?1 AND operation=?2", params![owner,&operation], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(storage_error)?;
    if let Some((old_workspace, old_method, old_id, old_body, result)) = receipt {
        if old_workspace != workspace || old_method != method || old_id != id || old_body != body {
            return Err(conflict(
                "operationId already used with a different request",
            ));
        }
        return serde_json::from_str(&result)
            .map_err(|_| ApiError::internal("Board receipt is invalid"));
    }
    let count: i64 = tx
        .query_row(
            "SELECT count(*) FROM workspace_board_receipts WHERE owner=?1 AND workspace=?2",
            params![owner, workspace],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if count >= 100_000 {
        return Err(conflict("Board receipt limit reached"));
    }
    let now = crate::iso_timestamp();
    let result = if method == "POST" {
        let count: i64 = tx
            .query_row(
                "SELECT count(*) FROM workspace_board_items WHERE owner=?1 AND workspace=?2",
                params![owner, workspace],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if count >= 1000 {
            return Err(conflict("Board item limit reached"));
        }
        let item = BoardItem {
            id: uuid::Uuid::new_v4().to_string(),
            title: v["title"].as_str().unwrap().into(),
            description: v
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            status: "open".into(),
            blocked_reason: None,
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        let data = serde_json::to_string(&item)
            .map_err(|_| ApiError::internal("Board serialization failed"))?;
        tx.execute(
            "INSERT INTO workspace_board_items(id,owner,workspace,item) VALUES (?1,?2,?3,?4)",
            params![item.id, owner, workspace, data],
        )
        .map_err(storage_error)?;
        json!(item)
    } else {
        let data: Option<String> = tx
            .query_row(
                "SELECT item FROM workspace_board_items WHERE id=?1 AND owner=?2 AND workspace=?3",
                params![id, owner, workspace],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let mut item: BoardItem =
            serde_json::from_str(&data.ok_or_else(|| ApiError::not_found("Board item not found"))?)
                .map_err(|_| ApiError::internal("Board item is invalid"))?;
        if item.revision != v["expectedRevision"].as_i64().unwrap() {
            return Err(conflict("Board revision is stale"));
        }
        if method == "DELETE" {
            tx.execute(
                "DELETE FROM workspace_board_items WHERE id=?1 AND owner=?2 AND workspace=?3",
                params![id, owner, workspace],
            )
            .map_err(storage_error)?;
            json!({"id": id, "deleted": true})
        } else {
            if let Some(s) = v.get("title") {
                item.title = s.as_str().unwrap().into();
            }
            if let Some(s) = v.get("description") {
                item.description = s.as_str().unwrap().into();
            }
            if let Some(s) = v.get("status") {
                item.status = s.as_str().unwrap().into();
            }
            if let Some(s) = v.get("blockedReason") {
                item.blocked_reason = s.as_str().map(str::to_owned);
            }
            item.revision = item
                .revision
                .checked_add(1)
                .ok_or_else(|| conflict("Board revision exhausted"))?;
            item.updated_at = now;
            let data = serde_json::to_string(&item)
                .map_err(|_| ApiError::internal("Board serialization failed"))?;
            tx.execute("UPDATE workspace_board_items SET item=?1 WHERE id=?2 AND owner=?3 AND workspace=?4", params![data,id,owner,workspace]).map_err(storage_error)?;
            json!(item)
        }
    };
    tx.execute("INSERT INTO workspace_board_receipts(owner,workspace,operation,method,target,payload,result) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![owner,workspace,&operation,method,id,body,result.to_string()]).map_err(storage_error)?;
    Ok(result)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/board",
            axum::routing::get(list).post(create),
        )
        .route(
            "/api/workspace/board/{id}",
            axum::routing::patch(update).delete(remove),
        )
        .layer(axum::middleware::map_response(no_store))
}
async fn no_store(mut response: axum::response::Response) -> axum::response::Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}
fn reject_paired(
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
) -> Result<(), ApiError> {
    if paired.is_some() {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Paired board access is unsupported".into(),
        });
    }
    Ok(())
}
async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    Query(query): Query<BoardQuery>,
) -> Result<Json<Value>, ApiError> {
    reject_paired(paired)?;
    let authority = local
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Local authentication required".into(),
        })?
        .0;
    let workspace = canonical(&query.path)?;
    #[cfg(unix)]
    let identity = WorkspaceIdentity::capture(&query.path, &workspace)?;
    crate::workspace_git::authorize_workspace_path(&state, &user, &workspace).await?;
    #[cfg(unix)]
    {
        let cancellation = RequestCancellation(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        ));
        let cancelled = cancellation.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut operation_error = None;
            let result = state.with_owner_review(&user.user_id, &authority, |tx, check| {
                check_workspace(&identity, &mut operation_error)?;
                if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Board request cancelled".into());
                }
                let items = match list_in_transaction(tx, &user.user_id, &workspace) {
                    Ok(items) => items,
                    Err(error) => {
                        operation_error = Some(error);
                        return Err("Board read failed".into());
                    }
                };
                check()?;
                check_workspace(&identity, &mut operation_error)?;
                if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Board request cancelled".into());
                }
                Ok(items)
            });
            match result {
                Ok(items) => Ok(Json(json!({"items": items}))),
                Err(error) => Err(operation_error.unwrap_or_else(|| ApiError {
                    status: if error.contains("revoked") || error.contains("expired") {
                        StatusCode::UNAUTHORIZED
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    message: "Board authorization unavailable or expired".into(),
                })),
            }
        })
        .await
        .map_err(|_| ApiError::internal("Board read task unavailable"))?
    }
    #[cfg(not(unix))]
    {
        let _ = authority;
        Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Board authorization unavailable".into(),
        })
    }
}
#[cfg(unix)]
fn list_in_transaction(
    db: &rusqlite::Connection,
    owner: &str,
    workspace: &str,
) -> Result<Vec<BoardItem>, ApiError> {
    schema(db)?;
    let mut stmt = db
        .prepare(
            "SELECT item FROM workspace_board_items WHERE owner=?1 AND workspace=?2 ORDER BY id",
        )
        .map_err(storage_error)?;
    let items = stmt
        .query_map(params![owner, workspace], |r| r.get::<_, String>(0))
        .map_err(storage_error)?
        .map(|r| {
            let s = r.map_err(storage_error)?;
            serde_json::from_str::<BoardItem>(&s)
                .map_err(|_| ApiError::internal("Board item is invalid"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}
async fn dispatch(
    state: AppState,
    user: AuthenticatedUser,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    method: &str,
    id: &str,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    reject_paired(paired)?;
    let authority = local
        .ok_or_else(|| ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Local authentication required".into(),
        })?
        .0;
    if method != "POST" && uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::not_found("Board item not found"));
    }
    let v = parse(&body, method)?;
    let workspace = canonical(v["path"].as_str().unwrap())?;
    #[cfg(unix)]
    let identity = WorkspaceIdentity::capture(v["path"].as_str().unwrap(), &workspace)?;
    crate::workspace_git::authorize_workspace_path(&state, &user, &workspace).await?;
    #[cfg(unix)]
    {
        let method = method.to_owned();
        let id = id.to_owned();
        let cancellation = RequestCancellation(std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        ));
        let cancelled = cancellation.0.clone();
        tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            let hook = {
                let mut slot = MUTATION_TEST_HOOK.lock().unwrap();
                slot.iter()
                    .position(|hook| hook.0 == workspace)
                    .map(|index| slot.remove(index))
            };
            #[cfg(test)]
            if let Some((_, entered, _)) = &hook {
                let _ = entered.send(());
            }
            let mut operation_error = None;
            let result = state.with_owner_review(&user.user_id, &authority, |tx, check| {
                check_workspace(&identity, &mut operation_error)?;
                if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Board request cancelled".into());
                }
                let result =
                    match mutate_in_transaction(tx, &user.user_id, &workspace, &method, &id, &body)
                    {
                        Ok(result) => result,
                        Err(error) => {
                            operation_error = Some(error);
                            return Err("Board operation failed".into());
                        }
                    };
                #[cfg(test)]
                {
                    let pause = {
                        let mut slot = BEFORE_COMMIT_TEST_HOOK.lock().unwrap();
                        slot.iter()
                            .position(|hook| hook.0 == workspace)
                            .map(|index| slot.remove(index))
                    };
                    if let Some((_, entered, release)) = pause {
                        let _ = entered.send(());
                        release.recv().map_err(|_| "Test pause abandoned")?;
                    }
                }
                check()?;
                check_workspace(&identity, &mut operation_error)?;
                if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Board request cancelled".into());
                }
                Ok(result)
            });
            #[cfg(test)]
            if let Some((_, _, finished)) = hook {
                let _ = finished.send(());
            }
            match result {
                Ok(result) => Ok(Json(result)),
                Err(error) => Err(operation_error.unwrap_or_else(|| ApiError {
                    status: if error.contains("revoked") || error.contains("expired") {
                        StatusCode::UNAUTHORIZED
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    message: "Board authorization unavailable or expired".into(),
                })),
            }
        })
        .await
        .map_err(|_| ApiError::internal("Board mutation task unavailable"))?
    }
    #[cfg(not(unix))]
    {
        let _ = authority;
        Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Board authorization unavailable".into(),
        })
    }
}
async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    dispatch(state, user, paired, local, "POST", "", body).await
}
async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    dispatch(state, user, paired, local, "PATCH", &id, body).await
}
async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    dispatch(state, user, paired, local, "DELETE", &id, body).await
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replacing_workspace_before_commit_rejects_mutation() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "board-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let own = data
            .path()
            .join("workspace-git")
            .join(&hex::encode(Sha256::digest(b"owner"))[..32]);
        std::fs::create_dir_all(&own).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let app = routes()
            .layer(Extension(user))
            .layer(Extension(authority))
            .with_state(state.clone());
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        BEFORE_COMMIT_TEST_HOOK.lock().unwrap().push((
            canonical(own.to_str().unwrap()).unwrap(),
            entered,
            release_rx,
        ));
        let body = json!({"path": own.to_str().unwrap(), "operationId": uuid::Uuid::new_v4(), "title": "Task"}).to_string();
        let request = Request::builder()
            .method("POST")
            .uri("/api/workspace/board")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap().status() });
        tokio::task::spawn_blocking(move || {
            entered_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .unwrap()
        .unwrap();
        std::fs::rename(&own, own.with_extension("old")).unwrap();
        std::fs::create_dir(&own).unwrap();
        release.send(()).unwrap();
        assert_eq!(pending.await.unwrap(), StatusCode::CONFLICT);
        let db = state.lock_db().unwrap();
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_board_items')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!exists);
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_mutation_after_write_rolls_back_before_commit() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "board-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let own = data
            .path()
            .join("workspace-git")
            .join(&hex::encode(Sha256::digest(b"owner"))[..32]);
        std::fs::create_dir_all(&own).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let app = routes()
            .layer(Extension(user))
            .layer(Extension(authority))
            .with_state(state.clone());
        let canonical_workspace = canonical(own.to_str().unwrap()).unwrap();
        let (started, _started_rx) = std::sync::mpsc::channel();
        let (finished, finished_rx) = std::sync::mpsc::channel();
        MUTATION_TEST_HOOK
            .lock()
            .unwrap()
            .push((canonical_workspace.clone(), started, finished));
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        BEFORE_COMMIT_TEST_HOOK
            .lock()
            .unwrap()
            .push((canonical_workspace, entered, release_rx));
        let body = json!({"path": own.to_str().unwrap(), "operationId": uuid::Uuid::new_v4(), "title": "Task"}).to_string();
        let request = Request::builder()
            .method("POST")
            .uri("/api/workspace/board")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await });
        tokio::task::spawn_blocking(move || {
            entered_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .unwrap()
        .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        tokio::task::spawn_blocking(move || {
            finished_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .unwrap()
        .unwrap();
        let db = state.lock_db().unwrap();
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_board_items')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!exists);
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_mutation_waiting_for_admission_does_not_write() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "board-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let own = data
            .path()
            .join("workspace-git")
            .join(&hex::encode(Sha256::digest(b"owner"))[..32]);
        std::fs::create_dir_all(&own).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let app = routes()
            .layer(Extension(user))
            .layer(Extension(authority))
            .with_state(state.clone());
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.path().join("auth-admission.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        let (started, started_rx) = std::sync::mpsc::channel();
        let (finished, finished_rx) = std::sync::mpsc::channel();
        MUTATION_TEST_HOOK.lock().unwrap().push((
            canonical(own.to_str().unwrap()).unwrap(),
            started,
            finished,
        ));
        let body = json!({"path": own.to_str().unwrap(), "operationId": uuid::Uuid::new_v4(), "title": "Task"}).to_string();
        let request = Request::builder()
            .method("POST")
            .uri("/api/workspace/board")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await });
        tokio::task::spawn_blocking(move || {
            started_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .unwrap()
        .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        lock.unlock().unwrap();
        tokio::task::spawn_blocking(move || {
            finished_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .unwrap()
        .unwrap();
        let db = state.lock_db().unwrap();
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_board_items')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!exists);
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn board_requests_submitted_during_logout_reject_revoked_authority() {
        for method in ["GET", "POST"] {
            let data = tempfile::tempdir().unwrap();
            let config = terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                jwt_secret: "board-test".into(),
                ..Default::default()
            };
            let state = AppState::new_with_external_auth(config, None).unwrap();
            let user = AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            };
            let own = data
                .path()
                .join("workspace-git")
                .join(&hex::encode(Sha256::digest(b"owner"))[..32]);
            std::fs::create_dir_all(&own).unwrap();
            let authority = crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            );
            let app = routes()
                .layer(Extension(user))
                .layer(Extension(authority))
                .with_state(state.clone());
            let body = json!({"path": own.to_str().unwrap(), "operationId": uuid::Uuid::new_v4(), "title": "Task"}).to_string();
            let (entered, release) = state.pause_logout_marker_for_test();
            let logout = tokio::task::spawn_blocking({
                let state = state.clone();
                move || state.logout_user("owner")
            });
            tokio::task::spawn_blocking(move || {
                entered.recv_timeout(std::time::Duration::from_secs(5))
            })
            .await
            .unwrap()
            .unwrap();
            let request = if method == "GET" {
                Request::builder()
                    .uri(format!("/api/workspace/board?path={}", own.display()))
                    .body(Body::empty())
                    .unwrap()
            } else {
                Request::builder()
                    .method("POST")
                    .uri("/api/workspace/board")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap()
            };
            let mut pending =
                tokio::spawn(async move { app.oneshot(request).await.unwrap().status() });
            let release_thread = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                release.send(()).unwrap();
            });
            let start = std::time::Instant::now();
            let responsive =
                tokio::time::timeout(std::time::Duration::from_millis(150), &mut pending)
                    .await
                    .is_err()
                    && start.elapsed() < std::time::Duration::from_millis(700);
            logout.await.unwrap().unwrap();
            release_thread.join().unwrap();
            assert!(responsive, "{method} blocked the async executor");
            assert_eq!(pending.await.unwrap(), StatusCode::UNAUTHORIZED);
            let db = state.lock_db().unwrap();
            let exists: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_board_items')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(!exists);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn board_routes_require_live_local_authority() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "board-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let own = data
            .path()
            .join("workspace-git")
            .join(&hex::encode(Sha256::digest(b"owner"))[..32]);
        std::fs::create_dir_all(&own).unwrap();
        let app = routes().layer(Extension(user)).with_state(state.clone());
        let body = json!({"path": own.to_str().unwrap(), "operationId": uuid::Uuid::new_v4(), "title": "Task"}).to_string();
        let now = crate::v4_agent::interaction::now_ms();
        state
            .lock_db()
            .unwrap()
            .execute(
                "INSERT INTO auth_generations(user_id, generation) VALUES ('owner', 1)",
                [],
            )
            .unwrap();
        let cases = [
            app.clone(),
            app.clone()
                .layer(Extension(crate::auth::LocalAuthority::for_test(
                    "owner", 0, now,
                ))),
            app.layer(Extension(crate::auth::LocalAuthority::for_test(
                "other",
                0,
                now + 60_000,
            ))),
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "owner".into(),
                }))
                .layer(Extension(crate::auth::LocalAuthority::for_test(
                    "owner",
                    0,
                    now + 60_000,
                )))
                .with_state(state.clone()),
        ];
        for app in cases {
            let request = Request::builder()
                .uri(format!("/api/workspace/board?path={}", own.display()))
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
            let request = Request::builder()
                .method("POST")
                .uri("/api/workspace/board")
                .header("content-type", "application/json")
                .body(Body::from(body.clone()))
                .unwrap();
            assert_eq!(
                app.oneshot(request).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let db = state.lock_db().unwrap();
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workspace_board_items')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!exists);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn board_routes_reject_another_owners_managed_workspace() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "board-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let digest = |name: &str| hex::encode(Sha256::digest(name.as_bytes()))[..32].to_owned();
        let own = data.path().join("workspace-git").join(digest("owner"));
        let foreign = data.path().join("workspace-git").join(digest("other"));
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();
        #[cfg(unix)]
        let alias = {
            let alias = own.join("foreign-link");
            std::os::unix::fs::symlink(&foreign, &alias).unwrap();
            alias
        };
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let app = routes()
            .layer(Extension(user))
            .layer(Extension(authority))
            .with_state(state);
        #[allow(unused_mut)]
        let mut cases = vec![(&own, StatusCode::OK), (&foreign, StatusCode::FORBIDDEN)];
        #[cfg(unix)]
        cases.push((&alias, StatusCode::FORBIDDEN));
        for (path, expected) in cases {
            let body = json!({"path": path.to_str().unwrap(), "operationId": uuid::Uuid::new_v4(), "title": "Task"}).to_string();
            let request = Request::builder()
                .method("POST")
                .uri("/api/workspace/board")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
            let request = Request::builder()
                .uri(format!("/api/workspace/board?path={}", path.display()))
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
    }
    #[test]
    fn concurrent_writers_and_restart_preserve_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("board.sqlite");
        let mut db = rusqlite::Connection::open(&file).unwrap();
        let create = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        let first = mutate(&mut db, "owner", "/workspace", "POST", "", create).unwrap();
        drop(db);
        let id = first["id"].as_str().unwrap().to_owned();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2).map(|n| {
            let file = file.clone(); let id = id.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut db = rusqlite::Connection::open(file).unwrap();
                let body = json!({"path":"/workspace", "operationId": format!("00000000-0000-4000-8000-{n:012}"), "expectedRevision":1,"title":format!("edit {n}")}).to_string();
                barrier.wait();
                mutate(&mut db,"owner","/workspace","PATCH",&id,body.as_bytes()).map(|_| StatusCode::OK).unwrap_or_else(|e| e.status)
            })
        }).collect();
        let mut results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        results.sort();
        assert_eq!(results, vec![StatusCode::OK, StatusCode::CONFLICT]);
        let mut db = rusqlite::Connection::open(file).unwrap();
        assert_eq!(
            mutate(&mut db, "owner", "/workspace", "POST", "", create).unwrap(),
            first
        );
        let changed = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Other"}"#;
        assert_eq!(
            mutate(&mut db, "owner", "/workspace", "POST", "", changed)
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
    }
    #[test]
    fn delete_retry_survives_deletion_and_rejects_changed_payload() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let create = br#"{"path":"/workspace","operationId":"11111111-1111-4111-8111-111111111111","title":"Task"}"#;
        let item = mutate(&mut db, "owner", "/workspace", "POST", "", create).unwrap();
        let id = item["id"].as_str().unwrap();
        let delete = br#"{"path":"/workspace","operationId":"22222222-2222-4222-8222-222222222222","expectedRevision":1}"#;
        let result = mutate(&mut db, "owner", "/workspace", "DELETE", id, delete).unwrap();
        assert_eq!(result, json!({"id":id,"deleted":true}));
        assert_eq!(
            mutate(&mut db, "owner", "/workspace", "DELETE", id, delete).unwrap(),
            result
        );
        let changed = br#"{"path":"/workspace","operationId":"22222222-2222-4222-8222-222222222222","expectedRevision":2}"#;
        assert_eq!(
            mutate(&mut db, "owner", "/workspace", "DELETE", id, changed)
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
    }
    #[tokio::test]
    async fn board_endpoints_are_unregistered_until_admission_is_safe() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "board-test".into(),
            ..Default::default()
        };
        let app = crate::app(AppState::new_with_external_auth(config, None).unwrap());
        let token = crate::auth::issue_access_token("board-test", "owner", "owner");
        for (method, uri) in [
            ("GET", "/api/workspace/board?path=/tmp"),
            ("POST", "/api/workspace/board"),
            (
                "PATCH",
                "/api/workspace/board/11111111-1111-4111-8111-111111111111",
            ),
            (
                "DELETE",
                "/api/workspace/board/11111111-1111-4111-8111-111111111111",
            ),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            let status = app.clone().oneshot(request).await.unwrap().status();
            assert!(
                matches!(
                    status,
                    StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
                ),
                "{method} {uri}: {status}"
            );
        }
    }
    #[test]
    fn paired_permissions_do_not_grant_board_access() {
        for capability in [
            crate::remote_permissions::Capabilities::observer(),
            crate::remote_permissions::Capabilities::operator(),
        ] {
            for (method, path) in [
                ("GET", "/api/workspace/board"),
                ("POST", "/api/workspace/board"),
                ("PATCH", "/api/workspace/board/id"),
                ("DELETE", "/api/workspace/board/id"),
            ] {
                assert!(!capability.allows_http(method, path));
            }
        }
        let paired = crate::auth::PairedInputAuthority {
            token: "token".into(),
            path: "/api/workspace/board".into(),
            method: "GET".into(),
        };
        assert_eq!(
            reject_paired(Some(Extension(paired))).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
    }
}
