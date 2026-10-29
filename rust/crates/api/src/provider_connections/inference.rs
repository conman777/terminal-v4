//! Trusted in-process bridge. Account identity comes from server authentication,
//! never from a prompt, model response, request body, or selected profile JSON.
use super::*;
use terminal_v4_provider_connections::{
    inference::{InferenceConsumer, InferencePoll, InferenceTicket},
    Transport,
};
mod input;
pub(crate) mod turn;
use input::QueuedBody;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub profile_id: String,
    pub revision: String,
    pub model: String,
}
pub struct Client {
    ticket: Arc<InferenceTicket>,
    manager: ProviderConnectionManager,
    owner: String,
    transport: Transport,
}
pub enum StartCleanup {
    /// Proven local no-dispatch for this attempt; historical journal/config
    /// cleanup is outside this statement.
    NoDispatch,
    Owned(Client),
    Unconfirmed,
}
pub struct StartFailure {
    error: ConnectionError,
    cleanup: StartCleanup,
}
impl StartFailure {
    pub fn into_parts(self) -> (ConnectionError, StartCleanup) {
        (self.error, self.cleanup)
    }
}
impl std::fmt::Debug for StartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.ticket.request_cancel();
    }
}
pub(super) enum Operation {
    Begin {
        selection: Selection,
        request: String,
        consumer: InferenceConsumer,
        body: QueuedBody,
        abandoned: Arc<AtomicBool>,
        expected_transport: Option<Transport>,
    },
    Poll {
        ticket: Arc<InferenceTicket>,
    },
    Stop {
        ticket: Arc<InferenceTicket>,
    },
    ConfirmRelease {
        ticket: Arc<InferenceTicket>,
    },
}
pub(super) enum Reply {
    Started {
        ticket: InferenceTicket,
        transport: Transport,
    },
    StartFailed {
        error: ConnectionError,
        ownership: FailedOwnership,
    },
    Poll(InferencePoll),
    Stopped(bool),
    ReleaseConfirmed(bool),
}
pub(super) enum FailedOwnership {
    NoDispatch,
    Owned {
        ticket: InferenceTicket,
        transport: Transport,
    },
    Unconfirmed,
}
pub(super) fn no_dispatch(error: ConnectionError) -> Reply {
    Reply::StartFailed {
        error,
        ownership: FailedOwnership::NoDispatch,
    }
}
struct CancelPendingBegin {
    abandoned: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for CancelPendingBegin {
    fn drop(&mut self) {
        if self.armed {
            self.abandoned.store(true, Ordering::Release);
        }
    }
}
struct CancelPendingPoll {
    ticket: Arc<InferenceTicket>,
    armed: bool,
}
impl Drop for CancelPendingPoll {
    fn drop(&mut self) {
        if self.armed {
            self.ticket.request_cancel();
        }
    }
}
impl Client {
    /// Confirms the original durable release against its exact current signed
    /// receipt. Errors retain the client for repair/retry. A stopped manager is
    /// insufficient because its original verifier is no longer available.
    pub async fn cancel_and_confirm_release(&mut self) -> Result<bool, ConnectionError> {
        self.request_cancel();
        match self
            .manager
            .execute_for_owner(
                &self.owner,
                super::Operation::Inference(Operation::ConfirmRelease {
                    ticket: self.ticket.clone(),
                }),
            )
            .await?
        {
            super::Reply::Inference(Reply::ReleaseConfirmed(confirmed)) => Ok(confirmed),
            _ => Err(ConnectionError::StorageUnavailable),
        }
    }
    /// Consumes one exchange. Text deltas are tentative until this succeeds;
    /// success requires original durable release and valid model completion.
    /// On error or future loss, keep this client and confirm its stop before
    /// reporting that the containing turn has finished cleanup.
    pub async fn response(
        &mut self,
        on_text: &mut (dyn FnMut(&str) -> Result<(), String> + Send),
    ) -> Result<Value, String> {
        let mut pending = CancelPendingPoll {
            ticket: self.ticket.clone(),
            armed: true,
        };
        let transport = match self.transport {
            Transport::OpenAiChat => "openai-chat",
            Transport::OpenAiResponses => "openai-responses",
        };
        let mut response = crate::v4_agent::profile_response::Response::new(transport);
        loop {
            match self.poll().await.map_err(|_| "Provider response or cleanup is unavailable; review the saved connection before retrying")? {
                InferencePoll::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
                InferencePoll::Head { streaming } => response.head(streaming)?,
                InferencePoll::Chunk(bytes) => response.feed(&bytes, &mut |delta| on_text(delta))?,
                InferencePoll::Complete => {
                    let body = response.finish()?;
                    pending.armed = false;
                    return Ok(body);
                }
                InferencePoll::Failed(failure) => return Err(match failure {
                    terminal_v4_provider_connections::inference::InferenceFailure::Cancelled => "Provider request cancelled".into(),
                    terminal_v4_provider_connections::inference::InferenceFailure::ConfigurationChanged => "Connection settings changed; refresh before retrying".into(),
                    terminal_v4_provider_connections::inference::InferenceFailure::HttpStatus(status) => format!("Provider returned HTTP {status}; check the connection and model"),
                    _ => "Provider transport failed; completion was not confirmed".into(),
                }),
            }
        }
    }
    /// Checks local original stop and previously observed release only. It does
    /// not reauthenticate current storage, including after manager shutdown.
    /// Use cancel_and_confirm_release for a current durable cleanup assertion.
    pub async fn cancel_and_confirm_stop(&mut self) -> Result<bool, ConnectionError> {
        self.request_cancel();
        // This flag is set only after the shared supervisor has joined and
        // durably released all of its original local inference owners.
        if self.manager.lifetime.stopped.load(Ordering::Acquire) {
            return Ok(true);
        }
        match self
            .manager
            .execute_for_owner(
                &self.owner,
                super::Operation::Inference(Operation::Stop {
                    ticket: self.ticket.clone(),
                }),
            )
            .await?
        {
            super::Reply::Inference(Reply::Stopped(stopped)) => Ok(stopped),
            _ => Err(ConnectionError::StorageUnavailable),
        }
    }
    pub fn transport(&self) -> Transport {
        self.transport
    }
    pub fn request_cancel(&self) {
        self.ticket.request_cancel();
    }
    pub async fn poll(&mut self) -> Result<InferencePoll, ConnectionError> {
        // Losing one delivered chunk would invalidate every later byte/finish
        // signal. Dropping this future therefore cancels the whole exchange.
        let mut pending = CancelPendingPoll {
            ticket: self.ticket.clone(),
            armed: true,
        };
        let result = self
            .manager
            .execute_for_owner(
                &self.owner,
                super::Operation::Inference(Operation::Poll {
                    ticket: self.ticket.clone(),
                }),
            )
            .await?;
        match result {
            super::Reply::Inference(Reply::Poll(poll)) => {
                pending.armed = false;
                Ok(poll)
            }
            _ => Err(ConnectionError::StorageUnavailable),
        }
    }
}
impl ProviderConnectionManager {
    /// Reserve serialized input before spawning a containing turn worker.
    /// The prepared request captures this manager and authenticated owner.
    pub(crate) fn prepare_retained_inference(
        &self,
        account: &ExecutionAccount,
        selection: Selection,
        expected_transport: Transport,
        request: String,
        consumer: InferenceConsumer,
        body: Value,
    ) -> Result<Prepared, StartFailure> {
        self.prepare_inference(
            account,
            selection,
            Some(expected_transport),
            request,
            consumer,
            body,
        )
    }
    fn prepare_inference(
        &self,
        account: &ExecutionAccount,
        selection: Selection,
        expected_transport: Option<Transport>,
        request: String,
        consumer: InferenceConsumer,
        body: Value,
    ) -> Result<Prepared, StartFailure> {
        if self.lifetime.draining.load(Ordering::Acquire) {
            return Err(StartFailure {
                error: ConnectionError::CleanupPending,
                cleanup: StartCleanup::NoDispatch,
            });
        }
        let body =
            QueuedBody::new(body, self.lifetime.queued_input_bytes.clone()).map_err(|error| {
                StartFailure {
                    error,
                    cleanup: StartCleanup::NoDispatch,
                }
            })?;
        Ok(Prepared {
            manager: self.clone(),
            owner: account.user_id.clone(),
            selection,
            expected_transport,
            request,
            consumer,
            body,
        })
    }
    pub async fn start_retained_inference(
        &self,
        account: &ExecutionAccount,
        selection: Selection,
        expected_transport: Transport,
        request: String,
        consumer: InferenceConsumer,
        body: Value,
    ) -> Result<Client, StartFailure> {
        self.prepare_retained_inference(
            account,
            selection,
            expected_transport,
            request,
            consumer,
            body,
        )?
        .start()
        .await
    }
    /// Account identity must come from server authentication.
    pub async fn start_checked_inference(
        &self,
        account: &ExecutionAccount,
        selection: Selection,
        expected_transport: Transport,
        request: String,
        consumer: InferenceConsumer,
        body: Value,
    ) -> Result<Client, ConnectionError> {
        self.start_retained_inference(
            account,
            selection,
            expected_transport,
            request,
            consumer,
            body,
        )
        .await
        .map_err(|failure| failure.error)
    }
    pub async fn start_owned_inference(
        &self,
        account: &ExecutionAccount,
        selection: Selection,
        request: String,
        consumer: InferenceConsumer,
        body: Value,
    ) -> Result<Client, ConnectionError> {
        // Discarding a retained failure drops its original cleanup client. The
        // shared actor still retains its original resource owner for retirement.
        self.prepare_inference(account, selection, None, request, consumer, body)
            .map_err(|failure| failure.error)?
            .start()
            .await
            .map_err(|failure| failure.error)
    }
}
pub(crate) struct Prepared {
    manager: ProviderConnectionManager,
    owner: String,
    selection: Selection,
    expected_transport: Option<Transport>,
    request: String,
    consumer: InferenceConsumer,
    body: QueuedBody,
}
impl Prepared {
    pub(crate) async fn start(self) -> Result<Client, StartFailure> {
        let Self {
            manager,
            owner,
            selection,
            expected_transport,
            request,
            consumer,
            body,
        } = self;
        let mut pending = CancelPendingBegin {
            abandoned: Arc::new(AtomicBool::new(false)),
            armed: true,
        };
        let operation = Operation::Begin {
            selection,
            request,
            consumer,
            body,
            abandoned: pending.abandoned.clone(),
            expected_transport,
        };
        // Only this synchronous enqueue boundary can classify its own rejection
        // as no-dispatch. A lost/failed actor reply must remain unconfirmed.
        let received = manager
            .enqueue(&owner, super::Operation::Inference(operation))
            .map_err(|error| StartFailure {
                error,
                cleanup: StartCleanup::NoDispatch,
            })?;
        let reply = received
            .await
            .map_err(|_| StartFailure {
                error: ConnectionError::StorageUnavailable,
                cleanup: StartCleanup::Unconfirmed,
            })?
            .map_err(|error| StartFailure {
                error,
                cleanup: StartCleanup::Unconfirmed,
            })?;
        let client = |ticket, transport| Client {
            ticket: Arc::new(ticket),
            manager: manager.clone(),
            owner: owner.clone(),
            transport,
        };
        match reply {
            super::Reply::Inference(Reply::Started { ticket, transport }) => {
                pending.armed = false;
                Ok(client(ticket, transport))
            }
            super::Reply::Inference(Reply::StartFailed { error, ownership }) => {
                pending.armed = false;
                Err(StartFailure {
                    error,
                    cleanup: match ownership {
                        FailedOwnership::NoDispatch => StartCleanup::NoDispatch,
                        FailedOwnership::Owned { ticket, transport } => {
                            StartCleanup::Owned(client(ticket, transport))
                        }
                        FailedOwnership::Unconfirmed => StartCleanup::Unconfirmed,
                    },
                })
            }
            _ => Err(StartFailure {
                error: ConnectionError::StorageUnavailable,
                cleanup: StartCleanup::Unconfirmed,
            }),
        }
    }
}
pub(super) fn perform(
    service: &mut ConnectionService,
    operation: Operation,
) -> Result<Reply, ConnectionError> {
    match operation {
        Operation::Begin {
            selection,
            request,
            consumer,
            body,
            abandoned,
            expected_transport,
        } => {
            if abandoned.load(Ordering::Acquire) {
                return Ok(no_dispatch(ConnectionError::StorageUnavailable));
            }
            let plan = match service.prepare_inference(
                &selection.profile_id,
                &selection.revision,
                &selection.model,
            ) {
                Ok(plan) => plan,
                Err(error) => return Ok(no_dispatch(error)),
            };
            if abandoned.load(Ordering::Acquire) {
                return Ok(no_dispatch(ConnectionError::StorageUnavailable));
            }
            let transport = plan.transport();
            if expected_transport.is_some_and(|expected| expected != transport) {
                return Ok(no_dispatch(ConnectionError::InvalidInput));
            }
            let ticket =
                match service.start_inference_retained(&plan, &request, consumer, &body.body) {
                    Ok(ticket) => ticket,
                    Err(failure) => {
                        use terminal_v4_provider_connections::InferenceStartDisposition;
                        let (error, disposition) = failure.into_parts();
                        let ownership = match disposition {
                            InferenceStartDisposition::NoDispatch => FailedOwnership::NoDispatch,
                            InferenceStartDisposition::Owned(ticket) => {
                                if abandoned.load(Ordering::Acquire) {
                                    ticket.request_cancel();
                                }
                                FailedOwnership::Owned { ticket, transport }
                            }
                            InferenceStartDisposition::Unconfirmed => FailedOwnership::Unconfirmed,
                        };
                        return Ok(Reply::StartFailed { error, ownership });
                    }
                };
            if abandoned.load(Ordering::Acquire) {
                ticket.request_cancel();
            }
            Ok(Reply::Started { ticket, transport })
        }
        Operation::Poll { ticket } => service.poll_inference(&ticket).map(Reply::Poll),
        Operation::Stop { ticket } => service.inference_released(&ticket).map(Reply::Stopped),
        Operation::ConfirmRelease { ticket } => service
            .inference_release_current(&ticket)
            .map(Reply::ReleaseConfirmed),
    }
}
#[cfg(test)]
mod tests;
