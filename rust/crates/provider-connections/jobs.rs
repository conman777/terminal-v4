use crate::*;
use serde_json::{json, Value};
use std::sync::Arc;

pub const MAX_JOBS_PER_SCOPE: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobKey {
    scope: Scope,
    profile_id: String,
    request_id: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    Empty,
    Failed,
    Cancelled,
    Stale,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IoState {
    NeverStarted,
    Active,
    Unconfirmed,
    Quiescent,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    binding: discovery::DiscoveryBinding,
    request_count: usize,
    model_count: usize,
    inference_verified: bool,
    metadata_unavailable: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobFailureReason {
    ServerRestarted,
    InventoryRejected,
    ConfigurationChanged,
    TransportNotStopped,
    AdmissionRejected,
    CapacityReached,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    key: JobKey,
    snapshot: Option<EffectiveConnection>,
    plan: Option<discovery::DiscoveryPlan>,
    status: Status,
    io: IoState,
    cancel_requested: bool,
    created_ms: u64,
    completed_ms: Option<u64>,
    receipt: Option<Receipt>,
    catalog: Option<discovery::ModelCatalog>,
    failure: Option<JobFailureReason>,
    worker_generation: Option<u64>,
}

// Sanitized typed terminal error data, bounded to one record per retained job.
// It cannot authorize publication or reconstruct an executor/lease resource owner.
struct ClosedFailure {
    key: JobKey,
    generation: u64,
    error: Error,
}
// Unresolved I/O routing data only, never observed-stop evidence or a live handle.
// The future executor must retain the original Gate C handle/coordinator resource.
struct PendingIo {
    key: JobKey,
    generation: u64,
}

/// One authoritative state owner. Adapters must serialize all transitions through
/// this instance; detached Job snapshots cannot authorize dispatch/publication.
pub struct JobStore {
    records: Vec<Job>,
    identity: Arc<()>,
    next_generation: u64,
    closed_failures: Vec<ClosedFailure>,
    pending_io: Vec<PendingIo>,
}
impl Default for JobStore {
    fn default() -> Self {
        Self::new()
    }
}
impl JobStore {
    pub fn new() -> Self {
        Self {
            records: vec![],
            identity: Arc::new(()),
            next_generation: 1,
            closed_failures: vec![],
            pending_io: vec![],
        }
    }
}

#[derive(Debug)]
pub struct WorkerPermit {
    key: JobKey,
    generation: u64,
    store_identity: Arc<()>,
}
impl PartialEq for WorkerPermit {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
            && self.generation == other.generation
            && Arc::ptr_eq(&self.store_identity, &other.store_identity)
    }
}
impl Eq for WorkerPermit {}

pub fn begin(
    store: &mut JobStore,
    scope: &Scope,
    snapshot: &EffectiveConnection,
    request_id: &str,
    now_ms: u64,
) -> Result<Job> {
    let jobs = &mut store.records;
    validate_scope(scope)?;
    validate_uuid(request_id)?;
    if snapshot.reference.scope != *scope {
        return Err(Error::InvalidScope);
    }
    let key = JobKey {
        scope: scope.clone(),
        profile_id: snapshot.reference.profile_id.clone(),
        request_id: request_id.to_owned(),
    };
    validate_key(&key)?;
    if let Some(existing) = jobs.iter().find(|job| job.key == key) {
        if existing.snapshot.is_none() && existing.status == Status::Cancelled {
            return Ok(existing.clone());
        }
        if existing.snapshot.as_ref() != Some(snapshot) {
            return Err(Error::DiscoveryConflict);
        }
        return Ok(existing.clone());
    }
    if jobs.iter().filter(|job| &job.key.scope == scope).count() >= MAX_JOBS_PER_SCOPE {
        return Err(Error::JobLimit);
    }
    let plan = runtime::discovery_plan(snapshot)?;
    let job = Job {
        key,
        snapshot: Some(snapshot.clone()),
        plan: Some(plan),
        status: Status::Queued,
        io: IoState::NeverStarted,
        cancel_requested: false,
        created_ms: now_ms,
        completed_ms: None,
        receipt: None,
        catalog: None,
        failure: None,
        worker_generation: None,
    };
    jobs.push(job.clone());
    Ok(job)
}

pub fn cancel(store: &mut JobStore, key: &JobKey, now_ms: u64) -> Result<Job> {
    let jobs = &mut store.records;
    validate_key(key)?;
    if let Some(job) = jobs.iter_mut().find(|job| &job.key == key) {
        if terminal(job.status) {
            return Ok(job.clone());
        }
        job.cancel_requested = true;
        job.catalog = None;
        job.receipt = None;
        if matches!(job.io, IoState::Active | IoState::Unconfirmed) {
            job.status = Status::Cancelling;
        } else {
            job.status = Status::Cancelled;
            job.io = IoState::Quiescent;
            job.completed_ms = Some(now_ms);
        }
        return Ok(job.clone());
    }
    if jobs.iter().filter(|job| job.key.scope == key.scope).count() >= MAX_JOBS_PER_SCOPE {
        return Err(Error::JobLimit);
    }
    let tombstone = Job {
        key: key.clone(),
        snapshot: None,
        plan: None,
        status: Status::Cancelled,
        io: IoState::Quiescent,
        cancel_requested: true,
        created_ms: now_ms,
        completed_ms: Some(now_ms),
        receipt: None,
        catalog: None,
        failure: None,
        worker_generation: None,
    };
    jobs.push(tombstone.clone());
    Ok(tombstone)
}

pub fn dispatch(
    store: &mut JobStore,
    key: &JobKey,
    current: Option<&StoredProfile>,
) -> Result<WorkerPermit> {
    validate_key(key)?;
    let job = store
        .records
        .iter_mut()
        .find(|job| &job.key == key)
        .ok_or(Error::NotFound)?;
    if job.cancel_requested || job.status == Status::Cancelled {
        return Err(Error::DiscoveryCancelled);
    }
    if job.status != Status::Queued || job.io != IoState::NeverStarted {
        return Err(Error::DiscoveryNotRunning);
    }
    let snapshot = validated_snapshot(job)?;
    runtime::dispatch_guard(snapshot, current)?;
    if job.plan.as_ref() != Some(&runtime::discovery_plan(snapshot)?) {
        return Err(Error::InvalidReceipt);
    }
    let generation = store.next_generation;
    let next = generation.checked_add(1).ok_or(Error::CapacityReached)?;
    job.status = Status::Running;
    job.io = IoState::Active;
    job.worker_generation = Some(generation);
    store.next_generation = next;
    store.pending_io.push(PendingIo {
        key: key.clone(),
        generation,
    });
    Ok(WorkerPermit {
        key: key.clone(),
        generation,
        store_identity: store.identity.clone(),
    })
}

pub fn finish(
    store: &mut JobStore,
    permit: &WorkerPermit,
    current: Option<&StoredProfile>,
    receipts: &[discovery::InventoryReceipt],
    attempted_requests: usize,
    transport_quiescent: bool,
    now_ms: u64,
) -> Result<Job> {
    validate_key(&permit.key)?;
    if !Arc::ptr_eq(&store.identity, &permit.store_identity) {
        return Err(Error::StaleResult);
    }
    let index = store
        .records
        .iter()
        .position(|job| job.key == permit.key)
        .ok_or(Error::StaleResult)?;
    // Validate the exact generation before exposing a cached error. This is a
    // read-only failure receipt, never permission to inspect new input or publish.
    if let Some(closed) = store
        .closed_failures
        .iter()
        .find(|closed| closed.key == permit.key && closed.generation == permit.generation)
    {
        let job = &store.records[index];
        if job.worker_generation.is_none() && matches!(job.status, Status::Failed | Status::Stale) {
            return Err(closed.error.clone());
        }
        return Err(Error::StaleResult);
    }
    let job = &store.records[index];
    if job.worker_generation != Some(permit.generation)
        || !matches!(job.status, Status::Running | Status::Cancelling)
        || job.io != IoState::Active
        || !store
            .pending_io
            .iter()
            .any(|pending| pending.key == permit.key && pending.generation == permit.generation)
    {
        return Err(Error::StaleResult);
    }
    // The mutable authoritative store is the current pure CAS boundary. A real
    // executor must retain its original resource/lease association through this
    // call, errors and actual cancel/join. No bool is new physical stop evidence.
    match complete(
        job,
        current,
        receipts,
        attempted_requests,
        transport_quiescent,
        now_ms,
    ) {
        Ok(mut completed) => {
            if terminal(completed.status) {
                completed.worker_generation = None;
                store.pending_io.retain(|pending| pending.key != permit.key);
            }
            store.records[index] = completed.clone();
            Ok(completed)
        }
        Err(error) => {
            let job = &mut store.records[index];
            job.status = if error == Error::StaleResult {
                Status::Stale
            } else {
                Status::Failed
            };
            job.completed_ms = Some(now_ms);
            job.catalog = None;
            job.receipt = None;
            job.failure = Some(match &error {
                Error::StaleResult => JobFailureReason::ConfigurationChanged,
                Error::CleanupPending => JobFailureReason::TransportNotStopped,
                _ => JobFailureReason::InventoryRejected,
            });
            job.worker_generation = None;
            // Leave Active and its independent pending generation intact. The
            // publication outcome cannot drop/replace the real future I/O owner.
            store.closed_failures.push(ClosedFailure {
                key: permit.key.clone(),
                generation: permit.generation,
                error: error.clone(),
            });
            Err(error)
        }
    }
}

fn complete(
    job: &Job,
    current: Option<&StoredProfile>,
    receipts: &[discovery::InventoryReceipt],
    attempted_requests: usize,
    transport_quiescent: bool,
    now_ms: u64,
) -> Result<Job> {
    validate_key(&job.key)?;
    if job.cancel_requested {
        return Ok(Job {
            status: if transport_quiescent {
                Status::Cancelled
            } else {
                Status::Cancelling
            },
            io: if transport_quiescent {
                IoState::Quiescent
            } else {
                job.io
            },
            completed_ms: if transport_quiescent {
                Some(now_ms)
            } else {
                None
            },
            receipt: None,
            catalog: None,
            ..job.clone()
        });
    }
    if terminal(job.status) {
        return Ok(job.clone());
    }
    if job.status != Status::Running || job.io != IoState::Active {
        return Err(Error::DiscoveryNotRunning);
    }
    if !transport_quiescent {
        return Err(Error::CleanupPending);
    }
    let snapshot = validated_snapshot(job)?;
    runtime::dispatch_guard(snapshot, current).map_err(|_| Error::StaleResult)?;
    let plan = job.plan.as_ref().ok_or(Error::InvalidReceipt)?;
    if *plan != runtime::discovery_plan(snapshot)? {
        return Err(Error::InvalidReceipt);
    }
    if attempted_requests == 0
        || attempted_requests > plan.requests.len()
        || receipts.len() > attempted_requests
    {
        return Err(Error::InvalidReceipt);
    }
    let mut kinds = Vec::with_capacity(receipts.len());
    for receipt in receipts {
        if kinds.contains(&receipt.kind) {
            return Err(Error::InvalidReceipt);
        }
        discovery::config::validate_receipt_binding(plan, receipt)
            .map_err(|_| Error::InvalidReceipt)?;
        kinds.push(receipt.kind);
    }
    let primary_kind = plan.requests.first().ok_or(Error::InvalidReceipt)?.kind;
    let primary = receipts
        .iter()
        .find(|receipt| receipt.kind == primary_kind)
        .ok_or(Error::InvalidReceipt)?;
    let mut catalog = discovery::normalize::normalize_inventory(plan, primary)
        .map_err(|_| Error::InvalidReceipt)?;
    let expects_metadata = plan
        .requests
        .iter()
        .any(|request| request.kind == discovery::InventoryKind::LmStudioMetadata);
    let mut metadata_unavailable = expects_metadata;
    if let Some(metadata) = receipts
        .iter()
        .find(|receipt| receipt.kind == discovery::InventoryKind::LmStudioMetadata)
    {
        // Metadata is optional. Bound target failures above reject the job; a malformed
        // same-target extension leaves the valid primary list with unknown capabilities.
        if let Ok(enriched) = discovery::normalize::enrich_lmstudio(&catalog, plan, metadata) {
            catalog = enriched;
            metadata_unavailable = false;
        }
    }
    let receipt = Receipt {
        binding: plan.binding.clone(),
        request_count: attempted_requests,
        model_count: catalog.models.len(),
        inference_verified: false,
        metadata_unavailable,
    };
    Ok(Job {
        status: if catalog.models.is_empty() {
            Status::Empty
        } else {
            Status::Succeeded
        },
        io: IoState::Quiescent,
        completed_ms: Some(now_ms),
        receipt: Some(receipt),
        catalog: Some(catalog),
        ..job.clone()
    })
}

pub fn recover_after_restart(store: &mut JobStore, scope: &Scope, now_ms: u64) -> Result<()> {
    validate_scope(scope)?;
    for job in store.records.iter().filter(|job| &job.key.scope == scope) {
        validate_key(&job.key)?;
    }
    for job in store
        .records
        .iter_mut()
        .filter(|job| &job.key.scope == scope)
    {
        if !terminal(job.status) {
            job.status = Status::Failed;
            job.completed_ms = Some(now_ms);
            job.catalog = None;
            job.receipt = None;
            job.failure = Some(JobFailureReason::ServerRestarted);
        }
        if matches!(job.io, IoState::Active | IoState::Unconfirmed) {
            job.io = IoState::Unconfirmed;
        }
        // Already terminal publication status/reason/time are preserved. This
        // barrier revokes old permission, never manufactures a stopped owner.
        job.worker_generation = None;
    }
    store
        .closed_failures
        .retain(|closed| &closed.key.scope != scope);
    store
        .pending_io
        .retain(|pending| &pending.key.scope != scope);
    Ok(())
}

#[cfg(test)]
thread_local! {
    static PUBLIC_JOB_PROJECTIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
fn public_job_projection_count() -> usize {
    PUBLIC_JOB_PROJECTIONS.with(|count| count.get())
}
pub fn public_job(store: &JobStore, key: &JobKey, scope: &Scope) -> Result<Value> {
    #[cfg(test)]
    PUBLIC_JOB_PROJECTIONS.with(|count| count.set(count.get() + 1));
    validate_key(key)?;
    let job = store
        .records
        .iter()
        .find(|job| &job.key == key)
        .ok_or(Error::NotFound)?;
    validate_scope(scope)?;
    if &job.key.scope != scope {
        return Err(Error::NotFound);
    }
    validate_key(&job.key)?;
    if job.snapshot.is_some() {
        let snapshot = validated_snapshot(job).map_err(|_| Error::NotFound)?;
        if job.plan.as_ref() != Some(&runtime::discovery_plan(snapshot)?) {
            return Err(Error::InvalidReceipt);
        }
    } else if job.status != Status::Cancelled
        || job.plan.is_some()
        || job.catalog.is_some()
        || job.receipt.is_some()
        || !job.cancel_requested
    {
        return Err(Error::InvalidReceipt);
    }
    if job.catalog.as_ref().is_some_and(|catalog| {
        job.plan
            .as_ref()
            .is_none_or(|plan| catalog.binding != plan.binding)
    }) {
        return Err(Error::InvalidReceipt);
    }
    if job.receipt.as_ref().is_some_and(|receipt| {
        job.plan
            .as_ref()
            .is_none_or(|plan| receipt.binding != plan.binding)
    }) {
        return Err(Error::InvalidReceipt);
    }
    let models = job.catalog.as_ref().map(|catalog| catalog.models.iter().map(|model| {
        let reasoning = match &model.reasoning {
            discovery::ReasoningControl::Unknown => Value::Null,
            discovery::ReasoningControl::NativeOptions { allowed, default, .. } => json!({"allowed":allowed,"default":default,"openaiWireMappingVerified":false}),
        };
        let clusters = model.clusters.as_ref().map(|clusters| clusters.iter().map(|cluster| json!({"clusterId":cluster.cluster_id,"loaded":cluster.loaded})).collect::<Vec<_>>());
        json!({"id":model.selection_id,"publicId":model.public_id,"label":model.label,"loaded":model.loaded,"available":model.available,
            "imageInput":model.image_input,"trainedForTools":model.trained_for_tools,"contextWindow":model.context_window,
            "effectiveContext":model.effective_context,"maxOutputTokens":model.max_output_tokens,"reasoning":reasoning,"clusters":clusters})
    }).collect::<Vec<_>>());
    let receipt = job.receipt.as_ref().map(|receipt| {
        json!({"requestCount":receipt.request_count,"modelCount":receipt.model_count,
        "inferenceVerified":false,"metadataUnavailable":receipt.metadata_unavailable})
    });
    let error = job.failure.map(|reason| match reason {
        JobFailureReason::ServerRestarted => json!({"code":"server_restarted","message":"Model discovery was interrupted because V4 restarted. Run discovery again."}),
        JobFailureReason::InventoryRejected => json!({"code":"inventory_rejected","message":"Model discovery returned an invalid inventory. Run discovery again."}),
        JobFailureReason::ConfigurationChanged => json!({"code":"configuration_changed","message":"Discovery results were discarded because connection settings changed. Run discovery again."}),
        JobFailureReason::TransportNotStopped => json!({"code":"transport_not_stopped","message":"Model discovery stopped publishing while V4 waits for its transport to stop."}),
        JobFailureReason::AdmissionRejected => json!({"code":"admission_rejected","message":"Model discovery did not start. Check the provider connection and try again."}),
        JobFailureReason::CapacityReached => json!({"code":"discovery_history_full","message":"The model catalog exceeds V4's retained discovery storage budget. Earlier discovery results remain available."}),
    });
    let cleanup_pending = matches!(job.io, IoState::Active | IoState::Unconfirmed)
        && (terminal(job.status) || job.status == Status::Cancelling);
    Ok(
        json!({"requestId":job.key.request_id,"profileId":job.key.profile_id,
        "revision":job.snapshot.as_ref().map(|snapshot| &snapshot.reference.revision),"status":status_name(job.status),
        "createdMs":job.created_ms,"completedMs":job.completed_ms,"cancelRequested":job.cancel_requested,
        "cancelConfirmed":job.status == Status::Cancelled && job.io == IoState::Quiescent,"cleanupPending":cleanup_pending,"receipt":receipt,"models":models,"error":error}),
    )
}

pub(crate) fn published_inventory(
    store: &JobStore,
    snapshot: &EffectiveConnection,
) -> Result<Option<Value>> {
    validate_scope(&snapshot.reference.scope)?;
    let Some(job) = store.records.iter().rev().find(|job| {
        job.key.scope == snapshot.reference.scope
            && job.key.profile_id == snapshot.reference.profile_id
            && job.snapshot.as_ref() == Some(snapshot)
            && matches!(job.status, Status::Succeeded | Status::Empty)
            && job.io == IoState::Quiescent
    }) else {
        return Ok(None);
    };
    let receipt = job.receipt.as_ref().ok_or(Error::InvalidReceipt)?;
    let catalog = job.catalog.as_ref().ok_or(Error::InvalidReceipt)?;
    let plan = job.plan.as_ref().ok_or(Error::InvalidReceipt)?;
    if job.cancel_requested
        || job.failure.is_some()
        || job.worker_generation.is_some()
        || job.completed_ms.is_none()
        || receipt.model_count != catalog.models.len()
        || receipt.request_count == 0
        || receipt.request_count > plan.requests.len()
        || receipt.inference_verified
        || (job.status == Status::Empty) != catalog.models.is_empty()
    {
        return Err(Error::InvalidReceipt);
    }
    let public = public_job(store, &job.key, &snapshot.reference.scope)?;
    for model in &catalog.models {
        discovery::normalize::validate_id(&model.selection_id)
            .map_err(|_| Error::InvalidReceipt)?;
    }
    Ok(Some(json!({
        "source":"published-discovery", "requestId":job.key.request_id,
        "revision":snapshot.reference.revision, "completedMs":job.completed_ms,
        "models":public["models"], "receipt":public["receipt"]
    })))
}

fn validate_key(key: &JobKey) -> Result<()> {
    validate_scope(&key.scope)?;
    validate_uuid(&key.profile_id)?;
    validate_uuid(&key.request_id)
}

fn validated_snapshot(job: &Job) -> Result<&EffectiveConnection> {
    let snapshot = job.snapshot.as_ref().ok_or(Error::InvalidReceipt)?;
    if snapshot.reference.scope != job.key.scope
        || snapshot.reference.profile_id != job.key.profile_id
    {
        return Err(Error::InvalidScope);
    }
    Ok(snapshot)
}

fn terminal(status: Status) -> bool {
    matches!(
        status,
        Status::Succeeded | Status::Empty | Status::Failed | Status::Cancelled | Status::Stale
    )
}

fn status_name(status: Status) -> &'static str {
    match status {
        Status::Queued => "queued",
        Status::Running => "running",
        Status::Cancelling => "cancelling",
        Status::Succeeded => "succeeded",
        Status::Empty => "empty",
        Status::Failed => "failed",
        Status::Cancelled => "cancelled",
        Status::Stale => "stale",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::*;
    use serde_json::json;

    fn store(records: Vec<Job>) -> JobStore {
        let mut store = JobStore {
            records,
            ..JobStore::new()
        };
        // Fixtures reach running state through the actual authoritative dispatch.
        for index in 0..store.records.len() {
            if store.records[index].status == Status::Running {
                let current =
                    profile_from_snapshot(store.records[index].snapshot.as_ref().unwrap());
                let key = store.records[index].key.clone();
                store.records[index].status = Status::Queued;
                store.records[index].io = IoState::NeverStarted;
                dispatch(&mut store, &key, Some(&current)).unwrap();
            }
        }
        store
    }
    fn permit(store: &JobStore, key: &JobKey) -> WorkerPermit {
        let job = store.records.iter().find(|job| &job.key == key).unwrap();
        WorkerPermit {
            key: key.clone(),
            generation: job.worker_generation.unwrap(),
            store_identity: store.identity.clone(),
        }
    }
    impl JobStore {
        fn len(&self) -> usize {
            self.records.len()
        }
        fn iter(&self) -> std::slice::Iter<'_, Job> {
            self.records.iter()
        }
    }
    impl std::ops::Index<usize> for JobStore {
        type Output = Job;
        fn index(&self, index: usize) -> &Self::Output {
            &self.records[index]
        }
    }

    fn key() -> JobKey {
        JobKey {
            scope: scope(),
            profile_id: PROFILE.into(),
            request_id: REQUEST.into(),
        }
    }
    fn queued(kind: ProfileKind) -> Job {
        let snapshot = effective(kind);
        let discovery_profile = discovery::Profile {
            owner_id: scope().owner_id,
            environment_id: scope().environment_id,
            profile_id: PROFILE.into(),
            config_revision: REVISION.into(),
            provider: if kind == ProfileKind::LmStudioLocal {
                discovery::ProviderKind::LmStudio
            } else {
                discovery::ProviderKind::Actual
            },
            mode: if kind == ProfileKind::ActualRelay {
                discovery::ConnectionMode::Relay
            } else {
                discovery::ConnectionMode::Local
            },
            base_url: snapshot.base_url.clone(),
            authentication: match &snapshot.auth {
                StoredAuth::None => discovery::Authentication::None,
                StoredAuth::Bearer(binding) => {
                    discovery::Authentication::ApiKey(discovery::CredentialReference {
                        vault_id: binding.id.clone(),
                        generation: binding.generation.clone(),
                        bound_base_url: snapshot.base_url.clone(),
                    })
                }
            },
            cluster_id: snapshot.cluster_id.clone(),
        };
        let plan =
            discovery::config::plan_discovery(&discovery_profile, &snapshot.base_url).unwrap();
        Job {
            key: key(),
            snapshot: Some(snapshot),
            plan: Some(plan),
            status: Status::Queued,
            io: IoState::NeverStarted,
            cancel_requested: false,
            created_ms: 1,
            completed_ms: None,
            receipt: None,
            catalog: None,
            failure: None,
            worker_generation: None,
        }
    }
    fn running() -> Job {
        Job {
            status: Status::Running,
            io: IoState::Active,
            ..queued(ProfileKind::ActualRelay)
        }
    }
    fn inventory(job: &Job, body: Value) -> discovery::InventoryReceipt {
        let plan = job.plan.as_ref().unwrap();
        discovery::InventoryReceipt {
            binding: plan.binding.clone(),
            kind: plan.requests[0].kind,
            effective_url: plan.requests[0].url.clone(),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    fn published_fixture() -> (JobStore, EffectiveConnection) {
        let job = Job {
            status: Status::Running,
            io: IoState::Active,
            ..queued(ProfileKind::ActualLocal)
        };
        let snapshot = job.snapshot.clone().unwrap();
        let receipt = inventory(&job, json!({"data":[{"id":"own-selection-id"}]}));
        let current = profile_from_snapshot(&snapshot);
        let mut jobs = store(vec![job]);
        let token = permit(&jobs, &key());
        finish(&mut jobs, &token, Some(&current), &[receipt], 1, true, 900).unwrap();
        (jobs, snapshot)
    }

    #[test]
    fn published_inventory_projects_only_previously_published_metadata() {
        let (jobs, snapshot) = published_fixture();
        let view = published_inventory(&jobs, &snapshot).unwrap().unwrap();
        assert_eq!(view["source"], "published-discovery");
        assert_eq!(view["requestId"], REQUEST);
        assert_eq!(view["revision"], REVISION);
        assert_eq!(view["models"][0]["id"], "own-selection-id");
        assert_eq!(view["models"][0]["imageInput"], Value::Null);
        assert_eq!(view["models"][0]["reasoning"], Value::Null);
        assert_eq!(view["receipt"]["inferenceVerified"], false);
        assert!(view.get("snapshot").is_none());
        assert!(view.get("binding").is_none());
        assert!(view.get("stopEvidence").is_none());
    }

    #[test]
    fn published_inventory_uses_append_order_and_new_empty_overrides_old_models() {
        let (mut jobs, snapshot) = published_fixture();
        let mut empty = jobs.records[0].clone();
        empty.key.request_id = "40000000-0000-4000-8000-000000000002".into();
        empty.status = Status::Empty;
        empty.created_ms = 1;
        empty.completed_ms = Some(2);
        empty.catalog.as_mut().unwrap().models.clear();
        empty.receipt.as_mut().unwrap().model_count = 0;
        jobs.records.push(empty);
        let view = published_inventory(&jobs, &snapshot).unwrap().unwrap();
        assert_eq!(view["requestId"], "40000000-0000-4000-8000-000000000002");
        assert_eq!(view["models"], json!([]));
        assert_eq!(view["completedMs"], 2);
    }

    #[test]
    fn published_inventory_ignores_incomplete_or_failed_newer_jobs() {
        let (mut jobs, snapshot) = published_fixture();
        for (status, io) in [
            (Status::Running, IoState::Active),
            (Status::Failed, IoState::Quiescent),
            (Status::Succeeded, IoState::Unconfirmed),
        ] {
            let mut newer = jobs.records[0].clone();
            newer.key.request_id = "40000000-0000-4000-8000-000000000002".into();
            newer.status = status;
            newer.io = io;
            jobs.records.push(newer);
            assert_eq!(
                published_inventory(&jobs, &snapshot).unwrap().unwrap()["requestId"],
                REQUEST
            );
            jobs.records.pop();
        }
    }

    #[test]
    fn published_inventory_requires_full_exact_owner_revision_and_configuration() {
        let (jobs, snapshot) = published_fixture();
        for index in 0..7 {
            let mut changed = snapshot.clone();
            match index {
                0 => changed.reference.scope.owner_id = "other-owner".into(),
                1 => changed.reference.scope.environment_id = "other-server".into(),
                2 => changed.reference.revision = "20000000-0000-4000-8000-000000000002".into(),
                3 => changed.transport = Transport::OpenAiChat,
                4 => changed.base_url = "http://127.0.0.1:8766/v1".into(),
                5 => changed.cluster_id = Some("other-cluster".into()),
                _ => changed.auth = StoredAuth::Bearer(binding(&profile_from_snapshot(&snapshot))),
            }
            assert_ne!(changed, snapshot);
            assert_eq!(published_inventory(&jobs, &changed).unwrap(), None);
        }
    }

    #[test]
    fn published_inventory_rejects_corrupt_eligible_publications_without_old_fallback() {
        let (mut jobs, snapshot) = published_fixture();
        let original = jobs.records[0].clone();
        for index in 0..5 {
            let mut invalid = original.clone();
            invalid.key.request_id = "40000000-0000-4000-8000-000000000002".into();
            match index {
                0 => invalid.receipt = None,
                1 => invalid.catalog = None,
                2 => invalid.receipt.as_mut().unwrap().model_count = 2,
                3 => invalid.status = Status::Empty,
                _ => {
                    invalid.catalog.as_mut().unwrap().binding.config_revision =
                        "20000000-0000-4000-8000-000000000002".into()
                }
            }
            jobs.records.push(invalid);
            assert_eq!(
                published_inventory(&jobs, &snapshot),
                Err(Error::InvalidReceipt)
            );
            jobs.records.pop();
        }
    }

    #[test]
    fn published_inventory_rejects_padded_selection_ids_from_older_history() {
        let (mut jobs, snapshot) = published_fixture();
        for id in [
            " own-selection-id",
            "own-selection-id ",
            "\u{2003}own-selection-id",
            "\u{feff}own-selection-id",
            "own-selection-id\u{feff}",
        ] {
            jobs.records[0].catalog.as_mut().unwrap().models[0].selection_id = id.into();
            assert_eq!(
                published_inventory(&jobs, &snapshot),
                Err(Error::InvalidReceipt)
            );
        }
    }

    #[test]
    fn explicit_begin_only_queues_known_gets_without_starting_transport() {
        let mut jobs = store(vec![]);
        let snapshot = effective(ProfileKind::LmStudioLocal);
        let created = begin(&mut jobs, &scope(), &snapshot, REQUEST, 1).unwrap();
        assert_eq!(created.status, Status::Queued);
        assert_eq!(created.io, IoState::NeverStarted);
        assert!(created
            .plan
            .as_ref()
            .unwrap()
            .requests
            .iter()
            .all(|request| request.method == discovery::InventoryMethod::Get
                && request.credential.is_none()));
        assert_eq!(jobs.len(), 1);
    }

    #[test]
    fn same_request_and_snapshot_return_the_original_job_without_duplicate_dispatch() {
        let original = queued(ProfileKind::ActualRelay);
        let mut jobs = store(vec![original.clone()]);
        assert_eq!(
            begin(
                &mut jobs,
                &scope(),
                original.snapshot.as_ref().unwrap(),
                REQUEST,
                99
            ),
            Ok(original)
        );
        assert_eq!(jobs.len(), 1);
    }

    #[test]
    fn same_request_id_cannot_be_rebound_to_a_new_config_or_credential_generation() {
        let original = queued(ProfileKind::ActualRelay);
        let mut jobs = store(vec![original.clone()]);
        let mut changed = original.snapshot.unwrap();
        changed.reference.revision = NEXT_REVISION.into();
        changed.reference.credential_generation = Some(NEXT_GENERATION.into());
        assert_eq!(
            begin(&mut jobs, &scope(), &changed, REQUEST, 99),
            Err(Error::DiscoveryConflict)
        );
        assert_eq!(jobs.len(), 1);
    }

    #[test]
    fn identical_request_uuids_in_another_owner_scope_are_not_the_same_job() {
        let original = queued(ProfileKind::ActualLocal);
        let mut jobs = store(vec![original]);
        let mut foreign = effective(ProfileKind::ActualLocal);
        foreign.reference.scope.owner_id = "another-owner".into();
        let result = begin(&mut jobs, &foreign.reference.scope, &foreign, REQUEST, 2).unwrap();
        assert_eq!(result.key.scope.owner_id, "another-owner");
        assert_eq!(jobs.len(), 2);
    }

    #[test]
    fn cancellation_before_begin_persists_a_tombstone_that_prevents_late_dispatch() {
        let mut jobs = store(vec![]);
        let cancelled = cancel(&mut jobs, &key(), 1).unwrap();
        assert_eq!(cancelled.status, Status::Cancelled);
        assert!(cancelled.snapshot.is_none());
        assert!(cancelled.plan.is_none());
        let late = begin(
            &mut jobs,
            &scope(),
            &effective(ProfileKind::ActualRelay),
            REQUEST,
            2,
        )
        .unwrap();
        assert_eq!(late.status, Status::Cancelled);
        assert_eq!(
            dispatch(
                &mut jobs,
                &late.key,
                Some(&profile(ProfileKind::ActualRelay))
            ),
            Err(Error::DiscoveryCancelled)
        );
        assert_eq!(jobs.len(), 1);
    }

    #[test]
    fn cancelling_running_transport_never_claims_cancelled_before_quiescence() {
        let mut jobs = store(vec![running()]);
        let worker = permit(&jobs, &key());
        let cancelled = cancel(&mut jobs, &key(), 2).unwrap();
        assert_eq!(cancelled.status, Status::Cancelling);
        assert_eq!(cancelled.io, IoState::Active);
        let pending = finish(
            &mut jobs,
            &worker,
            Some(&profile(ProfileKind::ActualRelay)),
            &[],
            1,
            false,
            3,
        )
        .unwrap();
        assert_eq!(pending.status, Status::Cancelling);
        assert!(pending.receipt.is_none());
        let stopped = finish(
            &mut jobs,
            &worker,
            Some(&profile(ProfileKind::ActualRelay)),
            &[],
            1,
            true,
            4,
        )
        .unwrap();
        assert_eq!(stopped.status, Status::Cancelled);
        assert_eq!(stopped.io, IoState::Quiescent);
        assert!(stopped.catalog.is_none());
    }

    #[test]
    fn a_revoked_snapshot_cannot_start_new_inventory_work() {
        let job = queued(ProfileKind::ActualRelay);
        let mut jobs = store(vec![job.clone()]);
        let mut current = profile(ProfileKind::ActualRelay);
        current.revision = NEXT_REVISION.into();
        assert_eq!(
            dispatch(&mut jobs, &job.key, Some(&current)),
            Err(Error::ConfigurationChanged)
        );
        assert_eq!(
            dispatch(&mut jobs, &job.key, None),
            Err(Error::ConfigurationChanged)
        );
    }

    #[test]
    fn successful_inventory_keeps_unknown_capabilities_and_never_verifies_inference() {
        let job = running();
        let mut jobs = store(vec![job.clone()]);
        let worker = permit(&jobs, &job.key);
        let receipt = inventory(
            &job,
            json!({"data":[{"id":"synthetic-model","loaded":true}]}),
        );
        let finished = finish(
            &mut jobs,
            &worker,
            Some(&profile(ProfileKind::ActualRelay)),
            &[receipt],
            1,
            true,
            3,
        )
        .unwrap();
        assert_eq!(finished.status, Status::Succeeded);
        let catalog = finished.catalog.as_ref().unwrap();
        assert_eq!(catalog.models[0].loaded, Some(true));
        assert_eq!(catalog.models[0].available, None);
        assert_eq!(catalog.models[0].image_input, None);
        assert_eq!(catalog.models[0].context_window, None);
        assert!(!finished.receipt.as_ref().unwrap().inference_verified);
    }

    #[test]
    fn an_empty_success_remains_empty_and_does_not_choose_a_model() {
        let job = running();
        let mut jobs = store(vec![job.clone()]);
        let worker = permit(&jobs, &job.key);
        let receipt = inventory(&job, json!({"data":[]}));
        let finished = finish(
            &mut jobs,
            &worker,
            Some(&profile(ProfileKind::ActualRelay)),
            &[receipt],
            1,
            true,
            3,
        )
        .unwrap();
        assert_eq!(finished.status, Status::Empty);
        assert!(finished.catalog.unwrap().models.is_empty());
        assert_eq!(finished.receipt.unwrap().model_count, 0);
    }

    #[test]
    fn stale_configuration_is_rejected_before_parsing_or_publishing_a_body() {
        let job = running();
        let mut jobs = store(vec![job.clone()]);
        let worker = permit(&jobs, &job.key);
        let mut receipt = inventory(&job, json!({"data":[]}));
        receipt.body = b"must not parse stale body".to_vec();
        let mut current = profile(ProfileKind::ActualRelay);
        current.revision = NEXT_REVISION.into();
        assert_eq!(
            finish(&mut jobs, &worker, Some(&current), &[receipt], 1, true, 3),
            Err(Error::StaleResult)
        );
        assert!(job.catalog.is_none());
    }

    #[test]
    fn a_cross_owner_or_redirected_receipt_cannot_be_published() {
        let job = running();
        let mut jobs = store(vec![job.clone()]);
        let worker = permit(&jobs, &job.key);
        for field in ["owner", "redirect"] {
            let mut receipt = inventory(&job, json!({"data":[]}));
            if field == "owner" {
                receipt.binding.owner_id = "other-owner".into();
            } else {
                receipt.effective_url = "https://redirect.example.test/v1/models".into();
            }
            assert_eq!(
                finish(
                    &mut jobs,
                    &worker,
                    Some(&profile(ProfileKind::ActualRelay)),
                    &[receipt],
                    1,
                    true,
                    3
                ),
                Err(Error::InvalidReceipt)
            );
        }
    }

    #[test]
    fn normal_completion_requires_all_transport_work_to_be_quiescent() {
        let job = running();
        let mut jobs = store(vec![job.clone()]);
        let worker = permit(&jobs, &job.key);
        let receipt = inventory(&job, json!({"data":[]}));
        assert_eq!(
            finish(
                &mut jobs,
                &worker,
                Some(&profile(ProfileKind::ActualRelay)),
                &[receipt],
                1,
                false,
                3
            ),
            Err(Error::CleanupPending)
        );
    }

    #[test]
    fn a_job_cannot_report_more_requests_than_its_explicit_plan() {
        let job = running();
        let mut jobs = store(vec![job.clone()]);
        let worker = permit(&jobs, &job.key);
        let receipt = inventory(&job, json!({"data":[]}));
        assert_eq!(
            finish(
                &mut jobs,
                &worker,
                Some(&profile(ProfileKind::ActualRelay)),
                &[receipt],
                2,
                true,
                3
            ),
            Err(Error::InvalidReceipt)
        );
    }

    #[test]
    fn bounded_job_policy_never_evicts_an_active_or_cancel_before_begin_identity() {
        let mut jobs = store(
            (0..MAX_JOBS_PER_SCOPE)
                .map(|index| {
                    let mut job = queued(ProfileKind::ActualLocal);
                    job.key.request_id = format!("50000000-0000-4000-8000-{index:012x}");
                    job
                })
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            begin(
                &mut jobs,
                &scope(),
                &effective(ProfileKind::ActualLocal),
                "50000000-0000-4000-8000-999999999999",
                1
            ),
            Err(Error::JobLimit)
        );
        assert_eq!(jobs.len(), MAX_JOBS_PER_SCOPE);
    }

    #[test]
    fn process_restart_fails_nonterminal_jobs_without_automatically_restarting_them() {
        let mut jobs = store(vec![running(), queued(ProfileKind::ActualLocal)]);
        recover_after_restart(&mut jobs, &scope(), 99).unwrap();
        assert!(jobs
            .iter()
            .all(|job| job.status == Status::Failed && job.completed_ms == Some(99)));
        assert_eq!(jobs[0].io, IoState::Unconfirmed);
        assert_eq!(jobs[1].io, IoState::NeverStarted);
        assert!(jobs.iter().all(|job| job.worker_generation.is_none()));
        assert!(jobs
            .iter()
            .all(|job| job.failure == Some(JobFailureReason::ServerRestarted)));
        assert!(jobs.iter().all(|job| job.catalog.is_none()));
    }

    #[test]
    fn public_job_lookup_is_owner_and_execution_server_scoped() {
        let job = queued(ProfileKind::ActualRelay);
        let jobs = store(vec![job.clone()]);
        let mut foreign = scope();
        foreign.environment_id = "other-server".into();
        assert_eq!(public_job(&jobs, &job.key, &foreign), Err(Error::NotFound));
        let dto = public_job(&jobs, &job.key, &scope()).unwrap();
        assert_eq!(dto["requestId"], REQUEST);
        assert_eq!(dto["status"], "queued");
        assert!(dto.get("credentialId").is_none());
        assert!(dto.get("plan").is_none());
        assert!(dto.get("secret").is_none());
    }

    #[test]
    fn a_detached_queued_clone_cannot_dispatch_after_authoritative_cancellation() {
        let stale = queued(ProfileKind::ActualRelay);
        let mut authoritative = store(vec![stale.clone()]);
        cancel(&mut authoritative, &key(), 2).unwrap();
        assert_eq!(authoritative[0].status, Status::Cancelled);
        // The stale clone supplies only its key; latest authoritative state decides.
        assert_eq!(
            dispatch(
                &mut authoritative,
                &stale.key,
                Some(&profile(ProfileKind::ActualRelay))
            )
            .err(),
            Some(Error::DiscoveryCancelled)
        );
    }

    #[test]
    fn a_detached_queued_clone_cannot_dispatch_after_authoritative_restart_recovery() {
        let stale = queued(ProfileKind::ActualRelay);
        let mut authoritative = store(vec![stale.clone()]);
        recover_after_restart(&mut authoritative, &scope(), 2).unwrap();
        assert_eq!(authoritative[0].status, Status::Failed);
        assert_eq!(
            dispatch(
                &mut authoritative,
                &stale.key,
                Some(&profile(ProfileKind::ActualRelay))
            )
            .err(),
            Some(Error::DiscoveryNotRunning)
        );
    }

    #[test]
    fn a_cancelled_running_worker_can_only_ack_quiescence_and_never_publish_models() {
        let stale = running();
        let receipt = inventory(&stale, json!({"data":[{"id":"late-model"}]}));
        let mut authoritative = store(vec![stale.clone()]);
        let worker = permit(&authoritative, &stale.key);
        cancel(&mut authoritative, &key(), 2).unwrap();
        assert_eq!(authoritative[0].status, Status::Cancelling);
        let completed = finish(
            &mut authoritative,
            &worker,
            Some(&profile(ProfileKind::ActualRelay)),
            &[receipt],
            1,
            true,
            3,
        )
        .unwrap();
        assert_eq!(completed.status, Status::Cancelled);
        assert!(completed.catalog.is_none() && completed.receipt.is_none());
    }

    #[test]
    fn a_pre_restart_worker_generation_cannot_publish_into_the_recovered_store() {
        let stale = running();
        let receipt = inventory(&stale, json!({"data":[{"id":"late-model"}]}));
        let mut authoritative = store(vec![stale.clone()]);
        let worker = permit(&authoritative, &stale.key);
        recover_after_restart(&mut authoritative, &scope(), 2).unwrap();
        assert_eq!(
            finish(
                &mut authoritative,
                &worker,
                Some(&profile(ProfileKind::ActualRelay)),
                &[receipt],
                1,
                true,
                3
            )
            .err(),
            Some(Error::StaleResult)
        );
        assert_eq!(authoritative[0].status, Status::Failed);
        assert!(authoritative[0].catalog.is_none());
    }

    #[test]
    fn a_worker_generation_cannot_publish_twice_from_the_same_detached_running_snapshot() {
        let stale = running();
        let mut authoritative = store(vec![stale.clone()]);
        let worker = permit(&authoritative, &stale.key);
        let receipt = inventory(&stale, json!({"data":[{"id":"once"}]}));
        let first = finish(
            &mut authoritative,
            &worker,
            Some(&profile(ProfileKind::ActualRelay)),
            std::slice::from_ref(&receipt),
            1,
            true,
            2,
        )
        .unwrap();
        assert_eq!(authoritative[0], first);
        assert_eq!(authoritative[0].status, Status::Succeeded);
        assert_eq!(
            finish(
                &mut authoritative,
                &worker,
                Some(&profile(ProfileKind::ActualRelay)),
                &[receipt],
                1,
                true,
                3
            )
            .err(),
            Some(Error::StaleResult)
        );
    }

    #[test]
    fn restart_failure_dto_has_a_typed_sanitized_server_restarted_reason() {
        let mut authoritative = store(vec![running()]);
        recover_after_restart(&mut authoritative, &scope(), 2).unwrap();
        let dto = public_job(&authoritative, &authoritative[0].key, &scope()).unwrap();
        assert_eq!(
            dto["error"],
            json!({"code":"server_restarted","message":"Model discovery was interrupted because V4 restarted. Run discovery again."})
        );
        assert_eq!(
            authoritative[0].failure,
            Some(JobFailureReason::ServerRestarted)
        );
    }
}

// Gate D isolated current-API RED tests only; production behavior unchanged.
#[cfg(test)]
#[path = "finish_error_tests.rs"]
mod finish_error_tests;

// Isolated owned-discovery TEST/STUB gate only; no app capability.
#[path = "owned_discovery/mod.rs"]
pub(crate) mod owned_discovery;

pub(crate) mod checkpoint;
