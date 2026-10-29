//! Original Gate B adapters. Explicit private roots; no app or network integration.
pub(crate) mod codec;
mod crypto;
mod key;
mod sqlite;
pub(crate) mod v2;
#[derive(Clone, Copy, PartialEq, Eq)]
enum StorageFormat {
    HistoricalV1,
    ExactV2,
}
impl StorageFormat {
    fn version(self) -> i64 {
        match self {
            Self::HistoricalV1 => 1,
            Self::ExactV2 => crate::leases::SCHEMA_VERSION,
        }
    }
    fn schema(self) -> &'static str {
        match self {
            Self::HistoricalV1 => SCHEMA,
            Self::ExactV2 => crate::leases::SCHEMA,
        }
    }
}

use crate::*;
use crypto::CryptoAdapter;
use sqlite::SqlRepository;
use std::path::Path;

pub const DATABASE_FILE: &str = "provider-connections.sqlite3";
pub const KEY_FILE: &str = "feature.key";
pub const LOCK_FILE: &str = "feature.lock";
pub const KEY_PREFIX: &str = "v4-provider-key:v1:";
pub const SCHEMA: &str = include_str!("schema.sql");

pub struct FeatureStorage {
    repository: SqlRepository,
    sealer: CryptoAdapter,
    authenticator: CryptoAdapter,
    #[cfg(test)]
    test_failure: Option<TestFailurePoint>,
}

impl FeatureStorage {
    pub fn open(private_root: &Path) -> Result<Self> {
        Self::open_internal(private_root, StorageFormat::HistoricalV1).map(|(storage, _)| storage)
    }
    fn open_internal(
        private_root: &Path,
        format: StorageFormat,
    ) -> Result<(Self, Option<crate::leases::stop_fact::StopFactMac>)> {
        let lock = key::InitializationLock::acquire(private_root)?;
        Self::open_locked(&lock, format)
    }
    fn open_locked(
        lock: &key::InitializationLock,
        format: StorageFormat,
    ) -> Result<(Self, Option<crate::leases::stop_fact::StopFactMac>)> {
        let mut repository = SqlRepository::open_versioned(lock, format)?;
        let evidence = repository.evidence()?;
        let verifier = repository.verifier()?;
        let master = key::open_feature_key_locked(lock, &evidence, verifier.as_deref())?;
        let sealer = CryptoAdapter::from_master(&master)?;
        let authenticator = CryptoAdapter::from_master(&master)?;
        let history = if format == StorageFormat::ExactV2 {
            Some(
                crate::leases::stop_fact::StopFactMac::from_private_feature_key(Some(&*master.0))
                    .map_err(|_| Error::KeyUnavailable)?,
            )
        } else {
            None
        };
        if verifier.is_none() {
            if !evidence.is_empty() {
                return Err(Error::KeyUnavailable);
            }
            repository.insert_verifier(&sealer.key_verifier()?)?;
        }
        repository.finish(Ok(()))?;
        lock.check_root()?;
        Ok((
            Self {
                repository,
                sealer,
                authenticator,
                #[cfg(test)]
                test_failure: None,
            },
            history,
        ))
    }
    pub fn mutate(
        &mut self,
        scope: &Scope,
        mutation: ConfigMutation,
        ids: SaveIds,
        cleanup: &mut impl Cleanup,
    ) -> Result<ConfigReceipt> {
        validate_scope(scope)?;
        if self.repository.format != StorageFormat::HistoricalV1 {
            return Err(Error::PersistenceFailed);
        }
        self.repository.begin()?;
        #[cfg(test)]
        {
            self.repository.failure = self.test_failure.take();
        }
        self.mutate_started(scope, mutation, ids, cleanup)
    }
    fn mutate_started(
        &mut self,
        scope: &Scope,
        mutation: ConfigMutation,
        ids: SaveIds,
        cleanup: &mut impl Cleanup,
    ) -> Result<ConfigReceipt> {
        if self.repository.connection.is_autocommit() {
            return Err(Error::PersistenceFailed);
        }
        let result = self.invoke(|store| {
            let (profile_id, operation_id) = match &mutation {
                ConfigMutation::Put(value) => (&value.profile_id, &value.operation_id),
                ConfigMutation::Delete(value) => (&value.profile_id, &value.operation_id),
            };
            if let Some(operation) = store
                .repository
                .operation(scope, profile_id, operation_id)?
            {
                // Verify privately in constant time before the pure compatibility
                // comparison, revision check or any possible seal invocation.
                store
                    .authenticator
                    .verify_tag(scope, &mutation, &operation.payload_tag)?;
            }
            profiles::mutate(
                &mut store.repository,
                &mut store.sealer,
                &mut store.authenticator,
                cleanup,
                scope,
                mutation,
                ids,
            )
        });
        self.finish_receipt(scope, result)
    }
    fn invoke<T>(&mut self, action: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| action(self))) {
            Ok(result) => result,
            Err(payload) => {
                self.repository.rollback();
                std::panic::resume_unwind(payload)
            }
        }
    }
    fn finish_receipt(
        &mut self,
        scope: &Scope,
        result: Result<ConfigReceipt>,
    ) -> Result<ConfigReceipt> {
        match result {
            Err(error) => {
                self.repository.rollback();
                Err(error)
            }
            Ok(mut receipt) => {
                if !self.repository.connection.is_autocommit() && self.repository.commit().is_err()
                {
                    self.repository.rollback();
                    // Only cleanup/read reconciliation remains uncommitted here;
                    // profiles::mutate committed any new configuration itself.
                    receipt.cleanup_confirmed = false;
                    return Ok(profiles::operation_status(
                        &self.repository,
                        scope,
                        &receipt.profile_id,
                        &receipt.operation_id,
                    )
                    .unwrap_or(receipt));
                }
                Ok(receipt)
            }
        }
    }
    pub fn profile(&self, scope: &Scope, profile_id: &str) -> Result<Option<StoredProfile>> {
        self.repository.profile(scope, profile_id)
    }
    pub fn operation_status(
        &self,
        scope: &Scope,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<ConfigReceipt> {
        profiles::operation_status(&self.repository, scope, profile_id, operation_id)
    }
    pub fn retry_cleanup(
        &mut self,
        scope: &Scope,
        profile_id: &str,
        operation_id: &str,
        cleanup: &mut impl Cleanup,
    ) -> Result<ConfigReceipt> {
        self.repository.begin()?;
        let result = self.invoke(|store| {
            profiles::retry_cleanup(
                &mut store.repository,
                cleanup,
                scope,
                profile_id,
                operation_id,
            )
        });
        self.finish_receipt(scope, result)
    }
    pub fn authorization(
        &mut self,
        scope: &Scope,
        reference: &ConnectionRef,
    ) -> Result<ResolvedAuthorization> {
        validate_scope(scope)?;
        if reference.scope != *scope {
            return Err(Error::InvalidScope);
        }
        self.repository.begin()?;
        let result = self.invoke(|store| {
            let profile = store
                .repository
                .profile(scope, &reference.profile_id)?
                .ok_or(Error::ConfigurationChanged)?;
            let snapshot = runtime::resolve(scope, &profile, reference, None)?;
            let encrypted = match &snapshot.auth {
                StoredAuth::None => {
                    let count:i64=store.repository.connection.query_row("SELECT COUNT(*) FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3",rusqlite::params![scope.owner_id,scope.environment_id,profile.id],|row|row.get(0)).map_err(|_|Error::PersistenceFailed)?;
                    if count != 0 {
                        return Err(Error::UnexpectedCredential);
                    }
                    None
                }
                StoredAuth::Bearer(binding) => store.repository.credential(scope, &binding.id)?,
            };
            runtime::authorization(&snapshot, encrypted.as_ref(), &mut store.sealer)
        });
        self.repository.finish(result)
    }
    pub fn evidence(&self) -> Result<FeatureStoreEvidence> {
        self.repository.evidence()
    }
    #[cfg(test)]
    fn fail_once(&mut self, point: TestFailurePoint) {
        self.test_failure = Some(point);
    }
    #[cfg(test)]
    fn metrics_for_test(&self) -> Result<TestMetrics> {
        Ok(TestMetrics {
            seal_attempts: self.sealer.seal_attempts,
        })
    }
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct TestMetrics {
    seal_attempts: usize,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TestFailurePoint {
    AfterProfileWrite,
    AfterCredentialWrite,
    AfterRevocationWrite,
    AfterOperationWrite,
    AfterDiscoveryCancellation,
    AfterTombstoneWrite,
    BeforeCommit,
    AfterCommitBeforeReceipt,
}

#[cfg(test)]
mod tests;
