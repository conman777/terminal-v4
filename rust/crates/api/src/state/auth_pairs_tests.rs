#![cfg(unix)]

use super::*;

fn fixture(cutover: bool) -> (tempfile::TempDir, AppState) {
    let data = tempfile::tempdir().unwrap();
    let state = AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "auth-pairs-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    state.set_auth_session_cutover(cutover);
    (data, state)
}

fn request<'a>(refresh: &'a str, access: Option<&'a str>, binding: bool) -> RefreshRequest<'a> {
    RefreshRequest {
        refresh_token: refresh,
        access_token: access,
        pair_binding: binding,
        request_id: None,
    }
}

fn retry<'a>(refresh: &'a str, access: Option<&'a str>, request_id: &'a str) -> RefreshRequest<'a> {
    RefreshRequest {
        request_id: Some(request_id),
        ..request(refresh, access, false)
    }
}

const REQUEST_ID: &str = "0123456789abcdef0123456789abcdef";

async fn issued(state: &AppState, request: RefreshRequest<'_>) -> AuthResult {
    match state.refresh_auth_pair(request).await.unwrap() {
        RefreshOutcome::Issued(result) => result,
        RefreshOutcome::Rejected(reason) => panic!("refresh rejected: {reason:?}"),
    }
}

async fn rejected(state: &AppState, request: RefreshRequest<'_>) -> RefreshRejection {
    match state.refresh_auth_pair(request).await.unwrap() {
        RefreshOutcome::Rejected(reason) => reason,
        RefreshOutcome::Issued(_) => panic!("refresh unexpectedly issued a pair"),
    }
}

fn authorizes(state: &AppState, access: &str) -> bool {
    crate::auth::authenticate_local_token(state, access).is_ok()
}

fn account_protocol(state: &AppState, owner: &str) -> i64 {
    let connection = state.lock_db().unwrap();
    AppState::auth_protocol_minimum(&connection, owner).unwrap()
}

async fn bound_login(state: &AppState) -> AuthResult {
    state
        .login_with("fixture", "fixture-password", true)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn cutover_is_off_by_default_and_a_binding_login_stays_legacy() {
    let (_data, state) = fixture(false);
    let login = bound_login(&state).await;
    assert_eq!(login.session, None);
    assert_eq!(account_protocol(&state, &login.user.id), 0);
    assert!(authorizes(&state, &login.tokens.access_token));
}

#[tokio::test]
async fn login_without_opt_in_keeps_a_legacy_account_legacy() {
    let (_data, state) = fixture(true);
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(login.session, None);
    assert_eq!(account_protocol(&state, &login.user.id), 0);
}

#[tokio::test]
async fn binding_login_creates_a_bound_session_pair_without_signing_out_legacy_tabs() {
    let (_data, state) = fixture(true);
    let legacy_tab = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let login = bound_login(&state).await;
    let session = login.session.as_ref().unwrap();
    assert_eq!(
        (
            session.pair_seq,
            session.pair_binding,
            session.logout_capability.is_some()
        ),
        (Some(1), true, true)
    );
    assert_eq!(account_protocol(&state, &login.user.id), 1);
    assert!(authorizes(&state, &login.tokens.access_token));

    assert!(!authorizes(&state, &legacy_tab.tokens.access_token));
    let migrated = issued(
        &state,
        request(&legacy_tab.tokens.refresh_token, None, false),
    )
    .await;
    let migrated_session = migrated.session.as_ref().unwrap();
    assert_eq!(
        (migrated_session.pair_seq, migrated_session.pair_binding),
        (Some(1), false)
    );
    assert_ne!(migrated_session.id, session.id);
    assert!(authorizes(&state, &migrated.tokens.access_token));
    assert!(authorizes(&state, &login.tokens.access_token));
}

#[tokio::test]
async fn legacy_refresh_with_opt_in_cuts_the_account_over_and_every_legacy_tab_migrates_once() {
    let (_data, state) = fixture(true);
    let tab_a = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let tab_b = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let owner = tab_a.user.id.clone();

    let first = issued(&state, request(&tab_a.tokens.refresh_token, None, true)).await;
    assert_eq!(account_protocol(&state, &owner), 1);
    assert!(first.session.as_ref().unwrap().pair_binding);
    assert!(!authorizes(&state, &tab_a.tokens.access_token));
    assert!(!authorizes(&state, &tab_b.tokens.access_token));

    let second = issued(&state, request(&tab_b.tokens.refresh_token, None, false)).await;
    assert!(authorizes(&state, &second.tokens.access_token));
    assert_eq!(
        rejected(&state, request(&tab_b.tokens.refresh_token, None, false)).await,
        RefreshRejection::Spent
    );
    let generation = {
        let connection = state.lock_db().unwrap();
        AppState::auth_generation(&connection, &owner).unwrap()
    };
    assert_eq!(generation, 0);
}

#[tokio::test]
async fn legacy_refresh_without_opt_in_never_triggers_the_cutover() {
    let (_data, state) = fixture(true);
    let tab = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let refreshed = issued(&state, request(&tab.tokens.refresh_token, None, false)).await;
    assert_eq!(refreshed.session, None);
    assert_eq!(account_protocol(&state, &tab.user.id), 0);
    assert!(authorizes(&state, &refreshed.tokens.access_token));
}

#[tokio::test]
async fn rotation_advances_the_pair_and_spent_tokens_cannot_be_replayed() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let second = issued(
        &state,
        request(
            &first.tokens.refresh_token,
            Some(&first.tokens.access_token),
            false,
        ),
    )
    .await;
    assert_eq!(second.session.as_ref().unwrap().pair_seq, Some(2));
    assert_eq!(second.session.as_ref().unwrap().logout_capability, None);
    assert_eq!(
        rejected(
            &state,
            request(
                &first.tokens.refresh_token,
                Some(&first.tokens.access_token),
                false
            )
        )
        .await,
        RefreshRejection::Spent
    );
    assert_eq!(
        rejected(&state, request("never-issued", None, false)).await,
        RefreshRejection::Invalid
    );
    let third = issued(
        &state,
        request(
            &second.tokens.refresh_token,
            Some(&second.tokens.access_token),
            false,
        ),
    )
    .await;
    assert_eq!(third.session.as_ref().unwrap().pair_seq, Some(3));
    let live: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM refresh_tokens WHERE user_id=?",
            [&first.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live, 1);
}

#[tokio::test]
async fn mixed_pairs_are_rejected_without_consuming_the_refresh_token() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let second = issued(
        &state,
        request(
            &first.tokens.refresh_token,
            Some(&first.tokens.access_token),
            false,
        ),
    )
    .await;
    assert_eq!(
        rejected(
            &state,
            request(
                &second.tokens.refresh_token,
                Some(&first.tokens.access_token),
                false
            )
        )
        .await,
        RefreshRejection::PairMismatch
    );
    assert_eq!(
        rejected(&state, request(&second.tokens.refresh_token, None, false)).await,
        RefreshRejection::PairRequired
    );
    let other = bound_login(&state).await;
    assert_eq!(
        rejected(
            &state,
            request(
                &second.tokens.refresh_token,
                Some(&other.tokens.access_token),
                false
            )
        )
        .await,
        RefreshRejection::PairMismatch
    );
    assert_eq!(
        rejected(
            &state,
            request(&second.tokens.refresh_token, Some("not-a-token"), false)
        )
        .await,
        RefreshRejection::PairMismatch
    );
    issued(
        &state,
        request(
            &second.tokens.refresh_token,
            Some(&second.tokens.access_token),
            false,
        ),
    )
    .await;
}

#[tokio::test]
async fn an_expired_access_token_still_proves_its_pair_at_refresh() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let expired = {
        use jsonwebtoken::{encode, EncodingKey, Header};
        let claims = serde_json::json!({
            "sub": login.user.id, "username": login.user.username, "exp": 1, "iat": 0,
            "token_kind": "access", "generation": 0, "auth_protocol": 1,
            "session_id": login.session.as_ref().unwrap().id, "pair": 1
        });
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(state.config().jwt_secret.as_bytes()),
        )
        .unwrap()
    };
    assert!(!authorizes(&state, &expired));
    issued(
        &state,
        request(&login.tokens.refresh_token, Some(&expired), false),
    )
    .await;
}

#[tokio::test]
async fn bound_access_tokens_survive_one_rotation_but_not_two() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let second = issued(
        &state,
        request(
            &first.tokens.refresh_token,
            Some(&first.tokens.access_token),
            false,
        ),
    )
    .await;
    assert!(authorizes(&state, &first.tokens.access_token));
    assert!(authorizes(&state, &second.tokens.access_token));
    let third = issued(
        &state,
        request(
            &second.tokens.refresh_token,
            Some(&second.tokens.access_token),
            false,
        ),
    )
    .await;
    assert!(!authorizes(&state, &first.tokens.access_token));
    assert!(authorizes(&state, &second.tokens.access_token));
    assert!(authorizes(&state, &third.tokens.access_token));
}

#[tokio::test]
async fn an_existing_unpaired_session_adopts_pairs_and_can_opt_in_to_binding() {
    let (_data, state) = fixture(false);
    let user = state
        .get_user_public_by_id(&state.get_user_by_username("fixture").unwrap().unwrap().id)
        .unwrap()
        .unwrap();
    let old = state.issue_auth_session_for_test(user).unwrap();
    assert_eq!(old.session.as_ref().unwrap().pair_seq, None);
    let adopted = issued(&state, request(&old.tokens.refresh_token, None, false)).await;
    let session = adopted.session.as_ref().unwrap();
    assert_eq!((session.pair_seq, session.pair_binding), (Some(1), false));
    let bound = issued(&state, request(&adopted.tokens.refresh_token, None, true)).await;
    assert!(bound.session.as_ref().unwrap().pair_binding);
    assert_eq!(
        rejected(&state, request(&bound.tokens.refresh_token, None, false)).await,
        RefreshRejection::PairRequired
    );
}

#[tokio::test]
async fn cut_over_account_refuses_legacy_login_explicitly_only_while_cutover_is_disabled() {
    let (_data, state) = fixture(true);
    bound_login(&state).await;
    state.set_auth_session_cutover(false);
    let error = state
        .login("fixture", "fixture-password")
        .await
        .unwrap_err();
    assert_eq!(error, UPGRADE_REQUIRED_MESSAGE);
    state.set_auth_session_cutover(true);
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    assert!(!login.session.as_ref().unwrap().pair_binding);
}

#[tokio::test]
async fn refresh_then_logout_leaves_no_usable_pair() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let next = issued(
        &state,
        request(
            &login.tokens.refresh_token,
            Some(&login.tokens.access_token),
            false,
        ),
    )
    .await;
    let (_, authority) =
        crate::auth::authenticate_local_with_authority(&state, &next.tokens.access_token).unwrap();
    assert!(state
        .logout_user_authorized(&login.user.id, &authority)
        .unwrap());
    assert!(!authorizes(&state, &next.tokens.access_token));
    assert!(!authorizes(&state, &login.tokens.access_token));
    assert_eq!(
        rejected(
            &state,
            request(
                &next.tokens.refresh_token,
                Some(&next.tokens.access_token),
                false
            )
        )
        .await,
        RefreshRejection::Invalid
    );
    assert_eq!(
        rejected(&state, request(&login.tokens.refresh_token, None, false)).await,
        RefreshRejection::Invalid
    );
}

#[tokio::test]
async fn logout_then_refresh_cannot_publish_a_pair() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let (_, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    assert!(state
        .logout_user_authorized(&login.user.id, &authority)
        .unwrap());
    assert_eq!(
        rejected(
            &state,
            request(
                &login.tokens.refresh_token,
                Some(&login.tokens.access_token),
                false
            )
        )
        .await,
        RefreshRejection::Invalid
    );
    let tokens: i64 = state
        .lock_db()
        .unwrap()
        .query_row("SELECT count(*) FROM refresh_tokens", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tokens, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn logout_racing_refresh_never_leaves_a_usable_pair_behind() {
    let (_data, state) = fixture(true);
    for round in 0..24 {
        let login = bound_login(&state).await;
        let session = login.session.clone().unwrap();
        let (_, authority) =
            crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token)
                .unwrap();
        let refreshers: Vec<_> = (0..3)
            .map(|_| {
                let state = state.clone();
                let refresh = login.tokens.refresh_token.clone();
                let access = login.tokens.access_token.clone();
                tokio::spawn(async move {
                    match state
                        .refresh_auth_pair(request(&refresh, Some(&access), false))
                        .await
                        .unwrap()
                    {
                        RefreshOutcome::Issued(result) => Some(result),
                        RefreshOutcome::Rejected(_) => None,
                    }
                })
            })
            .collect();
        if round % 2 == 0 {
            tokio::task::yield_now().await;
        }
        let logout = {
            let state = state.clone();
            let owner = login.user.id.clone();
            tokio::task::spawn_blocking(move || state.logout_user_authorized(&owner, &authority))
        };
        assert!(logout.await.unwrap().unwrap());
        let mut winners = 0;
        for refresher in refreshers {
            if let Some(result) = refresher.await.unwrap() {
                winners += 1;
                assert!(!authorizes(&state, &result.tokens.access_token));
                assert_eq!(
                    rejected(
                        &state,
                        request(
                            &result.tokens.refresh_token,
                            Some(&result.tokens.access_token),
                            false
                        )
                    )
                    .await,
                    RefreshRejection::Invalid
                );
            }
        }
        assert!(winners <= 1, "a refresh token redeemed more than once");
        let remaining: i64 = state
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM refresh_tokens WHERE session_id=?",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_refreshes_of_one_token_redeem_it_exactly_once() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let attempts: Vec<_> = (0..6)
        .map(|_| {
            let state = state.clone();
            let refresh = login.tokens.refresh_token.clone();
            let access = login.tokens.access_token.clone();
            tokio::spawn(async move {
                state
                    .refresh_auth_pair(request(&refresh, Some(&access), false))
                    .await
                    .unwrap()
            })
        })
        .collect();
    let mut issued_count = 0;
    for attempt in attempts {
        match attempt.await.unwrap() {
            RefreshOutcome::Issued(_) => issued_count += 1,
            RefreshOutcome::Rejected(reason) => assert_eq!(reason, RefreshRejection::Spent),
        }
    }
    assert_eq!(issued_count, 1);
}

#[tokio::test]
async fn schema_migration_adds_pair_columns_without_losing_sessions() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "auth-pairs-migration".into(),
        ..Default::default()
    };
    let session = {
        let state = AppState::new(config.clone()).unwrap();
        let user = state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let session = state.issue_auth_session_for_test(user).unwrap();
        state
            .lock_db()
            .unwrap()
            .execute_batch(
                "ALTER TABLE auth_sessions DROP COLUMN pair_seq;
                 ALTER TABLE auth_sessions DROP COLUMN pair_binding;
                 ALTER TABLE refresh_tokens DROP COLUMN pair_seq;
                 DROP TABLE auth_spent_refresh_tokens;",
            )
            .unwrap();
        session
    };
    for _ in 0..2 {
        let state = AppState::new(config.clone()).unwrap();
        let columns: i64 = state
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM pragma_table_info('auth_sessions') WHERE name IN ('pair_seq','pair_binding')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 2);
        assert!(authorizes(&state, &session.tokens.access_token));
    }
    let state = AppState::new(config).unwrap();
    let rotated = issued(&state, request(&session.tokens.refresh_token, None, false)).await;
    assert_eq!(rotated.session.as_ref().unwrap().pair_seq, Some(1));
    assert_eq!(
        rejected(&state, request(&session.tokens.refresh_token, None, false)).await,
        RefreshRejection::Spent
    );
}

#[tokio::test]
async fn spent_history_is_pruned_when_it_expires_and_cleared_by_logout() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let next = issued(
        &state,
        request(
            &login.tokens.refresh_token,
            Some(&login.tokens.access_token),
            false,
        ),
    )
    .await;
    state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE auth_spent_refresh_tokens SET expires_at='2000-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
    assert_eq!(
        rejected(&state, request(&login.tokens.refresh_token, None, false)).await,
        RefreshRejection::Invalid
    );
    let again = issued(
        &state,
        request(
            &next.tokens.refresh_token,
            Some(&next.tokens.access_token),
            false,
        ),
    )
    .await;
    let (_, authority) =
        crate::auth::authenticate_local_with_authority(&state, &again.tokens.access_token).unwrap();
    assert!(state
        .logout_user_authorized(&login.user.id, &authority)
        .unwrap());
    let history: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM auth_spent_refresh_tokens",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history, 0);
}

fn fence_version(state: &AppState) -> Option<i64> {
    let connection = state.lock_db().unwrap();
    connection
        .query_row(
            "SELECT schema_version FROM auth_cutover_fence WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

#[tokio::test]
async fn fence_marker_is_absent_until_cutover_is_used() {
    let (_data, state) = fixture(false);
    let login = bound_login(&state).await;
    assert_eq!(login.session, None);
    assert_eq!(fence_version(&state), None);
    let connection = state.lock_db().unwrap();
    assert!(AppState::verify_cutover_fence(&connection).is_ok());
}

#[tokio::test]
async fn cutover_records_a_durable_marker_and_refuses_protocol_zero_credentials() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    assert_eq!(fence_version(&state), Some(AUTH_CUTOVER_SCHEMA_VERSION));
    let connection = state.lock_db().unwrap();
    let minted = AppState::insert_scoped_refresh_token(&connection, &login.user.id, 0, None);
    assert!(minted.unwrap_err().contains("cut over"));
}

#[tokio::test]
async fn older_binary_refresh_insert_is_aborted_by_the_database() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let connection = state.lock_db().unwrap();
    let error = connection
        .execute(
            "INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at,created_at) VALUES ('old-writer',?1,'h','2999-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            params![login.user.id],
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("cut-over account"), "{error}");
}

#[tokio::test]
async fn a_marker_from_a_newer_server_makes_this_server_fail_closed() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE auth_cutover_fence SET schema_version=99 WHERE id=1",
            [],
        )
        .unwrap();
    {
        let connection = state.lock_db().unwrap();
        let error = AppState::auth_protocol_minimum(&connection, &login.user.id).unwrap_err();
        assert!(error.contains("newer server"), "{error}");
    }
    assert!(state
        .initialize_schema()
        .unwrap_err()
        .contains("newer server"));
    assert!(state
        .login_with("fixture", "fixture-password", true)
        .await
        .is_err());
}

#[tokio::test]
async fn a_removed_fence_trigger_is_detected() {
    let (_data, state) = fixture(true);
    let login = bound_login(&state).await;
    let connection = state.lock_db().unwrap();
    connection
        .execute_batch("DROP TRIGGER auth_cutover_no_legacy_refresh")
        .unwrap();
    let error = AppState::auth_protocol_minimum(&connection, &login.user.id).unwrap_err();
    assert!(error.contains("fence"), "{error}");
}

fn replay_rows(state: &AppState) -> i64 {
    let connection = state.lock_db().unwrap();
    connection
        .query_row("SELECT count(*) FROM auth_refresh_replays", [], |row| {
            row.get(0)
        })
        .unwrap_or(0)
}

#[tokio::test]
async fn a_lost_refresh_response_is_recovered_by_retrying_the_same_request() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let (old_refresh, old_access) = (
        first.tokens.refresh_token.clone(),
        first.tokens.access_token.clone(),
    );
    let lost = issued(&state, retry(&old_refresh, Some(&old_access), REQUEST_ID)).await;
    let recovered = issued(&state, retry(&old_refresh, Some(&old_access), REQUEST_ID)).await;
    assert_eq!(recovered.tokens.refresh_token, lost.tokens.refresh_token);
    assert_eq!(
        recovered
            .session
            .as_ref()
            .map(|s| (s.id.clone(), s.pair_seq)),
        lost.session.as_ref().map(|s| (s.id.clone(), s.pair_seq))
    );
    assert!(authorizes(&state, &recovered.tokens.access_token));
    let next = issued(
        &state,
        request(
            &recovered.tokens.refresh_token,
            Some(&recovered.tokens.access_token),
            false,
        ),
    )
    .await;
    assert_eq!(next.session.unwrap().pair_seq, Some(3));
}

#[tokio::test]
async fn retries_without_the_matching_request_id_remain_replays() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let (refresh, access) = (
        first.tokens.refresh_token.clone(),
        first.tokens.access_token.clone(),
    );
    issued(&state, retry(&refresh, Some(&access), REQUEST_ID)).await;
    assert_eq!(
        rejected(&state, request(&refresh, Some(&access), false)).await,
        RefreshRejection::Spent
    );
    assert_eq!(
        rejected(
            &state,
            retry(&refresh, Some(&access), "fedcba9876543210fedcba9876543210")
        )
        .await,
        RefreshRejection::Spent
    );
    assert_eq!(
        rejected(&state, retry(&refresh, Some(&access), "short")).await,
        RefreshRejection::Spent
    );
}

#[tokio::test]
async fn a_retry_is_refused_after_the_new_pair_has_rotated_or_the_window_closed() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let (refresh, access) = (
        first.tokens.refresh_token.clone(),
        first.tokens.access_token.clone(),
    );
    let second = issued(&state, retry(&refresh, Some(&access), REQUEST_ID)).await;
    state
        .lock_db()
        .unwrap()
        .execute("UPDATE auth_refresh_replays SET expires_ms=0", [])
        .unwrap();
    assert_eq!(
        rejected(&state, retry(&refresh, Some(&access), REQUEST_ID)).await,
        RefreshRejection::Spent
    );
    state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE auth_refresh_replays SET expires_ms=?1",
            params![i64::MAX],
        )
        .unwrap();
    issued(
        &state,
        request(
            &second.tokens.refresh_token,
            Some(&second.tokens.access_token),
            false,
        ),
    )
    .await;
    assert_eq!(
        rejected(&state, retry(&refresh, Some(&access), REQUEST_ID)).await,
        RefreshRejection::Spent
    );
}

#[tokio::test]
async fn a_retry_must_still_present_the_matching_access_token() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let other = bound_login(&state).await;
    let (refresh, access) = (
        first.tokens.refresh_token.clone(),
        first.tokens.access_token.clone(),
    );
    issued(&state, retry(&refresh, Some(&access), REQUEST_ID)).await;
    assert_eq!(
        rejected(
            &state,
            retry(&refresh, Some(&other.tokens.access_token), REQUEST_ID)
        )
        .await,
        RefreshRejection::PairMismatch
    );
    assert_eq!(
        rejected(&state, retry(&refresh, None, REQUEST_ID)).await,
        RefreshRejection::PairRequired
    );
}

#[tokio::test]
async fn logout_discards_the_retry_window() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let (refresh, access) = (
        first.tokens.refresh_token.clone(),
        first.tokens.access_token.clone(),
    );
    let second = issued(&state, retry(&refresh, Some(&access), REQUEST_ID)).await;
    assert_eq!(replay_rows(&state), 1);
    let authority = crate::auth::authenticate_runtime_with_authority(
        &state,
        &second.tokens.access_token,
        "POST",
        "/api/auth/logout",
    )
    .unwrap()
    .1
    .unwrap();
    assert!(state
        .logout_user_authorized(&first.user.id, &authority)
        .unwrap());
    assert_eq!(replay_rows(&state), 0);
    assert!(matches!(
        state
            .refresh_auth_pair(retry(&refresh, Some(&access), REQUEST_ID))
            .await
            .unwrap(),
        RefreshOutcome::Rejected(_)
    ));
}

#[tokio::test]
async fn the_retry_window_stores_hashes_only() {
    let (_data, state) = fixture(true);
    let first = bound_login(&state).await;
    let second = issued(
        &state,
        retry(
            &first.tokens.refresh_token,
            Some(&first.tokens.access_token),
            REQUEST_ID,
        ),
    )
    .await;
    let connection = state.lock_db().unwrap();
    let mut statement = connection
        .prepare("SELECT old_token_hash||request_hash||new_token_hash FROM auth_refresh_replays")
        .unwrap();
    let rows: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows.len(), 1);
    for secret in [
        first.tokens.refresh_token.as_str(),
        second.tokens.refresh_token.as_str(),
        REQUEST_ID,
    ] {
        assert!(!rows[0].contains(secret));
    }
}

#[tokio::test]
async fn with_cutover_off_a_request_id_changes_nothing() {
    let (_data, state) = fixture(false);
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let refresh = login.tokens.refresh_token.clone();
    issued(&state, retry(&refresh, None, REQUEST_ID)).await;
    assert_eq!(replay_rows(&state), 0);
    assert_eq!(
        rejected(&state, retry(&refresh, None, REQUEST_ID)).await,
        RefreshRejection::Spent
    );
}

#[tokio::test]
async fn a_database_cut_over_before_the_marker_existed_adopts_it_at_startup() {
    let (_data, state) = fixture(true);
    bound_login(&state).await;
    state
        .lock_db()
        .unwrap()
        .execute_batch(
            "DROP TRIGGER auth_cutover_no_legacy_refresh; DROP TABLE auth_cutover_fence; DROP TABLE auth_refresh_replays;",
        )
        .unwrap();
    state.initialize_schema().unwrap();
    assert_eq!(fence_version(&state), Some(AUTH_CUTOVER_SCHEMA_VERSION));
    assert_eq!(replay_rows(&state), 0);
}
