//! Owner-scoped saved text/metadata reads. No recovery, state repair, or external calls.
use super::{StructuredControlError, StructuredSessionManager};
use crate::{auth::AuthenticatedUser, state::AppState};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::Semaphore;
const MAX_SAFE: i64 = 9_007_199_254_740_991;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_READERS: usize = 128;

pub(super) struct LocalReads {
    permit: Arc<Semaphore>,
    #[cfg(test)]
    barrier: StdMutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
}
impl Default for LocalReads {
    fn default() -> Self {
        Self {
            permit: Arc::new(Semaphore::new(1)),
            #[cfg(test)]
            barrier: StdMutex::new(None),
        }
    }
}
fn global_permits() -> Arc<Semaphore> {
    static GLOBAL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GLOBAL.get_or_init(|| Arc::new(Semaphore::new(2))).clone()
}
impl LocalReads {
    async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let local = self
            .permit
            .clone()
            .try_acquire_owned()
            .map_err(|_| "A saved-context read is still finishing; try again".to_string())?;
        let global = global_permits()
            .try_acquire_owned()
            .map_err(|_| "Local context readers are busy; try again".to_string())?;
        let keep_alive = self.clone();
        #[cfg(test)]
        let barrier = self.barrier.lock().unwrap().take();
        // Both permits and the registry's strong reader identity belong to the worker, not its HTTP waiter.
        let worker = tokio::task::spawn_blocking(move || {
            let _ownership = (local, global, keep_alive);
            #[cfg(test)]
            if let Some((entered, release)) = barrier {
                let _ = entered.send(());
                let _ = release.recv();
            }
            work()
        });
        tokio::time::timeout(READ_TIMEOUT, worker)
            .await
            .map_err(|_| {
                "The local context read exceeded its wait budget; it may still be finishing"
                    .to_string()
            })?
            .map_err(|_| "Local context reader failed".to_string())?
    }
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct ReaderKey {
    data: PathBuf,
    owner: String,
    session: String,
}
fn reader(data: &FsPath, owner: &str, id: &str) -> Result<Arc<LocalReads>, StructuredControlError> {
    static READERS: OnceLock<StdMutex<HashMap<ReaderKey, Weak<LocalReads>>>> = OnceLock::new();
    let mut readers = READERS
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .map_err(|_| StructuredControlError::internal("Local context reader is unavailable"))?;
    readers.retain(|_, reader| reader.strong_count() > 0);
    let key = ReaderKey {
        data: data.into(),
        owner: owner.into(),
        session: id.into(),
    };
    if let Some(existing) = readers.get(&key).and_then(Weak::upgrade) {
        return Ok(existing);
    }
    if readers.len() >= MAX_READERS {
        return Err(StructuredControlError {
            code: "unavailable",
            message: "Local context reader capacity is full; try again".into(),
        });
    }
    let reader = Arc::new(LocalReads::default());
    readers.insert(key, Arc::downgrade(&reader));
    Ok(reader)
}
#[derive(Clone, PartialEq, Eq)]
struct Authority {
    generation: u64,
    seq: i64,
    provider: String,
    model: String,
    reasoning: Option<String>,
    cwd: String,
    busy: bool,
    cleanup: bool,
}
fn authority(state: &super::StructuredSessionState) -> Authority {
    Authority {
        generation: state.generation,
        seq: state.events.last().map_or(0, |event| event.seq()),
        provider: state.provider.clone(),
        model: state.model.clone().unwrap_or_default(),
        reasoning: state.reasoning.clone(),
        cwd: state.cwd.clone(),
        busy: state.process.is_some() || state.retiring || state.deleting,
        cleanup: state.retiring
            || state.deleting
            || state
                .process
                .as_ref()
                .is_some_and(|controller| controller.is_blocked()),
    }
}
fn disk_authority(snapshot: &terminal_v4_core::StructuredSessionSnapshot) -> Authority {
    let completed: HashSet<_> = snapshot
        .events
        .iter()
        .filter_map(|event| match event {
            terminal_v4_core::StructuredSessionEvent::TurnCompleted { turn_id, .. } => {
                Some(turn_id.as_str())
            }
            _ => None,
        })
        .collect();
    let unfinished = snapshot.events.iter().any(|event| match event {
        terminal_v4_core::StructuredSessionEvent::UserMessageAccepted { turn_id, .. }
        | terminal_v4_core::StructuredSessionEvent::CommandAccepted { turn_id, .. } => {
            !completed.contains(turn_id.as_str())
        }
        _ => false,
    });
    let cleanup = matches!(
        snapshot.status.as_deref(),
        Some("cleanup_required" | "reconciliation_required")
    );
    Authority {
        generation: 0,
        seq: snapshot.events.last().map_or(0, |event| event.seq()),
        provider: snapshot.provider.clone(),
        model: snapshot.model.clone().unwrap_or_default(),
        reasoning: snapshot.reasoning.clone(),
        cwd: snapshot.cwd.clone(),
        busy: unfinished || cleanup,
        cleanup,
    }
}
fn validate_authority(source: &Authority) -> Result<(), StructuredControlError> {
    if !(0..=MAX_SAFE).contains(&source.seq)
        || source.provider.len() > 120
        || source.provider.chars().any(char::is_control)
        || source.model.len() > 200
        || source.model.chars().any(char::is_control)
        || source
            .reasoning
            .as_ref()
            .is_some_and(|value| value.len() > 32 || value.chars().any(char::is_control))
        || source.cwd.len() > 2048
        || !FsPath::new(&source.cwd).is_absolute()
        || source.cwd.chars().any(char::is_control)
    {
        return Err(StructuredControlError {
            code: "unavailable",
            message: "Conversation sequence or target metadata exceeds the supported display range"
                .into(),
        });
    }
    Ok(())
}
fn dto(
    id: &str,
    source: &Authority,
    status: &str,
    blocked: Option<&str>,
    warning: Option<&str>,
) -> Value {
    json!({"schemaVersion":1,"sessionId":id,"asOfSeq":source.seq,"measuredAt":crate::iso_timestamp(),"provider":source.provider,"model":source.model,"reasoning":source.reasoning,"scope":"saved_conversation","measurementScope":"saved_text_and_metadata","draftIncluded":false,"hydratedBinaryIncluded":false,"sampleStatus":status,"canCompact":false,"blockedReason":blocked,"usage":null,"conversationRevision":null,"warning":warning})
}
fn busy(id: &str, source: &Authority) -> Value {
    dto(
        id,
        source,
        "busy",
        Some(if source.cleanup {
            "cleanup_required"
        } else {
            "busy"
        }),
        Some("Conversation is busy; saved target and context were not sampled. The displayed target is the parent selection."),
    )
}
#[derive(PartialEq, Eq)]
struct ParentStamp {
    digest: [u8; 32],
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
fn parent_bytes(
    data: &FsPath,
    owner: &str,
    id: &str,
) -> Result<Option<(Vec<u8>, ParentStamp)>, StructuredControlError> {
    let fail = || StructuredControlError {
        code: "unavailable",
        message: "The owned conversation could not be read safely".into(),
    };
    #[cfg(unix)]
    let file = {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        };
        let mut directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(data)
            .map_err(|_| fail())?;
        for part in [
            "structured-sessions".to_string(),
            hex::encode(Sha256::digest(owner.as_bytes())),
        ] {
            let part = std::ffi::CString::new(part).map_err(|_| fail())?;
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    part.as_ptr(),
                    libc::O_RDONLY
                        | libc::O_DIRECTORY
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC
                        | libc::O_NONBLOCK,
                )
            };
            if fd < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                    return Ok(None);
                }
                return Err(fail());
            }
            directory = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        let name = std::ffi::CString::new(format!("{id}.json")).map_err(|_| fail())?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(fail());
        }
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let file = {
        let mut path = data.to_path_buf();
        for part in [
            "structured-sessions".to_string(),
            hex::encode(Sha256::digest(owner.as_bytes())),
        ] {
            path.push(part);
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                    return Err(fail())
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(fail()),
            }
        }
        path.push(format!("{id}.json"));
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(fail())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(fail()),
        };
        std::fs::File::open(path).map_err(|_| fail())?
    };
    let metadata = file.metadata().map_err(|_| fail())?;
    if !metadata.is_file() || metadata.len() > super::MAX_STRUCTURED_FILE_BYTES as u64 {
        return Err(fail());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(fail());
        }
    }
    let before_modified = metadata.modified().ok();
    let before_length = metadata.len();
    let mut bytes = Vec::new();
    (&file)
        .take(super::MAX_STRUCTURED_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail())?;
    let after = file.metadata().map_err(|_| fail())?;
    if bytes.len() > super::MAX_STRUCTURED_FILE_BYTES
        || after.len() != before_length
        || after.modified().ok() != before_modified
    {
        return Err(fail());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let stamp = ParentStamp {
        digest: Sha256::digest(&bytes).into(),
        length: after.len(),
        modified: after.modified().ok(),
        #[cfg(unix)]
        device: after.dev(),
        #[cfg(unix)]
        inode: after.ino(),
    };
    Ok(Some((bytes, stamp)))
}
struct ReadOutcome {
    source: Authority,
    stamp: Option<ParentStamp>,
    sample: Value,
}
fn read_owned(
    data: &FsPath,
    owner: &str,
    id: &str,
    engine: &str,
    live_source: Option<Authority>,
    queue_boot_id: uuid::Uuid,
    background_delegation: bool,
) -> Result<ReadOutcome, StructuredControlError> {
    let (source, stamp) = if let Some(source) = live_source {
        (source, None)
    } else {
        let (bytes, stamp) =
            parent_bytes(data, owner, id)?.ok_or_else(StructuredControlError::not_found)?;
        let stored = super::storage::decode(&bytes).map_err(|_| StructuredControlError {
            code: "unavailable",
            message: "Owned conversation metadata is invalid".into(),
        })?;
        if stored.owner_id != owner {
            return Err(StructuredControlError::not_found());
        }
        if stored.snapshot.id != id || stored.snapshot.events.len() > super::MAX_STRUCTURED_EVENTS {
            return Err(StructuredControlError {
                code: "unavailable",
                message: "Owned conversation binding is invalid".into(),
            });
        }
        let snapshot = &stored.snapshot;
        if snapshot.provider.len() > 120
            || snapshot.provider.chars().any(char::is_control)
            || snapshot
                .model
                .as_ref()
                .is_some_and(|model| model.len() > 200 || model.chars().any(char::is_control))
            || snapshot
                .reasoning
                .as_ref()
                .is_some_and(|value| value.len() > 32 || value.chars().any(char::is_control))
            || snapshot.cwd.len() > 2048
            || !FsPath::new(&snapshot.cwd).is_absolute()
            || snapshot.cwd.chars().any(char::is_control)
        {
            return Err(StructuredControlError {
                code: "unavailable",
                message: "Owned conversation target metadata is invalid".into(),
            });
        }
        (disk_authority(&stored.snapshot), Some(stamp))
    };
    validate_authority(&source)?;
    if !crate::v4_agent::supports(&source.provider) {
        return Err(StructuredControlError::conflict(
            "Context is available for V4 sessions only",
        ));
    }
    if source.seq > MAX_SAFE {
        return Err(StructuredControlError {
            code: "unavailable",
            message: "Conversation sequence exceeds the supported display range".into(),
        });
    }
    let mut sample = if source.busy {
        busy(id, &source)
    } else {
        match crate::v4_agent::context::sample(
            data,
            owner,
            FsPath::new(&source.cwd),
            engine,
            &source.provider,
            &source.model,
            crate::v4_agent::context::ContextOptions {
                reasoning: source.reasoning.as_deref(),
                background_delegation,
            },
        ) {
            Ok(projected) => {
                let saved = projected["saved"] == true;
                let eligible = projected["canCompact"] == true;
                let mut result = dto(
                    id,
                    &source,
                    if saved { "current" } else { "no_saved_history" },
                    if !saved {
                        Some("no_saved_history")
                    } else if !eligible {
                        Some("nothing_compactable")
                    } else {
                        None
                    },
                    None,
                );
                result["provider"] = projected["provider"].clone();
                result["model"] = projected["model"].clone();
                result["usage"] = projected["usage"].clone();
                result["conversationRevision"] = projected["conversationRevision"].clone();
                result["canCompact"] = json!(eligible);
                if saved {
                    let scope =
                        crate::followup_queue::QueueScope::new(owner, FsPath::new(&source.cwd), id)
                            .map_err(|_| {
                                StructuredControlError::internal("Queue scope is unavailable")
                            })?;
                    match crate::followup_queue::QueueStore::new(data, queue_boot_id)
                        .inspect(&scope)
                    {
                        Ok(Some(queue))
                            if queue.items.iter().any(|item| {
                                item.state == crate::followup_queue::ItemState::Dispatching
                            }) || (queue.mode == crate::followup_queue::QueueMode::Running
                                && !queue.order.is_empty()) =>
                        {
                            result["canCompact"] = json!(false);
                            result["blockedReason"] = json!("queue_has_priority");
                        }
                        Ok(_) => {}
                        Err(_) => {
                            result = dto(
                                id,
                                &source,
                                "unavailable",
                                Some("unavailable"),
                                Some("Queue readiness could not be read safely"),
                            );
                        }
                    }
                }
                result
            }
            Err(error) => {
                let mut result = dto(
                    id,
                    &source,
                    "unavailable",
                    Some("unavailable"),
                    Some(&error.message),
                );
                if let Some(provider) = error.provider {
                    result["provider"] = json!(provider)
                }
                if let Some(model) = error.model {
                    result["model"] = json!(model)
                }
                result
            }
        }
    };
    if let Some(before) = &stamp {
        if parent_bytes(data, owner, id)?
            .map(|(_, after)| after)
            .as_ref()
            != Some(before)
        {
            sample = dto(
                id,
                &source,
                "unavailable",
                Some("unavailable"),
                Some("Conversation changed during the local context read; refresh"),
            );
        }
    }
    Ok(ReadOutcome {
        source,
        stamp,
        sample,
    })
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/structured/sessions/{id}/context", get(get_context))
}
async fn get_context(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<String>,
) -> Response {
    let result = state
        .structured_session_manager()
        .context_snapshot(&user.user_id, &id)
        .await;
    let mut response = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error.code {
                "not_found" => StatusCode::NOT_FOUND,
                "conflict" => StatusCode::CONFLICT,
                "invalid" => StatusCode::BAD_REQUEST,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            (status, Json(json!({"error":error.message}))).into_response()
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
}
impl StructuredSessionManager {
    pub(crate) async fn context_snapshot(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<Value, StructuredControlError> {
        #[cfg(unix)]
        let _admission = self
            .external_admission()
            .map_err(StructuredControlError::internal)?;
        if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
            return Err(StructuredControlError::not_found());
        }
        let engine =
            super::engine_session_id(id).map_err(|_| StructuredControlError::not_found())?;
        #[cfg(unix)]
        if let Some(ownership) = self.inner.live_ownership.get() {
            ownership
                .ensure(owner)
                .map_err(StructuredControlError::internal)?;
        }
        let live = self.inner.sessions.lock().await.get(id).cloned();
        let captured = if let Some(live) = &live {
            let state = live.state.lock().await;
            if state.user_id != owner {
                return Err(StructuredControlError::not_found());
            }
            let source = authority(&state);
            validate_authority(&source)?;
            if !crate::v4_agent::supports(&source.provider) {
                return Err(StructuredControlError::conflict(
                    "Context is available for V4 sessions only",
                ));
            }
            if source.busy {
                return Ok(busy(id, &source));
            }
            Some(source)
        } else {
            None
        };
        let reader = reader(&self.inner.config.data_dir, owner, id)?;
        #[cfg(test)]
        if let Some(live) = &live {
            if let Some(barrier) = live.context_reads.barrier.lock().unwrap().take() {
                *reader.barrier.lock().unwrap() = Some(barrier);
            }
        }
        let data = self.inner.config.data_dir.clone();
        let worker_owner = owner.to_string();
        let worker_id = id.to_string();
        let worker_source = captured.clone();
        let queue_boot_id = super::queue::manager_boot_id(self);
        #[cfg(unix)]
        let background_delegation = self.inner.delegation_supervisor.get().is_some();
        #[cfg(not(unix))]
        let background_delegation = false;
        #[cfg(unix)]
        let worker_permit = self
            .internal_admission()
            .map_err(StructuredControlError::internal)?;
        let result = reader
            .run(move || {
                #[cfg(unix)]
                let _worker_permit = worker_permit;
                Ok(read_owned(
                    &data,
                    &worker_owner,
                    &worker_id,
                    &engine,
                    worker_source,
                    queue_boot_id,
                    background_delegation,
                ))
            })
            .await;
        let outcome = match result {
            Ok(result) => result?,
            Err(message) => {
                if let Some(source) = &captured {
                    return Ok(dto(
                        id,
                        source,
                        "unavailable",
                        Some("unavailable"),
                        Some(&message),
                    ));
                }
                return Err(StructuredControlError {
                    code: "unavailable",
                    message,
                });
            }
        };
        let current = self.inner.sessions.lock().await.get(id).cloned();
        match (&live, current) {
            (Some(expected), Some(current)) if Arc::ptr_eq(expected, &current) => {
                let state = current.state.lock().await;
                if state.user_id != owner {
                    return Err(StructuredControlError::not_found());
                }
                let now = authority(&state);
                validate_authority(&now)?;
                if captured.as_ref() != Some(&now) {
                    return Ok(if now.busy {
                        busy(id, &now)
                    } else {
                        dto(
                            id,
                            &now,
                            "unavailable",
                            Some("unavailable"),
                            Some("Conversation changed during the local context read; refresh"),
                        )
                    });
                }
            }
            (None, None) if outcome.stamp.is_some() => {}
            _ => return Ok(dto(
                id,
                &outcome.source,
                "unavailable",
                Some("unavailable"),
                Some("Conversation ownership or activity changed during the context read; refresh"),
            )),
        }
        Ok(outcome.sample)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    // These tests deliberately occupy the process-wide reader slots, so their fixtures must not compete.
    static CONTEXT_READ_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn setup(
        saved: bool,
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        StructuredSessionManager,
        String,
        String,
    ) {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        let engine = super::super::engine_session_id(&parent.id).unwrap();
        let revision = if saved {
            crate::v4_agent::context::seed(
                data.path(),
                "owner",
                &workspace.path().canonicalize().unwrap(),
                &engine,
                "deepseek",
                "deepseek-chat",
            )
        } else {
            String::new()
        };
        (data, workspace, manager, parent.id, revision)
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn structured_context_includes_the_bound_delegation_capability() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE api_key_vault (user_id TEXT, key_name TEXT, key_value TEXT)",
        )
        .unwrap();
        drop(db);
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let supervisor =
            crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap();
        manager.bind_delegation_supervisor(supervisor).unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        let engine = super::super::engine_session_id(&parent.id).unwrap();
        let root = workspace.path().canonicalize().unwrap();
        crate::v4_agent::context::seed(
            data.path(),
            "owner",
            &root,
            &engine,
            "deepseek",
            "deepseek-chat",
        );
        let direct = |enabled| {
            crate::v4_agent::context::sample(
                data.path(),
                "owner",
                &root,
                &engine,
                "deepseek",
                "deepseek-chat",
                crate::v4_agent::context::ContextOptions {
                    reasoning: None,
                    background_delegation: enabled,
                },
            )
            .unwrap()
        };
        let expected = direct(true);
        let without_delegation = direct(false);
        let result = manager.context_snapshot("owner", &parent.id).await.unwrap();
        assert_eq!(result["sampleStatus"], "current");
        assert_eq!(
            result["usage"]["requestBytes"],
            expected["usage"]["requestBytes"]
        );
        assert!(
            result["usage"]["requestBytes"].as_u64().unwrap()
                > without_delegation["usage"]["requestBytes"]
                    .as_u64()
                    .unwrap()
        );
        manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn context_route_requires_owner_before_local_reads_and_is_private() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (data, _workspace, manager, id, _) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let app = routes()
            .layer(Extension(AuthenticatedUser {
                user_id: "foreign".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/structured/sessions/{id}/context"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
    }
    #[tokio::test]
    async fn context_saved_sample_is_current_exact_revision_and_honest_scope() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (data, _workspace, manager, id, revision) = setup(true).await;
        let sample = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(sample["sampleStatus"], "current");
        assert_eq!(sample["provider"], "deepseek");
        assert_eq!(sample["model"], "deepseek-chat");
        assert_eq!(sample["conversationRevision"], revision);
        assert_eq!(sample["measurementScope"], "saved_text_and_metadata");
        assert_eq!(sample["hydratedBinaryIncluded"], false);
        assert_eq!(sample["draftIncluded"], false);
        assert_eq!(sample["canCompact"], true);
        assert!(!data.path().join("terminal.db").exists());
        assert!(!data.path().join("followup-queues").exists());
        assert!(!data.path().join("agent-mcp").exists());
    }
    #[tokio::test]
    async fn context_no_saved_history_is_not_unavailable_and_creates_no_engine_or_queue() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (data, _workspace, manager, id, _) = setup(false).await;
        let sample = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(sample["sampleStatus"], "no_saved_history");
        assert!(sample["usage"].is_null());
        assert!(sample["conversationRevision"].is_null());
        assert!(!data.path().join("v4-agent-history").exists());
        assert!(!data.path().join("followup-queues").exists());
    }
    #[tokio::test]
    async fn context_busy_and_cleanup_are_not_current_samples() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (_data, _workspace, manager, id, _) = setup(true).await;
        let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
        live.state.lock().await.retiring = true;
        let sample = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(sample["blockedReason"], "cleanup_required");
        assert!(sample["usage"].is_null());
    }
    #[tokio::test]
    async fn context_cold_journal_tail_preserves_accepted_turn_busy_state_and_sequence() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (_data, _workspace, manager, id, _) = setup(true).await;
        manager
            .record_event(
                "owner",
                &id,
                terminal_v4_core::StructuredSessionEvent::UserMessageAccepted {
                    ts: 1,
                    seq: 0,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    turn_id: uuid::Uuid::new_v4().to_string(),
                    message_id: uuid::Uuid::new_v4().to_string(),
                    content: "Appended context fixture".into(),
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        let path = super::super::structured_session_path(&manager.inner.config, "owner", &id);
        let before = std::fs::read(&path).unwrap();
        let lines: Vec<_> = before
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .collect();
        let checkpoint: Value = serde_json::from_slice(lines[0]).unwrap();
        assert_eq!(checkpoint["version"], 2);
        assert_eq!(checkpoint["snapshot"]["events"], json!([]));
        assert_eq!(lines.len(), 2);

        let cold = StructuredSessionManager::new(manager.inner.config.clone());
        let sample = cold.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(
            (
                sample["sampleStatus"].clone(),
                sample["asOfSeq"].clone(),
                sample["blockedReason"].clone(),
                sample["canCompact"].clone()
            ),
            (json!("busy"), json!(1), json!("busy"), json!(false)),
        );
        assert!(sample["usage"].is_null() && sample["conversationRevision"].is_null());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(cold.inner.sessions.lock().await.is_empty());
    }
    #[tokio::test]
    async fn context_selected_target_mismatch_exposes_actual_target_without_metrics() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (_data, _workspace, manager, id, _) = setup(true).await;
        let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
        live.state.lock().await.model = Some("deepseek-reasoner".into());
        let sample = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(sample["sampleStatus"], "unavailable");
        assert_eq!(sample["model"], "deepseek-chat");
        assert!(sample["usage"].is_null());
        assert!(sample["warning"].as_str().unwrap().contains("target"));
    }
    #[tokio::test]
    async fn compact_controls_are_rejected_before_any_acceptance() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        for text in [
            "forbidden\u{7}control",
            "forbidden\u{1b}control",
            "forbidden\u{85}control",
        ] {
            let (_data, _workspace, manager, id, revision) = setup(true).await;
            let result = manager
                .compact(
                    "owner",
                    &id,
                    &uuid::Uuid::new_v4().to_string(),
                    Some(text),
                    Some(&revision),
                )
                .await;
            assert_eq!(result.unwrap_err().code, "invalid");
            let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
            assert!(snapshot.events.is_empty());
        }
    }
    #[tokio::test]
    async fn local_read_abort_keeps_single_flight_until_worker_finishes() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let reads = Arc::new(LocalReads::default());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first = tokio::spawn({
            let reads = reads.clone();
            async move {
                reads
                    .run(move || {
                        let _ = entered_tx.send(());
                        let _ = release_rx.recv();
                        Ok(())
                    })
                    .await
            }
        });
        entered_rx.await.unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let next = tokio::spawn({
            let reads = reads.clone();
            let started = started.clone();
            async move {
                reads
                    .run(move || {
                        started.store(true, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            }
        });
        let result = next.await.unwrap();
        let violated = started.load(std::sync::atomic::Ordering::SeqCst);
        let _ = release_tx.send(());
        let _finished = global_permits().acquire_many_owned(2).await.unwrap();
        assert_eq!(
            result.unwrap_err(),
            "A saved-context read is still finishing; try again"
        );
        assert!(
            !violated,
            "aborted HTTP waiter released ownership while its worker still ran"
        );
    }
    #[tokio::test]
    async fn local_read_global_cap_survives_two_aborted_session_waiters() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let mut releases = Vec::new();
        for _ in 0..2 {
            let reads = Arc::new(LocalReads::default());
            let (tx, rx) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            releases.push(release);
            let task = tokio::spawn(async move {
                reads
                    .run(move || {
                        let _ = tx.send(());
                        let _ = wait.recv();
                        Ok(())
                    })
                    .await
            });
            rx.await.unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let third = tokio::spawn({
            let started = started.clone();
            async move {
                Arc::new(LocalReads::default())
                    .run(move || {
                        started.store(true, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            }
        });
        let result = third.await.unwrap();
        let violated = started.load(std::sync::atomic::Ordering::SeqCst);
        for release in releases {
            let _ = release.send(());
        }
        let _finished = global_permits().acquire_many_owned(2).await.unwrap();
        assert_eq!(
            result.unwrap_err(),
            "Local context readers are busy; try again"
        );
        assert!(
            !violated,
            "third session exceeded the global local-worker cap"
        );
    }
    #[tokio::test]
    async fn context_post_worker_authority_rejects_generation_changed_during_local_read() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (_data, _workspace, manager, id, _) = setup(true).await;
        let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let (entered, wait) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        *live.context_reads.barrier.lock().unwrap() = Some((entered, blocked));
        let task = tokio::spawn({
            let manager = manager.clone();
            let id = id.clone();
            async move { manager.context_snapshot("owner", &id).await }
        });
        wait.await.unwrap();
        {
            let mut state = live.state.lock().await;
            state.generation += 1;
            state.retiring = true;
        }
        release.send(()).unwrap();
        let sample = task.await.unwrap().unwrap();
        assert_eq!(sample["sampleStatus"], "busy");
        assert_eq!(sample["blockedReason"], "cleanup_required");
        assert!(sample["usage"].is_null());
        assert!(sample["conversationRevision"].is_null());
    }
    #[tokio::test]
    async fn context_cold_missing_foreign_and_native_do_not_recover_unrelated_compact() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        for case in ["missing", "foreign", "native"] {
            let (_data, workspace, manager, id, _) = setup(true).await;
            let mut pending = manager.get_session("owner", &id).await.unwrap().unwrap();
            pending.events = vec![terminal_v4_core::StructuredSessionEvent::CommandAccepted {
                ts: 1,
                seq: 1,
                request_id: uuid::Uuid::new_v4().to_string(),
                turn_id: uuid::Uuid::new_v4().to_string(),
                command: "compact".into(),
                input: json!({"instructions":null,"expectedRevision":"a".repeat(64),"sourceRevision":"a".repeat(64)}),
            }];
            let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
            let incarnation = live.state.lock().await.session_incarnation;
            manager
                .persist_snapshot("owner", &pending, incarnation)
                .unwrap();
            let target = if case == "missing" {
                format!("ss-{}", uuid::Uuid::new_v4().simple())
            } else {
                manager
                    .create_session(
                        if case == "foreign" {
                            "foreign"
                        } else {
                            "owner"
                        },
                        workspace.path().to_str().unwrap(),
                        Some("claude"),
                        None,
                        None,
                    )
                    .await
                    .unwrap()
                    .id
            };
            let path = super::super::structured_session_path(&manager.inner.config, "owner", &id);
            let before = std::fs::read(&path).unwrap();
            let cold = StructuredSessionManager::new(manager.inner.config.clone());
            let result = cold.context_snapshot("owner", &target).await;
            assert_eq!(
                std::fs::read(&path).unwrap(),
                before,
                "{case} read rewrote unrelated accepted command"
            );
            assert_eq!(
                result.unwrap_err().code,
                if case == "native" {
                    "conflict"
                } else {
                    "not_found"
                }
            );
        }
    }
    #[tokio::test]
    async fn compact_rejects_saved_target_mismatch_before_acceptance_or_provider_resolution() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (_data, _workspace, baseline, id, revision) = setup(true).await;
        let accepted=baseline.compact("owner",&id,&uuid::Uuid::new_v4().to_string(),Some("keep goals"),Some(&revision)).await.expect("matching target, scope and revision must reach durable acceptance before this mismatch test is meaningful");
        assert_eq!(accepted.status, "accepted");
        baseline.shutdown().await.unwrap();
        let (_data, _workspace, manager, id, revision) = setup(true).await;
        let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
        live.state.lock().await.model = Some("deepseek-reasoner".into());
        let result = manager
            .compact(
                "owner",
                &id,
                &uuid::Uuid::new_v4().to_string(),
                Some("keep goals"),
                Some(&revision),
            )
            .await;
        manager.shutdown().await.unwrap();
        let error = result.expect_err("a changed selected target must not be accepted");
        assert_eq!(error.code, "conflict");
        assert!(
            error.message.to_lowercase().contains("target"),
            "unexpected rejection: {}",
            error.message
        );
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .is_empty());
    }
    #[tokio::test]
    async fn context_cold_copied_foreign_envelope_is_not_found_without_engine_reads() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        let (data, _workspace, manager, id, _) = setup(true).await;
        let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
        manager
            .persist_snapshot("foreign", &snapshot, None)
            .unwrap();
        let source = super::super::structured_session_path(&manager.inner.config, "foreign", &id);
        let target = super::super::structured_session_path(&manager.inner.config, "owner", &id);
        std::fs::copy(&source, &target).unwrap();
        let before = std::fs::read(&target).unwrap();
        let cold = StructuredSessionManager::new(manager.inner.config.clone());
        let result = cold.context_snapshot("owner", &id).await;
        assert_eq!(std::fs::read(&target).unwrap(), before);
        assert!(!data.path().join("agent-mcp").exists());
        assert!(!data.path().join("followup-queues").exists());
        assert_eq!(result.unwrap_err().code, "not_found");
    }
    #[tokio::test]
    async fn context_hot_busy_rejects_negative_and_unsafe_sequences_before_public_dto() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        for seq in [-1, MAX_SAFE + 1] {
            let (_data, _workspace, manager, id, _) = setup(true).await;
            let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
            {
                let mut state = live.state.lock().await;
                state.retiring = true;
                state
                    .events
                    .push(terminal_v4_core::StructuredSessionEvent::Status {
                        ts: 1,
                        seq,
                        status: "busy".into(),
                    });
            }
            let result = manager.context_snapshot("owner", &id).await;
            assert_eq!(
                result
                    .expect_err("unsafe canonical sequence must not enter a public DTO")
                    .code,
                "unavailable"
            );
        }
    }
    #[tokio::test]
    async fn context_queue_priority_is_nonmutating_for_running_pending_held_pending_and_dispatching(
    ) {
        let _test = CONTEXT_READ_TESTS.lock().await;
        use crate::followup_queue::{
            IdleBoundary, Mutation, QueueOperation, QueueScope, QueueStore,
        };
        let (data, workspace, manager, id, _) = setup(true).await;
        let canonical = workspace.path().canonicalize().unwrap();
        let scope = QueueScope::new("owner", &canonical, &id).unwrap();
        let store = QueueStore::new(data.path(), super::super::queue::boot_id());
        let mutate = |op| {
            let revision = store.load(&scope).unwrap().revision;
            store
                .mutate(
                    &scope,
                    Mutation {
                        operation_id: uuid::Uuid::new_v4(),
                        expected_queue_revision: revision,
                        operation: op,
                    },
                )
                .unwrap();
        };
        mutate(QueueOperation::Enqueue {
            item_id: uuid::Uuid::new_v4(),
            text: "pending fixture".into(),
            run_when_idle: false,
        });
        let path = data
            .path()
            .join("followup-queues")
            .join(hex::encode(Sha256::digest(b"owner")))
            .join(hex::encode(Sha256::digest(
                canonical.to_str().unwrap().as_bytes(),
            )))
            .join(format!("{id}.json"));
        let before = std::fs::read(&path).unwrap();
        let held = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(held["sampleStatus"], "current");
        assert_eq!(held["canCompact"], true);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        mutate(QueueOperation::Resume);
        let before = std::fs::read(&path).unwrap();
        let running = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(running["canCompact"], false);
        assert_eq!(running["blockedReason"], "queue_has_priority");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        store
            .reserve_next(
                &scope,
                store.load(&scope).unwrap().revision,
                IdleBoundary { turn_epoch: 0 },
            )
            .unwrap()
            .unwrap();
        mutate(QueueOperation::Pause);
        let before = std::fs::read(&path).unwrap();
        let dispatching = manager.context_snapshot("owner", &id).await.unwrap();
        assert_eq!(dispatching["canCompact"], false);
        assert_eq!(dispatching["blockedReason"], "queue_has_priority");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn context_read_requires_paired_agent_execution_authority() {
        for (permissions, allowed) in [
            (crate::remote_permissions::Capabilities::observer(), false),
            (crate::remote_permissions::Capabilities::operator(), true),
        ] {
            for method in ["GET", "HEAD"] {
                assert_eq!(
                    permissions.allows_http(
                        method,
                        "/api/structured/sessions/ss-00000000000000000000000000000001/context"
                    ),
                    allowed
                );
            }
        }
    }
    #[tokio::test]
    async fn context_post_worker_rejects_new_busy_negative_and_unsafe_sequences() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        for seq in [-1, MAX_SAFE + 1] {
            let (_data, _workspace, manager, id, _) = setup(true).await;
            let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
            let (entered, wait) = tokio::sync::oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel();
            *live.context_reads.barrier.lock().unwrap() = Some((entered, blocked));
            let task = tokio::spawn({
                let manager = manager.clone();
                let id = id.clone();
                async move { manager.context_snapshot("owner", &id).await }
            });
            wait.await.unwrap();
            {
                let mut state = live.state.lock().await;
                state.generation += 1;
                state.retiring = true;
                state
                    .events
                    .push(terminal_v4_core::StructuredSessionEvent::Status {
                        ts: 1,
                        seq,
                        status: "busy".into(),
                    });
            }
            release.send(()).unwrap();
            let result = task.await.unwrap();
            assert_eq!(
                result
                    .expect_err("post-worker state must not emit an unsafe sequence")
                    .code,
                "unavailable"
            );
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn context_fifo_workspace_instructions_do_not_hold_read_slots_until_a_writer_arrives() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        use std::os::unix::fs::OpenOptionsExt;
        let mut fixtures = Vec::new();
        let mut tasks = Vec::new();
        let mut releases = Vec::new();
        let mut entered = Vec::new();
        let mut pipes = Vec::new();
        for _ in 0..2 {
            let fixture = setup(true).await;
            let pipe = fixture.1.path().join("AGENTS.md");
            let path = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            let live = fixture
                .2
                .owned_session("owner", &fixture.3)
                .await
                .unwrap()
                .unwrap();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel();
            *live.context_reads.barrier.lock().unwrap() = Some((tx, blocked));
            releases.push(release);
            entered.push(rx);
            let manager = fixture.2.clone();
            let id = fixture.3.clone();
            tasks.push(tokio::spawn(async move {
                manager.context_snapshot("owner", &id).await
            }));
            pipes.push(pipe);
            fixtures.push(fixture);
        }
        for wait in entered {
            wait.await.unwrap();
        }
        for release in releases {
            release.send(()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
        let finished_before_any_writer = tasks.iter().all(|task| task.is_finished());
        let healthy = setup(true).await;
        let third = healthy
            .2
            .context_snapshot("owner", &healthy.3)
            .await
            .unwrap();
        let third_current_before_any_writer = third["sampleStatus"] == "current";
        // Record the actual pre-writer outcome before releasing old blocked readers, even on the failing implementation.
        let observed = (finished_before_any_writer, third_current_before_any_writer);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tasks.iter().any(|task| !task.is_finished()) && tokio::time::Instant::now() < deadline
        {
            for pipe in &pipes {
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(pipe);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for task in tasks {
            let _ = tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            observed,
            (true, true),
            "non-regular AGENTS files occupied bounded local-read slots until a writer arrived"
        );
    }
    #[tokio::test]
    async fn context_invalid_saved_model_keeps_public_target_bounded_and_metrics_unavailable() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        for model in [
            "PRIVATE-INVALID-TARGET".repeat(20),
            "PRIVATE\nMODEL".into(),
            "PRIVATE\u{7f}MODEL".into(),
        ] {
            let (data, workspace, manager, id, _) = setup(true).await;
            let engine = super::super::engine_session_id(&id).unwrap();
            crate::v4_agent::context::corrupt_saved_model(
                data.path(),
                "owner",
                workspace.path(),
                &engine,
                &model,
            );
            let result = manager.context_snapshot("owner", &id).await.unwrap();
            assert_eq!(result["sampleStatus"], "unavailable");
            assert!(result["usage"].is_null());
            assert!(result["conversationRevision"].is_null());
            let public_model = result["model"].as_str().unwrap();
            assert!(public_model.len() <= 200 && !public_model.chars().any(char::is_control));
            assert!(!result.to_string().contains("PRIVATE"));
        }
    }
    fn poison_authority(state: &mut super::super::StructuredSessionState, case: &str) {
        state.retiring = true;
        match case {
            "provider_length" => state.provider = "p".repeat(121),
            "provider_control" => state.provider = "deepseek\u{7}".into(),
            "model_length" => state.model = Some("m".repeat(201)),
            "model_control" => state.model = Some("model\u{1b}".into()),
            "reasoning_length" => state.reasoning = Some("r".repeat(33)),
            "reasoning_control" => state.reasoning = Some("high\n".into()),
            "cwd_length" => state.cwd = format!("/{}", "w".repeat(2048)),
            "cwd_relative" => state.cwd = "relative/workspace".into(),
            "cwd_control" => state.cwd = "/tmp/control\u{7f}".into(),
            _ => panic!("unknown fixture"),
        }
    }
    #[tokio::test]
    async fn context_hot_and_post_worker_authority_metadata_bounds_fail_closed() {
        let _test = CONTEXT_READ_TESTS.lock().await;
        for post_worker in [false, true] {
            for case in [
                "provider_length",
                "provider_control",
                "model_length",
                "model_control",
                "reasoning_length",
                "reasoning_control",
                "cwd_length",
                "cwd_relative",
                "cwd_control",
            ] {
                let (_data, _workspace, manager, id, _) = setup(true).await;
                let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
                let result = if post_worker {
                    let (entered, wait) = tokio::sync::oneshot::channel();
                    let (release, blocked) = std::sync::mpsc::channel();
                    *live.context_reads.barrier.lock().unwrap() = Some((entered, blocked));
                    let task = tokio::spawn({
                        let manager = manager.clone();
                        let id = id.clone();
                        async move { manager.context_snapshot("owner", &id).await }
                    });
                    wait.await.unwrap();
                    {
                        let mut state = live.state.lock().await;
                        state.generation += 1;
                        poison_authority(&mut state, case);
                    }
                    release.send(()).unwrap();
                    task.await.unwrap()
                } else {
                    {
                        let mut state = live.state.lock().await;
                        poison_authority(&mut state, case);
                    }
                    manager.context_snapshot("owner", &id).await
                };
                let error = result
                    .expect_err("invalid authority metadata must not enter any public DTO path");
                assert_eq!(error.code, "unavailable", "{case} postworker={post_worker}");
                assert!(error.message.len() < 500);
            }
        }
    }
}
