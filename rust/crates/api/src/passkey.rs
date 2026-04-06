//! Passkey/WebAuthn support.
//!
//! The WebAuthn challenge flow requires the `webauthn-rs` crate which depends
//! on OpenSSL. On Windows dev machines without OpenSSL, the route handlers
//! return 501 Not Implemented. On Linux deployment, enable the `webauthn-rs`
//! dependency in Cargo.toml for full functionality.

/// Stored passkey credential for API responses.
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

/// Database operations for passkey credentials.
/// The schema is always created (see state.rs initialize_schema),
/// but WebAuthn operations require the webauthn-rs crate.
pub mod db {
    use super::StoredCredential;

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
}
