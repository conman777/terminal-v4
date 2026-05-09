use async_trait::async_trait;
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::Row;

const ACCEPT_INVALID_CERTS_ENV: &str = "TERMINAL_V4_EXTERNAL_AUTH_ACCEPT_INVALID_CERTS";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalAuthUser {
    pub id: String,
    pub email: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub created_at: String,
}

impl ExternalAuthUser {
    pub fn resolved_username(&self) -> String {
        self.display_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.email)
            .to_string()
    }
}

#[async_trait]
pub trait ExternalAuthProvider: Send + Sync {
    async fn get_user_by_identifier(
        &self,
        identifier: &str,
    ) -> Result<Option<ExternalAuthUser>, String>;

    async fn get_user_by_id(&self, user_id: &str) -> Result<Option<ExternalAuthUser>, String>;
}

pub struct PostgresExternalAuthProvider {
    connection_string: String,
}

impl PostgresExternalAuthProvider {
    pub fn new(connection_string: String) -> Self {
        Self { connection_string }
    }

    async fn query_user(
        &self,
        query: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Option<ExternalAuthUser>, String> {
        let tls = external_auth_tls_connector()?;
        let (client, connection) = tokio_postgres::connect(&self.connection_string, tls)
            .await
            .map_err(|error| error.to_string())?;

        tokio::spawn(async move {
            let _ = connection.await;
        });

        client
            .query_opt(query, params)
            .await
            .map_err(|error| error.to_string())
            .and_then(|row| row.map(map_row).transpose())
    }
}

fn external_auth_tls_connector() -> Result<MakeTlsConnector, String> {
    let mut builder = TlsConnector::builder();
    if external_auth_accepts_invalid_certs() {
        builder.danger_accept_invalid_certs(true);
    }

    builder
        .build()
        .map(MakeTlsConnector::new)
        .map_err(|error| error.to_string())
}

fn external_auth_accepts_invalid_certs() -> bool {
    std::env::var(ACCEPT_INVALID_CERTS_ENV)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}

#[async_trait]
impl ExternalAuthProvider for PostgresExternalAuthProvider {
    async fn get_user_by_identifier(
        &self,
        identifier: &str,
    ) -> Result<Option<ExternalAuthUser>, String> {
        let normalized = identifier.to_lowercase();
        self.query_user(
            "SELECT id, email, password_hash, display_name, created_at
             FROM users
             WHERE lower(email) = $1 OR lower(coalesce(display_name, '')) = $1
             LIMIT 1",
            &[&normalized],
        )
        .await
    }

    async fn get_user_by_id(&self, user_id: &str) -> Result<Option<ExternalAuthUser>, String> {
        self.query_user(
            "SELECT id, email, password_hash, display_name, created_at
             FROM users
             WHERE id = $1",
            &[&user_id],
        )
        .await
    }
}

fn map_row(row: Row) -> Result<ExternalAuthUser, String> {
    Ok(ExternalAuthUser {
        id: row.try_get("id").map_err(|error| error.to_string())?,
        email: row.try_get("email").map_err(|error| error.to_string())?,
        password_hash: row
            .try_get("password_hash")
            .map_err(|error| error.to_string())?,
        display_name: row
            .try_get("display_name")
            .map_err(|error| error.to_string())?,
        created_at: row
            .try_get("created_at")
            .map_err(|error| error.to_string())?,
    })
}

#[cfg(test)]
mod tests {
    use super::{external_auth_accepts_invalid_certs, ACCEPT_INVALID_CERTS_ENV};
    use std::sync::{LazyLock, Mutex};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn external_auth_tls_rejects_invalid_certs_by_default() {
        let _env_guard = ENV_LOCK.lock().expect("env lock should acquire");
        let original = std::env::var(ACCEPT_INVALID_CERTS_ENV).ok();
        std::env::remove_var(ACCEPT_INVALID_CERTS_ENV);

        assert!(!external_auth_accepts_invalid_certs());

        match original {
            Some(value) => std::env::set_var(ACCEPT_INVALID_CERTS_ENV, value),
            None => std::env::remove_var(ACCEPT_INVALID_CERTS_ENV),
        }
    }

    #[test]
    fn external_auth_tls_allows_invalid_certs_with_dev_flag() {
        let _env_guard = ENV_LOCK.lock().expect("env lock should acquire");
        let original = std::env::var(ACCEPT_INVALID_CERTS_ENV).ok();
        std::env::set_var(ACCEPT_INVALID_CERTS_ENV, "true");

        assert!(external_auth_accepts_invalid_certs());

        match original {
            Some(value) => std::env::set_var(ACCEPT_INVALID_CERTS_ENV, value),
            None => std::env::remove_var(ACCEPT_INVALID_CERTS_ENV),
        }
    }
}
