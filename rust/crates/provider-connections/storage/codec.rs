//! Private persistence bridges: parse DTO values, then validate domain invariants.
use crate::*;
use serde_json::{json, Value};

const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
pub(super) fn parse(text: &str) -> Result<Value> {
    if text.len() > MAX_RECORD_BYTES {
        return Err(Error::PersistenceFailed);
    }
    serde_json::from_str(text).map_err(|_| Error::PersistenceFailed)
}
pub(super) fn array(value: &Value, len: usize) -> Result<&Vec<Value>> {
    let values = value.as_array().ok_or(Error::PersistenceFailed)?;
    if values.len() != len {
        return Err(Error::PersistenceFailed);
    }
    Ok(values)
}
fn string(value: &Value) -> Result<String> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or(Error::PersistenceFailed)
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        Ok(Some(string(value)?))
    }
}
fn boolean(value: &Value) -> Result<bool> {
    value.as_bool().ok_or(Error::PersistenceFailed)
}
pub(super) fn kind_name(kind: ProfileKind) -> &'static str {
    match kind {
        ProfileKind::ActualRelay => "actual-relay",
        ProfileKind::ActualLocal => "actual-local",
        ProfileKind::LmStudioLocal => "lmstudio-local",
    }
}
fn kind(value: &Value) -> Result<ProfileKind> {
    match value.as_str() {
        Some("actual-relay") => Ok(ProfileKind::ActualRelay),
        Some("actual-local") => Ok(ProfileKind::ActualLocal),
        Some("lmstudio-local") => Ok(ProfileKind::LmStudioLocal),
        _ => Err(Error::PersistenceFailed),
    }
}
pub(super) fn transport_name(transport: Transport) -> &'static str {
    match transport {
        Transport::OpenAiResponses => "openai-responses",
        Transport::OpenAiChat => "openai-chat",
    }
}
fn transport(value: &Value) -> Result<Transport> {
    match value.as_str() {
        Some("openai-responses") => Ok(Transport::OpenAiResponses),
        Some("openai-chat") => Ok(Transport::OpenAiChat),
        _ => Err(Error::PersistenceFailed),
    }
}
pub(super) fn validate_binding(binding: &CredentialBinding) -> Result<()> {
    let target = &binding.target;
    validate_scope(&target.scope)?;
    validate_uuid(&target.profile_id)?;
    validate_uuid(&binding.id)?;
    validate_uuid(&binding.generation)?;
    if target.kind == ProfileKind::ActualLocal {
        return Err(Error::UnexpectedCredential);
    }
    let endpoint = canonical_target(target.kind, &target.base_url)?;
    if endpoint.base_url != target.base_url || target.transport != transport_for(target.kind) {
        return Err(Error::CredentialBindingMismatch);
    }
    Ok(())
}
pub(super) fn binding_value(binding: &CredentialBinding) -> Value {
    json!([
        "v4.provider-credential-binding.v1",
        binding.target.scope.owner_id,
        binding.target.scope.environment_id,
        binding.target.profile_id,
        kind_name(binding.target.kind),
        binding.target.base_url,
        transport_name(binding.target.transport),
        binding.id,
        binding.generation
    ])
}
pub(super) fn binding(value: &Value) -> Result<CredentialBinding> {
    let a = array(value, 9)?;
    if a[0] != "v4.provider-credential-binding.v1" {
        return Err(Error::PersistenceFailed);
    }
    let result = CredentialBinding {
        id: string(&a[7])?,
        generation: string(&a[8])?,
        target: CredentialTarget {
            scope: Scope {
                owner_id: string(&a[1])?,
                environment_id: string(&a[2])?,
            },
            profile_id: string(&a[3])?,
            kind: kind(&a[4])?,
            base_url: string(&a[5])?,
            transport: transport(&a[6])?,
        },
    };
    validate_binding(&result)?;
    Ok(result)
}
pub(crate) fn profile_value(profile: &StoredProfile) -> Value {
    let auth = match &profile.auth {
        StoredAuth::None => json!(["none"]),
        StoredAuth::Bearer(value) => json!(["bearer", binding_value(value)]),
    };
    json!([
        "v4.provider-profile.v1",
        profile.scope.owner_id,
        profile.scope.environment_id,
        profile.id,
        profile.revision,
        kind_name(profile.kind),
        profile.base_url,
        transport_name(profile.transport),
        auth,
        profile.cluster_id,
        if profile.activation == Activation::Ready {
            "ready"
        } else {
            "cleanup-pending"
        }
    ])
}
pub(crate) fn profile(value: &Value) -> Result<StoredProfile> {
    let a = array(value, 11)?;
    if a[0] != "v4.provider-profile.v1" {
        return Err(Error::PersistenceFailed);
    }
    let auth = a[8].as_array().ok_or(Error::PersistenceFailed)?;
    let auth = match auth.as_slice() {
        [Value::String(mode)] if mode == "none" => StoredAuth::None,
        [Value::String(mode), value] if mode == "bearer" => StoredAuth::Bearer(binding(value)?),
        _ => return Err(Error::PersistenceFailed),
    };
    let profile = StoredProfile {
        scope: Scope {
            owner_id: string(&a[1])?,
            environment_id: string(&a[2])?,
        },
        id: string(&a[3])?,
        revision: string(&a[4])?,
        kind: kind(&a[5])?,
        base_url: string(&a[6])?,
        transport: transport(&a[7])?,
        auth,
        cluster_id: optional(&a[9])?,
        activation: match a[10].as_str() {
            Some("ready") => Activation::Ready,
            Some("cleanup-pending") => Activation::CleanupPending,
            _ => return Err(Error::PersistenceFailed),
        },
    };
    validate_profile(&profile)?;
    Ok(profile)
}
pub(super) fn reference_value(reference: &ConnectionRef) -> Value {
    json!([
        "v4.connection-ref.v1",
        reference.scope.owner_id,
        reference.scope.environment_id,
        reference.profile_id,
        reference.revision,
        reference.credential_id,
        reference.credential_generation
    ])
}
pub(super) fn reference(value: &Value) -> Result<ConnectionRef> {
    let a = array(value, 7)?;
    if a[0] != "v4.connection-ref.v1" {
        return Err(Error::PersistenceFailed);
    }
    let reference = ConnectionRef {
        scope: Scope {
            owner_id: string(&a[1])?,
            environment_id: string(&a[2])?,
        },
        profile_id: string(&a[3])?,
        revision: string(&a[4])?,
        credential_id: optional(&a[5])?,
        credential_generation: optional(&a[6])?,
    };
    validate_scope(&reference.scope)?;
    let mut set = RevocationSet::default();
    set.add_connection(&reference, &[]);
    set.validate(&reference.scope, &reference.profile_id)?;
    Ok(reference)
}
pub(super) fn revocations_value(set: &RevocationSet) -> Value {
    json!([
        "v4.revocation-set.v1",
        set.targets
            .iter()
            .map(|target| json!([
                reference_value(&target.connection),
                target
                    .leases
                    .iter()
                    .map(|lease| json!([lease.actor_id, lease.process_instance_id, lease.lease_id]))
                    .collect::<Vec<_>>()
            ]))
            .collect::<Vec<_>>()
    ])
}
pub(super) fn revocations(value: &Value, scope: &Scope, profile_id: &str) -> Result<RevocationSet> {
    validate_scope(scope)?;
    validate_uuid(profile_id)?;
    let a = array(value, 2)?;
    if a[0] != "v4.revocation-set.v1" {
        return Err(Error::PersistenceFailed);
    }
    let mut targets = vec![];
    for value in a[1].as_array().ok_or(Error::PersistenceFailed)? {
        let target = array(value, 2)?;
        let connection = reference(&target[0])?;
        let mut leases = vec![];
        for value in target[1].as_array().ok_or(Error::PersistenceFailed)? {
            let a = array(value, 3)?;
            leases.push(RequiredLeaseIdentity {
                actor_id: string(&a[0])?,
                process_instance_id: string(&a[1])?,
                lease_id: string(&a[2])?,
            });
        }
        targets.push(RevocationTarget { connection, leases });
    }
    let result = RevocationSet { targets };
    result.validate(scope, profile_id)?;
    Ok(result)
}
pub(super) fn receipt_value(receipt: &ConfigReceipt) -> Value {
    json!({"version":1,"operationId":receipt.operation_id,"profileId":receipt.profile_id,"savedRevision":receipt.saved_revision,"settingsSaved":receipt.settings_saved,
    "cleanupConfirmed":receipt.cleanup_confirmed,"deleted":receipt.deleted,"superseded":receipt.superseded,"profile":receipt.profile})
}
fn validate_public_profile(
    value: &Value,
    scope: &Scope,
    profile_id: &str,
    revision: &str,
) -> Result<()> {
    let object = value.as_object().ok_or(Error::PersistenceFailed)?;
    let keys = [
        "profileId",
        "provider",
        "mode",
        "revision",
        "executionEnvironmentId",
        "baseUrl",
        "transport",
        "authMode",
        "credentialState",
        "clusterId",
        "activation",
        "inferenceVerified",
    ];
    if object.len() != keys.len() || object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(Error::PersistenceFailed);
    }
    if value["profileId"] != profile_id
        || value["revision"] != revision
        || value["executionEnvironmentId"] != scope.environment_id
        || value["inferenceVerified"] != false
    {
        return Err(Error::PersistenceFailed);
    }
    let kind = match (value["provider"].as_str(), value["mode"].as_str()) {
        (Some("actual"), Some("relay")) => ProfileKind::ActualRelay,
        (Some("actual"), Some("local")) => ProfileKind::ActualLocal,
        (Some("lmstudio"), Some("local")) => ProfileKind::LmStudioLocal,
        _ => return Err(Error::PersistenceFailed),
    };
    let base = string(&value["baseUrl"])?;
    if canonical_target(kind, &base)?.base_url != base
        || value["transport"] != transport_name(transport_for(kind))
    {
        return Err(Error::PersistenceFailed);
    }
    match (
        value["authMode"].as_str(),
        value["credentialState"].as_str(),
    ) {
        (Some("none"), Some("not-required")) if kind != ProfileKind::ActualRelay => {}
        (Some("bearer"), Some("configured")) if kind != ProfileKind::ActualLocal => {}
        _ => return Err(Error::PersistenceFailed),
    }
    if !matches!(
        value["activation"].as_str(),
        Some("ready") | Some("cleanup-pending")
    ) {
        return Err(Error::PersistenceFailed);
    }
    if let Some(cluster) = optional(&value["clusterId"])? {
        if kind == ProfileKind::LmStudioLocal
            || cluster.trim().is_empty()
            || cluster.len() > 200
            || cluster.chars().any(char::is_control)
        {
            return Err(Error::PersistenceFailed);
        }
    }
    Ok(())
}
pub(super) fn receipt(value: &Value, scope: &Scope) -> Result<ConfigReceipt> {
    validate_scope(scope)?;
    let object = value.as_object().ok_or(Error::PersistenceFailed)?;
    let keys = [
        "version",
        "operationId",
        "profileId",
        "savedRevision",
        "settingsSaved",
        "cleanupConfirmed",
        "deleted",
        "superseded",
        "profile",
    ];
    if object.len() != keys.len()
        || object.keys().any(|key| !keys.contains(&key.as_str()))
        || value["version"] != 1
    {
        return Err(Error::PersistenceFailed);
    }
    let result = ConfigReceipt {
        operation_id: string(&value["operationId"])?,
        profile_id: string(&value["profileId"])?,
        saved_revision: string(&value["savedRevision"])?,
        settings_saved: boolean(&value["settingsSaved"])?,
        cleanup_confirmed: boolean(&value["cleanupConfirmed"])?,
        deleted: boolean(&value["deleted"])?,
        superseded: boolean(&value["superseded"])?,
        profile: if value["profile"].is_null() {
            None
        } else {
            Some(value["profile"].clone())
        },
    };
    for id in [
        &result.operation_id,
        &result.profile_id,
        &result.saved_revision,
    ] {
        validate_uuid(id)?;
    }
    if !result.settings_saved || result.deleted != result.profile.is_none() {
        return Err(Error::PersistenceFailed);
    }
    if let Some(value) = &result.profile {
        validate_public_profile(value, scope, &result.profile_id, &result.saved_revision)?;
    }
    Ok(result)
}
