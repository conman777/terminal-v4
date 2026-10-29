use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Path, Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path as FsPath, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const CHUNK: usize = 262_144;
const MAX_FILE: u64 = 268_435_456;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Upload,
    Download,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transfer {
    id: Uuid,
    direction: Direction,
    workspace_path: String,
    relative_path: String,
    size: u64,
    offset: u64,
    status: String,
    sha256: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Record {
    owner: String,
    transfer: Transfer,
    stage: PathBuf,
    target: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Create {
    direction: Direction,
    workspace_path: String,
    relative_path: String,
    size: Option<u64>,
    sha256: Option<String>,
}
#[derive(Deserialize)]
struct ChunkInput {
    offset: u64,
    data: String,
    sha256: String,
}
#[derive(Deserialize)]
struct ChunkQuery {
    offset: u64,
    length: Option<usize>,
}
#[derive(Deserialize)]
struct ListQuery {
    path: Option<String>,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn io(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(format!("Transfer I/O failed: {error}"))
}
fn conflict(message: &str) -> ApiError {
    ApiError {
        status: axum::http::StatusCode::CONFLICT,
        message: message.into(),
    }
}
fn directory(data: &FsPath, owner: &str) -> PathBuf {
    data.join("file-transfers").join(digest(owner.as_bytes()))
}
fn record_path(data: &FsPath, owner: &str, id: Uuid) -> PathBuf {
    directory(data, owner).join(format!("{id}.json"))
}
fn load_record(data: &FsPath, owner: &str, id: Uuid) -> Result<Record, ApiError> {
    let bytes = fs::read(record_path(data, owner, id))
        .map_err(|_| ApiError::not_found("Transfer not found"))?;
    let record: Record = serde_json::from_slice(&bytes).map_err(io)?;
    if record.owner != owner || record.transfer.id != id {
        return Err(ApiError::not_found("Transfer not found"));
    }
    Ok(record)
}
fn load(data: &FsPath, owner: &str, id: Uuid) -> Result<Record, ApiError> {
    let mut record = load_record(data, owner, id)?;
    if record.transfer.direction == Direction::Upload && record.transfer.status == "publishing" {
        let (_, target) = resolve(
            &record.transfer.workspace_path,
            &record.transfer.relative_path,
        )?;
        if target != record.target {
            return Err(conflict("Destination moved during transfer"));
        }
        if target.exists() {
            if fs::metadata(&target).map_err(io)?.len() != record.transfer.size
                || Some(hash_file(&target)?) != record.transfer.sha256
            {
                return Err(conflict("Destination changed during interrupted publish"));
            }
            record.transfer.status = "completed".into();
            save(data, &record)?;
            let _ = fs::remove_file(&record.stage);
        } else {
            record.transfer.status = "pending".into();
            save(data, &record)?;
        }
    }
    if record.transfer.direction == Direction::Upload && record.transfer.status == "pending" {
        validate_stage(&record)?;
        let length = fs::metadata(&record.stage).map_err(io)?.len();
        if length > record.transfer.size {
            return Err(conflict("Staged transfer exceeds expected size"));
        }
        record.transfer.offset = length;
    }
    Ok(record)
}
fn save(data: &FsPath, record: &Record) -> Result<(), ApiError> {
    let dir = directory(data, &record.owner);
    fs::create_dir_all(&dir).map_err(io)?;
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(io)?;
    serde_json::to_writer(&mut temp, record).map_err(io)?;
    temp.as_file().sync_all().map_err(io)?;
    temp.persist(record_path(data, &record.owner, record.transfer.id))
        .map_err(io)?;
    Ok(())
}
fn resolve(workspace: &str, relative: &str) -> Result<(PathBuf, PathBuf), ApiError> {
    let root =
        fs::canonicalize(workspace).map_err(|_| ApiError::bad_request("Workspace unavailable"))?;
    if !root.is_dir()
        || relative.is_empty()
        || relative.len() > 4096
        || relative.contains('\0')
        || relative.contains('\\')
        || relative.contains(':')
        || relative
            .split('/')
            .any(|name| name.ends_with('.') || name.ends_with(' '))
    {
        return Err(ApiError::bad_request("Invalid relative file path"));
    }
    let relative = FsPath::new(relative);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(ApiError::bad_request(
            "File path must stay inside the workspace",
        ));
    }
    let target = root.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| ApiError::bad_request("Invalid destination"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| ApiError::bad_request("Destination directory unavailable"))?;
    if !canonical_parent.starts_with(&root) {
        return Err(ApiError::bad_request("File path escapes workspace"));
    }
    let mut current = root.clone();
    for part in relative.components() {
        current.push(part);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(ApiError::bad_request("Symlink transfers are not supported"));
        }
    }
    Ok((root, canonical_parent.join(target.file_name().unwrap())))
}
fn validate_stage(record: &Record) -> Result<(), ApiError> {
    if record.transfer.direction == Direction::Upload {
        let (_, target) = resolve(
            &record.transfer.workspace_path,
            &record.transfer.relative_path,
        )?;
        if target != record.target {
            return Err(conflict("Destination moved during transfer"));
        }
    }
    let meta = fs::symlink_metadata(&record.stage).map_err(io)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(conflict("Transfer staging file changed"));
    }
    Ok(())
}
fn hash_file(path: &FsPath) -> Result<String, ApiError> {
    let mut file = fs::File::open(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let count = file.read(&mut buffer).map_err(io)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn records(data: &FsPath, owner: &str) -> Result<Vec<Record>, ApiError> {
    let dir = directory(data, owner);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in fs::read_dir(dir).map_err(io)? {
        let path = entry.map_err(io)?.path();
        if path.extension().is_some_and(|e| e == "json") {
            let record: Record =
                serde_json::from_slice(&fs::read(path).map_err(io)?).map_err(io)?;
            if record.owner == owner {
                result.push(record);
                if result.len() > 100 {
                    return Err(conflict("Transfer record limit reached"));
                }
            }
        }
    }
    Ok(result)
}
fn create(data: &FsPath, owner: &str, input: Create) -> Result<Transfer, ApiError> {
    let (root, target) = resolve(&input.workspace_path, &input.relative_path)?;
    let _activity = crate::workspace_activity::enter(&root).map_err(conflict_owned)?;
    if input
        .sha256
        .as_ref()
        .is_some_and(|hash| hash.len() != 64 || hex::decode(hash).is_err())
    {
        return Err(ApiError::bad_request("Invalid SHA-256"));
    }
    let size = match input.direction {
        Direction::Upload => {
            if target.exists() {
                return Err(conflict("Destination exists; choose another filename"));
            }
            input
                .size
                .ok_or_else(|| ApiError::bad_request("Upload size is required"))?
        }
        Direction::Download => {
            let meta = fs::metadata(&target).map_err(io)?;
            if !meta.is_file() {
                return Err(ApiError::bad_request("Select a regular file"));
            }
            meta.len()
        }
    };
    if size > MAX_FILE {
        return Err(ApiError::bad_request("Maximum transfer size is 256 MiB"));
    }
    let existing = records(data, owner)?;
    if existing.len() >= 100
        || existing
            .iter()
            .filter(|r| {
                r.transfer.status == "pending"
                    || (r.transfer.direction == Direction::Download
                        && r.transfer.status == "completed")
            })
            .map(|r| r.transfer.size)
            .sum::<u64>()
            + size
            > MAX_FILE * 2
    {
        return Err(conflict(
            "Transfer quota reached; cancel or remove previous transfers",
        ));
    }
    let dir = directory(data, owner);
    fs::create_dir_all(&dir).map_err(io)?;
    let stage = tempfile::NamedTempFile::new_in(&dir).map_err(io)?;
    let stage = stage.into_temp_path().keep().map_err(io)?;
    let id = Uuid::new_v4();
    let mut transfer = Transfer {
        id,
        direction: input.direction,
        workspace_path: root.to_string_lossy().into(),
        relative_path: input.relative_path,
        size,
        offset: 0,
        status: "pending".into(),
        sha256: input.sha256,
    };
    let prepare = (|| {
        if transfer.direction == Direction::Download {
            fs::copy(&target, &stage).map_err(io)?;
            if fs::metadata(&stage).map_err(io)?.len() != size {
                return Err(conflict("Source changed while preparing download"));
            }
            transfer.sha256 = Some(hash_file(&stage)?);
        }
        let record = Record {
            owner: owner.into(),
            transfer: transfer.clone(),
            stage: stage.clone(),
            target,
        };
        save(data, &record)
    })();
    if let Err(error) = prepare {
        let _ = fs::remove_file(stage);
        return Err(error);
    }
    Ok(transfer)
}
fn conflict_owned(message: String) -> ApiError {
    conflict(&message)
}
fn append(data: &FsPath, owner: &str, id: Uuid, input: ChunkInput) -> Result<Transfer, ApiError> {
    let mut record = load(data, owner, id)?;
    if record.transfer.direction != Direction::Upload || record.transfer.status != "pending" {
        return Err(conflict("Upload is not pending"));
    }
    if input.data.len() > CHUNK * 2 || input.data.is_empty() {
        return Err(ApiError::bad_request("Invalid chunk size"));
    }
    let bytes =
        hex::decode(&input.data).map_err(|_| ApiError::bad_request("Invalid chunk bytes"))?;
    if digest(&bytes) != input.sha256 {
        return Err(ApiError::bad_request("Chunk checksum mismatch"));
    }
    let end = input
        .offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| ApiError::bad_request("Invalid chunk offset"))?;
    if end > record.transfer.size || input.offset > record.transfer.offset {
        return Err(conflict("Chunk offset does not match server progress"));
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&record.stage)
        .map_err(io)?;
    file.seek(SeekFrom::Start(input.offset)).map_err(io)?;
    if input.offset < record.transfer.offset {
        if end > record.transfer.offset {
            return Err(conflict("Chunk overlaps server progress"));
        }
        let mut previous = vec![0; bytes.len()];
        file.read_exact(&mut previous).map_err(io)?;
        if previous != bytes {
            return Err(conflict("Duplicate chunk differs from stored bytes"));
        }
        return Ok(record.transfer);
    }
    file.write_all(&bytes).map_err(io)?;
    file.sync_all().map_err(io)?;
    record.transfer.offset = end;
    save(data, &record)?;
    Ok(record.transfer)
}
fn finish(data: &FsPath, owner: &str, id: Uuid) -> Result<Transfer, ApiError> {
    let mut record = load(data, owner, id)?;
    if record.transfer.status == "completed" {
        return Ok(record.transfer);
    }
    if record.transfer.status != "pending" {
        return Err(conflict("Transfer is not pending"));
    }
    validate_stage(&record)?;
    if record.transfer.direction == Direction::Download {
        return Err(ApiError::bad_request(
            "Downloads are completed by the browser after checksum verification",
        ));
    }
    if record.transfer.offset != record.transfer.size {
        return Err(conflict("Upload is incomplete"));
    }
    let actual = hash_file(&record.stage)?;
    if record
        .transfer
        .sha256
        .as_ref()
        .is_some_and(|expected| expected != &actual)
    {
        return Err(conflict("File checksum mismatch"));
    }
    let _activity = crate::workspace_activity::enter(FsPath::new(&record.transfer.workspace_path))
        .map_err(conflict_owned)?;
    let (_, target) = resolve(
        &record.transfer.workspace_path,
        &record.transfer.relative_path,
    )?;
    if target != record.target {
        return Err(conflict("Destination moved during transfer"));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(target.parent().unwrap()).map_err(io)?;
    let mut source = fs::File::open(&record.stage).map_err(io)?;
    std::io::copy(&mut source, &mut temporary).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    if target.exists() {
        return Err(conflict("Destination exists; choose another filename"));
    }
    record.transfer.status = "publishing".into();
    record.transfer.sha256 = Some(actual);
    save(data, &record)?;
    if temporary.persist_noclobber(&target).is_err() {
        record.transfer.status = "pending".into();
        save(data, &record)?;
        return Err(conflict("Destination exists or cannot be published"));
    }
    record.transfer.status = "completed".into();
    save(data, &record)?;
    let _ = fs::remove_file(&record.stage);
    Ok(record.transfer)
}
fn cancel(data: &FsPath, owner: &str, id: Uuid) -> Result<Transfer, ApiError> {
    let mut record = load_record(data, owner, id)?;
    // Cleanup owns only the stored staging file; publication prerequisites may be gone.
    if record.stage.parent() != Some(directory(data, owner).as_path()) {
        return Err(conflict("Transfer staging path changed"));
    }
    match fs::remove_file(&record.stage) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io(error)),
    }
    if record.transfer.status == "completed" || record.transfer.status == "cancelled" {
        fs::remove_file(record_path(data, owner, id)).map_err(io)?;
    } else {
        record.transfer.status = "cancelled".into();
        save(data, &record)?;
    }
    Ok(record.transfer)
}
fn read_chunk(
    data: &FsPath,
    owner: &str,
    id: Uuid,
    query: ChunkQuery,
) -> Result<serde_json::Value, ApiError> {
    let mut record = load(data, owner, id)?;
    if record.transfer.direction != Direction::Download
        || !matches!(record.transfer.status.as_str(), "pending" | "completed")
    {
        return Err(conflict("Download is not pending"));
    }
    let length = query.length.unwrap_or(CHUNK);
    if length == 0 || length > CHUNK || query.offset > record.transfer.size {
        return Err(ApiError::bad_request("Invalid download range"));
    }
    validate_stage(&record)?;
    let count = (record.transfer.size - query.offset).min(length as u64) as usize;
    let mut bytes = vec![0; count];
    let mut file = fs::File::open(&record.stage).map_err(io)?;
    file.seek(SeekFrom::Start(query.offset)).map_err(io)?;
    file.read_exact(&mut bytes).map_err(io)?;
    record.transfer.offset = record.transfer.offset.max(query.offset + count as u64);
    save(data, &record)?;
    Ok(
        serde_json::json!({"offset":query.offset,"size":record.transfer.size,"data":hex::encode(&bytes),"sha256":digest(&bytes)}),
    )
}
#[derive(Deserialize)]
struct DownloadComplete {
    sha256: String,
}
fn finish_download(
    data: &FsPath,
    owner: &str,
    id: Uuid,
    input: DownloadComplete,
) -> Result<Transfer, ApiError> {
    let mut record = load(data, owner, id)?;
    if record.transfer.direction != Direction::Download
        || !matches!(record.transfer.status.as_str(), "pending" | "completed")
    {
        return Err(conflict("Download is not pending"));
    }
    if record.transfer.offset != record.transfer.size
        || record.transfer.sha256.as_ref() != Some(&input.sha256)
    {
        return Err(conflict("Download checksum or progress mismatch"));
    }
    record.transfer.status = "completed".into();
    save(data, &record)?;
    // Keep the snapshot for delivery retries until explicit record removal.
    Ok(record.transfer)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/transfers",
            axum::routing::get(list_route).post(create_route),
        )
        .route(
            "/api/transfers/download",
            axum::routing::post(create_download_route),
        )
        .route(
            "/api/transfers/{id}",
            axum::routing::get(status_route).delete(cancel_route),
        )
        .route(
            "/api/transfers/{id}/chunk",
            axum::routing::get(download_route).put(upload_route),
        )
        .route(
            "/api/transfers/{id}/complete",
            axum::routing::post(complete_route),
        )
        .route(
            "/api/transfers/{id}/download-complete",
            axum::routing::post(download_complete_route),
        )
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<Json<T>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _lock = LOCK
            .lock()
            .map_err(|_| ApiError::internal("Transfer store unavailable"))?;
        work().map(Json)
    })
    .await
    .map_err(io)?
}
async fn list_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Transfer>>, ApiError> {
    let data = state.config().data_dir.clone();
    let canonical = query
        .path
        .as_ref()
        .map(|path| {
            fs::canonicalize(path)
                .map(|path| path.to_string_lossy().to_string())
                .map_err(|_| ApiError::bad_request("Workspace unavailable"))
        })
        .transpose()?;
    blocking(move || {
        Ok(records(&data, &user.user_id)?
            .into_iter()
            .map(|r| r.transfer)
            .filter(|r| {
                canonical
                    .as_ref()
                    .is_none_or(|path| r.workspace_path == *path)
            })
            .collect())
    })
    .await
}
async fn create_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<Create>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || {
        if input.direction != Direction::Upload {
            return Err(ApiError::bad_request("Use the download endpoint"));
        }
        create(&data, &user.user_id, input)
    })
    .await
}
async fn status_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || Ok(load(&data, &user.user_id, id)?.transfer)).await
}
async fn cancel_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || cancel(&data, &user.user_id, id)).await
}
async fn upload_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
    Json(input): Json<ChunkInput>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || append(&data, &user.user_id, id, input)).await
}
async fn download_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
    Query(query): Query<ChunkQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || read_chunk(&data, &user.user_id, id, query)).await
}
async fn complete_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || finish(&data, &user.user_id, id)).await
}
async fn download_complete_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
    Json(input): Json<DownloadComplete>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    blocking(move || finish_download(&data, &user.user_id, id, input)).await
}

async fn create_download_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(mut input): Json<Create>,
) -> Result<Json<Transfer>, ApiError> {
    let data = state.config().data_dir.clone();
    input.direction = Direction::Download;
    blocking(move || create(&data, &user.user_id, input)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(root: &FsPath, name: &str, size: u64) -> Create {
        Create {
            direction: Direction::Upload,
            workspace_path: root.to_string_lossy().into(),
            relative_path: name.into(),
            size: Some(size),
            sha256: None,
        }
    }
    fn chunk(offset: u64, bytes: &[u8]) -> ChunkInput {
        ChunkInput {
            offset,
            data: hex::encode(bytes),
            sha256: digest(bytes),
        }
    }
    #[tokio::test]
    async fn http_transfer_auth_offsets_download_and_owner_isolation() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        async fn request(
            router: Router,
            token: Option<&str>,
            method: &str,
            path: &str,
            body: serde_json::Value,
        ) -> (StatusCode, serde_json::Value) {
            let mut builder = Request::builder()
                .method(method)
                .uri(path)
                .header("Content-Type", "application/json");
            if let Some(token) = token {
                builder = builder.header("Authorization", format!("Bearer {token}"));
            }
            let response = router
                .oneshot(builder.body(Body::from(body.to_string())).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap();
            (status, serde_json::from_slice(&bytes).unwrap())
        }
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let router = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let owner = crate::auth::issue_access_token(&config.jwt_secret, "alice", "alice");
        let other = crate::auth::issue_access_token(&config.jwt_secret, "bob", "bob");
        assert_eq!(
            request(
                router.clone(),
                None,
                "GET",
                "/api/transfers",
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let body = serde_json::json!({"direction":"upload","workspacePath":work.path(),"relativePath":"http.txt","size":2});
        let (status, record) =
            request(router.clone(), Some(&owner), "POST", "/api/transfers", body).await;
        assert_eq!(status, StatusCode::OK);
        let id = record["id"].as_str().unwrap();
        assert_eq!(
            request(
                router.clone(),
                Some(&other),
                "GET",
                &format!("/api/transfers/{id}"),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "PUT",
                &format!("/api/transfers/{id}/chunk"),
                serde_json::json!({"offset":1,"data":"6869","sha256":digest(b"hi")})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "PUT",
                &format!("/api/transfers/{id}/chunk"),
                serde_json::json!({"offset":0,"data":"6869","sha256":digest(b"hi")})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "POST",
                &format!("/api/transfers/{id}/complete"),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_,record)=request(router.clone(),Some(&owner),"POST","/api/transfers/download",serde_json::json!({"direction":"download","workspacePath":work.path(),"relativePath":"http.txt"})).await;
        let id = record["id"].as_str().unwrap();
        let (status, chunk) = request(
            router.clone(),
            Some(&owner),
            "GET",
            &format!("/api/transfers/{id}/chunk?offset=0"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(
            (status, chunk["data"].as_str(), chunk["sha256"].as_str()),
            (StatusCode::OK, Some("6869"), Some(digest(b"hi").as_str()))
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "POST",
                &format!("/api/transfers/{id}/download-complete"),
                serde_json::json!({"sha256":digest(b"hi")})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "POST",
                &format!("/api/transfers/{id}/download-complete"),
                serde_json::json!({"sha256":digest(b"hi")})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "POST",
                &format!("/api/transfers/{id}/download-complete"),
                serde_json::json!({"sha256":digest(b"wrong")})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&other),
                "GET",
                &format!("/api/transfers/{id}/chunk?offset=0"),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(
                router.clone(),
                Some(&owner),
                "GET",
                &format!("/api/transfers/{id}/chunk?offset=0"),
                serde_json::Value::Null
            )
            .await
            .1["data"],
            "6869"
        );
    }
    #[test]
    fn cancellation_survives_missing_destination_workspace_and_stage() {
        for missing in ["destination", "workspace", "stage"] {
            let data = tempfile::tempdir().unwrap();
            let work = tempfile::tempdir().unwrap();
            fs::create_dir(work.path().join("nested")).unwrap();
            let file = create(
                data.path(),
                "alice",
                input(work.path(), "nested/new.txt", 2),
            )
            .unwrap();
            let record = load(data.path(), "alice", file.id).unwrap();
            match missing {
                "destination" => fs::remove_dir(work.path().join("nested")).unwrap(),
                "workspace" => fs::remove_dir_all(work.path()).unwrap(),
                _ => fs::remove_file(&record.stage).unwrap(),
            }
            assert!(cancel(data.path(), "bob", file.id).is_err());
            assert_eq!(
                cancel(data.path(), "alice", file.id).unwrap().status,
                "cancelled"
            );
            assert!(!record.stage.exists());
            cancel(data.path(), "alice", file.id).unwrap();
            assert!(records(data.path(), "alice").unwrap().is_empty());
        }
    }
    #[test]
    fn download_receipt_retries_and_completed_bytes_remain_deliverable() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        fs::write(work.path().join("download.txt"), b"hello").unwrap();
        let mut intent = input(work.path(), "download.txt", 5);
        intent.direction = Direction::Download;
        let file = create(data.path(), "alice", intent).unwrap();
        read_chunk(
            data.path(),
            "alice",
            file.id,
            ChunkQuery {
                offset: 0,
                length: None,
            },
        )
        .unwrap();
        let receipt = || DownloadComplete {
            sha256: digest(b"hello"),
        };
        finish_download(data.path(), "alice", file.id, receipt()).unwrap();
        fs::remove_file(work.path().join("download.txt")).unwrap();
        assert_eq!(
            finish_download(data.path(), "alice", file.id, receipt())
                .unwrap()
                .status,
            "completed"
        );
        assert!(finish_download(
            data.path(),
            "alice",
            file.id,
            DownloadComplete {
                sha256: digest(b"wrong")
            }
        )
        .is_err());
        assert!(read_chunk(
            data.path(),
            "bob",
            file.id,
            ChunkQuery {
                offset: 0,
                length: None
            }
        )
        .is_err());
        assert_eq!(
            read_chunk(
                data.path(),
                "alice",
                file.id,
                ChunkQuery {
                    offset: 0,
                    length: None
                }
            )
            .unwrap()["data"],
            "68656c6c6f"
        );
        let stage = load(data.path(), "alice", file.id).unwrap().stage;
        cancel(data.path(), "alice", file.id).unwrap();
        assert!(!stage.exists());
    }
    #[test]
    fn rewind_prevents_publish_and_staging_stays_outside_the_workspace() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let file = create(data.path(), "alice", input(work.path(), "new.txt", 2)).unwrap();
        append(data.path(), "alice", file.id, chunk(0, b"ok")).unwrap();
        assert_eq!(fs::read_dir(work.path()).unwrap().count(), 0);
        let guard = crate::workspace_activity::exclusive(work.path()).unwrap();
        assert!(finish(data.path(), "alice", file.id).is_err());
        drop(guard);
        assert!(finish(data.path(), "alice", file.id).is_ok());
    }
    #[test]
    fn upload_resumes_from_disk_and_publishes_exact_bytes_without_overwrite() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let file = create(data.path(), "alice", input(work.path(), "hello.txt", 5)).unwrap();
        append(data.path(), "alice", file.id, chunk(0, b"hel")).unwrap();
        assert_eq!(
            load(data.path(), "alice", file.id).unwrap().transfer.offset,
            3
        );
        assert!(append(data.path(), "bob", file.id, chunk(3, b"lo")).is_err());
        assert!(append(data.path(), "alice", file.id, chunk(0, b"hel")).is_ok());
        assert!(append(data.path(), "alice", file.id, chunk(0, b"bad")).is_err());
        append(data.path(), "alice", file.id, chunk(3, b"lo")).unwrap();
        let done = finish(data.path(), "alice", file.id).unwrap();
        assert_eq!(
            (
                done.status,
                fs::read(work.path().join("hello.txt")).unwrap()
            ),
            ("completed".into(), b"hello".to_vec())
        );
        assert!(create(data.path(), "alice", input(work.path(), "hello.txt", 2)).is_err());
    }
    #[test]
    fn checksum_failure_and_cancel_preserve_existing_files() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let file = create(data.path(), "alice", input(work.path(), "new.txt", 2)).unwrap();
        let mut bad = chunk(0, b"ok");
        bad.sha256 = "0".repeat(64);
        assert!(append(data.path(), "alice", file.id, bad).is_err());
        assert_eq!(
            load(data.path(), "alice", file.id).unwrap().transfer.offset,
            0
        );
        append(data.path(), "alice", file.id, chunk(0, b"ok")).unwrap();
        fs::write(work.path().join("new.txt"), b"existing").unwrap();
        assert!(finish(data.path(), "alice", file.id).is_err());
        cancel(data.path(), "alice", file.id).unwrap();
        assert_eq!(fs::read(work.path().join("new.txt")).unwrap(), b"existing");
    }
    #[test]
    fn traversal_and_oversize_are_rejected() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        assert!(create(data.path(), "alice", input(work.path(), "../escape", 1)).is_err());
        assert!(create(
            data.path(),
            "alice",
            input(work.path(), "large", MAX_FILE + 1)
        )
        .is_err());
    }
}
