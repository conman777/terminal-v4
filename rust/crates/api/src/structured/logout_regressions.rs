use super::*;
use axum::extract::State;
use axum::Extension;
use std::time::Duration;

#[cfg(unix)]
fn enable_cleanup_fixture(state: &crate::state::AppState) {
    let manager = state.structured_session_manager();
    if manager.owner_cleanup_for_test().is_ok() {
        return;
    }
    manager
        .bind_owner_cleanup(state.provision_owner_cleanup().unwrap())
        .unwrap();
    manager.start_owner_cleanup_workers().unwrap();
}

#[cfg(unix)]
#[test]
fn owner_cleanup_installation_is_idempotent_and_missing_tables_fail_closed() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "cleanup-schema-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state.provision_owner_cleanup().unwrap();
    state.provision_owner_cleanup().unwrap();
    state
        .lock_db()
        .unwrap()
        .execute("DROP TABLE structured_owner_cleanup_receipts", [])
        .unwrap();
    assert!(state.provision_owner_cleanup().is_err());
    assert!(state
        .lock_db()
        .unwrap()
        .prepare("SELECT * FROM structured_owner_cleanup_receipts")
        .is_err());
}

#[cfg(unix)]
#[test]
fn owner_cleanup_migrates_v2_audit_once_and_rejects_its_loss() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    state.provision_owner_cleanup().unwrap();
    {
        let db = state.lock_db().unwrap();
        db.execute_batch("DROP TABLE structured_owner_delegation_reviews; DROP TABLE structured_owner_background_reviews; UPDATE auth_admission_identity SET structured_cleanup_version=2 WHERE id=1").unwrap();
    }
    state.provision_owner_cleanup().unwrap();
    {
        let db = state.lock_db().unwrap();
        let version: i64 = db
            .query_row(
                "SELECT structured_cleanup_version FROM auth_admission_identity WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 4);
        db.execute_batch("DROP TABLE structured_owner_background_reviews")
            .unwrap();
    }
    assert!(state.provision_owner_cleanup().is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_starts_owner_cleanup_and_restores_its_registration_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let state = crate::state::AppState::new_runtime(config.clone()).unwrap();
    let manager = state.structured_session_manager();
    assert!(manager.owner_cleanup_for_test().is_ok());
    manager.shutdown().await.unwrap();
    drop(manager);
    drop(state);
    let reopened = crate::state::AppState::new_runtime(config).unwrap();
    assert!(reopened
        .structured_session_manager()
        .owner_cleanup_for_test()
        .is_ok());
    reopened
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn first_install_failure_does_not_commit_cleanup_marker_and_can_retry() {
    let data = tempfile::tempdir().unwrap();
    let blocker = crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    assert!(crate::state::AppState::new_runtime(config.clone()).is_err());
    let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let column: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='structured_cleanup_version')", [], |row| row.get(0)).unwrap();
    if column {
        let version: i64 = db
            .query_row(
                "SELECT structured_cleanup_version FROM auth_admission_identity WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 0);
    }
    assert!(!db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='structured_owner_holds')", [], |row| row.get::<_, bool>(0)).unwrap());
    drop(db);
    blocker.shutdown().await.unwrap();
    drop(blocker);
    let state = crate::state::AppState::new_runtime(config).unwrap();
    assert!(state
        .structured_session_manager()
        .owner_cleanup_for_test()
        .is_ok());
    state.structured_session_manager().shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_waits_for_owned_delegation_cleanup_after_monitor_cancellation() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    manager
        .bind_delegation_supervisor(
            crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap(),
        )
        .unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    state.logout_user("owner").unwrap();
    let (entered, entered_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    *manager.inner.delegation_cleanup_pause.lock().unwrap() = Some((entered, release_rx));
    manager.start_owner_cleanup_workers().unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .unwrap()
        .unwrap();
    let mut shutdown = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.shutdown().await })
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut shutdown)
            .await
            .is_err()
    );
    assert!(cleanup.is_held("owner").unwrap());
    let _ = release.send(());
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_cancels_pending_claude_permission_before_waiting_for_owner_admissions() {
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "claude-logout-cycle".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let auth = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            &auth.user.id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let other_session = manager
        .create_session(
            "other",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let mut request = {
        let manager = manager.clone();
        let owner = auth.user.id.clone();
        let id = session.id.clone();
        tokio::spawn(async move {
            manager
                .request_claude_permission(
                    &owner,
                    &id,
                    "Read",
                    serde_json::json!({"file_path":"fixture"}),
                )
                .await
        })
    };
    let mut other = {
        let manager = manager.clone();
        let id = other_session.id.clone();
        tokio::spawn(async move {
            manager
                .request_claude_permission(
                    "other",
                    &id,
                    "Read",
                    serde_json::json!({"file_path":"other"}),
                )
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if manager.inner.claude_permissions.lock().unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (approval, other_approval) = {
        let pending = manager.inner.claude_permissions.lock().unwrap();
        (
            pending
                .iter()
                .find(|(_, value)| value.owner == auth.user.id)
                .unwrap()
                .0
                .clone(),
            pending
                .iter()
                .find(|(_, value)| value.owner == "other")
                .unwrap()
                .0
                .clone(),
        )
    };
    let response = crate::app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(
                    "authorization",
                    format!("Bearer {}", auth.tokens.access_token),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(
        response.status(),
        axum::http::StatusCode::OK | axum::http::StatusCode::ACCEPTED
    ));
    let stale = crate::app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{}/approve", session.id))
                .header(
                    "authorization",
                    format!("Bearer {}", auth.tokens.access_token),
                )
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({"approvalId":approval,"approved":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), axum::http::StatusCode::UNAUTHORIZED);
    assert!(!tokio::time::timeout(Duration::from_secs(3), &mut request)
        .await
        .expect("pending approval was not cancelled")
        .unwrap()
        .unwrap());
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut other)
        .await
        .is_err());
    manager
        .approve_bound(
            "other",
            &other_session.id,
            Some(&other_approval),
            true,
            None,
        )
        .await
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), other)
        .await
        .unwrap()
        .unwrap()
        .unwrap());
    let cleanup = manager.owner_cleanup_for_test().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while cleanup.is_held(&auth.user.id).unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("logout hold did not clear");
    assert!(manager.inner.claude_permissions.lock().unwrap().is_empty());
    assert!(crate::auth::authenticate_local_token(&state, &auth.tokens.access_token).is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_approval_waiting_to_record_resolution_is_denied_after_logout() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let (entered, entered_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    *manager.inner.claude_before_resolved.lock().unwrap() = Some((entered, release_rx));
    let request = {
        let manager = manager.clone();
        let id = session.id.clone();
        tokio::spawn(async move {
            manager
                .request_claude_permission("owner", &id, "Read", serde_json::json!({}))
                .await
        })
    };
    let approval = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(id) = manager
                .inner
                .claude_permissions
                .lock()
                .unwrap()
                .keys()
                .next()
                .cloned()
            {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager
        .approve_bound("owner", &session.id, Some(&approval), true, None)
        .await
        .unwrap();
    entered_rx.await.unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let session_guard = live.state.lock().await;
    release.send(()).unwrap();
    let logout_state = state.clone();
    tokio::task::spawn_blocking(move || logout_state.logout_user("owner"))
        .await
        .unwrap()
        .unwrap();
    assert!(manager
        .owner_cleanup_for_test()
        .unwrap()
        .is_held("owner")
        .unwrap());
    drop(session_guard);
    assert!(!tokio::time::timeout(Duration::from_secs(3), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap());
    let events = live.state.lock().await.events.clone();
    let user_approval = events.iter().position(|event| matches!(event,
        StructuredSessionEvent::ApprovalResolved { approval_id, approved: true, .. } if approval_id == &approval)).unwrap();
    let cancelled = events.iter().position(|event| matches!(event,
        StructuredSessionEvent::Error { code: Some(code), .. } if code == "claude_permission_cancelled")).unwrap();
    assert!(user_approval < cancelled);
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_prompt_admitted_before_logout_cannot_register_after_the_hold() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let (entered, entered_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    *manager.inner.claude_prompt_admitted.lock().unwrap() = Some((entered, release_rx));
    let request = {
        let manager = manager.clone();
        let id = session.id;
        tokio::spawn(async move {
            manager
                .request_claude_permission("owner", &id, "Read", serde_json::json!({}))
                .await
        })
    };
    entered_rx.await.unwrap();
    let logout_state = state.clone();
    tokio::task::spawn_blocking(move || logout_state.logout_user("owner"))
        .await
        .unwrap()
        .unwrap();
    let cleanup = manager.owner_cleanup_for_test().unwrap();
    assert!(cleanup.is_held("owner").unwrap());
    let _ = release.send(());
    assert!(!tokio::time::timeout(Duration::from_secs(3), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap());
    assert!(manager.inner.claude_permissions.lock().unwrap().is_empty());
    tokio::time::timeout(Duration::from_secs(5), async {
        while cleanup.is_held("owner").unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_decisions_are_rejected_after_hold_before_monitor_cancels_them() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for name in ["Read", "Write"] {
        let manager = manager.clone();
        let id = session.id.clone();
        tasks.push(tokio::spawn(async move {
            manager
                .request_claude_permission("owner", &id, name, serde_json::json!({}))
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while manager.inner.claude_permissions.lock().unwrap().len() != 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let approvals: Vec<_> = manager
        .inner
        .claude_permissions
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    manager.stop_owner_cleanup_workers().await.unwrap();
    let logout_state = state.clone();
    tokio::task::spawn_blocking(move || logout_state.logout_user("owner"))
        .await
        .unwrap()
        .unwrap();
    assert!(manager
        .resolve_claude_permission(&session.id, &approvals[0], true, None)
        .is_err());
    assert!(manager
        .resolve_claude_session_permission(&session.id, &approvals[1], None)
        .is_err());
    assert_eq!(manager.inner.claude_permissions.lock().unwrap().len(), 2);
    manager.start_owner_cleanup_workers().unwrap();
    for task in tasks {
        assert!(!tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap());
    }
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn unconfirmed_previous_owner_is_visible_until_reviewed() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    manager
        .bind_owner_cleanup(state.provision_owner_cleanup().unwrap())
        .unwrap();
    let leases = live_ownership::ManagerLeases::new(data.path()).unwrap();
    drop(leases.acquire("owner").unwrap());
    state.logout_user("owner").unwrap();
    assert!(manager.service_owner_cleanup("owner").await.is_err());
    let status = manager.owner_cleanup_status("owner").unwrap().unwrap();
    assert_eq!(status["state"], "review_required");
    assert_eq!(status["resources"]["structured"], "unconfirmed");
    assert!(manager
        .owner_cleanup_for_test()
        .unwrap()
        .is_held("owner")
        .unwrap());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn missing_delegation_ledger_is_visible_without_recreating_it() {
    let data = tempfile::tempdir().unwrap();
    let blocker = crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    manager
        .bind_owner_cleanup(state.provision_owner_cleanup().unwrap())
        .unwrap();
    state.logout_user("owner").unwrap();
    assert!(manager
        .service_owner_cleanup("owner")
        .await
        .unwrap()
        .is_some());
    drop(blocker);
    let path = data.path().join("delegation-outbox/outbox.sqlite3");
    std::fs::remove_file(&path).unwrap();
    assert!(manager.service_delegation_cleanup("owner").await.is_err());
    let status = manager.owner_cleanup_status("owner").unwrap().unwrap();
    assert_eq!(status["state"], "unavailable");
    assert_eq!(status["resources"]["delegation"], "unavailable");
    assert!(manager
        .owner_cleanup_for_test()
        .unwrap()
        .is_held("owner")
        .unwrap());
    assert!(!path.exists());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_logout_without_existing_sessions_cleans_up_and_releases_hold() {
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "empty-owner-logout".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let auth = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = state.structured_session_manager();
    enable_cleanup_fixture(&state);
    let cleanup = manager.owner_cleanup_for_test().unwrap();
    let response = crate::app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(
                    "Authorization",
                    format!("Bearer {}", auth.tokens.access_token),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(
        response.status(),
        axum::http::StatusCode::OK | axum::http::StatusCode::ACCEPTED
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        while cleanup.is_held(&auth.user.id).unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("empty owner hold did not clear");
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
struct ChildGuard(Option<std::process::Child>);

#[cfg(unix)]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(unix)]
async fn wait_fixture(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cleanup fixture did not reach its barrier");
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "invoked by the cross-process logout test"]
async fn remote_structured_owner_fixture() {
    let Some(root) = std::env::var_os("V4_REMOTE_OWNER_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let workspace = PathBuf::from(std::env::var_os("V4_REMOTE_OWNER_WORKSPACE").unwrap());
    let owner = std::env::var("V4_REMOTE_OWNER_ID").unwrap();
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: root.clone(),
        jwt_secret: "cleanup-cross-process".into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    enable_cleanup_fixture(&state);
    let cleanup = manager.owner_cleanup_for_test().unwrap();
    let session = manager
        .create_session(
            &owner,
            workspace.to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let active = manager
        .owned_session(&owner, &session.id)
        .await
        .unwrap()
        .unwrap();
    std::fs::write(root.join("remote-owner-ready"), b"ready").unwrap();
    wait_fixture(&root.join("remote-owner-release")).await;
    drop(active);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !cleanup.is_held(&owner).unwrap() {
                break;
            }
            if let Some(request) = cleanup.pending(&owner).unwrap() {
                if cleanup.receipt(&request).unwrap().is_some() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owner worker did not acknowledge cleanup");
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_http_releases_hold_only_after_remote_owner_and_supervisor_cleanup() {
    cross_process_logout(true, false, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn logout_http_keeps_hold_when_supervisor_ownership_is_unavailable() {
    cross_process_logout(false, false, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn logout_http_releases_only_after_current_background_manager_confirms() {
    cross_process_logout(true, true, true).await;
}

#[cfg(unix)]
#[tokio::test]
async fn logout_http_keeps_hold_when_background_manager_is_elsewhere() {
    cross_process_logout(true, true, false).await;
}

#[cfg(unix)]
async fn cross_process_logout(
    with_supervisor: bool,
    install_background: bool,
    bind_background: bool,
) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    if !with_supervisor {
        let initial = crate::state::AppState::new_runtime(AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "cleanup-cross-process".into(),
            ..Default::default()
        })
        .unwrap();
        initial
            .structured_session_manager()
            .shutdown()
            .await
            .unwrap();
        drop(initial);
    }
    let mut supervisor_blocker = if with_supervisor {
        None
    } else {
        Some(crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap())
    };
    let mut background = if install_background {
        let preinstall = crate::state::AppState::new(AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "cleanup-cross-process".into(),
            ..Default::default()
        })
        .unwrap();
        let mut db = preinstall.lock_db().unwrap();
        Some(Arc::new(
            crate::v4_agent::background_process::bootstrap::open_or_provision(data.path(), &mut db)
                .unwrap(),
        ))
    } else {
        None
    };
    let state = crate::state::AppState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "cleanup-cross-process".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let auth = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = state.structured_session_manager();
    enable_cleanup_fixture(&state);
    let cleanup = manager.owner_cleanup_for_test().unwrap();
    if bind_background {
        manager
            .bind_background_processes(background.as_ref().unwrap().clone())
            .unwrap();
    }
    let fixture = format!(
        "{}::remote_structured_owner_fixture",
        module_path!().split_once("::").unwrap().1
    );
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &fixture, "--ignored"])
        .env("V4_REMOTE_OWNER_ROOT", data.path())
        .env("V4_REMOTE_OWNER_WORKSPACE", workspace.path())
        .env("V4_REMOTE_OWNER_ID", &auth.user.id)
        .spawn()
        .unwrap();
    let mut child = ChildGuard(Some(child));
    wait_fixture(&data.path().join("remote-owner-ready")).await;
    let response = crate::app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(
                    "Authorization",
                    format!("Bearer {}", auth.tokens.access_token),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::ACCEPTED);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"success":true,"cleanup":{"state":"pending"}})
    );
    assert!(crate::auth::authenticate_local_token(&state, &auth.tokens.access_token).is_err());
    let request = cleanup
        .pending(&auth.user.id)
        .unwrap()
        .expect("logout must durably hold owner cleanup");
    if install_background {
        let db = state.lock_db().unwrap();
        let background_request: String = db
            .query_row(
                "SELECT request FROM background_owner_holds WHERE owner=?1",
                [&auth.user.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(background_request, request.id().to_string());
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(cleanup.receipt(&request).unwrap(), None);
    assert!(cleanup.is_held(&auth.user.id).unwrap());
    std::fs::write(data.path().join("remote-owner-release"), b"release").unwrap();
    let expect_release = with_supervisor && (!install_background || bind_background);
    tokio::time::timeout(Duration::from_secs(10), async {
        while if expect_release {
            cleanup.is_held(&auth.user.id).unwrap()
        } else {
            cleanup.receipt(&request).unwrap().is_none()
        } {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("remote owner and supervisor did not reach the expected cleanup state");
    assert_eq!(cleanup.is_held(&auth.user.id).unwrap(), !expect_release);
    let status = child.0.take().unwrap().wait().unwrap();
    assert!(status.success());
    let renewed = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renewed.user.id, auth.user.id);
    let sessions = manager.list_sessions(&renewed.user.id).await;
    assert_eq!(
        sessions.is_ok(),
        expect_release,
        "re-login access must match confirmed cleanup"
    );
    if !expect_release {
        if let Some(blocker) = supervisor_blocker.take() {
            blocker.shutdown().await.unwrap();
            drop(blocker);
        }
        if !bind_background {
            if let Some(background) = background.take() {
                background.shutdown().await.unwrap();
                drop(background);
            }
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            while cleanup.is_held(&auth.user.id).unwrap() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("standby did not acquire and reconcile the released resource");
        assert!(manager.list_sessions(&renewed.user.id).await.is_ok());
    }
    manager.shutdown().await.unwrap();
    if let Some(blocker) = supervisor_blocker {
        blocker.shutdown().await.unwrap();
    }
    if !bind_background {
        if let Some(background) = background {
            background.shutdown().await.unwrap();
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn structured_manager_drains_owned_operation_before_logout_cleanup() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "cleanup-manager-fixture".into(),
        ..Default::default()
    };
    let state = crate::state::AppState::new(config).unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let active = manager
        .owned_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    let mut writer = state.lock_db().unwrap();
    let tx = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let request =
        owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "owner", Uuid::new_v4()).unwrap();
    tx.commit().unwrap();
    drop(writer);
    assert!(manager.owned_session("owner", &session.id).await.is_err());
    let service = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.service_owner_cleanup("owner").await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(cleanup.receipt(&request).unwrap(), None);
    drop(active);
    let receipt = tokio::time::timeout(Duration::from_secs(2), service)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(receipt.is_some());
    assert!(cleanup.receipt(&request).unwrap().is_some());
    assert!(cleanup.is_held("owner").unwrap());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn manager_shutdown_waits_for_owner_cleanup_before_releasing_lease() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "cleanup-shutdown-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let active = manager
        .owned_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    let mut db = state.lock_db().unwrap();
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let request =
        owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "owner", Uuid::new_v4()).unwrap();
    tx.commit().unwrap();
    drop(db);
    let service = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.service_owner_cleanup("owner").await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let shutdown = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.shutdown().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!shutdown.is_finished());
    assert_eq!(cleanup.receipt(&request).unwrap(), None);
    drop(active);
    assert!(tokio::time::timeout(Duration::from_secs(3), service)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .is_some());
    tokio::time::timeout(Duration::from_secs(3), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(cleanup.receipt(&request).unwrap().is_some());
}

#[tokio::test]
async fn logout_revokes_existing_access_before_waiting_for_session_cleanup() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "logout-cleanup-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let auth = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            &auth.user.id,
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let state_guard = live.state.lock().await;
    let task = tokio::spawn({
        let state = state.clone();
        let user = crate::auth::AuthenticatedUser {
            user_id: auth.user.id.clone(),
            username: auth.user.username.clone(),
        };
        async move { crate::logout(State(state), Extension(user)).await }
    });
    let revoked = tokio::time::timeout(Duration::from_secs(2), async {
        while crate::auth::authenticate_local_token(&state, &auth.tokens.access_token).is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    drop(state_guard);
    task.await.unwrap().unwrap();
    assert!(
        revoked,
        "logout waited for cleanup before revoking the existing access token"
    );
}

#[tokio::test]
async fn disconnect_after_revocation_does_not_cancel_session_cleanup() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "logout-disconnect-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let auth = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            &auth.user.id,
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(crate::workspace_browser::hold_session_registry_for_test(
        entered_tx, release_rx,
    ));
    entered_rx.await.unwrap();
    let request = tokio::spawn({
        let state = state.clone();
        let user = crate::auth::AuthenticatedUser {
            user_id: auth.user.id.clone(),
            username: auth.user.username.clone(),
        };
        async move { crate::logout(State(state), Extension(user)).await }
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while crate::auth::authenticate_local_token(&state, &auth.tokens.access_token).is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    request.abort();
    let _ = request.await;
    let _ = release_tx.send(());
    blocker.await.unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if live.state.lock().await.generation > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    if !completed {
        manager.close_owner(&auth.user.id).await.unwrap();
    }
    assert!(
        completed,
        "disconnect cancelled the remaining owner cleanup"
    );
}
