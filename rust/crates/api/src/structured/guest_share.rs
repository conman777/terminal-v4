use super::*;

pub(crate) struct GuestView<'a> {
    pub(crate) incarnation: String,
    pub(crate) title: &'a str,
    pub(crate) events: &'a [StructuredSessionEvent],
}

impl StructuredSessionManager {
    pub(crate) async fn with_guest_view<R>(
        &self,
        owner: &str,
        id: &str,
        read: impl FnOnce(GuestView<'_>) -> R,
    ) -> Result<Option<R>, String> {
        let Some(session) = self.owned_session(owner, id).await? else {
            return Ok(None);
        };
        let state = session.state.lock().await;
        if state.deleting || state.retiring {
            return Ok(None);
        }
        let incarnation = state
            .session_incarnation
            .map(|value| value.0.to_string())
            .unwrap_or_else(|| "legacy".into());
        Ok(Some(read(GuestView {
            incarnation,
            title: &state.title,
            events: &state.events,
        })))
    }

    #[cfg(test)]
    pub(crate) async fn push_event_for_test(
        &self,
        owner: &str,
        id: &str,
        event: StructuredSessionEvent,
    ) {
        let session = self.owned_session(owner, id).await.unwrap().unwrap();
        session.state.lock().await.events.push(event);
    }
}
