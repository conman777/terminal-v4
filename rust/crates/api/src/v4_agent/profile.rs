use super::*;
use crate::provider_connections::{
    inference::{
        turn::{Event, Group, Target},
        Selection,
    },
    ExecutionAccount, ProviderConnectionManager,
};
use terminal_v4_provider_connections::Transport;
pub(crate) struct Binding {
    pub(crate) profile_id: String,
    pub(crate) revision: String,
    pub(crate) transport: Transport,
}
impl Binding {
    pub(crate) fn parse(provider: &str) -> Option<Self> {
        let mut parts = provider.split(':');
        if parts.next()? != "v4-profile" {
            return None;
        }
        let transport = match parts.next()? {
            "chat" => Transport::OpenAiChat,
            "responses" => Transport::OpenAiResponses,
            _ => return None,
        };
        let profile_id = parts.next()?;
        let revision = parts.next()?;
        for id in [profile_id, revision] {
            let parsed = uuid::Uuid::parse_str(id).ok()?;
            if parsed.is_nil() || parsed.to_string() != id {
                return None;
            }
        }
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            profile_id: profile_id.into(),
            revision: revision.into(),
            transport,
        })
    }
    pub(crate) fn provider_id(profile: &str, revision: &str, transport: Transport) -> String {
        format!(
            "v4-profile:{}:{profile}:{revision}",
            match transport {
                Transport::OpenAiChat => "chat",
                Transport::OpenAiResponses => "responses",
            }
        )
    }
    pub(super) fn protocol(&self) -> &'static str {
        match self.transport {
            Transport::OpenAiChat => "openai-chat",
            Transport::OpenAiResponses => "openai-responses",
        }
    }
}
pub(super) struct Profile {
    target: Target,
    scope: ActionScope,
    group: Arc<Group>,
}
impl Profile {
    pub(super) fn new(
        binding: Binding,
        manager: ProviderConnectionManager,
        owner: &str,
        model: &str,
        scope: ActionScope,
        resources: &interaction::TurnResources,
    ) -> Result<Self, String> {
        let group = resources.profile_group(&scope)?;
        Ok(Self {
            target: Target {
                manager,
                account: ExecutionAccount {
                    user_id: owner.into(),
                    username: owner.into(),
                },
                selection: Selection {
                    profile_id: binding.profile_id,
                    revision: binding.revision,
                    model: model.into(),
                },
                transport: binding.transport,
            },
            scope,
            group,
        })
    }
    pub(super) async fn request(
        &self,
        body: Value,
        consumer: terminal_v4_provider_connections::inference::InferenceConsumer,
        target: &mut TextTarget<'_>,
    ) -> Result<(Value, bool), String> {
        let mut exchange = self
            .group
            .start(&self.target, &self.scope, consumer, body)?;
        loop {
            match exchange.next().await {
                Some(Event::Text(text)) => target.text(&text).await?,
                Some(Event::Finished(result)) => return result,
                None => return Err(
                    "Provider request worker stopped; cleanup must be confirmed before retrying"
                        .into(),
                ),
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod compaction_test_gate {
    use std::{
        collections::HashMap,
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
    };
    use tokio::sync::oneshot;
    type Gate = (oneshot::Sender<()>, oneshot::Receiver<()>);
    fn gates() -> &'static Mutex<HashMap<PathBuf, Gate>> {
        static GATES: OnceLock<Mutex<HashMap<PathBuf, Gate>>> = OnceLock::new();
        GATES.get_or_init(Default::default)
    }
    pub(crate) fn install(data: &Path) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered, receive) = oneshot::channel();
        let (release, resume) = oneshot::channel();
        assert!(gates()
            .lock()
            .unwrap()
            .insert(data.into(), (entered, resume))
            .is_none());
        (receive, release)
    }
    pub(crate) async fn checkpoint(data: &Path) {
        let gate = gates().lock().unwrap().remove(data);
        if let Some((entered, resume)) = gate {
            let _ = entered.send(());
            let _ = resume.await;
        }
    }
}
