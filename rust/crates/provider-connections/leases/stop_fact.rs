//! Authenticated history of a prior accepted join. It grants no live authority.
use super::*;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};
pub(crate) const KEY_DOMAIN: &[u8] = b"v4.provider-stop-fact-key.v1";
pub(super) const FACT_DOMAIN: &str = "v4.provider-stop-fact.v1";
pub(super) const ENVELOPE_DOMAIN: &str = "v4.provider-stop-fact-envelope.v1";
pub(crate) struct StopFactMac {
    key: Zeroizing<[u8; 32]>,
}
pub(crate) struct SignedPriorStopFact {
    pub(super) encoded: String,
}
pub(crate) struct PriorAcceptedStopFact {
    reference: ConnectionRef,
    identity: LeaseIdentity,
    admission_generation: u64,
    observation_nonce: String,
    kind: ObservationKind,
}
fn invalid<T>(_: T) -> LeaseError {
    LeaseError::InvalidEvidence
}
fn text(value: &Value) -> LeaseResult<String> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or(LeaseError::InvalidEvidence)
}
fn valid_reference(reference: &ConnectionRef) -> LeaseResult<()> {
    validate_scope(&reference.scope).map_err(invalid)?;
    validate_uuid(&reference.profile_id).map_err(invalid)?;
    validate_uuid(&reference.revision).map_err(invalid)?;
    match (&reference.credential_id, &reference.credential_generation) {
        (None, None) => Ok(()),
        (Some(id), Some(generation)) => {
            validate_uuid(id).map_err(invalid)?;
            validate_uuid(generation).map_err(invalid)
        }
        _ => Err(LeaseError::InvalidEvidence),
    }
}
fn valid_identity(identity: &LeaseIdentity, generation: u64) -> LeaseResult<()> {
    for id in [
        &identity.actor_id,
        &identity.process_instance_id,
        &identity.lease_id,
    ] {
        validate_uuid(id).map_err(invalid)?;
    }
    if generation == 0 || generation > i64::MAX as u64 {
        return Err(LeaseError::InvalidEvidence);
    }
    Ok(())
}
fn reference_value(reference: &ConnectionRef) -> Value {
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
fn reference(value: &Value) -> LeaseResult<ConnectionRef> {
    let a = value
        .as_array()
        .filter(|a| a.len() == 7)
        .ok_or(LeaseError::InvalidEvidence)?;
    if a[0] != "v4.connection-ref.v1" {
        return Err(LeaseError::InvalidEvidence);
    }
    let optional = |v: &Value| {
        if v.is_null() {
            Ok(None)
        } else {
            text(v).map(Some)
        }
    };
    let result = ConnectionRef {
        scope: Scope {
            owner_id: text(&a[1])?,
            environment_id: text(&a[2])?,
        },
        profile_id: text(&a[3])?,
        revision: text(&a[4])?,
        credential_id: optional(&a[5])?,
        credential_generation: optional(&a[6])?,
    };
    valid_reference(&result)?;
    Ok(result)
}
fn kind_name(kind: ObservationKind) -> &'static str {
    match kind {
        ObservationKind::ContractPortJoin => "contract-port-join",
        ObservationKind::SyntheticChildExit => "synthetic-child-exit",
    }
}
impl StopFactMac {
    pub(crate) fn from_private_feature_key(master: Option<&[u8; 32]>) -> LeaseResult<Self> {
        let master = master.ok_or(LeaseError::KeyUnavailable)?;
        let mut derivation = <Hmac<Sha256> as Mac>::new_from_slice(master).map_err(invalid)?;
        derivation.update(KEY_DOMAIN);
        let mut digest = derivation.finalize().into_bytes();
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&digest);
        for byte in digest.iter_mut() {
            byte.zeroize();
        }
        Ok(Self { key })
    }
    pub(crate) fn authenticate_accepted(
        &self,
        accepted: &AcceptedStopObservation,
    ) -> LeaseResult<SignedPriorStopFact> {
        valid_reference(&accepted.reference)?;
        valid_identity(&accepted.identity, accepted.admission_generation)?;
        validate_uuid(&accepted.observation_nonce).map_err(invalid)?;
        let record = json!([
            FACT_DOMAIN,
            reference_value(&accepted.reference),
            [
                accepted.identity.actor_id,
                accepted.identity.process_instance_id,
                accepted.identity.lease_id
            ],
            accepted.admission_generation,
            accepted.observation_nonce,
            kind_name(accepted.kind)
        ]);
        let bytes = serde_json::to_vec(&record).map_err(invalid)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&*self.key).map_err(invalid)?;
        mac.update(&bytes);
        let encoded = serde_json::to_string(&json!([
            ENVELOPE_DOMAIN,
            record,
            hex::encode(mac.finalize().into_bytes())
        ]))
        .map_err(invalid)?;
        if encoded.len() > 65536 {
            return Err(LeaseError::InvalidEvidence);
        }
        Ok(SignedPriorStopFact { encoded })
    }
    pub(crate) fn verify_prior(
        &self,
        encoded: &str,
        expected: &ConnectionRef,
        identity: &LeaseIdentity,
        generation: u64,
    ) -> LeaseResult<PriorAcceptedStopFact> {
        valid_reference(expected)?;
        valid_identity(identity, generation)?;
        if encoded.len() > 65536 {
            return Err(LeaseError::InvalidEvidence);
        }
        let value: Value = serde_json::from_str(encoded).map_err(invalid)?;
        let a = value
            .as_array()
            .filter(|a| a.len() == 3)
            .ok_or(LeaseError::InvalidEvidence)?;
        if a[0] != ENVELOPE_DOMAIN {
            return Err(LeaseError::InvalidEvidence);
        }
        let tag = a[2]
            .as_str()
            .filter(|t| {
                t.len() == 64
                    && t.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or(LeaseError::InvalidEvidence)?;
        let tag = hex::decode(tag).map_err(invalid)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&*self.key).map_err(invalid)?;
        mac.update(&serde_json::to_vec(&a[1]).map_err(invalid)?);
        mac.verify_slice(&tag).map_err(invalid)?;
        let r = a[1]
            .as_array()
            .filter(|r| r.len() == 6)
            .ok_or(LeaseError::InvalidEvidence)?;
        if r[0] != FACT_DOMAIN {
            return Err(LeaseError::InvalidEvidence);
        }
        let reference = reference(&r[1])?;
        let ids = r[2]
            .as_array()
            .filter(|a| a.len() == 3)
            .ok_or(LeaseError::InvalidEvidence)?;
        let actual = LeaseIdentity {
            actor_id: text(&ids[0])?,
            process_instance_id: text(&ids[1])?,
            lease_id: text(&ids[2])?,
        };
        let actual_generation = r[3].as_u64().ok_or(LeaseError::InvalidEvidence)?;
        valid_identity(&actual, actual_generation)?;
        let observation_nonce = text(&r[4])?;
        validate_uuid(&observation_nonce).map_err(invalid)?;
        let kind = match r[5].as_str() {
            Some("contract-port-join") => ObservationKind::ContractPortJoin,
            Some("synthetic-child-exit") => ObservationKind::SyntheticChildExit,
            _ => return Err(LeaseError::InvalidEvidence),
        };
        if reference != *expected || actual != *identity || actual_generation != generation {
            return Err(LeaseError::InvalidEvidence);
        }
        Ok(PriorAcceptedStopFact {
            reference,
            identity: actual,
            admission_generation: actual_generation,
            observation_nonce,
            kind,
        })
    }
}
#[cfg(test)]
mod tests;
