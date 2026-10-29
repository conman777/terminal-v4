use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    io::Write,
    time::Duration,
};
use terminal_v4_core::StructuredSessionEvent;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{oneshot, watch, Mutex};

#[derive(Clone)]
pub(crate) struct Cancellation(watch::Sender<bool>, Arc<std::sync::RwLock<()>>);
impl Default for Cancellation {
    fn default() -> Self {
        Self(
            watch::channel(false).0,
            Arc::new(std::sync::RwLock::new(())),
        )
    }
}
impl Cancellation {
    pub(crate) fn cancel(&self) {
        self.0.send_replace(true);
    }
    #[cfg(unix)]
    pub(crate) fn cancel_checked(
        &self,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let _admission = self
            .1
            .try_write()
            .map_err(|_| "Stop admission is busy; retry".to_string())?;
        let mut result = Ok(());
        self.0.send_if_modified(|cancelled| {
            result = check();
            if result.is_err() || *cancelled {
                return false;
            }
            *cancelled = true;
            true
        });
        result
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("Turn cancelled".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn admit<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _admission = self
            .1
            .read()
            .map_err(|_| "Cancellation admission unavailable".to_string())?;
        // Hold the watch read guard through the short synchronous admission so
        // cancellation and the action have one observable ordering.
        let cancelled = self.0.borrow();
        if *cancelled {
            return Err("Turn cancelled".into());
        }
        let result = action();
        drop(cancelled);
        result
    }
    pub(crate) async fn run<T>(
        &self,
        operation: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.check()?;
        tokio::select! {
            biased;
            _ = self.cancelled() => Err("Turn cancelled".into()),
            result = operation => result,
        }
    }
    pub(crate) async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ActionScope {
    pub(crate) owner: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ApprovalRequest {
    pub(crate) id: String,
    pub(crate) scope: ActionScope,
    pub(crate) tool_call_id: String,
    pub(crate) tool_name: String,
    pub(crate) tool_input: Value,
    pub(crate) description: String,
    pub(crate) expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionReceipt {
    pub(crate) status: String,
    pub(crate) approval_id: String,
    pub(crate) approved: bool,
}

#[async_trait]
pub(crate) trait Interaction: Send + Sync {
    async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String>;
    async fn approve(&self, request: ApprovalRequest) -> Result<bool, String>;
    async fn question(&self, _request: ApprovalRequest) -> Result<Option<Value>, String> {
        Err("Questions require an interactive structured conversation".into())
    }
}

struct PendingApproval {
    request: ApprovalRequest,
    cancel: Cancellation,
    reply: Option<oneshot::Sender<Option<Value>>>,
}
#[derive(Default)]
struct ApprovalState {
    pending: Option<PendingApproval>,
    decisions: VecDeque<DecisionReceipt>,
    answers: HashMap<String, Value>,
}
pub(crate) struct ApprovalGate {
    scope: ActionScope,
    state: Mutex<ApprovalState>,
}
impl ApprovalGate {
    pub(crate) fn new(scope: ActionScope) -> Self {
        Self {
            scope,
            state: Mutex::new(ApprovalState::default()),
        }
    }
    #[cfg(test)]
    pub(crate) fn matches_scope(&self, scope: &ActionScope) -> bool {
        self.scope == *scope
    }
    pub(crate) async fn wait(
        &self,
        request: ApprovalRequest,
        sink: &dyn Interaction,
        cancel: &Cancellation,
    ) -> Result<bool, String> {
        self.wait_inner(request, sink, cancel)
            .await
            .map(|answer| answer == Some(Value::Bool(true)))
    }
    pub(crate) async fn wait_question(
        &self,
        request: ApprovalRequest,
        sink: &dyn Interaction,
        cancel: &Cancellation,
    ) -> Result<Option<Value>, String> {
        if request.tool_name != "ask_user" {
            return Err("Invalid question action".into());
        }
        super::question::validate_questions(&request.tool_input)?;
        self.wait_inner(request, sink, cancel).await
    }
    async fn wait_inner(
        &self,
        request: ApprovalRequest,
        sink: &dyn Interaction,
        cancel: &Cancellation,
    ) -> Result<Option<Value>, String> {
        cancel.check()?;
        if request.scope != self.scope || request.expires_at <= now_ms() {
            return Err("Approval scope or expiry is invalid".into());
        }
        let (send, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().await;
            if state.pending.is_some()
                || state
                    .decisions
                    .iter()
                    .any(|decision| decision.approval_id == request.id)
            {
                return Err("An approval is already pending or this action was decided".into());
            }
            state.pending = Some(PendingApproval {
                request: request.clone(),
                cancel: cancel.clone(),
                reply: Some(send),
            });
        }
        if let Err(error) = sink
            .emit(StructuredSessionEvent::ApprovalRequired {
                ts: now_ms(),
                seq: 0,
                approval_id: Some(request.id.clone()),
                turn_id: Some(request.scope.turn_id.clone()),
                tool_call_id: Some(request.tool_call_id.clone()),
                expires_at: Some(request.expires_at),
                tool_name: request.tool_name.clone(),
                tool_input: request.tool_input.clone(),
                description: request.description.clone(),
            })
            .await
        {
            self.remove(&request.id).await;
            return Err(error);
        }
        let result = tokio::select! {
            biased;
            _=cancel.cancelled()=>Err("Turn cancelled".into()),
            _=tokio::time::sleep(Duration::from_millis((request.expires_at-now_ms()).max(0) as u64))=>Err("Approval expired".into()),
            answer=receive=>answer.map_err(|_|"Approval is no longer pending".to_string()),
        };
        if let Err(reason) = &result {
            let mut state = self.state.lock().await;
            if !state
                .decisions
                .iter()
                .any(|decision| decision.approval_id == request.id)
            {
                sink.emit(StructuredSessionEvent::ApprovalResolved {
                    ts: now_ms(),
                    seq: 0,
                    approval_id: request.id.clone(),
                    turn_id: request.scope.turn_id.clone(),
                    approved: false,
                    reason: Some(reason.clone()),
                })
                .await?;
            }
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.request.id == request.id)
            {
                state.pending = None;
            }
        } else {
            self.remove(&request.id).await;
        }
        result
    }
    async fn remove(&self, id: &str) {
        let mut state = self.state.lock().await;
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request.id == id)
        {
            state.pending = None;
        }
    }
    pub(crate) async fn cancel_pending(
        &self,
        sink: &dyn Interaction,
        reason: &str,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if let Some(pending) = state.pending.as_ref() {
            if !state
                .decisions
                .iter()
                .any(|decision| decision.approval_id == pending.request.id)
            {
                sink.emit(StructuredSessionEvent::ApprovalResolved {
                    ts: now_ms(),
                    seq: 0,
                    approval_id: pending.request.id.clone(),
                    turn_id: self.scope.turn_id.clone(),
                    approved: false,
                    reason: Some(reason.into()),
                })
                .await?;
            }
            state.pending = None;
        }
        Ok(())
    }
    pub(crate) async fn decide(
        &self,
        id: &str,
        approved: bool,
        sink: &dyn Interaction,
    ) -> Result<DecisionReceipt, String> {
        self.decide_with_expiry(id, approved, sink, None).await
    }

    pub(crate) async fn decide_with_expiry(
        &self,
        id: &str,
        approved: bool,
        sink: &dyn Interaction,
        expires_at: Option<i64>,
    ) -> Result<DecisionReceipt, String> {
        let mut state = self.state.lock().await;
        if expires_at.is_some_and(|expiry| now_ms() >= expiry) {
            return Err("Paired grant expired before approval".into());
        }
        if let Some(previous) = state
            .decisions
            .iter()
            .find(|decision| decision.approval_id == id)
        {
            if previous.approved != approved || (approved && state.answers.contains_key(id)) {
                return Err("This exact action already has a different decision".into());
            }
            return Ok(DecisionReceipt {
                status: "already_decided".into(),
                ..previous.clone()
            });
        }
        let pending = state
            .pending
            .as_ref()
            .filter(|pending| pending.request.id == id && pending.reply.is_some())
            .ok_or("Approval ID is stale or does not match the pending action")?;
        if pending.request.tool_name == "ask_user" && approved {
            return Err("Answer the question before sending".into());
        }
        if pending.request.scope != self.scope
            || pending.request.expires_at <= now_ms()
            || pending.cancel.is_cancelled()
            || pending.reply.as_ref().is_none_or(|reply| reply.is_closed())
        {
            return Err("Approval expired, cancelled, or changed scope".into());
        }
        if state.decisions.len() >= 64 {
            return Err("This turn's approval receipt storage is full".into());
        }
        if expires_at.is_some_and(|expiry| now_ms() >= expiry) {
            return Err("Paired grant expired before approval".into());
        }
        sink.emit(StructuredSessionEvent::ApprovalResolved {
            ts: now_ms(),
            seq: 0,
            approval_id: id.into(),
            turn_id: self.scope.turn_id.clone(),
            approved,
            reason: None,
        })
        .await?;
        let receipt = DecisionReceipt {
            status: "accepted".into(),
            approval_id: id.into(),
            approved,
        };
        state.decisions.push_back(receipt.clone());
        if let Some(reply) = state
            .pending
            .as_mut()
            .and_then(|pending| pending.reply.take())
        {
            let _ = reply.send(approved.then_some(Value::Bool(true)));
        }
        Ok(receipt)
    }
    pub(crate) async fn answer(
        &self,
        id: &str,
        answers: Value,
        sink: &dyn Interaction,
    ) -> Result<DecisionReceipt, String> {
        self.answer_with_expiry(id, answers, sink, None).await
    }

    pub(crate) async fn answer_with_expiry(
        &self,
        id: &str,
        answers: Value,
        sink: &dyn Interaction,
        expires_at: Option<i64>,
    ) -> Result<DecisionReceipt, String> {
        let mut state = self.state.lock().await;
        if expires_at.is_some_and(|expiry| now_ms() >= expiry) {
            return Err("Paired grant expired before answering".into());
        }
        if let Some(previous) = state
            .decisions
            .iter()
            .find(|decision| decision.approval_id == id)
        {
            if state.answers.get(id) != Some(&answers) {
                return Err("This question already has a different decision".into());
            }
            return Ok(DecisionReceipt {
                status: "already_decided".into(),
                ..previous.clone()
            });
        }
        let pending = state
            .pending
            .as_ref()
            .filter(|pending| pending.request.id == id && pending.reply.is_some())
            .ok_or("Question ID is stale or does not match the pending action")?;
        if pending.request.tool_name != "ask_user" {
            return Err("This action is not a question".into());
        }
        if pending.request.scope != self.scope
            || pending.request.expires_at <= now_ms()
            || pending.cancel.is_cancelled()
            || pending.reply.as_ref().is_none_or(|reply| reply.is_closed())
        {
            return Err("Question expired, cancelled, or changed scope".into());
        }
        super::question::validate_answers(&pending.request.tool_input, &answers)?;
        if state.decisions.len() >= 64 {
            return Err("This turn's approval receipt storage is full".into());
        }
        if expires_at.is_some_and(|expiry| now_ms() >= expiry) {
            return Err("Paired grant expired before answering".into());
        }
        sink.emit(StructuredSessionEvent::ApprovalResolved {
            ts: now_ms(),
            seq: 0,
            approval_id: id.into(),
            turn_id: self.scope.turn_id.clone(),
            approved: true,
            reason: None,
        })
        .await?;
        let receipt = DecisionReceipt {
            status: "accepted".into(),
            approval_id: id.into(),
            approved: true,
        };
        state.decisions.push_back(receipt.clone());
        state.answers.insert(id.into(), answers.clone());
        if let Some(reply) = state
            .pending
            .as_mut()
            .and_then(|pending| pending.reply.take())
        {
            let _ = reply.send(Some(answers));
        }
        Ok(receipt)
    }
}

struct PendingCheckpoint {
    data_dir: std::path::PathBuf,
    owner: String,
    session: super::Session,
}
pub(crate) struct TurnResources {
    pub(super) integrations: Mutex<super::integrations::Integrations>,
    pub(super) commands: super::tools::CommandResources,
    checkpoint: Mutex<Option<PendingCheckpoint>>,
    checkpoint_pending: std::sync::atomic::AtomicBool,
    confirmed: std::sync::atomic::AtomicBool,
    #[cfg(unix)]
    delegation: std::sync::Mutex<Option<std::sync::Weak<super::delegation_outbox::DelegationTurn>>>,
    #[cfg(test)]
    background_actor: std::sync::Mutex<
        Option<std::sync::Weak<dyn super::background_process::tool::BackgroundActor>>,
    >,
    #[cfg(unix)]
    profiles: std::sync::Mutex<
        Option<(
            ActionScope,
            Arc<crate::provider_connections::inference::turn::Group>,
        )>,
    >,
}
impl Default for TurnResources {
    fn default() -> Self {
        Self {
            integrations: Mutex::new(super::integrations::Integrations::default()),
            commands: super::tools::CommandResources::default(),
            checkpoint: Mutex::new(None),
            checkpoint_pending: std::sync::atomic::AtomicBool::new(false),
            confirmed: std::sync::atomic::AtomicBool::new(true),
            #[cfg(unix)]
            delegation: std::sync::Mutex::new(None),
            #[cfg(test)]
            background_actor: std::sync::Mutex::new(None),
            #[cfg(unix)]
            profiles: std::sync::Mutex::new(None),
        }
    }
}
impl TurnResources {
    #[cfg(unix)]
    pub(crate) fn bind_delegation(
        &self,
        turn: &Arc<super::delegation_outbox::DelegationTurn>,
    ) -> Result<(), String> {
        let mut slot = self
            .delegation
            .lock()
            .map_err(|_| "Delegation turn unavailable")?;
        if slot.as_ref().and_then(std::sync::Weak::upgrade).is_some() {
            return Err("A previous delegation turn is still active".into());
        }
        *slot = Some(Arc::downgrade(turn));
        Ok(())
    }
    #[cfg(unix)]
    pub(super) fn delegation(
        &self,
        scope: &ActionScope,
    ) -> Option<Arc<super::delegation_outbox::DelegationTurn>> {
        let turn = self.delegation.lock().ok()?.as_ref()?.upgrade()?;
        (turn.scope == *scope).then_some(turn)
    }
    #[cfg(test)]
    pub(crate) fn bind_background_actor(
        &self,
        actor: &Arc<dyn super::background_process::tool::BackgroundActor>,
    ) -> Result<(), String> {
        let mut slot = self
            .background_actor
            .lock()
            .map_err(|_| "Background turn unavailable")?;
        if slot.as_ref().and_then(std::sync::Weak::upgrade).is_some() {
            return Err("A previous background turn is still active".into());
        }
        *slot = Some(Arc::downgrade(actor));
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn background_actor(
        &self,
        scope: &ActionScope,
    ) -> Option<Arc<dyn super::background_process::tool::BackgroundActor>> {
        let actor = self.background_actor.lock().ok()?.as_ref()?.upgrade()?;
        (actor.scope() == scope).then_some(actor)
    }
    #[cfg(unix)]
    pub(super) fn profile_group(
        &self,
        scope: &ActionScope,
    ) -> Result<Arc<crate::provider_connections::inference::turn::Group>, String> {
        let mut current = self
            .profiles
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((bound, group)) = &*current {
            if bound == scope {
                return Ok(group.clone());
            }
            if !group.is_closed_and_confirmed() {
                return Err("Previous provider request cleanup remains unconfirmed".into());
            }
        }
        let group = Arc::new(crate::provider_connections::inference::turn::Group::default());
        *current = Some((scope.clone(), group.clone()));
        self.mark_open();
        Ok(group)
    }
    pub(super) async fn close_profiles(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            let group = self
                .profiles
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .map(|(_, group)| group.clone());
            if let Some(group) = group {
                group.close().await?;
            }
        }
        Ok(())
    }
    fn profiles_confirmed(&self) -> bool {
        #[cfg(unix)]
        if self
            .profiles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_some_and(|(_, group)| !group.is_confirmed())
        {
            return false;
        }
        true
    }
    #[cfg(all(test, unix))]
    pub(crate) async fn seed_browser_cleanup_test_client(
        &self,
        data: &std::path::Path,
        owner: &str,
        workspace: &std::path::Path,
    ) -> super::browser::CleanupProbe {
        let (client, probe) = super::browser::cleanup_test_client(data, owner, workspace).await;
        self.mark_open();
        self.integrations
            .lock()
            .await
            .install_browser_cleanup_test_client(client);
        probe
    }
    pub(super) fn mark_open(&self) {
        self.confirmed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
    pub(crate) fn is_confirmed(&self) -> bool {
        self.confirmed.load(std::sync::atomic::Ordering::SeqCst)
            && self.commands.is_confirmed()
            && self.profiles_confirmed()
            && !self
                .checkpoint_pending
                .load(std::sync::atomic::Ordering::SeqCst)
    }
    pub(super) async fn retain_checkpoint(
        &self,
        data: &std::path::Path,
        owner: &str,
        session: &super::Session,
    ) {
        *self.checkpoint.lock().await = Some(PendingCheckpoint {
            data_dir: data.into(),
            owner: owner.into(),
            session: session.clone(),
        });
        self.checkpoint_pending
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    async fn reconcile_checkpoint(&self) -> Result<(), String> {
        let mut pending = self.checkpoint.lock().await;
        let Some(checkpoint) = pending.as_mut() else {
            return Ok(());
        };
        let stored = super::load(
            &checkpoint.data_dir,
            &checkpoint.owner,
            std::path::Path::new(&checkpoint.session.workspace),
            &checkpoint.session.id,
        )
        .ok();
        if !stored.as_ref().is_some_and(|stored| {
            super::session_fingerprint(stored) == super::session_fingerprint(&checkpoint.session)
        }) {
            super::save(
                &checkpoint.data_dir,
                &checkpoint.owner,
                &mut checkpoint.session,
            )
            .map_err(|error| format!("Completed tool results could not be saved: {error}"))?;
        }
        *pending = None;
        self.checkpoint_pending
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    pub(super) async fn close_locked(
        &self,
        integrations: &mut super::integrations::Integrations,
    ) -> Result<(), String> {
        let (integration, command, profiles) = tokio::join!(
            integrations.close(),
            self.commands.close(),
            self.close_profiles()
        );
        let checkpoint = self.reconcile_checkpoint().await;
        let failures: Vec<_> = [integration, command, profiles, checkpoint]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        self.confirmed
            .store(failures.is_empty(), std::sync::atomic::Ordering::SeqCst);
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
    pub(crate) async fn close(&self) -> Result<(), String> {
        let mut integrations = self.integrations.lock().await;
        self.close_locked(&mut integrations).await
    }
}

pub(crate) fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

pub(super) struct CliInteraction {
    pub(super) session_id: String,
    pub(super) interactive: bool,
}
#[async_trait]
impl Interaction for CliInteraction {
    async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
        match event {
            StructuredSessionEvent::MessageDelta { content, .. } => {
                if self.interactive {
                    print!("{}", super::terminal_text(&content));
                    std::io::stdout()
                        .flush()
                        .map_err(|_| "Terminal output closed".to_string())?;
                } else {
                    println!(
                        "{}",
                        serde_json::json!({"type":"v4.text.delta","sessionId":self.session_id,"delta":content})
                    );
                }
            }
            StructuredSessionEvent::ToolOutput {
                stream: Some(_),
                output,
                ..
            } if self.interactive => {
                print!("{}", super::terminal_text(&output));
                std::io::stdout()
                    .flush()
                    .map_err(|_| "Terminal output closed".to_string())?;
            }
            StructuredSessionEvent::MessageCompleted { .. } if self.interactive => println!(),
            StructuredSessionEvent::ToolStarted { tool_name, .. } if self.interactive => {
                println!("[V4 tool: {}]", super::terminal_text(&tool_name))
            }
            StructuredSessionEvent::ToolCompleted {
                result,
                is_error: true,
                ..
            } if self.interactive => println!("{}", super::terminal_text(&result)),
            _ => {}
        }
        Ok(())
    }
    async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
        if !self.interactive {
            return Ok(false);
        }
        println!("{}", super::terminal_text(&request.description));
        Ok(matches!(
            super::read_line("Approve this exact action? [y/N] ")
                .await?
                .trim(),
            "y" | "Y" | "yes"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    #[test]
    fn cancellation_and_synchronous_admission_are_serialized() {
        let already_cancelled = Cancellation::default();
        already_cancelled.cancel();
        let mut called = false;
        assert!(already_cancelled
            .admit(|| {
                called = true;
                Ok(())
            })
            .is_err());
        assert!(!called);

        let cancellation = Cancellation::default();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let launch_cancellation = cancellation.clone();
        let launch = std::thread::spawn(move || {
            launch_cancellation.admit(|| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();
        let (attempted_tx, attempted_rx) = std::sync::mpsc::channel();
        let (cancelled_tx, cancelled_rx) = std::sync::mpsc::channel();
        let cancel = std::thread::spawn(move || {
            attempted_tx.send(()).unwrap();
            cancellation.cancel();
            cancelled_tx.send(()).unwrap();
        });
        attempted_rx.recv().unwrap();
        let returned_during_admission = cancelled_rx
            .recv_timeout(Duration::from_millis(100))
            .is_ok();
        release_tx.send(()).unwrap();
        launch.join().unwrap().unwrap();
        cancel.join().unwrap();
        assert!(!returned_during_admission);
    }

    struct Sink {
        events: Mutex<Vec<StructuredSessionEvent>>,
        ready: Notify,
        fail_resolution: AtomicBool,
        fail_required: AtomicBool,
    }
    impl Sink {
        fn new() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
                ready: Notify::new(),
                fail_resolution: AtomicBool::new(false),
                fail_required: AtomicBool::new(false),
            }
        }
    }
    #[async_trait]
    impl Interaction for Sink {
        async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
            if matches!(&event, StructuredSessionEvent::ApprovalRequired { .. })
                && self.fail_required.swap(false, Ordering::SeqCst)
            {
                return Err("fixture required-event journal unavailable".into());
            }
            if serde_json::to_value(&event).unwrap()["type"] == "approval_resolved"
                && self.fail_resolution.swap(false, Ordering::SeqCst)
            {
                return Err("fixture journal unavailable".into());
            }
            self.events.lock().await.push(event);
            self.ready.notify_one();
            Ok(())
        }
        async fn approve(&self, _request: ApprovalRequest) -> Result<bool, String> {
            Err("Fixture sink cannot recursively approve".into())
        }
    }
    fn scope() -> ActionScope {
        ActionScope {
            owner: "owner".into(),
            session_id: "session".into(),
            turn_id: "turn".into(),
        }
    }
    fn request() -> ApprovalRequest {
        ApprovalRequest {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope(),
            tool_call_id: "call".into(),
            tool_name: "run_command".into(),
            tool_input: json!({"command":"printf fixture"}),
            description: "Exact host command".into(),
            expires_at: (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
                + 30_000,
        }
    }
    async fn waiting(
        gate: Arc<ApprovalGate>,
        sink: Arc<Sink>,
        cancel: Cancellation,
        request: ApprovalRequest,
    ) -> tokio::task::JoinHandle<Result<bool, String>> {
        let observe = sink.clone();
        let task = tokio::spawn(async move { gate.wait(request, sink.as_ref(), &cancel).await });
        tokio::time::timeout(Duration::from_millis(300), observe.ready.notified())
            .await
            .expect("Approval must be published before a decision");
        task
    }
    #[tokio::test]
    async fn paired_approval_expiry_is_checked_after_gate_mutex() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let request = request();
        let id = request.id.clone();
        let pending = waiting(gate.clone(), sink.clone(), Cancellation::default(), request).await;
        let held = gate.state.lock().await;
        let expires = now_ms() + 150;
        let decision = tokio::spawn({
            let gate = gate.clone();
            let sink = sink.clone();
            let id = id.clone();
            async move {
                gate.decide_with_expiry(&id, true, sink.as_ref(), Some(expires))
                    .await
            }
        });
        while now_ms() < expires {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(held);
        assert!(decision.await.unwrap().is_err());
        assert!(!pending.is_finished());
        gate.decide(&id, false, sink.as_ref()).await.unwrap();
        assert!(!pending.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn question_answers_are_scoped_complete_and_idempotent() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let mut request = request();
        request.tool_name = "ask_user".into();
        request.tool_input = json!({"questions":[{"id":"platform","question":"Which platform?","options":[{"label":"Desktop"},{"label":"Mobile"}]},{"id":"reason","question":"Why?"}]});
        let id = request.id.clone();
        let waiting_gate = gate.clone();
        let waiting_sink = sink.clone();
        let task = tokio::spawn(async move {
            waiting_gate
                .wait_question(request, waiting_sink.as_ref(), &Cancellation::default())
                .await
        });
        tokio::time::timeout(Duration::from_millis(300), sink.ready.notified())
            .await
            .unwrap();
        assert!(gate
            .answer(
                "wrong",
                json!({"platform":["Mobile"],"reason":["Testing"]}),
                sink.as_ref()
            )
            .await
            .is_err());
        assert!(gate.decide(&id, true, sink.as_ref()).await.is_err());
        assert!(gate
            .answer(&id, json!({"platform":["Mobile"]}), sink.as_ref())
            .await
            .is_err());
        let answers = json!({"platform":["Mobile"],"reason":["Testing"]});
        assert_eq!(
            gate.answer(&id, answers.clone(), sink.as_ref())
                .await
                .unwrap()
                .status,
            "accepted"
        );
        assert_eq!(task.await.unwrap().unwrap(), Some(answers.clone()));
        assert_eq!(
            gate.answer(&id, answers, sink.as_ref())
                .await
                .unwrap()
                .status,
            "already_decided"
        );
        assert!(gate
            .answer(
                &id,
                json!({"platform":["Desktop"],"reason":["Testing"]}),
                sink.as_ref()
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn question_dismissal_and_cancellation_never_accept_late_answers() {
        for cancel_instead in [false, true] {
            let gate = Arc::new(ApprovalGate::new(scope()));
            let sink = Arc::new(Sink::new());
            let cancel = Cancellation::default();
            let mut request = request();
            request.tool_name = "ask_user".into();
            request.tool_input = json!({"questions":[{"id":"choice","question":"Choose?"}]});
            let id = request.id.clone();
            let (g, s, c) = (gate.clone(), sink.clone(), cancel.clone());
            let task = tokio::spawn(async move { g.wait_question(request, s.as_ref(), &c).await });
            tokio::time::timeout(Duration::from_millis(300), sink.ready.notified())
                .await
                .unwrap();
            if cancel_instead {
                cancel.cancel();
            } else {
                gate.decide(&id, false, sink.as_ref()).await.unwrap();
            }
            let result = task.await.unwrap();
            if cancel_instead {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap(), None);
            }
            assert!(gate
                .answer(&id, json!({"choice":["Late"]}), sink.as_ref())
                .await
                .is_err());
        }
    }
    #[tokio::test]
    async fn failed_question_resolution_keeps_the_same_answer_retryable() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let mut request = request();
        request.tool_name = "ask_user".into();
        request.tool_input = json!({"questions":[{"id":"choice","question":"Choose?"}]});
        let id = request.id.clone();
        let (waiting_gate, waiting_sink) = (gate.clone(), sink.clone());
        let task = tokio::spawn(async move {
            waiting_gate
                .wait_question(request, waiting_sink.as_ref(), &Cancellation::default())
                .await
        });
        tokio::time::timeout(Duration::from_millis(300), sink.ready.notified())
            .await
            .unwrap();
        let answer = json!({"choice":["Phone"]});
        sink.fail_resolution.store(true, Ordering::SeqCst);
        assert!(gate
            .answer(&id, answer.clone(), sink.as_ref())
            .await
            .is_err());
        assert!(!task.is_finished());
        assert_eq!(
            gate.answer(&id, answer.clone(), sink.as_ref())
                .await
                .unwrap()
                .status,
            "accepted"
        );
        assert_eq!(task.await.unwrap().unwrap(), Some(answer));
    }
    #[tokio::test]
    async fn approval_is_bound_to_one_action_and_repeated_decisions_are_idempotent() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let request = request();
        let id = request.id.clone();
        let task = waiting(gate.clone(), sink.clone(), Cancellation::default(), request).await;
        assert!(gate
            .decide("another-action", true, sink.as_ref())
            .await
            .is_err());
        let receipt = gate.decide(&id, true, sink.as_ref()).await.unwrap();
        assert_eq!(receipt.approval_id, id);
        assert!(receipt.approved);
        assert_eq!(task.await.unwrap().unwrap(), true);
        assert_eq!(
            gate.decide(&id, true, sink.as_ref()).await.unwrap().status,
            "already_decided"
        );
        assert!(gate.decide(&id, false, sink.as_ref()).await.is_err());
        let resolutions = sink
            .events
            .lock()
            .await
            .iter()
            .filter(|event| serde_json::to_value(event).unwrap()["type"] == "approval_resolved")
            .count();
        assert_eq!(resolutions, 1);
    }
    #[tokio::test]
    async fn failed_approval_journal_write_keeps_the_same_pending_action_for_retry() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let request = request();
        let id = request.id.clone();
        let task = waiting(gate.clone(), sink.clone(), Cancellation::default(), request).await;
        sink.fail_resolution.store(true, Ordering::SeqCst);
        assert!(gate.decide(&id, true, sink.as_ref()).await.is_err());
        assert!(!task.is_finished());
        assert_eq!(
            gate.decide(&id, true, sink.as_ref()).await.unwrap().status,
            "accepted"
        );
        assert!(task.await.unwrap().unwrap());
    }
    #[tokio::test]
    async fn cancellation_invalidates_pending_approval_without_authorizing_it() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let cancel = Cancellation::default();
        let request = request();
        let id = request.id.clone();
        let task = waiting(gate.clone(), sink.clone(), cancel.clone(), request).await;
        cancel.cancel();
        assert!(tokio::time::timeout(Duration::from_millis(300), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(gate.decide(&id, true, sink.as_ref()).await.is_err());
    }
    #[tokio::test]
    async fn pending_approval_rejects_a_different_owner_turn_or_session() {
        let gate = ApprovalGate::new(scope());
        let sink = Sink::new();
        let mut request = request();
        request.scope.owner = "other".into();
        assert!(gate
            .wait(request, &sink, &Cancellation::default())
            .await
            .is_err());
        assert!(sink.events.lock().await.is_empty());
    }
    #[tokio::test]
    async fn failed_cancellation_resolution_preserves_pending_id_until_exactly_once_retry() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let request = request();
        let id = request.id.clone();
        let task = waiting(gate.clone(), sink.clone(), Cancellation::default(), request).await;
        task.abort();
        let _ = task.await;
        sink.fail_resolution.store(true, Ordering::SeqCst);
        assert!(gate
            .cancel_pending(sink.as_ref(), "Turn ended")
            .await
            .is_err());
        assert_eq!(
            gate.state
                .lock()
                .await
                .pending
                .as_ref()
                .map(|pending| pending.request.id.as_str()),
            Some(id.as_str())
        );
        assert!(gate.decide(&id, true, sink.as_ref()).await.is_err());
        gate.cancel_pending(sink.as_ref(), "Turn ended")
            .await
            .unwrap();
        gate.cancel_pending(sink.as_ref(), "Turn ended")
            .await
            .unwrap();
        let events = sink.events.lock().await;
        let resolutions: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                StructuredSessionEvent::ApprovalResolved {
                    approval_id,
                    approved,
                    ..
                } => Some((approval_id, *approved)),
                _ => None,
            })
            .collect();
        assert_eq!(resolutions, vec![(&id, false)]);
    }
    #[tokio::test]
    async fn wait_cancellation_with_failed_resolution_keeps_a_retryable_pending_action() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let cancel = Cancellation::default();
        let request = request();
        let id = request.id.clone();
        let task = waiting(gate.clone(), sink.clone(), cancel.clone(), request).await;
        sink.fail_resolution.store(true, Ordering::SeqCst);
        cancel.cancel();
        assert!(task.await.unwrap().is_err());
        assert!(gate
            .state
            .lock()
            .await
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request.id == id));
        gate.cancel_pending(sink.as_ref(), "Turn ended")
            .await
            .unwrap();
        assert_eq!(sink.events.lock().await.iter().filter(|event|matches!(event,StructuredSessionEvent::ApprovalResolved{approval_id,approved:false,..} if approval_id==&id)).count(),1);
    }
    #[tokio::test]
    async fn required_event_persistence_failure_leaves_no_authorizable_or_delayed_action() {
        let gate = Arc::new(ApprovalGate::new(scope()));
        let sink = Arc::new(Sink::new());
        let request = request();
        let id = request.id.clone();
        sink.fail_required.store(true, Ordering::SeqCst);
        assert!(gate
            .wait(request, sink.as_ref(), &Cancellation::default())
            .await
            .is_err());
        assert!(gate.state.lock().await.pending.is_none());
        assert!(gate.decide(&id, true, sink.as_ref()).await.is_err());
        gate.cancel_pending(sink.as_ref(), "Turn ended")
            .await
            .unwrap();
        assert!(sink.events.lock().await.is_empty());
    }
}
