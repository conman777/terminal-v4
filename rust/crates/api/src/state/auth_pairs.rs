//! Session-bound credential pairs.
//!
//! A protocol-1 session owns exactly one live (access, refresh) pair at a time.
//! Each pair carries a per-session sequence number (`pair_seq`). Login, refresh
//! and logout all change that state inside one immediate SQLite transaction
//! taken under the authentication admission fence, so they are totally ordered.

use super::*;

pub(crate) const UPGRADE_REQUIRED_MESSAGE: &str = "This account requires an upgraded client";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefreshRejection {
    /// Unknown, expired, revoked or otherwise unusable refresh token.
    Invalid,
    /// The token was valid once and has already been rotated.
    Spent,
    /// The supplied access token belongs to a different pair than the refresh token.
    PairMismatch,
    /// The session is pair-bound and the request did not present its access token.
    PairRequired,
}

impl RefreshRejection {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid_refresh_token",
            Self::Spent => "refresh_token_spent",
            Self::PairMismatch => "pair_mismatch",
            Self::PairRequired => "pair_required",
        }
    }
}

#[derive(Debug)]
pub(crate) enum RefreshOutcome {
    Issued(AuthResult),
    Rejected(RefreshRejection),
}

pub(crate) struct RefreshRequest<'a> {
    pub(crate) refresh_token: &'a str,
    pub(crate) access_token: Option<&'a str>,
    pub(crate) pair_binding: bool,
    /// Client-generated identifier of one logical refresh attempt. A retry of
    /// the same token with the same identifier recovers a lost response.
    pub(crate) request_id: Option<&'a str>,
}

impl<'a> RefreshRequest<'a> {
    pub(crate) fn valid_request_id(&self) -> Option<&'a str> {
        self.request_id.filter(|id| {
            (16..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
    }

    pub(crate) fn unpaired(refresh_token: &'a str) -> Self {
        Self {
            refresh_token,
            access_token: None,
            pair_binding: false,
            request_id: None,
        }
    }
}

impl AppState {
    /// Enables or disables the server-side cutover that creates protocol-1
    /// sessions. Defaults to the `TERMINAL_V4_AUTH_SESSION_CUTOVER=1` environment
    /// variable. Disabling it never revokes existing sessions.
    pub fn set_auth_session_cutover(&self, enabled: bool) {
        self.inner
            .auth_session_cutover
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    /// Pairing codes and grants are tied to their issuing session only while
    /// the cutover switch is on, so nothing changes for legacy deployments.
    pub(crate) fn session_scoped_paired_access(&self) -> bool {
        self.auth_session_cutover_enabled()
    }

    pub(super) fn auth_session_cutover_enabled(&self) -> bool {
        self.inner
            .auth_session_cutover
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(super) fn refresh_token_was_spent(&self, token_hash: &str) -> Result<bool, String> {
        let connection = self.lock_db()?;
        connection
            .execute(
                "DELETE FROM auth_spent_refresh_tokens WHERE expires_at < ?",
                params![iso_timestamp()],
            )
            .map_err(|error| error.to_string())?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM auth_spent_refresh_tokens WHERE token_hash=?)",
                params![token_hash],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub(super) fn record_spent_refresh_token(
        connection: &Connection,
        stored: &StoredRefreshToken,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT OR REPLACE INTO auth_spent_refresh_tokens (token_hash,user_id,session_id,expires_at) VALUES (?1,?2,?3,?4)",
                params![stored.token_hash, stored.user_id, stored.session_id, stored.expires_at],
            )
            .map(|_| ())
            .map_err(|_| "Cannot record spent refresh token".into())
    }

    /// Access tokens of a pair-bound session must belong to the current pair or
    /// the one immediately before it (a short grace so a rotation does not cut off
    /// requests and streams that are already in flight).
    pub(super) fn validate_access_pair(
        connection: &Connection,
        user_id: &str,
        session_id: &str,
        pair: Option<i64>,
    ) -> Result<(), String> {
        let (seq, binding): (i64, bool) = connection
            .query_row(
                "SELECT pair_seq, pair_binding FROM auth_sessions WHERE id=?1 AND user_id=?2",
                params![session_id, user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Credential authority unavailable".to_string())?;
        if !binding {
            return Ok(());
        }
        match pair {
            Some(pair) if pair >= 1 && (pair == seq || pair + 1 == seq) => Ok(()),
            _ => Err("Credential belongs to an outdated token pair".into()),
        }
    }

    /// Deterministic successor token for a retryable refresh. It is derived
    /// from the server secret, the spent token and the client's request id, so
    /// the plaintext never has to be stored to hand the same token back.
    fn replay_refresh_token(&self, old_token: &str, request_id: &str) -> String {
        hash_token(&format!(
            "tv4-refresh-replay-v1\0{}\0{old_token}\0{request_id}",
            self.inner.config.jwt_secret
        ))
    }

    fn insert_pair_refresh_token(
        connection: &Connection,
        user_id: &str,
        session_id: &str,
        pair: i64,
        token: Option<String>,
    ) -> Result<String, String> {
        let token = Self::insert_scoped_refresh_token_with(
            connection,
            user_id,
            1,
            Some(session_id),
            token.unwrap_or_else(|| Uuid::new_v4().to_string()),
        )?;
        let updated = connection
            .execute(
                "UPDATE refresh_tokens SET pair_seq=?1 WHERE token_hash=?2",
                params![pair, hash_token(&token)],
            )
            .map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("Cannot bind refresh token to its pair".into());
        }
        Ok(token)
    }

    fn pair_auth_result(
        &self,
        user: UserPublic,
        refresh_token: String,
        generation: i64,
        session_id: &str,
        pair: i64,
        binding: bool,
        logout_capability: Option<String>,
    ) -> AuthResult {
        AuthResult {
            tokens: TokenPair {
                access_token: crate::auth::issue_access_token_for_pair(
                    &self.inner.config.jwt_secret,
                    &user.id,
                    &user.username,
                    generation,
                    1,
                    Some(session_id),
                    Some(pair),
                ),
                refresh_token,
            },
            user,
            session: Some(AuthSession {
                id: session_id.to_owned(),
                logout_capability,
                pair_seq: Some(pair),
                pair_binding: binding,
            }),
        }
    }

    fn insert_session_pair(
        &self,
        connection: &Connection,
        user: UserPublic,
        generation: i64,
        binding: bool,
    ) -> Result<AuthResult, String> {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let capability = hex::encode(bytes);
        let session_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO auth_sessions (id,user_id,generation,logout_capability_hash,revoked_at,created_at,pair_seq,pair_binding) VALUES (?1,?2,?3,?4,NULL,?5,1,?6)",
                params![session_id, user.id, generation, hash_token(&capability), iso_timestamp(), binding],
            )
            .map_err(|_| "Cannot create authentication session")?;
        let refresh = Self::insert_pair_refresh_token(connection, &user.id, &session_id, 1, None)?;
        Ok(self.pair_auth_result(
            user,
            refresh,
            generation,
            &session_id,
            1,
            binding,
            Some(capability),
        ))
    }

    /// Issues a login pair for an account that is, or is being, cut over to
    /// session credentials. Returns `None` when the account is still legacy and
    /// the client did not opt in, so the caller issues a legacy pair.
    #[cfg(unix)]
    pub(super) fn issue_session_login(
        &self,
        user: &UserPublic,
        pair_binding: bool,
    ) -> Result<Option<AuthResult>, String> {
        crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            &user.username,
        )?;
        let owner_guard = owner_input::acquire(
            &self.inner.config.data_dir,
            &user.id,
            std::time::Duration::from_secs(3),
        )?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        match Self::auth_protocol_minimum(&transaction, &user.id)? {
            0 if !pair_binding => return Ok(None),
            0 => Self::activate_account_protocol(&transaction, &user.id, &owner_guard)?,
            1 => {}
            _ => return Err(UPGRADE_REQUIRED_MESSAGE.into()),
        }
        let generation = Self::auth_generation(&transaction, &user.id)?;
        let result =
            self.insert_session_pair(&transaction, user.clone(), generation, pair_binding)?;
        admission.validate(&transaction)?;
        transaction
            .commit()
            .map_err(|_| "Authentication outcome is uncertain")?;
        Ok(Some(result))
    }

    /// Marks the whole account as requiring session credentials. Unlike the
    /// earlier prototype this neither bumps the generation nor deletes refresh
    /// tokens: protocol-0 access tokens stop working immediately (their protocol
    /// no longer matches), but each protocol-0 refresh token stays redeemable
    /// exactly once, for a session pair.
    #[cfg(unix)]
    fn activate_account_protocol(
        transaction: &rusqlite::Transaction<'_>,
        user_id: &str,
        owner_guard: &owner_input::OwnerInputGuard,
    ) -> Result<(), String> {
        if owner_input::installed(transaction)? {
            owner_guard.bind(transaction)?;
        }
        let updated = transaction
            .execute(
                "UPDATE users SET auth_protocol_min=1 WHERE id=? AND auth_protocol_min=0",
                params![user_id],
            )
            .map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("Credential authority unavailable".into());
        }
        Self::record_cutover_fence(transaction)?;
        Self::verify_auth_protocol_integrity(transaction)
    }

    #[cfg(unix)]
    pub(super) fn upgrade_legacy_refresh(
        &self,
        stored: &StoredRefreshToken,
        user: UserPublic,
        request: &RefreshRequest<'_>,
    ) -> Result<RefreshOutcome, String> {
        let invalid = RefreshOutcome::Rejected(RefreshRejection::Invalid);
        let owner_guard = owner_input::acquire(
            &self.inner.config.data_dir,
            &user.id,
            std::time::Duration::from_secs(3),
        )?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        match Self::auth_protocol_minimum(&transaction, &user.id)? {
            0 if request.pair_binding => {
                Self::activate_account_protocol(&transaction, &user.id, &owner_guard)?
            }
            1 => {}
            _ => return Ok(invalid),
        }
        let consumed = transaction
            .execute(
                "DELETE FROM refresh_tokens WHERE id=? AND user_id=? AND expires_at>=? AND auth_protocol=0",
                params![stored.id, user.id, iso_timestamp()],
            )
            .map_err(|error| error.to_string())?;
        if consumed != 1 {
            return Ok(RefreshOutcome::Rejected(RefreshRejection::Spent));
        }
        Self::record_spent_refresh_token(&transaction, stored)?;
        let generation = Self::auth_generation(&transaction, &user.id)?;
        let result =
            self.insert_session_pair(&transaction, user, generation, request.pair_binding)?;
        admission.validate(&transaction)?;
        transaction
            .commit()
            .map_err(|_| "Authentication outcome is uncertain")?;
        Ok(RefreshOutcome::Issued(result))
    }

    #[cfg(unix)]
    pub(super) fn rotate_session_pair(
        &self,
        stored: &StoredRefreshToken,
        user: UserPublic,
        request: &RefreshRequest<'_>,
    ) -> Result<RefreshOutcome, String> {
        let invalid = RefreshOutcome::Rejected(RefreshRejection::Invalid);
        let Some(session_id) = stored.session_id.as_deref() else {
            return Ok(invalid);
        };
        let _owner_guard = owner_input::acquire(
            &self.inner.config.data_dir,
            &user.id,
            std::time::Duration::from_secs(3),
        )?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        if Self::auth_protocol_minimum(&transaction, &user.id)? != 1 {
            return Ok(invalid);
        }
        let generation = Self::auth_generation(&transaction, &user.id)?;
        let Some((current, binding)) = transaction
            .query_row(
                "SELECT pair_seq, pair_binding FROM auth_sessions WHERE id=?1 AND user_id=?2 AND generation=?3 AND revoked_at IS NULL",
                params![session_id, user.id, generation],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()
            .map_err(|_| "Credential authority unavailable")?
        else {
            return Ok(invalid);
        };
        let live: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM refresh_tokens WHERE id=?1 AND user_id=?2 AND session_id=?3 AND auth_protocol=1 AND expires_at>=?4 AND COALESCE(pair_seq,0)=?5)",
                params![stored.id, user.id, session_id, iso_timestamp(), current],
                |row| row.get(0),
            )
            .map_err(|_| "Credential authority unavailable")?;
        if !live {
            return Ok(RefreshOutcome::Rejected(RefreshRejection::Spent));
        }
        match request.access_token {
            Some(access) => {
                let expected = (current >= 1).then_some(current);
                let matches =
                    crate::auth::access_pair_claims(&self.inner.config.jwt_secret, access)
                        .is_some_and(|claims| {
                            claims.owner == user.id
                                && claims.session_id.as_deref() == Some(session_id)
                                && claims.pair == expected
                        });
                if !matches {
                    return Ok(RefreshOutcome::Rejected(RefreshRejection::PairMismatch));
                }
            }
            None if binding => {
                return Ok(RefreshOutcome::Rejected(RefreshRejection::PairRequired));
            }
            None => {}
        }
        let next = current + 1;
        let binding = binding || request.pair_binding;
        let advanced = transaction
            .execute(
                "UPDATE auth_sessions SET pair_seq=?1, pair_binding=?2 WHERE id=?3 AND user_id=?4 AND pair_seq=?5 AND revoked_at IS NULL",
                params![next, binding, session_id, user.id, current],
            )
            .map_err(|_| "Cannot advance authentication pair")?;
        let consumed = transaction
            .execute(
                "DELETE FROM refresh_tokens WHERE id=?1 AND user_id=?2 AND session_id=?3",
                params![stored.id, user.id, session_id],
            )
            .map_err(|_| "Cannot consume refresh token")?;
        if advanced != 1 || consumed != 1 {
            return Ok(RefreshOutcome::Rejected(RefreshRejection::Spent));
        }
        Self::record_spent_refresh_token(&transaction, stored)?;
        let request_id = request
            .valid_request_id()
            .filter(|_| self.auth_session_cutover_enabled());
        let refresh = Self::insert_pair_refresh_token(
            &transaction,
            &user.id,
            session_id,
            next,
            request_id.map(|id| self.replay_refresh_token(request.refresh_token, id)),
        )?;
        if let Some(id) = request_id {
            let now = crate::v4_agent::interaction::now_ms();
            transaction
                .execute(
                    "DELETE FROM auth_refresh_replays WHERE expires_ms<=?1",
                    params![now],
                )
                .and_then(|_| {
                    transaction.execute(
                        "INSERT OR REPLACE INTO auth_refresh_replays (old_token_hash,request_hash,user_id,session_id,new_token_hash,expires_ms) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![
                            stored.token_hash,
                            hash_token(id),
                            user.id,
                            session_id,
                            hash_token(&refresh),
                            now + super::auth_fence::REFRESH_REPLAY_WINDOW_MS
                        ],
                    )
                })
                .map_err(|_| "Cannot record refresh retry window")?;
        }
        let result =
            self.pair_auth_result(user, refresh, generation, session_id, next, binding, None);
        admission.validate(&transaction)?;
        transaction
            .commit()
            .map_err(|_| "Authentication outcome is uncertain")?;
        Ok(RefreshOutcome::Issued(result))
    }

    /// Returns the pair a lost refresh response carried, when the very same
    /// request (spent token plus client request id) is repeated inside the
    /// retry window and the pair it produced is still the session's live one.
    /// Anything else stays an ordinary replay of a spent token.
    #[cfg(unix)]
    pub(super) fn replay_lost_refresh(
        &self,
        request: &RefreshRequest<'_>,
    ) -> Result<Option<RefreshOutcome>, String> {
        let Some(request_id) = request.valid_request_id() else {
            return Ok(None);
        };
        if !self.auth_session_cutover_enabled() {
            return Ok(None);
        }
        let old_hash = hash_token(request.refresh_token);
        let request_hash = hash_token(request_id);
        let lookup = |connection: &Connection| -> Result<Option<(String, String, String)>, String> {
            if !Self::table_present(connection, "auth_refresh_replays")? {
                return Ok(None);
            }
            connection
                .query_row(
                    "SELECT user_id,session_id,new_token_hash FROM auth_refresh_replays WHERE old_token_hash=?1 AND request_hash=?2 AND expires_ms>?3",
                    params![old_hash, request_hash, crate::v4_agent::interaction::now_ms()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|_| "Credential authority unavailable".to_string())
        };
        let peeked = {
            let connection = self.lock_db()?;
            lookup(&connection)?
        };
        let Some((user_id, _, _)) = peeked else {
            return Ok(None);
        };
        let Some(user) = self.get_user_by_id(&user_id)? else {
            return Ok(None);
        };
        let user = to_public_user(&user);
        if crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            &user.username,
        )
        .is_err()
        {
            return Ok(None);
        }
        let _owner_guard = owner_input::acquire(
            &self.inner.config.data_dir,
            &user.id,
            std::time::Duration::from_secs(3),
        )?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        if Self::auth_protocol_minimum(&transaction, &user.id)? != 1 {
            return Ok(None);
        }
        let Some((user_id, session_id, new_hash)) = lookup(&transaction)? else {
            return Ok(None);
        };
        if user_id != user.id {
            return Ok(None);
        }
        let generation = Self::auth_generation(&transaction, &user.id)?;
        let Some((current, binding)) = transaction
            .query_row(
                "SELECT pair_seq, pair_binding FROM auth_sessions WHERE id=?1 AND user_id=?2 AND generation=?3 AND revoked_at IS NULL",
                params![session_id, user.id, generation],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()
            .map_err(|_| "Credential authority unavailable")?
        else {
            return Ok(None);
        };
        let live: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM refresh_tokens WHERE token_hash=?1 AND user_id=?2 AND session_id=?3 AND auth_protocol=1 AND expires_at>=?4 AND COALESCE(pair_seq,0)=?5)",
                params![new_hash, user.id, session_id, iso_timestamp(), current],
                |row| row.get(0),
            )
            .map_err(|_| "Credential authority unavailable")?;
        let refresh = self.replay_refresh_token(request.refresh_token, request_id);
        if !live || current < 2 || hash_token(&refresh) != new_hash {
            return Ok(None);
        }
        match request.access_token {
            Some(access) => {
                let matches =
                    crate::auth::access_pair_claims(&self.inner.config.jwt_secret, access)
                        .is_some_and(|claims| {
                            claims.owner == user.id
                                && claims.session_id.as_deref() == Some(session_id.as_str())
                                && claims.pair == Some(current - 1)
                        });
                if !matches {
                    return Ok(Some(RefreshOutcome::Rejected(
                        RefreshRejection::PairMismatch,
                    )));
                }
            }
            None if binding => {
                return Ok(Some(RefreshOutcome::Rejected(
                    RefreshRejection::PairRequired,
                )));
            }
            None => {}
        }
        admission.validate(&transaction)?;
        let result = self.pair_auth_result(
            user,
            refresh,
            generation,
            &session_id,
            current,
            binding,
            None,
        );
        Ok(Some(RefreshOutcome::Issued(result)))
    }
}
