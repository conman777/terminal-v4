//! Own HTTP-to-job supervisor. This candidate is not wired into App/API yet.
use super::*;
use crate::http_discovery::{HttpOutcome, OutcomeReader};
use crate::leases::TrustedExecutionContext;
use crate::{ConfigMutation, ConfigReceipt, SaveIds};
use std::{path::Path, time::Duration};

// A reader enters only through begin(), paired with its original owned entry.
// It is never accepted from a public DTO or reconstructed on restart.
struct Exchange {
    entry: usize,
    reader: OutcomeReader,
    outcome: Option<HttpOutcome>,
}
pub(crate) struct HttpDiscoveryService {
    owner: OwnedDiscovery,
    inferences: crate::inference::supervisor::Supervisor,
    exchanges: Vec<Exchange>,
    history_generation: u64,
    history_dirty: bool,
    history_fingerprint: Option<[u8; 32]>,
    // Scheduling only: retained services scan past unknown actors. Reopening
    // restarts at the oldest row; no cursor can establish cleanup or stop proof.
    configuration_scan_after: i64,
    #[cfg(test)]
    fail_before_publication: bool,
}
impl HttpDiscoveryService {
    pub(crate) fn inference_usage(&self) -> crate::inference::InferenceUsage {
        self.inferences.usage()
    }
    pub(crate) fn inference_released(
        &self,
        ticket: &crate::inference::InferenceTicket,
    ) -> crate::leases::LeaseResult<bool> {
        self.inferences.released(ticket)
    }
    pub(crate) fn inference_release_current(
        &mut self,
        ticket: &crate::inference::InferenceTicket,
    ) -> crate::leases::LeaseResult<bool> {
        self.inferences
            .durable_released(&mut self.owner.coordinator, ticket)
    }
    pub(crate) fn open(root: &Path, context: TrustedExecutionContext) -> DrainResult<Self> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| u64::try_from(d.as_millis()).ok())
            .ok_or(DrainError::Job(Error::PersistenceFailed))?;
        Self::open_at(root, context, now_ms)
    }
    pub(crate) fn open_at(
        root: &Path,
        context: TrustedExecutionContext,
        now_ms: u64,
    ) -> DrainResult<Self> {
        let mut coordinator = Coordinator::open(root, context).map_err(DrainError::Lease)?;
        let scope = coordinator.authenticated_scope().clone();
        let (jobs, history_generation) = coordinator
            .load_discovery_history(now_ms)
            .map_err(DrainError::Lease)?;
        let mut service = Self {
            owner: OwnedDiscovery::from_owned_parts(scope, jobs, coordinator),
            inferences: Default::default(),
            exchanges: vec![],
            history_generation,
            history_dirty: true,
            history_fingerprint: None,
            configuration_scan_after: 0,
            #[cfg(test)]
            fail_before_publication: false,
        };
        // Recovery is durable before exposing interrupted jobs to callers.
        service.flush_history()?;
        Ok(service)
    }
    pub(crate) fn flush_history(&mut self) -> DrainResult<()> {
        if !self.history_dirty {
            return Ok(());
        }
        let payload = {
            let store = lock_jobs(&self.owner.jobs)?;
            super::super::checkpoint::encode(&store, &self.owner.scope).map_err(DrainError::Job)?
        };
        use sha2::Digest;
        let fingerprint: [u8; 32] = sha2::Sha256::digest(&payload).into();
        if self.history_fingerprint == Some(fingerprint) {
            self.history_dirty = false;
            return Ok(());
        }
        self.history_generation = self
            .owner
            .coordinator
            .save_discovery_history(&payload, self.history_generation)
            .map_err(DrainError::Lease)?;
        self.history_fingerprint = Some(fingerprint);
        self.history_dirty = false;
        Ok(())
    }
    pub(crate) fn profiles(&mut self) -> DrainResult<Value> {
        let profiles = self
            .owner
            .coordinator
            .profiles()
            .map_err(DrainError::Lease)?;
        Ok(Value::Array(
            profiles
                .iter()
                .map(crate::profiles::public_profile)
                .collect::<crate::Result<Vec<_>>>()
                .map_err(DrainError::Job)?,
        ))
    }
    pub(crate) fn profiles_with_published_inventory(&mut self) -> DrainResult<Value> {
        self.flush_history()?;
        let fingerprint = self.history_fingerprint.ok_or(DrainError::Lease(
            crate::leases::LeaseError::PersistenceFailed,
        ))?;
        let OwnedDiscovery {
            coordinator,
            jobs,
            scope,
            ..
        } = &mut self.owner;
        coordinator
            .with_profiles_at_history_generation(
                self.history_generation,
                &fingerprint,
                |profiles| {
                    let store = lock_jobs(jobs)?;
                    let mut output = Vec::with_capacity(profiles.len());
                    for stored in profiles {
                        let mut public =
                            crate::profiles::public_profile(stored).map_err(DrainError::Job)?;
                        let inventory = if stored.activation == crate::Activation::Ready {
                            let snapshot = runtime::resolve(
                                scope,
                                stored,
                                &crate::reference_for(stored),
                                None,
                            )
                            .map_err(DrainError::Job)?;
                            super::super::published_inventory(&store, &snapshot)
                                .map_err(DrainError::Job)?
                        } else {
                            None
                        };
                        // Authenticated history proves prior publication, including
                        // after restart. It cannot reconstruct an original I/O owner.
                        public["modelInventory"] = inventory.unwrap_or(Value::Null);
                        output.push(public);
                    }
                    Ok(Value::Array(output))
                },
            )
            .map_err(DrainError::Lease)?
    }

    pub(crate) fn prepare_inference(
        &mut self,
        profile: &str,
        revision: &str,
        model: &str,
    ) -> DrainResult<crate::inference::InferencePlan> {
        crate::validate_uuid(profile).map_err(DrainError::Job)?;
        crate::validate_uuid(revision).map_err(DrainError::Job)?;
        let stored = self
            .owner
            .coordinator
            .profile(profile)
            .map_err(DrainError::Lease)?
            .ok_or(DrainError::Job(Error::NotFound))?;
        if stored.revision != revision {
            return Err(DrainError::Job(Error::ConfigurationChanged));
        }
        let snapshot = runtime::resolve(
            &self.owner.scope,
            &stored,
            &crate::reference_for(&stored),
            None,
        )
        .map_err(DrainError::Job)?;
        crate::inference::InferencePlan::prepare(&snapshot, model).map_err(DrainError::Job)
    }
    pub(crate) fn start_inference(
        &mut self,
        plan: &crate::inference::InferencePlan,
        request: &str,
        consumer: crate::inference::InferenceConsumer,
        body: &Value,
    ) -> DrainResult<crate::inference::InferenceTicket> {
        self.inferences
            .start(&mut self.owner.coordinator, plan, request, consumer, body)
            .map_err(DrainError::Lease)
    }
    pub(crate) fn start_inference_retained(
        &mut self,
        plan: &crate::inference::InferencePlan,
        request: &str,
        consumer: crate::inference::InferenceConsumer,
        body: &Value,
    ) -> std::result::Result<
        crate::inference::InferenceTicket,
        crate::inference::supervisor::StartFailure,
    > {
        self.inferences
            .start_retained(&mut self.owner.coordinator, plan, request, consumer, body)
    }
    pub(crate) fn poll_inference(
        &mut self,
        ticket: &crate::inference::InferenceTicket,
        cancel: bool,
    ) -> DrainResult<crate::inference::InferencePoll> {
        self.inferences
            .poll(&mut self.owner.coordinator, ticket, cancel)
            .map_err(DrainError::Lease)
    }
    pub(crate) fn operation(
        &mut self,
        profile: &str,
        operation: &str,
    ) -> DrainResult<ConfigReceipt> {
        self.owner
            .coordinator
            .retry_cleanup(profile, operation)
            .map_err(DrainError::Lease)
    }
    pub(crate) fn cleanup_confirmed(&mut self) -> DrainResult<bool> {
        {
            let store = lock_jobs(&self.owner.jobs)?;
            if store
                .records
                .iter()
                .any(|job| matches!(job.io, IoState::Active | IoState::Unconfirmed))
            {
                return Ok(false);
            }
        }
        if self
            .owner
            .coordinator
            .has_unconfirmed_actors()
            .map_err(DrainError::Lease)?
        {
            return Ok(false);
        }
        Ok(self
            .owner
            .coordinator
            .pending_configurations()
            .map_err(DrainError::Lease)?
            .is_empty())
    }
    pub(crate) fn reconcile_configurations(&mut self) -> DrainResult<()> {
        let pending = self
            .owner
            .coordinator
            .pending_configurations_after(self.configuration_scan_after)
            .map_err(DrainError::Lease)?;
        let reached_end = pending.len() < crate::storage::v2::PENDING_CONFIGURATION_BATCH_SIZE;
        for (rowid, profile, operation) in pending {
            // Advance on attempts, including failed retries, so one bad receipt
            // cannot monopolize every pass. Read-only cleanup probes never move it.
            self.configuration_scan_after = rowid;
            self.owner
                .coordinator
                .retry_cleanup(&profile, &operation)
                .map_err(DrainError::Lease)?;
        }
        if reached_end {
            self.configuration_scan_after = 0;
        }
        Ok(())
    }
    pub(crate) fn configure(
        &mut self,
        mutation: ConfigMutation,
        ids: SaveIds,
    ) -> DrainResult<ConfigReceipt> {
        self.owner
            .coordinator
            .configure(mutation, ids)
            .map_err(DrainError::Lease)
    }
    pub(crate) fn retry_cleanup(
        &mut self,
        profile: &str,
        operation: &str,
    ) -> DrainResult<ConfigReceipt> {
        self.owner
            .coordinator
            .retry_cleanup(profile, operation)
            .map_err(DrainError::Lease)
    }
    pub(crate) fn begin(
        &mut self,
        profile: &str,
        request: &str,
        timeout: Duration,
        now_ms: u64,
    ) -> DrainResult<Value> {
        crate::validate_uuid(profile).map_err(DrainError::Job)?;
        crate::validate_uuid(request).map_err(DrainError::Job)?;
        let stored = self
            .owner
            .coordinator
            .profile(profile)
            .map_err(DrainError::Lease)?
            .ok_or(DrainError::Job(Error::NotFound))?;
        let snapshot = runtime::resolve(
            &self.owner.scope,
            &stored,
            &crate::reference_for(&stored),
            None,
        )
        .map_err(DrainError::Job)?;
        // Preparation is inert; same-request replays below cannot launch it.
        let (action, reader) = self
            .owner
            .coordinator
            .prepare_http_discovery(&snapshot, timeout)
            .map_err(DrainError::Lease)?;
        self.history_dirty = true;
        let previous = self.owner.entries.len();
        let result = self.owner.begin_owned_impl(
            request,
            &snapshot,
            Box::new(action),
            now_ms,
            Some(&mut self.history_generation),
        );
        if self.owner.entries.len() > previous {
            // Retain the reader even when admission/status/publication failed.
            // begin_owned has already retained every original handle before error.
            self.exchanges.push(Exchange {
                entry: previous,
                reader,
                outcome: None,
            });
        }
        let persisted = self.flush_history();
        result?;
        persisted?;
        self.job(request)
    }
    pub(crate) fn job(&self, request: &str) -> DrainResult<Value> {
        self.owner.reader().job(request)
    }
    pub(crate) fn cancel(
        &mut self,
        profile: &str,
        request: &str,
        now_ms: u64,
    ) -> DrainResult<Value> {
        self.history_dirty = true;
        let key = JobKey {
            scope: self.owner.scope.clone(),
            profile_id: profile.into(),
            request_id: request.into(),
        };
        {
            let mut store = lock_jobs(&self.owner.jobs)?;
            // A request is unique across this authenticated service scope.
            if store.records.iter().any(|job| {
                job.key.scope == key.scope
                    && job.key.request_id == request
                    && job.key.profile_id != profile
            }) {
                return Err(DrainError::Job(Error::DiscoveryConflict));
            }
            super::super::cancel(&mut store, &key, now_ms).map_err(DrainError::Job)?;
        }
        self.flush_history()?;
        self.job(request)
    }
    pub(crate) fn poll(&mut self, request: &str, now_ms: u64) -> DrainResult<Value> {
        let result = self.poll_owned(request, now_ms);
        let persisted = self.flush_history();
        if result.is_ok() {
            persisted?;
            self.discard_settled_response(request)?;
        }
        result
    }
    fn discard_settled_response(&mut self, request: &str) -> DrainResult<()> {
        let index = self.owner.entry_index(request)?;
        let entry = &self.owner.entries[index];
        let io = {
            let store = lock_jobs(&self.owner.jobs)?;
            let job = &store.records[bound_job_index(&store, entry)?];
            if !super::super::terminal(job.status) {
                return Ok(());
            }
            job.io
        };
        if io != IoState::Quiescent {
            return Ok(());
        }
        if entry.phase != DrainPhase::Settled || entry.original_proof.is_none() {
            return Err(DrainError::Lease(LeaseError::InvalidEvidence));
        }
        if let Some(exchange) = self
            .exchanges
            .iter_mut()
            .find(|exchange| exchange.entry == index)
        {
            // Includes admission-failure drains which never read the shared slot.
            exchange
                .reader
                .discard_after_join()
                .map_err(DrainError::Lease)?;
            exchange.outcome = None;
        }
        Ok(())
    }
    fn poll_owned(&mut self, request: &str, now_ms: u64) -> DrainResult<Value> {
        let index = self.owner.entry_index(request)?;
        let (terminal, io, cancelled) = {
            let store = lock_jobs(&self.owner.jobs)?;
            let job_index = bound_job_index(&store, &self.owner.entries[index])?;
            let job = &store.records[job_index];
            (
                super::super::terminal(job.status),
                job.io,
                job.cancel_requested,
            )
        };
        if terminal {
            if io == IoState::Active {
                self.history_dirty = true;
                return self.owner.drain_failed(request, now_ms);
            }
            return self.job(request);
        }
        let exchange = self
            .exchanges
            .iter()
            .position(|exchange| exchange.entry == index)
            .ok_or(DrainError::Job(Error::StaleResult))?;
        let snapshot = self.owner.entries[index].snapshot.clone();
        let current = self
            .owner
            .coordinator
            .profile(&snapshot.reference.profile_id)
            .map_err(DrainError::Lease)?;
        let stale = runtime::dispatch_guard(&snapshot, current.as_ref()).is_err();
        if !cancelled && !stale && !self.exchanges[exchange].reader.outcome_ready() {
            return self.job(request);
        }
        self.history_dirty = true;
        // Cancel or readiness is a scheduling signal. Only the original owner
        // can join and produce the retained proof; no job mutex spans this work.
        self.owner.refresh_original_view(index)?;
        self.owner.observe_original(index)?;
        {
            let entry = &self.owner.entries[index];
            self.owner
                .coordinator
                .release_completed(
                    entry
                        .original_handle
                        .as_ref()
                        .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?,
                    entry
                        .original_proof
                        .as_ref()
                        .ok_or(DrainError::Lease(LeaseError::InvalidEvidence))?,
                )
                .map_err(DrainError::Lease)?;
        }
        self.owner.entries[index].phase = DrainPhase::GateCFactAccepted;
        if self.exchanges[exchange].outcome.is_none() {
            match self.exchanges[exchange].reader.take_after_join() {
                Ok(Some(outcome)) => self.exchanges[exchange].outcome = Some(outcome),
                _ => {
                    // The original join/release is already retained. A missing
                    // or poisoned result can fail publication, never erase it.
                    self.owner
                        .record_rejection(request, Error::PersistenceFailed, now_ms)?;
                    return self.owner.drain_failed(request, now_ms);
                }
            }
        }
        #[cfg(test)]
        if std::mem::take(&mut self.fail_before_publication) {
            return Err(DrainError::Job(Error::PersistenceFailed));
        }
        let outcome = self.exchanges[exchange]
            .outcome
            .as_ref()
            .ok_or(DrainError::Job(Error::InvalidReceipt))?;
        if outcome.plan != runtime::discovery_plan(&snapshot).map_err(DrainError::Job)? {
            self.owner
                .record_rejection(request, Error::InvalidReceipt, now_ms)?;
            return self.owner.drain_failed(request, now_ms);
        }
        // For cancelled jobs finish ignores provider data; stale jobs are rejected
        // under the same configuration fence as a successful publication.
        if outcome.failure.is_some() && !cancelled && !stale {
            self.owner
                .record_rejection(request, Error::InvalidReceipt, now_ms)?;
            return self.owner.drain_failed(request, now_ms);
        }
        let publication = {
            let OwnedDiscovery {
                coordinator,
                jobs,
                entries,
                ..
            } = &mut self.owner;
            let entry = &entries[index];
            // The fence spans the current-profile read and the short job CAS.
            // All service paths release the job mutex before entering the fence.
            coordinator
                .with_current_profile(&snapshot, |current| {
                    let mut store = lock_jobs(jobs)?;
                    let job_index = bound_job_index(&store, entry)?;
                    if let Ok(candidate) = super::super::complete(
                        &store.records[job_index],
                        current,
                        &outcome.receipts,
                        outcome.attempted_requests,
                        true,
                        now_ms,
                    ) {
                        super::super::checkpoint::encode_replacing(
                            &store,
                            &entry.permit.key.scope,
                            &candidate,
                        )
                        .map_err(DrainError::Job)?;
                    }
                    super::super::finish(
                        &mut store,
                        &entry.permit,
                        current,
                        &outcome.receipts,
                        outcome.attempted_requests,
                        true,
                        now_ms,
                    )
                    .map_err(DrainError::Job)
                })
                .map_err(DrainError::Lease)?
        };
        match publication {
            Ok(_) => {
                self.owner.entries[index].phase = DrainPhase::Settled;
                self.job(request)
            }
            Err(DrainError::Job(error)) => {
                let rejection = match error {
                    Error::CapacityReached => Error::CapacityReached,
                    Error::StaleResult => Error::StaleResult,
                    Error::CleanupPending => Error::CleanupPending,
                    _ => Error::PersistenceFailed,
                };
                // An earlier finish failure keeps its exact cause/time; a
                // prospective rejection is closed without installing its catalog.
                self.owner.record_rejection(request, rejection, now_ms)?;
                self.owner.drain_failed(request, now_ms)
            }
            Err(error) => Err(error),
        }
    }
    // Explicit shutdown owns cancellation and repeated polling. Drop cannot claim
    // shutdown succeeded, erase original resources, or fabricate stop evidence.
    pub(crate) fn request_shutdown(&mut self, now_ms: u64) -> DrainResult<()> {
        self.inferences.shutdown();
        let keys = {
            let store = lock_jobs(&self.owner.jobs)?;
            store
                .records
                .iter()
                .filter(|job| !super::super::terminal(job.status))
                .map(|job| job.key.clone())
                .collect::<Vec<_>>()
        };
        for key in keys {
            self.cancel(&key.profile_id, &key.request_id, now_ms)?;
        }
        Ok(())
    }
    pub(crate) fn poll_all(&mut self, now_ms: u64) -> DrainResult<bool> {
        let inference = self.inferences.tick(&mut self.owner.coordinator);
        let discovery = self.poll_discoveries(now_ms);
        let inference = inference.map_err(DrainError::Lease)?;
        Ok(discovery? && inference)
    }
    fn poll_discoveries(&mut self, now_ms: u64) -> DrainResult<bool> {
        // A prior terminal CAS may still need its durable checkpoint retried.
        // Do this before disposing any response or skipping a settled entry.
        self.flush_history()?;
        let requests = self
            .owner
            .entries
            .iter()
            .map(|entry| entry.permit.key.request_id.clone())
            .collect::<Vec<_>>();
        let mut stopped = true;
        for request in requests {
            let index = self.owner.entry_index(&request)?;
            let settled = {
                let store = lock_jobs(&self.owner.jobs)?;
                let entry = &self.owner.entries[index];
                let job = &store.records[bound_job_index(&store, entry)?];
                entry.phase == DrainPhase::Settled
                    && super::super::terminal(job.status)
                    && job.io == IoState::Quiescent
            };
            if settled {
                // Status-only background polling never rebuilds a completed
                // catalog. This still checks the original retained stop proof.
                self.discard_settled_response(&request)?;
                continue;
            }
            match self.poll(&request, now_ms) {
                Ok(job) => {
                    stopped &= matches!(
                        job["status"].as_str(),
                        Some("succeeded" | "empty" | "failed" | "stale" | "cancelled")
                    ) && job["cleanupPending"] == false;
                }
                Err(DrainError::Lease(LeaseError::ResourceStopPending)) => stopped = false,
                Err(error) => return Err(error),
            }
        }
        Ok(stopped)
    }
}
#[cfg(test)]
mod tests;
