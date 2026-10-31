use super::*;
use crate::v4_agent::background_process::{
    BackgroundCompletion, BackgroundProcesses, BackgroundState,
};

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const NOTICE_ID_PREFIX: &str = "background-completion:";

#[derive(Debug, Eq, PartialEq)]
enum Disposition {
    Delivered,
    Stale,
    Held,
}

fn printable(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .take(128)
        .collect()
}

fn outcome_phrase(state: &BackgroundState) -> String {
    match state {
        BackgroundState::Exited { code: Some(code) } => format!("exited with code {code}"),
        BackgroundState::Exited { code: None } => "exited".into(),
        BackgroundState::Cancelled => "was cancelled".into(),
        BackgroundState::TimedOut => "timed out".into(),
        BackgroundState::FailedToStart => "failed to start".into(),
        BackgroundState::Running => "is still running".into(),
        BackgroundState::CleanupUnconfirmed | BackgroundState::Unknown => {
            "ended with an unconfirmed outcome".into()
        }
    }
}

pub(super) fn notice_event(completion: &BackgroundCompletion) -> StructuredSessionEvent {
    let action = printable(&completion.action_id);
    StructuredSessionEvent::MessageCompleted {
        message_id: Some(format!("{NOTICE_ID_PREFIX}{action}")),
        turn_id: None,
        ts: now_ts(),
        seq: 0,
        role: "system".into(),
        content: format!(
            "Background command {action} {}. Its output is not included; output release is currently unavailable.",
            outcome_phrase(&completion.state)
        ),
    }
}

impl StructuredSessionManager {
    async fn deliver_background_completion(
        &self,
        background: &BackgroundProcesses,
        completion: &BackgroundCompletion,
    ) -> Disposition {
        let scope = &completion.scope;
        let Some(incarnation) = scope.incarnation else {
            return Disposition::Stale;
        };
        if background.delivery_open(scope).await.is_err() {
            return Disposition::Held;
        }
        let session = match self
            .owned_session_internal(&scope.owner, &scope.session)
            .await
        {
            Ok(Some(session)) => session,
            Ok(None) => return Disposition::Stale,
            Err(_) => return Disposition::Held,
        };
        let generation = {
            let state = session.state.lock().await;
            if state.user_id != scope.owner
                || state.id != scope.session
                || state.session_incarnation != Some(SessionIncarnation(incarnation))
                || Path::new(&state.cwd) != scope.workspace
            {
                return Disposition::Stale;
            }
            if state.deleting || state.retiring {
                return Disposition::Held;
            }
            state.generation
        };
        match storage::read_for_recovery(&self.inner.config, &scope.owner, &scope.session) {
            Ok(stored)
                if stored.owner_id == scope.owner
                    && stored.snapshot.id == scope.session
                    && stored.session_incarnation == Some(SessionIncarnation(incarnation))
                    && Path::new(&stored.snapshot.cwd) == scope.workspace => {}
            Ok(_) => return Disposition::Stale,
            Err(_) => return Disposition::Held,
        }
        match self
            .record_event_generation(
                &scope.owner,
                &scope.session,
                Some(generation),
                notice_event(completion),
            )
            .await
        {
            Ok(()) => Disposition::Delivered,
            Err(_) => Disposition::Held,
        }
    }

    pub(crate) async fn deliver_background_completions(&self) -> Result<usize, String> {
        let Some(background) = self.inner.background_processes.get().cloned() else {
            return Ok(0);
        };
        let mut delivered = 0;
        loop {
            let page = background.pending_completions()?;
            if page.is_empty() {
                return Ok(delivered);
            }
            let mut progressed = false;
            for (seq, completion) in page {
                match self
                    .deliver_background_completion(&background, &completion)
                    .await
                {
                    Disposition::Held => {}
                    disposition => {
                        progressed = true;
                        if background.acknowledge_completion(seq)?
                            && disposition == Disposition::Delivered
                        {
                            delivered += 1;
                        }
                    }
                }
            }
            if !progressed {
                return Ok(delivered);
            }
        }
    }

    pub(crate) fn start_background_completion_worker(&self) -> Result<(), String> {
        let Some(background) = self.inner.background_processes.get().cloned() else {
            return Ok(());
        };
        if !background.commands_enabled() || !background.claim_completion_worker() {
            return Ok(());
        }
        tokio::runtime::Handle::try_current()
            .map_err(|_| "Background completion delivery requires an async runtime")?;
        let inner = Arc::downgrade(&self.inner);
        let mut events = background.subscribe_completions();
        tokio::spawn(async move {
            loop {
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                if background.is_closed().await {
                    return;
                }
                let manager = StructuredSessionManager { inner };
                if let Err(error) = manager.deliver_background_completions().await {
                    tracing::warn!(%error, "Background completion delivery failed");
                }
                drop(manager);
                if let Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) =
                    tokio::time::timeout(POLL_INTERVAL, events.recv()).await
                {
                    return;
                }
            }
        });
        Ok(())
    }
}

#[cfg(test)]
#[path = "background_completion_tests.rs"]
mod tests;
