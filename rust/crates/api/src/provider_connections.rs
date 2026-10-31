//! Original authenticated provider-profile API and retained discovery supervisor.
use crate::{auth::AuthenticatedUser, state::AppState};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use terminal_v4_provider_connections::{ConnectionError, ConnectionService};
use tokio::sync::oneshot;
pub mod inference;
pub use crate::auth::AuthenticatedUser as ExecutionAccount;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/connections", get(profiles))
        .route("/api/agent/connections/{profile}", put(save).delete(delete))
        .route(
            "/api/agent/connections/{profile}/operations/{operation}",
            get(operation),
        )
        .route(
            "/api/agent/connections/{profile}/discoveries",
            post(discover),
        )
        .route("/api/agent/connection-discoveries/{request}", get(job))
        .route(
            "/api/agent/connections/{profile}/discoveries/{request}/cancel",
            post(cancel),
        )
        .layer(DefaultBodyLimit::max(65_536))
}
#[derive(Clone)]
pub struct ProviderConnectionManager {
    lifetime: Arc<Lifetime>,
}
struct Lifetime {
    sender: SyncSender<Message>,
    accepting: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    queued_input_bytes: Arc<AtomicUsize>,
    draining: Arc<AtomicBool>,
    #[cfg(test)]
    profile_enqueued: Mutex<Option<mpsc::Sender<()>>>,
}
enum Operation {
    Inference(inference::Operation),
    Profiles,
    ProfilesWithPublishedInventory,
    Put { profile: String, body: Value },
    Delete { profile: String, body: Value },
    Configuration { profile: String, operation: String },
    Discover { profile: String, request: String },
    Job { request: String },
    Cancel { profile: String, request: String },
}
enum Message {
    #[cfg(test)]
    Pause {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    },
    Execute {
        owner: String,
        operation: Operation,
        reply: oneshot::Sender<Result<Reply, ConnectionError>>,
    },
    Wake,
}
enum Reply {
    Json(Value),
    Inference(inference::Reply),
}
fn now_ms() -> Result<u64, ConnectionError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .ok_or(ConnectionError::StorageUnavailable)
}
impl ProviderConnectionManager {
    pub(crate) fn request_drain(&self) {
        self.lifetime.draining.store(true, Ordering::Release);
        let _ = self.lifetime.sender.try_send(Message::Wake);
    }
    pub(crate) async fn public_profiles_with_published_inventory(
        &self,
        account: &ExecutionAccount,
    ) -> Result<Value, ConnectionError> {
        self.execute(account, Operation::ProfilesWithPublishedInventory)
            .await
    }
    pub fn new(data_dir: &FsPath) -> Result<Self, String> {
        let canonical = data_dir
            .canonicalize()
            .map_err(|_| "Provider data directory is unavailable")?;
        let environment = format!(
            "v4-local-{}",
            hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()))
        );
        let root = canonical.join("provider-connections");
        let (sender, receiver) = mpsc::sync_channel(128);
        let accepting = Arc::new(AtomicBool::new(true));
        let stopped = Arc::new(AtomicBool::new(false));
        let draining = Arc::new(AtomicBool::new(false));
        let worker_draining = draining.clone();
        let (worker_accepting, worker_stopped) = (accepting.clone(), stopped.clone());
        let thread = std::thread::Builder::new()
            .name("v4-provider-connections".into())
            .spawn(move || {
                supervise(
                    root,
                    environment,
                    receiver,
                    worker_accepting,
                    worker_stopped,
                    worker_draining,
                )
            })
            .map_err(|_| "Provider discovery supervisor could not start")?;
        Ok(Self {
            lifetime: Arc::new(Lifetime {
                sender,
                accepting,
                stopped,
                thread: Mutex::new(Some(thread)),
                queued_input_bytes: Arc::new(AtomicUsize::new(0)),
                draining,
                #[cfg(test)]
                profile_enqueued: Mutex::new(None),
            }),
        })
    }
    async fn execute(
        &self,
        user: &AuthenticatedUser,
        operation: Operation,
    ) -> Result<Value, ConnectionError> {
        match self.execute_for_owner(&user.user_id, operation).await? {
            Reply::Json(value) => Ok(value),
            Reply::Inference(_) => Err(ConnectionError::StorageUnavailable),
        }
    }
    async fn execute_for_owner(
        &self,
        owner: &str,
        operation: Operation,
    ) -> Result<Reply, ConnectionError> {
        self.enqueue(owner, operation)?
            .await
            .map_err(|_| ConnectionError::StorageUnavailable)?
    }
    fn enqueue(
        &self,
        owner: &str,
        operation: Operation,
    ) -> Result<oneshot::Receiver<Result<Reply, ConnectionError>>, ConnectionError> {
        #[cfg(test)]
        let profile_lookup = matches!(operation, Operation::ProfilesWithPublishedInventory);
        if !self.lifetime.accepting.load(Ordering::Acquire) {
            return Err(ConnectionError::StorageUnavailable);
        }
        let (reply, received) = oneshot::channel();
        self.lifetime
            .sender
            .try_send(Message::Execute {
                owner: owner.into(),
                operation,
                reply,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => ConnectionError::CapacityReached,
                mpsc::TrySendError::Disconnected(_) => ConnectionError::StorageUnavailable,
            })?;
        #[cfg(test)]
        if profile_lookup {
            if let Some(sender) = self.lifetime.profile_enqueued.lock().unwrap().take() {
                let _ = sender.send(());
            }
        }
        Ok(received)
    }

    #[cfg(test)]
    pub(crate) fn pause_profile_lookup_for_test(&self) -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (enqueued_tx, enqueued) = mpsc::channel();
        *self.lifetime.profile_enqueued.lock().unwrap() = Some(enqueued_tx);
        self.lifetime
            .sender
            .try_send(Message::Pause {
                entered: entered_tx,
                release: release_rx,
            })
            .unwrap();
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        (release, enqueued)
    }
    pub async fn shutdown(&self) -> bool {
        self.lifetime.accepting.store(false, Ordering::Release);
        let _ = self.lifetime.sender.try_send(Message::Wake);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !self.lifetime.stopped.load(Ordering::Acquire) {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        true
    }
}
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.accepting.store(false, Ordering::Release);
        let _ = self.sender.try_send(Message::Wake);
        let deadline = Instant::now() + Duration::from_millis(250);
        let thread = self
            .thread
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(thread) = thread {
            while !thread.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
            // Otherwise the supervisor thread itself keeps every original owner
            // and continues cancellation/cleanup. Dropping this JoinHandle does
            // not drop its services or claim that durable cleanup was confirmed.
        }
    }
}
#[cfg(unix)]
fn private_base(path: &FsPath) -> Result<(), ConnectionError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let created = match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(ConnectionError::StorageUnavailable),
    };
    if created {
        use std::os::unix::fs::OpenOptionsExt;
        let parent = path.parent().ok_or(ConnectionError::StorageUnavailable)?;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| ConnectionError::StorageUnavailable)?;
    }
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| ConnectionError::StorageUnavailable)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o7777 != 0o700
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(ConnectionError::StorageUnavailable);
    }
    Ok(())
}
#[cfg(not(unix))]
fn private_base(_: &FsPath) -> Result<(), ConnectionError> {
    Err(ConnectionError::StorageUnavailable)
}
fn perform(
    service: &mut ConnectionService,
    operation: Operation,
    draining: bool,
) -> Result<Reply, ConnectionError> {
    let operation = if draining {
        match operation {
            Operation::Inference(inference::Operation::Begin { .. }) => {
                return Ok(Reply::Inference(inference::no_dispatch(
                    ConnectionError::CleanupPending,
                )))
            }
            Operation::Put { .. } | Operation::Delete { .. } | Operation::Discover { .. } => {
                return Err(ConnectionError::CleanupPending)
            }
            operation => operation,
        }
    } else {
        operation
    };
    let result = match operation {
        Operation::Inference(operation) => {
            return inference::perform(service, operation).map(Reply::Inference)
        }
        Operation::Profiles => service
            .profiles()
            .map(|profiles| json!({"profiles":profiles})),
        Operation::ProfilesWithPublishedInventory => service
            .profiles_with_published_inventory()
            .map(|profiles| json!({"profiles":profiles})),
        Operation::Put { profile, body } => service.put(&profile, &body),
        Operation::Delete { profile, body } => service.delete(&profile, &body),
        Operation::Configuration { profile, operation } => service.operation(&profile, &operation),
        Operation::Discover { profile, request } => service.discover(&profile, &request, now_ms()?),
        Operation::Job { request } => service.job(&request),
        Operation::Cancel { profile, request } => service.cancel(&profile, &request, now_ms()?),
    };
    result.map(Reply::Json)
}
fn supervise(
    root: PathBuf,
    environment: String,
    receiver: Receiver<Message>,
    accepting: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
) {
    // This one actor owns every service. Request cancellation cannot drop an
    // original HTTP owner; detached reply channels only discard the response.
    let mut services = HashMap::<String, ConnectionService>::new();
    let mut shutdown_requested = false;
    let mut warned = false;
    loop {
        if !accepting.load(Ordering::Acquire) {
            shutdown_requested = true;
        }
        if shutdown_requested {
            let mut local_stopped = true;
            for service in services.values_mut() {
                // Retry cancellation after transient failures. An unwind must
                // retain the service and its original resource owners here.
                let report = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let now = now_ms()?;
                    service.request_shutdown(now)?;
                    service.tick(now)
                }));
                local_stopped &= matches!(report, Ok(Ok(report)) if report.local_resources_stopped);
            }
            if local_stopped {
                stopped.store(true, Ordering::Release);
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
            continue;
        }
        if draining.load(Ordering::Acquire) {
            for service in services.values_mut() {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    now_ms().and_then(|now| service.request_shutdown(now))
                }));
                if !matches!(result, Ok(Ok(()))) && !warned {
                    tracing::warn!(
                        "Provider drain retained original resources after a storage error"
                    );
                    warned = true;
                }
            }
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            #[cfg(test)]
            Ok(Message::Pause { entered, release }) => {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            Ok(Message::Execute {
                owner,
                operation,
                reply,
            }) => {
                let result = if reply.is_closed() {
                    None
                } else {
                    Some(if !accepting.load(Ordering::Acquire) {
                        Err(ConnectionError::StorageUnavailable)
                    } else {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            if !services.contains_key(&owner) {
                                if services.len() >= 128 {
                                    return Err(ConnectionError::CapacityReached);
                                }
                                private_base(&root)?;
                                let private =
                                    root.join(hex::encode(Sha256::digest(owner.as_bytes())));
                                let service = ConnectionService::open_for_authenticated_execution(
                                    &private,
                                    &owner,
                                    &environment,
                                )?;
                                services.insert(owner.clone(), service);
                            }
                            perform(
                                services
                                    .get_mut(&owner)
                                    .ok_or(ConnectionError::StorageUnavailable)?,
                                operation,
                                draining.load(Ordering::Acquire),
                            )
                        }))
                        .unwrap_or(Err(ConnectionError::StorageUnavailable))
                    })
                };
                if let Some(result) = result {
                    let _ = reply.send(result);
                }
            }
            Ok(Message::Wake) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                accepting.store(false, Ordering::Release);
                continue;
            }
        }
        // Tick after messages as well as timeouts so a busy client cannot starve
        // completion, revocation, cancellation or original-resource cleanup.
        for service in services.values_mut() {
            let report = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                now_ms().and_then(|now| service.tick(now))
            }));
            if !matches!(report, Ok(Ok(_))) && !warned {
                tracing::warn!("Provider discovery supervisor retained pending cleanup after a storage or worker error");
                warned = true;
            }
        }
    }
}
struct ConnectionApiError(ConnectionError);
impl From<ConnectionError> for ConnectionApiError {
    fn from(value: ConnectionError) -> Self {
        Self(value)
    }
}
impl IntoResponse for ConnectionApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self.0 {
            ConnectionError::InvalidInput => {
                (StatusCode::BAD_REQUEST, "Connection settings are invalid.")
            }
            ConnectionError::NotFound => (
                StatusCode::NOT_FOUND,
                "Connection or discovery job was not found.",
            ),
            ConnectionError::Conflict => (
                StatusCode::CONFLICT,
                "Connection settings changed. Refresh and try again.",
            ),
            ConnectionError::CleanupPending => (
                StatusCode::CONFLICT,
                "V4 is waiting for the previous connection work to stop.",
            ),
            ConnectionError::CapacityReached => (
                StatusCode::TOO_MANY_REQUESTS,
                "The provider connection or discovery limit has been reached.",
            ),
            ConnectionError::StorageUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Provider connection storage is unavailable. Saved keys have not been replaced.",
            ),
        };
        (
            status,
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(json!({"code":self.0.code(),"error":message})),
        )
            .into_response()
    }
}
type ApiResult = Result<([(header::HeaderName, &'static str); 1], Json<Value>), ConnectionApiError>;
fn response(result: Result<Value, ConnectionError>) -> ApiResult {
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(result?),
    ))
}
async fn profiles(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(&user, Operation::Profiles)
            .await,
    )
}
async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(profile): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(&user, Operation::Put { profile, body })
            .await,
    )
}
async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(profile): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(&user, Operation::Delete { profile, body })
            .await,
    )
}
async fn operation(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((profile, operation)): Path<(String, String)>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(&user, Operation::Configuration { profile, operation })
            .await,
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscoverInput {
    request_id: String,
}
async fn discover(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(profile): Path<String>,
    Json(input): Json<DiscoverInput>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(
                &user,
                Operation::Discover {
                    profile,
                    request: input.request_id,
                },
            )
            .await,
    )
}
async fn job(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(request): Path<String>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(&user, Operation::Job { request })
            .await,
    )
}
async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path((profile, request)): Path<(String, String)>,
) -> ApiResult {
    response(
        state
            .provider_connections()
            .execute(&user, Operation::Cancel { profile, request })
            .await,
    )
}
#[cfg(test)]
mod tests;
