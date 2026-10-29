//! Data-only durable history. No live permit, owner, join or proof is serialized.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
pub(crate) const MAX_CHECKPOINT_BYTES: usize = 32 * 1024 * 1024;
// Reserve room for every bounded control/failure/tombstone record even when
// catalog publication is full. Capacity must never poison future history saves.
const MAX_CATALOG_BYTES: usize = 23 * 1024 * 1024;
const MAX_CONTROL_RECORD_BYTES: usize = 64 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u8,
    owner: String,
    environment: String,
    records: Vec<Record>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    profile: String,
    request: String,
    snapshot: Option<Value>,
    status: String,
    io: String,
    cancel_requested: bool,
    created_ms: u64,
    completed_ms: Option<u64>,
    receipt: Option<StoredReceipt>,
    models: Option<Vec<StoredModel>>,
    failure: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredReceipt {
    requests: usize,
    models: usize,
    inference_verified: bool,
    metadata_unavailable: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredModel {
    id: String,
    public_id: String,
    label: String,
    loaded: Option<bool>,
    available: Option<bool>,
    image_input: Option<bool>,
    trained_for_tools: Option<bool>,
    context_window: Option<u64>,
    effective_context: Option<u64>,
    max_output_tokens: Option<u64>,
    clusters: Option<Vec<StoredCluster>>,
    reasoning: StoredReasoning,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCluster {
    id: String,
    loaded: Option<bool>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StoredReasoning {
    Unknown,
    NativeOptions {
        allowed: Vec<String>,
        default: Option<String>,
    },
}
fn invalid<T>(_: T) -> Error {
    Error::PersistenceFailed
}
fn text(value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(Error::PersistenceFailed);
    }
    Ok(())
}
fn failure_name(value: JobFailureReason) -> &'static str {
    match value {
        JobFailureReason::ServerRestarted => "server_restarted",
        JobFailureReason::InventoryRejected => "inventory_rejected",
        JobFailureReason::ConfigurationChanged => "configuration_changed",
        JobFailureReason::TransportNotStopped => "transport_not_stopped",
        JobFailureReason::AdmissionRejected => "admission_rejected",
        JobFailureReason::CapacityReached => "capacity_reached",
    }
}
fn parse_failure(value: &str) -> Result<JobFailureReason> {
    match value {
        "server_restarted" => Ok(JobFailureReason::ServerRestarted),
        "inventory_rejected" => Ok(JobFailureReason::InventoryRejected),
        "configuration_changed" => Ok(JobFailureReason::ConfigurationChanged),
        "transport_not_stopped" => Ok(JobFailureReason::TransportNotStopped),
        "admission_rejected" => Ok(JobFailureReason::AdmissionRejected),
        "capacity_reached" => Ok(JobFailureReason::CapacityReached),
        _ => Err(Error::PersistenceFailed),
    }
}
impl StoredModel {
    fn from_model(m: &discovery::ModelInfo) -> Result<Self> {
        Ok(Self {
            id: m.selection_id.clone(),
            public_id: m.public_id.clone(),
            label: m.label.clone(),
            loaded: m.loaded,
            available: m.available,
            image_input: m.image_input,
            trained_for_tools: m.trained_for_tools,
            context_window: m.context_window,
            effective_context: m.effective_context,
            max_output_tokens: m.max_output_tokens,
            clusters: m.clusters.as_ref().map(|rows| {
                rows.iter()
                    .map(|c| StoredCluster {
                        id: c.cluster_id.clone(),
                        loaded: c.loaded,
                    })
                    .collect()
            }),
            reasoning: match &m.reasoning {
                discovery::ReasoningControl::Unknown => StoredReasoning::Unknown,
                discovery::ReasoningControl::NativeOptions {
                    allowed,
                    default,
                    openai_wire_mapping_verified: false,
                } => StoredReasoning::NativeOptions {
                    allowed: allowed.clone(),
                    default: default.clone(),
                },
                _ => return Err(Error::PersistenceFailed),
            },
        })
    }
    fn into_model(self) -> Result<discovery::ModelInfo> {
        text(&self.id, discovery::MAX_MODEL_ID_BYTES)?;
        text(&self.public_id, discovery::MAX_MODEL_ID_BYTES)?;
        text(&self.label, discovery::MAX_RESPONSE_BYTES)?;
        if [
            self.context_window,
            self.effective_context,
            self.max_output_tokens,
        ]
        .contains(&Some(0))
        {
            return Err(Error::PersistenceFailed);
        }
        let clusters = self
            .clusters
            .map(|rows| {
                if rows.len() > discovery::MAX_MODELS {
                    return Err(Error::PersistenceFailed);
                }
                let mut seen = HashSet::new();
                rows.into_iter()
                    .map(|c| {
                        text(&c.id, discovery::MAX_MODEL_ID_BYTES)?;
                        if !seen.insert(c.id.clone()) {
                            return Err(Error::PersistenceFailed);
                        }
                        Ok(discovery::ClusterAvailability {
                            cluster_id: c.id,
                            loaded: c.loaded,
                        })
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;
        let reasoning = match self.reasoning {
            StoredReasoning::Unknown => discovery::ReasoningControl::Unknown,
            StoredReasoning::NativeOptions { allowed, default } => {
                if allowed.len() > discovery::MAX_MODELS {
                    return Err(Error::PersistenceFailed);
                }
                let mut seen = HashSet::new();
                for option in &allowed {
                    text(option, discovery::MAX_MODEL_ID_BYTES)?;
                    if !seen.insert(option) {
                        return Err(Error::PersistenceFailed);
                    }
                }
                if default
                    .as_ref()
                    .is_some_and(|value| !allowed.contains(value))
                {
                    return Err(Error::PersistenceFailed);
                }
                discovery::ReasoningControl::NativeOptions {
                    allowed,
                    default,
                    openai_wire_mapping_verified: false,
                }
            }
        };
        Ok(discovery::ModelInfo {
            selection_id: self.id,
            public_id: self.public_id,
            label: self.label,
            loaded: self.loaded,
            available: self.available,
            image_input: self.image_input,
            trained_for_tools: self.trained_for_tools,
            context_window: self.context_window,
            effective_context: self.effective_context,
            max_output_tokens: self.max_output_tokens,
            clusters,
            reasoning,
        })
    }
}
fn record(job: &Job) -> Result<Record> {
    if job.plan
        != job
            .snapshot
            .as_ref()
            .map(runtime::discovery_plan)
            .transpose()?
    {
        return Err(Error::PersistenceFailed);
    }
    if let Some(catalog) = &job.catalog {
        if job
            .plan
            .as_ref()
            .is_none_or(|plan| plan.binding != catalog.binding)
        {
            return Err(Error::PersistenceFailed);
        }
    }
    if let Some(receipt) = &job.receipt {
        if job
            .plan
            .as_ref()
            .is_none_or(|plan| plan.binding != receipt.binding)
        {
            return Err(Error::PersistenceFailed);
        }
    }
    Ok(Record {
        profile: job.key.profile_id.clone(),
        request: job.key.request_id.clone(),
        snapshot: job
            .snapshot
            .as_ref()
            .map(|s| crate::storage::codec::profile_value(&profile_from_snapshot(s))),
        status: status_name(job.status).into(),
        io: match job.io {
            IoState::NeverStarted => "never_started",
            IoState::Active => "active",
            IoState::Unconfirmed => "unconfirmed",
            IoState::Quiescent => "quiescent",
        }
        .into(),
        cancel_requested: job.cancel_requested,
        created_ms: job.created_ms,
        completed_ms: job.completed_ms,
        receipt: job.receipt.as_ref().map(|r| StoredReceipt {
            requests: r.request_count,
            models: r.model_count,
            inference_verified: r.inference_verified,
            metadata_unavailable: r.metadata_unavailable,
        }),
        models: job
            .catalog
            .as_ref()
            .map(|c| {
                c.models
                    .iter()
                    .map(StoredModel::from_model)
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?,
        failure: job.failure.map(|f| failure_name(f).into()),
    })
}
fn restore(record: Record, scope: &Scope) -> Result<Job> {
    let key = JobKey {
        scope: scope.clone(),
        profile_id: record.profile,
        request_id: record.request,
    };
    validate_key(&key).map_err(invalid)?;
    let snapshot = record
        .snapshot
        .map(|value| {
            let profile = crate::storage::codec::profile(&value).map_err(invalid)?;
            if profile.id != key.profile_id
                || profile.scope != *scope
                || profile.activation != Activation::Ready
            {
                return Err(Error::PersistenceFailed);
            }
            runtime::resolve(scope, &profile, &reference_for(&profile), None).map_err(invalid)
        })
        .transpose()?;
    let plan = snapshot
        .as_ref()
        .map(runtime::discovery_plan)
        .transpose()
        .map_err(invalid)?;
    let status = match record.status.as_str() {
        "queued" => Status::Queued,
        "running" => Status::Running,
        "cancelling" => Status::Cancelling,
        "succeeded" => Status::Succeeded,
        "empty" => Status::Empty,
        "failed" => Status::Failed,
        "cancelled" => Status::Cancelled,
        "stale" => Status::Stale,
        _ => return Err(Error::PersistenceFailed),
    };
    let io = match record.io.as_str() {
        "never_started" => IoState::NeverStarted,
        "active" => IoState::Active,
        "unconfirmed" => IoState::Unconfirmed,
        "quiescent" => IoState::Quiescent,
        _ => return Err(Error::PersistenceFailed),
    };
    let failure = record.failure.as_deref().map(parse_failure).transpose()?;
    let models = record
        .models
        .map(|rows| {
            if rows.len() > discovery::MAX_MODELS {
                return Err(Error::PersistenceFailed);
            }
            let mut ids = HashSet::new();
            rows.into_iter()
                .map(|r| {
                    let m = r.into_model()?;
                    if !ids.insert(m.selection_id.clone()) {
                        return Err(Error::PersistenceFailed);
                    }
                    Ok(m)
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?;
    let catalog = models
        .map(|models| {
            Ok(discovery::ModelCatalog {
                binding: plan
                    .as_ref()
                    .ok_or(Error::PersistenceFailed)?
                    .binding
                    .clone(),
                models,
            })
        })
        .transpose()?;
    let receipt = record
        .receipt
        .map(|r| {
            let plan = plan.as_ref().ok_or(Error::PersistenceFailed)?;
            if r.inference_verified
                || r.requests == 0
                || r.requests > plan.requests.len()
                || r.models
                    != catalog
                        .as_ref()
                        .ok_or(Error::PersistenceFailed)?
                        .models
                        .len()
            {
                return Err(Error::PersistenceFailed);
            }
            Ok(Receipt {
                binding: plan.binding.clone(),
                request_count: r.requests,
                model_count: r.models,
                inference_verified: false,
                metadata_unavailable: r.metadata_unavailable,
            })
        })
        .transpose()?;
    if terminal(status) != record.completed_ms.is_some()
        || (!matches!(status, Status::Succeeded | Status::Empty)
            && (catalog.is_some() || receipt.is_some()))
    {
        return Err(Error::PersistenceFailed);
    }
    match status {
        Status::Queued
            if io == IoState::NeverStarted && !record.cancel_requested && failure.is_none() => {}
        Status::Running
            if io == IoState::Active && !record.cancel_requested && failure.is_none() => {}
        Status::Cancelling
            if matches!(io, IoState::Active | IoState::Unconfirmed)
                && record.cancel_requested
                && failure.is_none() => {}
        Status::Succeeded | Status::Empty
            if io == IoState::Quiescent
                && !record.cancel_requested
                && failure.is_none()
                && receipt.is_some()
                && catalog
                    .as_ref()
                    .is_some_and(|c| c.models.is_empty() == (status == Status::Empty)) => {}
        Status::Cancelled
            if io == IoState::Quiescent && record.cancel_requested && failure.is_none() => {}
        Status::Stale if failure == Some(JobFailureReason::ConfigurationChanged) => {}
        Status::Failed if failure.is_some() => {}
        _ => return Err(Error::PersistenceFailed),
    }
    if snapshot.is_none()
        && !(status == Status::Cancelled && record.cancel_requested && io == IoState::Quiescent)
    {
        return Err(Error::PersistenceFailed);
    }
    Ok(Job {
        key,
        snapshot,
        plan,
        status,
        io,
        cancel_requested: record.cancel_requested,
        created_ms: record.created_ms,
        completed_ms: record.completed_ms,
        receipt,
        catalog,
        failure,
        worker_generation: None,
    })
}
fn budgets(records: &mut [Record]) -> Result<()> {
    if records.len() > MAX_JOBS_PER_SCOPE {
        return Err(Error::CapacityReached);
    }
    let mut catalog_bytes = 0usize;
    for record in records {
        let models = record.models.take();
        let control_bytes = serde_json::to_vec(&record).map_err(invalid)?.len();
        let model_bytes = models
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(invalid)?
            .map_or(0, |raw| raw.len());
        record.models = models;
        catalog_bytes = catalog_bytes
            .checked_add(model_bytes)
            .ok_or(Error::CapacityReached)?;
        if control_bytes > MAX_CONTROL_RECORD_BYTES || catalog_bytes > MAX_CATALOG_BYTES {
            return Err(Error::CapacityReached);
        }
    }
    Ok(())
}
fn decode_data(raw: &[u8], scope: &Scope) -> Result<JobStore> {
    validate_scope(scope)?;
    if raw.len() > MAX_CHECKPOINT_BYTES {
        return Err(Error::PersistenceFailed);
    }
    let mut data: Checkpoint = serde_json::from_slice(raw).map_err(invalid)?;
    if data.version != 1
        || data.owner != scope.owner_id
        || data.environment != scope.environment_id
        || data.records.len() > MAX_JOBS_PER_SCOPE
    {
        return Err(Error::PersistenceFailed);
    }
    budgets(&mut data.records).map_err(invalid)?;
    let mut seen = HashSet::new();
    let mut store = JobStore::new();
    for record in data.records {
        let job = restore(record, scope)?;
        // Request IDs are unique across profiles in one authenticated service.
        if !seen.insert(job.key.request_id.clone()) {
            return Err(Error::PersistenceFailed);
        }
        store.records.push(job);
    }
    Ok(store)
}
fn encode_records(mut records: Vec<Record>, scope: &Scope) -> Result<Vec<u8>> {
    budgets(&mut records)?;
    let raw = serde_json::to_vec(&Checkpoint {
        version: 1,
        owner: scope.owner_id.clone(),
        environment: scope.environment_id.clone(),
        records,
    })
    .map_err(invalid)?;
    if raw.len() > MAX_CHECKPOINT_BYTES {
        return Err(Error::CapacityReached);
    }
    decode_data(&raw, scope)?;
    Ok(raw)
}
pub(crate) fn encode(store: &JobStore, scope: &Scope) -> Result<Vec<u8>> {
    validate_scope(scope)?;
    if store.records.iter().any(|job| job.key.scope != *scope) {
        return Err(Error::InvalidScope);
    }
    encode_records(
        store
            .records
            .iter()
            .map(record)
            .collect::<Result<Vec<_>>>()?,
        scope,
    )
}
// Inert prospective publication data only. It creates no worker/permit/proof and
// cannot mutate the authoritative store before its capacity check succeeds.
pub(crate) fn encode_replacing(
    store: &JobStore,
    scope: &Scope,
    candidate: &Job,
) -> Result<Vec<u8>> {
    validate_scope(scope)?;
    if candidate.key.scope != *scope
        || store.records.iter().any(|job| job.key.scope != *scope)
        || store
            .records
            .iter()
            .filter(|job| job.key == candidate.key)
            .count()
            != 1
    {
        return Err(Error::InvalidScope);
    }
    encode_records(
        store
            .records
            .iter()
            .map(|job| {
                record(if job.key == candidate.key {
                    candidate
                } else {
                    job
                })
            })
            .collect::<Result<Vec<_>>>()?,
        scope,
    )
}
pub(crate) fn decode_after_restart(raw: &[u8], scope: &Scope, now_ms: u64) -> Result<JobStore> {
    let mut store = decode_data(raw, scope)?;
    recover_after_restart(&mut store, scope, now_ms)?;
    Ok(store)
}
#[cfg(test)]
mod tests;
