use super::{
    AuthMode, Authentication, ConnectionMode, DiscoveryBinding, DiscoveryPlan, DomainError,
    Endpoint, InventoryKind, InventoryMethod, InventoryReceipt, InventoryRequest, Profile,
    ProviderKind,
};
use url::{Host, Url};

pub fn canonicalize_endpoint(input: &str, mode: ConnectionMode) -> Result<Endpoint, DomainError> {
    if input.chars().count() > 2_048
        || input.trim() != input
        || input.chars().any(char::is_control)
        || input.contains('\\')
    {
        return Err(DomainError::InvalidEndpoint);
    }
    let (_, remainder) = input
        .split_once("://")
        .ok_or(DomainError::InvalidEndpoint)?;
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err(DomainError::InvalidEndpoint);
    }
    let mut url = Url::parse(input).map_err(|_| DomainError::InvalidEndpoint)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err(DomainError::InvalidEndpoint);
    }
    let literal_loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(_)) => false,
        None => return Err(DomainError::InvalidEndpoint),
    };
    match mode {
        ConnectionMode::Local if literal_loopback && matches!(url.scheme(), "http" | "https") => {}
        ConnectionMode::Relay | ConnectionMode::CustomHttps if url.scheme() == "https" => {}
        _ => return Err(DomainError::InvalidEndpoint),
    }
    // Keep the explicit API prefix; do not guess /v1 or replace an inference suffix.
    let path = url.path().trim_end_matches('/').to_owned();
    if !path.ends_with("/v1") {
        return Err(DomainError::InvalidEndpoint);
    }
    url.set_path(&path);
    Ok(Endpoint {
        base_url: url.to_string(),
        verified_literal_loopback: mode == ConnectionMode::Local && literal_loopback,
    })
}

pub fn validate_new_key(endpoint: &Endpoint, mode: AuthMode, key: &str) -> Result<(), DomainError> {
    match mode {
        AuthMode::None => {
            // The public scaffold types are constructible. Recheck the URL rather than
            // accepting a caller-supplied `verified_literal_loopback: true` on its own.
            let local = canonicalize_endpoint(&endpoint.base_url, ConnectionMode::Local);
            if !endpoint.verified_literal_loopback
                || !matches!(local, Ok(ref value) if value.base_url == endpoint.base_url)
            {
                return Err(DomainError::NoAuthRequiresLoopback);
            }
            if !key.is_empty() {
                return Err(DomainError::UnexpectedCredential);
            }
            Ok(())
        }
        AuthMode::ApiKey => {
            if key.trim().is_empty() {
                return Err(DomainError::MissingCredential);
            }
            if key.chars().count() > 10_000 || key.chars().any(char::is_control) {
                return Err(DomainError::InvalidCredential);
            }
            Ok(())
        }
    }
}

pub fn plan_discovery(
    profile: &Profile,
    effective_base_url: &str,
) -> Result<DiscoveryPlan, DomainError> {
    if [
        &profile.owner_id,
        &profile.environment_id,
        &profile.profile_id,
        &profile.config_revision,
    ]
    .iter()
    .any(|value| !valid_opaque_value(value))
    {
        return Err(DomainError::InvalidProfile);
    }
    if profile.mode == ConnectionMode::Relay && profile.provider != ProviderKind::Actual {
        return Err(DomainError::UnsupportedProviderMode);
    }
    if let Some(cluster_id) = &profile.cluster_id {
        if profile.provider != ProviderKind::Actual
            || !valid_opaque_value(cluster_id)
            || cluster_id.len() > 200
        {
            return Err(DomainError::InvalidProfile);
        }
    }
    let endpoint = canonicalize_endpoint(&profile.base_url, profile.mode)?;
    let effective = canonicalize_endpoint(effective_base_url, profile.mode)?;
    if endpoint.base_url != effective.base_url {
        return Err(DomainError::CredentialTargetMismatch);
    }
    let credential = match &profile.authentication {
        Authentication::None => {
            validate_new_key(&endpoint, AuthMode::None, "")?;
            None
        }
        Authentication::ApiKey(reference) => {
            // Actual's documented local endpoint does not use its public relay key.
            if profile.provider == ProviderKind::Actual && profile.mode == ConnectionMode::Local {
                return Err(DomainError::UnexpectedCredential);
            }
            if reference.vault_id.trim().is_empty() || reference.generation.trim().is_empty() {
                return Err(DomainError::MissingCredential);
            }
            if !valid_opaque_value(&reference.vault_id)
                || !valid_opaque_value(&reference.generation)
            {
                return Err(DomainError::InvalidCredential);
            }
            let bound = canonicalize_endpoint(&reference.bound_base_url, profile.mode)
                .map_err(|_| DomainError::CredentialTargetMismatch)?;
            if bound.base_url != endpoint.base_url {
                return Err(DomainError::CredentialTargetMismatch);
            }
            let mut reference = reference.clone();
            reference.bound_base_url = endpoint.base_url.clone();
            Some(reference)
        }
    };
    let binding = DiscoveryBinding {
        owner_id: profile.owner_id.clone(),
        environment_id: profile.environment_id.clone(),
        profile_id: profile.profile_id.clone(),
        config_revision: profile.config_revision.clone(),
        provider: profile.provider,
        base_url: endpoint.base_url.clone(),
        auth_mode: if credential.is_some() {
            AuthMode::ApiKey
        } else {
            AuthMode::None
        },
        credential_id: credential.as_ref().map(|value| value.vault_id.clone()),
        credential_generation: credential.as_ref().map(|value| value.generation.clone()),
        cluster_id: profile.cluster_id.clone(),
    };
    let mut requests = vec![InventoryRequest {
        method: InventoryMethod::Get,
        kind: if profile.provider == ProviderKind::Actual {
            InventoryKind::ActualModels
        } else {
            InventoryKind::OpenAiModels
        },
        url: format!("{}/models", endpoint.base_url),
        credential: credential.clone(),
        cluster_id: profile.cluster_id.clone(),
    }];
    let parsed = Url::parse(&endpoint.base_url).map_err(|_| DomainError::InvalidEndpoint)?;
    if profile.provider == ProviderKind::LmStudio
        && profile.mode == ConnectionMode::Local
        && parsed.path() == "/v1"
    {
        let mut metadata_url = parsed;
        metadata_url.set_path("/api/v1/models");
        requests.push(InventoryRequest {
            method: InventoryMethod::Get,
            kind: InventoryKind::LmStudioMetadata,
            url: metadata_url.to_string(),
            credential,
            cluster_id: None,
        });
    }
    Ok(DiscoveryPlan { binding, requests })
}

pub fn validate_receipt_binding(
    plan: &DiscoveryPlan,
    receipt: &InventoryReceipt,
) -> Result<(), DomainError> {
    if receipt.binding != plan.binding {
        return Err(DomainError::ReceiptBindingMismatch);
    }
    let request = plan
        .requests
        .iter()
        .find(|request| request.kind == receipt.kind)
        .ok_or(DomainError::ReceiptKindMismatch)?;
    if receipt.effective_url != request.url {
        return Err(DomainError::ReceiptTargetMismatch);
    }
    Ok(())
}

fn valid_opaque_value(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::super::{
        fixtures::*, Authentication, CredentialReference, InventoryKind, InventoryMethod,
        ProviderKind,
    };
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_https_target_retains_base_prefix_and_removes_default_port_and_trailing_slash() {
        assert_eq!(
            canonicalize_endpoint(
                "https://API.EXAMPLE.test:443/provider/v1/",
                ConnectionMode::CustomHttps
            ),
            Ok(Endpoint {
                base_url: "https://api.example.test/provider/v1".into(),
                verified_literal_loopback: false
            })
        );
    }

    #[test]
    fn literal_loopback_local_endpoints_support_both_ip_families() {
        for (input, expected) in [
            ("http://127.0.0.1:1234/v1/", "http://127.0.0.1:1234/v1"),
            ("http://[::1]:8084/v1", "http://[::1]:8084/v1"),
        ] {
            assert_eq!(
                canonicalize_endpoint(input, ConnectionMode::Local),
                Ok(Endpoint {
                    base_url: expected.into(),
                    verified_literal_loopback: true
                })
            );
        }
    }

    #[test]
    fn endpoints_reject_credentials_query_fragment_http_remote_and_deceptive_loopback_names() {
        for value in [
            "https://user:secret@example.test/v1",
            "https://example.test/v1?key=secret",
            "https://example.test/v1#fragment",
            "http://example.test/v1",
            "http://127.0.0.1.example.test/v1",
            "http://localhost.example.test/v1",
            "file:///private/data",
            "http://0.0.0.0:1234/v1",
        ] {
            assert_eq!(
                canonicalize_endpoint(value, ConnectionMode::Local),
                Err(DomainError::InvalidEndpoint),
                "{value}"
            );
        }
    }

    #[test]
    fn hostname_localhost_is_not_treated_as_verified_loopback_without_resolver_evidence() {
        assert_eq!(
            canonicalize_endpoint("http://localhost:1234/v1", ConnectionMode::Local),
            Err(DomainError::InvalidEndpoint)
        );
    }

    #[test]
    fn empty_key_is_allowed_only_for_explicit_none_mode_on_verified_literal_loopback() {
        let local = Endpoint {
            base_url: "http://127.0.0.1:1234/v1".into(),
            verified_literal_loopback: true,
        };
        let remote = Endpoint {
            base_url: "https://api.actual.inc/v1".into(),
            verified_literal_loopback: false,
        };
        assert_eq!(validate_new_key(&local, AuthMode::None, ""), Ok(()));
        assert_eq!(
            validate_new_key(&local, AuthMode::ApiKey, ""),
            Err(DomainError::MissingCredential)
        );
        assert_eq!(
            validate_new_key(&remote, AuthMode::None, ""),
            Err(DomainError::NoAuthRequiresLoopback)
        );
        assert_eq!(
            validate_new_key(&local, AuthMode::None, "synthetic-relay-token"),
            Err(DomainError::UnexpectedCredential)
        );
    }

    #[test]
    fn key_validation_has_no_vendor_prefix_assumption_but_rejects_blank_control_and_oversized_values(
    ) {
        let endpoint = Endpoint {
            base_url: "https://example.test/v1".into(),
            verified_literal_loopback: false,
        };
        assert_eq!(
            validate_new_key(&endpoint, AuthMode::ApiKey, "synthetic-token"),
            Ok(())
        );
        assert_eq!(
            validate_new_key(&endpoint, AuthMode::ApiKey, "   "),
            Err(DomainError::MissingCredential)
        );
        assert_eq!(
            validate_new_key(&endpoint, AuthMode::ApiKey, "value\nheader"),
            Err(DomainError::InvalidCredential)
        );
        assert_eq!(
            validate_new_key(&endpoint, AuthMode::ApiKey, &"a".repeat(10_001)),
            Err(DomainError::InvalidCredential)
        );
    }

    #[test]
    fn actual_relay_plan_is_one_get_bound_to_the_exact_owner_target_and_credential_generation() {
        let mut profile = profile(ProviderKind::Actual);
        profile.cluster_id = Some("cluster-synthetic".into());
        let mut expected = plan(ProviderKind::Actual);
        expected.binding.cluster_id = profile.cluster_id.clone();
        expected.requests[0].cluster_id = profile.cluster_id.clone();
        assert_eq!(plan_discovery(&profile, &profile.base_url), Ok(expected));
    }

    #[test]
    fn lmstudio_local_no_auth_plan_contains_only_explicit_get_inventory_requests() {
        let profile = profile(ProviderKind::LmStudio);
        let expected = plan(ProviderKind::LmStudio);
        assert!(expected
            .requests
            .iter()
            .all(|request| request.method == InventoryMethod::Get && request.credential.is_none()));
        assert_eq!(plan_discovery(&profile, &profile.base_url), Ok(expected));
    }

    #[test]
    fn actual_local_mode_omits_relay_credential_and_uses_the_explicit_dynamic_port() {
        let mut profile = profile(ProviderKind::Actual);
        profile.mode = ConnectionMode::Local;
        profile.base_url = "http://127.0.0.1:8087/v1".into();
        profile.authentication = Authentication::None;
        let mut expected = plan(ProviderKind::Actual);
        expected.binding.base_url = profile.base_url.clone();
        expected.binding.auth_mode = AuthMode::None;
        expected.binding.credential_id = None;
        expected.binding.credential_generation = None;
        expected.requests[0].url = "http://127.0.0.1:8087/v1/models".into();
        expected.requests[0].credential = None;
        assert_eq!(plan_discovery(&profile, &profile.base_url), Ok(expected));
    }

    #[test]
    fn custom_prefix_skips_unverified_lmstudio_native_metadata_route() {
        let mut profile = profile(ProviderKind::LmStudio);
        profile.base_url = "http://127.0.0.1:1234/custom/v1".into();
        let mut expected = plan(ProviderKind::LmStudio);
        expected.binding.base_url = profile.base_url.clone();
        expected.requests.truncate(1);
        expected.requests[0].url = "http://127.0.0.1:1234/custom/v1/models".into();
        assert_eq!(plan_discovery(&profile, &profile.base_url), Ok(expected));
    }

    #[test]
    fn environment_override_never_retargets_an_existing_credential() {
        let profile = profile(ProviderKind::Actual);
        assert_eq!(
            plan_discovery(&profile, "https://different.example.test/v1"),
            Err(DomainError::CredentialTargetMismatch)
        );
    }

    #[test]
    fn stored_credential_reference_must_have_target_and_generation_binding() {
        let mut profile = profile(ProviderKind::Actual);
        profile.authentication = Authentication::ApiKey(CredentialReference {
            vault_id: "synthetic-reference".into(),
            generation: "".into(),
            bound_base_url: profile.base_url.clone(),
        });
        assert_eq!(
            plan_discovery(&profile, &profile.base_url),
            Err(DomainError::MissingCredential)
        );
        if let Authentication::ApiKey(reference) = &mut profile.authentication {
            reference.generation = "credential-1".into();
            reference.bound_base_url = "https://other.example.test/v1".into();
        }
        assert_eq!(
            plan_discovery(&profile, &profile.base_url),
            Err(DomainError::CredentialTargetMismatch)
        );
    }

    #[test]
    fn missing_or_control_contaminated_owner_environment_profile_and_revision_are_rejected() {
        let original = profile(ProviderKind::Actual);
        for field in ["owner", "environment", "profile", "revision"] {
            let mut profile = original.clone();
            match field {
                "owner" => profile.owner_id.clear(),
                "environment" => profile.environment_id = "server\nother".into(),
                "profile" => profile.profile_id.clear(),
                _ => profile.config_revision.clear(),
            }
            assert_eq!(
                plan_discovery(&profile, &profile.base_url),
                Err(DomainError::InvalidProfile),
                "{field}"
            );
        }
    }

    #[test]
    fn remote_actual_profile_cannot_use_explicit_none_mode() {
        let mut profile = profile(ProviderKind::Actual);
        profile.authentication = Authentication::None;
        assert_eq!(
            plan_discovery(&profile, &profile.base_url),
            Err(DomainError::NoAuthRequiresLoopback)
        );
    }

    #[test]
    fn cluster_header_rejects_controls_and_never_changes_the_url() {
        let mut profile = profile(ProviderKind::Actual);
        profile.cluster_id = Some("cluster\r\nAuthorization: unexpected".into());
        assert_eq!(
            plan_discovery(&profile, &profile.base_url),
            Err(DomainError::InvalidProfile)
        );
    }

    #[test]
    fn matching_receipt_is_accepted_without_ever_running_inference() {
        let plan = plan(ProviderKind::Actual);
        let receipt = receipt(&plan, InventoryKind::ActualModels, json!({"data":[]}));
        assert_eq!(validate_receipt_binding(&plan, &receipt), Ok(()));
    }

    #[test]
    fn receipts_from_another_owner_environment_revision_or_credential_generation_are_rejected() {
        let plan = plan(ProviderKind::Actual);
        let original = receipt(&plan, InventoryKind::ActualModels, json!({"data":[]}));
        for field in [
            "owner",
            "environment",
            "profile",
            "config",
            "credential",
            "generation",
            "cluster",
            "endpoint",
        ] {
            let mut receipt = original.clone();
            match field {
                "owner" => receipt.binding.owner_id = "another-owner".into(),
                "environment" => receipt.binding.environment_id = "another-host".into(),
                "profile" => receipt.binding.profile_id = "another-profile".into(),
                "config" => receipt.binding.config_revision = "config-2".into(),
                "credential" => receipt.binding.credential_id = Some("another-reference".into()),
                "generation" => receipt.binding.credential_generation = Some("credential-2".into()),
                "cluster" => receipt.binding.cluster_id = Some("another-cluster".into()),
                _ => receipt.binding.base_url = "https://another.example.test/v1".into(),
            }
            assert_eq!(
                validate_receipt_binding(&plan, &receipt),
                Err(DomainError::ReceiptBindingMismatch),
                "{field}"
            );
        }
    }

    #[test]
    fn response_effective_url_must_equal_the_planned_get_without_redirect_following() {
        let plan = plan(ProviderKind::Actual);
        let mut receipt = receipt(&plan, InventoryKind::ActualModels, json!({"data":[]}));
        receipt.effective_url = "https://redirect.example.test/v1/models".into();
        assert_eq!(
            validate_receipt_binding(&plan, &receipt),
            Err(DomainError::ReceiptTargetMismatch)
        );
    }

    #[test]
    fn receipt_kind_must_be_one_of_the_explicit_requests_on_this_plan() {
        let plan = plan(ProviderKind::Actual);
        let mut receipt = receipt(&plan, InventoryKind::ActualModels, json!({"data":[]}));
        receipt.kind = InventoryKind::LmStudioMetadata;
        assert_eq!(
            validate_receipt_binding(&plan, &receipt),
            Err(DomainError::ReceiptKindMismatch)
        );
    }

    #[test]
    fn endpoint_requires_an_explicit_versioned_base_and_respects_the_url_bound() {
        for input in [
            "https://example.test",
            "https:example.test/v1",
            "https://@example.test/v1",
            "https://example.test\\v1",
            "https://example.test/chat/completions",
            "https://example.test/v10",
            "https://example.test:0/v1",
            &format!("https://example.test/{}/v1", "x".repeat(2_048)),
        ] {
            assert_eq!(
                canonicalize_endpoint(input, ConnectionMode::CustomHttps),
                Err(DomainError::InvalidEndpoint)
            );
        }
    }

    #[test]
    fn none_auth_rechecks_the_url_instead_of_trusting_a_forged_loopback_flag() {
        let endpoint = Endpoint {
            base_url: "https://remote.example.test/v1".into(),
            verified_literal_loopback: true,
        };
        assert_eq!(
            validate_new_key(&endpoint, AuthMode::None, ""),
            Err(DomainError::NoAuthRequiresLoopback)
        );
    }

    #[test]
    fn lmstudio_local_token_is_bound_to_both_inventory_gets_with_canonical_target() {
        let mut profile = profile(ProviderKind::LmStudio);
        profile.authentication = Authentication::ApiKey(CredentialReference {
            vault_id: "local-token-reference".into(),
            generation: "local-token-generation".into(),
            bound_base_url: "http://127.0.0.1:1234/v1/".into(),
        });
        let discovered = plan_discovery(&profile, &profile.base_url).unwrap();
        assert_eq!(discovered.requests.len(), 2);
        assert_eq!(discovered.binding.auth_mode, AuthMode::ApiKey);
        assert!(discovered.requests.iter().all(|request| {
            request.method == InventoryMethod::Get
                && matches!(&request.credential, Some(reference)
                    if reference.bound_base_url == profile.base_url
                    && reference.generation == "local-token-generation")
        }));
    }

    #[test]
    fn actual_local_never_inherits_a_relay_credential_and_other_providers_have_no_relay_mode() {
        let mut actual = profile(ProviderKind::Actual);
        actual.mode = ConnectionMode::Local;
        actual.base_url = "http://127.0.0.1:8087/v1".into();
        assert_eq!(
            plan_discovery(&actual, &actual.base_url),
            Err(DomainError::UnexpectedCredential)
        );
        let mut generic = profile(ProviderKind::OpenAiCompatible);
        generic.mode = ConnectionMode::Relay;
        assert_eq!(
            plan_discovery(&generic, &generic.base_url),
            Err(DomainError::UnsupportedProviderMode)
        );
    }
}
