//! Trusted server facade. The application supplies authenticated owner/execution
//! identity; request bodies never choose either scope or a storage root.
use crate::{
    jobs::owned_discovery::{http::HttpDiscoveryService, DrainError},
    leases::{LeaseError, TrustedExecutionContext},
    *,
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionError {
    InvalidInput,
    NotFound,
    Conflict,
    CleanupPending,
    CapacityReached,
    StorageUnavailable,
}
impl ConnectionError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_connection",
            Self::NotFound => "connection_not_found",
            Self::Conflict => "connection_changed",
            Self::CleanupPending => "connection_cleanup_pending",
            Self::CapacityReached => "connection_capacity_reached",
            Self::StorageUnavailable => "connection_storage_unavailable",
        }
    }
}
fn domain(error: Error) -> ConnectionError {
    match error {
        Error::NotFound => ConnectionError::NotFound,
        Error::RevisionConflict
        | Error::ConfigurationChanged
        | Error::DiscoveryConflict
        | Error::OperationConflict
        | Error::StaleResult => ConnectionError::Conflict,
        Error::CleanupPending => ConnectionError::CleanupPending,
        Error::JobLimit | Error::CapacityReached => ConnectionError::CapacityReached,
        Error::KeyUnavailable | Error::PersistenceFailed | Error::EncryptionFailed => {
            ConnectionError::StorageUnavailable
        }
        _ => ConnectionError::InvalidInput,
    }
}
fn failure(error: DrainError) -> ConnectionError {
    match error {
        DrainError::Job(error) => domain(error),
        DrainError::Lease(LeaseError::ResourceStopPending | LeaseError::CleanupPending) => {
            ConnectionError::CleanupPending
        }
        DrainError::Lease(
            LeaseError::ConfigurationChanged
            | LeaseError::AdmissionExists
            | LeaseError::StaleHandle,
        ) => ConnectionError::Conflict,
        DrainError::Lease(LeaseError::InvalidScope | LeaseError::NotFound) => {
            ConnectionError::NotFound
        }
        DrainError::Lease(LeaseError::InvalidConfiguration) => ConnectionError::InvalidInput,
        DrainError::Lease(LeaseError::CapacityReached) => ConnectionError::CapacityReached,
        _ => ConnectionError::StorageUnavailable,
    }
}
fn id() -> std::result::Result<String, ConnectionError> {
    use rand::TryRngCore;
    let mut bytes = [0; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| ConnectionError::StorageUnavailable)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}
fn ids() -> std::result::Result<SaveIds, ConnectionError> {
    Ok(SaveIds {
        revision: id()?,
        credential_id: id()?,
        credential_generation: id()?,
    })
}
fn receipt(value: ConfigReceipt) -> Value {
    json!({"operationId":value.operation_id,"profileId":value.profile_id,"savedRevision":value.saved_revision,
        "settingsSaved":value.settings_saved,"cleanupConfirmed":value.cleanup_confirmed,"deleted":value.deleted,
        "superseded":value.superseded,"profile":value.profile})
}
/// One retained service per authenticated scope. Serialize calls through the app
/// manager and keep ticking/shutting down while it owns original HTTP resources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickReport {
    /// Only original resources owned by this service instance.
    pub local_resources_stopped: bool,
    /// Includes unresolved history, durable actors and config operations.
    pub cleanup_confirmed: bool,
}
pub struct ConnectionService {
    inner: HttpDiscoveryService,
}
pub enum InferenceStartDisposition {
    /// This attempt's original callback did not enter. This alone is not a
    /// statement that historical or durable configuration cleanup is complete.
    NoDispatch,
    /// The exact original retained ticket. It must be stopped/released before
    /// confirming cleanup of the containing operation.
    Owned(inference::InferenceTicket),
    /// No original no-dispatch proof or owned ticket could be returned.
    Unconfirmed,
}
pub struct InferenceStartFailure {
    error: ConnectionError,
    disposition: InferenceStartDisposition,
}
impl InferenceStartFailure {
    pub fn into_parts(self) -> (ConnectionError, InferenceStartDisposition) {
        (self.error, self.disposition)
    }
}
impl std::fmt::Debug for InferenceStartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InferenceStartFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}
impl ConnectionService {
    /// Requires the exact original handle/proof and its currently authenticated
    /// durable fact. A cached physical stop or shutdown flag cannot satisfy it.
    pub fn inference_release_current(
        &mut self,
        ticket: &inference::InferenceTicket,
    ) -> std::result::Result<bool, ConnectionError> {
        self.inner
            .inference_release_current(ticket)
            .map_err(|error| failure(DrainError::Lease(error)))
    }
    pub fn start_inference_retained(
        &mut self,
        plan: &inference::InferencePlan,
        request: &str,
        consumer: inference::InferenceConsumer,
        body: &Value,
    ) -> std::result::Result<inference::InferenceTicket, InferenceStartFailure> {
        self.inner
            .start_inference_retained(plan, request, consumer, body)
            .map_err(|start_error| {
                use crate::inference::supervisor::StartDisposition;
                InferenceStartFailure {
                    error: failure(DrainError::Lease(start_error.error)),
                    disposition: match start_error.disposition {
                        StartDisposition::NoDispatch => InferenceStartDisposition::NoDispatch,
                        StartDisposition::Owned(ticket) => InferenceStartDisposition::Owned(ticket),
                        StartDisposition::Unconfirmed => InferenceStartDisposition::Unconfirmed,
                    },
                }
            })
    }
    pub fn inference_usage(&self) -> inference::InferenceUsage {
        self.inner.inference_usage()
    }
    /// Confirms the original retained ticket's join and durable release, without
    /// publishing response data or requiring its old profile to remain current.
    pub fn inference_released(
        &self,
        ticket: &inference::InferenceTicket,
    ) -> std::result::Result<bool, ConnectionError> {
        self.inner
            .inference_released(ticket)
            .map_err(|error| failure(DrainError::Lease(error)))
    }
    pub fn prepare_inference(
        &mut self,
        profile: &str,
        revision: &str,
        model: &str,
    ) -> std::result::Result<inference::InferencePlan, ConnectionError> {
        self.inner
            .prepare_inference(profile, revision, model)
            .map_err(failure)
    }
    pub fn start_inference(
        &mut self,
        plan: &inference::InferencePlan,
        request: &str,
        consumer: inference::InferenceConsumer,
        body: &Value,
    ) -> std::result::Result<inference::InferenceTicket, ConnectionError> {
        self.inner
            .start_inference(plan, request, consumer, body)
            .map_err(failure)
    }
    pub fn poll_inference(
        &mut self,
        ticket: &inference::InferenceTicket,
    ) -> std::result::Result<inference::InferencePoll, ConnectionError> {
        self.inner.poll_inference(ticket, false).map_err(failure)
    }
    pub fn cancel_inference(
        &mut self,
        ticket: &inference::InferenceTicket,
    ) -> std::result::Result<inference::InferencePoll, ConnectionError> {
        self.inner.poll_inference(ticket, true).map_err(failure)
    }
    pub fn open_for_authenticated_execution(
        root: &Path,
        owner: &str,
        environment: &str,
    ) -> std::result::Result<Self, ConnectionError> {
        let scope = Scope {
            owner_id: owner.into(),
            environment_id: environment.into(),
        };
        validate_scope(&scope).map_err(domain)?;
        let inner = HttpDiscoveryService::open(
            root,
            TrustedExecutionContext::from_authenticated_execution(scope),
        )
        .map_err(failure)?;
        Ok(Self { inner })
    }
    pub fn profiles(&mut self) -> std::result::Result<Value, ConnectionError> {
        self.inner.profiles().map_err(failure)
    }
    pub fn profiles_with_published_inventory(
        &mut self,
    ) -> std::result::Result<Value, ConnectionError> {
        self.inner
            .profiles_with_published_inventory()
            .map_err(failure)
    }
    pub fn put(
        &mut self,
        profile: &str,
        input: &Value,
    ) -> std::result::Result<Value, ConnectionError> {
        let mutation = profiles::decode_put(profile, input).map_err(domain)?;
        self.inner
            .configure(ConfigMutation::Put(mutation), ids()?)
            .map(receipt)
            .map_err(failure)
    }
    pub fn delete(
        &mut self,
        profile: &str,
        input: &Value,
    ) -> std::result::Result<Value, ConnectionError> {
        let mutation = profiles::decode_delete(profile, input).map_err(domain)?;
        self.inner
            .configure(ConfigMutation::Delete(mutation), ids()?)
            .map(receipt)
            .map_err(failure)
    }
    pub fn operation(
        &mut self,
        profile: &str,
        operation: &str,
    ) -> std::result::Result<Value, ConnectionError> {
        self.inner
            .operation(profile, operation)
            .map(receipt)
            .map_err(failure)
    }
    pub fn discover(
        &mut self,
        profile: &str,
        request: &str,
        now_ms: u64,
    ) -> std::result::Result<Value, ConnectionError> {
        self.inner
            .begin(profile, request, Duration::from_secs(15), now_ms)
            .map_err(failure)
    }
    pub fn job(&mut self, request: &str) -> std::result::Result<Value, ConnectionError> {
        // A read cannot expose an in-memory terminal transition whose durable
        // save previously failed. The original owner/outcome stays retained.
        self.inner.flush_history().map_err(failure)?;
        self.inner.job(request).map_err(failure)
    }
    pub fn cancel(
        &mut self,
        profile: &str,
        request: &str,
        now_ms: u64,
    ) -> std::result::Result<Value, ConnectionError> {
        self.inner.cancel(profile, request, now_ms).map_err(failure)
    }
    pub fn tick(&mut self, now_ms: u64) -> std::result::Result<TickReport, ConnectionError> {
        let local_resources_stopped = self.inner.poll_all(now_ms).map_err(failure)?;
        self.inner.reconcile_configurations().map_err(failure)?;
        let cleanup_confirmed = self.inner.cleanup_confirmed().map_err(failure)?;
        Ok(TickReport {
            local_resources_stopped,
            cleanup_confirmed,
        })
    }
    pub fn request_shutdown(&mut self, now_ms: u64) -> std::result::Result<(), ConnectionError> {
        self.inner.request_shutdown(now_ms).map_err(failure)
    }
}
#[cfg(test)]
mod tests;
