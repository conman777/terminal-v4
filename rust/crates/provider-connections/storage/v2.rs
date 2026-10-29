//! Private exact-v2 bridge. Data views are never live capabilities.
use super::{codec, key, FeatureStorage, StorageFormat};
use crate::leases::stop_fact::StopFactMac;
use crate::leases::{
    AcceptedStopObservation, ConsumerKind, LeaseError, LeaseIdentity, LeaseResult, LeaseStatus,
    LeaseView,
};
use crate::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs::File,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub(crate) const PENDING_CONFIGURATION_BATCH_SIZE: usize = 128;
fn map(error: Error) -> LeaseError {
    match error {
        Error::KeyUnavailable => LeaseError::KeyUnavailable,
        Error::InvalidScope => LeaseError::InvalidScope,
        Error::CleanupPending => LeaseError::CleanupPending,
        Error::ConfigurationChanged | Error::RevisionConflict | Error::OperationConflict => {
            LeaseError::ConfigurationChanged
        }
        Error::NotFound => LeaseError::NotFound,
        Error::InvalidInput
        | Error::InvalidEndpoint
        | Error::InvalidCredential
        | Error::MissingCredential
        | Error::UnexpectedCredential
        | Error::CredentialTargetChanged => LeaseError::InvalidConfiguration,
        Error::CapacityReached | Error::JobLimit => LeaseError::CapacityReached,
        _ => LeaseError::PersistenceFailed,
    }
}
fn sql<T>(value: rusqlite::Result<T>) -> Result<T> {
    value.map_err(|_| Error::PersistenceFailed)
}
#[derive(Clone)]
pub(crate) struct Actor {
    pub(crate) reference: ConnectionRef,
    pub(crate) identity: LeaseIdentity,
    pub(crate) request_id: String,
    pub(crate) consumer: ConsumerKind,
    pub(crate) generation: u64,
    pub(crate) status: LeaseStatus,
    pub(crate) started: bool,
    pub(crate) fact: Option<String>,
    pub(crate) revocation_operation: Option<String>,
}
impl Actor {
    pub(crate) fn view(&self) -> LeaseView {
        LeaseView {
            request_id: self.request_id.clone(),
            identity: self.identity.clone(),
            reference: self.reference.clone(),
            status: self.status,
        }
    }
    pub(crate) fn same_binding(&self, other: &Actor) -> bool {
        self.reference == other.reference
            && self.identity == other.identity
            && self.generation == other.generation
    }
}
fn consumer_name(value: ConsumerKind) -> &'static str {
    match value {
        ConsumerKind::StructuredTurn => "structured-turn",
        ConsumerKind::StructuredCompact => "structured-compact",
        ConsumerKind::Cli => "cli",
        ConsumerKind::DurableTask => "durable-task",
        ConsumerKind::Discovery => "discovery",
    }
}
fn status_name(value: LeaseStatus) -> &'static str {
    match value {
        LeaseStatus::RegisteredUnstarted => "registered_unstarted",
        LeaseStatus::HandoffUncertain => "handoff_uncertain",
        LeaseStatus::Active => "active",
        LeaseStatus::Revoked => "revoked",
        LeaseStatus::Quiescent => "quiescent",
    }
}
pub(super) fn read_actors(db: &Connection, scope: Option<&Scope>) -> Result<Vec<Actor>> {
    let mut query=sql(db.prepare("SELECT owner_id,environment_id,profile_id,actor_id,process_instance_id,lease_id,config_revision,credential_generation,reference_json,request_id,consumer_kind,admission_generation,status,started,stop_evidence_json,revocation_operation_id FROM provider_connection_actors ORDER BY owner_id,environment_id,profile_id,actor_id,process_instance_id,lease_id"))?;
    let records = sql(query.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, i64>(11)?,
            r.get::<_, String>(12)?,
            r.get::<_, i64>(13)?,
            r.get::<_, Option<String>>(14)?,
            r.get::<_, Option<String>>(15)?,
        ))
    }))?;
    let mut result = vec![];
    for value in records {
        let (
            owner,
            environment,
            profile,
            actor,
            boot,
            lease,
            revision,
            credential_generation,
            raw,
            request,
            consumer,
            generation,
            status,
            started,
            fact,
            revocation,
        ) = sql(value)?;
        let reference = codec::reference(&codec::parse(&raw)?)?;
        if reference.scope.owner_id != owner
            || reference.scope.environment_id != environment
            || reference.profile_id != profile
            || reference.revision != revision
            || reference.credential_generation != credential_generation
            || generation < 1
            || ![0, 1].contains(&started)
        {
            return Err(Error::PersistenceFailed);
        }
        for id in [&actor, &boot, &lease, &request] {
            validate_uuid(id).map_err(|_| Error::PersistenceFailed)?;
        }
        if let Some(id) = &revocation {
            validate_uuid(id).map_err(|_| Error::PersistenceFailed)?;
        }
        if fact.as_ref().is_some_and(|fact| fact.len() > 65536) {
            return Err(Error::PersistenceFailed);
        }
        let consumer = match consumer.as_str() {
            "structured-turn" => ConsumerKind::StructuredTurn,
            "structured-compact" => ConsumerKind::StructuredCompact,
            "cli" => ConsumerKind::Cli,
            "durable-task" => ConsumerKind::DurableTask,
            "discovery" => ConsumerKind::Discovery,
            _ => return Err(Error::PersistenceFailed),
        };
        let status = match status.as_str() {
            "registered_unstarted" => LeaseStatus::RegisteredUnstarted,
            "handoff_uncertain" => LeaseStatus::HandoffUncertain,
            "active" => LeaseStatus::Active,
            "revoked" => LeaseStatus::Revoked,
            "quiescent" => LeaseStatus::Quiescent,
            _ => return Err(Error::PersistenceFailed),
        };
        if scope.is_none_or(|scope| reference.scope == *scope) {
            result.push(Actor {
                reference,
                identity: LeaseIdentity {
                    actor_id: actor,
                    process_instance_id: boot,
                    lease_id: lease,
                },
                request_id: request,
                consumer,
                generation: generation as u64,
                status,
                started: started == 1,
                fact,
                revocation_operation: revocation,
            });
        }
    }
    Ok(result)
}
pub(crate) struct FenceGuard {
    root: PathBuf,
    directory: File,
    file: File,
}
impl FenceGuard {
    fn acquire(root: &Path, mut notice: Option<std::sync::mpsc::Sender<()>>) -> LeaseResult<Self> {
        let (directory, file) = key::admission_files(root).map_err(map)?;
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let error = std::io::Error::last_os_error().raw_os_error();
            if error == Some(libc::EWOULDBLOCK) {
                if let Some(sender) = notice.take() {
                    let _ = sender.send(());
                }
            }
            if !matches!(error, Some(libc::EWOULDBLOCK) | Some(libc::EINTR))
                || Instant::now() >= end
            {
                return Err(LeaseError::PersistenceFailed);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = Self {
            root: root.to_owned(),
            directory,
            file,
        };
        result.check(root)?;
        Ok(result)
    }
    fn check(&self, root: &Path) -> LeaseResult<()> {
        if self.root != root {
            return Err(LeaseError::InvalidScope);
        }
        key::check_admission_files(root, &self.directory, &self.file).map_err(map)
    }
}
impl Drop for FenceGuard {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
struct Coverage {
    rows: Vec<Actor>,
    closed: Vec<Actor>,
    current: Option<ConnectionRef>,
}
impl Coverage {
    fn accepted(&self, row: &Actor) -> bool {
        self.closed.iter().any(|item| item.same_binding(row))
    }
    fn reference_closed(&self, reference: &ConnectionRef) -> bool {
        self.rows
            .iter()
            .filter(|row| row.reference == *reference)
            .all(|row| self.accepted(row))
    }
    fn covers(&self, set: &RevocationSet) -> bool {
        set.targets.iter().all(|target| {
            self.reference_closed(&target.connection)
                && target.leases.iter().all(|lease| {
                    self.rows.iter().any(|row| {
                        row.reference == target.connection
                            && row.identity.actor_id == lease.actor_id
                            && row.identity.process_instance_id == lease.process_instance_id
                            && row.identity.lease_id == lease.lease_id
                            && self.accepted(row)
                    })
                })
        })
    }
}
impl Cleanup for Coverage {
    fn quiesce(&mut self, reference: &ConnectionRef) -> Result<()> {
        self.current = Some(reference.clone());
        if self.reference_closed(reference) {
            Ok(())
        } else {
            Err(Error::CleanupPending)
        }
    }
    fn quiesce_lease(&mut self, lease: &RequiredLeaseIdentity) -> Result<()> {
        if self.rows.iter().any(|row| {
            self.current.as_ref() == Some(&row.reference)
                && row.identity.actor_id == lease.actor_id
                && row.identity.process_instance_id == lease.process_instance_id
                && row.identity.lease_id == lease.lease_id
                && self.accepted(row)
        }) {
            Ok(())
        } else {
            Err(Error::CleanupPending)
        }
    }
}
pub(crate) struct V2Store {
    root: PathBuf,
    inner: FeatureStorage,
    #[cfg(test)]
    fail_stop: bool,
    #[cfg(test)]
    fail_status: bool,
}
impl V2Store {
    pub(crate) fn open(root: &Path) -> LeaseResult<(Self, StopFactMac)> {
        Self::preflight(root)?;
        let initialization = key::InitializationLock::acquire(root).map_err(map)?;
        let guard = FenceGuard::acquire(root, None)?;
        Self::preflight(root)?;
        let (inner, history) =
            FeatureStorage::open_locked(&initialization, StorageFormat::ExactV2).map_err(map)?;
        read_actors(&inner.repository.connection, None).map_err(map)?;
        guard.check(root)?;
        Ok((
            Self {
                root: root.to_owned(),
                inner,
                #[cfg(test)]
                fail_stop: false,
                #[cfg(test)]
                fail_status: false,
            },
            history.ok_or(LeaseError::KeyUnavailable)?,
        ))
    }
    fn preflight(root: &Path) -> LeaseResult<()> {
        match key::inspect_version(root).map_err(map)? {
            Some(1) => Err(LeaseError::UnsupportedSchema),
            Some(2) => Ok(()),
            Some(0) | None => {
                // A formatless container is fresh only when it has no retained
                // key, sidecar or unknown feature state. Never recover by guessing.
                match std::fs::read_dir(root) {
                    Ok(entries) => {
                        for entry in entries {
                            let entry = entry.map_err(|_| LeaseError::PersistenceFailed)?;
                            let name = entry.file_name();
                            if name != super::DATABASE_FILE
                                && name != super::LOCK_FILE
                                && name != crate::leases::ADMISSION_LOCK_FILE
                            {
                                return Err(LeaseError::PersistenceFailed);
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(LeaseError::PersistenceFailed),
                }
                Ok(())
            }
            _ => Err(LeaseError::UnsupportedSchema),
        }
    }

    pub(crate) fn fence(
        &self,
        notice: Option<std::sync::mpsc::Sender<()>>,
    ) -> LeaseResult<FenceGuard> {
        FenceGuard::acquire(&self.root, notice)
    }
    pub(crate) fn begin(&mut self, guard: &FenceGuard, scope: &Scope) -> LeaseResult<()> {
        guard.check(&self.root)?;
        validate_scope(scope).map_err(map)?;
        self.inner.repository.begin().map_err(map)?;
        if let Err(error) = read_actors(&self.inner.repository.connection, Some(scope)) {
            self.inner.repository.rollback();
            return Err(map(error));
        }
        Ok(())
    }
    pub(crate) fn finish<T>(&mut self, result: LeaseResult<T>) -> LeaseResult<T> {
        match result {
            Ok(value) => self.inner.repository.finish(Ok(value)).map_err(map),
            Err(error) => {
                self.inner.repository.rollback();
                Err(error)
            }
        }
    }
    fn coverage(&mut self, scope: &Scope, mac: &StopFactMac) -> LeaseResult<Coverage> {
        let rows = read_actors(&self.inner.repository.connection, Some(scope)).map_err(map)?;
        let closed = rows
            .iter()
            .filter(|row| {
                row.status == LeaseStatus::Quiescent
                    && row.fact.as_ref().is_some_and(|fact| {
                        mac.verify_prior(fact, &row.reference, &row.identity, row.generation)
                            .is_ok()
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        self.inner.repository.verified_closed = Some(closed.clone());
        Ok(Coverage {
            rows,
            closed,
            current: None,
        })
    }
    pub(crate) fn configure(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        mutation: ConfigMutation,
        ids: SaveIds,
        mac: &StopFactMac,
    ) -> LeaseResult<ConfigReceipt> {
        self.begin(guard, scope)?;
        let result = (|| {
            let mut coverage = self.coverage(scope, mac)?;
            self.inner
                .mutate_started(scope, mutation, ids, &mut coverage)
                .map_err(map)
        })();
        if result.is_err() {
            self.inner.repository.rollback();
        }
        self.inner.repository.verified_closed = None;
        result
    }
    pub(crate) fn load_job_checkpoint(
        &self,
        guard: &FenceGuard,
        scope: &Scope,
    ) -> LeaseResult<Option<(u64, Vec<u8>)>> {
        guard.check(&self.root)?;
        let connection = &self.inner.repository.connection;
        let metadata: Option<(i64, i64, i64)> = sql(connection.query_row(
            "SELECT generation,length(payload),length(payload_tag) FROM provider_connection_job_checkpoints WHERE owner_id=?1 AND environment_id=?2",
            params![scope.owner_id, scope.environment_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()).map_err(map)?;
        let Some((generation, length, tag_length)) = metadata else {
            return Ok(None);
        };
        if generation <= 0
            || length < 0
            || length as u64 > crate::jobs::checkpoint::MAX_CHECKPOINT_BYTES as u64
            || tag_length != 32
        {
            return Err(LeaseError::PersistenceFailed);
        }
        let (payload, tag): (Vec<u8>, Vec<u8>) = sql(connection.query_row(
            "SELECT payload,payload_tag FROM provider_connection_job_checkpoints WHERE owner_id=?1 AND environment_id=?2",
            params![scope.owner_id,scope.environment_id], |row| Ok((row.get(0)?,row.get(1)?)),
        )).map_err(map)?;
        if payload.len() != length as usize {
            return Err(LeaseError::PersistenceFailed);
        }
        self.inner
            .authenticator
            .verify_checkpoint(scope, generation as u64, &payload, &tag)
            .map_err(map)?;
        guard.check(&self.root)?;
        Ok(Some((generation as u64, payload)))
    }
    // Caller owns the shared fence and an active SQLite transaction. Admission
    // persists Running history in the SAME transaction as its registered actor.
    pub(crate) fn write_job_checkpoint_started(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        expected: u64,
        payload: &[u8],
    ) -> LeaseResult<u64> {
        guard.check(&self.root)?;
        if self.inner.repository.connection.is_autocommit() {
            return Err(LeaseError::PersistenceFailed);
        }
        let next = expected
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or(LeaseError::PersistenceFailed)?;
        let tag = self
            .inner
            .authenticator
            .checkpoint_tag(scope, next, payload)
            .map_err(map)?;
        let changed = if expected == 0 {
            sql(self.inner.repository.connection.execute(
                "INSERT OR IGNORE INTO provider_connection_job_checkpoints(owner_id,environment_id,generation,payload,payload_tag) VALUES (?1,?2,?3,?4,?5)",
                params![scope.owner_id,scope.environment_id,next as i64,payload,tag],
            )).map_err(map)?
        } else {
            sql(self.inner.repository.connection.execute(
                "UPDATE provider_connection_job_checkpoints SET generation=?3,payload=?4,payload_tag=?5 WHERE owner_id=?1 AND environment_id=?2 AND generation=?6",
                params![scope.owner_id,scope.environment_id,next as i64,payload,tag,expected as i64],
            )).map_err(map)?
        };
        if changed != 1 {
            return Err(LeaseError::PersistenceFailed);
        }
        guard.check(&self.root)?;
        Ok(next)
    }
    pub(crate) fn profiles(
        &self,
        guard: &FenceGuard,
        scope: &Scope,
    ) -> LeaseResult<Vec<StoredProfile>> {
        guard.check(&self.root)?;
        let mut query = sql(self.inner.repository.connection.prepare(
            "SELECT profile_id FROM provider_connection_profiles WHERE owner_id=?1 AND environment_id=?2 ORDER BY profile_id LIMIT 129",
        )).map_err(map)?;
        let rows = sql(
            query.query_map(params![scope.owner_id, scope.environment_id], |row| {
                row.get::<_, String>(0)
            }),
        )
        .map_err(map)?;
        let ids = sql(rows.collect::<rusqlite::Result<Vec<_>>>()).map_err(map)?;
        if ids.len() > 128 {
            return Err(LeaseError::PersistenceFailed);
        }
        let profiles = ids
            .into_iter()
            .map(|id| {
                self.profile(scope, &id)?
                    .ok_or(LeaseError::PersistenceFailed)
            })
            .collect::<LeaseResult<Vec<_>>>()?;
        guard.check(&self.root)?;
        Ok(profiles)
    }
    pub(crate) fn pending_configurations(
        &self,
        guard: &FenceGuard,
        scope: &Scope,
    ) -> LeaseResult<Vec<(String, String)>> {
        Ok(self
            .pending_configurations_after(guard, scope, 0)?
            .into_iter()
            .map(|(_, profile, operation)| (profile, operation))
            .collect())
    }
    pub(crate) fn pending_configurations_after(
        &self,
        guard: &FenceGuard,
        scope: &Scope,
        after_rowid: i64,
    ) -> LeaseResult<Vec<(i64, String, String)>> {
        guard.check(&self.root)?;
        let mut query = sql(self.inner.repository.connection.prepare(
            "SELECT rowid,profile_id,operation_id FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND cleanup_confirmed=0 AND rowid>?3 ORDER BY rowid LIMIT ?4",
        )).map_err(map)?;
        let rows = sql(query.query_map(
            params![
                scope.owner_id,
                scope.environment_id,
                after_rowid,
                PENDING_CONFIGURATION_BATCH_SIZE as i64
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ))
        .map_err(map)?;
        let pending = sql(rows.collect::<rusqlite::Result<Vec<_>>>()).map_err(map)?;
        guard.check(&self.root)?;
        Ok(pending)
    }
    pub(crate) fn profile(&self, scope: &Scope, id: &str) -> LeaseResult<Option<StoredProfile>> {
        self.inner.repository.profile(scope, id).map_err(map)
    }
    pub(crate) fn profile_under_fence(
        &self,
        guard: &FenceGuard,
        scope: &Scope,
        id: &str,
    ) -> LeaseResult<Option<StoredProfile>> {
        guard.check(&self.root)?;
        let profile = self.profile(scope, id)?;
        guard.check(&self.root)?;
        Ok(profile)
    }
    pub(crate) fn authorization(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        snapshot: &EffectiveConnection,
    ) -> LeaseResult<ResolvedAuthorization> {
        guard.check(&self.root)?;
        self.validate_effective(scope, snapshot)?;
        let authorization = self
            .inner
            .authorization(scope, &snapshot.reference)
            .map_err(map)?;
        guard.check(&self.root)?;
        Ok(authorization)
    }
    pub(crate) fn operation_status(
        &self,
        scope: &Scope,
        id: &str,
        operation: &str,
    ) -> LeaseResult<ConfigReceipt> {
        profiles::operation_status(&self.inner.repository, scope, id, operation).map_err(map)
    }
    pub(crate) fn actors(&self, scope: &Scope) -> LeaseResult<Vec<Actor>> {
        read_actors(&self.inner.repository.connection, Some(scope)).map_err(map)
    }
    pub(crate) fn validate_effective(
        &mut self,
        scope: &Scope,
        snapshot: &EffectiveConnection,
    ) -> LeaseResult<()> {
        let profile = self
            .inner
            .repository
            .profile(scope, &snapshot.reference.profile_id)
            .map_err(map)?
            .ok_or(LeaseError::ConfigurationChanged)?;
        runtime::dispatch_guard(snapshot, Some(&profile))
            .map_err(|_| LeaseError::ConfigurationChanged)?;
        if snapshot.reference.scope != *scope {
            return Err(LeaseError::InvalidScope);
        }
        let encrypted = match &snapshot.auth {
            StoredAuth::None => {
                let count:i64=sql(self.inner.repository.connection.query_row("SELECT COUNT(*) FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",params![scope.owner_id,scope.environment_id,profile.id],|r|r.get(0))).map_err(map)?;
                if count != 0 {
                    return Err(LeaseError::ConfigurationChanged);
                }
                None
            }
            StoredAuth::Bearer(binding) => self
                .inner
                .repository
                .credential(scope, &binding.id)
                .map_err(map)?,
        };
        runtime::authorization(snapshot, encrypted.as_ref(), &mut self.inner.sealer)
            .map_err(|_| LeaseError::ConfigurationChanged)?;
        Ok(())
    }
    pub(crate) fn insert(&mut self, guard: &FenceGuard, row: &Actor) -> LeaseResult<()> {
        guard.check(&self.root)?;
        if self.inner.repository.connection.is_autocommit() {
            return Err(LeaseError::PersistenceFailed);
        }
        let count: i64 = self.inner.repository.connection.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE owner_id=?1 AND environment_id=?2",
            params![row.reference.scope.owner_id, row.reference.scope.environment_id], |result| result.get(0),
        ).map_err(|_| LeaseError::PersistenceFailed)?;
        if count >= crate::leases::MAX_SCOPED_ACTORS {
            return Err(LeaseError::CapacityReached);
        }
        validate_uuid(&row.identity.actor_id).map_err(map)?;
        validate_uuid(&row.identity.process_instance_id).map_err(map)?;
        validate_uuid(&row.identity.lease_id).map_err(map)?;
        validate_uuid(&row.request_id).map_err(map)?;
        codec::reference(&codec::reference_value(&row.reference)).map_err(map)?;
        if row.generation == 0
            || row.generation > i64::MAX as u64
            || row.status != LeaseStatus::RegisteredUnstarted
            || row.started
            || row.fact.is_some()
            || row.revocation_operation.is_some()
        {
            return Err(LeaseError::InvalidEvidence);
        }
        sql(self.inner.repository.connection.execute("INSERT INTO provider_connection_actors(owner_id,environment_id,profile_id,actor_id,process_instance_id,lease_id,config_revision,credential_generation,reference_json,request_id,consumer_kind,admission_generation,started,stop_evidence_json,status,revocation_operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,NULL,'registered_unstarted',NULL)",params![row.reference.scope.owner_id,row.reference.scope.environment_id,row.reference.profile_id,row.identity.actor_id,row.identity.process_instance_id,row.identity.lease_id,row.reference.revision,row.reference.credential_generation,codec::reference_value(&row.reference).to_string(),row.request_id,consumer_name(row.consumer),row.generation as i64])).map_err(map)?;
        Ok(())
    }
    pub(crate) fn mark_handoff(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        row: &Actor,
    ) -> LeaseResult<()> {
        self.begin(guard, scope)?;
        let result = self.update_status(row, LeaseStatus::HandoffUncertain, false);
        self.finish(result)
    }
    fn update_status(
        &mut self,
        row: &Actor,
        status: LeaseStatus,
        started: bool,
    ) -> LeaseResult<()> {
        let current = self
            .actors(&row.reference.scope)?
            .into_iter()
            .find(|value| value.same_binding(row))
            .ok_or(LeaseError::StaleHandle)?;
        if current.status == LeaseStatus::Quiescent || current.status == LeaseStatus::Revoked {
            return Err(LeaseError::ConfigurationChanged);
        }
        let changed=sql(self.inner.repository.connection.execute("UPDATE provider_connection_actors SET status=?1,started=?2 WHERE owner_id=?3 AND environment_id=?4 AND profile_id=?5 AND actor_id=?6 AND process_instance_id=?7 AND lease_id=?8",params![status_name(status),started as i64,row.reference.scope.owner_id,row.reference.scope.environment_id,row.reference.profile_id,row.identity.actor_id,row.identity.process_instance_id,row.identity.lease_id])).map_err(map)?;
        if changed != 1 {
            return Err(LeaseError::PersistenceFailed);
        }
        Ok(())
    }
    pub(crate) fn returned_owner(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        row: &Actor,
        failed: bool,
    ) -> LeaseResult<()> {
        self.begin(guard, scope)?;
        let result = self.update_status(
            row,
            if failed {
                LeaseStatus::HandoffUncertain
            } else {
                LeaseStatus::Active
            },
            true,
        );
        #[cfg(test)]
        let result = if std::mem::take(&mut self.fail_status) {
            Err(LeaseError::PersistenceFailed)
        } else {
            result
        };
        self.finish(result)
    }
    #[cfg(test)]
    pub(crate) fn fail_status_write_once(&mut self) {
        self.fail_status = true;
    }
    #[cfg(test)]
    pub(crate) fn fail_stop_write_once(&mut self) {
        self.fail_stop = true;
    }
    pub(crate) fn accept_stop(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        observation: &AcceptedStopObservation,
        signed: &str,
        operation: Option<&str>,
        mac: &StopFactMac,
    ) -> LeaseResult<Option<ConfigReceipt>> {
        self.begin(guard, scope)?;
        let result = (|| {
            let expected = observation.reference();
            let identity = observation.identity();
            let generation = observation.generation();
            mac.verify_prior(signed, expected, identity, generation)?;
            let row = self
                .actors(scope)?
                .into_iter()
                .find(|row| {
                    row.reference == *expected
                        && row.identity == *identity
                        && row.generation == generation
                })
                .ok_or(LeaseError::InvalidEvidence)?;
            let operation_record = if let Some(id) = operation {
                let record = self
                    .inner
                    .repository
                    .operation(scope, &expected.profile_id, id)
                    .map_err(map)?
                    .ok_or(LeaseError::InvalidEvidence)?;
                if !record.revocations.targets.iter().any(|target| {
                    target.connection == *expected
                        && target.leases.iter().any(|lease| {
                            lease.actor_id == identity.actor_id
                                && lease.process_instance_id == identity.process_instance_id
                                && lease.lease_id == identity.lease_id
                        })
                }) {
                    return Err(LeaseError::InvalidEvidence);
                }
                Some(record)
            } else {
                None
            };
            if row.status != LeaseStatus::Quiescent || row.fact.as_deref() != Some(signed) {
                sql(self.inner.repository.connection.execute("UPDATE provider_connection_actors SET status='quiescent',stop_evidence_json=?1 WHERE owner_id=?2 AND environment_id=?3 AND profile_id=?4 AND actor_id=?5 AND process_instance_id=?6 AND lease_id=?7",params![signed,scope.owner_id,scope.environment_id,expected.profile_id,identity.actor_id,identity.process_instance_id,identity.lease_id])).map_err(map)?;
                #[cfg(test)]
                if std::mem::take(&mut self.fail_stop) {
                    return Err(LeaseError::PersistenceFailed);
                }
            }
            if let Some(record) = operation_record {
                let coverage = self.coverage(scope, mac)?;
                if coverage.covers(&record.revocations) {
                    self.inner
                        .repository
                        .confirm_cleanup(scope, &expected.profile_id, &record.operation_id)
                        .map_err(map)?;
                }
                return self
                    .operation_status(scope, &expected.profile_id, &record.operation_id)
                    .map(Some);
            }
            Ok(None)
        })();
        let result = self.finish(result);
        self.inner.repository.verified_closed = None;
        result
    }
    pub(crate) fn retry_cleanup(
        &mut self,
        guard: &FenceGuard,
        scope: &Scope,
        profile: &str,
        operation: &str,
        mac: &StopFactMac,
    ) -> LeaseResult<ConfigReceipt> {
        self.begin(guard, scope)?;
        let result = (|| {
            let record = self
                .inner
                .repository
                .operation(scope, profile, operation)
                .map_err(map)?
                .ok_or(LeaseError::InvalidEvidence)?;
            let coverage = self.coverage(scope, mac)?;
            if !record.receipt.cleanup_confirmed && coverage.covers(&record.revocations) {
                self.inner
                    .repository
                    .confirm_cleanup(scope, profile, operation)
                    .map_err(map)?;
            }
            self.operation_status(scope, profile, operation)
        })();
        let result = self.finish(result);
        self.inner.repository.verified_closed = None;
        result
    }
}
