//! Original isolated cooperative leases. No application consumer is wired yet.
// Prototype entry points are unused only in the non-test standalone library.
#![cfg_attr(not(test), allow(dead_code))]
use crate::*;
use std::{path::Path, sync::Arc};

pub(crate) const SCHEMA_VERSION: i64 = 2;
pub(crate) const MAX_SCOPED_ACTORS: i64 = 4096;
pub(crate) const SCHEMA: &str = include_str!("schema-v2.sql");
pub(crate) const ADMISSION_LOCK_FILE: &str = "admission.lock";
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LeaseError {
    UnsupportedSchema,
    InvalidScope,
    NotFound,
    InvalidConfiguration,
    CapacityReached,
    ConfigurationChanged,
    CleanupPending,
    PersistenceFailed,
    AdmissionExists,
    StaleHandle,
    InvalidEvidence,
    ResourceStopPending,
    KeyUnavailable,
    HandoffFailed,
}
pub(crate) type LeaseResult<T> = std::result::Result<T, LeaseError>;

pub(crate) struct TrustedExecutionContext {
    scope: Scope,
}
impl TrustedExecutionContext {
    // Internal adapter bridge only: no body/header/public DTO can call this.
    pub(crate) fn from_authenticated_execution(scope: Scope) -> Self {
        Self { scope }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConsumerKind {
    StructuredTurn,
    StructuredCompact,
    Cli,
    DurableTask,
    Discovery,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeaseIdentity {
    pub(crate) actor_id: String,
    pub(crate) process_instance_id: String,
    pub(crate) lease_id: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LeaseStatus {
    RegisteredUnstarted,
    HandoffUncertain,
    Active,
    Revoked,
    Quiescent,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeaseView {
    pub(crate) request_id: String,
    pub(crate) identity: LeaseIdentity,
    pub(crate) reference: ConnectionRef,
    pub(crate) status: LeaseStatus,
}
// Information above is not authority. Neither live type below is constructible,
// cloneable or serializable outside this module. Tests may inject invalid values.
pub(crate) struct LeaseHandle {
    coordinator_identity: Arc<()>,
    reference: ConnectionRef,
    identity: LeaseIdentity,
    admission_generation: u64,
}
pub(crate) struct StopEvidence {
    coordinator_identity: Arc<()>,
    reference: ConnectionRef,
    identity: LeaseIdentity,
    admission_generation: u64,
    observation_identity: Arc<()>,
}
// Trusted adapters only. Fake implementations prove contract calls, not actual
// network/process stop. Evidence is minted by Coordinator after successful join.
pub(crate) enum StartOutcome {
    Started(Box<dyn OwnedRunningResource>),
    FailedOwned {
        error: LeaseError,
        owner: Box<dyn OwnedRunningResource>,
    },
}
// A preparation origin is an in-memory seal, never a request/storage identifier.
pub(crate) struct AdmissionOrigin {
    coordinator_identity: Arc<()>,
}
impl AdmissionOrigin {
    pub(crate) fn same_origin(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.coordinator_identity, &other.coordinator_identity)
    }
    #[cfg(test)]
    pub(crate) fn test_fresh() -> Self {
        Self {
            coordinator_identity: Arc::new(()),
        }
    }
}
pub(crate) trait StartOwnedResource: Send {
    // Inert validation before registration or callback entry. Concrete network
    // adapters bind their prepared authority to this exact admission.
    fn validate_for_admission(
        &self,
        _origin: &AdmissionOrigin,
        _snapshot: &EffectiveConnection,
        _consumer: ConsumerKind,
    ) -> LeaseResult<()> {
        Ok(())
    }
    fn start(self: Box<Self>) -> StartOutcome;
}
struct HistoryAdmission<'a> {
    payload: crate::Result<Vec<u8>>,
    generation: &'a mut u64,
}
pub(crate) struct AdmissionFailure {
    error: LeaseError,
    owned_handle: Option<Box<LeaseHandle>>,
    original_never_dispatched: Option<Box<NeverDispatchedAdmission>>,
}
// This original lexical object is owned only by one admit call. It is consumed
// before callback entry, never reconstructed from a status, SQL row or None.
struct BeforeCallback {
    coordinator_identity: Arc<()>,
    process_instance_id: String,
    attempt_identity: Arc<()>,
    request_id: String,
    snapshot: EffectiveConnection,
    consumer: ConsumerKind,
}
struct CallbackEntered;
impl BeforeCallback {
    fn enter(self) -> CallbackEntered {
        CallbackEntered
    }
    fn never_dispatched(self) -> NeverDispatchedAdmission {
        NeverDispatchedAdmission {
            attempt_identity: self.attempt_identity.clone(),
            original: self,
        }
    }
}
pub(crate) struct NeverDispatchedAdmission {
    original: BeforeCallback,
    attempt_identity: Arc<()>,
}
pub(crate) enum AdmissionDisposition {
    Owned(LeaseHandle),
    NeverDispatched(NeverDispatchedAdmission),
    UnconfirmedNoHandle,
}
impl AdmissionFailure {
    pub(crate) fn into_parts(self) -> (LeaseError, Option<LeaseHandle>) {
        (self.error, self.owned_handle.map(|handle| *handle))
    }
    pub(crate) fn into_disposition(self) -> (LeaseError, AdmissionDisposition) {
        let disposition = match self.owned_handle {
            Some(handle) => AdmissionDisposition::Owned(*handle),
            None => match self.original_never_dispatched {
                Some(original) => AdmissionDisposition::NeverDispatched(*original),
                None => AdmissionDisposition::UnconfirmedNoHandle,
            },
        };
        (self.error, disposition)
    }
}
impl std::fmt::Debug for AdmissionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdmissionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}
pub(crate) trait OwnedRunningResource: Send {
    fn cancel_and_join(&mut self) -> LeaseResult<()>;
}
struct Observation {
    identity: Arc<()>,
    nonce: String,
    kind: ObservationKind,
}
struct OwnedLease {
    row: crate::storage::v2::Actor,
    owner: Option<Box<dyn OwnedRunningResource>>,
    reserved: Option<Box<dyn StartOwnedResource>>,
    observation: Option<Observation>,
    completed: bool,
}
pub(crate) struct Coordinator {
    context: TrustedExecutionContext,
    storage: crate::storage::v2::V2Store,
    history: stop_fact::StopFactMac,
    live_identity: Arc<()>,
    process_instance_id: String,
    resources: Vec<OwnedLease>,
    next_generation: u64,
    fence_notice: Option<std::sync::mpsc::Sender<()>>,
    #[cfg(test)]
    failure: Option<FailurePoint>,
    #[cfg(test)]
    pause: Option<(PausePoint, TestGate)>,
}
fn fresh_id() -> LeaseResult<String> {
    use rand::TryRngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| LeaseError::PersistenceFailed)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}
impl Coordinator {
    pub(crate) fn verify_never_dispatched(
        &self,
        original: &NeverDispatchedAdmission,
        request: &str,
        snapshot: &EffectiveConnection,
        consumer: ConsumerKind,
    ) -> LeaseResult<()> {
        let origin = &original.original;
        if !Arc::ptr_eq(&origin.coordinator_identity, &self.live_identity)
            || origin.process_instance_id != self.process_instance_id
            || !Arc::ptr_eq(&origin.attempt_identity, &original.attempt_identity)
            || origin.request_id != request
            || origin.snapshot != *snapshot
            || origin.consumer != consumer
            || snapshot.reference.scope != self.context.scope
        {
            return Err(LeaseError::InvalidEvidence);
        }
        validate_uuid(request).map_err(|_| LeaseError::InvalidEvidence)?;
        let profile = profile_from_snapshot(snapshot);
        let resolved = runtime::resolve(&self.context.scope, &profile, &snapshot.reference, None)
            .map_err(|_| LeaseError::InvalidEvidence)?;
        if resolved != *snapshot {
            return Err(LeaseError::InvalidEvidence);
        }
        Ok(())
    }
    pub(crate) fn open(root: &Path, context: TrustedExecutionContext) -> LeaseResult<Self> {
        validate_scope(&context.scope).map_err(|_| LeaseError::InvalidScope)?;
        let (storage, history) = crate::storage::v2::V2Store::open(root)?;
        Ok(Self {
            context,
            storage,
            history,
            live_identity: Arc::new(()),
            process_instance_id: fresh_id()?,
            resources: vec![],
            next_generation: 1,
            fence_notice: None,
            #[cfg(test)]
            failure: None,
            #[cfg(test)]
            pause: None,
        })
    }
    fn fence(&mut self) -> LeaseResult<crate::storage::v2::FenceGuard> {
        self.storage.fence(self.fence_notice.take())
    }
    pub(crate) fn configure(
        &mut self,
        mutation: ConfigMutation,
        ids: SaveIds,
    ) -> LeaseResult<ConfigReceipt> {
        let guard = self.fence()?;
        #[cfg(test)]
        self.pause_at(PausePoint::MutationBeforeCapture)?;
        self.storage
            .configure(&guard, &self.context.scope, mutation, ids, &self.history)
    }
    pub(crate) fn profiles(&mut self) -> LeaseResult<Vec<StoredProfile>> {
        let guard = self.fence()?;
        self.storage.profiles(&guard, &self.context.scope)
    }
    pub(crate) fn has_unconfirmed_actors(&mut self) -> LeaseResult<bool> {
        let _guard = self.fence()?;
        for actor in self.storage.actors(&self.context.scope)? {
            if actor.status != LeaseStatus::Quiescent {
                return Ok(true);
            }
            let Some(fact) = actor.fact.as_deref() else {
                return Ok(true);
            };
            if self
                .history
                .verify_prior(fact, &actor.reference, &actor.identity, actor.generation)
                .is_err()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(crate) fn pending_configurations(&mut self) -> LeaseResult<Vec<(String, String)>> {
        let guard = self.fence()?;
        self.storage
            .pending_configurations(&guard, &self.context.scope)
    }
    pub(crate) fn pending_configurations_after(
        &mut self,
        after_rowid: i64,
    ) -> LeaseResult<Vec<(i64, String, String)>> {
        let guard = self.fence()?;
        self.storage
            .pending_configurations_after(&guard, &self.context.scope, after_rowid)
    }
    pub(crate) fn authenticated_scope(&self) -> &Scope {
        &self.context.scope
    }
    pub(crate) fn profile(&self, id: &str) -> LeaseResult<Option<StoredProfile>> {
        self.storage.profile(&self.context.scope, id)
    }
    // Publication order: admission fence -> short in-memory job CAS. Callers
    // must never enter this while holding the job mutex, or join inside the callback.
    pub(crate) fn with_current_profile<T>(
        &mut self,
        snapshot: &EffectiveConnection,
        publish: impl FnOnce(Option<&StoredProfile>) -> T,
    ) -> LeaseResult<T> {
        if snapshot.reference.scope != self.context.scope {
            return Err(LeaseError::InvalidScope);
        }
        let guard = self.fence()?;
        let profile = self.storage.profile_under_fence(
            &guard,
            &self.context.scope,
            &snapshot.reference.profile_id,
        )?;
        Ok(publish(profile.as_ref()))
    }
    pub(crate) fn prepare_http_discovery(
        &mut self,
        snapshot: &EffectiveConnection,
        timeout: std::time::Duration,
    ) -> LeaseResult<(
        crate::http_discovery::HttpDiscoveryAction,
        crate::http_discovery::OutcomeReader,
    )> {
        if snapshot.reference.scope != self.context.scope {
            return Err(LeaseError::InvalidScope);
        }
        let guard = self.fence()?;
        let authorization = self
            .storage
            .authorization(&guard, &self.context.scope, snapshot)?;
        crate::http_discovery::HttpDiscoveryAction::prepare(
            AdmissionOrigin {
                coordinator_identity: self.live_identity.clone(),
            },
            snapshot,
            authorization,
            timeout,
        )
        .map_err(|_| LeaseError::ConfigurationChanged)
    }
    pub(crate) fn prepare_http_inference(
        &mut self,
        plan: &crate::inference::InferencePlan,
        consumer: ConsumerKind,
        body: Vec<u8>,
        timeout: std::time::Duration,
    ) -> LeaseResult<(
        crate::inference::http::Action,
        crate::inference::http::Reader,
    )> {
        if plan.snapshot.reference.scope != self.context.scope {
            return Err(LeaseError::InvalidScope);
        }
        let guard = self.fence()?;
        let authorization =
            self.storage
                .authorization(&guard, &self.context.scope, &plan.snapshot)?;
        crate::inference::http::Action::prepare(
            AdmissionOrigin {
                coordinator_identity: self.live_identity.clone(),
            },
            plan,
            consumer,
            body,
            authorization,
            timeout,
        )
        .map_err(|_| LeaseError::InvalidConfiguration)
    }
    pub(crate) fn load_discovery_history(
        &mut self,
        now_ms: u64,
    ) -> LeaseResult<(crate::jobs::JobStore, u64)> {
        let guard = self.fence()?;
        match self
            .storage
            .load_job_checkpoint(&guard, &self.context.scope)?
        {
            None => Ok((crate::jobs::JobStore::new(), 0)),
            Some((generation, payload)) => {
                let jobs = crate::jobs::checkpoint::decode_after_restart(
                    &payload,
                    &self.context.scope,
                    now_ms,
                )
                .map_err(|_| LeaseError::PersistenceFailed)?;
                Ok((jobs, generation))
            }
        }
    }
    pub(crate) fn save_discovery_history(
        &mut self,
        payload: &[u8],
        expected: u64,
    ) -> LeaseResult<u64> {
        let guard = self.fence()?;
        self.storage.begin(&guard, &self.context.scope)?;
        let result = self.storage.write_job_checkpoint_started(
            &guard,
            &self.context.scope,
            expected,
            payload,
        );
        self.storage.finish(result)
    }
    pub(crate) fn with_profiles_at_history_generation<T>(
        &mut self,
        generation: u64,
        fingerprint: &[u8; 32],
        project: impl FnOnce(&[StoredProfile]) -> T,
    ) -> LeaseResult<T> {
        use sha2::Digest;
        let guard = self.fence()?;
        let (current_generation, payload) = self
            .storage
            .load_job_checkpoint(&guard, &self.context.scope)?
            .ok_or(LeaseError::PersistenceFailed)?;
        let current_fingerprint: [u8; 32] = sha2::Sha256::digest(&payload).into();
        if current_generation != generation || current_fingerprint != *fingerprint {
            return Err(LeaseError::PersistenceFailed);
        }
        let profiles = self.storage.profiles(&guard, &self.context.scope)?;
        Ok(project(&profiles))
    }
    pub(crate) fn admit(
        &mut self,
        request: &str,
        snapshot: &EffectiveConnection,
        consumer: ConsumerKind,
        action: Box<dyn StartOwnedResource>,
    ) -> std::result::Result<LeaseHandle, AdmissionFailure> {
        self.admit_impl(request, snapshot, consumer, action, None, false)
    }
    pub(crate) fn admit_inference(
        &mut self,
        request: &str,
        snapshot: &EffectiveConnection,
        consumer: ConsumerKind,
        action: Box<dyn StartOwnedResource>,
    ) -> std::result::Result<LeaseHandle, AdmissionFailure> {
        self.admit_impl(request, snapshot, consumer, action, None, true)
    }
    pub(crate) fn admit_discovery_with_history(
        &mut self,
        request: &str,
        snapshot: &EffectiveConnection,
        action: Box<dyn StartOwnedResource>,
        payload: crate::Result<Vec<u8>>,
        generation: &mut u64,
    ) -> std::result::Result<LeaseHandle, AdmissionFailure> {
        self.admit_impl(
            request,
            snapshot,
            ConsumerKind::Discovery,
            action,
            Some(HistoryAdmission {
                payload,
                generation,
            }),
            false,
        )
    }
    fn admit_impl(
        &mut self,
        request: &str,
        snapshot: &EffectiveConnection,
        consumer: ConsumerKind,
        action: Box<dyn StartOwnedResource>,
        mut history: Option<HistoryAdmission<'_>>,
        reserved_across_restarts: bool,
    ) -> std::result::Result<LeaseHandle, AdmissionFailure> {
        let mut live_handle = None;
        let mut before_callback = None;
        let result = (|| -> LeaseResult<LeaseHandle> {
            validate_uuid(request).map_err(|_| LeaseError::ConfigurationChanged)?;
            if snapshot.reference.scope != self.context.scope {
                return Err(LeaseError::InvalidScope);
            }
            // Validate the full immutable attempted binding independently of the
            // later current-profile preflight, which may reject a replaced config.
            let profile = profile_from_snapshot(snapshot);
            let resolved =
                runtime::resolve(&self.context.scope, &profile, &snapshot.reference, None)
                    .map_err(|_| LeaseError::ConfigurationChanged)?;
            if resolved != *snapshot {
                return Err(LeaseError::ConfigurationChanged);
            }
            before_callback = Some(BeforeCallback {
                coordinator_identity: self.live_identity.clone(),
                process_instance_id: self.process_instance_id.clone(),
                attempt_identity: Arc::new(()),
                request_id: request.into(),
                snapshot: resolved,
                consumer,
            });
            action.validate_for_admission(
                &AdmissionOrigin {
                    coordinator_identity: self.live_identity.clone(),
                },
                snapshot,
                consumer,
            )?;
            // Even a codec/quota failure preserves this original lexical
            // no-dispatch proof. The actual network action has not entered.
            if let Some(history) = &history {
                history
                    .payload
                    .as_ref()
                    .map_err(|_| LeaseError::PersistenceFailed)?;
            }
            let guard = self.fence()?;
            self.storage.begin(&guard, &self.context.scope)?;
            let preflight = (|| {
                if self.storage.actors(&self.context.scope)?.iter().any(|row| {
                    row.request_id == request
                        && (reserved_across_restarts
                            || row.identity.process_instance_id == self.process_instance_id)
                }) {
                    return Err(LeaseError::AdmissionExists);
                }
                self.storage
                    .validate_effective(&self.context.scope, snapshot)?;
                let generation = self.next_generation;
                if generation == 0 || generation >= i64::MAX as u64 {
                    return Err(LeaseError::PersistenceFailed);
                }
                let row = crate::storage::v2::Actor {
                    reference: snapshot.reference.clone(),
                    identity: LeaseIdentity {
                        actor_id: fresh_id()?,
                        process_instance_id: self.process_instance_id.clone(),
                        lease_id: fresh_id()?,
                    },
                    request_id: request.into(),
                    consumer,
                    generation,
                    status: LeaseStatus::RegisteredUnstarted,
                    started: false,
                    fact: None,
                    revocation_operation: None,
                };
                self.storage.insert(&guard, &row)?;
                if let Some(history) = &history {
                    self.storage.write_job_checkpoint_started(
                        &guard,
                        &self.context.scope,
                        *history.generation,
                        history
                            .payload
                            .as_ref()
                            .map_err(|_| LeaseError::PersistenceFailed)?,
                    )?;
                }
                #[cfg(test)]
                {
                    self.pause_at(PausePoint::AdmissionBeforeCommit)?;
                    self.hit(FailurePoint::BeforeRegistrationCommit)?;
                }
                Ok(row)
            })();
            let row = self.storage.finish(preflight)?;
            // Journal generation advances at commit, including every later
            // handoff/status failure. Retries must not overwrite that generation.
            if let Some(history) = &mut history {
                *history.generation += 1;
            }
            #[cfg(test)]
            self.hit(FailurePoint::AfterRegistrationCommitBeforeOwnershipRetention)?;
            self.next_generation = row.generation + 1;
            let index = self.resources.len();
            self.resources.push(OwnedLease {
                row: row.clone(),
                owner: None,
                reserved: Some(action),
                observation: None,
                completed: false,
            });
            live_handle = Some(LeaseHandle {
                coordinator_identity: self.live_identity.clone(),
                reference: row.reference.clone(),
                identity: row.identity.clone(),
                admission_generation: row.generation,
            });
            #[cfg(test)]
            self.hit(FailurePoint::AfterRegistrationCommitBeforeHandoff)?;
            self.storage
                .mark_handoff(&guard, &self.context.scope, &row)?;
            self.resources[index].row.status = LeaseStatus::HandoffUncertain;
            #[cfg(test)]
            self.pause_at(PausePoint::HandoffMarkedBeforeStart)?;
            let action = self.resources[index]
                .reserved
                .take()
                .ok_or(LeaseError::PersistenceFailed)?;
            // The durable uncertain record precedes callback entry. Unwind cannot
            // manufacture a no-work proof or a replacement owner.
            let _entered = before_callback
                .take()
                .ok_or(LeaseError::PersistenceFailed)?
                .enter();
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| action.start()))
                .map_err(|_| LeaseError::PersistenceFailed)?;
            let (failed, error, owner) = match outcome {
                StartOutcome::Started(owner) => (false, None, owner),
                StartOutcome::FailedOwned { error, owner } => (true, Some(error), owner),
            };
            // Retain the original returned owner BEFORE any fallible status write.
            self.resources[index].owner = Some(owner);
            #[cfg(test)]
            if self.take_failure(FailurePoint::AfterReturnedOwnerBeforeStatusCommit) {
                self.storage.fail_status_write_once();
            }
            self.storage
                .returned_owner(&guard, &self.context.scope, &row, failed)?;
            self.resources[index].row.status = if failed {
                LeaseStatus::HandoffUncertain
            } else {
                LeaseStatus::Active
            };
            self.resources[index].row.started = true;
            if let Some(error) = error {
                return Err(error);
            }
            live_handle.take().ok_or(LeaseError::PersistenceFailed)
        })();
        result.map_err(|error| {
            // An existing handle always keeps its original ownership path, even
            // for a reserved action whose callback has not entered yet.
            let original_never_dispatched = if live_handle.is_none() {
                before_callback.map(BeforeCallback::never_dispatched)
            } else {
                None
            };
            AdmissionFailure {
                error,
                owned_handle: live_handle.map(Box::new),
                original_never_dispatched: original_never_dispatched.map(Box::new),
            }
        })
    }
    fn index(&self, handle: &LeaseHandle) -> LeaseResult<usize> {
        if !Arc::ptr_eq(&self.live_identity, &handle.coordinator_identity)
            || handle.reference.scope != self.context.scope
        {
            return Err(LeaseError::StaleHandle);
        }
        self.resources
            .iter()
            .position(|item| {
                item.row.reference == handle.reference
                    && item.row.identity == handle.identity
                    && item.row.generation == handle.admission_generation
            })
            .ok_or(LeaseError::StaleHandle)
    }
    pub(crate) fn admission_status(&self, request: &str) -> LeaseResult<Option<LeaseView>> {
        validate_uuid(request).map_err(|_| LeaseError::ConfigurationChanged)?;
        Ok(self
            .storage
            .actors(&self.context.scope)?
            .into_iter()
            .find(|row| {
                row.request_id == request
                    && row.identity.process_instance_id == self.process_instance_id
            })
            .map(|row| row.view()))
    }
    pub(crate) fn lease_view(&self, handle: &LeaseHandle) -> LeaseResult<LeaseView> {
        let index = self.index(handle)?;
        let expected = &self.resources[index].row;
        self.storage
            .actors(&self.context.scope)?
            .into_iter()
            .find(|row| row.same_binding(expected))
            .map(|row| row.view())
            .ok_or(LeaseError::StaleHandle)
    }
    pub(crate) fn observe_stop(&mut self, handle: &LeaseHandle) -> LeaseResult<StopEvidence> {
        let index = self.index(handle)?;
        if self.resources[index].completed {
            return Err(LeaseError::StaleHandle);
        }
        let guard = self.fence()?;
        self.storage.begin(&guard, &self.context.scope)?;
        let found = self.storage.actors(&self.context.scope).and_then(|rows| {
            if rows
                .iter()
                .any(|row| row.same_binding(&self.resources[index].row))
            {
                Ok(())
            } else {
                Err(LeaseError::StaleHandle)
            }
        });
        self.storage.finish(found)?;
        drop(guard);
        // Actual cancellation/join happens without holding the shared fence or SQL.
        if self.resources[index].observation.is_none() {
            let nonce = fresh_id()?;
            self.resources[index]
                .owner
                .as_mut()
                .ok_or(LeaseError::ResourceStopPending)?
                .cancel_and_join()?;
            self.resources[index].observation = Some(Observation {
                identity: Arc::new(()),
                nonce,
                kind: ObservationKind::ContractPortJoin,
            });
        }
        let observation = self.resources[index]
            .observation
            .as_ref()
            .ok_or(LeaseError::InvalidEvidence)?;
        Ok(StopEvidence {
            coordinator_identity: self.live_identity.clone(),
            reference: handle.reference.clone(),
            identity: handle.identity.clone(),
            admission_generation: handle.admission_generation,
            observation_identity: observation.identity.clone(),
        })
    }
    fn accepted(
        &self,
        handle: &LeaseHandle,
        proof: &StopEvidence,
    ) -> LeaseResult<(usize, AcceptedStopObservation)> {
        let index = self
            .index(handle)
            .map_err(|_| LeaseError::InvalidEvidence)?;
        let observation = self.resources[index]
            .observation
            .as_ref()
            .ok_or(LeaseError::InvalidEvidence)?;
        if !Arc::ptr_eq(&proof.coordinator_identity, &self.live_identity)
            || !Arc::ptr_eq(&proof.observation_identity, &observation.identity)
            || proof.reference != handle.reference
            || proof.identity != handle.identity
            || proof.admission_generation != handle.admission_generation
        {
            return Err(LeaseError::InvalidEvidence);
        }
        Ok((
            index,
            AcceptedStopObservation {
                reference: handle.reference.clone(),
                identity: handle.identity.clone(),
                admission_generation: handle.admission_generation,
                observation_nonce: observation.nonce.clone(),
                kind: observation.kind,
            },
        ))
    }
    pub(crate) fn acknowledge(
        &mut self,
        handle: &LeaseHandle,
        operation: &str,
        proof: &StopEvidence,
    ) -> LeaseResult<ConfigReceipt> {
        let (index, accepted) = self.accepted(handle, proof)?;
        let signed = self.history.authenticate_accepted(&accepted)?;
        let guard = self.fence()?;
        #[cfg(test)]
        if self.take_failure(FailurePoint::AfterAckWrite) {
            self.storage.fail_stop_write_once();
        }
        let receipt = self
            .storage
            .accept_stop(
                &guard,
                &self.context.scope,
                &accepted,
                &signed.encoded,
                Some(operation),
                &self.history,
            )?
            .ok_or(LeaseError::PersistenceFailed)?;
        self.resources[index].completed = true;
        Ok(receipt)
    }
    pub(crate) fn release_completed(
        &mut self,
        handle: &LeaseHandle,
        proof: &StopEvidence,
    ) -> LeaseResult<()> {
        let (index, accepted) = self.accepted(handle, proof)?;
        let signed = self.history.authenticate_accepted(&accepted)?;
        let guard = self.fence()?;
        #[cfg(test)]
        if self.take_failure(FailurePoint::AfterCompletedFactWrite) {
            self.storage.fail_stop_write_once();
        }
        self.storage.accept_stop(
            &guard,
            &self.context.scope,
            &accepted,
            &signed.encoded,
            None,
            &self.history,
        )?;
        self.resources[index].completed = true;
        Ok(())
    }
    pub(crate) fn retry_cleanup(
        &mut self,
        profile: &str,
        operation: &str,
    ) -> LeaseResult<ConfigReceipt> {
        let guard = self.fence()?;
        self.storage.retry_cleanup(
            &guard,
            &self.context.scope,
            profile,
            operation,
            &self.history,
        )
    }
    fn verify_completed_locked(
        &mut self,
        handle: &LeaseHandle,
        proof: &StopEvidence,
    ) -> LeaseResult<(usize, crate::storage::v2::FenceGuard)> {
        let (index, accepted) = self.accepted(handle, proof)?;
        if !self.resources[index].completed {
            return Err(LeaseError::InvalidEvidence);
        }
        let signed = self.history.authenticate_accepted(&accepted)?;
        let guard = self.fence()?;
        let row = self
            .storage
            .actors(&self.context.scope)?
            .into_iter()
            .find(|row| row.same_binding(&self.resources[index].row))
            .ok_or(LeaseError::InvalidEvidence)?;
        if row.status != LeaseStatus::Quiescent || row.fact.as_deref() != Some(&signed.encoded) {
            return Err(LeaseError::InvalidEvidence);
        }
        Ok((index, guard))
    }
    pub(crate) fn verify_completed(
        &mut self,
        handle: &LeaseHandle,
        proof: &StopEvidence,
    ) -> LeaseResult<()> {
        let (_index, _guard) = self.verify_completed_locked(handle, proof)?;
        Ok(())
    }
    pub(crate) fn forget_completed(
        &mut self,
        handle: &LeaseHandle,
        proof: &StopEvidence,
    ) -> LeaseResult<()> {
        // Keep the same original fence held through memory removal as well as
        // receipt verification; a reusable read verifier must not open a gap.
        let (index, _guard) = self.verify_completed_locked(handle, proof)?;
        // Only the joined in-memory owner is dropped. The immutable durable
        // actor and signed stop fact remain for replay and revocation coverage.
        self.resources.swap_remove(index);
        Ok(())
    }
    pub(crate) fn operation_status(
        &self,
        profile: &str,
        operation: &str,
    ) -> LeaseResult<ConfigReceipt> {
        self.storage
            .operation_status(&self.context.scope, profile, operation)
    }
    #[cfg(test)]
    fn fail_once(&mut self, point: FailurePoint) -> LeaseResult<()> {
        self.failure = Some(point);
        Ok(())
    }
    #[cfg(test)]
    fn take_failure(&mut self, point: FailurePoint) -> bool {
        if self.failure == Some(point) {
            self.failure = None;
            true
        } else {
            false
        }
    }
    #[cfg(test)]
    fn hit(&mut self, point: FailurePoint) -> LeaseResult<()> {
        if self.take_failure(point) {
            Err(LeaseError::PersistenceFailed)
        } else {
            Ok(())
        }
    }
    #[cfg(test)]
    pub(crate) fn test_fail_returned_owner_status(&mut self) {
        self.failure = Some(FailurePoint::AfterReturnedOwnerBeforeStatusCommit);
    }
    #[cfg(test)]
    pub(crate) fn notify_fence_attempt(
        &mut self,
        sender: std::sync::mpsc::Sender<()>,
    ) -> LeaseResult<()> {
        self.fence_notice = Some(sender);
        Ok(())
    }
    #[cfg(test)]
    fn pause_once(&mut self, point: PausePoint, gate: TestGate) -> LeaseResult<()> {
        self.pause = Some((point, gate));
        Ok(())
    }
    #[cfg(test)]
    fn pause_at(&mut self, point: PausePoint) -> LeaseResult<()> {
        if self
            .pause
            .as_ref()
            .is_some_and(|(value, _)| *value == point)
        {
            let (_, gate) = self.pause.take().ok_or(LeaseError::PersistenceFailed)?;
            gate.entered
                .send(())
                .map_err(|_| LeaseError::PersistenceFailed)?;
            gate.release
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|_| LeaseError::PersistenceFailed)?;
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn test_fail_after_registration_commit_before_ownership_retention(&mut self) {
        self.failure = Some(FailurePoint::AfterRegistrationCommitBeforeOwnershipRetention);
    }
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum FailurePoint {
    BeforeRegistrationCommit,
    AfterRegistrationCommitBeforeOwnershipRetention,
    AfterRegistrationCommitBeforeHandoff,
    AfterAckWrite,
    AfterCompletedFactWrite,
    AfterReturnedOwnerBeforeStatusCommit,
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum PausePoint {
    AdmissionBeforeCommit,
    HandoffMarkedBeforeStart,
    MutationBeforeCapture,
}
#[cfg(test)]
struct TestGate {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
mod tests;

// Only a validated live observe/ack path may construct this internal typed input.
// Durable authenticated readback is a different type and never restores authority.
pub(crate) struct AcceptedStopObservation {
    reference: ConnectionRef,
    identity: LeaseIdentity,
    admission_generation: u64,
    observation_nonce: String,
    kind: ObservationKind,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ObservationKind {
    ContractPortJoin,
    SyntheticChildExit,
}
pub(crate) mod stop_fact;

impl AcceptedStopObservation {
    pub(crate) fn reference(&self) -> &ConnectionRef {
        &self.reference
    }
    pub(crate) fn identity(&self) -> &LeaseIdentity {
        &self.identity
    }
    pub(crate) fn generation(&self) -> u64 {
        self.admission_generation
    }
}
