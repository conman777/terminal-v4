use super::*;
use std::time::Duration;

#[tokio::test]
async fn slow_owner_cleanup_does_not_block_other_owner_and_shutdown_retains_leases() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "owner-cleanup-concurrency".into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let first = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    manager
        .create_session(
            "bob",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let session = manager
        .owned_session_internal("alice", &first.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let locked = session.lifecycle.lock().await;
    let mut db = state.lock_db().unwrap();
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let alice =
        owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "alice", Uuid::new_v4()).unwrap();
    let bob = owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "bob", Uuid::new_v4()).unwrap();
    tx.commit().unwrap();
    drop(db);
    let slow = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.service_owner_cleanup("alice").await })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        while !session.state.lock().await.retiring {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("alice did not enter retirement");
    let fast = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.service_owner_cleanup("bob").await })
    };
    assert!(tokio::time::timeout(Duration::from_secs(3), fast)
        .await
        .expect("bob cleanup blocked behind alice")
        .unwrap()
        .unwrap()
        .is_some());
    assert!(cleanup.receipt(&bob).unwrap().is_some());
    assert!(cleanup.receipt(&alice).unwrap().is_none());
    let shutdown = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.shutdown().await })
    };
    tokio::task::yield_now().await;
    assert!(!shutdown.is_finished());
    assert!(manager
        .inner
        .live_ownership
        .get()
        .unwrap()
        .epoch("alice")
        .unwrap()
        .is_some());
    drop(locked);
    assert!(tokio::time::timeout(Duration::from_secs(3), slow)
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
    assert!(cleanup.receipt(&alice).unwrap().is_some());
}

#[tokio::test]
async fn failed_owner_cleanup_retains_hold_and_lease_for_retry() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let snapshot = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let session = manager
        .owned_session_internal("alice", &snapshot.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    session.state.lock().await.deleting = true;
    let mut db = state.lock_db().unwrap();
    let tx = db.transaction().unwrap();
    let request =
        owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "alice", Uuid::new_v4()).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert!(manager.service_owner_cleanup("alice").await.is_err());
    assert!(cleanup.receipt(&request).unwrap().is_none());
    assert!(cleanup.is_held("alice").unwrap());
    assert!(manager
        .inner
        .live_ownership
        .get()
        .unwrap()
        .epoch("alice")
        .unwrap()
        .is_some());
    session.state.lock().await.deleting = false;
    assert!(manager
        .service_owner_cleanup("alice")
        .await
        .unwrap()
        .is_some());
    manager.shutdown().await.unwrap();
}

async fn held_unrelated_state_does_not_block_cleanup(restored: bool) {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let state = crate::state::AppState::new(config.clone()).unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let first = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let second = manager
        .create_session(
            "bob",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    if restored {
        manager.shutdown().await.unwrap();
    }
    let state = if restored {
        drop(manager);
        drop(state);
        crate::state::AppState::new(config).unwrap()
    } else {
        state
    };
    let manager = state.structured_session_manager();
    if restored {
        manager.bind_live_ownership().unwrap();
    }
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let alice = manager
        .owned_session_internal("alice", &first.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let bob = manager
        .owned_session_internal("bob", &second.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let guard = alice.state.lock().await;
    let mut db = state.lock_db().unwrap();
    let tx = db.transaction().unwrap();
    let request =
        owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "bob", Uuid::new_v4()).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), manager.service_owner_cleanup("bob"))
            .await
            .expect("bob cleanup waited for alice's state")
            .unwrap()
            .is_some()
    );
    assert!(cleanup.receipt(&request).unwrap().is_some());
    assert!(!guard.retiring);
    assert!(!bob.state.lock().await.retiring);
    drop(guard);
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn unrelated_state_lock_does_not_block_new_or_restored_owner_cleanup() {
    held_unrelated_state_does_not_block_cleanup(false).await;
    held_unrelated_state_does_not_block_cleanup(true).await;
}

#[tokio::test]
async fn cleanup_rejects_owner_metadata_mismatch() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let snapshot = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let session = manager
        .owned_session_internal("alice", &snapshot.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    session.state.lock().await.user_id = "bob".into();
    assert!(manager.close_matching(Some("alice")).await.is_err());
    assert!(manager.close_matching(None).await.is_err());
    let mut guard = session.state.lock().await;
    assert!(!guard.retiring);
    guard.user_id = "alice".into();
    drop(guard);
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn owner_lists_and_usage_do_not_wait_for_other_owners_or_return_their_data() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let alice = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let bob = manager
        .create_session(
            "bob",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let alice_session = manager
        .owned_session_internal("alice", &alice.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let bob_session = manager
        .owned_session_internal("bob", &bob.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    bob_session
        .state
        .lock()
        .await
        .events
        .push(StructuredSessionEvent::ContextUsage {
            ts: now_ts(),
            seq: 1,
            turn_id: "turn".into(),
            usage: serde_json::json!({"inputTokens": 7, "outputTokens": 3}),
        });
    let guard = alice_session.state.lock().await;
    let (sessions, inventory, usage) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(
            manager.list_sessions("bob"),
            manager.list_inventory("bob"),
            manager.usage_summary("bob")
        )
    })
    .await
    .expect("owner lookup waited for another owner's state");
    assert_eq!(
        sessions.unwrap().iter().map(|s| &s.id).collect::<Vec<_>>(),
        vec![&bob.id]
    );
    assert_eq!(
        inventory.unwrap().iter().map(|s| &s.id).collect::<Vec<_>>(),
        vec![&bob.id]
    );
    let usage = usage.unwrap();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0]["id"], bob.id);
    assert_eq!(usage[0]["inputTokens"], 7);
    drop(guard);
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn owner_lists_and_usage_reject_session_owner_mismatch() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let snapshot = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let session = manager
        .owned_session_internal("alice", &snapshot.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    session.state.lock().await.user_id = "bob".into();
    assert!(manager.list_sessions("alice").await.is_err());
    assert!(manager.list_inventory("alice").await.is_err());
    assert!(manager.usage_summary("alice").await.is_err());
    session.state.lock().await.user_id = "alice".into();
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn cleanup_retry_skips_other_owner_and_rejects_identity_mismatch() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let alice = manager
        .create_session(
            "alice",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let bob = manager
        .create_session(
            "bob",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let alice_session = manager
        .owned_session_internal("alice", &alice.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let bob_session = manager
        .owned_session_internal("bob", &bob.id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let guard = alice_session.state.lock().await;
    tokio::time::timeout(Duration::from_secs(2), manager.retry_owner_cleanup("bob"))
        .await
        .expect("bob retry waited for alice")
        .unwrap();
    bob_session.state.lock().await.user_id = "wrong-owner".into();
    assert!(manager.retry_owner_cleanup("bob").await.is_err());
    bob_session.state.lock().await.user_id = "bob".into();
    drop(guard);
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn cleanup_monitor_services_seventeenth_owner_when_sixteen_are_stalled() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let mut sessions = Vec::new();
    for index in 0..17 {
        let owner = format!("owner{index:02}");
        let snapshot = manager
            .create_session(
                &owner,
                workspace.path().to_str().unwrap(),
                Some("codex"),
                None,
                None,
            )
            .await
            .unwrap();
        sessions.push(
            manager
                .owned_session_internal(&owner, &snapshot.id)
                .await
                .unwrap()
                .unwrap()
                .session
                .clone(),
        );
    }
    let mut guards = Vec::new();
    for session in &sessions[..16] {
        guards.push(session.lifecycle.lock().await);
    }
    let mut db = state.lock_db().unwrap();
    let tx = db.transaction().unwrap();
    let mut requests = Vec::new();
    for index in 0..17 {
        requests.push(
            owner_cleanup::OwnerCleanup::hold_in_transaction(
                &tx,
                &format!("owner{index:02}"),
                Uuid::new_v4(),
            )
            .unwrap(),
        );
    }
    tx.commit().unwrap();
    drop(db);
    let worker = manager.spawn_owner_cleanup_worker().unwrap();
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let mut stalled = 0;
            for session in &sessions[..16] {
                if session.state.lock().await.retiring {
                    stalled += 1;
                }
            }
            if stalled == 16 && cleanup.receipt(&requests[16]).unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("seventeenth owner was starved");
    assert!(requests[..16]
        .iter()
        .all(|request| cleanup.receipt(request).unwrap().is_none()));
    worker.abort();
    let _ = worker.await;
    let expected: std::collections::HashSet<_> =
        (0..16).map(|index| format!("owner{index:02}")).collect();
    tokio::time::timeout(Duration::from_secs(3), async {
        while *manager.inner.owner_cleanup_active.lock().unwrap() != expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("in-flight monitor owners were not retained after cancellation");
    let restarted = manager.spawn_owner_cleanup_worker().unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        *manager.inner.owner_cleanup_active.lock().unwrap(),
        expected
    );
    for owner in &expected {
        assert!(manager
            .inner
            .live_ownership
            .get()
            .unwrap()
            .epoch(owner)
            .unwrap()
            .is_some());
    }
    drop(guards);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !manager
            .inner
            .owner_cleanup_active
            .lock()
            .unwrap()
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned cleanup did not finish after its monitor restarted");
    restarted.abort();
    let _ = restarted.await;
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn delegation_monitor_services_seventeenth_owner_when_sixteen_are_stalled() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let supervisor = crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap();
    manager
        .bind_delegation_supervisor(supervisor.clone())
        .unwrap();
    let cleanup = state.provision_owner_cleanup().unwrap();
    manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    let mut guards = Vec::new();
    for index in 0..16 {
        guards.push(
            supervisor
                .lock_owner_cleanup(&format!("owner{index:02}"))
                .await
                .unwrap(),
        );
    }
    let mut db = state.lock_db().unwrap();
    let tx = db.transaction().unwrap();
    for index in 0..17 {
        owner_cleanup::OwnerCleanup::hold_in_transaction(
            &tx,
            &format!("owner{index:02}"),
            Uuid::new_v4(),
        )
        .unwrap();
    }
    tx.commit().unwrap();
    drop(db);
    let worker = manager.spawn_delegation_cleanup_worker().unwrap();
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let recorded: bool = state.lock_db().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_delegation_receipts WHERE owner='owner16')", [], |r| r.get(0)).unwrap();
            if recorded { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("seventeenth delegation owner was starved");
    let recorded: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM structured_owner_delegation_receipts WHERE owner <> 'owner16'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 0);
    worker.abort();
    let _ = worker.await;
    let expected: std::collections::HashSet<_> =
        (0..16).map(|index| format!("owner{index:02}")).collect();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let active = manager
                .inner
                .delegation_cleanup_active
                .lock()
                .unwrap()
                .clone();
            if active == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("delegation owners were not retained after monitor cancellation");
    let restarted = manager.spawn_delegation_cleanup_worker().unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(expected.is_subset(&manager.inner.delegation_cleanup_active.lock().unwrap()));
    let recorded: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM structured_owner_delegation_receipts WHERE owner <> 'owner16'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 0);
    restarted.abort();
    let _ = restarted.await;
    drop(guards);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let active = manager
                .inner
                .delegation_cleanup_active
                .lock()
                .unwrap()
                .clone();
            if active.is_disjoint(&expected) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("delegation cleanup did not finish after releasing owner gates");
    let recorded: i64 = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM structured_owner_delegation_receipts WHERE owner <> 'owner16'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 16);
    manager.shutdown().await.unwrap();
}
