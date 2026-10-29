use crate::*;
use serde_json::{json, Map, Value};

pub fn feature_key_policy(state: KeyState, evidence: &FeatureStoreEvidence) -> Result<KeyDecision> {
    match (state, !evidence.is_empty()) {
        (KeyState::Present, _) => Ok(KeyDecision::UseExisting),
        (KeyState::Absent, false) => Ok(KeyDecision::GenerateFreshPrivateKey),
        _ => Err(Error::KeyUnavailable),
    }
}

pub fn decode_put(profile_id: &str, body: &Value) -> Result<PutProfile> {
    validate_uuid(profile_id)?;
    let object = strict_object(
        body,
        &[
            "operationId",
            "expectedRevision",
            "provider",
            "mode",
            "baseUrl",
            "auth",
            "clusterId",
        ],
    )?;
    let operation_id = string_field(object, "operationId")?;
    validate_uuid(operation_id)?;
    let expected_revision = match object.get("expectedRevision") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => {
            validate_uuid(value)?;
            Some(value.clone())
        }
        _ => return Err(Error::InvalidInput),
    };
    let kind = match (
        string_field(object, "provider")?,
        string_field(object, "mode")?,
    ) {
        ("actual", "relay") => ProfileKind::ActualRelay,
        ("actual", "local") => ProfileKind::ActualLocal,
        ("lmstudio", "local") => ProfileKind::LmStudioLocal,
        _ => return Err(Error::InvalidInput),
    };
    let auth_value = object.get("auth").ok_or(Error::InvalidInput)?;
    let auth_object = strict_object(auth_value, &["type", "credentialAction", "secret"])?;
    let auth = match string_field(auth_object, "type")? {
        "none" if auth_object.len() == 1 => AuthChange::None,
        "bearer" => match string_field(auth_object, "credentialAction")? {
            "keep" if auth_object.len() == 2 => AuthChange::KeepBearer,
            "replace" if auth_object.len() == 3 => AuthChange::ReplaceBearer(SecretString::new(
                string_field(auth_object, "secret")?.to_owned(),
            )),
            _ => return Err(Error::InvalidInput),
        },
        _ => return Err(Error::InvalidInput),
    };
    let cluster_id = match object.get("clusterId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(Error::InvalidInput),
    };
    Ok(PutProfile {
        operation_id: operation_id.to_owned(),
        profile_id: profile_id.to_owned(),
        expected_revision,
        kind,
        base_url: string_field(object, "baseUrl")?.to_owned(),
        cluster_id,
        auth,
    })
}

pub fn decode_delete(profile_id: &str, body: &Value) -> Result<DeleteProfile> {
    validate_uuid(profile_id)?;
    let object = strict_object(body, &["operationId", "expectedRevision"])?;
    let operation_id = string_field(object, "operationId")?;
    let expected_revision = string_field(object, "expectedRevision")?;
    validate_uuid(operation_id)?;
    validate_uuid(expected_revision)?;
    Ok(DeleteProfile {
        operation_id: operation_id.to_owned(),
        profile_id: profile_id.to_owned(),
        expected_revision: expected_revision.to_owned(),
    })
}

pub fn mutate(
    repository: &mut impl Repository,
    sealer: &mut impl SecretSealer,
    authenticator: &mut impl PayloadAuthenticator,
    cleanup: &mut impl Cleanup,
    scope: &Scope,
    mutation: ConfigMutation,
    ids: SaveIds,
) -> Result<ConfigReceipt> {
    validate_scope(scope)?;
    let (profile_id, operation_id, expected_revision) = match &mutation {
        ConfigMutation::Put(value) => (
            value.profile_id.clone(),
            value.operation_id.clone(),
            value.expected_revision.clone(),
        ),
        ConfigMutation::Delete(value) => (
            value.profile_id.clone(),
            value.operation_id.clone(),
            Some(value.expected_revision.clone()),
        ),
    };
    validate_uuid(&profile_id)?;
    validate_uuid(&operation_id)?;
    if let Some(revision) = &expected_revision {
        validate_uuid(revision)?;
    }
    let payload_tag = authenticator.tag(scope, &mutation)?;
    if let Some(previous) = repository.operation(scope, &profile_id, &operation_id)? {
        validate_operation(&previous, scope, &profile_id, &operation_id)?;
        if previous.payload_tag != payload_tag {
            return Err(Error::OperationConflict);
        }
        return retry_cleanup(repository, cleanup, scope, &profile_id, &operation_id);
    }
    if repository.tombstone(scope, &profile_id)?.is_some() {
        return Err(Error::NotFound);
    }
    let old = repository.profile(scope, &profile_id)?;
    if old.as_ref().map(|value| &value.revision) != expected_revision.as_ref() {
        return Err(Error::RevisionConflict);
    }
    if let Some(profile) = &old {
        if profile.scope != *scope || profile.id != profile_id {
            return Err(Error::InvalidScope);
        }
        validate_profile(profile)?;
    }
    validate_uuid(&ids.revision)?;
    if old
        .as_ref()
        .is_some_and(|value| value.revision == ids.revision)
    {
        return Err(Error::InvalidInput);
    }
    let revoked = old.as_ref().map(reference_for);
    let revocations = repository.capture_revocations(scope, &profile_id, revoked.as_ref())?;
    revocations.validate(scope, &profile_id)?;
    if revoked.as_ref().is_some_and(|reference| {
        !revocations
            .targets
            .iter()
            .any(|target| &target.connection == reference)
    }) {
        return Err(Error::InvalidInput);
    }
    let (profile, tombstone, vault_change, deleted) = match mutation {
        ConfigMutation::Put(request) => {
            if old
                .as_ref()
                .is_some_and(|value| value.activation == Activation::CleanupPending)
            {
                return Err(Error::CleanupPending);
            }
            let budget = repository.budget(scope, &profile_id)?;
            if budget.put_receipts_for_profile >= 1_024
                || (old.is_none() && budget.profile_ids_including_tombstones >= 128)
            {
                return Err(Error::CapacityReached);
            }
            if old.as_ref().is_some_and(|value| {
                (value.kind == ProfileKind::LmStudioLocal)
                    != (request.kind == ProfileKind::LmStudioLocal)
            }) {
                return Err(Error::InvalidInput);
            }
            let endpoint = canonical_target(request.kind, &request.base_url)?;
            let mut profile = StoredProfile {
                scope: scope.clone(),
                id: profile_id.clone(),
                revision: ids.revision.clone(),
                kind: request.kind,
                base_url: endpoint.base_url,
                transport: transport_for(request.kind),
                auth: StoredAuth::None,
                cluster_id: request.cluster_id,
                activation: if revoked.is_some() {
                    Activation::CleanupPending
                } else {
                    Activation::Ready
                },
            };
            let vault_change = match request.auth {
                AuthChange::None => {
                    if request.kind == ProfileKind::ActualRelay {
                        return Err(Error::MissingCredential);
                    }
                    match old.as_ref().map(|value| &value.auth) {
                        Some(StoredAuth::Bearer(binding)) => VaultChange::Delete {
                            credential_id: binding.id.clone(),
                        },
                        _ => VaultChange::Keep,
                    }
                }
                AuthChange::KeepBearer => {
                    let existing = match old.as_ref().map(|value| &value.auth) {
                        Some(StoredAuth::Bearer(binding)) => binding,
                        _ => return Err(Error::MissingCredential),
                    };
                    if existing.target != target_for(&profile) {
                        return Err(Error::CredentialTargetChanged);
                    }
                    let encrypted = repository
                        .credential(scope, &existing.id)?
                        .ok_or(Error::MissingCredential)?;
                    if encrypted.binding != *existing {
                        return Err(Error::CredentialBindingMismatch);
                    }
                    validate_ciphertext(&encrypted.sealed)?;
                    profile.auth = StoredAuth::Bearer(existing.clone());
                    VaultChange::Keep
                }
                AuthChange::ReplaceBearer(secret) => {
                    if request.kind == ProfileKind::ActualLocal {
                        return Err(Error::UnexpectedCredential);
                    }
                    validate_uuid(&ids.credential_id)?;
                    validate_uuid(&ids.credential_generation)?;
                    if let Some(StoredAuth::Bearer(previous)) =
                        old.as_ref().map(|value| &value.auth)
                    {
                        if previous.id == ids.credential_id
                            || previous.generation == ids.credential_generation
                        {
                            return Err(Error::InvalidCredential);
                        }
                    }
                    let endpoint = canonical_target(profile.kind, &profile.base_url)?;
                    discovery::config::validate_new_key(
                        &endpoint,
                        discovery::AuthMode::ApiKey,
                        secret.expose_for_adapter(),
                    )
                    .map_err(|error| {
                        if error == discovery::DomainError::MissingCredential {
                            Error::MissingCredential
                        } else {
                            Error::InvalidCredential
                        }
                    })?;
                    let binding = CredentialBinding {
                        id: ids.credential_id.clone(),
                        generation: ids.credential_generation.clone(),
                        target: target_for(&profile),
                    };
                    profile.auth = StoredAuth::Bearer(binding.clone());
                    validate_profile(&profile)?;
                    let sealed = sealer.seal(&CredentialPayload {
                        binding: binding.clone(),
                        secret,
                    })?;
                    validate_ciphertext(&sealed)?;
                    VaultChange::Put(EncryptedCredential { binding, sealed })
                }
            };
            validate_profile(&profile)?;
            (Some(profile), None, vault_change, false)
        }
        ConfigMutation::Delete(_) => {
            let old = old.as_ref().ok_or(Error::NotFound)?;
            let vault_change = match &old.auth {
                StoredAuth::Bearer(binding) => VaultChange::Delete {
                    credential_id: binding.id.clone(),
                },
                StoredAuth::None => VaultChange::Keep,
            };
            (
                None,
                Some(ProfileTombstone {
                    scope: scope.clone(),
                    profile_id: profile_id.clone(),
                    revision: ids.revision.clone(),
                    operation_id: operation_id.clone(),
                }),
                vault_change,
                true,
            )
        }
    };
    let receipt = ConfigReceipt {
        operation_id: operation_id.clone(),
        profile_id: profile_id.clone(),
        saved_revision: ids.revision,
        settings_saved: true,
        cleanup_confirmed: revocations.targets.is_empty(),
        deleted,
        superseded: false,
        profile: profile.as_ref().map(public_profile).transpose()?,
    };
    let operation = OperationRecord {
        scope: scope.clone(),
        profile_id: profile_id.clone(),
        operation_id: operation_id.clone(),
        payload_tag,
        receipt,
        revoked,
        revocations,
    };
    let committed = repository.commit_atomic(AtomicWrite {
        expected_revision,
        profile,
        tombstone,
        vault_change,
        operation,
    })?;
    if committed.cleanup_confirmed {
        return Ok(committed);
    }
    // A commit already succeeded. Later read/cleanup/ack failure cannot turn it into
    // an ambiguous save error or cause a subsequent key rotation.
    Ok(retry_cleanup(repository, cleanup, scope, &profile_id, &operation_id).unwrap_or(committed))
}

pub fn public_profile(profile: &StoredProfile) -> Result<Value> {
    validate_profile(profile)?;
    let (provider, mode) = match profile.kind {
        ProfileKind::ActualRelay => ("actual", "relay"),
        ProfileKind::ActualLocal => ("actual", "local"),
        ProfileKind::LmStudioLocal => ("lmstudio", "local"),
    };
    Ok(
        json!({"profileId":profile.id,"provider":provider,"mode":mode,"revision":profile.revision,
        "executionEnvironmentId":profile.scope.environment_id,"baseUrl":profile.base_url,
        "transport":match profile.transport {Transport::OpenAiResponses=>"openai-responses",Transport::OpenAiChat=>"openai-chat"},
        "authMode":if matches!(&profile.auth,StoredAuth::None){"none"}else{"bearer"},
        "credentialState":if matches!(&profile.auth,StoredAuth::None){"not-required"}else{"configured"},
        "clusterId":profile.cluster_id,"activation":if profile.activation == Activation::Ready {"ready"}else{"cleanup-pending"},"inferenceVerified":false}),
    )
}

pub fn operation_status(
    repository: &impl Repository,
    scope: &Scope,
    profile_id: &str,
    operation_id: &str,
) -> Result<ConfigReceipt> {
    validate_scope(scope)?;
    validate_uuid(profile_id)?;
    validate_uuid(operation_id)?;
    let operation = repository
        .operation(scope, profile_id, operation_id)?
        .ok_or(Error::NotFound)?;
    validate_operation(&operation, scope, profile_id, operation_id)?;
    annotate_receipt(repository, scope, operation.receipt)
}

pub fn retry_cleanup(
    repository: &mut impl Repository,
    cleanup: &mut impl Cleanup,
    scope: &Scope,
    profile_id: &str,
    operation_id: &str,
) -> Result<ConfigReceipt> {
    let receipt = operation_status(repository, scope, profile_id, operation_id)?;
    if receipt.cleanup_confirmed {
        return Ok(receipt);
    }
    let operation = repository
        .operation(scope, profile_id, operation_id)?
        .ok_or(Error::NotFound)?;
    validate_operation(&operation, scope, profile_id, operation_id)?;
    let mut all_quiescent = true;
    for target in &operation.revocations.targets {
        if cleanup.quiesce(&target.connection).is_err() {
            all_quiescent = false;
        }
        for lease in &target.leases {
            if cleanup.quiesce_lease(lease).is_err() {
                all_quiescent = false;
            }
        }
    }
    if !all_quiescent {
        return Ok(receipt);
    }
    let acknowledged = match repository.confirm_cleanup(scope, profile_id, operation_id) {
        Ok(value) => value,
        Err(_) => return Ok(receipt),
    };
    Ok(annotate_receipt(repository, scope, acknowledged.clone()).unwrap_or(acknowledged))
}

fn strict_object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value.as_object().ok_or(Error::InvalidInput)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Error::InvalidInput);
    }
    Ok(object)
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::InvalidInput)
}

pub(crate) fn validate_operation(
    operation: &OperationRecord,
    scope: &Scope,
    profile_id: &str,
    operation_id: &str,
) -> Result<()> {
    if operation.scope != *scope
        || operation.profile_id != profile_id
        || operation.operation_id != operation_id
        || operation.receipt.profile_id != profile_id
        || operation.receipt.operation_id != operation_id
        || !operation.receipt.settings_saved
    {
        return Err(Error::NotFound);
    }
    if operation
        .revoked
        .as_ref()
        .is_some_and(|value| value.scope != *scope || value.profile_id != profile_id)
    {
        return Err(Error::InvalidScope);
    }
    operation.revocations.validate(scope, profile_id)?;
    if operation.revoked.as_ref().is_some_and(|reference| {
        !operation
            .revocations
            .targets
            .iter()
            .any(|target| &target.connection == reference)
    }) {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

fn annotate_receipt(
    repository: &impl Repository,
    scope: &Scope,
    mut receipt: ConfigReceipt,
) -> Result<ConfigReceipt> {
    let current_revision = match repository.profile(scope, &receipt.profile_id)? {
        Some(value) => Some(value.revision),
        None => repository
            .tombstone(scope, &receipt.profile_id)?
            .map(|value| value.revision),
    };
    receipt.superseded |= current_revision.as_deref() != Some(receipt.saved_revision.as_str());
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::*;
    use serde_json::json;

    #[derive(Default)]
    struct Harness {
        repository: MemoryRepository,
        sealer: FakeSealer,
        authenticator: FakeAuthenticator,
        cleanup: FakeCleanup,
    }
    fn relay() -> Harness {
        Harness {
            repository: repository_with_relay(),
            ..Default::default()
        }
    }
    fn apply(harness: &mut Harness, mutation: ConfigMutation) -> Result<ConfigReceipt> {
        mutate(
            &mut harness.repository,
            &mut harness.sealer,
            &mut harness.authenticator,
            &mut harness.cleanup,
            &scope(),
            mutation,
            ids(),
        )
    }
    fn replacement() -> PutProfile {
        let mut request = update(
            ProfileKind::ActualRelay,
            AuthChange::ReplaceBearer(synthetic_secret()),
        );
        request.expected_revision = Some(REVISION.into());
        request
    }
    fn deletion() -> DeleteProfile {
        DeleteProfile {
            operation_id: OPERATION.into(),
            profile_id: PROFILE.into(),
            expected_revision: REVISION.into(),
        }
    }

    #[test]
    fn fresh_empty_store_may_create_a_private_key_but_existing_ciphertext_never_regenerates_one() {
        assert_eq!(
            feature_key_policy(KeyState::Absent, &FeatureStoreEvidence::empty()),
            Ok(KeyDecision::GenerateFreshPrivateKey)
        );
        assert_eq!(
            feature_key_policy(KeyState::Absent, &FeatureStoreEvidence::with_ciphertext()),
            Err(Error::KeyUnavailable)
        );
        assert_eq!(
            feature_key_policy(KeyState::Unreadable, &FeatureStoreEvidence::empty()),
            Err(Error::KeyUnavailable)
        );
        assert_eq!(
            feature_key_policy(
                KeyState::Unreadable,
                &FeatureStoreEvidence::with_ciphertext()
            ),
            Err(Error::KeyUnavailable)
        );
        assert_eq!(
            feature_key_policy(KeyState::Present, &FeatureStoreEvidence::with_ciphertext()),
            Ok(KeyDecision::UseExisting)
        );
    }

    #[test]
    fn decode_put_accepts_explicit_none_and_rejects_body_identity_or_unknown_fields() {
        let body = json!({"operationId":OPERATION,"expectedRevision":null,"provider":"lmstudio","mode":"local","baseUrl":"http://127.0.0.1:1234/v1","auth":{"type":"none"},"clusterId":null});
        let decoded = decode_put(PROFILE, &body).unwrap();
        assert_eq!(decoded.operation_id, OPERATION);
        assert!(matches!(decoded.auth, AuthChange::None));
        for field in [
            "ownerId",
            "environmentId",
            "transport",
            "credentialId",
            "unexpected",
        ] {
            let mut invalid = body.clone();
            invalid[field] = json!("untrusted");
            assert_eq!(
                decode_put(PROFILE, &invalid).err(),
                Some(Error::InvalidInput)
            );
        }
    }

    #[test]
    fn decode_bearer_requires_explicit_replace_or_keep_and_never_infers_none_from_blank() {
        let body = json!({"operationId":OPERATION,"expectedRevision":null,"provider":"actual","mode":"relay","baseUrl":"https://api.actual.inc/v1","auth":{"type":"bearer","credentialAction":"replace","secret":"synthetic-test-token"},"clusterId":null});
        assert!(matches!(
            decode_put(PROFILE, &body).unwrap().auth,
            AuthChange::ReplaceBearer(_)
        ));
        for auth in [
            json!({"type":"bearer"}),
            json!({"type":"none","secret":"synthetic-test-token"}),
            json!({"type":"bearer","credentialAction":"keep","secret":"synthetic-test-token"}),
        ] {
            let mut invalid = body.clone();
            invalid["auth"] = auth;
            assert_eq!(
                decode_put(PROFILE, &invalid).err(),
                Some(Error::InvalidInput)
            );
        }
    }

    #[test]
    fn delete_requires_stable_operation_uuid_and_exact_expected_revision() {
        let body = json!({"operationId":OPERATION,"expectedRevision":REVISION});
        let decoded = decode_delete(PROFILE, &body).unwrap();
        assert_eq!(decoded.expected_revision, REVISION);
        for invalid in [
            json!({"operationId":OPERATION}),
            json!({"operationId":"not-uuid","expectedRevision":REVISION}),
            json!({"operationId":OPERATION,"expectedRevision":null}),
            json!({"operationId":OPERATION,"expectedRevision":REVISION,"ownerId":"untrusted"}),
        ] {
            assert_eq!(
                decode_delete(PROFILE, &invalid).err(),
                Some(Error::InvalidInput)
            );
        }
    }

    #[test]
    fn local_none_creation_persists_canonical_target_without_a_credential_or_cleanup_probe() {
        let mut harness = Harness::default();
        let mut request = update(ProfileKind::LmStudioLocal, AuthChange::None);
        request.base_url.push('/');
        let receipt = apply(&mut harness, ConfigMutation::Put(request)).unwrap();
        let saved = harness.repository.stored.as_ref().unwrap();
        assert_eq!(saved.base_url, "http://127.0.0.1:1234/v1");
        assert_eq!(saved.auth, StoredAuth::None);
        assert!(receipt.settings_saved && receipt.cleanup_confirmed);
        assert_eq!((harness.sealer.seals, harness.cleanup.calls), (0, 0));
    }

    #[test]
    fn new_relay_profile_has_no_legacy_or_environment_credential_fallback() {
        let mut harness = Harness::default();
        assert_eq!(
            apply(
                &mut harness,
                ConfigMutation::Put(update(ProfileKind::ActualRelay, AuthChange::KeepBearer))
            ),
            Err(Error::MissingCredential)
        );
        assert_eq!((harness.repository.commits, harness.sealer.seals), (0, 0));
    }

    #[test]
    fn remote_none_and_nonofficial_relay_targets_cannot_be_configured_in_this_scope() {
        for (kind, auth, endpoint) in [
            (
                ProfileKind::ActualLocal,
                AuthChange::None,
                "https://remote.example.test/v1",
            ),
            (
                ProfileKind::ActualRelay,
                AuthChange::ReplaceBearer(synthetic_secret()),
                "https://unverified.example.test/v1",
            ),
        ] {
            let mut harness = Harness::default();
            let mut request = update(kind, auth);
            request.base_url = endpoint.into();
            assert_eq!(
                apply(&mut harness, ConfigMutation::Put(request)),
                Err(Error::InvalidEndpoint)
            );
            assert_eq!((harness.repository.commits, harness.sealer.seals), (0, 0));
        }
    }

    #[test]
    fn replacement_binds_new_ciphertext_and_revokes_the_exact_old_revision_atomically() {
        let mut harness = relay();
        let receipt = apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        let encrypted = harness.repository.encrypted.as_ref().unwrap();
        assert_eq!(encrypted.binding.id, NEXT_CREDENTIAL);
        assert_eq!(encrypted.binding.generation, NEXT_GENERATION);
        assert_eq!(encrypted.binding.target.scope, scope());
        assert_eq!(
            encrypted.binding.target.base_url,
            "https://api.actual.inc/v1"
        );
        assert_eq!(
            harness.repository.operations[0].revoked,
            Some(reference(&profile(ProfileKind::ActualRelay)))
        );
        assert_eq!(receipt.saved_revision, NEXT_REVISION);
        assert_eq!(
            (
                harness.repository.commits,
                harness.sealer.seals,
                harness.cleanup.calls
            ),
            (1, 1, 1)
        );
    }

    #[test]
    fn keep_allows_only_the_same_canonical_endpoint_and_preserves_generation() {
        let mut harness = relay();
        let mut request = update(ProfileKind::ActualRelay, AuthChange::KeepBearer);
        request.expected_revision = Some(REVISION.into());
        request.base_url = "https://API.ACTUAL.INC:443/v1/".into();
        request.cluster_id = Some("synthetic-cluster".into());
        apply(&mut harness, ConfigMutation::Put(request)).unwrap();
        let saved = harness.repository.stored.as_ref().unwrap();
        assert!(
            matches!(&saved.auth,StoredAuth::Bearer(binding) if binding.generation == GENERATION)
        );
        assert_eq!(saved.cluster_id.as_deref(), Some("synthetic-cluster"));
        assert_eq!(harness.sealer.seals, 0);
    }

    #[test]
    fn keep_does_not_move_an_optional_local_token_to_a_new_port() {
        let mut harness = Harness::default();
        let mut saved = profile(ProfileKind::LmStudioLocal);
        saved.auth = StoredAuth::Bearer(binding(&saved));
        harness.repository.stored = Some(saved.clone());
        let mut request = update(ProfileKind::LmStudioLocal, AuthChange::KeepBearer);
        request.expected_revision = Some(REVISION.into());
        request.base_url = "http://127.0.0.1:1235/v1".into();
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(request)),
            Err(Error::CredentialTargetChanged)
        );
        assert_eq!(harness.repository.stored, Some(saved));
        assert_eq!(harness.repository.commits, 0);
    }

    #[test]
    fn switching_actual_to_explicit_local_none_deletes_the_detached_relay_credential() {
        let mut harness = relay();
        let mut request = update(ProfileKind::ActualLocal, AuthChange::None);
        request.expected_revision = Some(REVISION.into());
        apply(&mut harness, ConfigMutation::Put(request)).unwrap();
        assert!(harness.repository.encrypted.is_none());
        assert_eq!(
            harness.repository.stored.as_ref().unwrap().auth,
            StoredAuth::None
        );
        assert_eq!(harness.sealer.seals, 0);
    }

    #[test]
    fn encryption_failure_never_starts_a_commit_or_removes_the_existing_key() {
        let mut harness = relay();
        let before = harness.repository.stored.clone();
        let ciphertext = harness.repository.encrypted.clone();
        harness.sealer.fail_seal = true;
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(replacement())),
            Err(Error::EncryptionFailed)
        );
        assert_eq!(harness.repository.stored, before);
        assert!(harness.repository.encrypted == ciphertext);
        assert_eq!(harness.repository.commits, 0);
    }

    #[test]
    fn atomic_commit_failure_keeps_old_profile_ciphertext_and_receipt_ledger() {
        let mut harness = relay();
        let before = harness.repository.stored.clone();
        let ciphertext = harness.repository.encrypted.clone();
        harness.repository.fail_commit = true;
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(replacement())),
            Err(Error::PersistenceFailed)
        );
        assert_eq!(harness.repository.stored, before);
        assert!(harness.repository.encrypted == ciphertext);
        assert!(harness.repository.operations.is_empty());
        assert_eq!(harness.cleanup.calls, 0);
    }

    #[test]
    fn stale_revision_fails_before_encrypting_a_replacement_or_running_cleanup() {
        let mut harness = relay();
        let mut request = replacement();
        request.expected_revision = Some(NEXT_REVISION.into());
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(request)),
            Err(Error::RevisionConflict)
        );
        assert_eq!(
            (
                harness.repository.commits,
                harness.sealer.seals,
                harness.cleanup.calls
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn another_owner_or_execution_environment_cannot_update_this_profile() {
        for field in ["owner", "environment"] {
            let mut harness = relay();
            let mut foreign = scope();
            if field == "owner" {
                foreign.owner_id = "another-owner".into();
            } else {
                foreign.environment_id = "another-server".into();
            }
            assert_eq!(
                mutate(
                    &mut harness.repository,
                    &mut harness.sealer,
                    &mut harness.authenticator,
                    &mut harness.cleanup,
                    &foreign,
                    ConfigMutation::Put(replacement()),
                    ids()
                ),
                Err(Error::RevisionConflict)
            );
            assert_eq!((harness.repository.commits, harness.sealer.seals), (0, 0));
        }
    }

    #[test]
    fn identical_lost_response_retry_reuses_receipt_before_cas_and_does_not_rotate_again() {
        let mut harness = relay();
        let first = apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        let second = apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        assert_eq!(second, first);
        assert_eq!(
            (
                harness.repository.commits,
                harness.sealer.seals,
                harness.cleanup.calls
            ),
            (1, 1, 1)
        );
    }

    #[test]
    fn reused_operation_uuid_with_different_private_payload_identity_is_a_conflict() {
        let mut harness = relay();
        apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        harness.authenticator.different_payload = true;
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(replacement())),
            Err(Error::OperationConflict)
        );
        assert_eq!((harness.repository.commits, harness.sealer.seals), (1, 1));
    }

    #[test]
    fn saved_but_cleanup_pending_retry_only_quiesces_original_revocation() {
        let mut harness = relay();
        harness.cleanup.fail = true;
        let saved = apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        assert!(saved.settings_saved && !saved.cleanup_confirmed);
        assert_eq!(
            harness.repository.stored.as_ref().unwrap().activation,
            Activation::CleanupPending
        );
        harness.cleanup.fail = false;
        let retried = apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        assert!(retried.cleanup_confirmed);
        assert_eq!(retried.saved_revision, saved.saved_revision);
        assert_eq!(retried.operation_id, saved.operation_id);
        assert_eq!(retried.profile, saved.profile);
        assert_eq!(
            harness.repository.stored.as_ref().unwrap().activation,
            Activation::Ready
        );
        assert_eq!(
            (
                harness.repository.commits,
                harness.sealer.seals,
                harness.cleanup.calls
            ),
            (1, 1, 2)
        );
    }

    #[test]
    fn delete_is_atomic_deduplicated_and_cannot_restore_a_credential_after_lost_response() {
        let mut harness = relay();
        let first = apply(&mut harness, ConfigMutation::Delete(deletion())).unwrap();
        assert!(first.settings_saved && first.deleted);
        assert!(harness.repository.stored.is_none());
        assert!(harness.repository.encrypted.is_none());
        assert!(harness.repository.deleted.is_some());
        let repeated = apply(&mut harness, ConfigMutation::Delete(deletion())).unwrap();
        assert_eq!(repeated, first);
        assert_eq!(harness.repository.commits, 1);
        let mut request = update(
            ProfileKind::ActualRelay,
            AuthChange::ReplaceBearer(synthetic_secret()),
        );
        request.operation_id = "60000000-0000-4000-8000-000000000002".into();
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(request)),
            Err(Error::NotFound)
        );
        assert!(harness.repository.encrypted.is_none());
    }

    #[test]
    fn receipt_budget_rejects_new_put_before_encryption_but_preserves_reserved_final_delete() {
        let mut harness = relay();
        harness.repository.budget = Budget {
            profile_ids_including_tombstones: 128,
            put_receipts_for_profile: 1024,
        };
        assert_eq!(
            apply(&mut harness, ConfigMutation::Put(replacement())),
            Err(Error::CapacityReached)
        );
        assert_eq!(harness.sealer.seals, 0);
        assert!(
            apply(&mut harness, ConfigMutation::Delete(deletion()))
                .unwrap()
                .deleted
        );
    }

    #[test]
    fn public_config_contains_no_credential_reference_secret_or_inference_claim() {
        let value = public_profile(&profile(ProfileKind::ActualRelay)).unwrap();
        assert_eq!(
            value,
            json!({"profileId":PROFILE,"provider":"actual","mode":"relay","revision":REVISION,"executionEnvironmentId":"synthetic-execution-server","baseUrl":"https://api.actual.inc/v1","transport":"openai-responses","authMode":"bearer","credentialState":"configured","clusterId":null,"activation":"ready","inferenceVerified":false})
        );
    }

    #[test]
    fn committed_operation_can_be_looked_up_and_cleanup_retried_without_resupplying_a_secret() {
        let mut harness = relay();
        harness.cleanup.fail = true;
        let saved = apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        assert_eq!(
            operation_status(&harness.repository, &scope(), PROFILE, OPERATION),
            Ok(saved.clone())
        );
        harness.cleanup.fail = false;
        let recovered = retry_cleanup(
            &mut harness.repository,
            &mut harness.cleanup,
            &scope(),
            PROFILE,
            OPERATION,
        )
        .unwrap();
        assert!(recovered.cleanup_confirmed);
        assert_eq!(recovered.saved_revision, saved.saved_revision);
        assert_eq!((harness.repository.commits, harness.sealer.seals), (1, 1));
        let mut foreign = scope();
        foreign.owner_id = "other-owner".into();
        assert_eq!(
            operation_status(&harness.repository, &foreign, PROFILE, OPERATION),
            Err(Error::NotFound)
        );
    }

    #[test]
    fn cleanup_of_a_superseded_operation_cannot_activate_a_later_profile_revision() {
        let mut harness = relay();
        harness.cleanup.fail = true;
        apply(&mut harness, ConfigMutation::Put(replacement())).unwrap();
        let current = harness.repository.stored.as_mut().unwrap();
        current.revision = "20000000-0000-4000-8000-000000000003".into();
        current.activation = Activation::CleanupPending;
        harness.repository.operations[0].receipt.superseded = true;
        harness.cleanup.fail = false;
        let historical = retry_cleanup(
            &mut harness.repository,
            &mut harness.cleanup,
            &scope(),
            PROFILE,
            OPERATION,
        )
        .unwrap();
        assert!(historical.cleanup_confirmed && historical.superseded);
        assert_eq!(
            harness.repository.stored.as_ref().unwrap().activation,
            Activation::CleanupPending
        );
        assert_eq!(harness.repository.commits, 1);
    }

    struct ReferenceCleanup {
        blocked: ConnectionRef,
        calls: Vec<ConnectionRef>,
    }
    impl Cleanup for ReferenceCleanup {
        fn quiesce(&mut self, revoked: &ConnectionRef) -> Result<()> {
            self.calls.push(revoked.clone());
            if *revoked == self.blocked {
                Err(Error::CleanupPending)
            } else {
                Ok(())
            }
        }
    }
    fn pending_a_to_b() -> (
        MemoryRepository,
        FakeSealer,
        FakeAuthenticator,
        ReferenceCleanup,
        ConnectionRef,
        ConnectionRef,
    ) {
        let mut repository = repository_with_relay();
        let a = reference(repository.stored.as_ref().unwrap());
        let mut cleanup = ReferenceCleanup {
            blocked: a.clone(),
            calls: vec![],
        };
        let mut sealer = FakeSealer::default();
        let mut authenticator = FakeAuthenticator::default();
        let result = mutate(
            &mut repository,
            &mut sealer,
            &mut authenticator,
            &mut cleanup,
            &scope(),
            ConfigMutation::Put(replacement()),
            ids(),
        )
        .unwrap();
        assert!(result.settings_saved && !result.cleanup_confirmed);
        let b = reference(repository.stored.as_ref().unwrap());
        (repository, sealer, authenticator, cleanup, a, b)
    }
    const DELETE_B_OPERATION: &str = "60000000-0000-4000-8000-000000000002";
    fn delete_pending_b(
        repository: &mut MemoryRepository,
        sealer: &mut FakeSealer,
        authenticator: &mut FakeAuthenticator,
        cleanup: &mut ReferenceCleanup,
    ) -> ConfigReceipt {
        let mutation = ConfigMutation::Delete(DeleteProfile {
            operation_id: DELETE_B_OPERATION.into(),
            profile_id: PROFILE.into(),
            expected_revision: NEXT_REVISION.into(),
        });
        let mut delete_ids = ids();
        delete_ids.revision = "20000000-0000-4000-8000-000000000003".into();
        mutate(
            repository,
            sealer,
            authenticator,
            cleanup,
            &scope(),
            mutation,
            delete_ids,
        )
        .unwrap()
    }
    fn captured_cleanup_targets(operation: &OperationRecord) -> Vec<ConnectionRef> {
        operation
            .revocations
            .targets
            .iter()
            .map(|target| target.connection.clone())
            .collect()
    }

    #[test]
    fn deleting_pending_b_cannot_confirm_cleanup_while_previously_revoked_a_is_active() {
        let (mut repository, mut sealer, mut authenticator, mut cleanup, _a, _b) = pending_a_to_b();
        let deleted = delete_pending_b(
            &mut repository,
            &mut sealer,
            &mut authenticator,
            &mut cleanup,
        );
        assert!(deleted.settings_saved && deleted.deleted);
        assert!(!deleted.cleanup_confirmed);
        assert!(repository.stored.is_none() && repository.encrypted.is_none());
    }

    #[test]
    fn deleting_pending_b_persists_the_immutable_union_of_a_and_b_cleanup_targets() {
        let (mut repository, mut sealer, mut authenticator, mut cleanup, a, b) = pending_a_to_b();
        let required_lease = RequiredLeaseIdentity {
            actor_id: "70000000-0000-4000-8000-000000000001".into(),
            process_instance_id: "70000000-0000-4000-8000-000000000002".into(),
            lease_id: "70000000-0000-4000-8000-000000000003".into(),
        };
        repository.operations[0].revocations.targets[0]
            .leases
            .push(required_lease.clone());
        delete_pending_b(
            &mut repository,
            &mut sealer,
            &mut authenticator,
            &mut cleanup,
        );
        let committed = repository
            .operations
            .iter()
            .find(|operation| operation.operation_id == DELETE_B_OPERATION)
            .unwrap();
        assert_eq!(captured_cleanup_targets(committed), vec![a, b]);
        assert_eq!(
            committed.revocations.targets[0].leases,
            vec![required_lease]
        );
    }

    #[test]
    fn a_delete_cleanup_retry_keeps_waiting_for_a_without_another_config_write() {
        let (mut repository, mut sealer, mut authenticator, mut cleanup, a, _b) = pending_a_to_b();
        let saved = delete_pending_b(
            &mut repository,
            &mut sealer,
            &mut authenticator,
            &mut cleanup,
        );
        cleanup.calls.clear();
        let retry = retry_cleanup(
            &mut repository,
            &mut cleanup,
            &scope(),
            PROFILE,
            DELETE_B_OPERATION,
        )
        .unwrap();
        assert!(!retry.cleanup_confirmed);
        assert!(cleanup.calls.contains(&a));
        assert_eq!(
            (retry.operation_id, retry.saved_revision),
            (saved.operation_id, saved.saved_revision)
        );
        assert_eq!((repository.commits, sealer.seals), (2, 1));
    }

    #[test]
    fn a_none_profile_without_ciphertext_still_requires_its_existing_feature_key() {
        let evidence = FeatureStoreEvidence {
            profile_rows: 1,
            ..FeatureStoreEvidence::empty()
        };
        assert_eq!(
            feature_key_policy(KeyState::Absent, &evidence),
            Err(Error::KeyUnavailable)
        );
    }

    #[test]
    fn hmac_operation_receipts_without_ciphertext_must_not_silently_rotate_the_feature_key() {
        let evidence = FeatureStoreEvidence {
            operation_rows: 1,
            ..FeatureStoreEvidence::empty()
        };
        assert_eq!(
            feature_key_policy(KeyState::Absent, &evidence),
            Err(Error::KeyUnavailable)
        );
    }

    #[test]
    fn tombstone_discovery_or_actor_rows_are_nonempty_feature_state_even_without_ciphertext() {
        for evidence in [
            FeatureStoreEvidence {
                tombstone_rows: 1,
                ..FeatureStoreEvidence::empty()
            },
            FeatureStoreEvidence {
                discovery_rows: 1,
                ..FeatureStoreEvidence::empty()
            },
            FeatureStoreEvidence {
                actor_rows: 1,
                ..FeatureStoreEvidence::empty()
            },
            FeatureStoreEvidence {
                metadata_rows: 1,
                ..FeatureStoreEvidence::empty()
            },
        ] {
            assert_eq!(
                feature_key_policy(KeyState::Absent, &evidence),
                Err(Error::KeyUnavailable)
            );
        }
    }
}
