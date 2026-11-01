//! Durable fence for accounts that used the session-credential cutover.
//!
//! The first cutover records a schema marker and installs a database trigger.
//! A newer server refuses to run against a marker it does not understand, and
//! an older binary sharing the data directory cannot insert protocol-0 refresh
//! tokens for a cut-over account: the insert aborts inside SQLite. Nothing is
//! written until the cutover is actually used.

use super::*;

pub(crate) const AUTH_CUTOVER_SCHEMA_VERSION: i64 = 1;
pub(super) const REFRESH_REPLAY_WINDOW_MS: i64 = 30_000;
const FENCE_TRIGGER: &str = "auth_cutover_no_legacy_refresh";
pub(super) const LEGACY_MINT_REFUSED: &str =
    "Cannot mint legacy credentials for a cut over account";

fn table_exists(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            params![name],
            |row| row.get(0),
        )
        .map_err(|_| "Credential authority unavailable".to_string())
}

impl AppState {
    pub(super) fn table_present(connection: &Connection, name: &str) -> Result<bool, String> {
        table_exists(connection, name)
    }

    /// Records the cutover marker, the retry-window table and the trigger that
    /// aborts protocol-0 refresh-token inserts for cut-over accounts.
    pub(super) fn record_cutover_fence(connection: &Connection) -> Result<(), String> {
        Self::check_marker_version(connection)?;
        connection
            .execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS auth_cutover_fence (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, activated_at TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS auth_refresh_replays (old_token_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL, new_token_hash TEXT NOT NULL, expires_ms INTEGER NOT NULL);
                 CREATE TRIGGER IF NOT EXISTS {FENCE_TRIGGER} BEFORE INSERT ON refresh_tokens
                 WHEN NEW.auth_protocol=0 AND COALESCE((SELECT auth_protocol_min FROM users WHERE id=NEW.user_id),0)=1
                 BEGIN SELECT RAISE(ABORT, 'cut-over account requires session credentials'); END;"
            ))
            .map_err(|_| "Cannot record the authentication cutover fence".to_string())?;
        connection
            .execute(
                "INSERT INTO auth_cutover_fence (id,schema_version,activated_at) VALUES (1,?1,?2) ON CONFLICT(id) DO UPDATE SET schema_version=MAX(schema_version, excluded.schema_version)",
                params![AUTH_CUTOVER_SCHEMA_VERSION, iso_timestamp()],
            )
            .map(|_| ())
            .map_err(|_| "Cannot record the authentication cutover fence".to_string())
    }

    /// Fails closed when the marker is newer than this binary or the trigger
    /// that protects cut-over accounts has been removed. Inert until a cutover
    /// has been recorded.
    pub(super) fn verify_cutover_fence(connection: &Connection) -> Result<(), String> {
        if !table_exists(connection, "auth_cutover_fence")? {
            return Ok(());
        }
        Self::check_marker_version(connection)?;
        let trigger: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",
                params![FENCE_TRIGGER],
                |row| row.get(0),
            )
            .map_err(|_| "Credential authority unavailable".to_string())?;
        if !trigger || !table_exists(connection, "auth_refresh_replays")? {
            return Err("Authentication cutover fence was removed; refusing to run because another server may have modified this data directory".into());
        }
        Ok(())
    }

    fn check_marker_version(connection: &Connection) -> Result<(), String> {
        if !table_exists(connection, "auth_cutover_fence")? {
            return Ok(());
        }
        let version: Option<i64> = connection
            .query_row(
                "SELECT schema_version FROM auth_cutover_fence WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Credential authority unavailable".to_string())?;
        let Some(version) = version else {
            return Err("Authentication cutover fence is incomplete; refusing to run".into());
        };
        if version > AUTH_CUTOVER_SCHEMA_VERSION {
            return Err(format!(
                "This data directory was cut over by a newer server (authentication schema {version}; this binary supports {AUTH_CUTOVER_SCHEMA_VERSION}). Run the newer server or restore a backup."
            ));
        }
        Ok(())
    }

    /// Records the fence for a database that was cut over before the marker
    /// existed.
    pub(super) fn adopt_existing_cutover(connection: &Connection) -> Result<(), String> {
        let activated: i64 = connection
            .query_row(
                "SELECT activated_count FROM auth_protocol_account_integrity WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "Credential authority unavailable".to_string())?;
        if activated > 0 || table_exists(connection, "auth_cutover_fence")? {
            Self::record_cutover_fence(connection)?;
        }
        Ok(())
    }

    pub(super) fn purge_refresh_replays(
        connection: &Connection,
        user_id: &str,
        session_id: Option<&str>,
    ) -> Result<(), String> {
        if !table_exists(connection, "auth_refresh_replays")? {
            return Ok(());
        }
        let result = match session_id {
            Some(session) => connection.execute(
                "DELETE FROM auth_refresh_replays WHERE user_id=?1 AND session_id=?2",
                params![user_id, session],
            ),
            None => connection.execute(
                "DELETE FROM auth_refresh_replays WHERE user_id=?1",
                params![user_id],
            ),
        };
        result
            .map(|_| ())
            .map_err(|_| "Cannot discard refresh retry history".to_string())
    }
}
