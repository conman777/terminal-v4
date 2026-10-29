//! An admitted request owns its dedicated runtime and OS thread until join.
use super::*;
use crate::leases::{
    AdmissionOrigin, ConsumerKind, LeaseError, LeaseResult, OwnedRunningResource, StartOutcome,
    StartOwnedResource,
};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use std::{collections::VecDeque, sync::Mutex, thread::JoinHandle, time::Duration};
use tokio_util::sync::CancellationToken;

const MAX_BUFFER_BYTES: usize = 1_048_576;
const MAX_BUFFER_EVENTS: usize = 32;
const CHUNK_BYTES: usize = 65_536;
enum Event {
    Head(bool),
    Chunk(Vec<u8>),
}
struct State {
    queue: VecDeque<Event>,
    queued_bytes: usize,
    outcome: Option<std::result::Result<(), InferenceFailure>>,
}
struct Shared {
    state: Mutex<State>,
    ready: AtomicBool,
    joined: AtomicBool,
    cancel: CancellationToken,
}
pub(crate) struct Reader(Arc<Shared>);
impl Reader {
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.0.cancel.clone()
    }
    pub(crate) fn request_cancel(&self) {
        self.0.cancel.cancel();
    }
    pub(crate) fn ready(&self) -> bool {
        self.0.ready.load(Ordering::Acquire)
    }
    pub(crate) fn outcome(&self) -> LeaseResult<Option<std::result::Result<(), InferenceFailure>>> {
        Ok(self
            .0
            .state
            .lock()
            .map_err(|_| LeaseError::PersistenceFailed)?
            .outcome)
    }
    pub(crate) fn next(&self) -> LeaseResult<Option<InferencePoll>> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| LeaseError::PersistenceFailed)?;
        Ok(state.queue.pop_front().map(|event| match event {
            Event::Head(streaming) => InferencePoll::Head { streaming },
            Event::Chunk(bytes) => {
                state.queued_bytes -= bytes.len();
                InferencePoll::Chunk(bytes)
            }
        }))
    }
    pub(crate) fn discard(&self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.queue.clear();
        state.queued_bytes = 0;
    }
}

pub(crate) struct Action {
    origin: AdmissionOrigin,
    plan: InferencePlan,
    consumer: ConsumerKind,
    body: Vec<u8>,
    authorization: ResolvedAuthorization,
    timeout: Duration,
    shared: Arc<Shared>,
}
impl Action {
    pub(crate) fn prepare(
        origin: AdmissionOrigin,
        plan: &InferencePlan,
        consumer: ConsumerKind,
        body: Vec<u8>,
        authorization: ResolvedAuthorization,
        timeout: Duration,
    ) -> crate::Result<(Self, Reader)> {
        if !(Duration::from_millis(50)..=Duration::from_secs(120)).contains(&timeout)
            || consumer == ConsumerKind::Discovery
            || InferencePlan::prepare(&plan.snapshot, plan.model())? != *plan
        {
            return Err(Error::InvalidInput);
        }
        // The only factory supplies encoded bytes after validating the exact model.
        let value: Value = serde_json::from_slice(&body).map_err(|_| Error::InvalidInput)?;
        if plan.encode_request(&value)? != body {
            return Err(Error::InvalidInput);
        }
        match (&plan.snapshot.auth, &authorization) {
            (StoredAuth::None, ResolvedAuthorization::None) => {}
            (StoredAuth::Bearer(_), ResolvedAuthorization::Bearer(secret)) => {
                let endpoint = canonical_target(plan.snapshot.kind, &plan.snapshot.base_url)?;
                discovery::config::validate_new_key(
                    &endpoint,
                    discovery::AuthMode::ApiKey,
                    secret.expose_for_adapter(),
                )
                .map_err(|_| Error::InvalidCredential)?;
            }
            _ => return Err(Error::CredentialBindingMismatch),
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                queued_bytes: 0,
                outcome: None,
            }),
            ready: AtomicBool::new(false),
            joined: AtomicBool::new(false),
            cancel: CancellationToken::new(),
        });
        Ok((
            Self {
                origin,
                plan: plan.clone(),
                consumer,
                body,
                authorization,
                timeout,
                shared: shared.clone(),
            },
            Reader(shared),
        ))
    }
}
impl StartOwnedResource for Action {
    fn validate_for_admission(
        &self,
        origin: &AdmissionOrigin,
        snapshot: &EffectiveConnection,
        consumer: ConsumerKind,
    ) -> LeaseResult<()> {
        if !self.origin.same_origin(origin)
            || self.plan.snapshot != *snapshot
            || self.consumer != consumer
        {
            return Err(LeaseError::ConfigurationChanged);
        }
        Ok(())
    }
    fn start(self: Box<Self>) -> StartOutcome {
        let Self {
            plan,
            body,
            authorization,
            timeout,
            shared,
            ..
        } = *self;
        let cancel = shared.cancel.clone();
        let worker_cancel = cancel.clone();
        let worker_shared = shared.clone();
        let thread=std::thread::Builder::new().name("v4-profile-inference".into()).spawn(move||{
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
                let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|InferenceFailure::WorkerUnavailable)?;
                let result=runtime.block_on(async {
                    tokio::select!{biased;
                        _=worker_cancel.cancelled()=>Err(InferenceFailure::Cancelled),
                        result=tokio::time::timeout(timeout,exchange(&plan,body,authorization,timeout,&worker_shared))=>result.unwrap_or(Err(InferenceFailure::Timeout)),
                    }
                });
                drop(runtime);result
            })).unwrap_or(Err(InferenceFailure::WorkerPanicked));
            let mut state=worker_shared.state.lock().unwrap_or_else(|e|e.into_inner());
            if result.is_err(){state.queue.clear();state.queued_bytes=0;}
            state.outcome=Some(result);drop(state);worker_shared.ready.store(true,Ordering::Release);
        });
        match thread {
            Ok(thread) => StartOutcome::Started(Box::new(Owner {
                cancel,
                thread: Some(thread),
                shared,
                no_thread_created: false,
            })),
            Err(_) => {
                let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                state.outcome = Some(Err(InferenceFailure::WorkerUnavailable));
                drop(state);
                shared.ready.store(true, Ordering::Release);
                StartOutcome::FailedOwned {
                    error: LeaseError::HandoffFailed,
                    owner: Box::new(Owner {
                        cancel,
                        thread: None,
                        shared,
                        no_thread_created: true,
                    }),
                }
            }
        }
    }
}
struct Owner {
    cancel: CancellationToken,
    thread: Option<JoinHandle<()>>,
    shared: Arc<Shared>,
    no_thread_created: bool,
}
impl OwnedRunningResource for Owner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        self.cancel.cancel();
        if let Some(thread) = &self.thread {
            if !thread.is_finished() {
                return Err(LeaseError::ResourceStopPending);
            }
        } else if !self.no_thread_created && !self.shared.joined.load(Ordering::Acquire) {
            return Err(LeaseError::ResourceStopPending);
        }
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
                state.outcome = Some(Err(InferenceFailure::WorkerPanicked));
                state.queue.clear();
                state.queued_bytes = 0;
                self.shared.ready.store(true, Ordering::Release);
            }
        }
        self.shared.joined.store(true, Ordering::Release);
        Ok(())
    }
}
async fn enqueue(shared: &Shared, event: Event) -> std::result::Result<(), InferenceFailure> {
    let size = match &event {
        Event::Chunk(bytes) => bytes.len(),
        _ => 0,
    };
    loop {
        {
            let mut state = shared
                .state
                .lock()
                .map_err(|_| InferenceFailure::WorkerPanicked)?;
            if state.queue.len() < MAX_BUFFER_EVENTS
                && size <= MAX_BUFFER_BYTES - state.queued_bytes
            {
                state.queued_bytes += size;
                state.queue.push_back(event);
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
fn classify(error: reqwest::Error) -> InferenceFailure {
    if error.is_timeout() {
        InferenceFailure::Timeout
    } else {
        InferenceFailure::Transport
    }
}
async fn exchange(
    plan: &InferencePlan,
    body: Vec<u8>,
    authorization: ResolvedAuthorization,
    timeout: Duration,
    shared: &Shared,
) -> std::result::Result<(), InferenceFailure> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| InferenceFailure::Transport)?;
    let mut request = client
        .post(&plan.url)
        .header(ACCEPT, "text/event-stream, application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(body);
    if let ResolvedAuthorization::Bearer(secret) = &authorization {
        let text = zeroize::Zeroizing::new(format!("Bearer {}", secret.expose_for_adapter()));
        let mut header = HeaderValue::from_str(&text).map_err(|_| InferenceFailure::Transport)?;
        header.set_sensitive(true);
        request = request.header(AUTHORIZATION, header);
    }
    if let Some(cluster) = &plan.snapshot.cluster_id {
        request = request.header("X-Cluster-ID", cluster);
    }
    let mut response = request.send().await.map_err(classify)?;
    if response.url().as_str() != plan.request_url() {
        return Err(InferenceFailure::Transport);
    }
    if !response.status().is_success() {
        return Err(InferenceFailure::HttpStatus(response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let streaming = content_type == "text/event-stream";
    if !streaming
        && content_type != "application/json"
        && !(content_type.starts_with("application/") && content_type.ends_with("+json"))
    {
        return Err(InferenceFailure::ContentType);
    }
    let limit = if streaming { 16_000_000 } else { 8_000_000 };
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(InferenceFailure::ResponseTooLarge);
    }
    enqueue(shared, Event::Head(streaming)).await?;
    let mut received = 0;
    while let Some(chunk) = response.chunk().await.map_err(classify)? {
        if chunk.len() > limit - received {
            return Err(InferenceFailure::ResponseTooLarge);
        }
        received += chunk.len();
        for bytes in chunk.chunks(CHUNK_BYTES) {
            enqueue(shared, Event::Chunk(bytes.to_vec())).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
