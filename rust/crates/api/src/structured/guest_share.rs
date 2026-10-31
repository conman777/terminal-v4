use super::*;

#[cfg(test)]
static GUEST_VIEW_FAILURES: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::HashMap<
            String,
            (
                tokio::sync::oneshot::Sender<()>,
                tokio::sync::oneshot::Receiver<()>,
            ),
        >,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub(crate) struct GuestView<'a> {
    pub(crate) incarnation: String,
    pub(crate) title: &'a str,
    pub(crate) cwd: &'a str,
    pub(crate) events: &'a [StructuredSessionEvent],
}

impl StructuredSessionManager {
    pub(crate) async fn load_guest_owner_authorized(
        &self,
        owner: &str,
        app: &crate::state::AppState,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
    ) -> Result<(), String> {
        if local.is_some() == paired.is_some()
            || self
                .inner
                .config
                .data_dir
                .canonicalize()
                .map_err(|_| "Credential admission unavailable")?
                != app
                    .config()
                    .data_dir
                    .canonicalize()
                    .map_err(|_| "Credential admission unavailable")?
        {
            return Err("Credential scope mismatch".into());
        }
        #[cfg(unix)]
        let _permit = self.external_admission()?;
        #[cfg(unix)]
        let _owner_permit = self.external_owner_admission(owner)?;
        let admission = SessionReadAdmission {
            app,
            local,
            paired,
            nonblocking: true,
        };
        self.load_user_sessions_checked(owner, Some(admission))
            .await
            .map_err(ThreadUpdateFailure::message)
    }

    // Owner mutations must not trigger unguarded cold-load recovery after their
    // credentials were checked by middleware. The conversation must already be
    // loaded through the authorized session routes.
    pub(crate) async fn with_cached_guest_view<R>(
        &self,
        owner: &str,
        id: &str,
        read: impl FnOnce(GuestView<'_>) -> R,
    ) -> Result<Option<R>, String> {
        #[cfg(unix)]
        let _permit = self.external_admission()?;
        #[cfg(unix)]
        let _owner_permit = self.external_owner_admission(owner)?;
        let session = self.inner.sessions.lock().await.get(id).cloned();
        let Some(session) = session else {
            return Ok(None);
        };
        let state = session.state.lock().await;
        if state.user_id != owner || state.deleting || state.retiring {
            return Ok(None);
        }
        let incarnation = state
            .session_incarnation
            .map(|value| value.0.to_string())
            .unwrap_or_else(|| "legacy".into());
        Ok(Some(read(GuestView {
            incarnation,
            title: &state.title,
            cwd: &state.cwd,
            events: &state.events,
        })))
    }

    pub(crate) async fn with_guest_view<R>(
        &self,
        owner: &str,
        id: &str,
        read: impl FnOnce(GuestView<'_>) -> R,
    ) -> Result<Option<R>, String> {
        #[cfg(test)]
        {
            let hook = GUEST_VIEW_FAILURES.lock().unwrap().remove(id);
            if let Some((entered, release)) = hook {
                let _ = entered.send(());
                let _ = release.await;
                return Err("synthetic temporary lookup failure".into());
            }
        }
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
            cwd: &state.cwd,
            events: &state.events,
        })))
    }

    #[cfg(test)]
    pub(crate) fn fail_guest_view_once_for_test(
        &self,
        id: &str,
        entered: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) {
        GUEST_VIEW_FAILURES
            .lock()
            .unwrap()
            .insert(id.into(), (entered, release));
    }

    #[cfg(test)]
    pub(crate) async fn hold_guest_view_for_test(
        &self,
        owner: &str,
        id: &str,
        entered: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) {
        let session = self.owned_session(owner, id).await.unwrap().unwrap();
        let _state = session.state.lock().await;
        let _ = entered.send(());
        let _ = release.await;
    }

    #[cfg(test)]
    pub(crate) async fn clear_cached_guest_session_for_test(&self, owner: &str, id: &str) {
        self.inner.sessions.lock().await.remove(id);
        self.inner.loaded_owners.lock().await.remove(owner);
    }

    #[cfg(test)]
    pub(crate) fn notify_guest_load_for_test(&self, sender: tokio::sync::oneshot::Sender<()>) {
        *self.inner.read_load_entered.lock().unwrap() = Some(sender);
    }

    #[cfg(test)]
    pub(crate) async fn hold_guest_load_for_test(
        &self,
        entered: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) {
        let _loaded = self.inner.loaded_owners.lock().await;
        let _ = entered.send(());
        let _ = release.await;
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
