use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::path::Path;

const ENCRYPTION_PREFIX: &str = "enc:v2:";
const LEGACY_PREFIX: &str = "enc:v1:";
const LEGACY_PUBLIC_KEY: &str = "dev-vault-key-change-in-production";

pub struct VaultCipher {
    write_key: String,
    install_key: Option<String>,
}

impl VaultCipher {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let configured = match std::env::var("VAULT_ENCRYPTION_KEY") {
            Ok(key) => Some(key),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return Err("VAULT_ENCRYPTION_KEY must be valid Unicode".into()),
        };
        Self::load_with_key(data_dir, configured.as_deref())
    }

    /// Read an existing vault key without creating or replacing key material.
    #[cfg(unix)]
    pub(crate) fn load_existing(data_dir: &Path) -> Result<Self, String> {
        let configured = match std::env::var("VAULT_ENCRYPTION_KEY") {
            Ok(key) => Some(key),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return Err("VAULT_ENCRYPTION_KEY must be valid Unicode".into()),
        };
        Self::load_existing_with_key(data_dir, configured.as_deref())
    }

    #[cfg(not(unix))]
    pub(crate) fn load_existing(_data_dir: &Path) -> Result<Self, String> {
        Err("Existing-only vault reads are unavailable on this platform".into())
    }

    #[cfg(unix)]
    fn load_existing_with_key(data_dir: &Path, configured: Option<&str>) -> Result<Self, String> {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

        let configured = configured.filter(|key| *key != LEGACY_PUBLIC_KEY);
        if configured.is_some_and(|key| key.trim().is_empty()) {
            return Err("Configure a private, nonempty VAULT_ENCRYPTION_KEY".into());
        }
        let path = data_dir.join("vault-encryption.key");
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        let installed = match options.open(&path) {
            Ok(file) => {
                let before = file
                    .metadata()
                    .map_err(|_| "Cannot inspect vault installation key")?;
                if !before.is_file()
                    || before.permissions().mode() & 0o077 != 0
                    || before.len() != 64
                {
                    return Err("Vault installation key is invalid or unsafe".into());
                }
                let mut key = String::new();
                file.take(65)
                    .read_to_string(&mut key)
                    .map_err(|_| "Cannot read vault installation key")?;
                let after = std::fs::symlink_metadata(&path)
                    .map_err(|_| "Vault installation key changed during read")?;
                if !after.is_file()
                    || after.file_type().is_symlink()
                    || after.dev() != before.dev()
                    || after.ino() != before.ino()
                    || after.mtime() != before.mtime()
                    || after.mtime_nsec() != before.mtime_nsec()
                    || after.permissions().mode() & 0o077 != 0
                    || key.len() != 64
                    || hex::decode(&key).map_or(true, |bytes| bytes.len() != 32)
                {
                    return Err("Vault installation key changed or is invalid".into());
                }
                Some(key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Cannot open vault installation key safely".into()),
        };
        if let Some(key) = configured {
            return Ok(Self {
                write_key: key.into(),
                install_key: installed,
            });
        }
        let key = installed.ok_or("Vault installation key is unavailable")?;
        Ok(Self {
            write_key: key,
            install_key: None,
        })
    }

    fn load_with_key(data_dir: &Path, configured: Option<&str>) -> Result<Self, String> {
        let configured = configured.filter(|key| *key != LEGACY_PUBLIC_KEY);
        if configured.is_some_and(|key| key.trim().is_empty()) {
            return Err("Configure a private, nonempty VAULT_ENCRYPTION_KEY".into());
        }
        let path = data_dir.join("vault-encryption.key");
        let install_key = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err("Vault installation key must be a regular file".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o077 != 0 {
                        return Err("Vault installation key permissions must be 0600".into());
                    }
                }
                let key = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
                if key.len() != 64 || hex::decode(&key).map_or(true, |key| key.len() != 32) {
                    return Err("Invalid vault installation key; preserve it for recovery".into());
                }
                Some(key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if let Some(key) = configured {
            return Ok(Self {
                write_key: key.into(),
                install_key,
            });
        }
        if let Some(key) = install_key {
            return Ok(Self {
                write_key: key,
                install_key: None,
            });
        }
        use std::io::Write;
        std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let key = hex::encode(bytes);
        // Publish a complete owner-only key atomically; a concurrent creator wins unchanged.
        let mut temporary =
            tempfile::NamedTempFile::new_in(data_dir).map_err(|error| error.to_string())?;
        temporary
            .write_all(key.as_bytes())
            .map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => Ok(Self {
                write_key: key,
                install_key: None,
            }),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                Self::load_with_key(data_dir, None)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn encrypt(&self, value: &str) -> Result<String, String> {
        encrypt_with_prefix(value, &self.write_key, ENCRYPTION_PREFIX)
    }

    pub fn decrypt(&self, value: &str) -> Result<String, String> {
        decrypt_secret(value, &self.write_key)
            .or_else(|error| match &self.install_key {
                Some(key) => decrypt_secret(value, key),
                None => Err(error),
            })
            .or_else(|error| {
                // The old public key is read-only compatibility, never a new-write key.
                if value.starts_with(LEGACY_PREFIX) {
                    decrypt_secret(value, LEGACY_PUBLIC_KEY)
                } else {
                    Err(error)
                }
            })
    }

    #[cfg(unix)]
    pub(crate) fn decrypt_with_write_key(&self, value: &str) -> Result<String, String> {
        // `decrypt_secret` returns unprefixed values unchanged; a signed record never may be.
        if !value.starts_with(ENCRYPTION_PREFIX) {
            return Err("Value is not sealed with the installation key".into());
        }
        decrypt_secret(value, &self.write_key)
    }

    #[cfg(unix)]
    pub(crate) fn from_queue_installation_key(key: String) -> Result<Self, String> {
        if key.len() != 64 || hex::decode(&key).map_or(true, |bytes| bytes.len() != 32) {
            return Err("Queue installation key is invalid".into());
        }
        Ok(Self {
            write_key: key,
            install_key: None,
        })
    }
}

/// Encrypt a secret value using AES-256-GCM.
/// Retains the `enc:v1` format used by MCP and paired credential storage.
pub fn encrypt_secret(value: &str, encryption_key: &str) -> Result<String, String> {
    encrypt_with_prefix(value, encryption_key, LEGACY_PREFIX)
}

fn encrypt_with_prefix(value: &str, encryption_key: &str, prefix: &str) -> Result<String, String> {
    let key = derive_key(encryption_key);
    let cipher = Aes256Gcm::new(&key.into());

    let mut iv_bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let ciphertext = cipher
        .encrypt(nonce, value.as_bytes())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    Ok(format!(
        "{prefix}{}:{}",
        hex::encode(iv_bytes),
        hex::encode(ciphertext)
    ))
}

/// Decrypt a secret value. If it's not encrypted (no prefix), return as-is.
pub fn decrypt_secret(value: &str, encryption_key: &str) -> Result<String, String> {
    let Some(rest) = value
        .strip_prefix(ENCRYPTION_PREFIX)
        .or_else(|| value.strip_prefix(LEGACY_PREFIX))
    else {
        if value.starts_with("enc:") {
            return Err("Unsupported encrypted vault format".into());
        }
        return Ok(value.to_string());
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (iv_bytes, ciphertext) = match parts.as_slice() {
        [iv, ciphertext] => (
            hex::decode(iv).map_err(|error| format!("Invalid IV: {error}"))?,
            hex::decode(ciphertext).map_err(|error| format!("Invalid ciphertext: {error}"))?,
        ),
        [iv, tag, ciphertext] if value.starts_with(LEGACY_PREFIX) => {
            let decode = |value| {
                base64::engine::general_purpose::STANDARD
                    .decode(value)
                    .map_err(|error| format!("Invalid legacy ciphertext: {error}"))
            };
            let iv = decode(iv)?;
            let tag = decode(tag)?;
            if tag.len() != 16 {
                return Err("Invalid authentication tag length".into());
            }
            let mut ciphertext = decode(ciphertext)?;
            ciphertext.extend_from_slice(&tag);
            (iv, ciphertext)
        }
        _ => return Err("Invalid encrypted format".into()),
    };
    if iv_bytes.len() != 12 || ciphertext.len() < 16 {
        return Err("Invalid encrypted payload length".into());
    }

    let key = derive_key(encryption_key);
    let cipher = Aes256Gcm::new(&key.into());
    let nonce = Nonce::from_slice(&iv_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_slice())
        .map_err(|e| format!("Decryption failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 in decrypted value: {e}"))
}

/// Mask a key value for display: `****` + last 4 chars, or all `****` if <= 4 chars.
pub fn mask_key(value: &str) -> String {
    let Some((last_hidden_index, last_hidden_char)) = value.char_indices().rev().nth(4) else {
        return "****".to_string();
    };
    format!(
        "****{}",
        &value[last_hidden_index + last_hidden_char.len_utf8()..]
    )
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
    #[test]
    fn credential_helper_retains_v1_while_installation_vault_writes_v2() {
        let directory = tempfile::tempdir().unwrap();
        let vault = super::VaultCipher::load_with_key(directory.path(), None).unwrap();
        let credential =
            super::encrypt_secret("synthetic MCP credential", "private fixture key").unwrap();
        assert!(credential.starts_with("enc:v1:"));
        assert_eq!(
            super::decrypt_secret(&credential, "private fixture key").unwrap(),
            "synthetic MCP credential"
        );
        let secret = vault.encrypt("synthetic vault value").unwrap();
        assert!(secret.starts_with("enc:v2:"));
        assert_eq!(vault.decrypt(&secret).unwrap(), "synthetic vault value");
    }
    use super::*;

    #[cfg(unix)]
    #[test]
    fn existing_only_loader_never_creates_or_recreates_installation_key() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("vault-encryption.key");
        assert!(VaultCipher::load_existing_with_key(data.path(), None).is_err());
        assert!(!path.exists());
        let explicit =
            VaultCipher::load_existing_with_key(data.path(), Some("private-fixture")).unwrap();
        let encrypted = explicit.encrypt("synthetic value").unwrap();
        assert_eq!(explicit.decrypt(&encrypted).unwrap(), "synthetic value");
        assert!(!path.exists());
        let installed = VaultCipher::load_with_key(data.path(), None).unwrap();
        let encrypted = installed.encrypt("another synthetic value").unwrap();
        let loaded = VaultCipher::load_existing_with_key(data.path(), None).unwrap();
        assert_eq!(
            loaded.decrypt(&encrypted).unwrap(),
            "another synthetic value"
        );
        std::fs::remove_file(&path).unwrap();
        assert!(VaultCipher::load_existing_with_key(data.path(), None).is_err());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn existing_only_loader_rejects_symlinks_and_insecure_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let data = tempfile::tempdir().unwrap();
        let target = data.path().join("other-key");
        std::fs::write(&target, "a".repeat(64)).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        let path = data.path().join("vault-encryption.key");
        symlink(&target, &path).unwrap();
        assert!(VaultCipher::load_existing_with_key(data.path(), None).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "a".repeat(64)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(VaultCipher::load_existing_with_key(data.path(), None).is_err());
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = "test-encryption-key";
        let secret = "sk-abc123xyz";

        let encrypted = encrypt_secret(secret, key).expect("should encrypt");
        assert!(encrypted.starts_with(LEGACY_PREFIX));
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
    fn mask_key_uses_characters_for_unicode_secrets() {
        let cases = [
            ("", "****"),
            ("密钥", "****"),
            ("🔐🔑🙂🗝", "****"),
            ("密钥abc", "****钥abc"),
            ("secret🔐🔑🙂🗝", "****🔐🔑🙂🗝"),
        ];
        let masked: Vec<_> = cases.iter().map(|(secret, _)| mask_key(secret)).collect();
        let expected: Vec<_> = cases.iter().map(|(_, expected)| *expected).collect();
        assert_eq!(masked, expected);
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

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    fn install_key_survives_restart_and_is_unique_per_install() {
        let data = tempfile::tempdir().unwrap();
        let first = VaultCipher::load_with_key(data.path(), None).unwrap();
        let ciphertext = first.encrypt("synthetic secret").unwrap();
        assert!(decrypt_secret(&ciphertext, LEGACY_PUBLIC_KEY).is_err());
        let original_key = std::fs::read(data.path().join("vault-encryption.key")).unwrap();
        drop(first);
        let restarted = VaultCipher::load_with_key(data.path(), None).unwrap();
        assert_eq!(restarted.decrypt(&ciphertext).unwrap(), "synthetic secret");
        assert_eq!(
            std::fs::read(data.path().join("vault-encryption.key")).unwrap(),
            original_key
        );
        let other = tempfile::tempdir().unwrap();
        assert!(VaultCipher::load_with_key(other.path(), None)
            .unwrap()
            .decrypt(&ciphertext)
            .is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(data.path().join("vault-encryption.key"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn existing_ciphertexts_remain_readable_and_migrate_to_private_key() {
        let data = tempfile::tempdir().unwrap();
        let cipher = VaultCipher::load_with_key(data.path(), None).unwrap();
        let old_rust = encrypt_secret("synthetic prior value", LEGACY_PUBLIC_KEY)
            .unwrap()
            .replacen(ENCRYPTION_PREFIX, LEGACY_PREFIX, 1);
        let plain = cipher.decrypt(&old_rust).unwrap();
        let migrated = cipher.encrypt(&plain).unwrap();
        assert!(decrypt_secret(&migrated, LEGACY_PUBLIC_KEY).is_err());
        assert_eq!(
            VaultCipher::load_with_key(data.path(), None)
                .unwrap()
                .decrypt(&migrated)
                .unwrap(),
            "synthetic prior value"
        );
        let explicit =
            VaultCipher::load_with_key(data.path(), Some("synthetic-review-key")).unwrap();
        let legacy =
            "enc:v1:mSyrdyt5rf6Uc9+U:ci+FrOsqBl+rFGXC5q0XzQ==:Lbl90q8bJyNnAIOD9xIuJxWeQdEc+Bk=";
        let migrated_legacy = explicit
            .encrypt(&explicit.decrypt(legacy).unwrap())
            .unwrap();
        let reopened =
            VaultCipher::load_with_key(data.path(), Some("synthetic-review-key")).unwrap();
        assert_eq!(
            (
                reopened.decrypt(&migrated).unwrap(),
                reopened.decrypt(&migrated_legacy).unwrap()
            ),
            (
                "synthetic prior value".into(),
                "synthetic-review-secret".into()
            )
        );
        assert!(reopened
            .decrypt(&migrated_legacy.replacen("enc:v2:", "enc:v3:", 1))
            .is_err());
    }

    #[test]
    fn malformed_key_is_preserved_and_never_regenerated() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("vault-encryption.key");
        std::fs::write(&path, "synthetic damaged key").unwrap();
        assert!(VaultCipher::load_with_key(data.path(), None).is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "synthetic damaged key"
        );
        for key in ["", " "] {
            assert!(VaultCipher::load_with_key(data.path(), Some(key)).is_err());
        }
    }

    #[test]
    fn concurrent_initialization_publishes_one_complete_key() {
        let data = tempfile::tempdir().unwrap();
        let keys = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        VaultCipher::load_with_key(data.path(), None)
                            .unwrap()
                            .write_key
                    })
                })
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(keys, vec![keys[0].clone(); 8]);
        assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn queue_key_cipher_decrypts_only_what_its_own_key_sealed() {
        let queue_key = "ab".repeat(32);
        let queue = VaultCipher::from_queue_installation_key(queue_key.clone()).unwrap();
        let sealed = queue.encrypt("synthetic proof").unwrap();
        assert_eq!(
            queue.decrypt_with_write_key(&sealed).unwrap(),
            "synthetic proof"
        );

        let other = VaultCipher::from_queue_installation_key("cd".repeat(32)).unwrap();
        assert!(other.decrypt_with_write_key(&sealed).is_err());
        let public = encrypt_secret("synthetic proof", LEGACY_PUBLIC_KEY).unwrap();
        assert!(queue.decrypt_with_write_key(&public).is_err());
        let shared = encrypt_secret("synthetic proof", "shared vault key").unwrap();
        assert!(queue.decrypt_with_write_key(&shared).is_err());
        let claims = r#"{"version":1}"#;
        assert!(queue.decrypt_with_write_key(claims).is_err());
        let legacy_v1 = sealed.replacen("enc:v2:", "enc:v1:", 1);
        assert!(queue.decrypt_with_write_key(&legacy_v1).is_err());
        for invalid in ["", "short", &"zz".repeat(32), &"ab".repeat(33)] {
            assert!(VaultCipher::from_queue_installation_key(invalid.into()).is_err());
        }
    }

    #[test]
    fn invalid_nonce_and_tag_lengths_return_errors_without_panicking() {
        for value in [
            "enc:v1:00:00",
            "enc:v2:00:00",
            "enc:v1:AA==:AA==:AA==",
            "enc:v1:",
            "enc:v3:00:00",
        ] {
            assert!(decrypt_secret(value, "synthetic key").is_err());
        }
    }
}
