use super::*;
use crate::fixtures::*;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

fn accepted() -> AcceptedStopObservation {
    AcceptedStopObservation {
        reference: reference_for(&profile(ProfileKind::ActualRelay)),
        identity: LeaseIdentity {
            actor_id: "70000000-0000-4000-8000-000000000001".into(),
            process_instance_id: "80000000-0000-4000-8000-000000000001".into(),
            lease_id: "90000000-0000-4000-8000-000000000001".into(),
        },
        admission_generation: 7,
        observation_nonce: "a0000000-0000-4000-8000-000000000001".into(),
        kind: ObservationKind::SyntheticChildExit,
    }
}
fn mac() -> StopFactMac {
    StopFactMac::from_private_feature_key(Some(&[7; 32])).unwrap()
}
fn vector() -> Value {
    serde_json::from_str(include_str!("../stop-fact-vector.json")).unwrap()
}
fn encoded() -> String {
    vector()["envelopeUTF8"].as_str().unwrap().into()
}
fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}
fn resign(record: Value, domain: &[u8]) -> String {
    let key = hmac(&[7; 32], domain);
    let tag = hex::encode(hmac(&key, &serde_json::to_vec(&record).unwrap()));
    serde_json::to_string(&json!([ENVELOPE_DOMAIN, record, tag])).unwrap()
}

#[test]
fn fixed_prior_accepted_fact_vector_matches_independent_canonical_bytes_and_tag() {
    let authenticator = mac();
    let observation = accepted();
    let signed = authenticator.authenticate_accepted(&observation).unwrap();
    assert_eq!(signed.encoded, encoded());
    let outer: Value = serde_json::from_str(&signed.encoded).unwrap();
    assert_eq!(
        serde_json::to_string(&outer[1]).unwrap(),
        vector()["canonicalRecordUTF8"].as_str().unwrap()
    );
    assert_eq!(outer[2], vector()["expectedTagHex"]);
    let prior = authenticator
        .verify_prior(
            &signed.encoded,
            &observation.reference,
            &observation.identity,
            observation.admission_generation,
        )
        .unwrap();
    assert_eq!(prior.reference, observation.reference);
    assert_eq!(prior.identity, observation.identity);
    assert_eq!(prior.admission_generation, 7);
    assert_eq!(prior.observation_nonce, observation.observation_nonce);
    assert_eq!(prior.kind, ObservationKind::SyntheticChildExit);
}

#[test]
fn every_authenticated_fact_field_rejects_one_field_tamper_without_other_changes() {
    let authenticator = mac();
    let expected = accepted();
    for field in [
        "fact-domain",
        "reference-domain",
        "owner",
        "environment",
        "profile",
        "revision",
        "credential",
        "credential-generation",
        "actor",
        "boot",
        "lease",
        "admission-generation",
        "nonce",
        "kind",
    ] {
        let mut packet: Value = serde_json::from_str(&encoded()).unwrap();
        match field {
            "fact-domain" => packet[1][0] = json!("different-domain"),
            "reference-domain" => packet[1][1][0] = json!("v4.connection-ref.v0"),
            "owner" => packet[1][1][1] = json!("other-owner"),
            "environment" => packet[1][1][2] = json!("other-server"),
            "profile" => packet[1][1][3] = json!(NEXT_REVISION),
            "revision" => packet[1][1][4] = json!(NEXT_REVISION),
            "credential" => packet[1][1][5] = json!(NEXT_CREDENTIAL),
            "credential-generation" => packet[1][1][6] = json!(NEXT_GENERATION),
            "actor" => packet[1][2][0] = json!(REQUEST),
            "boot" => packet[1][2][1] = json!(REQUEST),
            "lease" => packet[1][2][2] = json!(REQUEST),
            "admission-generation" => packet[1][3] = json!(8),
            "nonce" => packet[1][4] = json!(REQUEST),
            _ => packet[1][5] = json!("contract-port-join"),
        }
        assert_eq!(
            authenticator
                .verify_prior(
                    &serde_json::to_string(&packet).unwrap(),
                    &expected.reference,
                    &expected.identity,
                    7
                )
                .err(),
            Some(LeaseError::InvalidEvidence),
            "{field}"
        );
    }
    assert!(authenticator
        .verify_prior(&encoded(), &expected.reference, &expected.identity, 7)
        .is_ok());
}

#[test]
fn valid_fact_cannot_replay_under_another_exact_reference_tuple_or_generation() {
    let authenticator = mac();
    let original = accepted();
    for field in [
        "owner",
        "environment",
        "profile",
        "revision",
        "credential",
        "generation",
        "half-id",
        "half-generation",
        "actor",
        "boot",
        "lease",
        "admission",
    ] {
        let mut expected = accepted();
        match field {
            "owner" => expected.reference.scope.owner_id = "other".into(),
            "environment" => expected.reference.scope.environment_id = "other".into(),
            "profile" => expected.reference.profile_id = NEXT_REVISION.into(),
            "revision" => expected.reference.revision = NEXT_REVISION.into(),
            "credential" => expected.reference.credential_id = Some(NEXT_CREDENTIAL.into()),
            "generation" => expected.reference.credential_generation = Some(NEXT_GENERATION.into()),
            "half-id" => expected.reference.credential_id = None,
            "half-generation" => expected.reference.credential_generation = None,
            "actor" => expected.identity.actor_id = REQUEST.into(),
            "boot" => expected.identity.process_instance_id = REQUEST.into(),
            "lease" => expected.identity.lease_id = REQUEST.into(),
            _ => expected.admission_generation += 1,
        }
        assert_eq!(
            authenticator
                .verify_prior(
                    &encoded(),
                    &expected.reference,
                    &expected.identity,
                    expected.admission_generation
                )
                .err(),
            Some(LeaseError::InvalidEvidence),
            "{field}"
        );
    }
    assert!(authenticator
        .verify_prior(&encoded(), &original.reference, &original.identity, 7)
        .is_ok());
}

#[test]
fn wrong_private_feature_key_never_verifies_a_prior_accepted_fact() {
    let wrong = StopFactMac::from_private_feature_key(Some(&[8; 32])).unwrap();
    let expected = accepted();
    assert_eq!(
        wrong
            .verify_prior(&encoded(), &expected.reference, &expected.identity, 7)
            .err(),
        Some(LeaseError::InvalidEvidence)
    );
}

#[test]
fn absent_private_feature_key_fails_closed_without_creating_authentication_state() {
    assert_eq!(
        StopFactMac::from_private_feature_key(None).err(),
        Some(LeaseError::KeyUnavailable)
    );
}

#[test]
fn mutation_aes_verifier_and_raw_master_domains_cannot_authenticate_stop_facts() {
    let authenticator = mac();
    let expected = accepted();
    let packet: Value = serde_json::from_str(&encoded()).unwrap();
    for domain in [
        b"v4.provider-connections.mutation-key.v1".as_slice(),
        b"v4.provider-connections.aes256gcm.v1",
        b"v4.provider-connections.key-verifier.v1",
    ] {
        let foreign = resign(packet[1].clone(), domain);
        assert_eq!(
            authenticator
                .verify_prior(&foreign, &expected.reference, &expected.identity, 7)
                .err(),
            Some(LeaseError::InvalidEvidence)
        );
    }
    let tag = hex::encode(hmac(&[7; 32], &serde_json::to_vec(&packet[1]).unwrap()));
    let foreign = serde_json::to_string(&json!([ENVELOPE_DOMAIN, packet[1], tag])).unwrap();
    assert_eq!(
        authenticator
            .verify_prior(&foreign, &expected.reference, &expected.identity, 7)
            .err(),
        Some(LeaseError::InvalidEvidence)
    );
}

#[test]
fn signed_but_malformed_unknown_or_half_present_fact_records_are_rejected() {
    let authenticator = mac();
    let expected = accepted();
    let base: Value = serde_json::from_str(&encoded()).unwrap();
    let mut records = vec![];
    let mut value = base[1].clone();
    value[1][5] = Value::Null;
    records.push(value);
    let mut value = base[1].clone();
    value[1][6] = Value::Null;
    records.push(value);
    let mut value = base[1].clone();
    value[3] = json!(0);
    records.push(value);
    let mut value = base[1].clone();
    value[3] = json!(-1);
    records.push(value);
    let mut value = base[1].clone();
    value[4] = json!("not-a-nonce");
    records.push(value);
    let mut value = base[1].clone();
    value[5] = json!("unverified-public-boolean");
    records.push(value);
    let mut value = base[1].clone();
    value.as_array_mut().unwrap().push(json!("unknown-field"));
    records.push(value);
    for record in records {
        let signed = resign(record, KEY_DOMAIN);
        assert_eq!(
            authenticator
                .verify_prior(&signed, &expected.reference, &expected.identity, 7)
                .err(),
            Some(LeaseError::InvalidEvidence)
        );
    }
    for malformed in [String::new(), "{}".into(), "[]".into(), "x".repeat(65537)] {
        assert_eq!(
            authenticator
                .verify_prior(&malformed, &expected.reference, &expected.identity, 7)
                .err(),
            Some(LeaseError::InvalidEvidence)
        );
    }
}

#[test]
fn explicit_none_fact_keeps_both_credential_fields_null_and_never_infers_a_bearer() {
    let authenticator = mac();
    let mut observation = accepted();
    observation.reference.credential_id = None;
    observation.reference.credential_generation = None;
    let signed = authenticator.authenticate_accepted(&observation).unwrap();
    let packet: Value = serde_json::from_str(&signed.encoded).unwrap();
    assert!(packet[1][1][5].is_null() && packet[1][1][6].is_null());
    let prior = authenticator
        .verify_prior(
            &signed.encoded,
            &observation.reference,
            &observation.identity,
            7,
        )
        .unwrap();
    assert_eq!(prior.reference, observation.reference);
}

#[test]
fn envelope_version_mac_shape_and_mac_bytes_are_authenticated_without_coercion() {
    let authenticator = mac();
    let expected = accepted();
    let base: Value = serde_json::from_str(&encoded()).unwrap();
    for field in [
        "version",
        "short-tag",
        "nonhex-tag",
        "different-tag",
        "extra-field",
        "null-tag",
    ] {
        let mut packet = base.clone();
        match field {
            "version" => packet[0] = json!("v4.provider-stop-fact-envelope.v0"),
            "short-tag" => packet[2] = json!("00"),
            "nonhex-tag" => packet[2] = json!("g".repeat(64)),
            "different-tag" => packet[2] = json!("0".repeat(64)),
            "extra-field" => packet.as_array_mut().unwrap().push(json!("extra")),
            _ => packet[2] = Value::Null,
        }
        assert_eq!(
            authenticator
                .verify_prior(
                    &serde_json::to_string(&packet).unwrap(),
                    &expected.reference,
                    &expected.identity,
                    7
                )
                .err(),
            Some(LeaseError::InvalidEvidence),
            "{field}"
        );
    }
}

#[test]
fn signed_malformed_reference_pairs_and_zero_generation_fail_even_when_expected_binding_matches() {
    let authenticator = mac();
    let original = accepted();
    let base: Value = serde_json::from_str(&encoded()).unwrap();
    for field in ["half-id", "half-generation", "zero-generation"] {
        let mut expected = accepted();
        let mut record = base[1].clone();
        match field {
            "half-id" => {
                expected.reference.credential_id = None;
                record[1][5] = Value::Null;
            }
            "half-generation" => {
                expected.reference.credential_generation = None;
                record[1][6] = Value::Null;
            }
            _ => {
                expected.admission_generation = 0;
                record[3] = json!(0);
            }
        }
        let signed = resign(record, KEY_DOMAIN);
        assert_eq!(
            authenticator
                .verify_prior(
                    &signed,
                    &expected.reference,
                    &expected.identity,
                    expected.admission_generation
                )
                .err(),
            Some(LeaseError::InvalidEvidence),
            "{field}:matchingmalformedexpectedmustnotmaskstructuralvalidation"
        );
        assert_eq!(
            authenticator.authenticate_accepted(&expected).err(),
            Some(LeaseError::InvalidEvidence),
            "{field}:signermustalsorejectmalformedtypedfixture"
        );
    }
    assert!(authenticator
        .verify_prior(
            &encoded(),
            &original.reference,
            &original.identity,
            original.admission_generation
        )
        .is_ok());
}
