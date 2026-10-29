//! Original V4 provider connections, discovery, storage and owned transport supervision.
#![cfg(unix)]

pub mod discovery;
pub mod jobs;
pub mod profiles;
pub mod runtime;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    NotImplemented,
    InvalidInput,
    InvalidScope,
    InvalidEndpoint,
    InvalidCredential,
    MissingCredential,
    UnexpectedCredential,
    CredentialTargetChanged,
    CredentialBindingMismatch,
    EncryptedCredentialRequired,
    RevisionConflict,
    NotFound,
    ConfigurationChanged,
    EncryptionFailed,
    PersistenceFailed,
    DiscoveryConflict,
    DiscoveryCancelled,
    DiscoveryNotRunning,
    CleanupPending,
    StaleResult,
    InvalidReceipt,
    JobLimit,
    KeyUnavailable,
    CapacityReached,
    OperationConflict,
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Scope {
    owner_id: String,
    environment_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileKind {
    ActualRelay,
    ActualLocal,
    LmStudioLocal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    OpenAiResponses,
    OpenAiChat,
}

// Deliberately no Debug, Clone or Serialize implementation for request secrets.
pub struct SecretString(String);
impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    pub(crate) fn expose_for_adapter(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

pub enum AuthChange {
    None,
    KeepBearer,
    ReplaceBearer(SecretString),
}

pub struct PutProfile {
    operation_id: String,
    profile_id: String,
    expected_revision: Option<String>,
    kind: ProfileKind,
    base_url: String,
    cluster_id: Option<String>,
    auth: AuthChange,
}

pub struct DeleteProfile {
    operation_id: String,
    profile_id: String,
    expected_revision: String,
}

pub enum ConfigMutation {
    Put(PutProfile),
    Delete(DeleteProfile),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    Ready,
    CleanupPending,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialTarget {
    scope: Scope,
    profile_id: String,
    kind: ProfileKind,
    base_url: String,
    transport: Transport,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialBinding {
    id: String,
    generation: String,
    target: CredentialTarget,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredAuth {
    None,
    Bearer(CredentialBinding),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProfile {
    scope: Scope,
    id: String,
    revision: String,
    kind: ProfileKind,
    base_url: String,
    transport: Transport,
    auth: StoredAuth,
    cluster_id: Option<String>,
    activation: Activation,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SealedSecret(pub(crate) String);

#[derive(Clone, PartialEq, Eq)]
pub struct EncryptedCredential {
    binding: CredentialBinding,
    sealed: SealedSecret,
}

pub struct CredentialPayload {
    binding: CredentialBinding,
    secret: SecretString,
}

/// Concrete adapter must use authenticated encryption, require ciphertext format,
/// and authenticate the full binding inside the encrypted payload before returning.
pub trait SecretSealer {
    fn seal(&mut self, payload: &CredentialPayload) -> Result<SealedSecret>;
    fn open(&mut self, encrypted: &EncryptedCredential) -> Result<CredentialPayload>;
}

#[derive(Clone, PartialEq, Eq)]
pub enum VaultChange {
    Keep,
    Put(EncryptedCredential),
    Delete { credential_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileTombstone {
    scope: Scope,
    profile_id: String,
    revision: String,
    operation_id: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct PayloadTag(pub(crate) String);

pub trait PayloadAuthenticator {
    fn tag(&mut self, scope: &Scope, mutation: &ConfigMutation) -> Result<PayloadTag>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigReceipt {
    operation_id: String,
    profile_id: String,
    saved_revision: String,
    settings_saved: bool,
    cleanup_confirmed: bool,
    deleted: bool,
    superseded: bool,
    profile: Option<serde_json::Value>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct OperationRecord {
    scope: Scope,
    profile_id: String,
    operation_id: String,
    payload_tag: PayloadTag,
    receipt: ConfigReceipt,
    revoked: Option<ConnectionRef>,
    revocations: RevocationSet,
}

/// Opaque acknowledgements captured by a future trusted cooperative lease adapter.
/// No constructor is exposed to request DTOs or untrusted callers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequiredLeaseIdentity {
    actor_id: String,
    process_instance_id: String,
    lease_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RevocationTarget {
    connection: ConnectionRef,
    leases: Vec<RequiredLeaseIdentity>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RevocationSet {
    targets: Vec<RevocationTarget>,
}

impl RevocationSet {
    /// Pure aggregation for trusted repository adapters. The adapter must query
    /// every unconfirmed operation and current lease in its transaction; this
    /// constructor validates the supplied records, not database completeness.
    pub fn capture_pending(
        scope: &Scope,
        profile_id: &str,
        pending: &[OperationRecord],
        current: Option<&ConnectionRef>,
        current_leases: &[RequiredLeaseIdentity],
    ) -> Result<Self> {
        validate_scope(scope)?;
        validate_uuid(profile_id)?;
        let mut captured = Self::default();
        for operation in pending {
            if operation.scope != *scope || operation.profile_id != profile_id {
                return Err(Error::InvalidScope);
            }
            operation.revocations.validate(scope, profile_id)?;
            if !operation.receipt.cleanup_confirmed {
                captured.merge(&operation.revocations);
            }
        }
        match current {
            Some(reference) => captured.add_connection(reference, current_leases),
            None if !current_leases.is_empty() => return Err(Error::InvalidInput),
            None => {}
        }
        captured.validate(scope, profile_id)?;
        Ok(captured)
    }

    fn merge(&mut self, other: &Self) {
        for target in &other.targets {
            if let Some(existing) = self
                .targets
                .iter_mut()
                .find(|value| value.connection == target.connection)
            {
                for lease in &target.leases {
                    if !existing.leases.contains(lease) {
                        existing.leases.push(lease.clone());
                    }
                }
            } else {
                self.targets.push(target.clone());
            }
        }
    }

    fn add_connection(&mut self, connection: &ConnectionRef, leases: &[RequiredLeaseIdentity]) {
        self.merge(&Self {
            targets: vec![RevocationTarget {
                connection: connection.clone(),
                leases: leases.to_vec(),
            }],
        });
    }

    fn validate(&self, scope: &Scope, profile_id: &str) -> Result<()> {
        for (index, target) in self.targets.iter().enumerate() {
            let reference = &target.connection;
            if reference.scope != *scope || reference.profile_id != profile_id {
                return Err(Error::InvalidScope);
            }
            validate_uuid(&reference.profile_id)?;
            validate_uuid(&reference.revision)?;
            match (&reference.credential_id, &reference.credential_generation) {
                (None, None) => {}
                (Some(id), Some(generation)) => {
                    validate_uuid(id)?;
                    validate_uuid(generation)?;
                }
                _ => return Err(Error::CredentialBindingMismatch),
            }
            if self.targets[..index]
                .iter()
                .any(|old| old.connection == *reference)
            {
                return Err(Error::InvalidInput);
            }
            for (lease_index, lease) in target.leases.iter().enumerate() {
                for id in [&lease.actor_id, &lease.process_instance_id, &lease.lease_id] {
                    validate_uuid(id)?;
                }
                if target.leases[..lease_index].contains(lease) {
                    return Err(Error::InvalidInput);
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AtomicWrite {
    expected_revision: Option<String>,
    profile: Option<StoredProfile>,
    tombstone: Option<ProfileTombstone>,
    vault_change: VaultChange,
    operation: OperationRecord,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Budget {
    profile_ids_including_tombstones: usize,
    put_receipts_for_profile: usize,
}

/// Implement with one SQLite transaction and an in-transaction revision recheck.
/// Failed commits must preserve both old rows and all job invalidation state.
pub trait Repository {
    fn profile(&self, scope: &Scope, profile_id: &str) -> Result<Option<StoredProfile>>;
    fn credential(&self, scope: &Scope, credential_id: &str)
        -> Result<Option<EncryptedCredential>>;
    fn tombstone(&self, scope: &Scope, profile_id: &str) -> Result<Option<ProfileTombstone>>;
    fn operation(
        &self,
        scope: &Scope,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<Option<OperationRecord>>;
    fn budget(&self, scope: &Scope, profile_id: &str) -> Result<Budget>;
    /// Capture the union of all unconfirmed operation targets plus current,
    /// including their immutable required lease identities. commit_atomic must
    /// recapture and compare this set inside its transaction before any write.
    /// New actor admission must serialize with that capture/revocation boundary.
    fn capture_revocations(
        &self,
        scope: &Scope,
        profile_id: &str,
        current: Option<&ConnectionRef>,
    ) -> Result<RevocationSet>;
    fn commit_atomic(&mut self, write: AtomicWrite) -> Result<ConfigReceipt>;
    fn confirm_cleanup(
        &mut self,
        scope: &Scope,
        profile_id: &str,
        operation_id: &str,
    ) -> Result<ConfigReceipt>;
}

pub trait Cleanup {
    /// Nonblocking signal-and-check port: an async owner performs the actual joins.
    /// Success means revoked actor/tool/discovery work is already quiescent;
    /// CleanupPending means cancellation is owned but not yet confirmed.
    fn quiesce(&mut self, revoked: &ConnectionRef) -> Result<()>;
    /// A reference-only adapter cannot acknowledge cooperative process leases.
    fn quiesce_lease(&mut self, _lease: &RequiredLeaseIdentity) -> Result<()> {
        Err(Error::CleanupPending)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyState {
    Absent,
    Present,
    Unreadable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyDecision {
    UseExisting,
    GenerateFreshPrivateKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeatureStoreEvidence {
    credential_rows: usize,
    profile_rows: usize,
    operation_rows: usize,
    tombstone_rows: usize,
    discovery_rows: usize,
    actor_rows: usize,
    metadata_rows: usize,
}
impl FeatureStoreEvidence {
    fn is_empty(&self) -> bool {
        [
            self.credential_rows,
            self.profile_rows,
            self.operation_rows,
            self.tombstone_rows,
            self.discovery_rows,
            self.actor_rows,
            self.metadata_rows,
        ]
        .iter()
        .all(|count| *count == 0)
    }
}
#[cfg(test)]
impl FeatureStoreEvidence {
    pub(crate) fn empty() -> Self {
        Self {
            credential_rows: 0,
            profile_rows: 0,
            operation_rows: 0,
            tombstone_rows: 0,
            discovery_rows: 0,
            actor_rows: 0,
            metadata_rows: 0,
        }
    }
    pub(crate) fn with_ciphertext() -> Self {
        Self {
            credential_rows: 1,
            ..Self::empty()
        }
    }
}

pub struct SaveIds {
    revision: String,
    credential_id: String,
    credential_generation: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionRef {
    scope: Scope,
    profile_id: String,
    revision: String,
    credential_id: Option<String>,
    credential_generation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectiveConnection {
    reference: ConnectionRef,
    kind: ProfileKind,
    base_url: String,
    transport: Transport,
    auth: StoredAuth,
    cluster_id: Option<String>,
}

pub enum ResolvedAuthorization {
    None,
    Bearer(SecretString),
}

pub(crate) fn validate_scope(scope: &Scope) -> Result<()> {
    if [&scope.owner_id, &scope.environment_id]
        .iter()
        .any(|value| {
            value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control)
        })
    {
        return Err(Error::InvalidScope);
    }
    Ok(())
}

pub(crate) fn validate_uuid(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| Error::InvalidInput)?;
    if parsed.is_nil() || parsed.hyphenated().to_string() != value {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

pub(crate) fn mode_for(kind: ProfileKind) -> discovery::ConnectionMode {
    if kind == ProfileKind::ActualRelay {
        discovery::ConnectionMode::Relay
    } else {
        discovery::ConnectionMode::Local
    }
}

pub(crate) fn transport_for(kind: ProfileKind) -> Transport {
    if kind == ProfileKind::LmStudioLocal {
        Transport::OpenAiChat
    } else {
        Transport::OpenAiResponses
    }
}

pub(crate) fn canonical_target(kind: ProfileKind, input: &str) -> Result<discovery::Endpoint> {
    let endpoint = discovery::config::canonicalize_endpoint(input, mode_for(kind))
        .map_err(|_| Error::InvalidEndpoint)?;
    if kind == ProfileKind::ActualRelay && endpoint.base_url != "https://api.actual.inc/v1" {
        return Err(Error::InvalidEndpoint);
    }
    Ok(endpoint)
}

pub(crate) fn target_for(profile: &StoredProfile) -> CredentialTarget {
    CredentialTarget {
        scope: profile.scope.clone(),
        profile_id: profile.id.clone(),
        kind: profile.kind,
        base_url: profile.base_url.clone(),
        transport: profile.transport,
    }
}

pub(crate) fn reference_for(profile: &StoredProfile) -> ConnectionRef {
    let binding = match &profile.auth {
        StoredAuth::None => None,
        StoredAuth::Bearer(value) => Some(value),
    };
    ConnectionRef {
        scope: profile.scope.clone(),
        profile_id: profile.id.clone(),
        revision: profile.revision.clone(),
        credential_id: binding.map(|value| value.id.clone()),
        credential_generation: binding.map(|value| value.generation.clone()),
    }
}

pub(crate) fn validate_profile(profile: &StoredProfile) -> Result<()> {
    validate_scope(&profile.scope)?;
    validate_uuid(&profile.id)?;
    validate_uuid(&profile.revision)?;
    let endpoint = canonical_target(profile.kind, &profile.base_url)?;
    if endpoint.base_url != profile.base_url || profile.transport != transport_for(profile.kind) {
        return Err(Error::InvalidEndpoint);
    }
    if let Some(cluster) = &profile.cluster_id {
        if profile.kind == ProfileKind::LmStudioLocal
            || cluster.trim().is_empty()
            || cluster.len() > 200
            || cluster.chars().any(char::is_control)
        {
            return Err(Error::InvalidInput);
        }
    }
    match &profile.auth {
        StoredAuth::None => {
            if profile.kind == ProfileKind::ActualRelay {
                return Err(Error::MissingCredential);
            }
            discovery::config::validate_new_key(&endpoint, discovery::AuthMode::None, "")
                .map_err(|_| Error::InvalidEndpoint)?;
        }
        StoredAuth::Bearer(binding) => {
            if profile.kind == ProfileKind::ActualLocal {
                return Err(Error::UnexpectedCredential);
            }
            validate_uuid(&binding.id).map_err(|_| Error::InvalidCredential)?;
            validate_uuid(&binding.generation).map_err(|_| Error::InvalidCredential)?;
            if binding.target != target_for(profile) {
                return Err(Error::CredentialBindingMismatch);
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_ciphertext(value: &SealedSecret) -> Result<()> {
    let rest = value
        .0
        .strip_prefix("enc:v1:")
        .ok_or(Error::EncryptedCredentialRequired)?;
    let (nonce, ciphertext) = rest
        .split_once(':')
        .ok_or(Error::EncryptedCredentialRequired)?;
    if nonce.len() != 24
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        || ciphertext.len() < 32
        || ciphertext.len() > 200_000
        || ciphertext.len() % 2 != 0
        || !ciphertext.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(Error::EncryptedCredentialRequired);
    }
    Ok(())
}

pub(crate) fn profile_from_snapshot(snapshot: &EffectiveConnection) -> StoredProfile {
    StoredProfile {
        scope: snapshot.reference.scope.clone(),
        id: snapshot.reference.profile_id.clone(),
        revision: snapshot.reference.revision.clone(),
        kind: snapshot.kind,
        base_url: snapshot.base_url.clone(),
        transport: snapshot.transport,
        auth: snapshot.auth.clone(),
        cluster_id: snapshot.cluster_id.clone(),
        activation: Activation::Ready,
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    pub const PROFILE: &str = "10000000-0000-4000-8000-000000000001";
    pub const REVISION: &str = "20000000-0000-4000-8000-000000000001";
    pub const NEXT_REVISION: &str = "20000000-0000-4000-8000-000000000002";
    pub const CREDENTIAL: &str = "30000000-0000-4000-8000-000000000001";
    pub const NEXT_CREDENTIAL: &str = "30000000-0000-4000-8000-000000000002";
    pub const GENERATION: &str = "40000000-0000-4000-8000-000000000001";
    pub const NEXT_GENERATION: &str = "40000000-0000-4000-8000-000000000002";
    pub const REQUEST: &str = "50000000-0000-4000-8000-000000000001";
    pub const OPERATION: &str = "60000000-0000-4000-8000-000000000001";
    pub fn scope() -> Scope {
        Scope {
            owner_id: "synthetic-owner".into(),
            environment_id: "synthetic-execution-server".into(),
        }
    }
    pub fn ids() -> SaveIds {
        SaveIds {
            revision: NEXT_REVISION.into(),
            credential_id: NEXT_CREDENTIAL.into(),
            credential_generation: NEXT_GENERATION.into(),
        }
    }
    pub fn profile(kind: ProfileKind) -> StoredProfile {
        let base_url = match kind {
            ProfileKind::ActualRelay => "https://api.actual.inc/v1",
            ProfileKind::ActualLocal => "http://127.0.0.1:8087/v1",
            ProfileKind::LmStudioLocal => "http://127.0.0.1:1234/v1",
        }
        .into();
        let transport = if kind == ProfileKind::LmStudioLocal {
            Transport::OpenAiChat
        } else {
            Transport::OpenAiResponses
        };
        let mut result = StoredProfile {
            scope: scope(),
            id: PROFILE.into(),
            revision: REVISION.into(),
            kind,
            base_url,
            transport,
            auth: StoredAuth::None,
            cluster_id: None,
            activation: Activation::Ready,
        };
        if kind == ProfileKind::ActualRelay {
            result.auth = StoredAuth::Bearer(binding(&result));
        }
        result
    }
    pub fn binding(profile: &StoredProfile) -> CredentialBinding {
        CredentialBinding {
            id: CREDENTIAL.into(),
            generation: GENERATION.into(),
            target: CredentialTarget {
                scope: profile.scope.clone(),
                profile_id: profile.id.clone(),
                kind: profile.kind,
                base_url: profile.base_url.clone(),
                transport: profile.transport,
            },
        }
    }
    pub fn reference(profile: &StoredProfile) -> ConnectionRef {
        let credential = match &profile.auth {
            StoredAuth::None => None,
            StoredAuth::Bearer(value) => Some(value),
        };
        ConnectionRef {
            scope: profile.scope.clone(),
            profile_id: profile.id.clone(),
            revision: profile.revision.clone(),
            credential_id: credential.map(|value| value.id.clone()),
            credential_generation: credential.map(|value| value.generation.clone()),
        }
    }
    pub fn effective(kind: ProfileKind) -> EffectiveConnection {
        let value = profile(kind);
        EffectiveConnection {
            reference: reference(&value),
            kind,
            base_url: value.base_url,
            transport: value.transport,
            auth: value.auth,
            cluster_id: value.cluster_id,
        }
    }
    pub fn update(kind: ProfileKind, auth: AuthChange) -> PutProfile {
        let value = profile(kind);
        PutProfile {
            operation_id: OPERATION.into(),
            profile_id: value.id,
            expected_revision: None,
            kind,
            base_url: value.base_url,
            cluster_id: None,
            auth,
        }
    }
    pub fn synthetic_secret() -> SecretString {
        SecretString::new("synthetic-test-token".into())
    }
    #[derive(Default)]
    pub struct MemoryRepository {
        pub stored: Option<StoredProfile>,
        pub encrypted: Option<EncryptedCredential>,
        pub commits: usize,
        pub fail_commit: bool,
        pub deleted: Option<ProfileTombstone>,
        pub operations: Vec<OperationRecord>,
        pub budget: Budget,
    }
    impl Repository for MemoryRepository {
        fn profile(&self, scope: &Scope, profile_id: &str) -> Result<Option<StoredProfile>> {
            Ok(self
                .stored
                .as_ref()
                .filter(|value| &value.scope == scope && value.id == profile_id)
                .cloned())
        }
        fn credential(
            &self,
            scope: &Scope,
            credential_id: &str,
        ) -> Result<Option<EncryptedCredential>> {
            Ok(self
                .encrypted
                .as_ref()
                .filter(|value| {
                    &value.binding.target.scope == scope && value.binding.id == credential_id
                })
                .cloned())
        }
        fn tombstone(&self, scope: &Scope, profile_id: &str) -> Result<Option<ProfileTombstone>> {
            Ok(self
                .deleted
                .as_ref()
                .filter(|value| &value.scope == scope && value.profile_id == profile_id)
                .cloned())
        }
        fn operation(
            &self,
            scope: &Scope,
            profile_id: &str,
            operation_id: &str,
        ) -> Result<Option<OperationRecord>> {
            Ok(self
                .operations
                .iter()
                .find(|value| {
                    &value.scope == scope
                        && value.profile_id == profile_id
                        && value.operation_id == operation_id
                })
                .cloned())
        }
        fn budget(&self, _scope: &Scope, _profile_id: &str) -> Result<Budget> {
            Ok(self.budget)
        }
        fn capture_revocations(
            &self,
            scope: &Scope,
            profile_id: &str,
            current: Option<&ConnectionRef>,
        ) -> Result<RevocationSet> {
            let pending = self
                .operations
                .iter()
                .filter(|operation| {
                    operation.scope == *scope
                        && operation.profile_id == profile_id
                        && !operation.receipt.cleanup_confirmed
                })
                .cloned()
                .collect::<Vec<_>>();
            RevocationSet::capture_pending(scope, profile_id, &pending, current, &[])
        }
        fn commit_atomic(&mut self, write: AtomicWrite) -> Result<ConfigReceipt> {
            self.commits += 1;
            if self.fail_commit {
                return Err(Error::PersistenceFailed);
            }
            let current = self.stored.as_ref().map(|value| value.revision.clone());
            if current != write.expected_revision {
                return Err(Error::RevisionConflict);
            }
            let recaptured = self.capture_revocations(
                &write.operation.scope,
                &write.operation.profile_id,
                write.operation.revoked.as_ref(),
            )?;
            if recaptured != write.operation.revocations {
                return Err(Error::RevisionConflict);
            }
            self.encrypted = match write.vault_change {
                VaultChange::Keep => self.encrypted.clone(),
                VaultChange::Put(value) => Some(value),
                VaultChange::Delete { .. } => None,
            };
            self.stored = write.profile;
            self.deleted = write.tombstone;
            let receipt = write.operation.receipt.clone();
            self.operations.push(write.operation);
            Ok(receipt)
        }
        fn confirm_cleanup(
            &mut self,
            scope: &Scope,
            profile_id: &str,
            operation_id: &str,
        ) -> Result<ConfigReceipt> {
            let value = self
                .operations
                .iter_mut()
                .find(|value| {
                    &value.scope == scope
                        && value.profile_id == profile_id
                        && value.operation_id == operation_id
                })
                .ok_or(Error::NotFound)?;
            value.receipt.cleanup_confirmed = true;
            if let Some(profile) = &mut self.stored {
                if profile.scope == *scope
                    && profile.id == profile_id
                    && profile.revision == value.receipt.saved_revision
                {
                    profile.activation = Activation::Ready;
                }
            }
            Ok(value.receipt.clone())
        }
    }
    #[derive(Default)]
    pub struct FakeAuthenticator {
        pub calls: usize,
        pub different_payload: bool,
    }
    impl PayloadAuthenticator for FakeAuthenticator {
        fn tag(&mut self, _scope: &Scope, _mutation: &ConfigMutation) -> Result<PayloadTag> {
            self.calls += 1;
            Ok(PayloadTag(
                if self.different_payload {
                    "synthetic-private-payload-tag-two"
                } else {
                    "synthetic-private-payload-tag-one"
                }
                .into(),
            ))
        }
    }
    #[derive(Default)]
    pub struct FakeCleanup {
        pub calls: usize,
        pub fail: bool,
    }
    impl Cleanup for FakeCleanup {
        fn quiesce(&mut self, _revoked: &ConnectionRef) -> Result<()> {
            self.calls += 1;
            if self.fail {
                Err(Error::CleanupPending)
            } else {
                Ok(())
            }
        }
    }
    #[derive(Default)]
    pub struct FakeSealer {
        pub seals: usize,
        pub opens: usize,
        pub fail_seal: bool,
        pub opened: Option<CredentialBinding>,
    }
    impl SecretSealer for FakeSealer {
        fn seal(&mut self, payload: &CredentialPayload) -> Result<SealedSecret> {
            self.seals += 1;
            if self.fail_seal {
                return Err(Error::EncryptionFailed);
            }
            assert_eq!(payload.secret.expose_for_adapter(), "synthetic-test-token");
            // Contract fixture, deliberately not cryptography or a storage adapter.
            Ok(SealedSecret(
                "enc:v1:000000000000000000000000:00000000000000000000000000000000".into(),
            ))
        }
        fn open(&mut self, encrypted: &EncryptedCredential) -> Result<CredentialPayload> {
            self.opens += 1;
            Ok(CredentialPayload {
                binding: self
                    .opened
                    .clone()
                    .unwrap_or_else(|| encrypted.binding.clone()),
                secret: synthetic_secret(),
            })
        }
    }
    pub fn repository_with_relay() -> MemoryRepository {
        let stored = profile(ProfileKind::ActualRelay);
        let encrypted = EncryptedCredential {
            binding: binding(&stored),
            sealed: SealedSecret(
                "enc:v1:000000000000000000000000:00000000000000000000000000000000".into(),
            ),
        };
        MemoryRepository {
            stored: Some(stored),
            encrypted: Some(encrypted),
            ..Default::default()
        }
    }
}

// Gate B scratch-only adapter module; original domain remains frozen.
pub mod storage;

// Original Gate C isolated RED scaffold; no app capability is enabled.
pub(crate) mod leases;

#[cfg(test)]
#[path = "admission_failure_adapter_tests.rs"]
mod admission_failure_adapter_tests;

// Original concrete HTTP owner; application factory integration follows separately.
pub(crate) mod http_discovery;

mod service;
pub use service::{
    ConnectionError, ConnectionService, InferenceStartDisposition, InferenceStartFailure,
    TickReport,
};

pub mod inference;
