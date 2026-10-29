use crate::*;

pub fn resolve(
    scope: &Scope,
    stored: &StoredProfile,
    expected: &ConnectionRef,
    effective_override: Option<&str>,
) -> Result<EffectiveConnection> {
    validate_scope(scope)?;
    if &stored.scope != scope || &expected.scope != scope {
        return Err(Error::InvalidScope);
    }
    if reference_for(stored) != *expected {
        return Err(Error::ConfigurationChanged);
    }
    validate_profile(stored)?;
    if stored.activation != Activation::Ready {
        return Err(Error::CleanupPending);
    }
    if let Some(input) = effective_override {
        let endpoint = discovery::config::canonicalize_endpoint(input, mode_for(stored.kind))
            .map_err(|_| Error::InvalidEndpoint)?;
        if endpoint.base_url != stored.base_url {
            return Err(Error::CredentialTargetChanged);
        }
    }
    Ok(EffectiveConnection {
        reference: expected.clone(),
        kind: stored.kind,
        base_url: stored.base_url.clone(),
        transport: stored.transport,
        auth: stored.auth.clone(),
        cluster_id: stored.cluster_id.clone(),
    })
}

pub fn authorization(
    snapshot: &EffectiveConnection,
    encrypted: Option<&EncryptedCredential>,
    sealer: &mut impl SecretSealer,
) -> Result<ResolvedAuthorization> {
    let profile = profile_from_snapshot(snapshot);
    validate_profile(&profile)?;
    if reference_for(&profile) != snapshot.reference {
        return Err(Error::ConfigurationChanged);
    }
    match &snapshot.auth {
        StoredAuth::None => {
            if encrypted.is_some() {
                return Err(Error::UnexpectedCredential);
            }
            Ok(ResolvedAuthorization::None)
        }
        StoredAuth::Bearer(binding) => {
            let encrypted = encrypted.ok_or(Error::MissingCredential)?;
            if encrypted.binding != *binding {
                return Err(Error::CredentialBindingMismatch);
            }
            validate_ciphertext(&encrypted.sealed)?;
            let payload = sealer.open(encrypted)?;
            if payload.binding != *binding {
                return Err(Error::CredentialBindingMismatch);
            }
            let endpoint = canonical_target(snapshot.kind, &snapshot.base_url)?;
            discovery::config::validate_new_key(
                &endpoint,
                discovery::AuthMode::ApiKey,
                payload.secret.expose_for_adapter(),
            )
            .map_err(|error| {
                if error == discovery::DomainError::MissingCredential {
                    Error::MissingCredential
                } else {
                    Error::InvalidCredential
                }
            })?;
            Ok(ResolvedAuthorization::Bearer(payload.secret))
        }
    }
}

pub fn discovery_plan(snapshot: &EffectiveConnection) -> Result<discovery::DiscoveryPlan> {
    let stored = profile_from_snapshot(snapshot);
    resolve(&stored.scope, &stored, &snapshot.reference, None)?;
    let profile = discovery::Profile {
        owner_id: stored.scope.owner_id.clone(),
        environment_id: stored.scope.environment_id.clone(),
        profile_id: stored.id,
        config_revision: stored.revision,
        provider: if stored.kind == ProfileKind::LmStudioLocal {
            discovery::ProviderKind::LmStudio
        } else {
            discovery::ProviderKind::Actual
        },
        mode: mode_for(stored.kind),
        base_url: stored.base_url.clone(),
        authentication: match stored.auth {
            StoredAuth::None => discovery::Authentication::None,
            StoredAuth::Bearer(binding) => {
                discovery::Authentication::ApiKey(discovery::CredentialReference {
                    vault_id: binding.id,
                    generation: binding.generation,
                    bound_base_url: stored.base_url.clone(),
                })
            }
        },
        cluster_id: stored.cluster_id,
    };
    discovery::config::plan_discovery(&profile, &profile.base_url).map_err(|_| Error::InvalidInput)
}

pub fn dispatch_guard(
    snapshot: &EffectiveConnection,
    current: Option<&StoredProfile>,
) -> Result<()> {
    let stored = current.ok_or(Error::ConfigurationChanged)?;
    let resolved = resolve(&snapshot.reference.scope, stored, &snapshot.reference, None)?;
    if resolved != *snapshot {
        return Err(Error::ConfigurationChanged);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::*;

    #[test]
    fn no_auth_snapshot_is_explicit_loopback_and_does_not_open_any_key() {
        let stored = profile(ProfileKind::ActualLocal);
        let snapshot = resolve(&scope(), &stored, &reference(&stored), None).unwrap();
        assert_eq!(snapshot, effective(ProfileKind::ActualLocal));
        let mut sealer = FakeSealer::default();
        assert!(matches!(
            authorization(&snapshot, None, &mut sealer).unwrap(),
            ResolvedAuthorization::None
        ));
        assert_eq!(sealer.opens, 0);
    }

    #[test]
    fn resolver_never_accepts_another_owner_or_execution_server_reference() {
        let stored = profile(ProfileKind::ActualRelay);
        for field in ["owner", "environment"] {
            let mut foreign = scope();
            if field == "owner" {
                foreign.owner_id = "other".into();
            } else {
                foreign.environment_id = "other".into();
            }
            assert_eq!(
                resolve(&foreign, &stored, &reference(&stored), None),
                Err(Error::InvalidScope)
            );
        }
    }

    #[test]
    fn changed_profile_revision_or_credential_generation_cannot_silently_rebind_a_session() {
        let stored = profile(ProfileKind::ActualRelay);
        for field in ["revision", "credential", "generation"] {
            let mut pinned = reference(&stored);
            match field {
                "revision" => pinned.revision = NEXT_REVISION.into(),
                "credential" => pinned.credential_id = Some(NEXT_CREDENTIAL.into()),
                _ => pinned.credential_generation = Some(NEXT_GENERATION.into()),
            }
            assert_eq!(
                resolve(&scope(), &stored, &pinned, None),
                Err(Error::ConfigurationChanged)
            );
        }
    }

    #[test]
    fn endpoint_override_must_be_the_identical_canonical_saved_target() {
        let stored = profile(ProfileKind::ActualRelay);
        let pinned = reference(&stored);
        assert_eq!(
            resolve(
                &scope(),
                &stored,
                &pinned,
                Some("https://API.ACTUAL.INC:443/v1/")
            ),
            Ok(effective(ProfileKind::ActualRelay))
        );
        assert_eq!(
            resolve(
                &scope(),
                &stored,
                &pinned,
                Some("https://other.example.test/v1")
            ),
            Err(Error::CredentialTargetChanged)
        );
    }

    #[test]
    fn pending_revocation_cleanup_keeps_the_replacement_unavailable() {
        let mut stored = profile(ProfileKind::ActualRelay);
        stored.activation = Activation::CleanupPending;
        assert_eq!(
            resolve(&scope(), &stored, &reference(&stored), None),
            Err(Error::CleanupPending)
        );
    }

    #[test]
    fn wrong_ciphertext_row_binding_is_rejected_before_decryption() {
        let snapshot = effective(ProfileKind::ActualRelay);
        let repository = repository_with_relay();
        for field in [
            "owner",
            "environment",
            "profile",
            "endpoint",
            "credential",
            "generation",
        ] {
            let mut encrypted = repository.encrypted.clone().unwrap();
            match field {
                "owner" => encrypted.binding.target.scope.owner_id = "other".into(),
                "environment" => encrypted.binding.target.scope.environment_id = "other".into(),
                "profile" => {
                    encrypted.binding.target.profile_id =
                        "10000000-0000-4000-8000-000000000002".into()
                }
                "endpoint" => {
                    encrypted.binding.target.base_url = "https://other.example.test/v1".into()
                }
                "credential" => encrypted.binding.id = NEXT_CREDENTIAL.into(),
                _ => encrypted.binding.generation = NEXT_GENERATION.into(),
            }
            let mut sealer = FakeSealer::default();
            assert_eq!(
                authorization(&snapshot, Some(&encrypted), &mut sealer).err(),
                Some(Error::CredentialBindingMismatch)
            );
            assert_eq!(sealer.opens, 0);
        }
    }

    #[test]
    fn authenticated_payload_binding_is_checked_again_after_decryption() {
        let snapshot = effective(ProfileKind::ActualRelay);
        let repository = repository_with_relay();
        let mut different = binding(&profile(ProfileKind::ActualRelay));
        different.target.scope.owner_id = "other".into();
        let mut sealer = FakeSealer {
            opened: Some(different),
            ..Default::default()
        };
        assert_eq!(
            authorization(&snapshot, repository.encrypted.as_ref(), &mut sealer).err(),
            Some(Error::CredentialBindingMismatch)
        );
        assert_eq!(sealer.opens, 1);
    }

    #[test]
    fn typed_bearer_authorization_has_no_plaintext_legacy_fallback() {
        let snapshot = effective(ProfileKind::ActualRelay);
        let repository = repository_with_relay();
        let mut sealer = FakeSealer::default();
        let resolved =
            authorization(&snapshot, repository.encrypted.as_ref(), &mut sealer).unwrap();
        assert!(
            matches!(resolved,ResolvedAuthorization::Bearer(secret) if secret.expose_for_adapter() == "synthetic-test-token")
        );
        let mut plaintext = repository.encrypted.unwrap();
        plaintext.sealed = SealedSecret("synthetic-legacy-plaintext".into());
        assert_eq!(
            authorization(&snapshot, Some(&plaintext), &mut sealer).err(),
            Some(Error::EncryptedCredentialRequired)
        );
    }

    #[test]
    fn none_rejects_supplied_vault_rows_and_bearer_never_tries_a_missing_key() {
        let repository = repository_with_relay();
        let mut sealer = FakeSealer::default();
        assert_eq!(
            authorization(
                &effective(ProfileKind::ActualLocal),
                repository.encrypted.as_ref(),
                &mut sealer
            )
            .err(),
            Some(Error::UnexpectedCredential)
        );
        assert_eq!(
            authorization(&effective(ProfileKind::ActualRelay), None, &mut sealer).err(),
            Some(Error::MissingCredential)
        );
        assert_eq!(sealer.opens, 0);
    }

    #[test]
    fn discovery_reuses_only_get_plans_and_preserves_the_full_effective_binding() {
        for kind in [
            ProfileKind::ActualLocal,
            ProfileKind::ActualRelay,
            ProfileKind::LmStudioLocal,
        ] {
            let snapshot = effective(kind);
            let plan = discovery_plan(&snapshot).unwrap();
            assert_eq!(plan.binding.owner_id, scope().owner_id);
            assert_eq!(plan.binding.environment_id, scope().environment_id);
            assert_eq!(plan.binding.config_revision, REVISION);
            assert_eq!(plan.binding.base_url, snapshot.base_url);
            assert!(plan
                .requests
                .iter()
                .all(|request| request.method == discovery::InventoryMethod::Get));
            assert_eq!(
                plan.requests.len(),
                if kind == ProfileKind::LmStudioLocal {
                    2
                } else {
                    1
                }
            );
            if kind != ProfileKind::ActualRelay {
                assert!(plan
                    .requests
                    .iter()
                    .all(|request| request.credential.is_none()));
            }
        }
    }

    #[test]
    fn every_later_dispatch_checks_revocation_and_deletion_before_network_or_tool_work() {
        let snapshot = effective(ProfileKind::ActualRelay);
        let mut current = profile(ProfileKind::ActualRelay);
        assert_eq!(dispatch_guard(&snapshot, Some(&current)), Ok(()));
        current.revision = NEXT_REVISION.into();
        assert_eq!(
            dispatch_guard(&snapshot, Some(&current)),
            Err(Error::ConfigurationChanged)
        );
        assert_eq!(
            dispatch_guard(&snapshot, None),
            Err(Error::ConfigurationChanged)
        );
    }
}
