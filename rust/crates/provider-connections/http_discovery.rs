//! Own HTTP discovery owner. Preparation and Drop perform no I/O.
#![cfg_attr(not(test), allow(dead_code))]
use crate::discovery::{self, DiscoveryPlan, InventoryKind, InventoryReceipt};
use crate::leases::{
    AdmissionOrigin, ConsumerKind, LeaseError, LeaseResult, OwnedRunningResource, StartOutcome,
    StartOwnedResource,
};
use crate::{EffectiveConnection, ResolvedAuthorization};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HttpFailure {
    Cancelled,
    Transport,
    Timeout,
    Status,
    ContentType,
    BodyTooLarge,
    WorkerUnavailable,
    WorkerPanicked,
}
pub(crate) struct HttpOutcome {
    pub(crate) plan: DiscoveryPlan,
    pub(crate) receipts: Vec<InventoryReceipt>,
    pub(crate) attempted_requests: usize,
    pub(crate) failure: Option<HttpFailure>,
}
struct Shared {
    outcome: Mutex<Option<HttpOutcome>>,
    joined: AtomicBool,
    outcome_ready: AtomicBool,
    attempts: AtomicUsize,
}
// A reader cannot cancel, start, mint a lease/stop fact, or observe bodies before join.
pub(crate) struct OutcomeReader(Arc<Shared>);
impl OutcomeReader {
    // Scheduling hint only. It never substitutes for the original owner's join.
    pub(crate) fn outcome_ready(&self) -> bool {
        self.0.outcome_ready.load(Ordering::Acquire)
    }
    // Destruction grants no publication authority. A poisoned slot can still be
    // discarded after the original owner joined, without exposing its contents.
    pub(crate) fn discard_after_join(&self) -> LeaseResult<()> {
        if !self.0.joined.load(Ordering::Acquire) {
            return Err(LeaseError::ResourceStopPending);
        }
        match self.0.outcome.lock() {
            Ok(mut slot) => {
                slot.take();
            }
            Err(error) => {
                error.into_inner().take();
            }
        }
        Ok(())
    }
    pub(crate) fn take_after_join(&self) -> LeaseResult<Option<HttpOutcome>> {
        if !self.0.joined.load(Ordering::Acquire) {
            return Err(LeaseError::ResourceStopPending);
        }
        Ok(self
            .0
            .outcome
            .lock()
            .map_err(|_| LeaseError::PersistenceFailed)?
            .take())
    }
}
pub(crate) struct HttpDiscoveryAction {
    origin: AdmissionOrigin,
    snapshot: EffectiveConnection,
    plan: DiscoveryPlan,
    authorization: ResolvedAuthorization,
    timeout: Duration,
    shared: Arc<Shared>,
}
impl HttpDiscoveryAction {
    // Trusted adapter input only. The authenticated factory must obtain this
    // authorization from the exact stored binding, then Coordinator::admit
    // revalidates the snapshot before this action may enter start().
    pub(crate) fn prepare(
        origin: AdmissionOrigin,
        snapshot: &EffectiveConnection,
        authorization: ResolvedAuthorization,
        timeout: Duration,
    ) -> crate::Result<(Self, OutcomeReader)> {
        let plan = crate::runtime::discovery_plan(snapshot)?;
        if !(Duration::from_millis(50)..=Duration::from_secs(60)).contains(&timeout) {
            return Err(crate::Error::InvalidInput);
        }
        match (&snapshot.auth, &authorization) {
            (crate::StoredAuth::None, ResolvedAuthorization::None) => {}
            (crate::StoredAuth::Bearer(_), ResolvedAuthorization::Bearer(secret)) => {
                let endpoint = crate::canonical_target(snapshot.kind, &snapshot.base_url)?;
                discovery::config::validate_new_key(
                    &endpoint,
                    discovery::AuthMode::ApiKey,
                    secret.expose_for_adapter(),
                )
                .map_err(|_| crate::Error::InvalidCredential)?;
            }
            _ => return Err(crate::Error::CredentialBindingMismatch),
        }
        let shared = Arc::new(Shared {
            outcome: Mutex::new(None),
            joined: AtomicBool::new(false),
            outcome_ready: AtomicBool::new(false),
            attempts: AtomicUsize::new(0),
        });
        Ok((
            Self {
                origin,
                snapshot: snapshot.clone(),
                plan,
                authorization,
                timeout,
                shared: shared.clone(),
            },
            OutcomeReader(shared),
        ))
    }
}
struct HttpOwner {
    cancel: CancellationToken,
    thread: Option<JoinHandle<()>>,
    shared: Arc<Shared>,
    plan: DiscoveryPlan,
    no_thread_created: bool,
}
impl StartOwnedResource for HttpDiscoveryAction {
    fn validate_for_admission(
        &self,
        origin: &AdmissionOrigin,
        snapshot: &EffectiveConnection,
        consumer: ConsumerKind,
    ) -> LeaseResult<()> {
        if !self.origin.same_origin(origin)
            || self.snapshot != *snapshot
            || consumer != ConsumerKind::Discovery
            || crate::runtime::discovery_plan(snapshot)
                .map_err(|_| LeaseError::ConfigurationChanged)?
                != self.plan
        {
            return Err(LeaseError::ConfigurationChanged);
        }
        Ok(())
    }
    fn start(self: Box<Self>) -> StartOutcome {
        let Self {
            origin: _,
            snapshot: _,
            plan,
            authorization,
            timeout,
            shared,
        } = *self;
        let cancel = CancellationToken::new();
        let worker_cancel = cancel.clone();
        let worker_shared = shared.clone();
        let worker_plan = plan.clone();
        // DNS, client creation and socket I/O occur only inside this admitted owner.
        let thread = std::thread::Builder::new().name("v4-model-discovery".into()).spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
                match runtime {
                    Ok(runtime) => {
                        // Dropping this dedicated runtime cancels its remaining
                        // async tasks and waits for its own blocking tasks. The OS
                        // thread cannot report joined while that work remains.
                        let result = runtime.block_on(async {
                            tokio::select! {
                                biased;
                                _ = worker_cancel.cancelled() => failure(&worker_plan, &worker_shared, HttpFailure::Cancelled),
                                result = fetch_inventory(&worker_plan, authorization, timeout, &worker_shared) => result,
                            }
                        });
                        drop(runtime);
                        result
                    }
                    Err(_) => failure(&worker_plan, &worker_shared, HttpFailure::WorkerUnavailable),
                }
            })).unwrap_or_else(|_| failure(&worker_plan, &worker_shared, HttpFailure::WorkerPanicked));
            if let Ok(mut slot) = worker_shared.outcome.lock() { *slot = Some(outcome); }
            worker_shared.outcome_ready.store(true, Ordering::Release);
        });
        match thread {
            Ok(thread) => StartOutcome::Started(Box::new(HttpOwner {
                cancel,
                thread: Some(thread),
                shared,
                plan,
                no_thread_created: false,
            })),
            Err(_) => {
                if let Ok(mut slot) = shared.outcome.lock() {
                    *slot = Some(failure(&plan, &shared, HttpFailure::WorkerUnavailable));
                }
                shared.outcome_ready.store(true, Ordering::Release);
                StartOutcome::FailedOwned {
                    error: LeaseError::HandoffFailed,
                    owner: Box::new(HttpOwner {
                        cancel,
                        thread: None,
                        shared,
                        plan,
                        no_thread_created: true,
                    }),
                }
            }
        }
    }
}
impl OwnedRunningResource for HttpOwner {
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
                let mut slot = self
                    .shared
                    .outcome
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                *slot = Some(failure(
                    &self.plan,
                    &self.shared,
                    HttpFailure::WorkerPanicked,
                ));
            }
        }
        self.shared.joined.store(true, Ordering::Release);
        Ok(())
    }
}
// No custom Drop: losing a supervisor does not cancel, join, ACK, or fabricate
// quiescence. Coordinator must retain the original owner through cleanup retries.
fn failure(plan: &DiscoveryPlan, shared: &Shared, error: HttpFailure) -> HttpOutcome {
    HttpOutcome {
        plan: plan.clone(),
        receipts: vec![],
        attempted_requests: shared.attempts.load(Ordering::Acquire),
        failure: Some(error),
    }
}
fn classify(error: reqwest::Error) -> HttpFailure {
    if error.is_timeout() {
        HttpFailure::Timeout
    } else {
        HttpFailure::Transport
    }
}
async fn fetch_inventory(
    plan: &DiscoveryPlan,
    authorization: ResolvedAuthorization,
    timeout: Duration,
    shared: &Shared,
) -> HttpOutcome {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout)
        .pool_max_idle_per_host(0)
        .build()
    {
        Ok(client) => client,
        Err(_) => return failure(plan, shared, HttpFailure::Transport),
    };
    let mut bearer = None;
    if let ResolvedAuthorization::Bearer(secret) = &authorization {
        let text = zeroize::Zeroizing::new(format!("Bearer {}", secret.expose_for_adapter()));
        let mut header = match HeaderValue::from_str(&text) {
            Ok(header) => header,
            Err(_) => return failure(plan, shared, HttpFailure::Transport),
        };
        header.set_sensitive(true);
        bearer = Some(header);
    }
    let mut receipts = vec![];
    for request in &plan.requests {
        let mut builder = client.get(&request.url).header(ACCEPT, "application/json");
        if let Some(header) = &bearer {
            builder = builder.header(AUTHORIZATION, header.clone());
        }
        if let Some(cluster) = &request.cluster_id {
            // Actual's documented inventory/inference cluster selector.
            builder = builder.header("X-Cluster-ID", cluster);
        }
        shared.attempts.fetch_add(1, Ordering::AcqRel);
        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                if request.kind == InventoryKind::LmStudioMetadata {
                    break;
                }
                return failure(plan, shared, classify(error));
            }
        };
        let body = read_response(response, &request.url).await;
        match body {
            Ok(body) => receipts.push(InventoryReceipt {
                binding: plan.binding.clone(),
                kind: request.kind,
                effective_url: request.url.clone(),
                body,
            }),
            Err(error) => {
                if request.kind == InventoryKind::LmStudioMetadata {
                    break;
                }
                return failure(plan, shared, error);
            }
        }
    }
    HttpOutcome {
        plan: plan.clone(),
        receipts,
        attempted_requests: shared.attempts.load(Ordering::Acquire),
        failure: None,
    }
}
async fn read_response(
    mut response: reqwest::Response,
    expected_url: &str,
) -> Result<Vec<u8>, HttpFailure> {
    if response.url().as_str() != expected_url || !response.status().is_success() {
        return Err(HttpFailure::Status);
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
    if content_type != "application/json"
        && !(content_type.starts_with("application/") && content_type.ends_with("+json"))
    {
        return Err(HttpFailure::ContentType);
    }
    if response
        .content_length()
        .is_some_and(|bytes| bytes > discovery::MAX_RESPONSE_BYTES as u64)
    {
        return Err(HttpFailure::BodyTooLarge);
    }
    let mut body = vec![];
    while let Some(chunk) = response.chunk().await.map_err(classify)? {
        if chunk.len() > discovery::MAX_RESPONSE_BYTES - body.len() {
            return Err(HttpFailure::BodyTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests;
