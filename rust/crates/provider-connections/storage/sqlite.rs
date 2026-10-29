#[cfg(test)]
use super::TestFailurePoint;
use super::{codec, key::InitializationLock, StorageFormat, DATABASE_FILE};
use crate::*;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::time::Duration;

pub(super) const TABLES: &[&str] = &[
    "provider_connection_metadata",
    "provider_connection_profiles",
    "provider_connection_credentials",
    "provider_connection_tombstones",
    "provider_connection_operations",
    "provider_connection_revision_revocations",
    "provider_connection_discoveries",
    "provider_connection_actors",
];
pub(super) struct SqlRepository {
    pub(super) connection: Connection,
    pub(super) format: StorageFormat,
    pub(super) verified_closed: Option<Vec<super::v2::Actor>>,
    #[cfg(test)]
    pub(super) failure: Option<TestFailurePoint>,
}
fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| Error::PersistenceFailed)
}
fn schema_objects(connection: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
    let mut query=sql(connection.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'provider_connection_%' OR tbl_name LIKE 'provider_connection_%' ORDER BY type,name"))?;
    let rows = sql(query.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))))?;
    sql(rows.collect())
}
impl SqlRepository {
    pub(super) fn open_versioned(lock: &InitializationLock, format: StorageFormat) -> Result<Self> {
        let held = lock.database_file(DATABASE_FILE)?;
        lock.check_auxiliary(DATABASE_FILE)?;
        let connection = sql(Connection::open_with_flags(
            lock.root().join(DATABASE_FILE),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        ))?;
        lock.check_database(DATABASE_FILE, &held)?;
        sql(connection.busy_timeout(Duration::from_secs(5)))?;
        sql(connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;",
        ))?;
        let mut repository = Self {
            connection,
            format,
            verified_closed: None,
            #[cfg(test)]
            failure: None,
        };
        repository.begin()?;
        let version: i64 =
            sql(repository
                .connection
                .query_row("PRAGMA user_version", [], |row| row.get(0)))?;
        match version {
            0 => {
                let count: i64 = sql(repository.connection.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get(0),
                ))?;
                if count != 0 {
                    return Err(Error::PersistenceFailed);
                }
                sql(repository.connection.execute_batch(format.schema()))?;
            }
            version if version == format.version() => {}
            _ => return Err(Error::PersistenceFailed),
        }
        let expected = sql(Connection::open_in_memory())?;
        sql(expected.execute_batch(format.schema()))?;
        if schema_objects(&repository.connection)? != schema_objects(&expected)? {
            return Err(Error::PersistenceFailed);
        }
        let fk: i64 = sql(repository
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0)))?;
        if fk != 1 {
            return Err(Error::PersistenceFailed);
        }
        Ok(repository)
    }
    pub(super) fn begin(&mut self) -> Result<()> {
        if !self.connection.is_autocommit() {
            return Err(Error::PersistenceFailed);
        }
        sql(self.connection.execute_batch("BEGIN IMMEDIATE"))
    }
    pub(super) fn commit(&mut self) -> Result<()> {
        sql(self.connection.execute_batch("COMMIT"))
    }
    pub(super) fn rollback(&mut self) {
        if !self.connection.is_autocommit() {
            let _ = self.connection.execute_batch("ROLLBACK");
        }
    }
    pub(super) fn finish<T>(&mut self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => {
                if !self.connection.is_autocommit() {
                    if let Err(error) = self.commit() {
                        self.rollback();
                        return Err(error);
                    }
                }
                Ok(value)
            }
            Err(error) => {
                self.rollback();
                Err(error)
            }
        }
    }
    pub(super) fn evidence(&self) -> Result<FeatureStoreEvidence> {
        let mut counts = vec![];
        for table in TABLES {
            let count: i64 = sql(self.connection.query_row(
                &format!("SELECT COUNT(*) FROM {table}"),
                [],
                |row| row.get(0),
            ))?;
            counts.push(usize::try_from(count).map_err(|_| Error::PersistenceFailed)?);
        }
        if self.format == StorageFormat::ExactV2 {
            let checkpoint_count: i64 = sql(self.connection.query_row(
                "SELECT COUNT(*) FROM provider_connection_job_checkpoints",
                [],
                |row| row.get(0),
            ))?;
            counts[6] = counts[6]
                .checked_add(
                    usize::try_from(checkpoint_count).map_err(|_| Error::PersistenceFailed)?,
                )
                .ok_or(Error::PersistenceFailed)?;
        }
        // Revision revocation rows are retained actor-state evidence as well.
        Ok(FeatureStoreEvidence {
            metadata_rows: counts[0],
            profile_rows: counts[1],
            credential_rows: counts[2],
            tombstone_rows: counts[3],
            operation_rows: counts[4],
            actor_rows: counts[5]
                .checked_add(counts[7])
                .ok_or(Error::PersistenceFailed)?,
            discovery_rows: counts[6],
        })
    }
    pub(super) fn verifier(&self) -> Result<Option<Vec<u8>>> {
        sql(self
            .connection
            .query_row(
                "SELECT value FROM provider_connection_metadata WHERE name='key-verifier-v1'",
                [],
                |row| row.get(0),
            )
            .optional())
    }
    pub(super) fn insert_verifier(&mut self, verifier: &[u8]) -> Result<()> {
        if verifier.len() != 32 {
            return Err(Error::KeyUnavailable);
        }
        sql(self.connection.execute(
            "INSERT INTO provider_connection_metadata(name,value) VALUES ('key-verifier-v1',?1)",
            [verifier],
        ))
        .map(|_| ())
    }
    #[cfg(test)]
    fn fail(&mut self, point: TestFailurePoint) -> Result<()> {
        if self.failure == Some(point) {
            self.failure = None;
            Err(Error::PersistenceFailed)
        } else {
            Ok(())
        }
    }
    fn pending_operations(&self, scope: &Scope, profile_id: &str) -> Result<Vec<OperationRecord>> {
        let ids = {
            let mut query=sql(self.connection.prepare("SELECT operation_id FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND cleanup_confirmed=0 ORDER BY rowid"))?;
            let rows = sql(query.query_map(
                params![scope.owner_id, scope.environment_id, profile_id],
                |row| row.get::<_, String>(0),
            ))?;
            sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
        };
        ids.into_iter()
            .map(|id| {
                self.operation(scope, profile_id, &id)?
                    .ok_or(Error::PersistenceFailed)
            })
            .collect()
    }
    fn current_leases(&self, reference: &ConnectionRef) -> Result<Vec<RequiredLeaseIdentity>> {
        if self.format == StorageFormat::ExactV2 {
            let closed = self
                .verified_closed
                .as_ref()
                .ok_or(Error::PersistenceFailed)?;
            return Ok(
                super::v2::read_actors(&self.connection, Some(&reference.scope))?
                    .into_iter()
                    .filter(|row| {
                        row.reference == *reference
                            && !closed.iter().any(|item| item.same_binding(row))
                    })
                    .map(|row| RequiredLeaseIdentity {
                        actor_id: row.identity.actor_id,
                        process_instance_id: row.identity.process_instance_id,
                        lease_id: row.identity.lease_id,
                    })
                    .collect(),
            );
        }
        let mut query=sql(self.connection.prepare("SELECT actor_id,process_instance_id,lease_id FROM provider_connection_actors WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND config_revision=?4 AND credential_generation IS ?5 AND status IN ('active','revoked') ORDER BY rowid"))?;
        let rows = sql(query.query_map(
            params![
                reference.scope.owner_id,
                reference.scope.environment_id,
                reference.profile_id,
                reference.revision,
                reference.credential_generation
            ],
            |row| {
                Ok(RequiredLeaseIdentity {
                    actor_id: row.get(0)?,
                    process_instance_id: row.get(1)?,
                    lease_id: row.get(2)?,
                })
            },
        ))?;
        sql(rows.collect())
    }
    fn save_profile(&self, profile: &StoredProfile) -> Result<()> {
        validate_profile(profile)?;
        sql(self.connection.execute("INSERT INTO provider_connection_profiles(owner_id,environment_id,profile_id,revision,record_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(owner_id,environment_id,profile_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json",params![profile.scope.owner_id,profile.scope.environment_id,profile.id,profile.revision,codec::profile_value(profile).to_string()])).map(|_|())
    }
}
impl Drop for SqlRepository {
    fn drop(&mut self) {
        self.rollback();
    }
}
impl Repository for SqlRepository {
    fn profile(&self, scope: &Scope, profile_id: &str) -> Result<Option<StoredProfile>> {
        validate_scope(scope)?;
        validate_uuid(profile_id)?;
        let row:Option<(String,String)>=sql(self.connection.query_row("SELECT revision,record_json FROM provider_connection_profiles WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",params![scope.owner_id,scope.environment_id,profile_id],|row|Ok((row.get(0)?,row.get(1)?))).optional())?;
        row.map(|(revision, text)| {
            let profile = codec::profile(&codec::parse(&text)?)?;
            if profile.scope != *scope || profile.id != profile_id || profile.revision != revision {
                return Err(Error::PersistenceFailed);
            }
            Ok(profile)
        })
        .transpose()
    }
    fn credential(
        &self,
        scope: &Scope,
        credential_id: &str,
    ) -> Result<Option<EncryptedCredential>> {
        validate_scope(scope)?;
        validate_uuid(credential_id)?;
        let mut query=sql(self.connection.prepare("SELECT profile_id,generation,binding_json,ciphertext FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2 AND credential_id=?3 LIMIT 2"))?;
        let rows = sql(query.query_map(
            params![scope.owner_id, scope.environment_id, credential_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        ))?;
        let mut rows = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
        if rows.len() > 1 {
            return Err(Error::CredentialBindingMismatch);
        }
        let Some((profile_id, generation, text, ciphertext)) = rows.pop() else {
            return Ok(None);
        };
        let binding = codec::binding(&codec::parse(&text).map_err(|_| Error::InvalidCredential)?)
            .map_err(|_| Error::InvalidCredential)?;
        if binding.target.scope != *scope
            || binding.target.profile_id != profile_id
            || binding.id != credential_id
            || binding.generation != generation
        {
            return Err(Error::CredentialBindingMismatch);
        }
        Ok(Some(EncryptedCredential {
            binding,
            sealed: SealedSecret(ciphertext),
        }))
    }
    fn tombstone(&self, scope: &Scope, profile_id: &str) -> Result<Option<ProfileTombstone>> {
        validate_scope(scope)?;
        validate_uuid(profile_id)?;
        let row:Option<(String,String)>=sql(self.connection.query_row("SELECT revision,operation_id FROM provider_connection_tombstones WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",params![scope.owner_id,scope.environment_id,profile_id],|row|Ok((row.get(0)?,row.get(1)?))).optional())?;
        row.map(|(revision, operation_id)| {
            validate_uuid(&revision)?;
            validate_uuid(&operation_id)?;
            Ok(ProfileTombstone {
                scope: scope.clone(),
                profile_id: profile_id.into(),
                revision,
                operation_id,
            })
        })
        .transpose()
    }
    fn operation(
        &self,
        scope: &Scope,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<Option<OperationRecord>> {
        validate_scope(scope)?;
        validate_uuid(profile_id)?;
        validate_uuid(operation_id)?;
        let row=sql(self.connection.query_row("SELECT payload_tag,saved_revision,receipt_json,revoked_json,revocations_json,cleanup_confirmed,action FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND operation_id=?4",params![scope.owner_id,scope.environment_id,profile_id,operation_id],|row|Ok((row.get::<_,Vec<u8>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,row.get::<_,i64>(5)?,row.get::<_,String>(6)?))).optional())?;
        let Some((tag, revision, text, revoked, revocations, confirmed, action)) = row else {
            return Ok(None);
        };
        if tag.len() != 32 || ![0, 1].contains(&confirmed) {
            return Err(Error::PersistenceFailed);
        }
        let mut receipt = codec::receipt(&codec::parse(&text)?, scope)?;
        if receipt.operation_id != operation_id
            || receipt.profile_id != profile_id
            || receipt.saved_revision != revision
            || action != if receipt.deleted { "delete" } else { "put" }
            || receipt.cleanup_confirmed && confirmed == 0
        {
            return Err(Error::PersistenceFailed);
        }
        receipt.cleanup_confirmed = confirmed == 1;
        let revoked = revoked
            .map(|text| codec::reference(&codec::parse(&text)?))
            .transpose()?;
        let operation = OperationRecord {
            scope: scope.clone(),
            profile_id: profile_id.into(),
            operation_id: operation_id.into(),
            payload_tag: PayloadTag(hex::encode(tag)),
            receipt,
            revoked,
            revocations: codec::revocations(&codec::parse(&revocations)?, scope, profile_id)?,
        };
        profiles::validate_operation(&operation, scope, profile_id, operation_id)?;
        Ok(Some(operation))
    }
    fn budget(&self, scope: &Scope, profile_id: &str) -> Result<Budget> {
        validate_scope(scope)?;
        validate_uuid(profile_id)?;
        let profiles:i64=sql(self.connection.query_row("SELECT COUNT(*) FROM (SELECT profile_id FROM provider_connection_profiles WHERE owner_id=?1 AND environment_id=?2 UNION SELECT profile_id FROM provider_connection_tombstones WHERE owner_id=?1 AND environment_id=?2)",params![scope.owner_id,scope.environment_id],|row|row.get(0)))?;
        let receipts:i64=sql(self.connection.query_row("SELECT COUNT(*) FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND action='put'",params![scope.owner_id,scope.environment_id,profile_id],|row|row.get(0)))?;
        Ok(Budget {
            profile_ids_including_tombstones: usize::try_from(profiles)
                .map_err(|_| Error::PersistenceFailed)?,
            put_receipts_for_profile: usize::try_from(receipts)
                .map_err(|_| Error::PersistenceFailed)?,
        })
    }
    fn capture_revocations(
        &self,
        scope: &Scope,
        profile_id: &str,
        current: Option<&ConnectionRef>,
    ) -> Result<RevocationSet> {
        let pending = self.pending_operations(scope, profile_id)?;
        let leases = current
            .map(|reference| self.current_leases(reference))
            .transpose()?
            .unwrap_or_default();
        RevocationSet::capture_pending(scope, profile_id, &pending, current, &leases)
    }
    fn commit_atomic(&mut self, write: AtomicWrite) -> Result<ConfigReceipt> {
        if self.connection.is_autocommit() {
            return Err(Error::PersistenceFailed);
        }
        let operation = &write.operation;
        let scope = &operation.scope;
        let profile_id = &operation.profile_id;
        profiles::validate_operation(operation, scope, profile_id, &operation.operation_id)?;
        if let Some(previous) = self.operation(scope, profile_id, &operation.operation_id)? {
            if previous.payload_tag != operation.payload_tag {
                return Err(Error::OperationConflict);
            }
            return Ok(previous.receipt);
        }
        if self.tombstone(scope, profile_id)?.is_some() {
            return Err(Error::NotFound);
        }
        if write.profile.is_some() == write.tombstone.is_some()
            || operation.receipt.deleted != write.tombstone.is_some()
        {
            return Err(Error::InvalidInput);
        }
        if let Some(profile) = &write.profile {
            if operation.receipt.profile.as_ref() != Some(&profiles::public_profile(profile)?) {
                return Err(Error::InvalidInput);
            }
        }
        let reused:i64=sql(self.connection.query_row("SELECT COUNT(*) FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND saved_revision=?4",params![scope.owner_id,scope.environment_id,profile_id,operation.receipt.saved_revision],|row|row.get(0)))?;
        if reused != 0 {
            return Err(Error::RevisionConflict);
        }
        let current = self.profile(scope, profile_id)?;
        if current.as_ref().map(|profile| &profile.revision) != write.expected_revision.as_ref() {
            return Err(Error::RevisionConflict);
        }
        let expected = current.as_ref().map(reference_for);
        if expected != operation.revoked {
            return Err(Error::RevisionConflict);
        }
        if self.capture_revocations(scope, profile_id, operation.revoked.as_ref())?
            != operation.revocations
        {
            return Err(Error::RevisionConflict);
        }
        if write.profile.is_some() {
            let budget = self.budget(scope, profile_id)?;
            if budget.put_receipts_for_profile >= 1024
                || (current.is_none() && budget.profile_ids_including_tombstones >= 128)
            {
                return Err(Error::CapacityReached);
            }
        }
        match &write.profile {
            Some(profile) => {
                if profile.scope != *scope
                    || profile.id != *profile_id
                    || profile.revision != operation.receipt.saved_revision
                {
                    return Err(Error::InvalidScope);
                }
                self.save_profile(profile)?;
            }
            None => {
                sql(self.connection.execute("DELETE FROM provider_connection_profiles WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",params![scope.owner_id,scope.environment_id,profile_id]))?;
            }
        }
        #[cfg(test)]
        self.fail(TestFailurePoint::AfterProfileWrite)?;
        if let Some(tombstone) = &write.tombstone {
            if tombstone.scope != *scope
                || tombstone.profile_id != *profile_id
                || tombstone.revision != operation.receipt.saved_revision
                || tombstone.operation_id != operation.operation_id
            {
                return Err(Error::InvalidScope);
            }
            sql(self.connection.execute(
                "INSERT INTO provider_connection_tombstones VALUES (?1,?2,?3,?4,?5)",
                params![
                    scope.owner_id,
                    scope.environment_id,
                    profile_id,
                    tombstone.revision,
                    tombstone.operation_id
                ],
            ))?;
            #[cfg(test)]
            self.fail(TestFailurePoint::AfterTombstoneWrite)?;
        }
        match &write.vault_change {
            VaultChange::Keep => {}
            VaultChange::Delete { credential_id } => {
                validate_uuid(credential_id)?;
            }
            VaultChange::Put(encrypted) => {
                let profile = write.profile.as_ref().ok_or(Error::InvalidInput)?;
                if profile.auth != StoredAuth::Bearer(encrypted.binding.clone()) {
                    return Err(Error::CredentialBindingMismatch);
                }
                codec::validate_binding(&encrypted.binding)?;
                validate_ciphertext(&encrypted.sealed)?;
                let collision:i64=sql(self.connection.query_row("SELECT COUNT(*) FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2 AND credential_id=?3 AND profile_id<>?4",params![scope.owner_id,scope.environment_id,encrypted.binding.id,profile_id],|row|row.get(0)))?;
                if collision != 0 {
                    return Err(Error::InvalidCredential);
                }
                sql(self.connection.execute("DELETE FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",params![scope.owner_id,scope.environment_id,profile_id]))?;
                sql(self.connection.execute(
                    "INSERT INTO provider_connection_credentials VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        scope.owner_id,
                        scope.environment_id,
                        profile_id,
                        encrypted.binding.id,
                        encrypted.binding.generation,
                        codec::binding_value(&encrypted.binding).to_string(),
                        encrypted.sealed.0
                    ],
                ))?;
            }
        }
        if operation.receipt.deleted
            || matches!(&write.vault_change, VaultChange::Delete { .. })
            || write
                .profile
                .as_ref()
                .is_some_and(|profile| matches!(&profile.auth, StoredAuth::None))
        {
            sql(self.connection.execute("DELETE FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",params![scope.owner_id,scope.environment_id,profile_id]))?;
        }
        #[cfg(test)]
        self.fail(TestFailurePoint::AfterCredentialWrite)?;
        for target in &operation.revocations.targets {
            let reference = &target.connection;
            sql(self.connection.execute(
                "INSERT INTO provider_connection_revision_revocations VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    scope.owner_id,
                    scope.environment_id,
                    profile_id,
                    reference.revision,
                    operation.operation_id,
                    codec::reference_value(reference).to_string()
                ],
            ))?;
            if self.format == StorageFormat::ExactV2 {
                let closed = self
                    .verified_closed
                    .as_ref()
                    .ok_or(Error::PersistenceFailed)?;
                for lease in &target.leases {
                    if closed.iter().any(|row| {
                        row.reference == *reference
                            && row.identity.actor_id == lease.actor_id
                            && row.identity.process_instance_id == lease.process_instance_id
                            && row.identity.lease_id == lease.lease_id
                    }) {
                        continue;
                    }
                    sql(self.connection.execute("UPDATE provider_connection_actors SET status='revoked',revocation_operation_id=COALESCE(revocation_operation_id,?1) WHERE owner_id=?2 AND environment_id=?3 AND profile_id=?4 AND actor_id=?5 AND process_instance_id=?6 AND lease_id=?7",params![operation.operation_id,scope.owner_id,scope.environment_id,profile_id,lease.actor_id,lease.process_instance_id,lease.lease_id]))?;
                }
            } else {
                sql(self.connection.execute("UPDATE provider_connection_actors SET status='revoked',revocation_operation_id=COALESCE(revocation_operation_id,?1) WHERE owner_id=?2 AND environment_id=?3 AND profile_id=?4 AND config_revision=?5 AND credential_generation IS ?6 AND status IN ('active','revoked')",params![operation.operation_id,scope.owner_id,scope.environment_id,profile_id,reference.revision,reference.credential_generation]))?;
            }
        }
        #[cfg(test)]
        self.fail(TestFailurePoint::AfterRevocationWrite)?;
        let tag = hex::decode(&operation.payload_tag.0).map_err(|_| Error::PersistenceFailed)?;
        if tag.len() != 32 {
            return Err(Error::PersistenceFailed);
        }
        sql(self.connection.execute("INSERT INTO provider_connection_operations VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![scope.owner_id,scope.environment_id,profile_id,operation.operation_id,if operation.receipt.deleted{"delete"}else{"put"},tag,operation.receipt.saved_revision,codec::receipt_value(&operation.receipt).to_string(),operation.revoked.as_ref().map(|reference|codec::reference_value(reference).to_string()),codec::revocations_value(&operation.revocations).to_string(),operation.receipt.cleanup_confirmed as i64]))?;
        #[cfg(test)]
        self.fail(TestFailurePoint::AfterOperationWrite)?;
        for target in &operation.revocations.targets {
            sql(self.connection.execute("UPDATE provider_connection_discoveries SET cancel_requested=1 WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND config_revision=?4 AND status IN ('queued','running','cancelling')",params![scope.owner_id,scope.environment_id,profile_id,target.connection.revision]))?;
        }
        #[cfg(test)]
        self.fail(TestFailurePoint::AfterDiscoveryCancellation)?;
        #[cfg(test)]
        self.fail(TestFailurePoint::BeforeCommit)?;
        if let Err(error) = self.commit() {
            if self.connection.is_autocommit() {
                if let Ok(Some(stored)) = self.operation(scope, profile_id, &operation.operation_id)
                {
                    if stored.payload_tag == operation.payload_tag
                        && stored.receipt.saved_revision == operation.receipt.saved_revision
                    {
                        return Ok(stored.receipt);
                    }
                }
            }
            return Err(error);
        }
        #[cfg(test)]
        self.fail(TestFailurePoint::AfterCommitBeforeReceipt)?;
        Ok(operation.receipt.clone())
    }
    fn confirm_cleanup(
        &mut self,
        scope: &Scope,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<ConfigReceipt> {
        let owns = self.connection.is_autocommit();
        if owns {
            self.begin()?;
        }
        if let Err(error) = sql(self
            .connection
            .execute_batch("SAVEPOINT provider_connection_cleanup_confirmation"))
        {
            if owns {
                self.rollback();
            }
            return Err(error);
        }
        let result = (|| {
            let mut operation = self
                .operation(scope, profile_id, operation_id)?
                .ok_or(Error::NotFound)?;
            if operation.receipt.cleanup_confirmed {
                return Ok(operation.receipt);
            }
            sql(self.connection.execute("UPDATE provider_connection_operations SET cleanup_confirmed=1 WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND operation_id=?4",params![scope.owner_id,scope.environment_id,profile_id,operation_id]))?;
            if let Some(mut profile) = self.profile(scope, profile_id)? {
                if profile.revision == operation.receipt.saved_revision {
                    profile.activation = Activation::Ready;
                    self.save_profile(&profile)?;
                }
            }
            operation.receipt.cleanup_confirmed = true;
            Ok(operation.receipt)
        })();
        // The caller may preserve a known saved receipt after an acknowledgement
        // error. Never leave part of this acknowledgement in its outer transaction.
        let result = match result {
            Ok(receipt) => {
                match sql(self
                    .connection
                    .execute_batch("RELEASE provider_connection_cleanup_confirmation"))
                {
                    Ok(()) => Ok(receipt),
                    Err(error) => {
                        self.rollback();
                        Err(error)
                    }
                }
            }
            Err(error) => {
                if self.connection.execute_batch(
                    "ROLLBACK TO provider_connection_cleanup_confirmation; RELEASE provider_connection_cleanup_confirmation;",
                ).is_err() {
                    self.rollback();
                }
                Err(error)
            }
        };
        if owns {
            self.finish(result)
        } else {
            result
        }
    }
}
