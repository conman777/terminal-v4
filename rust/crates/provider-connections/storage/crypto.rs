use super::{codec, key::PrivateKey};
use crate::*;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit,
};
use hmac::{Hmac, Mac};
use rand::TryRngCore;
use serde::{
    ser::{SerializeMap, SerializeSeq},
    Deserialize, Serialize,
};
use serde_json::Value;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub(super) const ENCRYPTION_DOMAIN: &[u8] = b"v4.provider-connections.aes256gcm.v1";
pub(super) const MUTATION_KEY_DOMAIN: &[u8] = b"v4.provider-connections.mutation-key.v1";
pub(super) const KEY_VERIFIER_DOMAIN: &[u8] = b"v4.provider-connections.key-verifier.v1";
type HmacSha256 = Hmac<Sha256>;
fn mac(key: &[u8]) -> Result<HmacSha256> {
    <HmacSha256 as Mac>::new_from_slice(key).map_err(|_| Error::InvalidCredential)
}
fn derive(master: &[u8], domain: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let mut context = mac(master)?;
    context.update(domain);
    let mut output = Zeroizing::new([0; 32]);
    let mut generated = context.finalize().into_bytes();
    output.copy_from_slice(&generated);
    for byte in generated.iter_mut() {
        byte.zeroize();
    }
    Ok(output)
}
pub(super) fn verify_master(master: &PrivateKey, expected: &[u8]) -> Result<()> {
    let mut context = mac(&*master.0).map_err(|_| Error::KeyUnavailable)?;
    context.update(KEY_VERIFIER_DOMAIN);
    context
        .verify_slice(expected)
        .map_err(|_| Error::KeyUnavailable)
}

pub(super) struct CryptoAdapter {
    encryption: Zeroizing<[u8; 32]>,
    mutation: Zeroizing<[u8; 32]>,
    verifier: Zeroizing<[u8; 32]>,
    checkpoint: Zeroizing<[u8; 32]>,
    #[cfg(test)]
    pub(super) seal_attempts: usize,
}
impl CryptoAdapter {
    pub(super) fn from_master(master: &PrivateKey) -> Result<Self> {
        Ok(Self {
            encryption: derive(&*master.0, ENCRYPTION_DOMAIN)?,
            mutation: derive(&*master.0, MUTATION_KEY_DOMAIN)?,
            verifier: derive(&*master.0, KEY_VERIFIER_DOMAIN)?,
            checkpoint: derive(&*master.0, b"v4.provider-connections.job-checkpoint-key.v1")?,
            #[cfg(test)]
            seal_attempts: 0,
        })
    }
    fn checkpoint_mac(&self, scope: &Scope, generation: u64, payload: &[u8]) -> Result<HmacSha256> {
        validate_scope(scope)?;
        if generation == 0
            || generation > i64::MAX as u64
            || payload.len() > crate::jobs::checkpoint::MAX_CHECKPOINT_BYTES
        {
            return Err(Error::PersistenceFailed);
        }
        let header = serde_json::to_vec(&(
            "v4.provider-discovery-checkpoint.v1",
            &scope.owner_id,
            &scope.environment_id,
            generation,
            payload.len(),
        ))
        .map_err(|_| Error::PersistenceFailed)?;
        let mut context = mac(&*self.checkpoint)?;
        context.update(&header);
        context.update(payload);
        Ok(context)
    }
    pub(super) fn checkpoint_tag(
        &self,
        scope: &Scope,
        generation: u64,
        payload: &[u8],
    ) -> Result<Vec<u8>> {
        Ok(self
            .checkpoint_mac(scope, generation, payload)?
            .finalize()
            .into_bytes()
            .to_vec())
    }
    pub(super) fn verify_checkpoint(
        &self,
        scope: &Scope,
        generation: u64,
        payload: &[u8],
        tag: &[u8],
    ) -> Result<()> {
        self.checkpoint_mac(scope, generation, payload)?
            .verify_slice(tag)
            .map_err(|_| Error::PersistenceFailed)
    }
    pub(super) fn key_verifier(&self) -> Result<Vec<u8>> {
        Ok(self.verifier.to_vec())
    }
    pub(super) fn verify_tag(
        &self,
        scope: &Scope,
        mutation: &ConfigMutation,
        expected: &PayloadTag,
    ) -> Result<()> {
        let bytes = identity_bytes(scope, mutation)?;
        let stored = hex::decode(&expected.0).map_err(|_| Error::OperationConflict)?;
        let mut context = mac(&*self.mutation)?;
        context.update(&bytes);
        context
            .verify_slice(&stored)
            .map_err(|_| Error::OperationConflict)
    }
}

struct Identity<'a> {
    scope: &'a Scope,
    mutation: &'a ConfigMutation,
}
impl Serialize for Identity<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(match self.mutation {
            ConfigMutation::Put(_) => 12,
            ConfigMutation::Delete(_) => 7,
        }))?;
        seq.serialize_element("v4.provider-mutation.v1")?;
        seq.serialize_element(&self.scope.owner_id)?;
        seq.serialize_element(&self.scope.environment_id)?;
        match self.mutation {
            ConfigMutation::Put(value) => {
                seq.serialize_element("put")?;
                seq.serialize_element(&value.operation_id)?;
                seq.serialize_element(&value.profile_id)?;
                seq.serialize_element(&value.expected_revision)?;
                seq.serialize_element(codec::kind_name(value.kind))?;
                seq.serialize_element(&value.base_url)?;
                seq.serialize_element(&value.cluster_id)?;
                let (action, secret) = match &value.auth {
                    AuthChange::None => ("none", None),
                    AuthChange::KeepBearer => ("keep-bearer", None),
                    AuthChange::ReplaceBearer(secret) => {
                        ("replace-bearer", Some(secret.expose_for_adapter()))
                    }
                };
                seq.serialize_element(action)?;
                seq.serialize_element(&secret)?;
            }
            ConfigMutation::Delete(value) => {
                seq.serialize_element("delete")?;
                seq.serialize_element(&value.operation_id)?;
                seq.serialize_element(&value.profile_id)?;
                seq.serialize_element(&value.expected_revision)?;
            }
        }
        seq.end()
    }
}
fn identity_bytes(scope: &Scope, mutation: &ConfigMutation) -> Result<Zeroizing<Vec<u8>>> {
    validate_scope(scope)?;
    let fields: Vec<&str> = match mutation {
        ConfigMutation::Put(value) => {
            let secret = match &value.auth {
                AuthChange::ReplaceBearer(secret) => secret.expose_for_adapter(),
                _ => "",
            };
            vec![
                &value.operation_id,
                &value.profile_id,
                value.expected_revision.as_deref().unwrap_or(""),
                &value.base_url,
                value.cluster_id.as_deref().unwrap_or(""),
                secret,
            ]
        }
        ConfigMutation::Delete(value) => vec![
            &value.operation_id,
            &value.profile_id,
            &value.expected_revision,
        ],
    };
    let total = fields
        .iter()
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or(Error::InvalidInput)?;
    if total > 65_536 {
        return Err(Error::InvalidInput);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    let mut serializer = serde_json::Serializer::new(&mut *bytes);
    Identity { scope, mutation }
        .serialize(&mut serializer)
        .map_err(|_| Error::InvalidInput)?;
    Ok(bytes)
}
struct PayloadView<'a> {
    binding: &'a Value,
    secret: &'a str,
}
impl Serialize for PayloadView<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("version", &1u8)?;
        map.serialize_entry("binding", self.binding)?;
        map.serialize_entry("secret", self.secret)?;
        map.end()
    }
}
struct SecretText(String);
impl Drop for SecretText {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl<'de> Deserialize<'de> for SecretText {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecryptedPayload {
    version: u8,
    binding: Value,
    secret: SecretText,
}
fn check_secret(binding: &CredentialBinding, secret: &str) -> Result<()> {
    let endpoint = canonical_target(binding.target.kind, &binding.target.base_url)
        .map_err(|_| Error::InvalidCredential)?;
    discovery::config::validate_new_key(&endpoint, discovery::AuthMode::ApiKey, secret)
        .map_err(|_| Error::InvalidCredential)
}
impl SecretSealer for CryptoAdapter {
    fn seal(&mut self, payload: &CredentialPayload) -> Result<SealedSecret> {
        #[cfg(test)]
        {
            self.seal_attempts += 1;
        }
        codec::validate_binding(&payload.binding).map_err(|_| Error::InvalidCredential)?;
        check_secret(&payload.binding, payload.secret.expose_for_adapter())?;
        let binding = codec::binding_value(&payload.binding);
        let aad = serde_json::to_vec(&binding).map_err(|_| Error::EncryptionFailed)?;
        let mut plaintext = Zeroizing::new(Vec::new());
        PayloadView {
            binding: &binding,
            secret: payload.secret.expose_for_adapter(),
        }
        .serialize(&mut serde_json::Serializer::new(&mut *plaintext))
        .map_err(|_| Error::EncryptionFailed)?;
        let cipher =
            Aes256Gcm::new_from_slice(&*self.encryption).map_err(|_| Error::EncryptionFailed)?;
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| Error::EncryptionFailed)?;
        let ciphertext = cipher
            .encrypt(
                &nonce.into(),
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::EncryptionFailed)?;
        let result = SealedSecret(format!(
            "enc:v1:{}:{}",
            hex::encode(nonce),
            hex::encode(ciphertext)
        ));
        validate_ciphertext(&result)?;
        Ok(result)
    }
    fn open(&mut self, encrypted: &EncryptedCredential) -> Result<CredentialPayload> {
        validate_ciphertext(&encrypted.sealed)?;
        codec::validate_binding(&encrypted.binding).map_err(|_| Error::InvalidCredential)?;
        let parts = encrypted.sealed.0.split(':').collect::<Vec<_>>();
        if parts.len() != 4
            || parts[2]
                .bytes()
                .chain(parts[3].bytes())
                .any(|byte| byte.is_ascii_uppercase())
        {
            return Err(Error::EncryptedCredentialRequired);
        }
        let nonce: [u8; 12] = hex::decode(parts[2])
            .map_err(|_| Error::EncryptedCredentialRequired)?
            .try_into()
            .map_err(|_| Error::EncryptedCredentialRequired)?;
        let ciphertext = hex::decode(parts[3]).map_err(|_| Error::EncryptedCredentialRequired)?;
        let expected = codec::binding_value(&encrypted.binding);
        let aad = serde_json::to_vec(&expected).map_err(|_| Error::InvalidCredential)?;
        let cipher =
            Aes256Gcm::new_from_slice(&*self.encryption).map_err(|_| Error::InvalidCredential)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    &nonce.into(),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| Error::InvalidCredential)?,
        );
        let mut payload: DecryptedPayload =
            serde_json::from_slice(&plaintext).map_err(|_| Error::InvalidCredential)?;
        if payload.version != 1 || payload.binding != expected {
            return Err(Error::InvalidCredential);
        }
        check_secret(&encrypted.binding, &payload.secret.0)?;
        Ok(CredentialPayload {
            binding: encrypted.binding.clone(),
            secret: SecretString::new(std::mem::take(&mut payload.secret.0)),
        })
    }
}
impl PayloadAuthenticator for CryptoAdapter {
    fn tag(&mut self, scope: &Scope, mutation: &ConfigMutation) -> Result<PayloadTag> {
        let bytes = identity_bytes(scope, mutation)?;
        let mut context = mac(&*self.mutation)?;
        context.update(&bytes);
        Ok(PayloadTag(hex::encode(context.finalize().into_bytes())))
    }
}

#[cfg(test)]
mod tests;
