//! Original V4 queue adapter. The parent state mutex remains canonical admission.
//! A per-session dispatch gate covers reserve -> submit -> receipt reconciliation.
//! The in-process permit is deliberately absent after restart: a stored reservation
//! must be reconciled, not retried automatically by a new process.
use super::{
    normalize_structured_input_message, StructuredControlError, StructuredSessionManager,
    StructuredSessionState,
};
use crate::followup_queue::{
    AcceptedReceipt, DispatchOutcome, HoldReason, IdleBoundary, ItemState, Mutation,
    MutationReceipt, QueueError, QueueMode, QueueOperation, QueueScope, QueueSnapshot, QueueStore,
};
use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode, Uri},
    routing::get,
    Extension, Json, Router,
};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
};
use tokio::sync::Mutex;
use uuid::Uuid;

static BOOT_ID: OnceLock<Uuid> = OnceLock::new();
#[cfg(test)]
static UNCONFIRMED_QUEUE_OPERATIONS: StdMutex<Vec<Uuid>> = StdMutex::new(Vec::new());
#[cfg(test)]
static UNAVAILABLE_QUEUE_SNAPSHOTS: StdMutex<Vec<Uuid>> = StdMutex::new(Vec::new());
#[cfg(all(test, unix))]
static UNAVAILABLE_WAKE_DRAINS: StdMutex<Vec<Uuid>> = StdMutex::new(Vec::new());
#[cfg(all(test, unix))]
type QueuePause = (
    Uuid,
    std::sync::mpsc::Sender<()>,
    std::sync::mpsc::Receiver<()>,
);
#[cfg(all(test, unix))]
static PAIRED_QUEUE_AFTER_AUTH: StdMutex<Vec<QueuePause>> = StdMutex::new(Vec::new());
#[cfg(all(test, unix))]
static QUEUE_AFTER_SNAPSHOT: StdMutex<Vec<QueuePause>> = StdMutex::new(Vec::new());

#[cfg(all(test, unix))]
fn pause_queue_test(gate: &StdMutex<Vec<QueuePause>>, operation_id: Uuid) {
    let pause = {
        let mut value = gate.lock().unwrap();
        value
            .iter()
            .position(|(id, _, _)| *id == operation_id)
            .map(|index| value.remove(index))
    };
    if let Some((_, entered, release)) = pause {
        let _ = entered.send(());
        let _ = release.recv_timeout(std::time::Duration::from_secs(5));
    }
}
pub(crate) fn boot_id() -> Uuid {
    *BOOT_ID.get_or_init(Uuid::new_v4)
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct Key {
    data: PathBuf,
    owner: String,
    session: String,
}
fn key(manager: &StructuredSessionManager, owner: &str, session: &str) -> Key {
    Key {
        data: manager
            .inner
            .config
            .data_dir
            .canonicalize()
            .unwrap_or_else(|_| manager.inner.config.data_dir.clone()),
        owner: owner.into(),
        session: session.into(),
    }
}
type Gates = HashMap<Key, Weak<Mutex<()>>>;
static GATES: OnceLock<StdMutex<Gates>> = OnceLock::new();
fn gate(
    manager: &StructuredSessionManager,
    owner: &str,
    session: &str,
) -> Result<Arc<Mutex<()>>, StructuredControlError> {
    let mut gates = GATES
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .map_err(|_| StructuredControlError::internal("Queue dispatcher lock is unavailable"))?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    let key = key(manager, owner, session);
    if let Some(existing) = gates.get(&key).and_then(Weak::upgrade) {
        return Ok(existing);
    }
    let gate = Arc::new(Mutex::new(()));
    gates.insert(key, Arc::downgrade(&gate));
    Ok(gate)
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Permit {
    request_id: Uuid,
    generation: u64,
}
static PERMITS: OnceLock<StdMutex<HashMap<Key, Permit>>> = OnceLock::new();
struct PermitGuard {
    key: Key,
    permit: Permit,
}
impl Drop for PermitGuard {
    fn drop(&mut self) {
        if let Ok(mut permits) = PERMITS.get_or_init(|| StdMutex::new(HashMap::new())).lock() {
            if permits.get(&self.key) == Some(&self.permit) {
                permits.remove(&self.key);
            }
        }
    }
}
fn install_permit(key: Key, permit: Permit) -> Result<PermitGuard, StructuredControlError> {
    let mut permits = PERMITS
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .map_err(|_| {
            StructuredControlError::internal("Queue admission permit lock is unavailable")
        })?;
    if permits.contains_key(&key) {
        return Err(StructuredControlError::conflict(
            "Another queued input is awaiting acceptance",
        ));
    }
    permits.insert(key.clone(), permit);
    Ok(PermitGuard { key, permit })
}
fn current_permit(key: &Key) -> Result<Option<Permit>, StructuredControlError> {
    Ok(PERMITS
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .map_err(|_| {
            StructuredControlError::internal("Queue admission permit lock is unavailable")
        })?
        .get(key)
        .copied())
}
pub(super) fn store(manager: &StructuredSessionManager) -> QueueStore {
    QueueStore::new(&manager.inner.config.data_dir, manager_boot_id(manager))
}
pub(crate) fn manager_boot_id(manager: &StructuredSessionManager) -> Uuid {
    #[cfg(unix)]
    if manager.inner.live_ownership.get().is_some() {
        return manager.inner.queue_ownership_epoch;
    }
    boot_id()
}
fn queue_supported(state: &StructuredSessionState) -> bool {
    crate::v4_agent::supports(&state.provider) || super::native_queue::enabled_for(state)
}
pub(super) fn scope(state: &StructuredSessionState) -> Result<QueueScope, StructuredControlError> {
    if crate::v4_agent::supports(&state.provider) {
        return QueueScope::new(&state.user_id, FsPath::new(&state.cwd), &state.id)
            .map_err(control_error);
    }
    if super::native_queue::enabled_for(state) {
        return QueueScope::new_native(&state.user_id, FsPath::new(&state.cwd), &state.id)
            .map_err(control_error);
    }
    Err(StructuredControlError::conflict(
        "Follow-up queues are available only in V4 conversations",
    ))
}

#[cfg(unix)]
pub(super) fn lifecycle_gate(
    manager: &StructuredSessionManager,
    owner: &str,
    session: &str,
) -> Result<Arc<Mutex<()>>, String> {
    gate(manager, owner, session).map_err(|error| error.message)
}

#[cfg(unix)]
pub(super) fn lifecycle_queue_state(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
) -> Result<(String, bool), String> {
    use sha2::{Digest, Sha256};
    let scope = scope(state).map_err(|error| error.message)?;
    let snapshot = store(manager)
        .fail_fast()
        .inspect(&scope)
        .map_err(|error| format!("{error:?}"))?;
    let mut digest = Sha256::new();
    digest.update(b"terminal-v4-settlement-queue-v1\0");
    let mut pending = false;
    if let Some(queue) = snapshot {
        for item in queue.items {
            digest.update(item.item_id.as_bytes());
            digest.update(item.revision.to_be_bytes());
            digest.update(item.input_request_id.as_bytes());
            digest.update([match item.state {
                ItemState::Pending => 1,
                ItemState::Dispatching => 2,
                ItemState::Accepted => 3,
                ItemState::Removed => 4,
            }]);
            pending |= matches!(item.state, ItemState::Pending | ItemState::Dispatching);
        }
    }
    Ok((hex::encode(digest.finalize()), pending))
}
fn control_error(error: QueueError) -> StructuredControlError {
    match error {
        QueueError::Invalid(message) => StructuredControlError::invalid(message),
        QueueError::Conflict(message) | QueueError::Capacity(message) => {
            StructuredControlError::conflict(message)
        }
        QueueError::Corrupt(message) | QueueError::Unavailable(message) => StructuredControlError {
            code: "unavailable",
            message,
        },
    }
}
fn api_error(error: StructuredControlError) -> ApiError {
    ApiError {
        status: match error.code {
            "not_found" => StatusCode::NOT_FOUND,
            "invalid" => StatusCode::BAD_REQUEST,
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "forbidden" => StatusCode::FORBIDDEN,
            "conflict" => StatusCode::CONFLICT,
            "unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        },
        message: error.message,
    }
}
fn accepted(receipt: super::StructuredReceipt) -> Result<AcceptedReceipt, StructuredControlError> {
    Ok(AcceptedReceipt {
        request_id: Uuid::parse_str(receipt.request_id.as_deref().ok_or_else(|| {
            StructuredControlError::internal("Canonical queue receipt has no request identity")
        })?)
        .map_err(|_| {
            StructuredControlError::internal("Canonical queue request identity is invalid")
        })?,
        turn_id: receipt.turn_id.ok_or_else(|| {
            StructuredControlError::internal("Canonical queue receipt has no turn identity")
        })?,
        message_id: receipt.message_id.ok_or_else(|| {
            StructuredControlError::internal("Canonical queue receipt has no message identity")
        })?,
        accepted_seq: receipt
            .accepted_seq
            .and_then(|seq| u64::try_from(seq).ok())
            .filter(|seq| *seq > 0)
            .ok_or_else(|| {
                StructuredControlError::internal("Canonical queue receipt has no accepted sequence")
            })?,
    })
}
/// Caller holds this parent's state and dispatch gate. No old queue submit can
/// remain waiting to commit when absence is used to unlock the reservation.
fn reconcile(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
) -> Result<QueueSnapshot, StructuredControlError> {
    if super::native_queue::enabled_for(state) {
        super::native_queue::ensure_disk_not_ahead(manager, state, &store(manager))?;
    }
    reconcile_with_store(&store(manager), state)
}

fn reconcile_with_store(
    store: &QueueStore,
    state: &StructuredSessionState,
) -> Result<QueueSnapshot, StructuredControlError> {
    reconcile_with_store_checked(store, state, &|| Ok(()))
}

fn reconcile_with_store_checked(
    store: &QueueStore,
    state: &StructuredSessionState,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<QueueSnapshot, StructuredControlError> {
    let scope = scope(state)?;
    let snapshot = store.load_checked(&scope, check).map_err(control_error)?;
    let Some(item) = snapshot
        .items
        .iter()
        .find(|item| item.state == ItemState::Dispatching)
    else {
        return Ok(snapshot);
    };
    let canonical = super::native_queue::canonical_receipt(
        store.data_dir(),
        state,
        &item.input_request_id.to_string(),
    )?;
    let outcome = if let Some((receipt, text)) = canonical {
        if text != normalize_structured_input_message(&item.text) {
            store
                .hold_checked(&scope, HoldReason::DispatchError, check)
                .map_err(control_error)?;
            return Err(StructuredControlError::conflict("Queued request identity was accepted with a different payload; queue held for review"));
        }
        DispatchOutcome::Accepted(accepted(receipt)?)
    } else if state.process.is_none() && !state.retiring && !state.deleting {
        DispatchOutcome::DefinitelyAbsent
    } else {
        DispatchOutcome::Unknown
    };
    store
        .reconcile_dispatch_checked(&scope, item.item_id, item.input_request_id, outcome, check)
        .map_err(control_error)
}
/// Called by canonical submit after request dedupe, while the parent state is held.
pub(super) fn check_admission(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: &str,
    text: &str,
) -> Result<(), StructuredControlError> {
    if state.retiring || state.deleting {
        return Err(StructuredControlError::conflict(
            "Conversation cleanup is still in progress",
        ));
    }
    let snapshot = store(manager).load(&scope(state)?).map_err(control_error)?;
    check_snapshot_admission(manager, state, request_id, text, snapshot)
}

/// Called by Codex submit after request dedupe, while the parent state and session lease are held.
pub(super) fn check_native_admission(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: &str,
    text: &str,
) -> Result<(), StructuredControlError> {
    if !super::native_queue::enabled_for(state) {
        return Ok(());
    }
    native_admission(manager, state, request_id, text)
}

#[cfg(test)]
fn check_native_admission_prototype(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: &str,
    text: &str,
) -> Result<(), StructuredControlError> {
    native_admission(manager, state, request_id, text)
}

fn native_admission(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: &str,
    text: &str,
) -> Result<(), StructuredControlError> {
    if !matches!(state.provider.as_str(), "codex" | "claude") {
        return Err(StructuredControlError::invalid(
            "Expected a native Codex or Claude conversation",
        ));
    }
    if state.retiring || state.deleting {
        return Err(StructuredControlError::conflict(
            "Conversation cleanup is still in progress",
        ));
    }
    let scope = QueueScope::new_native(&state.user_id, FsPath::new(&state.cwd), &state.id)
        .map_err(control_error)?;
    let Some(snapshot) = store(manager).inspect(&scope).map_err(control_error)? else {
        return Ok(());
    };
    if snapshot.hold_reason == Some(HoldReason::Restart) && !snapshot.order.is_empty() {
        return Err(StructuredControlError::conflict(
            "The queue must be reviewed after restart before sending a new message",
        ));
    }
    check_snapshot_admission(manager, state, request_id, text, snapshot)
}

fn check_snapshot_admission(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: &str,
    text: &str,
    snapshot: QueueSnapshot,
) -> Result<(), StructuredControlError> {
    if let Some(item) = snapshot
        .items
        .iter()
        .find(|item| item.state == ItemState::Dispatching)
    {
        let permit = current_permit(&key(manager, &state.user_id, &state.id))?;
        if snapshot.mode != QueueMode::Running
            || request_id != item.input_request_id.to_string()
            || normalize_structured_input_message(text)
                != normalize_structured_input_message(&item.text)
            || permit
                != Some(Permit {
                    request_id: item.input_request_id,
                    generation: state.generation,
                })
        {
            return Err(StructuredControlError::conflict("A queued input is awaiting acceptance or review. Open the follow-up queue before sending another message"));
        }
    } else if snapshot.mode == QueueMode::Running && !snapshot.order.is_empty() {
        return Err(StructuredControlError::conflict(
            "Queued messages have the next turn. Pause the queue to send another message first",
        ));
    }
    Ok(())
}
/// The caller must hold the parent dispatch gate and state through canonical
/// admission. Current credential revocation is checked separately under the
/// owner admission transaction immediately before the canonical write.
#[cfg(unix)]
pub(super) fn verify_queue_authority_for_admission(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: &str,
    text: &str,
) -> Result<Option<crate::followup_queue::VerifiedQueueAuthority>, StructuredControlError> {
    if state.retiring || state.deleting || state.process.is_some() {
        return Err(StructuredControlError::conflict("Conversation is not idle"));
    }
    let scope = scope(state)?;
    let store = store(manager);
    let snapshot = store.load(&scope).map_err(control_error)?;
    check_snapshot_admission(manager, state, request_id, text, snapshot.clone())?;
    let Some(item) = snapshot
        .items
        .iter()
        .find(|item| item.state == ItemState::Dispatching)
    else {
        return Ok(None);
    };
    let incarnation = state.session_incarnation.map(|incarnation| incarnation.0);
    let reservation = crate::followup_queue::DispatchReservation {
        item_id: item.item_id,
        item_revision: item.revision,
        input_request_id: item.input_request_id,
        text: item.text.clone(),
        turn_epoch: state.generation,
        queue_revision: snapshot.revision,
    };
    store
        .verify_reservation_authority_for_session(&scope, incarnation, &reservation)
        .map_err(control_error)
}

#[cfg(all(unix, any(test, not(feature = "queued-authority-preview"))))]
fn check_legacy_dispatch(
    queue: &QueueStore,
    scope: &QueueScope,
    incarnation: Option<Uuid>,
    reservation: &crate::followup_queue::DispatchReservation,
) -> Result<(), StructuredControlError> {
    match queue.verify_reservation_authority_for_session(scope, incarnation, reservation) {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(StructuredControlError::conflict(
            "This queued message requires authorized dispatch; review it before continuing",
        )),
        Err(error) => Err(control_error(error)),
    }
}

/// Erased future breaks the submit -> worker -> next-queue-turn Send type cycle.
pub(super) fn drain(
    manager: StructuredSessionManager,
    owner: String,
    session_id: String,
    expected_generation: u64,
) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
    drain_at_revision(manager, owner, session_id, expected_generation, None)
}

fn drain_at_revision(
    manager: StructuredSessionManager,
    owner: String,
    session_id: String,
    expected_generation: u64,
    expected_queue_revision: Option<u64>,
) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
    Box::pin(async move {
        let Some(session) = manager.owned_session(&owner, &session_id).await? else {
            return Ok(());
        };
        let queue_gate = gate(&manager, &owner, &session_id).map_err(|error| error.message)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        if state.user_id != owner
            || !queue_supported(&state)
            || state.generation != expected_generation
            || state.retiring
            || state.deleting
            || state.process.is_some()
        {
            return Ok(());
        }
        let snapshot = reconcile(&manager, &state).map_err(|error| error.message)?;
        if expected_queue_revision.is_some_and(|revision| snapshot.revision != revision) {
            return Ok(());
        }
        let scope = scope(&state).map_err(|error| error.message)?;
        if super::native_queue::enabled_for(&state) {
            match super::native_queue::drain_gate(&state) {
                super::native_queue::DrainGate::Proceed => {}
                super::native_queue::DrainGate::Skip(_) => {
                    super::native_queue::schedule_retry(
                        &manager,
                        &owner,
                        &session_id,
                        expected_generation,
                    );
                    return Ok(());
                }
                super::native_queue::DrainGate::Hold => {
                    return store(&manager)
                        .hold(&scope, HoldReason::Manual)
                        .map(|_| ())
                        .map_err(|error| format!("{error:?}"));
                }
            }
        }
        let reservation = store(&manager)
            .reserve_next(
                &scope,
                snapshot.revision,
                IdleBoundary {
                    turn_epoch: state.generation,
                },
            )
            .map_err(|error| format!("{error:?}"))?;
        let Some(reservation) = reservation else {
            return Ok(());
        };
        let _permit = match install_permit(
            key(&manager, &owner, &session_id),
            Permit {
                request_id: reservation.input_request_id,
                generation: state.generation,
            },
        ) {
            Ok(permit) => permit,
            Err(error) => {
                let _ = store(&manager).reconcile_dispatch(
                    &scope,
                    reservation.item_id,
                    reservation.input_request_id,
                    DispatchOutcome::Unknown,
                );
                return Err(error.message);
            }
        };
        #[cfg(all(unix, not(any(test, feature = "queued-authority-preview"))))]
        if let Err(error) = check_legacy_dispatch(
            &store(&manager),
            &scope,
            state.session_incarnation.map(|value| value.0),
            &reservation,
        ) {
            let _ = store(&manager).reconcile_dispatch(
                &scope,
                reservation.item_id,
                reservation.input_request_id,
                DispatchOutcome::Unknown,
            );
            return Err(error.message);
        }
        drop(state);
        #[cfg(all(unix, any(test, feature = "queued-authority-preview")))]
        let submission = manager
            .submit_queued(
                &owner,
                &session_id,
                &reservation.text,
                &reservation.input_request_id.to_string(),
            )
            .await;
        #[cfg(not(all(unix, any(test, feature = "queued-authority-preview"))))]
        let submission = manager
            .submit(
                &owner,
                &session_id,
                &reservation.text,
                Some(&reservation.input_request_id.to_string()),
            )
            .await;
        // The submit future has settled. Holding the dispatch gate plus state now
        // proves no earlier adapter acceptance can arrive after an absent lookup.
        let state = session.state.lock().await;
        let reconciled = reconcile(&manager, &state).map_err(|error| error.message);
        drop(state);
        reconciled?;
        submission.map(|_| ()).map_err(|error| error.message)
    })
}
/// Terminal callbacks may hold only the generation that they completed.
pub(super) async fn hold_generation(
    manager: &StructuredSessionManager,
    owner: &str,
    session_id: &str,
    expected_generation: u64,
) -> Result<(), String> {
    let Some(session) = manager.owned_session_internal(owner, session_id).await? else {
        return Ok(());
    };
    let queue_gate = gate(manager, owner, session_id).map_err(|error| error.message)?;
    let _gate = queue_gate.lock().await;
    let state = session.state.lock().await;
    if state.generation != expected_generation || !queue_supported(&state) {
        return Ok(());
    }
    store(manager)
        .hold(
            &scope(&state).map_err(|error| error.message)?,
            HoldReason::Manual,
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}
/// Parent sets retiring/generation first and releases state before awaiting this.
/// Holding an unused or native session creates no queue file.
pub(super) async fn hold_session(
    manager: &StructuredSessionManager,
    owner: &str,
    session_id: &str,
) -> Result<(), String> {
    let Some(session) = manager.owned_session_internal(owner, session_id).await? else {
        return Ok(());
    };
    let queue_gate = gate(manager, owner, session_id).map_err(|error| error.message)?;
    let _gate = queue_gate.lock().await;
    let state = session.state.lock().await;
    if !queue_supported(&state) {
        return Ok(());
    }
    store(manager)
        .hold(
            &scope(&state).map_err(|error| error.message)?,
            HoldReason::Manual,
        )
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}
#[cfg(unix)]
pub(crate) struct DelegationQueueTarget {
    pub(crate) identity: Uuid,
    pub(crate) operation: Uuid,
    pub(crate) generation: u64,
    pub(crate) incarnation: Option<Uuid>,
}

#[cfg(unix)]
pub(crate) struct DelegationQueueBinding {
    pub(crate) identity: Uuid,
    pub(crate) incarnation: Option<Uuid>,
}

impl StructuredSessionManager {
    #[cfg(test)]
    pub(crate) async fn session_incarnation_for_test(
        &self,
        owner: &str,
        session_id: &str,
    ) -> Option<Uuid> {
        let session = self.owned_session(owner, session_id).await.ok()??;
        let state = session.state.lock().await;
        state.session_incarnation.map(|value| value.0)
    }

    /// Marks the session as running a turn at `generation` so a delegation
    /// lifecycle test can bind a `DelegationTurn`. Interrupting or killing the
    /// fixture turn cancels `cancel`, as a real turn controller's Stop does.
    /// `None` ends the fixture turn.
    #[cfg(all(test, unix))]
    pub(crate) async fn set_fixture_turn(
        &self,
        owner: &str,
        session_id: &str,
        turn: Option<(u64, crate::v4_agent::interaction::Cancellation)>,
    ) -> Option<Arc<crate::v4_agent::interaction::TurnResources>> {
        struct FixtureTurn(crate::v4_agent::interaction::Cancellation);
        #[async_trait::async_trait]
        impl super::StructuredProcessController for FixtureTurn {
            async fn send_input(&self, _text: &str) -> Result<(), String> {
                Err("fixture turn".into())
            }
            async fn send_approval(&self, _approved: bool) -> Result<(), String> {
                Err("fixture turn".into())
            }
            async fn interrupt(&self) -> Result<(), String> {
                self.0.cancel();
                Ok(())
            }
            async fn kill(&self) -> Result<(), String> {
                self.0.cancel();
                Ok(())
            }
        }
        let session = self.owned_session(owner, session_id).await.ok()??;
        let mut state = session.state.lock().await;
        match turn {
            Some((generation, cancel)) => {
                state.process = Some(Arc::new(FixtureTurn(cancel)));
                state.generation = generation;
            }
            None => state.process = None,
        }
        Some(state.resources.clone())
    }

    #[cfg(unix)]
    pub(crate) fn with_delegation_local_authority<T>(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        uncertain_message: &str,
        action: impl FnOnce(&dyn Fn() -> Result<(), String>) -> Result<T, String>,
    ) -> Result<T, String> {
        self.validate_live_owner(owner)?;
        let admission = self
            .inner
            .local_admission
            .get()
            .ok_or("Queued credential admission unavailable")?;
        let (result, confirmed) = admission.accept(owner, authority, action)?;
        if !confirmed {
            return Err(uncertain_message.into());
        }
        result
    }

    #[cfg(unix)]
    pub(crate) async fn activate_delegation_delivery(
        &self,
        owner: &str,
        session_id: &str,
        workspace: &FsPath,
        target: DelegationQueueTarget,
        cancellation: &crate::v4_agent::interaction::Cancellation,
    ) -> Result<bool, StructuredControlError> {
        cancellation
            .check()
            .map_err(StructuredControlError::conflict)?;
        if !self.live_ownership_enabled() {
            return Err(StructuredControlError::conflict(
                "Exclusive session ownership is required for delegation",
            ));
        }
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        self.validate_live_owner(owner)
            .map_err(StructuredControlError::internal)?;
        let _lifecycle = session.lifecycle.lock().await;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        if state.deleting
            || state.retiring
            || state.process.is_none()
            || state.generation != target.generation
            || target.incarnation.is_none()
            || state.session_incarnation.map(|value| value.0) != target.incarnation
        {
            return Err(StructuredControlError::conflict(
                "The delegation turn is no longer active",
            ));
        }
        let queue_scope = scope(&state)?;
        if !workspace.is_absolute() || queue_scope.workspace() != workspace {
            return Err(StructuredControlError::conflict("Workspace scope changed"));
        }
        let queue = store(self);
        let snapshot = queue
            .snapshot_existing_with_identity(&queue_scope, target.identity)
            .map_err(control_error)?;
        if snapshot.mode == QueueMode::Running {
            return Ok(true);
        }
        if snapshot.hold_reason != Some(HoldReason::New)
            || snapshot
                .items
                .iter()
                .any(|item| item.item_id != target.operation)
        {
            return Ok(false);
        }
        cancellation
            .admit(|| {
                queue
                    .mutate_existing_with_identity(
                        &queue_scope,
                        target.identity,
                        Mutation {
                            operation_id: Uuid::new_v4(),
                            expected_queue_revision: snapshot.revision,
                            operation: crate::followup_queue::QueueOperation::Resume,
                        },
                    )
                    .map(|_| ())
                    .map_err(|error| format!("{error:?}"))
            })
            .map_err(StructuredControlError::conflict)?;
        Ok(true)
    }

    #[cfg(unix)]
    #[allow(dead_code)]
    pub(crate) async fn prepare_delegation_queue_binding(
        &self,
        owner: &str,
        session_id: &str,
        expected_workspace: &FsPath,
        generation: u64,
        resources: &Arc<crate::v4_agent::interaction::TurnResources>,
    ) -> Result<DelegationQueueBinding, StructuredControlError> {
        if !self.live_ownership_enabled() {
            return Err(StructuredControlError::conflict(
                "Exclusive session ownership is required for delegation",
            ));
        }
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        self.validate_live_owner(owner)
            .map_err(StructuredControlError::internal)?;
        let _lifecycle = session.lifecycle.lock().await;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        if state.deleting
            || state.retiring
            || state.generation != generation
            || state.process.is_none()
            || !Arc::ptr_eq(&state.resources, resources)
        {
            return Err(StructuredControlError::conflict(
                "The delegation turn is no longer active",
            ));
        }
        let queue_scope = scope(&state)?;
        if !expected_workspace.is_absolute() || queue_scope.workspace() != expected_workspace {
            return Err(StructuredControlError::conflict("Workspace scope changed"));
        }
        let identity = store(self)
            .ensure_delegation_identity(&queue_scope)
            .map_err(control_error)?;
        Ok(DelegationQueueBinding {
            identity,
            incarnation: state.session_incarnation.map(|value| value.0),
        })
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn prepare_delegation_queue(
        &self,
        owner: &str,
        session_id: &str,
        expected_workspace: &FsPath,
        generation: u64,
        resources: &Arc<crate::v4_agent::interaction::TurnResources>,
    ) -> Result<Uuid, StructuredControlError> {
        self.prepare_delegation_queue_binding(
            owner,
            session_id,
            expected_workspace,
            generation,
            resources,
        )
        .await
        .map(|binding| binding.identity)
    }

    #[cfg(unix)]
    #[allow(dead_code)]
    pub(crate) async fn with_bound_parent_launch<T, F, Fut>(
        &self,
        owner: &str,
        expected_data_root: &FsPath,
        session_id: &str,
        expected_workspace: &FsPath,
        queue_identity: Uuid,
        expected_incarnation: Option<Uuid>,
        shutdown: &crate::v4_agent::interaction::Cancellation,
        action: F,
    ) -> Result<T, StructuredControlError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        if self.inner.config.data_dir.canonicalize().ok().as_deref() != Some(expected_data_root) {
            return Err(StructuredControlError::conflict("Data scope changed"));
        }
        if !self.live_ownership_enabled() {
            return Err(StructuredControlError::conflict(
                "Exclusive session ownership is required for delegated launch",
            ));
        }
        let session = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(StructuredControlError::conflict("Delegation launch stopped")),
            result = self.owned_session(owner, session_id) => result,
        }
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        self.validate_live_owner(owner)
            .map_err(StructuredControlError::internal)?;
        let _lifecycle = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(StructuredControlError::conflict("Delegation launch stopped")),
            guard = session.lifecycle.lock() => guard,
        };
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(StructuredControlError::conflict("Delegation launch stopped")),
            guard = queue_gate.lock() => guard,
        };
        let state = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(StructuredControlError::conflict("Delegation launch stopped")),
            guard = session.state.lock() => guard,
        };
        if state.deleting
            || state.retiring
            || expected_incarnation.is_none()
            || state.session_incarnation.map(|value| value.0) != expected_incarnation
        {
            return Err(StructuredControlError::conflict(
                "Conversation cleanup is still in progress",
            ));
        }
        let queue_scope = scope(&state)?;
        if !expected_workspace.is_absolute() || queue_scope.workspace() != expected_workspace {
            return Err(StructuredControlError::conflict("Workspace scope changed"));
        }
        store(self)
            .snapshot_existing_with_identity(&queue_scope, queue_identity)
            .map_err(control_error)?;
        shutdown.check().map_err(StructuredControlError::conflict)?;
        action().await.map_err(StructuredControlError::internal)
    }

    #[cfg(any(test, unix))]
    #[allow(dead_code)]
    pub(crate) async fn with_bound_parent_queue<T, F>(
        &self,
        owner: &str,
        expected_data_root: &FsPath,
        session_id: &str,
        expected_workspace: &FsPath,
        queue_identity: Uuid,
        action: F,
    ) -> Result<T, StructuredControlError>
    where
        F: FnOnce(&QueueStore, &QueueScope, QueueSnapshot, Option<Uuid>) -> Result<T, String>,
    {
        if self.inner.config.data_dir.canonicalize().ok().as_deref() != Some(expected_data_root) {
            return Err(StructuredControlError::conflict("Data scope changed"));
        }
        #[cfg(unix)]
        if !self.live_ownership_enabled() {
            return Err(StructuredControlError::conflict(
                "Exclusive session ownership is required for delegated delivery",
            ));
        }
        #[cfg(not(unix))]
        return Err(StructuredControlError::conflict(
            "Exclusive session ownership is unavailable",
        ));
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        #[cfg(unix)]
        self.validate_live_owner(owner)
            .map_err(StructuredControlError::internal)?;
        let _lifecycle = session.lifecycle.lock().await;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        if state.deleting || state.retiring {
            return Err(StructuredControlError::conflict(
                "Conversation cleanup is still in progress",
            ));
        }
        let queue_scope = scope(&state)?;
        if !expected_workspace.is_absolute() || queue_scope.workspace() != expected_workspace {
            return Err(StructuredControlError::conflict("Workspace scope changed"));
        }
        let queue = store(self).fail_fast();
        let snapshot = queue
            .snapshot_existing_with_identity(&queue_scope, queue_identity)
            .map_err(control_error)?;
        let should_drain = snapshot.mode == QueueMode::Running && state.process.is_none();
        let generation = state.generation;
        let result = action(
            &queue,
            &queue_scope,
            snapshot,
            state.session_incarnation.map(|value| value.0),
        )
        .map_err(StructuredControlError::internal)?;
        drop(state);
        drop(_gate);
        drop(_lifecycle);
        drop(session);
        if should_drain {
            #[cfg(unix)]
            let drain_permit = match self.external_admission() {
                Ok(permit) => permit,
                Err(error) => {
                    tracing::debug!("Cannot schedule queue drain after delivery: {error}");
                    return Ok(result);
                }
            };
            let manager = self.clone();
            let owner = owner.to_owned();
            let session_id = session_id.to_owned();
            tokio::spawn(async move {
                #[cfg(unix)]
                let _drain_permit = drain_permit;
                if let Err(error) = drain(manager, owner, session_id, generation).await {
                    tracing::debug!("Queue remains held after delivery: {error}");
                }
            });
        }
        Ok(result)
    }

    #[cfg(any(test, unix))]
    #[allow(dead_code)]
    pub(crate) async fn confirm_existing_bound_queue_receipt<T, F>(
        &self,
        owner: &str,
        expected_data_root: &FsPath,
        session_id: &str,
        expected_workspace: &FsPath,
        queue_identity: Uuid,
        expected_incarnation: Option<Uuid>,
        mutation: &Mutation,
        confirm: F,
    ) -> Result<Option<T>, StructuredControlError>
    where
        F: FnOnce(&MutationReceipt) -> Result<T, String>,
    {
        if self.inner.config.data_dir.canonicalize().ok().as_deref() != Some(expected_data_root) {
            return Err(StructuredControlError::conflict("Data scope changed"));
        }
        #[cfg(unix)]
        if !self.live_ownership_enabled() {
            return Err(StructuredControlError::conflict(
                "Exclusive session ownership is required for delegated delivery",
            ));
        }
        #[cfg(not(unix))]
        return Err(StructuredControlError::conflict(
            "Exclusive session ownership is unavailable",
        ));
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        #[cfg(unix)]
        self.validate_live_owner(owner)
            .map_err(StructuredControlError::internal)?;
        let _lifecycle = session.lifecycle.lock().await;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        if state.deleting
            || state.retiring
            || expected_incarnation.is_none()
            || state.session_incarnation.map(|value| value.0) != expected_incarnation
        {
            return Err(StructuredControlError::conflict(
                "Conversation cleanup is still in progress",
            ));
        }
        let scope = scope(&state)?;
        if !expected_workspace.is_absolute() || scope.workspace() != expected_workspace {
            return Err(StructuredControlError::conflict("Workspace scope changed"));
        }
        let receipt = store(self)
            .verify_receipt_with_identity(&scope, queue_identity, mutation)
            .map_err(control_error)?;
        receipt
            .map(|receipt| confirm(&receipt).map_err(StructuredControlError::internal))
            .transpose()
    }

    /// Verify a previously committed queue operation while parent deletion and
    /// queue mutations are fenced. The callback may persist an acknowledgement;
    /// it must not re-enter the session or queue, or perform a delivery.
    #[allow(dead_code)]
    pub(crate) async fn confirm_existing_queue_receipt<T, F>(
        &self,
        owner: &str,
        expected_data_root: &FsPath,
        session_id: &str,
        expected_workspace: &FsPath,
        mutation: &Mutation,
        confirm: F,
    ) -> Result<Option<T>, StructuredControlError>
    where
        F: FnOnce(&MutationReceipt) -> Result<T, String>,
    {
        if self.inner.config.data_dir.canonicalize().ok().as_deref() != Some(expected_data_root) {
            return Err(StructuredControlError::conflict("Data scope changed"));
        }
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let _lifecycle = session.lifecycle.lock().await;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        if state.deleting || state.retiring {
            return Err(StructuredControlError::conflict(
                "Conversation cleanup is still in progress",
            ));
        }
        let scope = scope(&state)?;
        if !expected_workspace.is_absolute() || scope.workspace() != expected_workspace {
            return Err(StructuredControlError::conflict("Workspace scope changed"));
        }
        let receipt = store(self)
            .verify_operation_receipt(&scope, mutation)
            .map_err(control_error)?;
        receipt
            .map(|receipt| confirm(&receipt).map_err(StructuredControlError::internal))
            .transpose()
    }
    pub(crate) async fn queue_snapshot(
        &self,
        owner: &str,
        session_id: &str,
    ) -> Result<QueueSnapshot, StructuredControlError> {
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        reconcile(self, &state)
    }

    async fn queue_read_authorized<T>(
        &self,
        owner: &str,
        session_id: &str,
        request_path: &str,
        authority: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        app_state: &AppState,
        read: impl FnOnce(
            &QueueStore,
            &StructuredSessionState,
            &dyn Fn() -> Result<(), String>,
        ) -> Result<T, StructuredControlError>,
    ) -> Result<T, StructuredControlError> {
        if authority.is_some() == paired.is_some() {
            return Err(StructuredControlError {
                code: "unauthorized",
                message: "A local account or paired device credential is required".into(),
            });
        }
        if paired.is_some_and(|credential| {
            !matches!(credential.method.as_str(), "GET" | "HEAD") || credential.path != request_path
        }) {
            return Err(StructuredControlError::conflict(
                "Paired credential scope mismatch",
            ));
        }
        let manager_root =
            self.inner.config.data_dir.canonicalize().map_err(|_| {
                StructuredControlError::internal("Credential admission unavailable")
            })?;
        let auth_root =
            app_state.config().data_dir.canonicalize().map_err(|_| {
                StructuredControlError::internal("Credential admission unavailable")
            })?;
        if manager_root != auth_root {
            return Err(StructuredControlError::internal(
                "Credential admission scope mismatch",
            ));
        }
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        #[cfg(unix)]
        let paired_guard = if paired.is_some() {
            let app = app_state.clone();
            let guard_owner = owner.to_owned();
            let guard = tokio::task::spawn_blocking(move || app.acquire_input_guard(&guard_owner))
                .await
                .map_err(|_| {
                    StructuredControlError::internal("Paired credential admission unavailable")
                })?
                .map_err(StructuredControlError::conflict)?;
            app_state
                .verify_owner_input_guard(&guard)
                .map_err(StructuredControlError::internal)?;
            Some(guard)
        } else {
            None
        };
        let queue_gate = gate(self, owner, session_id)?;
        #[cfg(unix)]
        let _gate = if paired_guard.is_some() {
            queue_gate
                .try_lock()
                .map_err(|_| StructuredControlError::conflict("Queue is busy; try again"))?
        } else {
            queue_gate.lock().await
        };
        #[cfg(not(unix))]
        let _gate = queue_gate.lock().await;
        #[cfg(unix)]
        let state = if paired_guard.is_some() {
            session
                .state
                .try_lock()
                .map_err(|_| StructuredControlError::conflict("Conversation is busy; try again"))?
        } else {
            session.state.lock().await
        };
        #[cfg(not(unix))]
        let state = session.state.lock().await;
        let store = store(self).fail_fast();
        #[cfg(unix)]
        {
            self.validate_live_owner(owner)
                .map_err(StructuredControlError::internal)?;
            if let Some(authority) = authority {
                let (result, confirmed) = app_state
                    .accept_with_local_authority(owner, authority, |check| {
                        let value = read(&store, &state, check);
                        check().map_err(|message| StructuredControlError {
                            code: "unauthorized",
                            message,
                        })?;
                        value
                    })
                    .map_err(|message| {
                        let code = match message.as_str() {
                            "Credential is invalid or expired" | "Credential has been revoked" => {
                                "unauthorized"
                            }
                            _ => "unavailable",
                        };
                        StructuredControlError { code, message }
                    })?;
                if !confirmed {
                    return Err(StructuredControlError {
                        code: "unavailable",
                        message: "Credential verification could not be confirmed".into(),
                    });
                }
                if authority
                    .valid_for(owner, crate::v4_agent::interaction::now_ms())
                    .is_none()
                {
                    return Err(StructuredControlError {
                        code: "unauthorized",
                        message: "Credential is invalid or expired".into(),
                    });
                }
                return result;
            }
            let paired = paired.expect("exactly one credential was checked");
            let expires =
                crate::paired_environments::validate_input_authority(app_state, paired, owner)
                    .map_err(|message| StructuredControlError {
                        code: "unauthorized",
                        message,
                    })?;
            let check = || {
                if crate::v4_agent::interaction::now_ms() < expires {
                    Ok(())
                } else {
                    Err("Paired grant expired".into())
                }
            };
            let value = read(&store, &state, &check);
            check().map_err(|message| StructuredControlError {
                code: "unauthorized",
                message,
            })?;
            value
        }
        #[cfg(not(unix))]
        {
            let check = || {
                if let Some(authority) = authority {
                    let (generation, _) = authority
                        .valid_for(owner, crate::v4_agent::interaction::now_ms())
                        .ok_or("Credential is invalid or expired")?;
                    app_state.validate_auth_generation(owner, generation)?;
                    authority
                        .valid_for(owner, crate::v4_agent::interaction::now_ms())
                        .ok_or("Credential is invalid or expired")?;
                } else if let Some(paired) = paired {
                    let expires = crate::paired_environments::validate_input_authority(
                        app_state, paired, owner,
                    )?;
                    if crate::v4_agent::interaction::now_ms() >= expires {
                        return Err("Paired grant expired".into());
                    }
                }
                Ok(())
            };
            check().map_err(|message| StructuredControlError {
                code: "unauthorized",
                message,
            })?;
            let value = read(&store, &state, &check);
            check().map_err(|message| StructuredControlError {
                code: "unauthorized",
                message,
            })?;
            value
        }
    }
    #[cfg(test)]
    pub(crate) async fn queue_mutate(
        &self,
        owner: &str,
        session_id: &str,
        mutation: Mutation,
    ) -> Result<MutationReceipt, StructuredControlError> {
        self.queue_mutate_authorized(owner, session_id, mutation, None, None, None)
            .await
    }

    pub(crate) async fn queue_mutate_authorized(
        &self,
        owner: &str,
        session_id: &str,
        mutation: Mutation,
        authority: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        app_state: Option<&AppState>,
    ) -> Result<MutationReceipt, StructuredControlError> {
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        #[cfg(unix)]
        let paired_guard = if let Some(paired) = paired {
            let app_state = app_state.ok_or_else(|| {
                StructuredControlError::internal("Paired credential admission unavailable")
            })?;
            if authority.is_some()
                || paired.method != "POST"
                || paired.path != format!("/api/structured/sessions/{session_id}/queue")
            {
                return Err(StructuredControlError::conflict(
                    "Paired credential scope mismatch",
                ));
            }
            let manager_root = self.inner.config.data_dir.canonicalize().map_err(|_| {
                StructuredControlError::internal("Paired credential admission unavailable")
            })?;
            let auth_root = app_state.config().data_dir.canonicalize().map_err(|_| {
                StructuredControlError::internal("Paired credential admission unavailable")
            })?;
            if manager_root != auth_root {
                return Err(StructuredControlError::conflict(
                    "Paired credential scope mismatch",
                ));
            }
            let state = app_state.clone();
            let guard_owner = owner.to_owned();
            let guard =
                tokio::task::spawn_blocking(move || state.acquire_input_guard(&guard_owner))
                    .await
                    .map_err(|_| {
                        StructuredControlError::internal("Paired credential admission unavailable")
                    })?
                    .map_err(StructuredControlError::conflict)?;
            app_state
                .verify_owner_input_guard(&guard)
                .map_err(StructuredControlError::internal)?;
            if !self.permission_owner_open(owner) {
                return Err(StructuredControlError::conflict(
                    "Owner cleanup is in progress",
                ));
            }
            Some(guard)
        } else {
            None
        };
        #[cfg(unix)]
        if app_state.is_some() && authority.is_none() && paired_guard.is_none() {
            return Err(StructuredControlError {
                code: "forbidden",
                message: "Sign in with a local account or paired device to change the queue".into(),
            });
        }
        #[cfg(not(unix))]
        let _ = paired;
        let queue_gate = gate(self, owner, session_id)?;
        #[cfg(unix)]
        let gate_guard = if paired_guard.is_some() {
            queue_gate
                .try_lock()
                .map_err(|_| StructuredControlError::conflict("Queue is busy; try again"))?
        } else {
            queue_gate.lock().await
        };
        #[cfg(not(unix))]
        let gate_guard = queue_gate.lock().await;
        #[cfg(unix)]
        let state = if paired_guard.is_some() {
            session
                .state
                .try_lock()
                .map_err(|_| StructuredControlError::conflict("Conversation is busy; try again"))?
        } else {
            session.state.lock().await
        };
        #[cfg(not(unix))]
        let state = session.state.lock().await;
        let scope = scope(&state)?;
        let store = if app_state.is_some() {
            store(self).fail_fast()
        } else {
            store(self)
        };
        let wake_requested = matches!(&mutation.operation, QueueOperation::Wake);
        #[cfg(test)]
        let operation_id = mutation.operation_id;
        let apply = |check: &dyn Fn() -> Result<(), String>| {
            check().map_err(StructuredControlError::conflict)?;
            let check_after_publication = || {
                #[cfg(all(test, unix))]
                pause_queue_test(&QUEUE_AFTER_SNAPSHOT, operation_id);
                check().map_err(|_| StructuredControlError {
                    code: "unavailable",
                    message: "Queue operation may have been saved; sign in and retry the same operation ID to recover its receipt".into(),
                })
            };
            // Preserve a committed receipt before rejecting new work during cleanup.
            let already_committed = store
                .verify_operation_receipt(&scope, &mutation)
                .map_err(control_error)?
                .is_some();
            let receipt = if already_committed {
                let receipt = store
                    .mutate_checked(&scope, mutation, check)
                    .map_err(control_error)?;
                if state.retiring || state.deleting {
                    check_after_publication()?;
                    return Ok((receipt, false));
                }
                receipt
            } else {
                if state.retiring || state.deleting {
                    return Err(StructuredControlError::conflict(
                        "Conversation cleanup is still in progress",
                    ));
                }
                reconcile_with_store_checked(&store, &state, check)?;
                #[cfg(all(unix, any(test, feature = "queued-authority-preview")))]
                let capture_authority = self.inner.local_admission.get().is_some();
                #[cfg(not(all(unix, any(test, feature = "queued-authority-preview"))))]
                let capture_authority = false;
                #[cfg(all(unix, not(test), feature = "queued-authority-preview"))]
                if authority.is_some() && !capture_authority {
                    return Err(StructuredControlError::internal(
                        "Queued credential admission unavailable",
                    ));
                }
                if capture_authority
                    && authority.is_some()
                    && state.session_incarnation.is_none()
                    && matches!(
                        &mutation.operation,
                        QueueOperation::Enqueue { .. } | QueueOperation::Edit { .. }
                    )
                {
                    return Err(StructuredControlError::conflict(
                        "This older conversation lacks a durable identity; start a new conversation to authorize queued messages",
                    ));
                }
                if let (true, Some(authority), Some(incarnation), true) = (
                    capture_authority,
                    authority,
                    state.session_incarnation,
                    matches!(
                        &mutation.operation,
                        QueueOperation::Enqueue { .. } | QueueOperation::Edit { .. }
                    ),
                ) {
                    store
                        .mutate_authorized_checked(
                            &scope,
                            incarnation.0,
                            mutation,
                            authority,
                            check,
                        )
                        .map_err(control_error)?
                } else {
                    store
                        .mutate_checked(&scope, mutation, check)
                        .map_err(control_error)?
                }
            };
            #[cfg(test)]
            let snapshot_result = {
                let mut operations = UNAVAILABLE_QUEUE_SNAPSHOTS.lock().unwrap();
                if let Some(index) = operations.iter().position(|id| *id == operation_id) {
                    operations.remove(index);
                    Err(QueueError::Unavailable("Synthetic snapshot failure".into()))
                } else {
                    drop(operations);
                    store.load_checked(&scope, check)
                }
            };
            #[cfg(not(test))]
            let snapshot_result = store.load_checked(&scope, check);
            let snapshot = match snapshot_result {
                Ok(snapshot) => snapshot,
                Err(error) if already_committed => {
                    tracing::debug!("Cannot schedule queue drain after retry: {error:?}");
                    check_after_publication()?;
                    return Err(StructuredControlError {
                        code: "unavailable",
                        message: "Queue operation was saved, but its current state could not be confirmed; retry the same operation ID to recover its receipt".into(),
                    });
                }
                Err(error) => {
                    tracing::debug!("Queue snapshot unavailable after mutation: {error:?}");
                    return Err(StructuredControlError {
                        code: "unavailable",
                        message: "Queue operation may have been saved; retry the same operation ID to recover its receipt".into(),
                    });
                }
            };
            check_after_publication()?;
            if wake_requested && already_committed && snapshot.revision != receipt.queue_revision {
                return Err(StructuredControlError {
                    code: "unavailable",
                    message: "Wake was saved, but the queue has changed; review it before issuing a new wake".into(),
                });
            }
            Ok((
                receipt,
                snapshot.mode == QueueMode::Running && state.process.is_none(),
            ))
        };
        #[cfg(unix)]
        let (receipt, should_drain) = if let (Some(authority), Some(app_state)) =
            (authority, app_state)
        {
            let manager_root = self.inner.config.data_dir.canonicalize().map_err(|_| {
                StructuredControlError::internal("Credential admission unavailable")
            })?;
            let auth_root = app_state.config().data_dir.canonicalize().map_err(|_| {
                StructuredControlError::internal("Credential admission unavailable")
            })?;
            if manager_root != auth_root {
                return Err(StructuredControlError::internal(
                    "Credential admission scope mismatch",
                ));
            }
            self.validate_live_owner(owner)
                .map_err(StructuredControlError::internal)?;
            let (result, confirmed) = app_state
                .accept_with_local_authority(owner, authority, apply)
                .map_err(|message| {
                    let code = match message.as_str() {
                        "Credential is invalid or expired" | "Credential has been revoked" => {
                            "unauthorized"
                        }
                        _ => "unavailable",
                    };
                    StructuredControlError { code, message }
                })?;
            #[cfg(test)]
            let confirmed = {
                let mut operations = UNCONFIRMED_QUEUE_OPERATIONS.lock().unwrap();
                if let Some(index) = operations.iter().position(|id| *id == operation_id) {
                    operations.remove(index);
                    false
                } else {
                    confirmed
                }
            };
            let (receipt, should_drain) = result?;
            if !confirmed {
                return Err(StructuredControlError {
                        code: "unavailable",
                        message: "Queue operation may have been saved; retry the same operation ID to recover its receipt".into(),
                    });
            }
            (receipt, should_drain)
        } else if let (Some(paired), Some(app_state), Some(_guard)) =
            (paired, app_state, paired_guard.as_ref())
        {
            let expires =
                crate::paired_environments::validate_input_authority(app_state, paired, owner)
                    .map_err(|message| StructuredControlError {
                        code: "unauthorized",
                        message,
                    })?;
            #[cfg(all(test, unix))]
            pause_queue_test(&PAIRED_QUEUE_AFTER_AUTH, operation_id);
            let check = || {
                if crate::v4_agent::interaction::now_ms() < expires {
                    Ok(())
                } else {
                    Err("Paired grant expired".into())
                }
            };
            apply(&check)?
        } else {
            apply(&|| Ok(()))?
        };
        #[cfg(not(unix))]
        let (receipt, should_drain) = {
            let _ = app_state;
            apply(&|| Ok(()))?
        };
        let generation = state.generation;
        drop(state);
        drop(gate_guard);
        if should_drain {
            #[cfg(unix)]
            let drain_permit = match {
                #[cfg(test)]
                let unavailable = {
                    let mut operations = UNAVAILABLE_WAKE_DRAINS.lock().unwrap();
                    operations
                        .iter()
                        .position(|id| *id == operation_id)
                        .map(|index| operations.remove(index))
                        .is_some()
                };
                #[cfg(test)]
                if unavailable {
                    Err("Synthetic drain admission failure".into())
                } else {
                    self.internal_admission()
                }
                #[cfg(not(test))]
                self.internal_admission()
            } {
                Ok(permit) => permit,
                Err(error) => {
                    tracing::debug!("Cannot schedule queue drain after mutation: {error}");
                    if wake_requested {
                        return Err(StructuredControlError {
                            code: "unavailable",
                            message: "Queue wake was saved but processing could not be started; retry the same operation ID".into(),
                        });
                    }
                    return Ok(receipt);
                }
            };
            let manager = self.clone();
            let owner = owner.to_owned();
            let session_id = session_id.to_owned();
            let wake_revision = wake_requested.then_some(receipt.queue_revision);
            tokio::spawn(async move {
                #[cfg(unix)]
                let _drain_permit = drain_permit;
                if let Err(error) =
                    drain_at_revision(manager, owner, session_id, generation, wake_revision).await
                {
                    tracing::debug!("Queue remains held after dispatch: {error}");
                }
            });
        }
        Ok(receipt)
    }
    pub(crate) async fn queue_operation_receipt(
        &self,
        owner: &str,
        session_id: &str,
        operation_id: Uuid,
    ) -> Result<Option<MutationReceipt>, StructuredControlError> {
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let queue_gate = gate(self, owner, session_id)?;
        let _gate = queue_gate.lock().await;
        let state = session.state.lock().await;
        store(self)
            .operation_receipt(&scope(&state)?, operation_id)
            .map_err(control_error)
    }
}
const PRIVATE: &str = "private, no-store";
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/structured/sessions/{id}/queue",
            get(get_queue).post(post_queue),
        )
        .route(
            "/api/structured/sessions/{id}/queue/operations/{operationId}",
            get(get_operation),
        )
        .layer(DefaultBodyLimit::max(262_144))
}
async fn get_queue(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<QueueSnapshot>), ApiError> {
    let queue = state
        .structured_session_manager()
        .queue_read_authorized(
            &user.user_id,
            &id,
            uri.path(),
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            &state,
            reconcile_with_store_checked,
        )
        .await
        .map_err(api_error)?;
    Ok(([(header::CACHE_CONTROL, PRIVATE)], Json(queue)))
}
async fn post_queue(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    Path(id): Path<String>,
    Json(mutation): Json<Mutation>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<MutationReceipt>,
    ),
    ApiError,
> {
    let receipt = state
        .structured_session_manager()
        .queue_mutate_authorized(
            &user.user_id,
            &id,
            mutation,
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            Some(&state),
        )
        .await
        .map_err(api_error)?;
    Ok(([(header::CACHE_CONTROL, PRIVATE)], Json(receipt)))
}
async fn get_operation(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
    uri: Uri,
    Path((id, operation_id)): Path<(String, Uuid)>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<MutationReceipt>,
    ),
    ApiError,
> {
    let receipt = state
        .structured_session_manager()
        .queue_read_authorized(
            &user.user_id,
            &id,
            uri.path(),
            authority.as_ref().map(|Extension(value)| value),
            paired.as_ref().map(|Extension(value)| value),
            &state,
            |store, session, _| {
                store
                    .operation_receipt(&scope(session)?, operation_id)
                    .map_err(control_error)
            },
        )
        .await
        .map_err(api_error)?
        .ok_or_else(|| ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Queue operation not found".into(),
        })?;
    Ok(([(header::CACHE_CONTROL, PRIVATE)], Json(receipt)))
}

#[cfg(test)]
mod tests {
    use super::super::{StructuredProcessController, StructuredSessionEvent};
    use super::*;
    use crate::auth::AuthenticatedUser;
    use crate::followup_queue::{
        HoldReason, IdleBoundary, ItemState, QueueMode, QueueOperation, QueueScope, QueueStore,
    };
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Extension,
    };
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::{path::Path, sync::Arc};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    #[cfg(unix)]
    #[tokio::test]
    async fn reviewed_same_process_manager_recovery_holds_its_pending_queue() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let first = StructuredSessionManager::new(config.clone());
        first.bind_live_ownership().unwrap();
        first.load_user_sessions("owner").await.unwrap();
        let scope = QueueScope::new(
            "owner",
            workspace.path(),
            &format!("ss-{}", Uuid::new_v4().simple()),
        )
        .unwrap();
        store(&first)
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "pending".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        drop(first);
        let leases = super::super::live_ownership::ManagerLeases::new(data.path()).unwrap();
        let super::super::live_ownership::OwnerState::Unconfirmed { epoch } =
            leases.inspect("owner").unwrap()
        else {
            panic!("expected unconfirmed owner");
        };
        leases
            .reconcile_unknown("owner", epoch, Uuid::new_v4(), true)
            .unwrap();
        let second = StructuredSessionManager::new(config);
        second.bind_live_ownership().unwrap();
        second.load_user_sessions("owner").await.unwrap();
        let queue = store(&second).load(&scope).unwrap();
        assert_eq!(
            (queue.mode, queue.hold_reason, queue.order.len()),
            (QueueMode::Held, Some(HoldReason::Restart), 1)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aliased_data_directories_share_session_dispatch_gate_and_permit() {
        use std::os::unix::fs::symlink;
        let parent = tempfile::tempdir().unwrap();
        let real = parent.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::create_dir(real.join("data")).unwrap();
        symlink(&real, parent.path().join("alias")).unwrap();
        let manager = |path: PathBuf| {
            StructuredSessionManager::new(AppConfig {
                data_dir: path,
                ..Default::default()
            })
        };
        let direct = manager(real.join("data"));
        let aliased = manager(parent.path().join("alias/data"));
        let first = gate(&direct, "owner", "session").unwrap();
        let second = gate(&aliased, "owner", "session").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(
            &first,
            &gate(&aliased, "other", "session").unwrap()
        ));
        assert!(!Arc::ptr_eq(
            &first,
            &gate(&aliased, "owner", "another").unwrap()
        ));
        let permit = Permit {
            request_id: Uuid::new_v4(),
            generation: 7,
        };
        let _guard = install_permit(key(&direct, "owner", "session"), permit).unwrap();
        assert!(current_permit(&key(&aliased, "owner", "session")).unwrap() == Some(permit));
    }

    #[tokio::test]
    async fn receipt_confirmation_requires_the_exact_existing_owner_session_and_workspace() {
        let (data, workspace, manager, id) = setup(false).await;
        let expected_workspace = workspace.path().canonicalize().unwrap();
        let scope = scope(workspace.path(), &id);
        let mutation = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 0,
            operation: QueueOperation::Enqueue {
                item_id: Uuid::new_v4(),
                text: "child result".into(),
                run_when_idle: false,
            },
        };
        assert_eq!(
            manager
                .confirm_existing_queue_receipt(
                    "owner",
                    &data.path().canonicalize().unwrap(),
                    &id,
                    &expected_workspace,
                    &mutation,
                    |_| -> Result<(), String> { panic!("missing receipt must not run callback") }
                )
                .await
                .unwrap(),
            None
        );
        assert!(!data.path().join("followup-queues").exists());
        let expected = store(&manager).mutate(&scope, mutation.clone()).unwrap();
        assert_eq!(
            manager
                .confirm_existing_queue_receipt(
                    "owner",
                    &data.path().canonicalize().unwrap(),
                    &id,
                    &expected_workspace,
                    &mutation,
                    |actual| Ok(actual.clone())
                )
                .await
                .unwrap(),
            Some(expected.clone())
        );

        let mut changed = mutation.clone();
        if let QueueOperation::Enqueue { text, .. } = &mut changed.operation {
            text.push('!');
        }
        assert!(manager
            .confirm_existing_queue_receipt(
                "owner",
                &data.path().canonicalize().unwrap(),
                &id,
                &expected_workspace,
                &changed,
                |_| -> Result<(), String> { panic!("conflicting payload must not run callback") }
            )
            .await
            .is_err());
        assert!(manager
            .confirm_existing_queue_receipt(
                "other",
                &data.path().canonicalize().unwrap(),
                &id,
                &expected_workspace,
                &mutation,
                |_| -> Result<(), String> { panic!("foreign owner must not run callback") }
            )
            .await
            .is_err());
        assert!(manager
            .confirm_existing_queue_receipt(
                "owner",
                workspace.path(),
                &id,
                &expected_workspace,
                &mutation,
                |_| -> Result<(), String> { panic!("foreign data must not run callback") }
            )
            .await
            .is_err());
        assert!(manager
            .confirm_existing_queue_receipt(
                "owner",
                &data.path().canonicalize().unwrap(),
                &id,
                data.path(),
                &mutation,
                |_| -> Result<(), String> { panic!("foreign workspace must not run callback") }
            )
            .await
            .is_err());
        assert_eq!(
            store(&manager)
                .operation_receipt(&scope, mutation.operation_id)
                .unwrap(),
            Some(expected)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn receipt_confirmation_finishes_before_parent_deletion() {
        let (data, workspace, manager, id) = setup(false).await;
        let scope = scope(workspace.path(), &id);
        let mutation = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 0,
            operation: QueueOperation::Enqueue {
                item_id: Uuid::new_v4(),
                text: "child result".into(),
                run_when_idle: false,
            },
        };
        store(&manager).mutate(&scope, mutation.clone()).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let confirm_manager = manager.clone();
        let confirm_id = id.clone();
        let confirm_data = data.path().canonicalize().unwrap();
        let confirm_workspace = workspace.path().canonicalize().unwrap();
        let confirm_mutation = mutation.clone();
        let confirmation = tokio::spawn(async move {
            confirm_manager
                .confirm_existing_queue_receipt(
                    "owner",
                    &confirm_data,
                    &confirm_id,
                    &confirm_workspace,
                    &confirm_mutation,
                    move |_| {
                        started_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(5))
                            .map_err(|error| error.to_string())?;
                        Ok(())
                    },
                )
                .await
        });
        tokio::task::spawn_blocking(move || {
            started_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .unwrap()
        .unwrap();
        let delete_manager = manager.clone();
        let delete_id = id.clone();
        let (delete_started, delete_started_rx) = tokio::sync::oneshot::channel();
        let mut deletion = tokio::spawn(async move {
            let _ = delete_started.send(());
            delete_manager.delete_session("owner", &delete_id).await
        });
        delete_started_rx.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut deletion)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        assert_eq!(confirmation.await.unwrap().unwrap(), Some(()));
        deletion.await.unwrap().unwrap();
        assert!(manager
            .confirm_existing_queue_receipt(
                "owner",
                &data.path().canonicalize().unwrap(),
                &id,
                &workspace.path().canonicalize().unwrap(),
                &mutation,
                |_| -> Result<(), String> { panic!("deleted parent must not be acknowledged") }
            )
            .await
            .is_err());
    }
    struct Busy;
    #[async_trait::async_trait]
    impl StructuredProcessController for Busy {
        async fn send_input(&self, _text: &str) -> Result<(), String> {
            Err("busy fixture".into())
        }
        async fn send_approval(&self, _approved: bool) -> Result<(), String> {
            Err("no approval".into())
        }
        async fn interrupt(&self) -> Result<(), String> {
            Ok(())
        }
        async fn kill(&self) -> Result<(), String> {
            Ok(())
        }
    }
    async fn setup(
        busy: bool,
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        StructuredSessionManager,
        String,
    ) {
        setup_with_ownership(busy, false).await
    }
    async fn setup_with_ownership(
        busy: bool,
        guarded: bool,
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        StructuredSessionManager,
        String,
    ) {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        if guarded {
            rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        }
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        #[cfg(unix)]
        if guarded {
            manager.bind_live_ownership().unwrap();
        }
        let snapshot = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                Some("Queue fixture"),
            )
            .await
            .unwrap();
        if busy {
            let session = manager
                .owned_session("owner", &snapshot.id)
                .await
                .unwrap()
                .unwrap();
            let mut state = session.state.lock().await;
            state.process = Some(Arc::new(Busy));
            state.generation = 7;
        }
        (data, workspace, manager, snapshot.id)
    }
    async fn enqueue(manager: &StructuredSessionManager, id: &str, text: &str) -> MutationReceipt {
        let snapshot = manager.queue_snapshot("owner", id).await.unwrap();
        manager
            .queue_mutate(
                "owner",
                id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: snapshot.revision,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: text.into(),
                        run_when_idle: true,
                    },
                },
            )
            .await
            .unwrap()
    }
    fn scope(workspace: &Path, id: &str) -> QueueScope {
        QueueScope::new("owner", workspace, id).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn approved_background_investigation_delivers_verified_read_only_result() {
        use crate::v4_agent::interaction::{ActionScope, ApprovalRequest, Interaction};
        use axum::{routing::post, Json, Router};
        struct Allow;
        #[async_trait::async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
                Ok(true)
            }
        }
        let requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = Router::new().fallback(post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(if requests.len() == 1 {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[
                        {"id":"write","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"notes\",\"content\":\"changed\"}"}},
                        {"id":"read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes\"}"}}
                    ]}}]})
                } else {
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Verified investigation result"}}]})
                })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let parent_requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured_parent = parent_requests.clone();
        let parent_router = Router::new().fallback(post(move |Json(body): Json<Value>| {
            let captured = captured_parent.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(if requests.len() == 1 {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"delegate","type":"function","function":{"name":"delegate_task_background","arguments":"{\"prompt\":\"Inspect notes\"}"}}]}}]})
                } else {
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Investigation started"}}]})
                })
            }
        }));
        let parent_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let parent_address = parent_listener.local_addr().unwrap();
        let parent_server =
            tokio::spawn(async move { axum::serve(parent_listener, parent_router).await.unwrap() });
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("notes"), "original").unwrap();
        let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        db.execute_batch("CREATE TABLE api_key_vault(user_id TEXT, key_name TEXT, key_value TEXT, created_at TEXT)").unwrap();
        let key =
            crate::vault::encrypt_secret("fixture-provider-key", "fixture-vault-key").unwrap();
        db.execute(
            "INSERT INTO api_key_vault VALUES(?1,?2,?3,'2020')",
            rusqlite::params!["owner", "terminal-v4:provider:deepseek", key],
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
        manager
            .bind_delegation_supervisor(supervisor.clone())
            .unwrap();
        let snapshot = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let live = manager
            .owned_session("owner", &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let resources = {
            let mut state = live.state.lock().await;
            state.process = Some(Arc::new(Busy));
            state.generation = 7;
            state.resources.clone()
        };
        let root = workspace.path().canonicalize().unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: snapshot.id.clone(),
            turn_id: Uuid::new_v4().to_string(),
        };
        let turn = Arc::new(
            crate::v4_agent::delegation_outbox::DelegationTurn::new(
                manager.clone(),
                supervisor,
                scope.clone(),
                7,
            )
            .unwrap(),
        );
        resources.bind_delegation(&turn).unwrap();
        let fixture_data = data.path().to_path_buf();
        let fixture_workspace = root.clone();
        turn.set_test_command(move |command| {
            let args: Vec<String> = command.as_std().get_args().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
            let output = fixture_data.join("fixture-output.jsonl");
            let mut fixture = tokio::process::Command::new("/bin/sh");
            fixture.arg("-c").arg("\"$1\" --exact v4_agent::delegation_outbox::tests::provider_child_fixture --nocapture >/dev/null; status=$?; cat \"$V4_DELEGATION_FIXTURE_OUTPUT\"; exit \"$status\"")
                .arg("fixture").arg(std::env::current_exe().unwrap())
                .current_dir(fixture_workspace)
                .env("V4_DELEGATION_FIXTURE_ARGS", serde_json::to_string(&args).unwrap())
                .env("V4_DELEGATION_FIXTURE_DATA", &fixture_data)
                .env("V4_DELEGATION_FIXTURE_OUTPUT", output)
                .env("VAULT_ENCRYPTION_KEY", "fixture-vault-key")
                .env("DEEPSEEK_BASE_URL", format!("http://{address}/v1"))
                .env("NO_PROXY", "*");
            *command = fixture;
        });
        let mut session: crate::v4_agent::Session = serde_json::from_value(json!({
            "id": super::super::engine_session_id(&snapshot.id).unwrap(), "provider":"deepseek", "model":"deepseek-chat", "workspace":root.to_str().unwrap(), "messages":[], "history":[], "updated_at":""
        })).unwrap();
        let output = crate::v4_agent::test_background_provider_turn(
            format!("http://{parent_address}"),
            data.path(),
            &mut session,
            scope.clone(),
            resources.clone(),
            &Allow,
            None,
        )
        .await
        .unwrap();
        assert_eq!(output, "Investigation started");
        let parent_seen = parent_requests.lock().unwrap();
        assert_eq!(parent_seen.len(), 2);
        assert!(parent_seen[0]["tools"]
            .to_string()
            .contains("delegate_task_background"));
        assert!(parent_seen[1]
            .to_string()
            .contains("\\\"status\\\":\\\"running\\\""));
        drop(parent_seen);
        let queue_scope = QueueScope::new("owner", &root, &snapshot.id).unwrap();
        let item = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if let Some(item) = store(&manager).load(&queue_scope).unwrap().items.first() {
                    break item.text.clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            store(&manager).load(&queue_scope).unwrap().mode,
            QueueMode::Held
        );
        assert!(item.contains("Verified investigation result"));
        assert_eq!(
            std::fs::read_to_string(root.join("notes")).unwrap(),
            "original"
        );
        let seen = requests.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[1]
            .to_string()
            .contains("Tool denied by read-only child policy"));
        assert!(seen[1].to_string().contains("original"));
        drop(seen);
        live.state.lock().await.process = None;
        drop(live);
        manager.shutdown().await.unwrap();
        server.abort();
        parent_server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_delegation_checks_approval_and_delivers_interrupted_child() {
        use crate::v4_agent::interaction::{
            ActionScope, ApprovalRequest, Cancellation, Interaction,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Deny(AtomicUsize);
        #[async_trait::async_trait]
        impl Interaction for Deny {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(false)
            }
        }
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        #[cfg(feature = "queued-authority-preview")]
        let app = crate::state::AppState::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        #[cfg(feature = "queued-authority-preview")]
        manager
            .bind_local_admission(app.local_admission().unwrap())
            .unwrap();
        #[cfg(feature = "queued-authority-preview")]
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        #[cfg(feature = "queued-authority-preview")]
        let authority = Some(&authority);
        #[cfg(not(feature = "queued-authority-preview"))]
        let authority = None;
        let supervisor =
            crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap();
        manager
            .bind_delegation_supervisor(supervisor.clone())
            .unwrap();
        let snapshot = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let live = manager
            .owned_session("owner", &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let resources = {
            let mut state = live.state.lock().await;
            state.process = Some(Arc::new(Busy));
            state.generation = 7;
            state.resources.clone()
        };
        let root = workspace.path().canonicalize().unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: snapshot.id.clone(),
            turn_id: Uuid::new_v4().to_string(),
        };
        let turn = Arc::new(
            crate::v4_agent::delegation_outbox::DelegationTurn::new(
                manager.clone(),
                supervisor,
                scope.clone(),
                7,
            )
            .unwrap(),
        );
        let session: crate::v4_agent::Session = serde_json::from_value(json!({
            "id": super::super::engine_session_id(&snapshot.id).unwrap(), "provider":"deepseek", "model":"deepseek-chat", "workspace":root.to_str().unwrap(), "messages":[], "history":[], "updated_at":""
        })).unwrap();
        let deny = Deny(AtomicUsize::new(0));
        let mut wrong = scope.clone();
        wrong.turn_id = Uuid::new_v4().to_string();
        assert!(turn
            .execute(
                data.path(),
                &session,
                "call",
                &json!({"prompt":"Inspect"}),
                crate::v4_agent::delegation_outbox::DelegationInvocation {
                    scope: &wrong,
                    interaction: &deny,
                    cancellation: &Cancellation::default(),
                    resources: &resources,
                    authority,
                },
            )
            .await
            .is_err());
        assert_eq!(deny.0.load(Ordering::SeqCst), 0);
        assert!(store(&manager)
            .inspect(&QueueScope::new("owner", &root, &snapshot.id).unwrap())
            .unwrap()
            .is_none());
        assert!(turn
            .execute(
                data.path(),
                &session,
                "call",
                &json!({"prompt":"Inspect"}),
                crate::v4_agent::delegation_outbox::DelegationInvocation {
                    scope: &scope,
                    interaction: &deny,
                    cancellation: &Cancellation::default(),
                    resources: &resources,
                    authority,
                },
            )
            .await
            .is_err());
        assert_eq!(deny.0.load(Ordering::SeqCst), 1);
        assert!(!data.path().join("workspace-tasks").exists());
        assert!(!data.path().join("queue-authority.key").exists());
        assert!(!data.path().join("queue-authority.installation").exists());

        struct Allow;
        #[async_trait::async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
                Ok(())
            }
            async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
                assert_eq!(request.tool_name, "delegate_task_background");
                Ok(true)
            }
        }
        #[cfg(feature = "queued-authority-preview")]
        {
            struct CancelApproval(Cancellation);
            #[async_trait::async_trait]
            impl Interaction for CancelApproval {
                async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
                    Ok(())
                }
                async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
                    self.0.cancel();
                    Ok(true)
                }
            }
            let cancelled = Cancellation::default();
            assert!(turn
                .execute(
                    data.path(),
                    &session,
                    "cancelled-call",
                    &json!({"prompt":"Inspect"}),
                    crate::v4_agent::delegation_outbox::DelegationInvocation {
                        scope: &scope,
                        interaction: &CancelApproval(cancelled.clone()),
                        cancellation: &cancelled,
                        resources: &resources,
                        authority,
                    }
                )
                .await
                .is_err());
            assert!(!data.path().join("queue-authority.installation").exists());
            assert!(!data.path().join("queue-authority.key").exists());
            app.logout_user("owner").unwrap();
            assert!(turn
                .execute(
                    data.path(),
                    &session,
                    "revoked-call",
                    &json!({"prompt":"Inspect"}),
                    crate::v4_agent::delegation_outbox::DelegationInvocation {
                        scope: &scope,
                        interaction: &Allow,
                        cancellation: &Cancellation::default(),
                        resources: &resources,
                        authority,
                    }
                )
                .await
                .is_err());
            assert!(!data.path().join("queue-authority.installation").exists());
            assert!(!data.path().join("queue-authority.key").exists());
        }
        #[cfg(feature = "queued-authority-preview")]
        let refreshed = crate::auth::LocalAuthority::for_test(
            "owner",
            1,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        #[cfg(feature = "queued-authority-preview")]
        let authority = Some(&refreshed);
        let output = turn
            .execute(
                data.path(),
                &session,
                "approved-call",
                &json!({"prompt":"Inspect"}),
                crate::v4_agent::delegation_outbox::DelegationInvocation {
                    scope: &scope,
                    interaction: &Allow,
                    cancellation: &Cancellation::default(),
                    resources: &resources,
                    authority,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&output).unwrap()["status"],
            "running"
        );
        #[cfg(feature = "queued-authority-preview")]
        assert!(data.path().join("queue-authority.installation").is_file());
        let queue_scope = QueueScope::new("owner", &root, &snapshot.id).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let snapshot = store(&manager).load(&queue_scope).unwrap();
                if let Some(item) = snapshot.items.first() {
                    break (snapshot.mode, item.text.clone());
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        #[cfg(feature = "queued-authority-preview")]
        assert_eq!(result.0, QueueMode::Running);
        #[cfg(not(feature = "queued-authority-preview"))]
        assert_eq!(result.0, QueueMode::Held);
        assert!(result.1.contains("interrupted"));
        live.state.lock().await.process = None;
        drop(live);
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delegation_only_enables_a_new_queue_without_unrelated_pending_items() {
        let (_data, workspace, manager, id) = setup_with_ownership(true, true).await;
        let workspace = workspace.path().canonicalize().unwrap();
        let queue_scope = scope(&workspace, &id);
        let queue = store(&manager);
        let identity = queue.ensure_delegation_identity(&queue_scope).unwrap();
        let child = Uuid::new_v4();
        let incarnation = manager.session_incarnation_for_test("owner", &id).await;
        let target = |identity, incarnation| DelegationQueueTarget {
            identity,
            operation: child,
            generation: 7,
            incarnation,
        };
        let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
        live.state.lock().await.generation = 8;
        assert!(manager
            .activate_delegation_delivery(
                "owner",
                &id,
                &workspace,
                target(identity, incarnation),
                &crate::v4_agent::interaction::Cancellation::default()
            )
            .await
            .is_err());
        live.state.lock().await.generation = 7;
        assert!(manager
            .activate_delegation_delivery(
                "owner",
                &id,
                &workspace,
                target(Uuid::new_v4(), incarnation),
                &crate::v4_agent::interaction::Cancellation::default()
            )
            .await
            .is_err());
        let cancelled = crate::v4_agent::interaction::Cancellation::default();
        cancelled.cancel();
        assert!(manager
            .activate_delegation_delivery(
                "owner",
                &id,
                &workspace,
                target(identity, incarnation),
                &cancelled
            )
            .await
            .is_err());
        assert_eq!(
            queue.load(&queue_scope).unwrap().hold_reason,
            Some(HoldReason::New)
        );
        let cancellation = crate::v4_agent::interaction::Cancellation::default();
        assert!(manager
            .activate_delegation_delivery(
                "owner",
                &id,
                &workspace,
                target(identity, incarnation),
                &cancellation
            )
            .await
            .unwrap());
        let running = queue.load(&queue_scope).unwrap();
        assert_eq!(
            (running.mode, running.hold_reason),
            (QueueMode::Running, None)
        );
        queue
            .mutate(
                &queue_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: running.revision,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        assert!(!manager
            .activate_delegation_delivery(
                "owner",
                &id,
                &workspace,
                target(identity, incarnation),
                &cancellation
            )
            .await
            .unwrap());
        assert_eq!(
            queue.load(&queue_scope).unwrap().hold_reason,
            Some(HoldReason::Manual)
        );

        let (_other_data, other_workspace, other_manager, other_id) =
            setup_with_ownership(true, true).await;
        let other_workspace = other_workspace.path().canonicalize().unwrap();
        let other_scope = scope(&other_workspace, &other_id);
        let other_queue = store(&other_manager);
        other_queue
            .mutate(
                &other_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "Keep this pending".into(),
                        run_when_idle: false,
                    },
                },
            )
            .unwrap();
        let other_identity = other_queue
            .ensure_delegation_identity(&other_scope)
            .unwrap();
        assert!(!other_manager
            .activate_delegation_delivery(
                "owner",
                &other_id,
                &other_workspace,
                target(
                    other_identity,
                    other_manager
                        .session_incarnation_for_test("owner", &other_id)
                        .await
                ),
                &cancellation
            )
            .await
            .unwrap());
        let pending = other_queue.load(&other_scope).unwrap();
        assert_eq!(
            (pending.mode, pending.hold_reason, pending.items.len()),
            (QueueMode::Held, Some(HoldReason::New), 1)
        );

        let (_early_data, early_workspace, early_manager, early_id) =
            setup_with_ownership(true, true).await;
        let early_workspace = early_workspace.path().canonicalize().unwrap();
        let early_scope = scope(&early_workspace, &early_id);
        let early_queue = store(&early_manager);
        early_queue
            .mutate(
                &early_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: child,
                        text: "Early child result".into(),
                        run_when_idle: false,
                    },
                },
            )
            .unwrap();
        let early_identity = early_queue
            .ensure_delegation_identity(&early_scope)
            .unwrap();
        assert!(early_manager
            .activate_delegation_delivery(
                "owner",
                &early_id,
                &early_workspace,
                target(
                    early_identity,
                    early_manager
                        .session_incarnation_for_test("owner", &early_id)
                        .await
                ),
                &cancellation
            )
            .await
            .unwrap());
        assert_eq!(
            early_queue.load(&early_scope).unwrap().mode,
            QueueMode::Running
        );

        let (restart_data, restart_workspace, restart_manager, restart_id) =
            setup_with_ownership(true, true).await;
        let restart_workspace = restart_workspace.path().canonicalize().unwrap();
        let restart_scope = scope(&restart_workspace, &restart_id);
        let restart_queue = store(&restart_manager);
        let restart_identity = restart_queue
            .ensure_delegation_identity(&restart_scope)
            .unwrap();
        QueueStore::new(restart_data.path(), Uuid::new_v4())
            .load(&restart_scope)
            .unwrap();
        assert!(!restart_manager
            .activate_delegation_delivery(
                "owner",
                &restart_id,
                &restart_workspace,
                target(
                    restart_identity,
                    restart_manager
                        .session_incarnation_for_test("owner", &restart_id)
                        .await
                ),
                &cancellation
            )
            .await
            .unwrap());
        assert_eq!(
            restart_queue.load(&restart_scope).unwrap().hold_reason,
            Some(HoldReason::Restart)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delegation_queue_admission_requires_the_current_owned_turn() {
        let (_data, workspace, manager, id) = setup_with_ownership(true, true).await;
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let resources = session.state.lock().await.resources.clone();
        let workspace = workspace.path().canonicalize().unwrap();
        for (owner, generation, supplied_resources) in [
            ("other", 7, resources.clone()),
            ("owner", 6, resources.clone()),
            (
                "owner",
                7,
                Arc::new(crate::v4_agent::interaction::TurnResources::default()),
            ),
        ] {
            assert!(manager
                .prepare_delegation_queue(owner, &id, &workspace, generation, &supplied_resources)
                .await
                .is_err());
        }
        let queue_scope = scope(&workspace, &id);
        assert!(store(&manager).inspect(&queue_scope).unwrap().is_none());
        let other_workspace = tempfile::tempdir().unwrap();
        assert!(manager
            .prepare_delegation_queue(
                "owner",
                &id,
                &other_workspace.path().canonicalize().unwrap(),
                7,
                &resources,
            )
            .await
            .is_err());
        assert!(store(&manager).inspect(&queue_scope).unwrap().is_none());
        let identity = manager
            .prepare_delegation_queue("owner", &id, &workspace, 7, &resources)
            .await
            .unwrap();
        assert_eq!(
            store(&manager)
                .snapshot_existing_with_identity(&queue_scope, identity)
                .unwrap()
                .hold_reason,
            Some(HoldReason::New)
        );
        session.state.lock().await.process = None;
        assert!(manager
            .prepare_delegation_queue("owner", &id, &workspace, 7, &resources)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delegated_launch_holds_parent_lifecycle_until_admission_finishes() {
        let (data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let data_path = data.path().canonicalize().unwrap();
        let workspace_path = workspace.path().canonicalize().unwrap();
        let queue = store(&manager);
        let queue_scope = scope(&workspace_path, &id);
        queue.load(&queue_scope).unwrap();
        let identity = queue
            .ensure_existing_identity(&queue_scope)
            .unwrap()
            .unwrap();
        let wrong_workspace = tempfile::tempdir().unwrap();
        let wrong_workspace_path = wrong_workspace.path().canonicalize().unwrap();
        let incarnation = manager.session_incarnation_for_test("owner", &id).await;
        for (owner, path, queue_id) in [
            ("other", workspace_path.as_path(), identity),
            ("owner", wrong_workspace_path.as_path(), identity),
            ("owner", workspace_path.as_path(), Uuid::new_v4()),
        ] {
            assert!(manager
                .with_bound_parent_launch(
                    owner,
                    &data_path,
                    &id,
                    path,
                    queue_id,
                    incarnation,
                    &crate::v4_agent::interaction::Cancellation::default(),
                    || async {
                        panic!("Mismatched parent scope must not admit a child");
                        #[allow(unreachable_code)]
                        Ok::<(), String>(())
                    }
                )
                .await
                .is_err());
        }
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let launch_manager = manager.clone();
        let launch_id = id.clone();
        let launch_data = data_path.clone();
        let launch_workspace = workspace_path.clone();
        let launch = tokio::spawn(async move {
            launch_manager
                .with_bound_parent_launch(
                    "owner",
                    &launch_data,
                    &launch_id,
                    &launch_workspace,
                    identity,
                    incarnation,
                    &crate::v4_agent::interaction::Cancellation::default(),
                    || async move {
                        entered.send(()).unwrap();
                        release_rx
                            .await
                            .map_err(|_| "Launch cancelled".to_string())?;
                        Ok(())
                    },
                )
                .await
        });
        entered_rx.await.unwrap();
        let delete_manager = manager.clone();
        let delete_id = id.clone();
        let mut deletion =
            tokio::spawn(async move { delete_manager.delete_session("owner", &delete_id).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut deletion)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        launch.await.unwrap().unwrap();
        deletion.await.unwrap().unwrap();
        assert!(manager
            .with_bound_parent_launch(
                "owner",
                &data_path,
                &id,
                &workspace_path,
                identity,
                incarnation,
                &crate::v4_agent::interaction::Cancellation::default(),
                || async {
                    panic!("Deleted parent must not admit a child");
                    #[allow(unreachable_code)]
                    Ok::<(), String>(())
                },
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn native_admission_prototype_fences_queued_input_without_creating_unused_storage() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        let snapshot = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("codex"),
                None,
                None,
            )
            .await
            .unwrap();
        assert!(manager
            .owned_session("other", &snapshot.id)
            .await
            .unwrap()
            .is_none());
        let session = manager
            .owned_session("owner", &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let mut state = session.state.lock().await;
        let uuid = Uuid::parse_str(state.id.strip_prefix("ss-").unwrap()).unwrap();
        state.id = format!("ss-{}", uuid.hyphenated());
        let direct_id = Uuid::new_v4().to_string();
        check_native_admission_prototype(&manager, &state, &direct_id, "direct").unwrap();
        assert!(!data.path().join("followup-queues").exists());

        let native_scope =
            QueueScope::new_native(&state.user_id, workspace.path(), &state.id).unwrap();
        let store = store(&manager);
        store
            .mutate(
                &native_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "queued".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        assert_eq!(
            check_native_admission_prototype(&manager, &state, &direct_id, "direct")
                .unwrap_err()
                .code,
            "conflict"
        );

        let revision = store.load(&native_scope).unwrap().revision;
        let reservation = store
            .reserve_next(
                &native_scope,
                revision,
                IdleBoundary {
                    turn_epoch: state.generation,
                },
            )
            .unwrap()
            .unwrap();
        let request_id = reservation.input_request_id.to_string();
        assert!(check_native_admission_prototype(&manager, &state, &request_id, "queued").is_err());
        let permit = install_permit(
            key(&manager, &state.user_id, &state.id),
            Permit {
                request_id: reservation.input_request_id,
                generation: state.generation,
            },
        )
        .unwrap();
        check_native_admission_prototype(&manager, &state, &request_id, "queued").unwrap();
        assert!(
            check_native_admission_prototype(&manager, &state, &request_id, "changed").is_err()
        );
        state.generation += 1;
        assert!(check_native_admission_prototype(&manager, &state, &request_id, "queued").is_err());
        drop(permit);
    }

    #[tokio::test]
    async fn native_admission_prototype_requires_review_after_restart_without_mutating_queue() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        let snapshot = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("codex"),
                None,
                None,
            )
            .await
            .unwrap();
        let session = manager
            .owned_session("owner", &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let state = session.state.lock().await;
        let native_scope =
            QueueScope::new_native(&state.user_id, workspace.path(), &state.id).unwrap();
        let previous_boot = Uuid::new_v4();
        assert_ne!(previous_boot, boot_id());
        let previous_store = QueueStore::new(data.path(), previous_boot);
        previous_store
            .mutate(
                &native_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "queued before restart".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        let before = previous_store.inspect(&native_scope).unwrap().unwrap();
        let request_id = Uuid::new_v4().to_string();
        assert_eq!(
            check_native_admission_prototype(&manager, &state, &request_id, "new direct input")
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(previous_store.inspect(&native_scope).unwrap(), Some(before));
        let current_store = store(&manager);
        let held = current_store.load(&native_scope).unwrap();
        assert_eq!(held.hold_reason, Some(HoldReason::Restart));
        current_store
            .mutate(
                &native_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: held.revision,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        check_native_admission_prototype(&manager, &state, &request_id, "new direct input")
            .unwrap();
    }
    async fn committed_retry_fixture(
        manager: &StructuredSessionManager,
        workspace: &Path,
        id: &str,
    ) -> (Mutation, MutationReceipt, QueueSnapshot) {
        let store = store(manager);
        let scope = scope(workspace, id);
        let mutation = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 0,
            operation: QueueOperation::Enqueue {
                item_id: Uuid::new_v4(),
                text: "retry fixture".into(),
                run_when_idle: true,
            },
        };
        // Model interruption after the durable mutation and before scheduling.
        let receipt = store.mutate(&scope, mutation.clone()).unwrap();
        let snapshot = store.load(&scope).unwrap();
        // A canonical acceptance makes any attempted delivery local and also
        // exercises request-id deduplication without starting a provider worker.
        manager
            .record_event(
                "owner",
                id,
                StructuredSessionEvent::UserMessageAccepted {
                    ts: 1,
                    seq: 0,
                    request_id: snapshot.items[0].input_request_id.to_string(),
                    turn_id: Uuid::new_v4().to_string(),
                    message_id: Uuid::new_v4().to_string(),
                    content: "retry fixture".into(),
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        (mutation, receipt, snapshot)
    }
    async fn finish_queued_drains(manager: &StructuredSessionManager, id: &str) {
        let queue_gate = gate(manager, "owner", id).unwrap();
        let guard = queue_gate.lock().await;
        tokio::task::yield_now().await;
        drop(guard);
        let _guard = queue_gate.lock().await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn bound_delivery_wakes_running_idle_parent_once() {
        let (data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let (_, _, before) = committed_retry_fixture(&manager, workspace.path(), &id).await;
        let queue = store(&manager);
        let queue_scope = scope(workspace.path(), &id);
        let identity = queue
            .ensure_existing_identity(&queue_scope)
            .unwrap()
            .unwrap();
        for _ in 0..2 {
            manager
                .with_bound_parent_queue(
                    "owner",
                    &data.path().canonicalize().unwrap(),
                    &id,
                    &workspace.path().canonicalize().unwrap(),
                    identity,
                    |_, _, _, _| Ok(()),
                )
                .await
                .unwrap();
        }
        finish_queued_drains(&manager, &id).await;
        let after = queue.load(&queue_scope).unwrap();
        assert_eq!(after.items.len(), 1);
        assert_eq!(after.items[0].state, ItemState::Accepted);
        assert_eq!(
            after.items[0].input_request_id,
            before.items[0].input_request_id
        );
        assert!(after.order.is_empty());
        let session = manager.get_session("owner", &id).await.unwrap().unwrap();
        assert_eq!(session.events.iter().filter(|event| matches!(event, StructuredSessionEvent::UserMessageAccepted { request_id, .. } if request_id == &before.items[0].input_request_id.to_string())).count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_or_busy_bound_delivery_does_not_wake_parent() {
        for busy in [false, true] {
            let (data, workspace, manager, id) = setup_with_ownership(busy, true).await;
            let (_, _, before) = committed_retry_fixture(&manager, workspace.path(), &id).await;
            let queue = store(&manager);
            let queue_scope = scope(workspace.path(), &id);
            let identity = queue
                .ensure_existing_identity(&queue_scope)
                .unwrap()
                .unwrap();
            let result = manager
                .with_bound_parent_queue(
                    "owner",
                    &data.path().canonicalize().unwrap(),
                    &id,
                    &workspace.path().canonicalize().unwrap(),
                    identity,
                    |_, _, _, _| {
                        if busy {
                            Ok(())
                        } else {
                            Err("not committed".into())
                        }
                    },
                )
                .await;
            assert_eq!(result.is_ok(), busy);
            finish_queued_drains(&manager, &id).await;
            let after = queue.load(&queue_scope).unwrap();
            assert_eq!(after.items[0].state, ItemState::Pending);
            assert_eq!(after.order, before.order);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bound_delivery_does_not_schedule_a_wakeup_after_shutdown_begins() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let session = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                Some("Queue fixture"),
            )
            .await
            .unwrap();
        let (_, _, before) = committed_retry_fixture(&manager, workspace.path(), &session.id).await;
        let queue = store(&manager);
        let queue_scope = scope(workspace.path(), &session.id);
        let identity = queue
            .ensure_existing_identity(&queue_scope)
            .unwrap()
            .unwrap();
        let ownership = manager.inner.live_ownership.get().unwrap();
        manager
            .with_bound_parent_queue(
                "owner",
                &data.path().canonicalize().unwrap(),
                &session.id,
                &workspace.path().canonicalize().unwrap(),
                identity,
                |_, _, _, _| {
                    ownership.admission.close()?;
                    Ok(())
                },
            )
            .await
            .unwrap();
        finish_queued_drains(&manager, &session.id).await;
        let after = queue.load(&queue_scope).unwrap();
        assert_eq!(after.items[0].state, ItemState::Pending);
        assert_eq!(after.order, before.order);
        ownership.admission.reopen();
        manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn committed_retry_wakes_running_idle_queue_once() {
        let (_data, workspace, manager, id) = setup(false).await;
        let (mutation, receipt, before) =
            committed_retry_fixture(&manager, workspace.path(), &id).await;
        assert_eq!(
            manager
                .queue_mutate("owner", &id, mutation.clone())
                .await
                .unwrap(),
            receipt
        );
        assert_eq!(
            manager.queue_mutate("owner", &id, mutation).await.unwrap(),
            receipt
        );
        finish_queued_drains(&manager, &id).await;
        let after = store(&manager).load(&scope(workspace.path(), &id)).unwrap();
        assert_eq!(after.items.len(), 1);
        assert_eq!(after.items[0].state, ItemState::Accepted);
        assert_eq!(
            after.items[0].input_request_id,
            before.items[0].input_request_id
        );
        assert!(after.order.is_empty());
        let session = manager.get_session("owner", &id).await.unwrap().unwrap();
        assert_eq!(session.events.iter().filter(|event| matches!(event, StructuredSessionEvent::UserMessageAccepted { request_id, .. } if request_id == &before.items[0].input_request_id.to_string())).count(), 1);
    }
    #[tokio::test]
    async fn explicit_wake_holds_unproven_work_without_replaying_accepted_work() {
        let (_data, workspace, manager, id) = setup(false).await;
        let (_, _, before) = committed_retry_fixture(&manager, workspace.path(), &id).await;
        let wake = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: before.revision,
            operation: QueueOperation::Wake,
        };
        let receipt = manager
            .queue_mutate("owner", &id, wake.clone())
            .await
            .unwrap();
        assert_eq!(
            manager.queue_mutate("owner", &id, wake).await.unwrap(),
            receipt
        );
        finish_queued_drains(&manager, &id).await;
        let after = store(&manager).load(&scope(workspace.path(), &id)).unwrap();
        assert_eq!(after.items.len(), 1);
        assert_eq!(
            (after.mode, after.hold_reason),
            (QueueMode::Held, Some(HoldReason::DispatchError))
        );
        assert_eq!(after.items[0].state, ItemState::Pending);
        assert_eq!(
            after.items[0].input_request_id,
            before.items[0].input_request_id
        );
        let session = manager.get_session("owner", &id).await.unwrap().unwrap();
        assert_eq!(session.events.iter().filter(|event| matches!(event, StructuredSessionEvent::UserMessageAccepted { request_id, .. } if request_id == &before.items[0].input_request_id.to_string())).count(), 1);
    }
    #[tokio::test]
    async fn committed_wake_retry_never_dispatches_new_unproven_work() {
        let (_data, workspace, manager, id) = setup(false).await;
        let scope = scope(workspace.path(), &id);
        let queue = store(&manager);
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Resume,
                },
            )
            .unwrap();
        let wake = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 1,
            operation: QueueOperation::Wake,
        };
        let receipt = manager
            .queue_mutate("owner", &id, wake.clone())
            .await
            .unwrap();
        finish_queued_drains(&manager, &id).await;
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 2,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "later work".into(),
                        run_when_idle: false,
                    },
                },
            )
            .unwrap();
        let before = queue.load(&scope).unwrap();
        manager
            .record_event(
                "owner",
                &id,
                StructuredSessionEvent::UserMessageAccepted {
                    ts: 1,
                    seq: 0,
                    request_id: before.items[0].input_request_id.to_string(),
                    turn_id: Uuid::new_v4().to_string(),
                    message_id: Uuid::new_v4().to_string(),
                    content: "later work".into(),
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        let error = manager.queue_mutate("owner", &id, wake).await.unwrap_err();
        assert_eq!(error.code, "unavailable");
        assert_eq!(
            queue
                .verify_operation_receipt(
                    &scope,
                    &Mutation {
                        operation_id: receipt.operation_id,
                        expected_queue_revision: 1,
                        operation: QueueOperation::Wake
                    }
                )
                .unwrap(),
            Some(receipt)
        );
        finish_queued_drains(&manager, &id).await;
        let after = queue.load(&scope).unwrap();
        assert_eq!(
            (after.mode, after.hold_reason, after.items[0].state),
            (QueueMode::Running, None, ItemState::Pending)
        );
        assert_eq!(
            after.items[0].input_request_id,
            before.items[0].input_request_id
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn scheduled_wake_does_not_dispatch_work_added_after_its_commit() {
        let (_data, workspace, manager, id) = setup(false).await;
        let scope = scope(workspace.path(), &id);
        let queue = store(&manager);
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Resume,
                },
            )
            .unwrap();
        let wake = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 1,
            operation: QueueOperation::Wake,
        };
        manager.queue_mutate("owner", &id, wake).await.unwrap();
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let guard = queue_gate.try_lock().unwrap();
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 2,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "arrived after wake".into(),
                        run_when_idle: false,
                    },
                },
            )
            .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        session.state.lock().await.model = Some(String::new());
        drop(session);
        drop(guard);
        tokio::task::yield_now().await;
        finish_queued_drains(&manager, &id).await;
        let after = queue.load(&scope).unwrap();
        assert_eq!(
            (after.mode, after.hold_reason, after.items[0].state),
            (QueueMode::Running, None, ItemState::Pending)
        );
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
    }
    #[tokio::test]
    async fn committed_wake_retry_never_releases_a_new_hold() {
        for reason in [HoldReason::Manual, HoldReason::Restart] {
            let (data, workspace, manager, id) = setup(false).await;
            let scope = scope(workspace.path(), &id);
            let queue = store(&manager);
            queue
                .mutate(
                    &scope,
                    Mutation {
                        operation_id: Uuid::new_v4(),
                        expected_queue_revision: 0,
                        operation: QueueOperation::Resume,
                    },
                )
                .unwrap();
            let wake = Mutation {
                operation_id: Uuid::new_v4(),
                expected_queue_revision: 1,
                operation: QueueOperation::Wake,
            };
            manager
                .queue_mutate("owner", &id, wake.clone())
                .await
                .unwrap();
            finish_queued_drains(&manager, &id).await;
            if reason == HoldReason::Manual {
                queue.hold(&scope, reason).unwrap();
            } else {
                QueueStore::new(data.path(), Uuid::new_v4())
                    .load(&scope)
                    .unwrap();
            }
            let held = queue.load(&scope).unwrap();
            assert_eq!(held.hold_reason, Some(reason));
            assert_eq!(
                manager
                    .queue_mutate("owner", &id, wake)
                    .await
                    .unwrap_err()
                    .code,
                "unavailable"
            );
            finish_queued_drains(&manager, &id).await;
            assert_eq!(queue.load(&scope).unwrap(), held);
        }
    }
    #[tokio::test]
    async fn explicit_wake_never_releases_manual_or_restart_holds() {
        for reason in [HoldReason::Manual, HoldReason::Restart] {
            let (data, workspace, manager, id) = setup(false).await;
            committed_retry_fixture(&manager, workspace.path(), &id).await;
            let scope = scope(workspace.path(), &id);
            if reason == HoldReason::Manual {
                store(&manager).hold(&scope, reason).unwrap();
            } else {
                QueueStore::new(data.path(), Uuid::new_v4())
                    .load(&scope)
                    .unwrap();
            }
            let held = store(&manager).load(&scope).unwrap();
            let wake = Mutation {
                operation_id: Uuid::new_v4(),
                expected_queue_revision: held.revision,
                operation: QueueOperation::Wake,
            };
            assert_eq!(
                manager
                    .queue_mutate("owner", &id, wake)
                    .await
                    .unwrap_err()
                    .code,
                "conflict"
            );
            finish_queued_drains(&manager, &id).await;
            assert_eq!(store(&manager).load(&scope).unwrap(), held);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_wake_holds_unproven_queue_before_logout_or_admission() {
        let (data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let app = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let generation = session.state.lock().await.generation;
        drop(session);
        let queue_scope = scope(workspace.path(), &id);
        store(&manager)
            .mutate(
                &queue_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "unproven work".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        manager
            .queue_mutate_authorized(
                "owner",
                &id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 1,
                    operation: QueueOperation::Wake,
                },
                Some(&authority),
                None,
                Some(&app),
            )
            .await
            .unwrap();
        app.logout_user("owner").unwrap();
        drain(manager.clone(), "owner".into(), id.clone(), generation)
            .await
            .unwrap();
        let queue = store(&manager).load(&queue_scope).unwrap();
        assert_eq!(
            (queue.mode, queue.hold_reason, queue.items[0].state),
            (
                QueueMode::Held,
                Some(HoldReason::DispatchError),
                ItemState::Pending
            )
        );
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
        manager.shutdown().await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_wake_http_holds_unproven_queue_and_rejects_a_held_retry() {
        let (data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let app_state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let queue_scope = scope(workspace.path(), &id);
        store(&manager)
            .mutate(
                &queue_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "unproven work".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        let app = routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(app_state);
        let request = |revision| {
            Request::builder().method("POST")
            .uri(format!("/api/structured/sessions/{id}/queue"))
            .header("content-type", "application/json")
            .body(Body::from(json!({"operationId": Uuid::new_v4(), "expectedQueueRevision": revision, "operation": {"kind": "wake"}}).to_string())).unwrap()
        };
        assert_eq!(
            app.clone().oneshot(request(1)).await.unwrap().status(),
            StatusCode::OK
        );
        let held = store(&manager).load(&queue_scope).unwrap();
        assert_eq!(
            (held.mode, held.hold_reason, held.items[0].state),
            (
                QueueMode::Held,
                Some(HoldReason::DispatchError),
                ItemState::Pending
            )
        );
        assert_eq!(
            app.oneshot(request(held.revision)).await.unwrap().status(),
            StatusCode::CONFLICT
        );
        assert_eq!(store(&manager).load(&queue_scope).unwrap(), held);
        manager.shutdown().await.unwrap();
    }
    #[cfg(all(unix, feature = "queued-authority-preview"))]
    #[tokio::test(flavor = "current_thread")]
    async fn explicit_wake_rechecks_item_authority_after_logout_before_admission() {
        let (data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let app = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        manager
            .bind_local_admission(app.local_admission().unwrap())
            .unwrap();
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let incarnation = session.state.lock().await.session_incarnation.unwrap().0;
        drop(session);
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let queue_scope = scope(workspace.path(), &id);
        store(&manager)
            .mutate_authorized(
                &queue_scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "guarded work".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        let wake = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 1,
            operation: QueueOperation::Wake,
        };
        manager.queue_mutate("owner", &id, wake).await.unwrap();
        let gate = gate(&manager, "owner", &id).unwrap();
        let guard = gate.try_lock().unwrap();
        app.logout_user("owner").unwrap();
        drop(guard);
        finish_queued_drains(&manager, &id).await;
        let queue = store(&manager).load(&queue_scope).unwrap();
        assert_eq!(
            (queue.mode, queue.hold_reason),
            (QueueMode::Held, Some(HoldReason::DispatchError))
        );
        assert_eq!(queue.items[0].state, ItemState::Pending);
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
        manager.shutdown().await.unwrap();
    }
    #[cfg(all(unix, feature = "queued-authority-preview"))]
    #[tokio::test(flavor = "current_thread")]
    async fn explicit_wake_can_retry_after_a_drain_fails_before_reservation() {
        use sha2::{Digest, Sha256};
        let (data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let app = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        manager
            .bind_local_admission(app.local_admission().unwrap())
            .unwrap();
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let incarnation = session.state.lock().await.session_incarnation.unwrap().0;
        drop(session);
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let queue_scope = scope(workspace.path(), &id);
        store(&manager)
            .mutate_authorized(
                &queue_scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "existing work".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        let before = store(&manager).load(&queue_scope).unwrap();
        manager
            .record_event(
                "owner",
                &id,
                StructuredSessionEvent::UserMessageAccepted {
                    ts: 1,
                    seq: 0,
                    request_id: before.items[0].input_request_id.to_string(),
                    turn_id: Uuid::new_v4().to_string(),
                    message_id: Uuid::new_v4().to_string(),
                    content: "existing work".into(),
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        let wake = |revision| Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: revision,
            operation: QueueOperation::Wake,
        };
        manager
            .queue_mutate("owner", &id, wake(before.revision))
            .await
            .unwrap();
        let gate = gate(&manager, "owner", &id).unwrap();
        let guard = gate.try_lock().unwrap();
        let queue_path = data
            .path()
            .join("followup-queues")
            .join(hex::encode(Sha256::digest(b"owner")))
            .join(hex::encode(Sha256::digest(
                workspace
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .as_bytes(),
            )))
            .join(format!("{id}.json"));
        let saved = std::fs::read(&queue_path).unwrap();
        std::fs::write(&queue_path, b"{").unwrap();
        drop(guard);
        tokio::task::yield_now().await;
        finish_queued_drains(&manager, &id).await;
        std::fs::write(&queue_path, saved).unwrap();
        let retry = store(&manager).load(&queue_scope).unwrap();
        assert_eq!(retry.items[0].state, ItemState::Pending);
        manager
            .queue_mutate("owner", &id, wake(retry.revision))
            .await
            .unwrap();
        finish_queued_drains(&manager, &id).await;
        let finished = store(&manager).load(&queue_scope).unwrap();
        assert_eq!(finished.items[0].state, ItemState::Accepted);
        assert_eq!(
            finished.items[0].input_request_id,
            before.items[0].input_request_id
        );
        assert_eq!(
            manager
                .get_session("owner", &id)
                .await
                .unwrap()
                .unwrap()
                .events
                .iter()
                .filter(|event| matches!(event, StructuredSessionEvent::UserMessageAccepted { .. }))
                .count(),
            1
        );
        manager.shutdown().await.unwrap();
    }
    #[cfg(all(unix, feature = "queued-authority-preview"))]
    #[tokio::test]
    async fn explicit_wake_waits_for_active_turn_before_dispatch() {
        let (data, workspace, manager, id) = setup_with_ownership(true, true).await;
        let app = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        manager
            .bind_local_admission(app.local_admission().unwrap())
            .unwrap();
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let incarnation = session.state.lock().await.session_incarnation.unwrap().0;
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let queue_scope = scope(workspace.path(), &id);
        store(&manager)
            .mutate_authorized(
                &queue_scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "later work".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        manager
            .queue_mutate(
                "owner",
                &id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 1,
                    operation: QueueOperation::Wake,
                },
            )
            .await
            .unwrap();
        finish_queued_drains(&manager, &id).await;
        let after = store(&manager).load(&queue_scope).unwrap();
        assert_eq!(
            (after.mode, after.items[0].state),
            (QueueMode::Running, ItemState::Pending)
        );
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
        session.state.lock().await.process = None;
        drop(session);
        manager.shutdown().await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_wake_reports_uncertainty_when_drain_admission_is_closed() {
        let (_data, workspace, manager, id) = setup_with_ownership(false, true).await;
        let scope = scope(workspace.path(), &id);
        let before = store(&manager)
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Resume,
                },
            )
            .unwrap();
        let wake = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: before.queue_revision,
            operation: QueueOperation::Wake,
        };
        UNAVAILABLE_WAKE_DRAINS
            .lock()
            .unwrap()
            .push(wake.operation_id);
        let error = manager
            .queue_mutate("owner", &id, wake.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, "unavailable");
        let saved = store(&manager)
            .verify_operation_receipt(&scope, &wake)
            .unwrap();
        assert!(saved.is_some());
        assert!(store(&manager).load(&scope).unwrap().items.is_empty());
        assert_eq!(
            manager.queue_mutate("owner", &id, wake).await.unwrap(),
            saved.unwrap()
        );
        finish_queued_drains(&manager, &id).await;
        assert!(store(&manager).load(&scope).unwrap().items.is_empty());
        manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn committed_retry_attempts_unaccepted_work_and_holds_after_submit_failure() {
        let (_data, workspace, manager, id) = setup(false).await;
        let scope = scope(workspace.path(), &id);
        let mutation = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 0,
            operation: QueueOperation::Enqueue {
                item_id: Uuid::new_v4(),
                text: "unaccepted work".into(),
                run_when_idle: true,
            },
        };
        let receipt = store(&manager).mutate(&scope, mutation.clone()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        session.state.lock().await.model = Some(String::new());
        assert_eq!(
            manager.queue_mutate("owner", &id, mutation).await.unwrap(),
            receipt
        );
        finish_queued_drains(&manager, &id).await;
        let after = store(&manager).load(&scope).unwrap();
        assert_eq!(after.mode, QueueMode::Held);
        assert_eq!(after.hold_reason, Some(HoldReason::DispatchError));
        assert_eq!(after.items[0].state, ItemState::Pending);
        assert_eq!(after.order, vec![after.items[0].item_id]);
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
    }
    #[tokio::test]
    async fn committed_retry_during_cleanup_preserves_receipt_without_waking() {
        for deleting in [false, true] {
            let (_data, workspace, manager, id) = setup(false).await;
            let (mutation, receipt, before) =
                committed_retry_fixture(&manager, workspace.path(), &id).await;
            let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
            {
                let mut state = session.state.lock().await;
                state.retiring = !deleting;
                state.deleting = deleting;
            }
            assert_eq!(
                manager.queue_mutate("owner", &id, mutation).await.unwrap(),
                receipt
            );
            let queue_gate = gate(&manager, "owner", &id).unwrap();
            let guard = queue_gate.lock().await;
            tokio::task::yield_now().await;
            {
                let mut state = session.state.lock().await;
                state.retiring = false;
                state.deleting = false;
            }
            drop(guard);
            let _guard = queue_gate.lock().await;
            assert_eq!(
                store(&manager).load(&scope(workspace.path(), &id)).unwrap(),
                before
            );
        }
    }
    #[tokio::test]
    async fn committed_retry_respects_manual_and_restart_holds() {
        for reason in [HoldReason::Manual, HoldReason::Restart] {
            let (data, workspace, manager, id) = setup(false).await;
            let (mutation, receipt, _) =
                committed_retry_fixture(&manager, workspace.path(), &id).await;
            let scope = scope(workspace.path(), &id);
            if reason == HoldReason::Manual {
                store(&manager).hold(&scope, reason).unwrap();
            } else {
                QueueStore::new(data.path(), Uuid::new_v4())
                    .load(&scope)
                    .unwrap();
            }
            assert_eq!(
                manager.queue_mutate("owner", &id, mutation).await.unwrap(),
                receipt
            );
            finish_queued_drains(&manager, &id).await;
            let held = store(&manager).load(&scope).unwrap();
            assert_eq!(held.mode, QueueMode::Held);
            assert_eq!(held.hold_reason, Some(reason));
            assert_eq!(held.items[0].state, ItemState::Pending);
        }
    }
    #[tokio::test]
    async fn committed_retry_drain_is_fenced_by_generation_change() {
        let (_data, workspace, manager, id) = setup(false).await;
        let (mutation, receipt, before) =
            committed_retry_fixture(&manager, workspace.path(), &id).await;
        assert_eq!(
            manager.queue_mutate("owner", &id, mutation).await.unwrap(),
            receipt
        );
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let guard = queue_gate.lock().await;
        tokio::task::yield_now().await;
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        session.state.lock().await.generation += 1;
        drop(guard);
        let _guard = queue_gate.lock().await;
        assert_eq!(
            store(&manager).load(&scope(workspace.path(), &id)).unwrap(),
            before
        );
    }
    #[tokio::test]
    async fn conflicting_retry_does_not_wake_the_queue() {
        let (_data, workspace, manager, id) = setup(false).await;
        let (mut mutation, _, before) =
            committed_retry_fixture(&manager, workspace.path(), &id).await;
        mutation.operation = QueueOperation::Pause;
        assert_eq!(
            manager
                .queue_mutate("owner", &id, mutation)
                .await
                .unwrap_err()
                .code,
            "conflict"
        );
        finish_queued_drains(&manager, &id).await;
        assert_eq!(
            store(&manager).load(&scope(workspace.path(), &id)).unwrap(),
            before
        );
    }
    #[tokio::test]
    async fn holding_unused_v4_and_native_sessions_creates_no_queue_files() {
        let (data, workspace, manager, id) = setup(false).await;
        hold_session(&manager, "owner", &id).await.unwrap();
        let native = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        hold_session(&manager, "owner", &native.id).await.unwrap();
        assert!(!data.path().join("followup-queues").exists());
    }

    #[tokio::test]
    async fn receipt_lookup_for_unused_parent_does_not_create_a_queue() {
        let (data, _workspace, manager, id) = setup(false).await;
        assert_eq!(
            manager
                .queue_operation_receipt("owner", &id, Uuid::new_v4())
                .await
                .unwrap(),
            None
        );
        assert!(!data.path().join("followup-queues").exists());
    }

    #[tokio::test]
    async fn receipt_lookup_rejects_foreign_and_deleted_parents_without_creating_a_queue() {
        let (data, _workspace, manager, id) = setup(false).await;
        let operation_id = Uuid::new_v4();
        assert_eq!(
            manager
                .queue_operation_receipt("other", &id, operation_id)
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        manager.delete_session("owner", &id).await.unwrap();
        assert_eq!(
            manager
                .queue_operation_receipt("owner", &id, operation_id)
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        assert!(!data.path().join("followup-queues").exists());
    }

    #[tokio::test]
    async fn owner_parent_is_checked_before_any_queue_directory_is_created() {
        let (data, _workspace, manager, id) = setup(false).await;
        assert_eq!(
            manager
                .queue_snapshot("another-account", &id)
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        assert!(!data.path().join("followup-queues").exists());
        assert_eq!(
            manager
                .queue_snapshot("owner", "ss-11111111111111111111111111111111")
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        assert!(!data.path().join("followup-queues").exists());
    }
    #[tokio::test]
    async fn native_session_has_no_fake_model_followup_queue() {
        let (data, workspace, manager, _id) = setup(false).await;
        let native = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            manager
                .queue_snapshot("owner", &native.id)
                .await
                .unwrap_err()
                .code,
            "conflict"
        );
        assert!(!data.path().join("followup-queues").exists());
    }
    #[tokio::test]
    async fn queueing_during_active_turn_creates_only_durable_queue_receipt() {
        let (_data, _workspace, manager, id) = setup(true).await;
        let receipt = enqueue(&manager, &id, "later message").await;
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].state, ItemState::Pending);
        assert_eq!(receipt.item_id, Some(snapshot.items[0].item_id));
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
        assert_eq!(
            manager
                .queue_operation_receipt("owner", &id, receipt.operation_id)
                .await
                .unwrap(),
            Some(receipt)
        );
    }
    #[tokio::test]
    async fn stale_generation_and_active_process_do_not_reserve_queue_items() {
        let (_data, _workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "later").await;
        drain(manager.clone(), "owner".into(), id.clone(), 7)
            .await
            .unwrap();
        let before = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(before.items[0].state, ItemState::Pending);
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        {
            let mut state = session.state.lock().await;
            state.process = None;
            state.generation = 8;
        }
        drain(manager.clone(), "owner".into(), id.clone(), 7)
            .await
            .unwrap();
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), before);
    }
    #[tokio::test]
    async fn durable_hold_prevents_later_completed_generation_from_releasing_stopped_work() {
        let (_data, _workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "held work").await;
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        {
            let mut state = session.state.lock().await;
            state.process = None;
            state.generation = 8;
        }
        hold_session(&manager, "owner", &id).await.unwrap();
        let held = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(held.mode, QueueMode::Held);
        assert_eq!(held.hold_reason, Some(HoldReason::Manual));
        drain(manager.clone(), "owner".into(), id.clone(), 8)
            .await
            .unwrap();
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), held);
    }
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "invoked by the isolated queued-authority integration test"]
    async fn queued_authority_provider_fixture() {
        use crate::v4_agent::background_process::bootstrap;
        let data = PathBuf::from(std::env::var_os("V4_QUEUE_AUTH_DATA").unwrap());
        let workspace = PathBuf::from(std::env::var_os("V4_QUEUE_AUTH_WORKSPACE").unwrap());
        let state = AppState::new(AppConfig {
            data_dir: data.clone(),
            jwt_secret: "queue-fixture-jwt".into(),
            ..Default::default()
        })
        .unwrap();
        let user = AuthenticatedUser {
            user_id: "queue-fixture-owner".into(),
            username: "fixture".into(),
        };
        state
            .add_vault_key(
                &user,
                "fixture",
                "terminal-v4:provider:deepseek",
                &crate::vault::encrypt_secret("synthetic-provider-key", "queue-fixture-vault")
                    .unwrap(),
                "2026-01-01",
            )
            .unwrap();
        let background = {
            let mut db = state.lock_db().unwrap();
            Arc::new(bootstrap::open_or_provision(&data, &mut db).unwrap())
        };
        background.enable_commands();
        let manager = state.structured_session_manager();
        manager.bind_live_ownership().unwrap();
        manager.bind_background_processes(background).unwrap();
        manager
            .bind_local_admission(state.local_admission().unwrap())
            .unwrap();
        for (text, authorized, blocked) in [
            ("queue-authorized", true, false),
            ("queue-legacy", false, true),
            ("queue-expired", true, true),
            ("queue-revoked", true, true),
        ] {
            let session = manager
                .create_session(
                    &user.user_id,
                    workspace.to_str().unwrap(),
                    Some("deepseek"),
                    Some("deepseek-chat"),
                    None,
                )
                .await
                .unwrap();
            let authority = crate::auth::LocalAuthority::for_test(
                &user.user_id,
                0,
                crate::v4_agent::interaction::now_ms()
                    + if text == "queue-expired" {
                        1_500
                    } else {
                        60_000
                    },
            );
            let mutation = Mutation {
                operation_id: Uuid::new_v4(),
                expected_queue_revision: 0,
                operation: QueueOperation::Enqueue {
                    item_id: Uuid::new_v4(),
                    text: text.into(),
                    run_when_idle: false,
                },
            };
            manager
                .queue_mutate_authorized(
                    &user.user_id,
                    &session.id,
                    mutation,
                    authorized.then_some(&authority),
                    None,
                    None,
                )
                .await
                .unwrap();
            let held = manager
                .queue_snapshot(&user.user_id, &session.id)
                .await
                .unwrap();
            assert_eq!(held.mode, QueueMode::Held);
            assert!(manager
                .get_session(&user.user_id, &session.id)
                .await
                .unwrap()
                .unwrap()
                .events
                .iter()
                .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
            if text == "queue-expired" {
                tokio::time::sleep(std::time::Duration::from_millis(1_600)).await;
            }
            if text == "queue-revoked" {
                state.logout_user(&user.user_id).unwrap();
            }
            manager
                .queue_mutate(
                    &user.user_id,
                    &session.id,
                    Mutation {
                        operation_id: Uuid::new_v4(),
                        expected_queue_revision: 1,
                        operation: QueueOperation::Resume,
                    },
                )
                .await
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    if blocked {
                        let queue = manager
                            .queue_snapshot(&user.user_id, &session.id)
                            .await
                            .unwrap();
                        if queue.mode == QueueMode::Held
                            && queue.hold_reason == Some(HoldReason::DispatchError)
                        {
                            let session = manager
                                .get_session(&user.user_id, &session.id)
                                .await
                                .unwrap()
                                .unwrap();
                            assert!(session.events.iter().all(|event| !matches!(
                                event,
                                StructuredSessionEvent::UserMessageAccepted { .. }
                            )));
                            break;
                        }
                    }
                    let snapshot = manager
                        .get_session(&user.user_id, &session.id)
                        .await
                        .unwrap()
                        .unwrap();
                    if !blocked
                        && snapshot.events.iter().any(|event| {
                            matches!(event, StructuredSessionEvent::TurnCompleted { .. })
                        })
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("queued turn did not finish");
        }
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queued_turns_preserve_proven_authority_without_upgrading_legacy_items() {
        use axum::{routing::post, Json, Router};
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let provider = Router::new().fallback(post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(body);
                Json(json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}]}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "structured::queue::tests::queued_authority_provider_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", data.path())
            .env("V4_QUEUE_AUTH_DATA", data.path())
            .env("V4_QUEUE_AUTH_WORKSPACE", workspace.path())
            .env("VAULT_ENCRYPTION_KEY", "queue-fixture-vault")
            .env("DEEPSEEK_BASE_URL", format!("http://{address}/v1"))
            .env("NO_PROXY", "*")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            child.spawn().unwrap().wait_with_output(),
        )
        .await
        .expect("queued fixture timed out")
        .unwrap();
        server.abort();
        assert!(
            result.status.success(),
            "fixture failed: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]["tools"]
            .to_string()
            .contains("background_start"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_authority_requires_exact_permitted_reservation_and_incarnation() {
        let (data, workspace, manager, id) = setup(true).await;
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let _gate = queue_gate.lock().await;
        let mut state = session.state.lock().await;
        state.process = None;
        let incarnation = state.session_incarnation.unwrap().0;
        let scope = scope(workspace.path(), &id);
        let store = store(&manager);
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            8,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        store
            .mutate_authorized(
                &scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "queued work".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        let reservation = store
            .reserve_next(
                &scope,
                1,
                IdleBoundary {
                    turn_epoch: state.generation,
                },
            )
            .unwrap()
            .unwrap();
        assert!(verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            &reservation.text
        )
        .is_err());
        let permit = install_permit(
            key(&manager, "owner", &id),
            Permit {
                request_id: reservation.input_request_id,
                generation: state.generation,
            },
        )
        .unwrap();
        let verified = verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            &reservation.text,
        )
        .unwrap()
        .unwrap();
        let restored = crate::auth::LocalAuthority::from_verified_queue(verified);
        assert_eq!(restored.generation_for("owner"), Some(8));
        assert!(verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            "different"
        )
        .is_err());
        state.session_incarnation = None;
        assert!(verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            &reservation.text
        )
        .is_err());
        state.session_incarnation = Some(super::super::SessionIncarnation(Uuid::new_v4()));
        assert!(verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            &reservation.text
        )
        .is_err());
        drop(permit);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_dispatch_refuses_proof_bearing_or_unverifiable_reservations() {
        let (data, workspace, manager, id) = setup(true).await;
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let state = session.state.lock().await;
        let incarnation = state.session_incarnation.unwrap().0;
        let queue_scope = scope(workspace.path(), &id);
        let queue = store(&manager);
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        queue
            .mutate_authorized(
                &queue_scope,
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "protected".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        let reservation = queue
            .reserve_next(
                &queue_scope,
                1,
                IdleBoundary {
                    turn_epoch: state.generation,
                },
            )
            .unwrap()
            .unwrap();
        assert!(
            check_legacy_dispatch(&queue, &queue_scope, Some(incarnation), &reservation).is_err()
        );
        assert!(check_legacy_dispatch(&queue, &queue_scope, None, &reservation).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_incarnation_holds_proof_bearing_queued_turn() {
        let (data, workspace, manager, id) = setup(true).await;
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let mut state = session.state.lock().await;
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            8,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        store(&manager)
            .mutate_authorized(
                &scope(workspace.path(), &id),
                state.session_incarnation.unwrap().0,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "proof-bearing item".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        let generation = state.generation;
        state.process = None;
        state.session_incarnation = None;
        drop(state);
        assert!(
            drain(manager.clone(), "owner".into(), id.clone(), generation)
                .await
                .is_err()
        );
        let queue = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(
            (queue.mode, queue.hold_reason),
            (QueueMode::Held, Some(HoldReason::DispatchError))
        );
        let state = session.state.lock().await;
        assert!(state
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authenticated_enqueue_without_incarnation_is_rejected_before_logout_or_dispatch() {
        let (data, _workspace, manager, id) = setup(true).await;
        let app_state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        manager
            .bind_local_admission(app_state.local_admission().unwrap())
            .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let generation = {
            let mut state = session.state.lock().await;
            state.session_incarnation = None;
            state.process = None;
            state.generation
        };
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let mutation = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 0,
            operation: QueueOperation::Enqueue {
                item_id: Uuid::new_v4(),
                text: "should not queue".into(),
                run_when_idle: true,
            },
        };
        let result = manager
            .queue_mutate_authorized(
                "owner",
                &id,
                mutation,
                Some(&authority),
                None,
                Some(&app_state),
            )
            .await;
        assert!(
            result.is_err(),
            "legacy session must not lose authority on enqueue"
        );
        app_state.logout_user("owner").unwrap();
        drain(manager.clone(), "owner".into(), id.clone(), generation)
            .await
            .unwrap();
        assert!(manager
            .queue_snapshot("owner", &id)
            .await
            .unwrap()
            .items
            .is_empty());
        let state = session.state.lock().await;
        assert!(state
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authenticated_edit_without_incarnation_preserves_legacy_item_for_review() {
        let (data, workspace, manager, id) = setup(true).await;
        let app_state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        manager
            .bind_local_admission(app_state.local_admission().unwrap())
            .unwrap();
        let queue_scope = scope(workspace.path(), &id);
        let item = Uuid::new_v4();
        store(&manager)
            .mutate(
                &queue_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: item,
                        text: "original legacy text".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let generation = {
            let mut state = session.state.lock().await;
            state.session_incarnation = None;
            state.process = None;
            state.generation
        };
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let result = manager
            .queue_mutate_authorized(
                "owner",
                &id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 1,
                    operation: QueueOperation::Edit {
                        item_id: item,
                        expected_item_revision: 1,
                        text: "replacement".into(),
                    },
                },
                Some(&authority),
                None,
                Some(&app_state),
            )
            .await;
        assert!(
            result.is_err(),
            "legacy session must not lose authority on edit"
        );
        let before = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(before.items[0].text, "original legacy text");
        app_state.logout_user("owner").unwrap();
        assert!(
            drain(manager.clone(), "owner".into(), id.clone(), generation)
                .await
                .is_err()
        );
        let held = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(
            (held.mode, held.hold_reason, held.items[0].text.as_str()),
            (
                QueueMode::Held,
                Some(HoldReason::DispatchError),
                "original legacy text"
            )
        );
        let state = session.state.lock().await;
        assert!(state
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_authority_does_not_upgrade_unproven_reservation() {
        let (data, workspace, manager, id) = setup(true).await;
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let _gate = queue_gate.lock().await;
        let mut state = session.state.lock().await;
        state.process = None;
        let store = store(&manager);
        let scope = scope(workspace.path(), &id);
        store
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "legacy".into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        let reservation = store
            .reserve_next(
                &scope,
                1,
                IdleBoundary {
                    turn_epoch: state.generation,
                },
            )
            .unwrap()
            .unwrap();
        let _permit = install_permit(
            key(&manager, "owner", &id),
            Permit {
                request_id: reservation.input_request_id,
                generation: state.generation,
            },
        )
        .unwrap();
        assert!(verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            &reservation.text
        )
        .unwrap()
        .is_none());
        state.session_incarnation = None;
        assert!(verify_queue_authority_for_admission(
            &manager,
            &state,
            &reservation.input_request_id.to_string(),
            &reservation.text
        )
        .unwrap()
        .is_none());
        assert!(!data.path().join("vault-encryption.key").exists());
    }

    #[tokio::test]
    async fn dispatching_id_without_current_process_permit_cannot_bypass_admission() {
        let (data, workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "reserved").await;
        let store = QueueStore::new(data.path(), boot_id());
        let scope = scope(workspace.path(), &id);
        let snapshot = store.load(&scope).unwrap();
        let reserved = store
            .reserve_next(&scope, snapshot.revision, IdleBoundary { turn_epoch: 7 })
            .unwrap()
            .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let mut state = session.state.lock().await;
        state.process = None;
        assert_eq!(
            check_admission(
                &manager,
                &state,
                &reserved.input_request_id.to_string(),
                &reserved.text
            )
            .unwrap_err()
            .code,
            "conflict"
        );
        assert_eq!(
            check_admission(&manager, &state, &Uuid::new_v4().to_string(), "unrelated")
                .unwrap_err()
                .code,
            "conflict"
        );
    }
    #[tokio::test]
    async fn receipt_recovery_checks_text_instead_of_only_matching_request_uuid() {
        let (data, workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "reserved text").await;
        let store = QueueStore::new(data.path(), boot_id());
        let scope = scope(workspace.path(), &id);
        let snapshot = store.load(&scope).unwrap();
        let reserved = store
            .reserve_next(&scope, snapshot.revision, IdleBoundary { turn_epoch: 7 })
            .unwrap()
            .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        {
            let mut state = session.state.lock().await;
            state.process = None;
        }
        manager
            .record_event(
                "owner",
                &id,
                StructuredSessionEvent::UserMessageAccepted {
                    ts: 1,
                    seq: 0,
                    request_id: reserved.input_request_id.to_string(),
                    turn_id: Uuid::new_v4().to_string(),
                    message_id: Uuid::new_v4().to_string(),
                    content: "different accepted text".into(),
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            manager.queue_snapshot("owner", &id).await.unwrap_err().code,
            "conflict"
        );
        assert_ne!(
            store.load(&scope).unwrap().items[0].state,
            ItemState::Accepted
        );
    }
    #[tokio::test]
    async fn an_absent_interrupted_dispatch_is_held_and_not_automatically_resubmitted() {
        let (data, workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "reserved text").await;
        let store = QueueStore::new(data.path(), boot_id());
        let scope = scope(workspace.path(), &id);
        let snapshot = store.load(&scope).unwrap();
        let reserved = store
            .reserve_next(&scope, snapshot.revision, IdleBoundary { turn_epoch: 7 })
            .unwrap()
            .unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        {
            let mut state = session.state.lock().await;
            state.process = None;
            state.generation = 8;
        }
        let recovered = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(recovered.mode, QueueMode::Held);
        assert_eq!(recovered.items[0].state, ItemState::Pending);
        assert_eq!(
            recovered.items[0].input_request_id,
            reserved.input_request_id
        );
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
    }
    #[tokio::test]
    async fn router_returns_private_queue_snapshot_and_rejects_attachment_fields() {
        let (data, _workspace, manager, id) = setup(true).await;
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = AppState::new_with_services(config, None, manager).unwrap();
        let app = routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/structured/sessions/{id}/queue"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let value: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value["mode"], "held");
        let body = json!({"operationId":Uuid::new_v4(),"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"text","runWhenIdle":true,"attachments":[{"path":"/arbitrary"}]}});
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{id}/queue"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn queue_reads_reject_local_logout_after_waiting_for_queue_gate() {
        for receipt_read in [false, true] {
            let (data, _workspace, manager, id) = setup(true).await;
            let receipt = enqueue(&manager, &id, "private queued message").await;
            let state = AppState::new_with_services(
                AppConfig {
                    data_dir: data.path().into(),
                    ..Default::default()
                },
                None,
                manager.clone(),
            )
            .unwrap();
            let path = if receipt_read {
                format!(
                    "/api/structured/sessions/{id}/queue/operations/{}",
                    receipt.operation_id
                )
            } else {
                format!("/api/structured/sessions/{id}/queue")
            };
            let app = routes()
                .layer(Extension(crate::auth::LocalAuthority::for_test(
                    "owner",
                    0,
                    crate::v4_agent::interaction::now_ms() + 60_000,
                )))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            assert_eq!(
                app.clone()
                    .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
            let queue_gate = gate(&manager, "owner", &id).unwrap();
            let guard = queue_gate.lock().await;
            let pending = tokio::spawn(async move {
                app.oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            });
            tokio::task::yield_now().await;
            assert!(!pending.is_finished());
            state.logout_user("owner").unwrap();
            drop(guard);
            assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_reads_reject_local_expiry_after_waiting_for_queue_gate() {
        for receipt_read in [false, true] {
            let (data, _workspace, manager, id) = setup(true).await;
            let receipt = enqueue(&manager, &id, "private queued message").await;
            let state = AppState::new_with_services(
                AppConfig {
                    data_dir: data.path().into(),
                    ..Default::default()
                },
                None,
                manager.clone(),
            )
            .unwrap();
            let path = if receipt_read {
                format!(
                    "/api/structured/sessions/{id}/queue/operations/{}",
                    receipt.operation_id
                )
            } else {
                format!("/api/structured/sessions/{id}/queue")
            };
            let expires = crate::v4_agent::interaction::now_ms() + 150;
            let app = routes()
                .layer(Extension(crate::auth::LocalAuthority::for_test(
                    "owner", 0, expires,
                )))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state);
            let queue_gate = gate(&manager, "owner", &id).unwrap();
            let guard = queue_gate.lock().await;
            let pending = tokio::spawn(async move {
                app.oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            });
            tokio::task::yield_now().await;
            assert!(!pending.is_finished());
            let remaining = expires.saturating_sub(crate::v4_agent::interaction::now_ms()) as u64;
            tokio::time::sleep(std::time::Duration::from_millis(remaining + 20)).await;
            drop(guard);
            assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paired_queue_head_reads_are_authorized_for_exact_route() {
        let (data, _workspace, manager, id) = setup(true).await;
        let receipt = enqueue(&manager, &id, "private queued message").await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager,
        )
        .unwrap();
        let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        for path in [
            format!("/api/structured/sessions/{id}/queue"),
            format!(
                "/api/structured/sessions/{id}/queue/operations/{}",
                receipt.operation_id
            ),
        ] {
            let app = routes()
                .layer(Extension(crate::auth::PairedInputAuthority {
                    token: token.clone(),
                    path: path.clone(),
                    method: "HEAD".into(),
                }))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            let response = app
                .oneshot(
                    Request::builder()
                        .method("HEAD")
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_reads_reject_paired_revocation_after_waiting_for_owner_guard() {
        for receipt_read in [false, true] {
            let (data, _workspace, manager, id) = setup(true).await;
            let receipt = enqueue(&manager, &id, "private queued message").await;
            let state = AppState::new_with_services(
                AppConfig {
                    data_dir: data.path().into(),
                    ..Default::default()
                },
                None,
                manager.clone(),
            )
            .unwrap();
            let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
            let path = if receipt_read {
                format!(
                    "/api/structured/sessions/{id}/queue/operations/{}",
                    receipt.operation_id
                )
            } else {
                format!("/api/structured/sessions/{id}/queue")
            };
            let app = routes()
                .layer(Extension(crate::auth::PairedInputAuthority {
                    token,
                    path: path.clone(),
                    method: "GET".into(),
                }))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            assert_eq!(
                app.clone()
                    .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
            let guard = state.acquire_input_guard("owner").unwrap();
            let pending = tokio::spawn(async move {
                app.oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            });
            tokio::task::yield_now().await;
            assert!(!pending.is_finished());
            state
                .lock_db()
                .unwrap()
                .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
                .unwrap();
            drop(guard);
            assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_reads_reject_paired_expiry_and_scope_mismatch() {
        for receipt_read in [false, true] {
            let (data, _workspace, manager, id) = setup(true).await;
            let receipt = enqueue(&manager, &id, "private queued message").await;
            let state = AppState::new_with_services(
                AppConfig {
                    data_dir: data.path().into(),
                    ..Default::default()
                },
                None,
                manager.clone(),
            )
            .unwrap();
            let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
            let path = if receipt_read {
                format!(
                    "/api/structured/sessions/{id}/queue/operations/{}",
                    receipt.operation_id
                )
            } else {
                format!("/api/structured/sessions/{id}/queue")
            };
            let app = routes()
                .layer(Extension(crate::auth::PairedInputAuthority {
                    token: token.clone(),
                    path: path.clone(),
                    method: "GET".into(),
                }))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            let guard = state.acquire_input_guard("owner").unwrap();
            let requested_path = path.clone();
            let pending = tokio::spawn(async move {
                app.oneshot(
                    Request::builder()
                        .uri(requested_path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            });
            tokio::task::yield_now().await;
            assert!(!pending.is_finished());
            state
                .lock_db()
                .unwrap()
                .execute("UPDATE paired_grants SET expires=0 WHERE id=?1", [&grant])
                .unwrap();
            drop(guard);
            assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);

            let mismatched = routes()
                .layer(Extension(crate::auth::PairedInputAuthority {
                    token,
                    path: "/api/another".into(),
                    method: "GET".into(),
                }))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state);
            assert_eq!(
                mismatched
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::CONFLICT
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_reads_require_credential_and_do_not_expose_other_owners() {
        let (data, _workspace, manager, id) = setup(true).await;
        let receipt = enqueue(&manager, &id, "private queued message").await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager,
        )
        .unwrap();
        for path in [
            format!("/api/structured/sessions/{id}/queue"),
            format!(
                "/api/structured/sessions/{id}/queue/operations/{}",
                receipt.operation_id
            ),
        ] {
            let no_authority = routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            assert_eq!(
                no_authority
                    .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            let foreign = routes()
                .layer(Extension(crate::auth::LocalAuthority::for_test(
                    "other",
                    0,
                    crate::v4_agent::interaction::now_ms() + 60_000,
                )))
                .layer(Extension(AuthenticatedUser {
                    user_id: "other".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            assert_eq!(
                foreign
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        let (_, foreign_token) = crate::paired_environments::synthetic_input_grant(&state, "other");
        let path = format!("/api/structured/sessions/{id}/queue");
        let foreign_grant = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token: foreign_token,
                path: path.clone(),
                method: "GET".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        assert_eq!(
            foreign_grant
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paired_queue_read_does_not_hold_owner_guard_on_busy_store() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager,
        )
        .unwrap();
        let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "GET".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let storage_guard = crate::followup_queue::hold_store_lock_for_test();
        let pending = tokio::spawn(async move {
            app.oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
        });
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let owner_guard = state.acquire_input_guard("owner").unwrap();
        drop(owner_guard);
        drop(storage_guard);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paired_queue_read_does_not_hold_owner_guard_while_session_is_busy() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "GET".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let session_guard = session.state.lock().await;
        let pending = tokio::spawn(async move {
            app.oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
        });
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        let owner_guard = state.acquire_input_guard("owner").unwrap();
        state
            .lock_db()
            .unwrap()
            .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
            .unwrap();
        drop(owner_guard);
        drop(session_guard);
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_route_rejects_local_request_revoked_while_waiting_for_session_gate() {
        let (data, _workspace, manager, id) = setup(true).await;
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
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let gate_guard = queue_gate.lock().await;
        let body = json!({"operationId":Uuid::new_v4(),"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"stale request","runWhenIdle":false}});
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{id}/queue"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
        tokio::task::yield_now().await;
        state.logout_user("owner").unwrap();
        drop(gate_guard);
        let response = pending.await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        assert!(snapshot.items.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_route_rejects_paired_request_revoked_while_waiting_for_owner_guard() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "POST".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let guard = state.acquire_input_guard("owner").unwrap();
        let body = json!({"operationId":Uuid::new_v4(),"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"stale paired request","runWhenIdle":false}});
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
        tokio::task::yield_now().await;
        state
            .lock_db()
            .unwrap()
            .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
            .unwrap();
        drop(guard);
        assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert!(manager
            .queue_snapshot("owner", &id)
            .await
            .unwrap()
            .items
            .is_empty());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paired_queue_mutation_never_reacquires_database_after_grant_validation() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager,
        )
        .unwrap();
        let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "POST".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let operation_id = Uuid::new_v4();
        let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"paired","runWhenIdle":false}});
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        PAIRED_QUEUE_AFTER_AUTH
            .lock()
            .unwrap()
            .push((operation_id, entered, release_rx));
        let mut pending = tokio::spawn(async move {
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let (held, held_rx) = std::sync::mpsc::channel();
        let (unlock, unlock_rx) = std::sync::mpsc::channel();
        let db_holder = tokio::task::spawn_blocking(move || {
            let _db = state.lock_db().unwrap();
            held.send(()).unwrap();
            let _ = unlock_rx.recv_timeout(std::time::Duration::from_secs(5));
        });
        held_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        release.send(()).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), &mut pending).await;
        let _ = unlock.send(());
        db_holder.await.unwrap();
        assert_eq!(
            result
                .expect("queue mutation waited on the database while holding its store lock")
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn busy_paired_queue_request_does_not_keep_owner_guard() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "POST".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let _gate = queue_gate.lock().await;
        let body = json!({"operationId":Uuid::new_v4(),"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"paired","runWhenIdle":false}});
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let _guard = state.acquire_input_guard("owner").unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "invoked by the isolated queue store contention test"]
    async fn paired_queue_store_contention_fixture() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "POST".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let body = json!({"operationId":Uuid::new_v4(),"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"paired","runWhenIdle":false}});
        let store_guard = crate::followup_queue::hold_store_lock_for_test();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let _owner_guard = state.acquire_input_guard("owner").unwrap();
        drop(store_guard);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paired_queue_request_releases_owner_guard_when_store_is_busy() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "structured::queue::tests::paired_queue_store_contention_fixture",
                    "--ignored",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn revoked_queue_retry_does_not_schedule_a_drain() {
        let (data, _workspace, manager, id) = setup(true).await;
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
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let body = json!({"operationId":Uuid::new_v4(),"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"already queued","runWhenIdle":true}});
        let request = || {
            Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{id}/queue"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::OK
        );
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        session.state.lock().await.process = None;
        let before = manager.queue_snapshot("owner", &id).await.unwrap();
        let queue_gate = gate(&manager, "owner", &id).unwrap();
        let gate_guard = queue_gate.lock().await;
        let retry = request();
        let pending = tokio::spawn(async move { app.oneshot(retry).await.unwrap() });
        tokio::task::yield_now().await;
        state.logout_user("owner").unwrap();
        drop(gate_guard);
        assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        tokio::task::yield_now().await;
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), before);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_expiry_after_publication_returns_uncertain_status_and_preserves_receipt() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let expires = crate::v4_agent::interaction::now_ms() + 2_000;
        let app = routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner", 0, expires,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let operation_id = Uuid::new_v4();
        let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"saved local","runWhenIdle":false}});
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        QUEUE_AFTER_SNAPSHOT
            .lock()
            .unwrap()
            .push((operation_id, entered, release_rx));
        let path = format!("/api/structured/sessions/{id}/queue");
        let pending = tokio::spawn(async move {
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let remaining = expires.saturating_sub(crate::v4_agent::interaction::now_ms()) as u64;
        tokio::time::sleep(std::time::Duration::from_millis(remaining + 25)).await;
        release.send(()).unwrap();
        assert_eq!(
            pending.await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert!(manager
            .queue_operation_receipt("owner", &id, operation_id)
            .await
            .unwrap()
            .is_some());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paired_expiry_after_publication_returns_uncertain_status_and_preserves_receipt() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
        let expires = (crate::v4_agent::interaction::now_ms() / 1_000 + 3) * 1_000;
        state
            .lock_db()
            .unwrap()
            .execute(
                "UPDATE paired_grants SET expires=?1 WHERE id=?2",
                rusqlite::params![expires / 1_000, grant],
            )
            .unwrap();
        let path = format!("/api/structured/sessions/{id}/queue");
        let app = routes()
            .layer(Extension(crate::auth::PairedInputAuthority {
                token,
                path: path.clone(),
                method: "POST".into(),
            }))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let operation_id = Uuid::new_v4();
        let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"saved paired","runWhenIdle":false}});
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        QUEUE_AFTER_SNAPSHOT
            .lock()
            .unwrap()
            .push((operation_id, entered, release_rx));
        let pending = tokio::spawn(async move {
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let remaining = expires.saturating_sub(crate::v4_agent::interaction::now_ms()) as u64;
        tokio::time::sleep(std::time::Duration::from_millis(remaining + 25)).await;
        release.send(()).unwrap();
        assert_eq!(
            pending.await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert!(manager
            .queue_operation_receipt("owner", &id, operation_id)
            .await
            .unwrap()
            .is_some());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cleanup_retry_rechecks_expiry_before_returning_receipt_for_local_and_paired() {
        for paired in [false, true] {
            let (data, _workspace, manager, id) = setup(true).await;
            let state = AppState::new_with_services(
                AppConfig {
                    data_dir: data.path().into(),
                    ..Default::default()
                },
                None,
                manager.clone(),
            )
            .unwrap();
            let expires = (crate::v4_agent::interaction::now_ms() / 1_000 + 3) * 1_000;
            let path = format!("/api/structured/sessions/{id}/queue");
            let app = routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state.clone());
            let app = if paired {
                let (grant, token) =
                    crate::paired_environments::synthetic_input_grant(&state, "owner");
                state
                    .lock_db()
                    .unwrap()
                    .execute(
                        "UPDATE paired_grants SET expires=?1 WHERE id=?2",
                        rusqlite::params![expires / 1_000, grant],
                    )
                    .unwrap();
                app.layer(Extension(crate::auth::PairedInputAuthority {
                    token,
                    path: path.clone(),
                    method: "POST".into(),
                }))
            } else {
                app.layer(Extension(crate::auth::LocalAuthority::for_test(
                    "owner", 0, expires,
                )))
            };
            let operation_id = Uuid::new_v4();
            let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"saved once","runWhenIdle":false}});
            let request = || {
                Request::builder()
                    .method("POST")
                    .uri(path.clone())
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap()
            };
            assert_eq!(
                app.clone().oneshot(request()).await.unwrap().status(),
                StatusCode::OK
            );
            let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
            session.state.lock().await.retiring = true;
            let (entered, entered_rx) = std::sync::mpsc::channel();
            let (release, release_rx) = std::sync::mpsc::channel();
            QUEUE_AFTER_SNAPSHOT
                .lock()
                .unwrap()
                .push((operation_id, entered, release_rx));
            let retry = request();
            let pending = tokio::spawn(async move { app.oneshot(retry).await.unwrap() });
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            let remaining = expires.saturating_sub(crate::v4_agent::interaction::now_ms()) as u64;
            tokio::time::sleep(std::time::Duration::from_millis(remaining + 25)).await;
            release.send(()).unwrap();
            assert_eq!(
                pending.await.unwrap().status(),
                StatusCode::SERVICE_UNAVAILABLE
            );
            session.state.lock().await.retiring = false;
            let queue = manager.queue_snapshot("owner", &id).await.unwrap();
            assert_eq!(queue.items.len(), 1);
            assert!(manager
                .queue_operation_receipt("owner", &id, operation_id)
                .await
                .unwrap()
                .is_some());
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn committed_retry_does_not_schedule_drain_after_credential_expires() {
        let (data, _workspace, manager, id) = setup(true).await;
        let state = AppState::new_with_services(
            AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            },
            None,
            manager.clone(),
        )
        .unwrap();
        let expires = crate::v4_agent::interaction::now_ms() + 2_000;
        let app = routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner", 0, expires,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let operation_id = Uuid::new_v4();
        let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"already queued","runWhenIdle":true}});
        let request = || {
            Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{id}/queue"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::OK
        );
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        session.state.lock().await.process = None;
        let before = manager.queue_snapshot("owner", &id).await.unwrap();
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        QUEUE_AFTER_SNAPSHOT
            .lock()
            .unwrap()
            .push((operation_id, entered, release_rx));
        let retry = request();
        let pending = tokio::spawn(async move { app.oneshot(retry).await.unwrap() });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let remaining = expires.saturating_sub(crate::v4_agent::interaction::now_ms()) as u64;
        tokio::time::sleep(std::time::Duration::from_millis(remaining + 25)).await;
        release.send(()).unwrap();
        assert_eq!(
            pending.await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        tokio::task::yield_now().await;
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uncertain_queue_confirmation_returns_retryable_error_and_preserves_receipt() {
        let (data, _workspace, manager, id) = setup(true).await;
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
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let operation = Uuid::new_v4();
        let body = json!({"operationId":operation,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"saved once","runWhenIdle":false}});
        let request = || {
            Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{id}/queue"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        UNCONFIRMED_QUEUE_OPERATIONS.lock().unwrap().push(operation);
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let saved = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!((saved.revision, saved.items.len()), (1, 1));
        let retry = app.oneshot(request()).await.unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let receipt: Value =
            serde_json::from_slice(&retry.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(receipt["operationId"], operation.to_string());
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), saved);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_failure_after_commit_or_retry_returns_uncertain_without_losing_receipt() {
        for retry in [false, true] {
            let (data, _workspace, manager, id) = setup(true).await;
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
                .layer(Extension(crate::auth::LocalAuthority::for_test(
                    "owner",
                    0,
                    crate::v4_agent::interaction::now_ms() + 60_000,
                )))
                .layer(Extension(AuthenticatedUser {
                    user_id: "owner".into(),
                    username: "fixture".into(),
                }))
                .with_state(state);
            let operation_id = Uuid::new_v4();
            let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"saved once","runWhenIdle":false}});
            let request = || {
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{id}/queue"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap()
            };
            if retry {
                assert_eq!(
                    app.clone().oneshot(request()).await.unwrap().status(),
                    StatusCode::OK
                );
            }
            UNAVAILABLE_QUEUE_SNAPSHOTS
                .lock()
                .unwrap()
                .push(operation_id);
            assert_eq!(
                app.oneshot(request()).await.unwrap().status(),
                StatusCode::SERVICE_UNAVAILABLE
            );
            let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
            assert_eq!(snapshot.items.len(), 1);
            assert!(manager
                .queue_operation_receipt("owner", &id, operation_id)
                .await
                .unwrap()
                .is_some());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_route_records_local_authority_only_when_background_manager_is_bound() {
        let (data, _workspace, manager, id) = setup(true).await;
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
        crate::vault::VaultCipher::load(data.path()).unwrap();
        let background = {
            let mut db = state.lock_db().unwrap();
            Arc::new(
                crate::v4_agent::background_process::bootstrap::open_or_provision(
                    data.path(),
                    &mut db,
                )
                .unwrap(),
            )
        };
        manager.bind_background_processes(background).unwrap();
        manager
            .bind_local_admission(state.local_admission().unwrap())
            .unwrap();
        let app = routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let operation = Uuid::new_v4();
        let item = Uuid::new_v4();
        let body = json!({"operationId":operation,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":item,"text":"later","runWhenIdle":true}});
        let request = || {
            Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{id}/queue"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let first = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let receipt = first.into_body().collect().await.unwrap().to_bytes();
        let retry = app.oneshot(request()).await.unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(
            retry.into_body().collect().await.unwrap().to_bytes(),
            receipt
        );
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let current = session.state.lock().await;
        let queue_scope = super::scope(&current).unwrap();
        let reserved = store(&manager)
            .reserve_next(
                &queue_scope,
                1,
                IdleBoundary {
                    turn_epoch: current.generation,
                },
            )
            .unwrap()
            .unwrap();
        let incarnation = current.session_incarnation.unwrap().0;
        assert!(store(&manager)
            .verify_reservation_authority(&queue_scope, incarnation, &reserved)
            .unwrap()
            .is_some());
    }

    #[cfg(unix)]
    fn bound_authorized_state(data: &Path, manager: &StructuredSessionManager) -> AppState {
        let config = AppConfig {
            data_dir: data.into(),
            ..Default::default()
        };
        let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
        crate::vault::VaultCipher::load(data).unwrap();
        let background = {
            let mut db = state.lock_db().unwrap();
            Arc::new(
                crate::v4_agent::background_process::bootstrap::open_or_provision(data, &mut db)
                    .unwrap(),
            )
        };
        manager.bind_background_processes(background).unwrap();
        manager
            .bind_local_admission(state.local_admission().unwrap())
            .unwrap();
        state
    }

    #[cfg(unix)]
    fn owner_route(state: &AppState, owner: &str) -> Router {
        routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                owner,
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: owner.into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone())
    }

    #[cfg(unix)]
    async fn route_status(app: &Router, request: Request<Body>) -> StatusCode {
        app.clone().oneshot(request).await.unwrap().status()
    }

    #[cfg(unix)]
    fn enqueue_request(id: &str, operation: Uuid, revision: u64, text: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{id}/queue"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"operationId":operation,"expectedQueueRevision":revision,
                    "operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":text,"runWhenIdle":false}})
                .to_string(),
            ))
            .unwrap()
    }

    #[cfg(unix)]
    fn read_request(id: &str) -> Request<Body> {
        Request::builder()
            .uri(format!("/api/structured/sessions/{id}/queue"))
            .body(Body::empty())
            .unwrap()
    }

    #[cfg(unix)]
    fn queue_file(data: &Path, workspace: &Path, owner: &str, id: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let hash = |value: &str| hex::encode(Sha256::digest(value.as_bytes()));
        data.join("followup-queues")
            .join(hash(owner))
            .join(hash(workspace.canonicalize().unwrap().to_str().unwrap()))
            .join(format!("{id}.json"))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lost_queue_key_is_unavailable_and_never_recreated_through_the_route() {
        use std::os::unix::fs::PermissionsExt;
        let (data, workspace, manager, id) = setup(true).await;
        let state = bound_authorized_state(data.path(), &manager);
        let app = owner_route(&state, "owner");
        let key = data.path().join("queue-authority.key");
        let marker = data.path().join("queue-authority.installation");
        let queue = queue_file(data.path(), workspace.path(), "owner", &id);

        assert_eq!(
            route_status(&app, enqueue_request(&id, Uuid::new_v4(), 0, "first")).await,
            StatusCode::OK
        );
        let (key_bytes, marker_bytes, queue_bytes) = (
            std::fs::read(&key).unwrap(),
            std::fs::read(&marker).unwrap(),
            std::fs::read(&queue).unwrap(),
        );

        std::fs::remove_file(&key).unwrap();
        let second = Uuid::new_v4();
        assert_eq!(
            route_status(&app, enqueue_request(&id, second, 1, "second")).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            (
                key.exists(),
                std::fs::read(&marker).unwrap(),
                std::fs::read(&queue).unwrap()
            ),
            (false, marker_bytes.clone(), queue_bytes)
        );
        assert_eq!(
            route_status(&app, read_request(&id)).await,
            StatusCode::OK,
            "reading a queue does not need the signing key"
        );

        std::fs::write(&key, &key_bytes).unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            route_status(&app, enqueue_request(&id, second, 1, "second")).await,
            StatusCode::OK
        );
        assert_eq!(std::fs::read(&marker).unwrap(), marker_bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn one_owners_damaged_queue_does_not_block_another_owners_authorized_queue() {
        let (data, workspace, manager, id) = setup(true).await;
        let other = manager
            .create_session(
                "other",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                Some("Other owner"),
            )
            .await
            .unwrap()
            .id;
        enqueue(&manager, &id, "legacy work").await;
        let damaged = queue_file(data.path(), workspace.path(), "owner", &id);
        std::fs::write(&damaged, b"{malformed").unwrap();
        let state = bound_authorized_state(data.path(), &manager);
        let damaged_owner = owner_route(&state, "owner");
        let other_owner = owner_route(&state, "other");

        assert_eq!(
            route_status(
                &other_owner,
                enqueue_request(&other, Uuid::new_v4(), 0, "other work")
            )
            .await,
            StatusCode::OK
        );

        assert!(data.path().join("queue-authority.key").is_file());
        assert!(data.path().join("queue-authority.installation").is_file());
        assert_eq!(std::fs::read(&damaged).unwrap(), b"{malformed");
        assert_eq!(
            route_status(&damaged_owner, read_request(&id)).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            route_status(&other_owner, read_request(&other)).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn route_mutation_and_operation_lookup_have_the_same_durable_receipt() {
        let (data, _workspace, manager, id) = setup(true).await;
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = AppState::new_with_services(config, None, manager).unwrap();
        let app = routes()
            .layer(Extension(crate::auth::LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        let operation_id = Uuid::new_v4();
        let body = json!({"operationId":operation_id,"expectedQueueRevision":0,"operation":{"kind":"enqueue","itemId":Uuid::new_v4(),"text":"later","runWhenIdle":true}});
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/structured/sessions/{id}/queue"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let submitted: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(submitted["operationId"], operation_id.to_string());
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/structured/sessions/{id}/queue/operations/{operation_id}"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let found: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(found, submitted);
    }
    #[tokio::test]
    async fn stop_blocks_input_and_resume_until_durable_queue_hold_finishes() {
        let (_data, _workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "must stay queued").await;
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        manager
            .queue_mutate(
                "owner",
                &id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: snapshot.revision,
                    operation: QueueOperation::Pause,
                },
            )
            .await
            .unwrap();
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let dispatch_gate = gate(&manager, "owner", &id).unwrap();
        let guard = dispatch_gate.lock().await;
        let stopping = {
            let manager = manager.clone();
            let id = id.clone();
            tokio::spawn(async move { manager.interrupt("owner", &id).await })
        };
        // All cleanup is synthetic/ready; only the deliberately held queue gate
        // prevents Stop's durable hold from completing. Advance ready tasks.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        {
            let state = session.state.lock().await;
            assert!(
                state.retiring,
                "Stop reopened admission before its queue hold"
            );
            assert_eq!(
                state.generation, 7,
                "Stop advanced its epoch before its queue hold"
            );
        }
        let rejected = manager
            .submit(
                "owner",
                &id,
                "must not enter during Stop",
                Some(&Uuid::new_v4().to_string()),
            )
            .await
            .unwrap_err();
        assert_eq!(rejected.code, "conflict");
        let mut resuming = {
            let manager = manager.clone();
            let id = id.clone();
            tokio::spawn(async move {
                manager
                    .queue_mutate(
                        "owner",
                        &id,
                        Mutation {
                            operation_id: Uuid::new_v4(),
                            expected_queue_revision: snapshot.revision,
                            operation: QueueOperation::Resume,
                        },
                    )
                    .await
            })
        };
        match tokio::time::timeout(std::time::Duration::from_millis(20), &mut resuming).await {
            Ok(result) => assert_eq!(result.unwrap().unwrap_err().code, "conflict"),
            Err(_) => {
                resuming.abort();
                assert!(resuming.await.unwrap_err().is_cancelled());
            }
        }
        assert!(manager
            .get_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
        assert!(!stopping.is_finished());
        drop(guard);
        stopping.await.unwrap().unwrap();
        {
            let state = session.state.lock().await;
            assert!(!state.retiring);
            assert_eq!(state.generation, 8);
            assert!(state.process.is_none());
        }
        let held = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(held.mode, QueueMode::Held);
        assert_eq!(held.hold_reason, Some(HoldReason::Manual));
        assert_eq!(held.items[0].state, ItemState::Pending);
    }
    #[tokio::test]
    async fn stale_terminal_hold_cannot_pause_a_newer_resumed_queue() {
        let (_data, _workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "newer queued work").await;
        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        {
            session.state.lock().await.generation = 8;
        }
        let running = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(running.mode, QueueMode::Running);
        hold_generation(&manager, "owner", &id, 7).await.unwrap();
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), running);
        hold_generation(&manager, "owner", &id, 8).await.unwrap();
        let held = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(held.mode, QueueMode::Held);
        manager
            .queue_mutate(
                "owner",
                &id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: held.revision,
                    operation: QueueOperation::Resume,
                },
            )
            .await
            .unwrap();
        let resumed = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(resumed.mode, QueueMode::Running);
        hold_generation(&manager, "owner", &id, 7).await.unwrap();
        assert_eq!(manager.queue_snapshot("owner", &id).await.unwrap(), resumed);
    }
    #[tokio::test]
    async fn worker_hold_persistence_failure_keeps_admission_blocked_until_stop_retry() {
        use super::super::{
            ActionScope, StructuredEventSink, V4Job, V4StructuredController, V4Work,
        };
        use sha2::{Digest, Sha256};
        use std::time::Duration;

        let (data, workspace, manager, id) = setup(true).await;
        enqueue(&manager, &id, "preserved follow-up").await;
        let snapshot = manager.queue_snapshot("owner", &id).await.unwrap();
        manager
            .queue_mutate(
                "owner",
                &id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: snapshot.revision,
                    operation: QueueOperation::Pause,
                },
            )
            .await
            .unwrap();
        let file = data
            .path()
            .join("followup-queues")
            .join(hex::encode(Sha256::digest(b"owner")))
            .join(hex::encode(Sha256::digest(
                workspace
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .as_bytes(),
            )))
            .join(format!("{id}.json"));
        let backup = file.with_extension("fixture-backup");
        std::fs::rename(&file, &backup).unwrap();
        std::fs::create_dir(&file).unwrap();

        let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
        let turn_id = Uuid::new_v4().to_string();
        let sink = Arc::new(StructuredEventSink {
            manager: manager.clone(),
            owner: "owner".into(),
            session_id: id.clone(),
            generation: 7,
            pending: Mutex::new(std::collections::VecDeque::new()),
        });
        let controller = {
            let mut state = session.state.lock().await;
            let controller = Arc::new(V4StructuredController::new(
                ActionScope {
                    owner: "owner".into(),
                    session_id: id.clone(),
                    turn_id: turn_id.clone(),
                },
                sink.clone(),
                state.resources.clone(),
            ));
            state.process = Some(controller.clone());
            controller
        };
        let mut done = controller.done.subscribe();
        V4Job {
            #[cfg(unix)]
            permit: None,
            manager: manager.clone(),
            owner: "owner".into(),
            session_id: id.clone(),
            generation: 7,
            turn_id: turn_id.clone(),
            controller: controller.clone(),
            sink,
            work: V4Work::Turn(crate::v4_agent::TurnOptions {
                data_dir: data.path().into(),
                owner: "owner".into(),
                session_id: super::super::engine_session_id(&id).unwrap(),
                canonical_session_id: id.clone(),
                turn_id: turn_id.clone(),
                provider: "deepseek".into(),
                model: None,
                reasoning: None,
                workspace: workspace.path().into(),
                prompt: "missing credential fixture".into(),
                attachments: Vec::new(),
                recovery_events: Vec::new(),
                local_authority: None,
            }),
        }
        .spawn(());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !*done.borrow_and_update() {
                done.changed().await.unwrap();
            }
        })
        .await
        .expect("Missing credentials must fail before any provider request");
        assert!(controller.is_blocked());
        {
            let state = session.state.lock().await;
            assert!(state.retiring);
            assert!(state.process.is_some());
            assert_eq!(state.generation, 7);
            assert!(state.events.iter().any(|event| matches!(event,
                StructuredSessionEvent::Error { code: Some(code), .. } if code == "v4_cleanup_pending"
            )));
        }
        assert_eq!(
            manager
                .submit(
                    "owner",
                    &id,
                    "must remain blocked",
                    Some(&Uuid::new_v4().to_string())
                )
                .await
                .unwrap_err()
                .code,
            "conflict"
        );
        assert!(manager.interrupt("owner", &id).await.is_err());
        {
            let state = session.state.lock().await;
            assert!(state.retiring);
            assert_eq!(state.generation, 7);
        }

        std::fs::remove_dir(&file).unwrap();
        std::fs::rename(&backup, &file).unwrap();
        manager.interrupt("owner", &id).await.unwrap();
        let state = session.state.lock().await;
        assert!(!state.retiring);
        assert!(state.process.is_none());
        assert_eq!(state.generation, 8);
        assert!(state
            .events
            .iter()
            .all(|event| !matches!(event, StructuredSessionEvent::UserMessageAccepted { .. })));
        drop(state);
        let held = manager.queue_snapshot("owner", &id).await.unwrap();
        assert_eq!(held.mode, QueueMode::Held);
        assert_eq!(held.hold_reason, Some(HoldReason::Manual));
        assert_eq!(held.items[0].state, ItemState::Pending);
        assert_eq!(held.items[0].text, "preserved follow-up");
    }
}
