use std::collections::HashMap;
use std::sync::Arc;

use sha2::Digest;
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::*;

use terminal_v4_core::AppConfig;

const CHALLENGE_TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    pub id: String,
    pub credential_id: String,
    pub name: Option<String>,
    pub device_type: String,
    pub backed_up: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Clone)]
pub struct PasskeyService {
    webauthn: Arc<Webauthn>,
    pending: Arc<Mutex<HashMap<String, PendingChallenge>>>,
}

#[derive(Debug, Clone)]
enum PendingChallenge {
    Registration {
        state: PasskeyRegistration,
        expires_at: i64,
    },
    Authentication {
        state: PasskeyAuthentication,
        expires_at: i64,
    },
}

impl PasskeyService {
    pub fn new(config: &AppConfig) -> Result<Self, String> {
        let rp_id = std::env::var("WEBAUTHN_RP_ID").unwrap_or_else(|_| "localhost".to_string());
        let rp_name = std::env::var("WEBAUTHN_RP_NAME").unwrap_or_else(|_| "Terminal".to_string());
        let default_origin = format!("http://localhost:{}", config.port);
        let origin = std::env::var("WEBAUTHN_ORIGIN").unwrap_or(default_origin);
        let origin = Url::parse(&origin).map_err(|e| format!("Invalid WebAuthn origin: {e}"))?;

        let webauthn = WebauthnBuilder::new(&rp_id, &origin)
            .map_err(|e| format!("Invalid WebAuthn configuration: {e}"))?
            .rp_name(&rp_name)
            .allow_any_port(true)
            .build()
            .map_err(|e| format!("Failed to initialize WebAuthn: {e}"))?;

        Ok(Self {
            webauthn: Arc::new(webauthn),
            pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn begin_registration(
        &self,
        user_id: &str,
        username: &str,
        existing_passkeys: &[Passkey],
    ) -> Result<CreationChallengeResponse, String> {
        let user_uuid = stable_user_uuid(user_id);
        let exclude_credentials = if existing_passkeys.is_empty() {
            None
        } else {
            Some(
                existing_passkeys
                    .iter()
                    .map(|passkey| passkey.cred_id().clone())
                    .collect(),
            )
        };
        let (options, state) = self
            .webauthn
            .start_passkey_registration(user_uuid, username, username, exclude_credentials)
            .map_err(|e| format!("Failed to start passkey registration: {e}"))?;

        self.store_pending(
            pending_registration_key(user_id),
            PendingChallenge::Registration {
                state,
                expires_at: expiry_timestamp(),
            },
        )
        .await;

        Ok(options)
    }

    pub async fn complete_registration(
        &self,
        user_id: &str,
        credential: RegisterPublicKeyCredential,
    ) -> Result<Passkey, String> {
        let PendingChallenge::Registration { state, .. } = self
            .consume_pending(&pending_registration_key(user_id))
            .await
            .ok_or_else(|| "Registration challenge not found or expired".to_string())?
        else {
            return Err("Registration challenge mismatch".to_string());
        };

        self.webauthn
            .finish_passkey_registration(&credential, &state)
            .map_err(|e| format!("Passkey registration failed: {e}"))
    }

    pub async fn begin_authentication(
        &self,
        user_id: &str,
        passkeys: &[Passkey],
    ) -> Result<RequestChallengeResponse, String> {
        let (options, state) = self
            .webauthn
            .start_passkey_authentication(passkeys)
            .map_err(|e| format!("Failed to start passkey authentication: {e}"))?;

        self.store_pending(
            pending_authentication_key(user_id),
            PendingChallenge::Authentication {
                state,
                expires_at: expiry_timestamp(),
            },
        )
        .await;

        Ok(options)
    }

    pub async fn complete_authentication(
        &self,
        user_id: &str,
        credential: PublicKeyCredential,
    ) -> Result<AuthenticationResult, String> {
        let PendingChallenge::Authentication { state, .. } = self
            .consume_pending(&pending_authentication_key(user_id))
            .await
            .ok_or_else(|| "Authentication challenge not found or expired".to_string())?
        else {
            return Err("Authentication challenge mismatch".to_string());
        };

        self.webauthn
            .finish_passkey_authentication(&credential, &state)
            .map_err(|e| format!("Passkey authentication failed: {e}"))
    }

    async fn store_pending(&self, key: String, value: PendingChallenge) {
        let mut pending = self.pending.lock().await;
        prune_expired(&mut pending);
        pending.insert(key, value);
    }

    async fn consume_pending(&self, key: &str) -> Option<PendingChallenge> {
        let mut pending = self.pending.lock().await;
        prune_expired(&mut pending);
        pending.remove(key)
    }
}

fn pending_registration_key(user_id: &str) -> String {
    format!("reg:{user_id}")
}

fn pending_authentication_key(user_id: &str) -> String {
    format!("auth:{user_id}")
}

fn prune_expired(pending: &mut HashMap<String, PendingChallenge>) {
    let now = now_millis();
    pending.retain(|_, value| match value {
        PendingChallenge::Registration { expires_at, .. } => *expires_at >= now,
        PendingChallenge::Authentication { expires_at, .. } => *expires_at >= now,
    });
}

fn expiry_timestamp() -> i64 {
    now_millis() + CHALLENGE_TTL_MS
}

fn now_millis() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .expect("timestamp should fit in i64")
}

fn stable_user_uuid(user_id: &str) -> Uuid {
    Uuid::parse_str(user_id).unwrap_or_else(|_| {
        let digest = sha2::Sha256::digest(user_id.as_bytes());
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        Uuid::from_bytes(bytes)
    })
}

fn credential_id_to_string(credential_id: &CredentialID) -> Result<String, String> {
    serde_json::to_value(credential_id)
        .map_err(|e| format!("Failed to serialize credential id: {e}"))?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Credential id did not serialize to string".to_string())
}

#[derive(Debug, Clone)]
pub struct StoredPasskey {
    pub record: StoredCredential,
    pub passkey: Passkey,
}

#[derive(Debug, Clone)]
struct PasskeyMetadata {
    credential_id: String,
    counter: i64,
    device_type: String,
    backed_up: bool,
    transports: Option<String>,
    serialized_passkey: Vec<u8>,
}

fn passkey_metadata(passkey: &Passkey) -> Result<PasskeyMetadata, String> {
    let credential: Credential = passkey.clone().into();
    let credential_id = credential_id_to_string(&credential.cred_id)?;
    let transports = credential
        .transports
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("Failed to serialize transports: {e}"))?;

    Ok(PasskeyMetadata {
        credential_id,
        counter: i64::try_from(credential.counter).unwrap_or(i64::MAX),
        device_type: if credential.backup_eligible {
            "multiDevice".to_string()
        } else {
            "singleDevice".to_string()
        },
        backed_up: credential.backup_state,
        transports,
        serialized_passkey: serde_json::to_vec(passkey)
            .map_err(|e| format!("Failed to serialize passkey credential: {e}"))?,
    })
}

pub mod db {
    use super::{passkey_metadata, StoredCredential, StoredPasskey};
    use rusqlite::OptionalExtension;
    use uuid::Uuid;
    use webauthn_rs::prelude::{CredentialID, Passkey};

    pub fn list_credentials(
        conn: &rusqlite::Connection,
        user_id: &str,
    ) -> Result<Vec<StoredCredential>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, credential_id, name, device_type, backed_up, created_at, last_used_at \
                 FROM passkey_credentials WHERE user_id = ? ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([user_id], |row| {
                Ok(StoredCredential {
                    id: row.get(0)?,
                    credential_id: row.get(1)?,
                    name: row.get(2)?,
                    device_type: row.get(3)?,
                    backed_up: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                    last_used_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut creds = Vec::new();
        for row in rows {
            creds.push(row.map_err(|e| e.to_string())?);
        }
        Ok(creds)
    }

    pub fn list_passkeys(
        conn: &rusqlite::Connection,
        user_id: &str,
    ) -> Result<Vec<StoredPasskey>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, credential_id, name, device_type, backed_up, created_at, last_used_at, public_key \
                 FROM passkey_credentials WHERE user_id = ? ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([user_id], |row| {
                let public_key: Vec<u8> = row.get(7)?;
                let passkey: Passkey = serde_json::from_slice(&public_key).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        public_key.len(),
                        rusqlite::types::Type::Blob,
                        Box::new(error),
                    )
                })?;
                Ok(StoredPasskey {
                    record: StoredCredential {
                        id: row.get(0)?,
                        credential_id: row.get(1)?,
                        name: row.get(2)?,
                        device_type: row.get(3)?,
                        backed_up: row.get::<_, i32>(4)? != 0,
                        created_at: row.get(5)?,
                        last_used_at: row.get(6)?,
                    },
                    passkey,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut passkeys = Vec::new();
        for row in rows {
            passkeys.push(row.map_err(|e| e.to_string())?);
        }
        Ok(passkeys)
    }

    pub fn get_passkey_by_credential_id(
        conn: &rusqlite::Connection,
        credential_id: &str,
    ) -> Result<Option<StoredPasskey>, String> {
        conn.query_row(
            "SELECT id, user_id, credential_id, name, device_type, backed_up, created_at, last_used_at, public_key \
             FROM passkey_credentials WHERE credential_id = ?",
            [credential_id],
            |row| {
                let public_key: Vec<u8> = row.get(8)?;
                let passkey: Passkey = serde_json::from_slice(&public_key).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        public_key.len(),
                        rusqlite::types::Type::Blob,
                        Box::new(error),
                    )
                })?;
                Ok(StoredPasskey {
                    record: StoredCredential {
                        id: row.get(0)?,
                        credential_id: row.get(2)?,
                        name: row.get(3)?,
                        device_type: row.get(4)?,
                        backed_up: row.get::<_, i32>(5)? != 0,
                        created_at: row.get(6)?,
                        last_used_at: row.get(7)?,
                    },
                    passkey,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn create_credential(
        conn: &rusqlite::Connection,
        user_id: &str,
        passkey: &Passkey,
        name: Option<&str>,
    ) -> Result<StoredCredential, String> {
        let id = Uuid::new_v4().to_string();
        let created_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .expect("rfc3339 formatting should succeed");
        let metadata = passkey_metadata(passkey)?;

        conn.execute(
            "INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                id,
                user_id,
                metadata.credential_id,
                metadata.serialized_passkey,
                metadata.counter,
                metadata.device_type,
                if metadata.backed_up { 1 } else { 0 },
                metadata.transports,
                name,
                created_at,
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(StoredCredential {
            id,
            credential_id: metadata.credential_id,
            name: name.map(str::to_string),
            device_type: metadata.device_type,
            backed_up: metadata.backed_up,
            created_at,
            last_used_at: None,
        })
    }

    pub fn update_credential_after_authentication(
        conn: &rusqlite::Connection,
        id: &str,
        passkey: &Passkey,
        last_used_at: &str,
    ) -> Result<(), String> {
        let metadata = passkey_metadata(passkey)?;
        conn.execute(
            "UPDATE passkey_credentials
             SET public_key = ?, counter = ?, device_type = ?, backed_up = ?, transports = ?, last_used_at = ?
             WHERE id = ?",
            rusqlite::params![
                metadata.serialized_passkey,
                metadata.counter,
                metadata.device_type,
                if metadata.backed_up { 1 } else { 0 },
                metadata.transports,
                last_used_at,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_credential(
        conn: &rusqlite::Connection,
        user_id: &str,
        credential_id: &str,
    ) -> Result<bool, String> {
        let count = conn
            .execute(
                "DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?",
                rusqlite::params![credential_id, user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn lookup_credential_id(credential_id: &CredentialID) -> Result<String, String> {
        super::credential_id_to_string(credential_id)
    }
}
