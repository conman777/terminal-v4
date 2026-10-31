use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn state_at(path: &std::path::Path) -> AppState {
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: path.into(),
        ..Default::default()
    })
    .unwrap();
    state.lock_db().unwrap().execute(
        "INSERT OR IGNORE INTO users(id,username,password_hash,created_at,updated_at) VALUES('utility-fixture','utility-fixture','synthetic','2026','2026')", [],
    ).unwrap();
    state
}

#[cfg(unix)]
#[tokio::test]
async fn colliding_bookmark_owners_cannot_read_or_change_the_legacy_file() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let bookmark = state
        .create_bookmark(
            &user,
            "private".into(),
            "private command".into(),
            "test".into(),
        )
        .unwrap();
    let path = data.path().join("users/utility-fixture/bookmarks.json");
    let before = std::fs::read(&path).unwrap();
    state.lock_db().unwrap().execute(
        "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('utility-_fixture','other','synthetic','2026','2026')", [],
    ).unwrap();
    for owner in ["utility-fixture", "utility-_fixture"] {
        let token = auth::issue_access_token(&state.config().jwt_secret, owner, "synthetic");
        for (method, uri, body) in [
            ("GET", "/api/bookmarks".to_string(), Value::Null),
            (
                "POST",
                "/api/bookmarks".to_string(),
                json!({"name":"new", "command":"echo new", "category":"test"}),
            ),
            (
                "PUT",
                format!("/api/bookmarks/{}", bookmark.id),
                json!({"name":"changed"}),
            ),
            (
                "DELETE",
                format!("/api/bookmarks/{}", bookmark.id),
                Value::Null,
            ),
        ] {
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT, "{owner} {method}");
        }
    }
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn newly_colliding_account_blocks_a_prepared_bookmark_before_replacement() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let result = utility_with_authority_for(
        &state,
        &user,
        Some(Extension(authority)),
        UtilityKind::Bookmark,
        || {
            let prepared = state.prepare_bookmark_create(
                &user,
                "draft".into(),
                "echo draft".into(),
                "test".into(),
            )?;
            state.lock_db().unwrap().execute(
            "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('utility-_fixture','other','synthetic','2026','2026')", [],
        ).unwrap();
            Ok(prepared)
        },
    );
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    assert!(!data
        .path()
        .join("users/utility-fixture/bookmarks.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn revoked_authority_cannot_publish_a_prepared_bookmark() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    state
        .create_bookmark(&user, "old".into(), "echo old".into(), "test".into())
        .unwrap();
    let path = data.path().join("users/utility-fixture/bookmarks.json");
    let before = std::fs::read(&path).unwrap();
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let result = utility_with_authority_for(
        &state,
        &user,
        Some(Extension(authority)),
        UtilityKind::Bookmark,
        || {
            let prepared = state.prepare_bookmark_create(
                &user,
                "new".into(),
                "echo new".into(),
                "test".into(),
            )?;
            state.logout_user(&user.user_id)?;
            Ok(prepared)
        },
    );
    assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn unknown_account_cannot_claim_legacy_bookmark_storage() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "unknown-owner".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let reached = std::cell::Cell::new(false);
    let result = utility_with_authority_for(
        &state,
        &user,
        Some(Extension(authority)),
        UtilityKind::Bookmark,
        || {
            reached.set(true);
            state.prepare_bookmark_list(&user)
        },
    );
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    assert!(!reached.get());
}

#[cfg(unix)]
#[tokio::test]
async fn bookmarks_follow_the_originating_session_when_another_session_remains_active() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = state
        .create_local_user_for_test("bookmark-fixture", "fixture-password")
        .unwrap();
    let old = state.issue_auth_session_for_test(user.clone()).unwrap();
    let fresh = state.issue_auth_session_for_test(user.clone()).unwrap();
    let (_, authority) =
        auth::authenticate_local_with_authority(&state, &old.tokens.access_token).unwrap();
    let request = |token: &str, method: &str, body: &str| {
        Request::builder()
            .method(method)
            .uri("/api/bookmarks")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    };
    let router = app(state.clone());
    let created = router
        .clone()
        .oneshot(request(
            &old.tokens.access_token,
            "POST",
            r#"{"name":"kept","command":"echo kept","category":"General"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    assert!(state.logout_user_authorized(&user.id, &authority).unwrap());
    let denied = router
        .clone()
        .oneshot(request(&old.tokens.access_token, "GET", ""))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let live = router
        .oneshot(request(&fresh.tokens.access_token, "GET", ""))
        .await
        .unwrap();
    assert_eq!(live.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&live.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["bookmarks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|bookmark| bookmark["name"] == "kept"));
}

#[cfg(unix)]
#[tokio::test]
async fn bookmarks_wait_for_the_same_storage_lease_as_notes() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let lease = crate::vault_admission::notes_exclusive(data.path(), "utility-fixture").unwrap();
    let body = json!({"name":"draft", "command":"echo draft", "category":"test"});
    assert_eq!(
        request(&state, "POST", "/api/bookmarks", body.clone())
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(!data
        .path()
        .join("users/utility-fixture/bookmarks.json")
        .exists());
    drop(lease);
    assert_eq!(
        request(&state, "POST", "/api/bookmarks", body).await.0,
        StatusCode::CREATED
    );
}

#[cfg(unix)]
#[tokio::test]
async fn colliding_note_owners_cannot_read_or_change_the_legacy_file() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    state
        .create_note(&user, "private".into(), "retained".into(), "test".into())
        .unwrap();
    let path = data.path().join("users/utility-fixture/notes.json");
    let before = std::fs::read(&path).unwrap();
    state.lock_db().unwrap().execute(
        "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('utility-_fixture','other','synthetic','2026','2026')", [],
    ).unwrap();
    for owner in ["utility-fixture", "utility-_fixture"] {
        let token = auth::issue_access_token(&state.config().jwt_secret, owner, "synthetic");
        for (method, body) in [
            ("GET", Value::Null),
            (
                "POST",
                json!({"title":"new", "content":"draft", "category":"test"}),
            ),
        ] {
            let response = app(state.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/api/notes")
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn unknown_account_cannot_claim_legacy_note_storage() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "unknown-owner".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let reached = std::cell::Cell::new(false);
    let result = utility_with_authority(&state, &user, Some(Extension(authority)), || {
        reached.set(true);
        state.prepare_note_list(&user)
    });
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    assert!(!reached.get());
}

#[cfg(unix)]
#[test]
fn a_new_colliding_account_blocks_a_prepared_note_before_replacement() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let result = utility_with_authority(&state, &user, Some(Extension(authority)), || {
        let prepared =
            state.prepare_note_create(&user, "title".into(), "draft".into(), "test".into())?;
        state.lock_db().unwrap().execute(
            "INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('utility-_fixture','other','synthetic','2026','2026')", [],
        ).unwrap();
        Ok(prepared)
    });
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    assert!(!data
        .path()
        .join("users/utility-fixture/notes.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn expired_note_authority_cannot_reach_the_storage_operation() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, 1);
    let result = utility_with_authority(&state, &user, Some(Extension(authority)), || {
        state.prepare_note_create(&user, "title".into(), "secret".into(), "test".into())
    });
    assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
    assert!(!data
        .path()
        .join("users/utility-fixture/notes.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn revoked_note_authority_cannot_reach_the_storage_operation() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    state.logout_user(&user.user_id).unwrap();
    let result = utility_with_authority(&state, &user, Some(Extension(authority)), || {
        state.prepare_note_create(&user, "title".into(), "secret".into(), "test".into())
    });
    assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
    assert!(!data
        .path()
        .join("users/utility-fixture/notes.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn logout_does_not_wait_for_note_preparation_and_revoked_work_cannot_commit() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let (entered, reached) = std::sync::mpsc::channel();
    let (resume, resumed) = std::sync::mpsc::channel();
    let worker_state = state.clone();
    let worker_user = user.clone();
    let worker = std::thread::spawn(move || {
        utility_with_authority(
            &worker_state,
            &worker_user,
            Some(Extension(authority)),
            || {
                entered.send(()).unwrap();
                resumed.recv().unwrap();
                worker_state.prepare_note_create(
                    &worker_user,
                    "after logout".into(),
                    "draft".into(),
                    "test".into(),
                )
            },
        )
    });
    reached
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let competing = state_at(data.path());
    let competing_authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let blocked = utility_with_authority(
        &competing,
        &user,
        Some(Extension(competing_authority)),
        || competing.prepare_note_create(&user, "duplicate".into(), "draft".into(), "test".into()),
    );
    assert_eq!(blocked.unwrap_err().status, StatusCode::SERVICE_UNAVAILABLE);
    let (done, finished) = std::sync::mpsc::channel();
    let logout_state = state.clone();
    let owner = user.user_id.clone();
    let logout = std::thread::spawn(move || done.send(logout_state.logout_user(&owner)).unwrap());
    let timely_logout = finished.recv_timeout(std::time::Duration::from_secs(2));
    resume.send(()).unwrap();
    logout.join().unwrap();
    let result = worker.join().unwrap();
    assert!(
        timely_logout.unwrap().is_ok(),
        "logout waited for note preparation"
    );
    assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
    assert!(!data
        .path()
        .join("users/utility-fixture/notes.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn rejected_note_authority_before_atomic_replace_preserves_existing_notes() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    state
        .create_note(&user, "existing".into(), "kept".into(), "test".into())
        .unwrap();
    let path = data.path().join("users/utility-fixture/notes.json");
    let before = std::fs::read(&path).unwrap();
    let authority = auth::LocalAuthority::for_test(&user.user_id, 0, i64::MAX);
    let result = utility_with_authority(&state, &user, Some(Extension(authority)), || {
        let prepared =
            state.prepare_note_create(&user, "new".into(), "rejected".into(), "test".into())?;
        state.logout_user(&user.user_id)?;
        Ok(prepared)
    });
    assert_eq!(result.unwrap_err().status, StatusCode::UNAUTHORIZED);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("notes.json")]);
}

#[cfg(unix)]
#[tokio::test]
async fn notes_follow_the_originating_session_after_another_session_remains_active() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let old = state.issue_auth_session_for_test(user.clone()).unwrap();
    let fresh = state.issue_auth_session_for_test(user.clone()).unwrap();
    let (_, authority) =
        auth::authenticate_local_with_authority(&state, &old.tokens.access_token).unwrap();
    let request = |token: &str, method: &str, body: &str| {
        Request::builder()
            .method(method)
            .uri("/api/notes")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let router = app(state.clone());
    let created = router
        .clone()
        .oneshot(request(
            &old.tokens.access_token,
            "POST",
            r#"{"title":"kept","content":"draft","category":"General"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    assert!(state.logout_user_authorized(&user.id, &authority).unwrap());
    let denied = router
        .clone()
        .oneshot(request(&old.tokens.access_token, "GET", ""))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let live = router
        .oneshot(request(&fresh.tokens.access_token, "GET", ""))
        .await
        .unwrap();
    assert_eq!(live.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&live.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["notes"][0]["title"], "kept");
}

#[cfg(unix)]
#[tokio::test]
async fn vault_mutations_return_actionable_conflict_while_image_request_is_admitted() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let legacy = vault::encrypt_secret("synthetic secret", "dev-vault-key-change-in-production")
        .unwrap()
        .replacen("enc:v2:", "enc:v1:", 1);
    state
        .add_vault_key(&user, "previous", "old", &legacy, "2020-01-01")
        .unwrap();
    let lease = crate::vault_admission::shared(data.path(), &user.user_id).unwrap();
    for (method, path, body) in [
        (
            "POST",
            "/api/vault",
            json!({"keyName":"new","keyValue":"synthetic"}),
        ),
        ("DELETE", "/api/vault/previous", Value::Null),
        ("GET", "/api/vault/previous/reveal", Value::Null),
    ] {
        let (status, body) = request(&state, method, path, body).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], crate::vault_admission::BUSY);
    }
    drop(lease);
    assert_eq!(
        request(&state, "GET", "/api/vault/previous/reveal", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
}

#[cfg(unix)]
#[tokio::test]
async fn vault_routes_report_retryable_conflict_for_unrelated_sqlite_writer() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    state
        .lock_db()
        .unwrap()
        .busy_timeout(std::time::Duration::from_millis(10))
        .unwrap();
    drop(crate::vault_admission::exclusive(data.path(), "utility-fixture").unwrap());
    let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    for (path, body) in [
        (
            "/api/vault",
            json!({"keyName":"new", "keyValue":"synthetic"}),
        ),
        (
            "/api/agent/auth/openai-api/api-key",
            json!({"apiKey":"synthetic-credential"}),
        ),
    ] {
        let method = if path == "/api/vault" { "POST" } else { "PUT" };
        let (status, body) = request(&state, method, path, body).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], crate::vault_admission::BUSY);
    }
    db.execute_batch("ROLLBACK").unwrap();
}

async fn request(state: &AppState, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let token =
        auth::issue_access_token(&state.config().jwt_secret, "utility-fixture", "synthetic");
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn utility_routes_preserve_deleted_seed_and_report_corrupt_notes_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let (status, bookmarks) = request(&state, "GET", "/api/bookmarks", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let id = bookmarks["bookmarks"][0]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &state,
            "DELETE",
            &format!("/api/bookmarks/{id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    drop(state);
    let state = state_at(data.path());
    assert_eq!(
        request(&state, "GET", "/api/bookmarks", Value::Null).await,
        (StatusCode::OK, json!({"bookmarks":[]}))
    );
    let path = data.path().join("users/utility-fixture/notes.json");
    let original = br#"[{"content":"synthetic recovery marker""#;
    std::fs::write(&path, original).unwrap();
    assert_eq!(
        request(&state, "GET", "/api/notes", Value::Null).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/notes",
            json!({"title":"fresh", "content":"new", "category":"test"})
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[tokio::test]
async fn utility_vault_routes_migrate_previous_ciphertext_without_losing_values_on_restart() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let previous = vault::encrypt_secret(
        "synthetic prior secret",
        "dev-vault-key-change-in-production",
    )
    .unwrap()
    .replacen("enc:v2:", "enc:v1:", 1);
    state
        .add_vault_key(&user, "previous", "old", &previous, "2020-01-01")
        .unwrap();
    let (status, revealed) =
        request(&state, "GET", "/api/vault/previous/reveal", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{revealed}");
    assert_eq!(revealed["keyValue"], "synthetic prior secret");
    let migrated = state
        .get_vault_key(&user, "previous")
        .unwrap()
        .unwrap()
        .key_value;
    assert!(migrated.starts_with("enc:v2:"));
    assert!(vault::decrypt_secret(&migrated, "dev-vault-key-change-in-production").is_err());
    let (status, created) = request(
        &state,
        "POST",
        "/api/vault",
        json!({"keyName":"new", "keyValue":"synthetic new secret"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    drop(state);
    let state = state_at(data.path());
    assert_eq!(
        request(&state, "GET", "/api/vault/previous/reveal", Value::Null)
            .await
            .1["keyValue"],
        "synthetic prior secret"
    );
    assert_eq!(
        request(
            &state,
            "GET",
            &format!("/api/vault/{id}/reveal"),
            Value::Null
        )
        .await
        .1["keyValue"],
        "synthetic new secret"
    );
    let damaged = "enc:v1:00:00";
    state
        .add_vault_key(&user, "damaged", "damaged", damaged, "2020-01-02")
        .unwrap();
    assert_eq!(
        request(&state, "GET", "/api/vault/damaged/reveal", Value::Null)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        state
            .get_vault_key(&user, "damaged")
            .unwrap()
            .unwrap()
            .key_value,
        damaged
    );
    assert_eq!(
        request(&state, "GET", "/api/vault", Value::Null).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
}

#[tokio::test]
async fn utility_runtime_services_start_and_stop_stats_collection_in_data_root() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    start_services(&state);
    start_services(&state);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while state.stats_collector().get_history("1h").await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    shutdown_services(&state).await;
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["history"].as_array().unwrap().len(), 1);
    assert!(data.path().join("stats-history.json").is_file());
    drop(state);
    assert_eq!(
        state_at(data.path())
            .stats_collector()
            .get_history("1h")
            .await
            .len(),
        1
    );
}

#[tokio::test]
async fn stats_recovery_api_starts_preserves_corrupt_bytes_and_serves_stats_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("stats-history.json");
    let quarantine = data.path().join("stats-history.corrupt.json");
    let original = b"\xff synthetic corrupt monitoring history";
    std::fs::write(&path, original).unwrap();
    let state = state_at(data.path());
    assert_eq!(std::fs::read(&quarantine).unwrap(), original);
    assert_eq!(
        request(&state, "GET", "/api/notes", Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, "GET", "/api/system/stats", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["historyPersistenceEnabled"], true);
    assert!(body["historyError"].as_str().unwrap().contains("preserved"));
    state.stats_collector().record_snapshot().await.unwrap();
    drop(state);
    let state = state_at(data.path());
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["history"].as_array().unwrap().len(), 1);
    assert!(body.get("historyError").is_none());
    assert_eq!(std::fs::read(quarantine).unwrap(), original);
}

#[tokio::test]
async fn stats_recovery_api_reports_preservation_failure_without_overwriting_or_blocking_routes() {
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("stats-history.json");
    let quarantine = data.path().join("stats-history.corrupt.json");
    let original = b"synthetic currently corrupt history";
    let previous = b"synthetic previous recovery bytes";
    std::fs::write(&path, original).unwrap();
    std::fs::write(&quarantine, previous).unwrap();
    let state = state_at(data.path());
    assert_eq!(
        request(&state, "GET", "/api/notes", Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, "GET", "/api/system/stats", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert!(state.stats_collector().record_snapshot().await.is_err());
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["historyPersistenceEnabled"], false);
    assert!(body["historyError"].as_str().unwrap().contains("disabled"));
    assert_eq!(body["history"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(std::fs::read(quarantine).unwrap(), previous);
}

#[test]
fn stats_recovery_does_not_hide_unrelated_database_startup_errors() {
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir(data.path().join("terminal.db")).unwrap();
    let result = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    assert!(result.is_err());
}
