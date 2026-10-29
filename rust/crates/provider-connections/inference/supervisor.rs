use super::*;
use crate::leases::{
    AdmissionDisposition, ConsumerKind, Coordinator, LeaseError, LeaseHandle, LeaseResult,
    StopEvidence,
};
use std::time::Duration;

const MAX_RETAINED_REQUESTS: usize = 128;
const MAX_ACTIVE_REQUESTS: usize = 8;
pub(crate) enum StartDisposition {
    NoDispatch,
    Owned(InferenceTicket),
    Unconfirmed,
}
pub(crate) struct StartFailure {
    pub(crate) error: LeaseError,
    pub(crate) disposition: StartDisposition,
}
impl From<LeaseError> for StartFailure {
    fn from(error: LeaseError) -> Self {
        // Used only by inert validation/preparation before admit_inference.
        // Admission failures below preserve their original disposition instead.
        Self {
            error,
            disposition: StartDisposition::NoDispatch,
        }
    }
}
struct Entry {
    request: String,
    origin: Arc<()>,
    cancel: Arc<AtomicBool>,
    caller_dropped: Arc<AtomicBool>,
    plan: InferencePlan,
    reader: http::Reader,
    handle: LeaseHandle,
    proof: Option<StopEvidence>,
    released: bool,
    failure: Option<InferenceFailure>,
}
#[derive(Default)]
pub(crate) struct Supervisor {
    entries: Vec<Entry>,
    closing: bool,
}
impl Supervisor {
    pub(crate) fn start(
        &mut self,
        coordinator: &mut Coordinator,
        plan: &InferencePlan,
        request: &str,
        consumer: InferenceConsumer,
        body: &Value,
    ) -> LeaseResult<InferenceTicket> {
        self.start_retained(coordinator, plan, request, consumer, body)
            .map_err(|failure| failure.error)
    }
    pub(crate) fn start_retained(
        &mut self,
        coordinator: &mut Coordinator,
        plan: &InferencePlan,
        request: &str,
        consumer: InferenceConsumer,
        body: &Value,
    ) -> std::result::Result<InferenceTicket, StartFailure> {
        if self.closing {
            return Err(LeaseError::CleanupPending.into());
        }
        validate_uuid(request).map_err(|_| LeaseError::InvalidConfiguration)?;
        if self.entries.iter().any(|entry| entry.request == request) {
            return Err(LeaseError::AdmissionExists.into());
        }
        if self.entries.len() >= MAX_RETAINED_REQUESTS
            || self.entries.iter().filter(|entry| !entry.released).count() >= MAX_ACTIVE_REQUESTS
        {
            return Err(LeaseError::CapacityReached.into());
        }
        let body = plan.encode_request(body).map_err(|error| {
            if error == Error::CapacityReached {
                LeaseError::CapacityReached
            } else {
                LeaseError::InvalidConfiguration
            }
        })?;
        let consumer = match consumer {
            InferenceConsumer::Conversation => ConsumerKind::StructuredTurn,
            InferenceConsumer::Compaction => ConsumerKind::StructuredCompact,
            InferenceConsumer::Cli => ConsumerKind::Cli,
            InferenceConsumer::Task => ConsumerKind::DurableTask,
        };
        let (action, reader) =
            coordinator.prepare_http_inference(plan, consumer, body, Duration::from_secs(120))?;
        let (handle, error) = match coordinator.admit_inference(
            request,
            &plan.snapshot,
            consumer,
            Box::new(action),
        ) {
            Ok(handle) => (handle, None),
            Err(failure) => {
                let (error, disposition) = failure.into_disposition();
                match disposition {
                    AdmissionDisposition::Owned(handle) => (handle, Some(error)),
                    AdmissionDisposition::NeverDispatched(original) => {
                        let verified = coordinator
                            .verify_never_dispatched(&original, request, &plan.snapshot, consumer)
                            .is_ok();
                        return Err(StartFailure {
                            error,
                            disposition: if verified {
                                StartDisposition::NoDispatch
                            } else {
                                StartDisposition::Unconfirmed
                            },
                        });
                    }
                    AdmissionDisposition::UnconfirmedNoHandle => {
                        return Err(StartFailure {
                            error,
                            disposition: StartDisposition::Unconfirmed,
                        })
                    }
                }
            }
        };
        let origin = Arc::new(());
        let cancel = Arc::new(AtomicBool::new(error.is_some()));
        // Even a failed admission now returns its original ticket. Legacy
        // callers discard that failure/ticket, whose Drop requests retirement.
        let caller_dropped = Arc::new(AtomicBool::new(false));
        let cancel_io = reader.cancellation();
        self.entries.push(Entry {
            request: request.into(),
            origin: origin.clone(),
            cancel: cancel.clone(),
            caller_dropped: caller_dropped.clone(),
            plan: plan.clone(),
            reader,
            handle,
            proof: None,
            released: false,
            failure: error.as_ref().map(|_| InferenceFailure::WorkerUnavailable),
        });
        let ticket = InferenceTicket {
            origin,
            cancel,
            caller_dropped,
            cancel_io,
        };
        if let Some(error) = error {
            Err(StartFailure {
                error,
                disposition: StartDisposition::Owned(ticket),
            })
        } else {
            Ok(ticket)
        }
    }
    fn index(&self, ticket: &InferenceTicket) -> LeaseResult<usize> {
        self.entries
            .iter()
            .position(|entry| {
                Arc::ptr_eq(&entry.origin, &ticket.origin)
                    && Arc::ptr_eq(&entry.cancel, &ticket.cancel)
            })
            .ok_or(LeaseError::NotFound)
    }
    fn drive(&mut self, coordinator: &mut Coordinator, index: usize) -> LeaseResult<()> {
        let entry = &mut self.entries[index];
        if entry.cancel.load(Ordering::Acquire) {
            entry.reader.request_cancel();
        }
        let current = match coordinator.with_current_profile(&entry.plan.snapshot, |current| {
            runtime::dispatch_guard(&entry.plan.snapshot, current)
        }) {
            Ok(current) => current,
            Err(error) => {
                entry.cancel.store(true, Ordering::Release);
                entry.reader.request_cancel();
                entry.reader.discard();
                return Err(error);
            }
        };
        if current.is_err() {
            entry.failure = Some(InferenceFailure::ConfigurationChanged);
            entry.cancel.store(true, Ordering::Release);
        } else if entry.cancel.load(Ordering::Acquire) && entry.failure.is_none() {
            entry.failure = Some(InferenceFailure::Cancelled);
        }
        if entry.failure.is_some() {
            entry.reader.request_cancel();
            entry.reader.discard();
        }
        if entry.released || (!entry.cancel.load(Ordering::Acquire) && !entry.reader.ready()) {
            return Ok(());
        }
        if entry.proof.is_none() {
            match coordinator.observe_stop(&entry.handle) {
                Ok(proof) => entry.proof = Some(proof),
                Err(LeaseError::ResourceStopPending) => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        coordinator.release_completed(
            &entry.handle,
            entry.proof.as_ref().ok_or(LeaseError::InvalidEvidence)?,
        )?;
        entry.released = true;
        Ok(())
    }
    pub(crate) fn poll(
        &mut self,
        coordinator: &mut Coordinator,
        ticket: &InferenceTicket,
        cancel: bool,
    ) -> LeaseResult<InferencePoll> {
        let index = self.index(ticket)?;
        if cancel {
            ticket.cancel.store(true, Ordering::Release);
        }
        self.drive(coordinator, index)?;
        let entry = &mut self.entries[index];
        let publication = coordinator.with_current_profile(&entry.plan.snapshot, |current| {
            if runtime::dispatch_guard(&entry.plan.snapshot, current).is_err() {
                entry.failure = Some(InferenceFailure::ConfigurationChanged);
                entry.cancel.store(true, Ordering::Release);
                entry.reader.request_cancel();
                entry.reader.discard();
            }
            if entry.released {
                if let Some(failure) = entry.failure {
                    return Ok(InferencePoll::Failed(failure));
                }
                if let Some(Err(failure)) = entry.reader.outcome()? {
                    entry.reader.discard();
                    return Ok(InferencePoll::Failed(failure));
                }
            }
            if entry.failure.is_some() {
                return Ok(InferencePoll::Pending);
            }
            if let Some(event) = entry.reader.next()? {
                return Ok(event);
            }
            if entry.released {
                match entry.reader.outcome()? {
                    Some(Ok(())) => Ok(InferencePoll::Complete),
                    Some(Err(failure)) => Ok(InferencePoll::Failed(failure)),
                    None => Err(LeaseError::InvalidEvidence),
                }
            } else {
                Ok(InferencePoll::Pending)
            }
        });
        match publication {
            Ok(result) => result,
            Err(error) => {
                entry.cancel.store(true, Ordering::Release);
                entry.reader.request_cancel();
                entry.reader.discard();
                Err(error)
            }
        }
    }
    pub(crate) fn tick(&mut self, coordinator: &mut Coordinator) -> LeaseResult<bool> {
        let mut error = None;
        for index in 0..self.entries.len() {
            if self.entries[index].released {
                continue;
            }
            if let Err(found) = self.drive(coordinator, index) {
                // Keep an already joined owner's original proof and buffered
                // result when its durable release needs retrying.
                if self.entries[index].proof.is_none() {
                    self.entries[index].cancel.store(true, Ordering::Release);
                    self.entries[index].reader.request_cancel();
                    self.entries[index].reader.discard();
                    if let Ok(proof) = coordinator.observe_stop(&self.entries[index].handle) {
                        self.entries[index].proof = Some(proof);
                    }
                }
                if error.is_none() {
                    error = Some(found);
                }
            }
        }
        let mut index = 0;
        while index < self.entries.len() {
            let entry = &self.entries[index];
            if entry.released && entry.caller_dropped.load(Ordering::Acquire) {
                let retirement = entry
                    .proof
                    .as_ref()
                    .ok_or(LeaseError::InvalidEvidence)
                    .and_then(|proof| coordinator.forget_completed(&entry.handle, proof));
                match retirement {
                    Ok(()) => {
                        self.entries.swap_remove(index);
                        continue;
                    }
                    Err(found) => {
                        if error.is_none() {
                            error = Some(found);
                        }
                    }
                }
            }
            index += 1;
        }
        if let Some(error) = error {
            return Err(error);
        }
        Ok(self.entries.iter().all(|entry| entry.released))
    }
    pub(crate) fn usage(&self) -> InferenceUsage {
        InferenceUsage {
            unreleased_requests: self.entries.iter().filter(|entry| !entry.released).count(),
            retained_requests: self.entries.len(),
        }
    }
    pub(crate) fn released(&self, ticket: &InferenceTicket) -> LeaseResult<bool> {
        Ok(self.entries[self.index(ticket)?].released)
    }
    pub(crate) fn durable_released(
        &self,
        coordinator: &mut Coordinator,
        ticket: &InferenceTicket,
    ) -> LeaseResult<bool> {
        let entry = &self.entries[self.index(ticket)?];
        if !entry.released {
            return Ok(false);
        }
        coordinator.verify_completed(
            &entry.handle,
            entry.proof.as_ref().ok_or(LeaseError::InvalidEvidence)?,
        )?;
        Ok(true)
    }
    pub(crate) fn shutdown(&mut self) {
        self.closing = true;
        for entry in &self.entries {
            entry.cancel.store(true, Ordering::Release);
            entry.reader.request_cancel();
        }
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        // This signals original workers only. It cannot join, release actors,
        // or turn an abandoned service into confirmed durable cleanup.
        self.shutdown();
    }
}
