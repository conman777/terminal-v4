use super::*;
use crate::fixtures::*;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use zeroize::Zeroizing;

fn master(byte: u8) -> PrivateKey {
    PrivateKey(Zeroizing::new([byte; 32]))
}
fn crypto() -> CryptoAdapter {
    CryptoAdapter::from_master(&master(7)).unwrap()
}
fn payload() -> CredentialPayload {
    CredentialPayload {
        binding: binding(&profile(ProfileKind::ActualRelay)),
        secret: synthetic_secret(),
    }
}
fn encrypted(adapter: &mut CryptoAdapter) -> EncryptedCredential {
    let payload = payload();
    let sealed = adapter.seal(&payload).unwrap();
    EncryptedCredential {
        binding: payload.binding,
        sealed,
    }
}
fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}
fn binding_value(binding: &CredentialBinding) -> Value {
    json!([
        "v4.provider-credential-binding.v1",
        binding.target.scope.owner_id,
        binding.target.scope.environment_id,
        binding.target.profile_id,
        "actual-relay",
        binding.target.base_url,
        "openai-responses",
        binding.id,
        binding.generation
    ])
}
fn externally_sealed(binding: CredentialBinding, plaintext: &[u8]) -> EncryptedCredential {
    let derived = hmac(&[7; 32], ENCRYPTION_DOMAIN);
    let cipher = Aes256Gcm::new_from_slice(&derived).unwrap();
    let nonce_bytes = [3u8; 12];
    let aad = serde_json::to_vec(&binding_value(&binding)).unwrap();
    let ciphertext = cipher
        .encrypt(
            &nonce_bytes.into(),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .unwrap();
    EncryptedCredential {
        binding,
        sealed: SealedSecret(format!(
            "enc:v1:{}:{}",
            hex::encode(nonce_bytes),
            hex::encode(ciphertext)
        )),
    }
}

#[test]
fn aes_round_trip_has_versioned_ciphertext_without_plaintext_and_authenticates_binding() {
    let mut adapter = crypto();
    let row = encrypted(&mut adapter);
    validate_ciphertext(&row.sealed).unwrap();
    assert!(!row.sealed.0.contains("synthetic-test-token"));
    assert_eq!(row.sealed.0.split(':').nth(2).unwrap().len(), 24);
    let opened = adapter.open(&row).unwrap();
    assert_eq!(opened.binding, row.binding);
    assert_eq!(opened.secret.expose_for_adapter(), "synthetic-test-token");
}

#[test]
fn each_seal_uses_a_new_nonce_even_for_identical_binding_and_secret() {
    let mut adapter = crypto();
    let first = encrypted(&mut adapter);
    let second = encrypted(&mut adapter);
    assert!(first.sealed.0.split(':').nth(2) != second.sealed.0.split(':').nth(2));
    assert!(first.sealed != second.sealed);
    adapter.open(&first).unwrap();
    adapter.open(&second).unwrap();
}

#[test]
fn a_different_private_master_cannot_decrypt_existing_ciphertext() {
    let mut adapter = crypto();
    let row = encrypted(&mut adapter);
    let mut other = CryptoAdapter::from_master(&master(9)).unwrap();
    assert_eq!(other.open(&row).err(), Some(Error::InvalidCredential));
}

#[test]
fn changing_any_row_binding_field_cannot_replay_authenticated_ciphertext() {
    let mut adapter = crypto();
    let row = encrypted(&mut adapter);
    for field in [
        "owner",
        "environment",
        "profile",
        "kind",
        "endpoint",
        "transport",
        "credential",
        "generation",
    ] {
        let mut changed = row.clone();
        match field {
            "owner" => changed.binding.target.scope.owner_id = "other-owner".into(),
            "environment" => changed.binding.target.scope.environment_id = "other-server".into(),
            "profile" => {
                changed.binding.target.profile_id = "10000000-0000-4000-8000-000000000009".into()
            }
            "kind" => changed.binding.target.kind = ProfileKind::LmStudioLocal,
            "endpoint" => changed.binding.target.base_url = "https://other.example.test/v1".into(),
            "transport" => changed.binding.target.transport = Transport::OpenAiChat,
            "credential" => changed.binding.id = NEXT_CREDENTIAL.into(),
            _ => changed.binding.generation = NEXT_GENERATION.into(),
        }
        assert_eq!(adapter.open(&changed).err(), Some(Error::InvalidCredential));
    }
}

#[test]
fn malformed_plaintext_unknown_versions_and_short_envelopes_are_never_decrypted_as_keys() {
    let mut adapter = crypto();
    let original = encrypted(&mut adapter);
    for raw in [
        "plaintext-token",
        "enc:v0:00:00",
        "enc:v1:00:00",
        "enc:v1:zzzzzzzzzzzzzzzzzzzzzzzz:00000000000000000000000000000000",
    ] {
        let mut row = original.clone();
        row.sealed = SealedSecret(raw.into());
        assert_eq!(
            adapter.open(&row).err(),
            Some(Error::EncryptedCredentialRequired)
        );
    }
}

#[test]
fn changing_valid_hex_nonce_or_tag_produces_a_sanitized_authentication_failure() {
    let mut adapter = crypto();
    let original = encrypted(&mut adapter);
    for nonce in [true, false] {
        let mut parts = original
            .sealed
            .0
            .split(':')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let index = if nonce { 2 } else { 3 };
        let last = parts[index].pop().unwrap();
        parts[index].push(if last == '0' { '1' } else { '0' });
        let mut row = original.clone();
        row.sealed = SealedSecret(parts.join(":"));
        assert_eq!(adapter.open(&row).err(), Some(Error::InvalidCredential));
    }
}

#[test]
fn authenticated_non_utf8_unknown_payload_fields_or_wrong_binding_fail_closed() {
    let mut adapter = crypto();
    let binding = binding(&profile(ProfileKind::ActualRelay));
    let valid =
        json!({"version":1,"binding":binding_value(&binding),"secret":"synthetic-test-token"});
    let mut extra = valid.clone();
    extra["unexpected"] = json!(true);
    let mut wrong = valid.clone();
    wrong["binding"][1] = json!("other-owner");
    let mut version = valid.clone();
    version["version"] = json!(2);
    for bytes in [
        vec![255, 254],
        serde_json::to_vec(&extra).unwrap(),
        serde_json::to_vec(&wrong).unwrap(),
        serde_json::to_vec(&version).unwrap(),
    ] {
        assert_eq!(
            adapter
                .open(&externally_sealed(binding.clone(), &bytes))
                .err(),
            Some(Error::InvalidCredential)
        );
    }
}

#[test]
fn independently_encoded_valid_aead_envelope_uses_documented_domain_and_payload_schema() {
    let mut adapter = crypto();
    let binding = binding(&profile(ProfileKind::ActualRelay));
    let bytes = serde_json::to_vec(
        &json!({"version":1,"binding":binding_value(&binding),"secret":"synthetic-test-token"}),
    )
    .unwrap();
    let opened = adapter.open(&externally_sealed(binding, &bytes)).unwrap();
    assert_eq!(opened.secret.expose_for_adapter(), "synthetic-test-token");
}

#[test]
fn mutation_tag_matches_keyed_domain_separated_exact_parsed_payload_vector() {
    let mut adapter = crypto();
    let request = ConfigMutation::Put(update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    ));
    let bytes = serde_json::to_vec(&json!([
        "v4.provider-mutation.v1",
        "synthetic-owner",
        "synthetic-execution-server",
        "put",
        OPERATION,
        PROFILE,
        null,
        "actual-relay",
        "https://api.actual.inc/v1",
        null,
        "replace-bearer",
        "synthetic-test-token"
    ]))
    .unwrap();
    let derived = hmac(&[7; 32], MUTATION_KEY_DOMAIN);
    let expected = hex::encode(hmac(&derived, &bytes));
    assert!(adapter.tag(&scope(), &request).unwrap().0 == expected);
}

#[test]
fn exact_input_endpoint_secret_revision_auth_action_cluster_and_scope_change_private_tag() {
    let mut adapter = crypto();
    let original = adapter
        .tag(
            &scope(),
            &ConfigMutation::Put(update(
                ProfileKind::ActualRelay,
                AuthChange::ReplaceBearer(synthetic_secret()),
            )),
        )
        .unwrap();
    for field in [
        "operation",
        "profile",
        "kind",
        "endpoint",
        "secret",
        "revision",
        "action",
        "cluster",
        "owner",
        "environment",
    ] {
        let mut owner = scope();
        let mut request = update(
            ProfileKind::ActualRelay,
            AuthChange::ReplaceBearer(synthetic_secret()),
        );
        match field {
            "operation" => request.operation_id = "60000000-0000-4000-8000-000000000003".into(),
            "profile" => request.profile_id = "10000000-0000-4000-8000-000000000003".into(),
            "kind" => request.kind = ProfileKind::ActualLocal,
            "endpoint" => request.base_url.push('/'),
            "secret" => {
                request.auth =
                    AuthChange::ReplaceBearer(SecretString::new("different-synthetic-token".into()))
            }
            "revision" => request.expected_revision = Some(REVISION.into()),
            "action" => request.auth = AuthChange::KeepBearer,
            "cluster" => request.cluster_id = Some("synthetic-cluster".into()),
            "owner" => owner.owner_id = "other-owner".into(),
            _ => owner.environment_id = "other-server".into(),
        }
        assert!(adapter.tag(&owner, &ConfigMutation::Put(request)).unwrap() != original);
    }
}

#[test]
fn reordered_json_objects_have_the_same_private_tag_after_strict_typed_decode() {
    let mut adapter = crypto();
    let a=serde_json::from_str::<Value>(&format!(r#"{{"operationId":"{OPERATION}","expectedRevision":null,"provider":"lmstudio","mode":"local","baseUrl":"http://127.0.0.1:1234/v1","auth":{{"type":"none"}}}}"#)).unwrap();
    let b = json!({"auth":{"type":"none"},"baseUrl":"http://127.0.0.1:1234/v1","mode":"local","provider":"lmstudio","expectedRevision":null,"operationId":OPERATION});
    let first = adapter
        .tag(
            &scope(),
            &ConfigMutation::Put(profiles::decode_put(PROFILE, &a).unwrap()),
        )
        .unwrap();
    let second = adapter
        .tag(
            &scope(),
            &ConfigMutation::Put(profiles::decode_put(PROFILE, &b).unwrap()),
        )
        .unwrap();
    assert!(first == second);
}

#[test]
fn key_verifier_is_deterministic_private_keyed_and_distinct_from_payload_tag_derivation() {
    let first = crypto().key_verifier().unwrap();
    let again = crypto().key_verifier().unwrap();
    let other = CryptoAdapter::from_master(&master(9))
        .unwrap()
        .key_verifier()
        .unwrap();
    assert_eq!(first.len(), 32);
    assert!(first == again && first != other);
    assert!(first == hmac(&[7; 32], KEY_VERIFIER_DOMAIN));
    assert!(first != hmac(&[7; 32], MUTATION_KEY_DOMAIN));
}

#[test]
fn delete_identity_uses_its_action_scope_profile_operation_and_exact_expected_revision() {
    let mut adapter = crypto();
    let mutation = ConfigMutation::Delete(DeleteProfile {
        operation_id: OPERATION.into(),
        profile_id: PROFILE.into(),
        expected_revision: REVISION.into(),
    });
    let bytes = serde_json::to_vec(&json!([
        "v4.provider-mutation.v1",
        "synthetic-owner",
        "synthetic-execution-server",
        "delete",
        OPERATION,
        PROFILE,
        REVISION
    ]))
    .unwrap();
    let expected = hex::encode(hmac(&hmac(&[7; 32], MUTATION_KEY_DOMAIN), &bytes));
    let original = adapter.tag(&scope(), &mutation).unwrap();
    assert!(original.0 == expected);
    let changed = ConfigMutation::Delete(DeleteProfile {
        operation_id: OPERATION.into(),
        profile_id: PROFILE.into(),
        expected_revision: NEXT_REVISION.into(),
    });
    assert!(adapter.tag(&scope(), &changed).unwrap() != original);
}

#[test]
fn checkpoint_tag_binds_scope_generation_bytes_and_a_separate_key() {
    let adapter = crypto();
    let scope = scope();
    let bytes = b"synthetic-checkpoint";
    let tag = adapter.checkpoint_tag(&scope, 1, bytes).unwrap();
    adapter.verify_checkpoint(&scope, 1, bytes, &tag).unwrap();
    assert!(adapter.verify_checkpoint(&scope, 2, bytes, &tag).is_err());
    assert!(adapter
        .verify_checkpoint(&scope, 1, b"changed", &tag)
        .is_err());
    let mut foreign = scope.clone();
    foreign.owner_id = "other-owner".into();
    assert!(adapter.verify_checkpoint(&foreign, 1, bytes, &tag).is_err());
    let other = CryptoAdapter::from_master(&master(8)).unwrap();
    assert!(other.verify_checkpoint(&scope, 1, bytes, &tag).is_err());
    assert_ne!(tag, hmac(&*adapter.mutation, bytes));
}
