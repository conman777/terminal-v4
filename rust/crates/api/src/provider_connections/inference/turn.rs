use super::*;
use crate::v4_agent::interaction::{ActionScope, Cancellation};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

#[derive(Clone)]
pub(crate) struct Target {
    pub(crate) manager: ProviderConnectionManager,
    pub(crate) account: ExecutionAccount,
    pub(crate) selection: Selection,
    pub(crate) transport: Transport,
}
pub(crate) enum Event {
    Text(String),
    Finished(Result<(Value, bool), String>),
}
pub(crate) struct Exchange {
    receiver: mpsc::Receiver<Event>,
    cancel: Cancellation,
}
impl Exchange {
    pub(crate) async fn next(&mut self) -> Option<Event> {
        self.receiver.recv().await
    }
    #[cfg(test)]
    pub(super) fn buffered(&self) -> usize {
        self.receiver.len()
    }
}
impl Drop for Exchange {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
#[derive(Default)]
pub(crate) struct Group {
    state: Mutex<State>,
    close: AsyncMutex<()>,
}
#[derive(Default)]
struct State {
    closing: bool,
    scope: Option<ActionScope>,
    ordinal: u64,
    slots: Vec<Arc<Slot>>,
    #[cfg(test)]
    fault: u8,
}
enum Admission {
    Pending,
    NoDispatch,
    Owned(Arc<AsyncMutex<Client>>),
    Unconfirmed,
}
struct Slot {
    cancel: Cancellation,
    admission: Mutex<Admission>,
    join: AsyncMutex<Option<JoinHandle<()>>>,
    #[cfg(test)]
    fault: u8,
}
impl Group {
    pub(crate) fn start(
        &self,
        target: &Target,
        scope: &ActionScope,
        consumer: InferenceConsumer,
        body: Value,
    ) -> Result<Exchange, String> {
        if target.account.user_id != scope.owner
            || [&scope.owner, &scope.session_id, &scope.turn_id]
                .iter()
                .any(|part| {
                    part.is_empty() || part.len() > 512 || part.chars().any(char::is_control)
                })
        {
            return Err("Provider request has an invalid turn scope".into());
        }
        let request = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.closing
                || state.slots.len() >= 128
                || state.scope.as_ref().is_some_and(|bound| bound != scope)
            {
                return Err(
                    "Provider request group is closed, full, or belongs to another turn".into(),
                );
            }
            state.scope = Some(scope.clone());
            let ordinal = state.ordinal;
            state.ordinal = ordinal
                .checked_add(1)
                .ok_or("Provider request ordinal exhausted")?;
            request_id(scope, consumer, ordinal)
        };
        let prepared = target
            .manager
            .prepare_retained_inference(
                &target.account,
                target.selection.clone(),
                target.transport,
                request,
                consumer,
                body,
            )
            .map_err(|_| {
                "Provider request input is invalid or its queued byte limit was reached"
            })?;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closing || state.slots.len() >= 128 {
            return Err("Provider request group is closed or full".into());
        }
        let (sender, receiver) = mpsc::channel(4);
        let slot = Arc::new(Slot {
            cancel: Cancellation::default(),
            admission: Mutex::new(Admission::Pending),
            join: AsyncMutex::new(None),
            #[cfg(test)]
            fault: state.fault,
        });
        let worker = slot.clone();
        // Registration and installation of the original handle are one
        // synchronous operation. Closing cannot observe a half-spawned slot.
        let join = tokio::spawn(async move {
            run(worker, prepared, sender).await;
        });
        *slot.join.try_lock().expect("unpublished request join") = Some(join);
        state.slots.push(slot.clone());
        Ok(Exchange {
            receiver,
            cancel: slot.cancel.clone(),
        })
    }
    #[cfg(test)]
    pub(super) fn fail_worker(&self, fault: u8) {
        self.state.lock().unwrap().fault = fault;
    }
    pub(crate) fn is_confirmed(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .slots
            .is_empty()
    }
    pub(crate) async fn close(&self) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.closing = true;
            for slot in &state.slots {
                slot.cancel.cancel();
            }
        }
        tokio::time::timeout(Duration::from_secs(5),async {
            let _close=self.close.lock().await;
            let slots=self.state.lock().unwrap_or_else(|error|error.into_inner()).slots.clone();
            for slot in &slots {
                let mut join=slot.join.lock().await;
                if let Some(worker)=join.as_mut() {
                    // Keep the original handle in its slot while awaiting.
                    // A cancelled close can resume the same join on retry.
                    let _joined=worker.await;
                    *join=None;
                }
                drop(join);
                let client={
                    let admission=slot.admission.lock().unwrap_or_else(|error|error.into_inner());
                    match &*admission {
                        Admission::Owned(client)=>Some(client.clone()),
                        Admission::NoDispatch=>None,
                        Admission::Pending|Admission::Unconfirmed=>return Err("Provider admission cleanup remains unconfirmed".to_owned()),
                    }
                };
                if let Some(client)=client {
                    let mut client=client.lock().await;
                    loop {
                        match client.cancel_and_confirm_release().await {
                            Ok(true)=>break,
                            Ok(false)=>tokio::time::sleep(Duration::from_millis(10)).await,
                            Err(_)=>return Err("Original provider release could not be authenticated; cleanup remains retained".to_owned()),
                        }
                    }
                }
            }
            self.state.lock().unwrap_or_else(|error|error.into_inner()).slots.clear();
            Ok(())
        }).await.map_err(|_|"Provider request cleanup timed out; original workers remain retained".to_owned())?
    }
    pub(crate) fn is_closed_and_confirmed(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.closing && state.slots.is_empty()
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        for slot in &self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .slots
        {
            slot.cancel.cancel();
        }
    }
}
fn request_id(scope: &ActionScope, consumer: InferenceConsumer, ordinal: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"v4-profile-request-v1");
    let consumer = match consumer {
        InferenceConsumer::Conversation => "conversation",
        InferenceConsumer::Compaction => "compaction",
        InferenceConsumer::Cli => "cli",
        InferenceConsumer::Task => "task",
    };
    for field in [
        scope.owner.as_bytes(),
        scope.session_id.as_bytes(),
        scope.turn_id.as_bytes(),
        consumer.as_bytes(),
    ] {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field);
    }
    digest.update(ordinal.to_be_bytes());
    let mut bytes: [u8; 16] = digest.finalize()[..16]
        .try_into()
        .expect("UUID digest length");
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
async fn send(
    sender: &mpsc::Sender<Event>,
    cancel: &Cancellation,
    event: Event,
) -> Result<(), String> {
    tokio::select! {biased; _=cancel.cancelled()=>Err("Provider request cancelled".into()), result=sender.send(event)=>result.map_err(|_|"Provider output receiver closed".into())}
}
async fn run(slot: Arc<Slot>, prepared: Prepared, sender: mpsc::Sender<Event>) {
    #[cfg(test)]
    if slot.fault == 1 {
        panic!("synthetic request worker failure before admission publication");
    }
    if slot.cancel.is_cancelled() {
        *slot
            .admission
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Admission::NoDispatch;
        return;
    }
    // Resolve even after caller cancellation: dropping an enqueued admission
    // would lose its typed reconciliation result.
    let result = prepared.start().await;
    let (admission, error) = match result {
        Ok(client) => (Admission::Owned(Arc::new(AsyncMutex::new(client))), None),
        Err(failure) => {
            let (_, cleanup) = failure.into_parts();
            let admission = match cleanup {
                StartCleanup::NoDispatch => Admission::NoDispatch,
                StartCleanup::Owned(client) => Admission::Owned(Arc::new(AsyncMutex::new(client))),
                StartCleanup::Unconfirmed => Admission::Unconfirmed,
            };
            (admission,Some("Provider request could not start; check the saved connection and selected model".to_owned()))
        }
    };
    let client = match &admission {
        Admission::Owned(client) => Some(client.clone()),
        _ => None,
    };
    // Publish synchronously before the next await, including owned failures.
    *slot
        .admission
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = admission;
    #[cfg(test)]
    if slot.fault == 2 {
        panic!("synthetic request worker failure after original client publication");
    }
    let result = if let Some(error) = error {
        Err(error)
    } else if let Some(client) = &client {
        let mut client = client.lock().await;
        let result = drive(&mut client, &slot.cancel, &sender).await;
        client.request_cancel();
        result
    } else {
        Err("Provider admission remains unconfirmed".into())
    };
    if let Some(client) = client {
        client.lock().await.request_cancel();
    }
    let _ = send(&sender, &slot.cancel, Event::Finished(result)).await;
}
async fn drive(
    client: &mut Client,
    cancel: &Cancellation,
    sender: &mpsc::Sender<Event>,
) -> Result<(Value, bool), String> {
    let transport = match client.transport() {
        Transport::OpenAiChat => "openai-chat",
        Transport::OpenAiResponses => "openai-responses",
    };
    let mut response = crate::v4_agent::profile_response::Response::new(transport);
    let mut streamed = false;
    loop {
        let poll = cancel
            .run(async {
                client
                    .poll()
                    .await
                    .map_err(|_| "Provider response is unavailable".to_owned())
            })
            .await?;
        match poll {
            InferencePoll::Pending => {
                cancel
                    .run(async {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        Ok(())
                    })
                    .await?
            }
            InferencePoll::Head { streaming } => response.head(streaming)?,
            InferencePoll::Chunk(bytes) => {
                let mut deltas = Vec::new();
                let mut staged = 0usize;
                response.feed(&bytes, &mut |delta| {
                    if delta.is_empty() {
                        return Ok(());
                    }
                    staged = staged.saturating_add(delta.len());
                    if staged > 8_000_000 || deltas.len() >= 8192 {
                        return Err("Provider text chunk exceeds its bounded event buffer".into());
                    }
                    deltas.push(delta.to_owned());
                    Ok(())
                })?;
                for delta in deltas {
                    let mut remaining = delta.as_str();
                    while !remaining.is_empty() {
                        let mut end = remaining.len().min(16_384);
                        while !remaining.is_char_boundary(end) {
                            end -= 1;
                        }
                        send(sender, cancel, Event::Text(remaining[..end].to_owned())).await?;
                        remaining = &remaining[end..];
                        streamed = true;
                    }
                }
            }
            InferencePoll::Complete => return Ok((response.finish()?, streamed)),
            InferencePoll::Failed(_) => {
                return Err("Provider transport stopped without confirmed model completion".into())
            }
        }
    }
}
