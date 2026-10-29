//! Original isolated observed-drain bridge. No application executor is wired.
#![cfg_attr(not(test), allow(dead_code))]
use super::{
    EffectiveConnection, Error, IoState, JobFailureReason, JobKey, JobStore, Scope, Status, Value,
    WorkerPermit,
};
use crate::leases::{
    AdmissionDisposition, ConsumerKind, Coordinator, LeaseError, LeaseHandle, LeaseView,
    NeverDispatchedAdmission, StartOwnedResource, StopEvidence,
};
use crate::runtime;
use std::sync::{Arc, Mutex, MutexGuard};

struct OwnedDiscovery {
    jobs: Arc<Mutex<JobStore>>,
    coordinator: Coordinator,
    scope: Scope,
    entries: Vec<OwnedEntry>,
    #[cfg(test)]
    observe_calls: usize,
    #[cfg(test)]
    failure: Option<FailurePoint>,
    #[cfg(test)]
    admission_pause: Option<AdmissionPause>,
}
struct OwnedEntry {
    permit: WorkerPermit,
    snapshot: EffectiveConnection,
    original_handle: Option<LeaseHandle>,
    original_view: Option<LeaseView>,
    original_proof: Option<StopEvidence>,
    original_never_dispatched: Option<NeverDispatchedAdmission>,
    original_admission_failure_ms: Option<u64>,
    admission_error: Option<LeaseError>,
    phase: DrainPhase,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DrainPhase {
    Unobserved,
    Observed,
    GateCFactAccepted,
    Settled,
    NeverDispatched,
    AuthorityRevoked,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DrainError {
    Job(Error),
    Lease(LeaseError),
}
pub(crate) type DrainResult<T> = std::result::Result<T, DrainError>;
struct JobReader {
    jobs: Arc<Mutex<JobStore>>,
    scope: Scope,
}

// Borrowed information for the one private CAS, never a live drain capability.
// The retained original entry's handle/proof/phase are independently required.
struct DrainBinding<'a> {
    store_identity: &'a Arc<()>,
    key: &'a JobKey,
    generation: u64,
    snapshot: &'a EffectiveConnection,
    lease_view: &'a LeaseView,
}
// Expected data is not authority. Both normal retry and the test-only probe use
// this one CAS only while the original entry still owns its sealed admission.
struct NeverDispatchBinding<'a> {
    store_identity: &'a Arc<()>,
    key: &'a JobKey,
    generation: u64,
    snapshot: &'a EffectiveConnection,
}

fn lock_jobs(jobs: &Mutex<JobStore>) -> DrainResult<MutexGuard<'_, JobStore>> {
    jobs.lock()
        .map_err(|_| DrainError::Job(Error::PersistenceFailed))
}
fn same_lease_binding(left: &LeaseView, right: &LeaseView) -> bool {
    left.request_id == right.request_id
        && left.identity == right.identity
        && left.reference == right.reference
}

// Read-only exact store/key/generation/snapshot fence. No receipt/history/tuple
// creates an owner. Both publication and later observed-drain use this binding.
fn bound_job_index(store: &JobStore, entry: &OwnedEntry) -> DrainResult<usize> {
    let permit = &entry.permit;
    if !Arc::ptr_eq(&store.identity, &permit.store_identity)
        || permit.generation == 0
        || permit.key.scope != entry.snapshot.reference.scope
        || permit.key.profile_id != entry.snapshot.reference.profile_id
    {
        return Err(DrainError::Job(Error::StaleResult));
    }
    let index = store
        .records
        .iter()
        .position(|job| job.key == permit.key)
        .ok_or(DrainError::Job(Error::StaleResult))?;
    let job = &store.records[index];
    if job.snapshot.as_ref() != Some(&entry.snapshot)
        || job.plan.as_ref()
            != Some(&runtime::discovery_plan(&entry.snapshot).map_err(DrainError::Job)?)
    {
        return Err(DrainError::Job(Error::StaleResult));
    }
    Ok(index)
}
fn failed_job_index(
    store: &JobStore,
    entry: &OwnedEntry,
    expected_io: IoState,
) -> DrainResult<usize> {
    let index = bound_job_index(store, entry)?;
    let job = &store.records[index];
    let exact_pending = store.pending_io.iter().any(|pending| {
        pending.key == entry.permit.key && pending.generation == entry.permit.generation
    });
    if !matches!(job.status, Status::Failed | Status::Stale)
        || job.worker_generation.is_some()
        || job.io != expected_io
        || job.catalog.is_some()
        || job.receipt.is_some()
        || !store.closed_failures.iter().any(|closed| {
            closed.key == entry.permit.key && closed.generation == entry.permit.generation
        })
        || (expected_io == IoState::Active && !exact_pending)
        || (expected_io == IoState::Quiescent && exact_pending)
        || !matches!(expected_io, IoState::Active | IoState::Quiescent)
    {
        return Err(DrainError::Job(Error::StaleResult));
    }
    Ok(index)
}

impl OwnedDiscovery {
    // Private ownership transfer only; a future authenticated application factory
    // must establish this scope/context. No browser/auth-header constructor exists.
    fn from_owned_parts(scope: Scope, jobs: JobStore, coordinator: Coordinator) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(jobs)),
            coordinator,
            scope,
            entries: vec![],
            #[cfg(test)]
            observe_calls: 0,
            #[cfg(test)]
            failure: None,
            #[cfg(test)]
            admission_pause: None,
        }
    }
    fn begin_owned(
        &mut self,
        request: &str,
        snapshot: &EffectiveConnection,
        action: Box<dyn StartOwnedResource>,
        now_ms: u64,
    ) -> DrainResult<()> {
        self.begin_owned_impl(request, snapshot, action, now_ms, None)
    }
    fn begin_owned_impl(
        &mut self,
        request: &str,
        snapshot: &EffectiveConnection,
        action: Box<dyn StartOwnedResource>,
        now_ms: u64,
        history_generation: Option<&mut u64>,
    ) -> DrainResult<()> {
        let key = {
            let mut store = lock_jobs(&self.jobs)?;
            // Request-only supervision must have one selected-scope association.
            // Reject before pure begin can insert another profile's same UUID.
            // A retained full snapshot must match exactly; historical cancelled
            // tombstones without a snapshot still replay read-only via begin.
            if store.records.iter().any(|job| {
                job.key.scope == self.scope
                    && job.key.request_id == request
                    && (job.key.profile_id != snapshot.reference.profile_id
                        || job
                            .snapshot
                            .as_ref()
                            .is_some_and(|original| original != snapshot))
            }) {
                return Err(DrainError::Job(Error::DiscoveryConflict));
            }
            let job = super::begin(&mut store, &self.scope, snapshot, request, now_ms)
                .map_err(DrainError::Job)?;
            if super::terminal(job.status)
                || self.entries.iter().any(|entry| entry.permit.key == job.key)
            {
                // Same-ID retry returns the retained outcome, never another start.
                return Ok(());
            }
            if job.status != Status::Queued || job.io != IoState::NeverStarted {
                return Err(DrainError::Job(Error::StaleResult));
            }
            job.key
        };
        // No job mutex spans SQLite, the shared admission fence, or start handoff.
        let current = self
            .coordinator
            .profile(&key.profile_id)
            .map_err(DrainError::Lease)?;
        let permit = {
            let mut store = lock_jobs(&self.jobs)?;
            super::dispatch(&mut store, &key, current.as_ref()).map_err(DrainError::Job)?
        };
        #[cfg(test)]
        self.test_wait_after_dispatch()?;
        let admission = match history_generation {
            None => self
                .coordinator
                .admit(request, snapshot, ConsumerKind::Discovery, action),
            Some(generation) => {
                let payload = {
                    let store = lock_jobs(&self.jobs)?;
                    super::checkpoint::encode(&store, &self.scope)
                };
                self.coordinator
                    .admit_discovery_with_history(request, snapshot, action, payload, generation)
            }
        };
        let (handle, original_never_dispatched, admission_error) = match admission {
            Ok(handle) => (Some(handle), None, None),
            Err(failure) => {
                let (error, disposition) = failure.into_disposition();
                match disposition {
                    AdmissionDisposition::Owned(handle) => (Some(handle), None, Some(error)),
                    AdmissionDisposition::NeverDispatched(original) => {
                        (None, Some(original), Some(error))
                    }
                    AdmissionDisposition::UnconfirmedNoHandle => (None, None, Some(error)),
                }
            }
        };
        let index = self.entries.len();
        let original_admission_failure_ms = admission_error.as_ref().map(|_| now_ms);
        // The original handle is retained BEFORE every fallible binding read or
        // publication step. Coordinator already owns any partially started owner.
        self.entries.push(OwnedEntry {
            permit,
            snapshot: snapshot.clone(),
            original_handle: handle,
            original_view: None,
            original_proof: None,
            original_never_dispatched,
            original_admission_failure_ms,
            admission_error,
            phase: DrainPhase::Unobserved,
        });
        // Keep the original admission and first error time before any fallible
        // publication step. Retry never readmits or creates a replacement token.
        #[cfg(test)]
        if self.entries[index].original_never_dispatched.is_some() {
            self.hit(FailurePoint::AfterNeverDispatchedRetainedBeforeJobCas)?;
        }
        #[cfg(test)]
        self.hit(FailurePoint::AfterHandleRetainedBeforeBindingRead)?;
        if self.entries[index].original_handle.is_some() {
            self.refresh_original_view(index)?;
        }
        if let Some(error) = self.entries[index].admission_error.clone() {
            if self.entries[index].original_never_dispatched.is_some() {
                self.settle_never_dispatched(index, now_ms)?;
                return Err(DrainError::Lease(error));
            }
            #[cfg(test)]
            self.hit(FailurePoint::BeforeFailurePublication)?;
            // Handoff failure is sanitized as waiting for transport stop. Keep
            // the exact typed LeaseError separately and preserve it to the caller.
            self.record_rejection(request, Error::CleanupPending, now_ms)?;
            // Unknown None stays conservative; no invented no-op/stop proof.
            return Err(DrainError::Lease(error));
        }
        Ok(())
    }
    fn reader(&self) -> JobReader {
        JobReader {
            jobs: self.jobs.clone(),
            scope: self.scope.clone(),
        }
    }
    fn entry_index(&self, request: &str) -> DrainResult<usize> {
        crate::validate_uuid(request).map_err(DrainError::Job)?;
        let mut matches = self.entries.iter().enumerate().filter(|(_, entry)| {
            entry.permit.key.scope == self.scope && entry.permit.key.request_id == request
        });
        let index = matches
            .next()
            .map(|(index, _)| index)
            .ok_or(DrainError::Job(Error::NotFound))?;
        if matches.next().is_some() {
            return Err(DrainError::Job(Error::StaleResult));
        }
        Ok(index)
    }
    fn refresh_original_view(&mut self, index: usize) -> DrainResult<LeaseView> {
        let entry = self
            .entries
            .get_mut(index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        let handle = entry
            .original_handle
            .as_ref()
            .ok_or(DrainError::Lease(LeaseError::ResourceStopPending))?;
        let view = self
            .coordinator
            .lease_view(handle)
            .map_err(DrainError::Lease)?;
        if view.reference != entry.snapshot.reference
            || view.reference.scope != self.scope
            || view.request_id != entry.permit.key.request_id
            || entry
                .original_view
                .as_ref()
                .is_some_and(|original| !same_lease_binding(original, &view))
        {
            return Err(DrainError::Lease(LeaseError::InvalidEvidence));
        }
        if entry.original_view.is_none() {
            entry.original_view = Some(view.clone());
        }
        Ok(view)
    }
    fn record_rejection(&mut self, request: &str, error: Error, now_ms: u64) -> DrainResult<()> {
        if !matches!(
            error,
            Error::InvalidReceipt
                | Error::StaleResult
                | Error::CleanupPending
                | Error::PersistenceFailed
                | Error::CapacityReached
        ) {
            return Err(DrainError::Job(Error::InvalidInput));
        }
        let index = self.entry_index(request)?;
        let entry = &self.entries[index];
        if entry.phase == DrainPhase::AuthorityRevoked {
            return Err(DrainError::Job(Error::StaleResult));
        }
        let mut store = lock_jobs(&self.jobs)?;
        let job_index = bound_job_index(&store, entry)?;
        // Exact finalized generation is immutable. Do not replace its cause/time
        // on repeated rejection, and never parse another provider body here.
        if store.closed_failures.iter().any(|closed| {
            closed.key == entry.permit.key && closed.generation == entry.permit.generation
        }) {
            failed_job_index(
                &store,
                entry,
                if entry.phase == DrainPhase::Settled {
                    IoState::Quiescent
                } else {
                    IoState::Active
                },
            )?;
            return Ok(());
        }
        let job = &store.records[job_index];
        if job.worker_generation != Some(entry.permit.generation)
            || !matches!(job.status, Status::Running | Status::Cancelling)
            || job.io != IoState::Active
            || !store.pending_io.iter().any(|pending| {
                pending.key == entry.permit.key && pending.generation == entry.permit.generation
            })
        {
            return Err(DrainError::Job(Error::StaleResult));
        }
        // Same authoritative failure CAS as the accepted parent finalizer. No
        // synthetic receipt or true transport-quiescent bool is fed to finish().
        let job = &mut store.records[job_index];
        job.status = if error == Error::StaleResult {
            Status::Stale
        } else {
            Status::Failed
        };
        job.completed_ms = Some(now_ms);
        job.catalog = None;
        job.receipt = None;
        job.failure = Some(match error {
            Error::StaleResult => JobFailureReason::ConfigurationChanged,
            Error::CleanupPending => JobFailureReason::TransportNotStopped,
            Error::CapacityReached => JobFailureReason::CapacityReached,
            _ => JobFailureReason::InventoryRejected,
        });
        job.worker_generation = None;
        store.closed_failures.push(super::ClosedFailure {
            key: entry.permit.key.clone(),
            generation: entry.permit.generation,
            error,
        });
        // Active I/O and exact pending generation survive publication failure.
        Ok(())
    }
    fn drain_failed(&mut self, request: &str, now_ms: u64) -> DrainResult<Value> {
        let index = self.entry_index(request)?;
        if self.entries[index].phase == DrainPhase::AuthorityRevoked {
            return Err(DrainError::Job(Error::StaleResult));
        }
        if self.entries[index].original_never_dispatched.is_some() {
            return self.settle_never_dispatched(index, now_ms);
        }
        {
            let store = lock_jobs(&self.jobs)?;
            failed_job_index(
                &store,
                &self.entries[index],
                if self.entries[index].phase == DrainPhase::Settled {
                    IoState::Quiescent
                } else {
                    IoState::Active
                },
            )?;
        }
        let view = self.refresh_original_view(index)?;
        self.observe_original(index)?;
        let entry = &self.entries[index];
        // These clones are data only. The original capability stays in entries.
        let identity = entry.permit.store_identity.clone();
        let key = entry.permit.key.clone();
        let generation = entry.permit.generation;
        let snapshot = entry.snapshot.clone();
        self.settle_binding(
            index,
            DrainBinding {
                store_identity: &identity,
                key: &key,
                generation,
                snapshot: &snapshot,
                lease_view: &view,
            },
            now_ms,
        )
    }
    fn settle_never_dispatched(&mut self, index: usize, now_ms: u64) -> DrainResult<Value> {
        let entry = self
            .entries
            .get(index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        let identity = entry.permit.store_identity.clone();
        let key = entry.permit.key.clone();
        let generation = entry.permit.generation;
        let snapshot = entry.snapshot.clone();
        self.settle_never_dispatched_binding(
            index,
            NeverDispatchBinding {
                store_identity: &identity,
                key: &key,
                generation,
                snapshot: &snapshot,
            },
            now_ms,
        )
    }
    fn settle_never_dispatched_binding(
        &mut self,
        index: usize,
        binding: NeverDispatchBinding<'_>,
        _now_ms: u64,
    ) -> DrainResult<Value> {
        let entry = self
            .entries
            .get(index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        if !matches!(
            entry.phase,
            DrainPhase::Unobserved | DrainPhase::NeverDispatched
        ) || entry.permit.key.scope != self.scope
            || !Arc::ptr_eq(binding.store_identity, &entry.permit.store_identity)
            || binding.key != &entry.permit.key
            || binding.generation != entry.permit.generation
            || binding.snapshot != &entry.snapshot
            || entry.original_handle.is_some()
            || entry.original_view.is_some()
            || entry.original_proof.is_some()
            || entry.admission_error.is_none()
        {
            return Err(DrainError::Job(Error::StaleResult));
        }
        super::validate_key(binding.key).map_err(|_| DrainError::Job(Error::StaleResult))?;
        let original = entry
            .original_never_dispatched
            .as_ref()
            .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?;
        let failed_ms = entry
            .original_admission_failure_ms
            .ok_or(DrainError::Job(Error::StaleResult))?;
        // No fence, SQL, callback or join: only the original live lexical object
        // can verify this callback's nonentry. It cannot acknowledge actor rows.
        self.coordinator
            .verify_never_dispatched(
                original,
                &entry.permit.key.request_id,
                &entry.snapshot,
                ConsumerKind::Discovery,
            )
            .map_err(DrainError::Lease)?;
        let mut store = lock_jobs(&self.jobs)?;
        if !Arc::ptr_eq(binding.store_identity, &store.identity) {
            return Err(DrainError::Job(Error::StaleResult));
        }
        let job_index = bound_job_index(&store, entry)?;
        let job = &store.records[job_index];
        let closed = store
            .closed_failures
            .iter()
            .find(|closed| closed.key == entry.permit.key);
        let pending_count = store
            .pending_io
            .iter()
            .filter(|pending| pending.key == entry.permit.key)
            .count();
        if entry.phase == DrainPhase::NeverDispatched {
            // Validate the exact original generation BEFORE read-only replay.
            if job.status != Status::Failed
                || job.io != IoState::NeverStarted
                || job.failure != Some(JobFailureReason::AdmissionRejected)
                || job.completed_ms != Some(failed_ms)
                || job.worker_generation.is_some()
                || job.catalog.is_some()
                || job.receipt.is_some()
                || pending_count != 0
                || !closed.is_some_and(|closed| {
                    closed.generation == entry.permit.generation
                        && closed.error == Error::PersistenceFailed
                })
            {
                return Err(DrainError::Job(Error::StaleResult));
            }
            return super::public_job(&store, binding.key, &self.scope).map_err(DrainError::Job);
        }
        if !matches!(job.status, Status::Running | Status::Cancelling)
            || job.io != IoState::Active
            || job.worker_generation != Some(entry.permit.generation)
            || job.completed_ms.is_some()
            || job.failure.is_some()
            || job.catalog.is_some()
            || job.receipt.is_some()
            || closed.is_some()
            || pending_count != 1
            || !store.pending_io.iter().any(|pending| {
                pending.key == entry.permit.key && pending.generation == entry.permit.generation
            })
        {
            return Err(DrainError::Job(Error::StaleResult));
        }
        let job = &mut store.records[job_index];
        job.status = Status::Failed;
        job.io = IoState::NeverStarted;
        job.failure = Some(JobFailureReason::AdmissionRejected);
        job.completed_ms = Some(failed_ms);
        job.worker_generation = None;
        store.closed_failures.push(super::ClosedFailure {
            key: entry.permit.key.clone(),
            generation: entry.permit.generation,
            error: Error::PersistenceFailed,
        });
        store.pending_io.retain(|pending| {
            pending.key != entry.permit.key || pending.generation != entry.permit.generation
        });
        self.entries[index].phase = DrainPhase::NeverDispatched;
        super::public_job(&store, binding.key, &self.scope).map_err(DrainError::Job)
    }
    fn observe_original(&mut self, index: usize) -> DrainResult<()> {
        let entry = self
            .entries
            .get_mut(index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        if entry.original_proof.is_some() {
            return Ok(());
        }
        let handle = entry
            .original_handle
            .as_ref()
            .ok_or(DrainError::Lease(LeaseError::ResourceStopPending))?;
        #[cfg(test)]
        {
            self.observe_calls += 1;
        }
        // No JobStore mutex (or SQLite/fence owned here) during genuine join.
        let proof = self
            .coordinator
            .observe_stop(handle)
            .map_err(DrainError::Lease)?;
        // Retain original proof BEFORE fallible durable acceptance or job CAS.
        entry.original_proof = Some(proof);
        if entry.phase != DrainPhase::AuthorityRevoked {
            entry.phase = DrainPhase::Observed;
        }
        Ok(())
    }
    fn settle_binding(
        &mut self,
        index: usize,
        binding: DrainBinding<'_>,
        _now_ms: u64,
    ) -> DrainResult<Value> {
        let entry = self
            .entries
            .get(index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        if !matches!(
            entry.phase,
            DrainPhase::Observed | DrainPhase::GateCFactAccepted | DrainPhase::Settled
        ) || entry.permit.key.scope != self.scope
            || !Arc::ptr_eq(binding.store_identity, &entry.permit.store_identity)
            || binding.key != &entry.permit.key
            || binding.generation != entry.permit.generation
            || binding.snapshot != &entry.snapshot
        {
            return Err(DrainError::Job(Error::StaleResult));
        }
        let handle = entry
            .original_handle
            .as_ref()
            .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?;
        let proof = entry
            .original_proof
            .as_ref()
            .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?;
        let current_view = self
            .coordinator
            .lease_view(handle)
            .map_err(DrainError::Lease)?;
        if binding.lease_view != &current_view
            || current_view.reference != entry.snapshot.reference
            || current_view.request_id != entry.permit.key.request_id
            || !entry
                .original_view
                .as_ref()
                .is_some_and(|original| same_lease_binding(original, &current_view))
        {
            return Err(DrainError::Lease(LeaseError::InvalidEvidence));
        }
        // The real Coordinator authenticates original live handle+proof again;
        // historical SQL facts or data-only test targets cannot stand in for it.
        // No job mutex spans this idempotent durable release or its shared fence.
        self.coordinator
            .release_completed(handle, proof)
            .map_err(DrainError::Lease)?;
        let already_settled = self.entries[index].phase == DrainPhase::Settled;
        if !already_settled {
            self.entries[index].phase = DrainPhase::GateCFactAccepted;
        }
        #[cfg(test)]
        self.hit(FailurePoint::AfterGateCReleaseBeforeJobCas)?;
        let mut store = lock_jobs(&self.jobs)?;
        let entry = &self.entries[index];
        if !Arc::ptr_eq(binding.store_identity, &store.identity) {
            return Err(DrainError::Job(Error::StaleResult));
        }
        let job_index = failed_job_index(
            &store,
            entry,
            if already_settled {
                IoState::Quiescent
            } else {
                IoState::Active
            },
        )?;
        if !already_settled {
            // Exact original generation CAS only, after actual observed durable
            // acceptance. Publication status/cause/time/results remain untouched.
            store.records[job_index].io = IoState::Quiescent;
            store.pending_io.retain(|pending| {
                pending.key != entry.permit.key || pending.generation != entry.permit.generation
            });
            self.entries[index].phase = DrainPhase::Settled;
        }
        super::public_job(&store, binding.key, &self.scope).map_err(DrainError::Job)
    }
    fn recover_scope(&mut self, now_ms: u64) -> DrainResult<()> {
        {
            let mut store = lock_jobs(&self.jobs)?;
            super::recover_after_restart(&mut store, &self.scope, now_ms)
                .map_err(DrainError::Job)?;
        }
        // Revoked publication/drain authority does not drop original resources.
        for entry in &mut self.entries {
            if entry.permit.key.scope == self.scope {
                entry.phase = DrainPhase::AuthorityRevoked;
            }
        }
        Ok(())
    }
    fn stop_retired_owner(&mut self, request: &str) -> DrainResult<()> {
        let index = self.entry_index(request)?;
        if self.entries[index].phase != DrainPhase::AuthorityRevoked {
            return Err(DrainError::Job(Error::StaleResult));
        }
        self.refresh_original_view(index)?;
        self.observe_original(index)?;
        let entry = &self.entries[index];
        self.coordinator
            .release_completed(
                entry
                    .original_handle
                    .as_ref()
                    .ok_or(DrainError::Lease(LeaseError::ResourceStopPending))?,
                entry
                    .original_proof
                    .as_ref()
                    .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?,
            )
            .map_err(DrainError::Lease)
        // No job lock, map restoration or drain CAS: recovered job stays unknown.
    }
    #[cfg(test)]
    fn fail_once(&mut self, point: FailurePoint) {
        self.failure = Some(point);
    }
    #[cfg(test)]
    fn hit(&mut self, point: FailurePoint) -> DrainResult<()> {
        if self.failure == Some(point) {
            self.failure = None;
            Err(DrainError::Job(Error::PersistenceFailed))
        } else {
            Ok(())
        }
    }
    #[cfg(test)]
    fn test_observe_calls(&self) -> usize {
        self.observe_calls
    }
    #[cfg(test)]
    fn test_target_for_entry(&self, index: usize) -> DrainResult<TestDrainTarget> {
        let entry = self
            .entries
            .get(index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        Ok(TestDrainTarget {
            store_identity: entry.permit.store_identity.clone(),
            key: entry.permit.key.clone(),
            worker_generation: entry.permit.generation,
            snapshot: entry.snapshot.clone(),
            lease_view: self
                .coordinator
                .lease_view(
                    entry
                        .original_handle
                        .as_ref()
                        .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?,
                )
                .map_err(DrainError::Lease)?,
        })
    }
    #[cfg(test)]
    fn test_settle_observed_target(
        &mut self,
        index: usize,
        target: &TestDrainTarget,
        now_ms: u64,
    ) -> DrainResult<Value> {
        // Probe cannot create/observe a resource or promote its private phase.
        if self.entries.get(index).map(|entry| entry.phase) != Some(DrainPhase::GateCFactAccepted) {
            return Err(DrainError::Job(Error::StaleResult));
        }
        self.settle_binding(
            index,
            DrainBinding {
                store_identity: &target.store_identity,
                key: &target.key,
                generation: target.worker_generation,
                snapshot: &target.snapshot,
                lease_view: &target.lease_view,
            },
            now_ms,
        )
    }
    #[cfg(test)]
    fn test_settle_never_dispatched_target(
        &mut self,
        entry: usize,
        target: &NeverDispatchTarget,
        now_ms: u64,
    ) -> DrainResult<Value> {
        self.settle_never_dispatched_binding(
            entry,
            NeverDispatchBinding {
                store_identity: &target.store_identity,
                key: &target.key,
                generation: target.generation,
                snapshot: &target.snapshot,
            },
            now_ms,
        )
    }
}
#[cfg(test)]
struct AdmissionPause {
    reached: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
impl OwnedDiscovery {
    fn test_pause_after_dispatch(
        &mut self,
        reached: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        self.admission_pause = Some(AdmissionPause { reached, release });
    }
    fn test_wait_after_dispatch(&mut self) -> DrainResult<()> {
        if let Some(gate) = self.admission_pause.take() {
            gate.reached
                .send(())
                .map_err(|_| DrainError::Job(Error::PersistenceFailed))?;
            gate.release
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| DrainError::Job(Error::PersistenceFailed))?;
        }
        Ok(())
    }
}
impl JobReader {
    fn job(&self, request: &str) -> DrainResult<Value> {
        crate::validate_uuid(request).map_err(DrainError::Job)?;
        let store = lock_jobs(&self.jobs)?;
        let mut matches = store
            .records
            .iter()
            .filter(|job| job.key.scope == self.scope && job.key.request_id == request);
        let key = &matches.next().ok_or(DrainError::Job(Error::NotFound))?.key;
        if matches.next().is_some() {
            return Err(DrainError::Job(Error::NotFound));
        }
        super::public_job(&store, key, &self.scope).map_err(DrainError::Job)
    }
}
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailurePoint {
    AfterGateCReleaseBeforeJobCas,
    AfterHandleRetainedBeforeBindingRead,
    BeforeFailurePublication,
    AfterNeverDispatchedRetainedBeforeJobCas,
}
#[cfg(test)]
struct NeverDispatchTarget {
    store_identity: Arc<()>,
    key: JobKey,
    generation: u64,
    snapshot: EffectiveConnection,
}
#[cfg(test)]
#[derive(Clone)]
struct TestDrainTarget {
    store_identity: Arc<()>,
    key: JobKey,
    worker_generation: u64,
    snapshot: EffectiveConnection,
    lease_view: LeaseView,
}
#[cfg(test)]
mod tests;

// Real HTTP successor; original fake-port drain contract remains independently tested.
pub(crate) mod http;
