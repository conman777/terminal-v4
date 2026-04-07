use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use sha2::{Digest, Sha256};

const ENCRYPTION_PREFIX: &str = "enc:v1:";

/// Encrypt a secret value using AES-256-GCM.
/// Returns a string in format: `enc:v1:{iv_hex}:{tag+ciphertext_hex}`
pub fn encrypt_secret(value: &str, encryption_key: &str) -> Result<String, String> {
    let key = derive_key(encryption_key);
    let cipher = Aes256Gcm::new(&key.into());

    let mut iv_bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let ciphertext = cipher
        .encrypt(nonce, value.as_bytes())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    Ok(format!(
        "{ENCRYPTION_PREFIX}{}:{}",
        hex::encode(iv_bytes),
        hex::encode(ciphertext)
    ))
}

/// Decrypt a secret value. If it's not encrypted (no prefix), return as-is.
pub fn decrypt_secret(value: &str, encryption_key: &str) -> Result<String, String> {
    let Some(rest) = value.strip_prefix(ENCRYPTION_PREFIX) else {
        return Ok(value.to_string());
    };

    let parts: Vec<&str> = rest.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err("Invalid encrypted format".to_string());
    }

    let iv_bytes = hex::decode(parts[0]).map_err(|e| format!("Invalid IV: {e}"))?;
    let ciphertext = hex::decode(parts[1]).map_err(|e| format!("Invalid ciphertext: {e}"))?;

    let key = derive_key(encryption_key);
    let cipher = Aes256Gcm::new(&key.into());
    let nonce = Nonce::from_slice(&iv_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_slice())
        .map_err(|e| format!("Decryption failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 in decrypted value: {e}"))
}

/// Mask a key value for display: `****` + last 4 chars, or all `****` if < 4 chars.
pub fn mask_key(value: &str) -> String {
    if value.len() <= 4 {
        "****".to_string()
    } else {
        format!("****{}", &value[value.len() - 4..])
    }
}

fn derive_key(secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.finalize().into()
}

/// Vault key entry for API responses.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    pub key_name: String,
    pub key_value: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = "test-encryption-key";
        let secret = "sk-abc123xyz";

        let encrypted = encrypt_secret(secret, key).expect("should encrypt");
        assert!(encrypted.starts_with(ENCRYPTION_PREFIX));
        assert_ne!(encrypted, secret);

        let decrypted = decrypt_secret(&encrypted, key).expect("should decrypt");
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn decrypt_unencrypted_returns_as_is() {
        let result = decrypt_secret("plain-value", "any-key").expect("should succeed");
        assert_eq!(result, "plain-value");
    }

    #[test]
    fn mask_key_short_values() {
        assert_eq!(mask_key("abc"), "****");
        assert_eq!(mask_key("abcd"), "****");
    }

    #[test]
    fn mask_key_long_values() {
        assert_eq!(mask_key("sk-abc123xyz"), "****3xyz");
    }

    #[test]
    fn different_encryptions_produce_different_ciphertexts() {
        let key = "test-key";
        let secret = "same-secret";
        let enc1 = encrypt_secret(secret, key).unwrap();
        let enc2 = encrypt_secret(secret, key).unwrap();
        // Random IV means different ciphertexts
        assert_ne!(enc1, enc2);
        // Both decrypt to same value
        assert_eq!(decrypt_secret(&enc1, key).unwrap(), secret);
        assert_eq!(decrypt_secret(&enc2, key).unwrap(), secret);
    }
}
