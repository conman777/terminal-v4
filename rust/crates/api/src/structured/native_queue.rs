use super::*;

#[cfg(all(unix, feature = "native-codex-queue-preview"))]
const ENABLE_VARIABLE: &str = "TERMINAL_V4_NATIVE_CODEX_QUEUE";

#[cfg(all(unix, feature = "native-codex-queue-preview"))]
const CLAUDE_ENABLE_VARIABLE: &str = "TERMINAL_V4_NATIVE_CLAUDE_QUEUE";

#[cfg(all(unix, feature = "native-codex-queue-preview", test))]
static OPTED_IN: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

#[cfg(all(unix, feature = "native-codex-queue-preview", test))]
pub(super) fn opt_in(owner: &str, session: &str) {
    OPTED_IN
        .lock()
        .unwrap()
        .push((owner.to_owned(), session.to_owned()));
}

#[cfg(all(unix, feature = "native-codex-queue-preview"))]
pub(super) fn enabled_for(state: &StructuredSessionState) -> bool {
    let variable = match state.provider.as_str() {
        "codex" => ENABLE_VARIABLE,
        "claude" if !crate::v4_agent::supports(&state.provider) => CLAUDE_ENABLE_VARIABLE,
        _ => return false,
    };
    if std::env::var(variable).is_ok_and(|value| value == "1") {
        return true;
    }
    #[cfg(test)]
    if OPTED_IN
        .lock()
        .unwrap()
        .iter()
        .any(|(owner, session)| *owner == state.user_id && *session == state.id)
    {
        return true;
    }
    false
}

#[cfg(not(all(unix, feature = "native-codex-queue-preview")))]
pub(super) fn enabled_for(_state: &StructuredSessionState) -> bool {
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Fence {
    Approval,
    Workspace,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DrainGate {
    Proceed,
    Skip(Fence),
    Hold,
}

/// Skip leaves the queue pending; Hold records a manual hold. Neither answers an approval.
pub(super) fn drain_gate(state: &StructuredSessionState) -> DrainGate {
    if state.session_incarnation.is_none() {
        return DrainGate::Hold;
    }
    if unresolved_codex_approval(&state.events)
        || thread_lifecycle::has_pending_request(&state.events)
    {
        return DrainGate::Skip(Fence::Approval);
    }
    if crate::workspace_activity::enter(Path::new(&state.cwd)).is_err() {
        return DrainGate::Skip(Fence::Workspace);
    }
    DrainGate::Proceed
}

static FENCE_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();
static RETRYING: std::sync::Mutex<Vec<(PathBuf, String, String, u64)>> =
    std::sync::Mutex::new(Vec::new());

struct RetryRegistration((PathBuf, String, String, u64));

impl Drop for RetryRegistration {
    fn drop(&mut self) {
        if let Ok(mut retrying) = RETRYING.lock() {
            retrying.retain(|entry| *entry != self.0);
        }
    }
}

#[cfg(test)]
thread_local! {
    static FALLBACK: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::from_secs(60)) };
}
#[cfg(all(test, unix, feature = "native-codex-queue-preview"))]
pub(super) fn set_fallback_for_test(value: std::time::Duration) {
    FALLBACK.with(|cell| cell.set(value));
}
#[cfg(all(test, unix, feature = "native-codex-queue-preview"))]
pub(super) fn retrying_for_test(data_dir: &Path) -> usize {
    RETRYING
        .lock()
        .unwrap()
        .iter()
        .filter(|(dir, _, _, _)| dir == data_dir)
        .count()
}
fn fallback_interval() -> std::time::Duration {
    #[cfg(test)]
    return FALLBACK.with(|cell| cell.get());
    #[cfg(not(test))]
    std::time::Duration::from_secs(5)
}

/// Wakes drains skipped by an approval fence; call after any event that can settle one.
pub(super) fn event_may_clear_fence(event: &StructuredSessionEvent) {
    if matches!(
        event,
        StructuredSessionEvent::ApprovalResolved { .. }
            | StructuredSessionEvent::ApprovalDecisionReviewed { .. }
            | StructuredSessionEvent::TurnCompleted { .. }
            | StructuredSessionEvent::SessionEnded { .. }
    ) {
        FENCE_CHANGED.notify_waiters();
    }
}

enum RetryState {
    Done,
    Clear,
    Fenced(Fence, PathBuf),
}

async fn retry_state(
    manager: &StructuredSessionManager,
    owner: &str,
    session_id: &str,
    generation: u64,
) -> Result<RetryState, String> {
    let Some(session) = manager.owned_session_internal(owner, session_id).await? else {
        return Ok(RetryState::Done);
    };
    let state = session.state.lock().await;
    if !enabled_for(&state)
        || state.user_id != owner
        || state.generation != generation
        || state.retiring
        || state.deleting
        || state.process.is_some()
    {
        return Ok(RetryState::Done);
    }
    let scope = queue::scope(&state).map_err(|error| error.message)?;
    let snapshot = queue::store(manager)
        .fail_fast()
        .inspect(&scope)
        .map_err(|error| format!("{error:?}"))?;
    let runnable = snapshot.is_some_and(|queue| {
        queue.mode == crate::followup_queue::QueueMode::Running
            && queue
                .items
                .iter()
                .any(|item| item.state == crate::followup_queue::ItemState::Pending)
    });
    if !runnable {
        return Ok(RetryState::Done);
    }
    Ok(match drain_gate(&state) {
        DrainGate::Skip(fence) => RetryState::Fenced(fence, PathBuf::from(&state.cwd)),
        DrainGate::Proceed | DrainGate::Hold => RetryState::Clear,
    })
}

/// Re-runs a drain that an approval or workspace fence skipped, once that fence clears.
/// Event driven with a bounded fallback timer; ends when the queue is held, empty or the turn changes.
pub(super) fn schedule_retry(
    manager: &StructuredSessionManager,
    owner: &str,
    session_id: &str,
    generation: u64,
) {
    let key = (
        manager.inner.config.data_dir.clone(),
        owner.to_owned(),
        session_id.to_owned(),
        generation,
    );
    {
        let mut retrying = RETRYING.lock().unwrap();
        if retrying.contains(&key) {
            return;
        }
        retrying.push(key.clone());
    }
    let manager = manager.clone();
    let (owner, session_id) = (owner.to_owned(), session_id.to_owned());
    let registration = RetryRegistration(key);
    tokio::spawn(async move {
        let clear = loop {
            let changed = FENCE_CHANGED.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match retry_state(&manager, &owner, &session_id, generation).await {
                Ok(RetryState::Clear) => break true,
                Ok(RetryState::Done) => break false,
                Ok(RetryState::Fenced(fence, cwd)) => {
                    let workspace = async {
                        if fence == Fence::Workspace {
                            if let Ok(guard) = crate::workspace_activity::enter_wait(&cwd).await {
                                drop(guard);
                                return;
                            }
                        }
                        std::future::pending::<()>().await
                    };
                    tokio::select! {
                        _ = &mut changed => {}
                        _ = workspace => {}
                        _ = tokio::time::sleep(fallback_interval()) => {}
                    }
                }
                Err(_) => {
                    tokio::select! {
                        _ = &mut changed => {}
                        _ = tokio::time::sleep(fallback_interval()) => {}
                    }
                }
            }
        };
        drop(registration);
        if clear {
            let _ = queue::drain(manager, owner, session_id, generation).await;
        }
    });
}

fn last_turn_completed_cleanly(provider: &str, events: &[StructuredSessionEvent]) -> bool {
    if provider == "claude" {
        return claude_turn_completed_cleanly(events);
    }
    let Some(turn) = events.iter().rev().find_map(|event| match event {
        StructuredSessionEvent::UserMessageAccepted { turn_id, .. } => Some(turn_id.as_str()),
        _ => None,
    }) else {
        return false;
    };
    events.iter().any(|event| {
        matches!(event, StructuredSessionEvent::TurnCompleted { turn_id, status, .. }
            if turn_id == turn && status == "completed")
    })
}

/// A Claude run is one turn: it is clean only when the CLI ended `completed` with no error after the last user message.
fn claude_turn_completed_cleanly(events: &[StructuredSessionEvent]) -> bool {
    let Some(start) = events.iter().rposition(|event| {
        matches!(event, StructuredSessionEvent::MessageCompleted { role, .. } if role == "user")
    }) else {
        return false;
    };
    let after = &events[start + 1..];
    !after
        .iter()
        .any(|event| matches!(event, StructuredSessionEvent::Error { .. }))
        && after.iter().any(|event| {
            matches!(event, StructuredSessionEvent::SessionEnded { reason, .. } if reason == "completed")
        })
}

/// Idle boundary for a native Codex or Claude turn. Anything but a clean completion holds the queue.
pub(super) fn turn_finished(
    manager: StructuredSessionManager,
    owner: String,
    session_id: String,
    generation: u64,
) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
    Box::pin(async move {
        let Some(session) = manager.owned_session_internal(&owner, &session_id).await? else {
            return Ok(());
        };
        let (applies, clean) = {
            let state = session.state.lock().await;
            (
                enabled_for(&state) && state.generation == generation && state.process.is_none(),
                last_turn_completed_cleanly(&state.provider, &state.events),
            )
        };
        if !applies {
            return Ok(());
        }
        if !clean {
            return queue::hold_generation(&manager, &owner, &session_id, generation).await;
        }
        queue::drain(manager, owner, session_id, generation).await
    })
}

/// Canonical acceptance of a queued request, by journal for Codex and by the durable request ledger for Claude.
pub(super) fn canonical_receipt(
    data_dir: &Path,
    state: &StructuredSessionState,
    request_id: &str,
) -> Result<Option<(StructuredReceipt, String)>, StructuredControlError> {
    if state.provider != "claude" {
        return Ok(receipt_from_events(&state.events, request_id));
    }
    let config = AppConfig {
        data_dir: data_dir.to_path_buf(),
        ..Default::default()
    };
    let Some(intent) = request_ledger::find_intent(&config, &state.user_id, &state.id, request_id)
        .map_err(StructuredControlError::internal)?
    else {
        return Ok(None);
    };
    let Some(mut receipt) = request_ledger::accepted_receipt(&state.events, &intent) else {
        return Ok(None);
    };
    let content = state.events.iter().find_map(|event| match event {
        StructuredSessionEvent::MessageCompleted {
            message_id: Some(message_id),
            role,
            content,
            ..
        } if role == "user" && *message_id == intent.message_id => Some(content.clone()),
        _ => None,
    });
    let Some(content) = content else {
        return Ok(None);
    };
    receipt.turn_id = receipt.message_id.clone();
    Ok(Some((receipt, content)))
}

/// Fails closed and holds the queue when the stored journal is ahead of this manager.
pub(super) fn ensure_disk_not_ahead(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    store: &crate::followup_queue::QueueStore,
) -> Result<(), StructuredControlError> {
    let ahead = request_ledger::events_ahead_of(
        &manager.inner.config,
        &state.user_id,
        &state.id,
        &state.events,
    )
    .map_err(StructuredControlError::internal)?;
    if ahead.is_none() {
        return Ok(());
    }
    let scope = crate::followup_queue::QueueScope::new_native(
        &state.user_id,
        Path::new(&state.cwd),
        &state.id,
    )
    .map_err(|error| StructuredControlError::internal(format!("{error:?}")))?;
    store
        .hold(&scope, crate::followup_queue::HoldReason::DispatchError)
        .map_err(|error| StructuredControlError::internal(format!("{error:?}")))?;
    Err(StructuredControlError::conflict(
        "Session changed in another manager; queue held for review",
    ))
}

/// Proof of the queue item's signed authority, or None only in a build with no credential admission bound.
#[cfg(unix)]
pub(super) fn dispatch_authority(
    manager: &StructuredSessionManager,
    state: &StructuredSessionState,
    request_id: Option<&str>,
    text: &str,
) -> Result<Option<crate::auth::LocalAuthority>, StructuredControlError> {
    if state.session_incarnation.is_none() {
        return Err(StructuredControlError::conflict(
            "This older conversation lacks a durable identity; the queued message stays held",
        ));
    }
    let request_id = Uuid::parse_str(
        request_id
            .ok_or_else(|| StructuredControlError::invalid("Codex send requires requestId"))?,
    )
    .map_err(|_| StructuredControlError::invalid("requestId must be a UUID"))?
    .to_string();
    let text = normalize_structured_input_message(text);
    let proof = queue::verify_queue_authority_for_admission(manager, state, &request_id, &text)?;
    if proof.is_none() && (cfg!(not(test)) || manager.inner.local_admission.get().is_some()) {
        return Err(StructuredControlError::conflict(
            "Queued message needs authorization. Sign in locally, edit and save the message, then resume the queue",
        ));
    }
    proof
        .map(crate::auth::LocalAuthority::from_verified_queue)
        .transpose()
        .map_err(StructuredControlError::conflict)
}
