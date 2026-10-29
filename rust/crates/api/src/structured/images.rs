use super::*;
use crate::v4_agent::user_images::{self, Store};
use terminal_v4_core::ImageAttachment;

fn control(error: user_images::Error) -> StructuredControlError {
    StructuredControlError {
        code: error.code,
        message: error.message,
    }
}
pub(super) fn pins(events: &[StructuredSessionEvent]) -> Vec<ImageAttachment> {
    events
        .iter()
        .flat_map(|event| match event {
            StructuredSessionEvent::UserMessageAccepted { attachments, .. } => attachments.clone(),
            _ => Vec::new(),
        })
        .collect()
}
impl StructuredSessionManager {
    pub(crate) async fn upload_image(
        &self,
        owner: &str,
        id: &str,
        upload_id: &str,
        mime: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<(ImageAttachment, i64, bool), StructuredControlError> {
        let session = self
            .owned_session(owner, id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let state = session.state.lock().await;
        if state.deleting || state.retiring {
            return Err(StructuredControlError::conflict("Session is closing"));
        }
        if !crate::v4_agent::supports(&state.provider) {
            return Err(StructuredControlError::invalid(
                "User images require an owned V4 conversation",
            ));
        }
        let engine = engine_session_id(id).map_err(StructuredControlError::internal)?;
        let mut store = Store::open(
            &self.inner.config.data_dir,
            owner,
            Path::new(&state.cwd),
            &engine,
            crate::v4_agent::interaction::now_ms(),
        )
        .map_err(control)?;
        let pins = pins(&state.events);
        store.collect(&pins).map_err(control)?;
        if state.process.is_none() && !state.retiring {
            store.collect_engine_copies(&pins).map_err(control)?;
        }
        store.upload(upload_id, mime, name, bytes).map_err(control)
    }
    pub(crate) async fn read_user_image(
        &self,
        owner: &str,
        id: &str,
        attachment: &str,
    ) -> Result<(ImageAttachment, Vec<u8>, i64), StructuredControlError> {
        let session = self
            .owned_session(owner, id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let state = session.state.lock().await;
        if state.deleting {
            return Err(StructuredControlError::not_found());
        }
        let engine = engine_session_id(id).map_err(StructuredControlError::internal)?;
        let mut store = Store::open(
            &self.inner.config.data_dir,
            owner,
            Path::new(&state.cwd),
            &engine,
            crate::v4_agent::interaction::now_ms(),
        )
        .map_err(control)?;
        let pins = pins(&state.events);
        store.collect(&pins).map_err(control)?;
        if state.process.is_none() && !state.retiring {
            store.collect_engine_copies(&pins).map_err(control)?;
        }
        store.read(attachment, &pins).map_err(control)
    }
    pub(crate) async fn cancel_user_image(
        &self,
        owner: &str,
        id: &str,
        attachment: &str,
    ) -> Result<(), StructuredControlError> {
        let session = self
            .owned_session(owner, id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let state = session.state.lock().await;
        if state.deleting {
            return Err(StructuredControlError::not_found());
        }
        let engine = engine_session_id(id).map_err(StructuredControlError::internal)?;
        let mut store = Store::open(
            &self.inner.config.data_dir,
            owner,
            Path::new(&state.cwd),
            &engine,
            crate::v4_agent::interaction::now_ms(),
        )
        .map_err(control)?;
        store.cancel(attachment).map_err(control)?;
        let pins = pins(&state.events);
        store.collect(&pins).map_err(control)?;
        if state.process.is_none() && !state.retiring {
            store.collect_engine_copies(&pins).map_err(control)?;
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) async fn submit_images(
        &self,
        owner: &str,
        id: &str,
        text: &str,
        request_id: &str,
        attachments: &[ImageAttachment],
    ) -> Result<StructuredReceipt, StructuredControlError> {
        self.submit_content(
            owner,
            id,
            text,
            Some(request_id),
            attachments,
            true,
            None,
            None,
            None,
            None,
            #[cfg(unix)]
            false,
        )
        .await
    }

    pub(crate) async fn submit_images_authorized(
        &self,
        owner: &str,
        id: &str,
        text: &str,
        request_id: &str,
        attachments: &[ImageAttachment],
        authority: Option<&crate::auth::LocalAuthority>,
        app_state: &crate::state::AppState,
    ) -> Result<StructuredReceipt, StructuredControlError> {
        self.submit_content(
            owner,
            id,
            text,
            Some(request_id),
            attachments,
            true,
            authority,
            None,
            None,
            Some(app_state),
            #[cfg(unix)]
            false,
        )
        .await
    }
}
