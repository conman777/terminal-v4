use super::*;

#[cfg(all(unix, feature = "native-codex-queue-preview"))]
const ENABLE_VARIABLE: &str = "TERMINAL_V4_NATIVE_CODEX_QUEUE";

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
    if state.provider != "codex" {
        return false;
    }
    if std::env::var(ENABLE_VARIABLE).is_ok_and(|value| value == "1") {
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

#[cfg_attr(
    not(all(unix, feature = "native-codex-queue-preview")),
    allow(dead_code)
)]
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DrainGate {
    Proceed,
    Skip,
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
        return DrainGate::Skip;
    }
    if crate::workspace_activity::enter(Path::new(&state.cwd)).is_err() {
        return DrainGate::Skip;
    }
    DrainGate::Proceed
}

fn last_turn_completed_cleanly(events: &[StructuredSessionEvent]) -> bool {
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

/// Idle boundary for a native Codex turn. Anything but a clean completion holds the queue.
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
                last_turn_completed_cleanly(&state.events),
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
    Ok(proof.map(crate::auth::LocalAuthority::from_verified_queue))
}
