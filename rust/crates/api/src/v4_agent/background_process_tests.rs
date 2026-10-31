use super::*;

#[test]
fn bounded_output_retains_original_prefix_and_most_recent_tail() {
    let mut output = Output::default();
    output.append(&vec![b'a'; OUTPUT_LIMIT]);
    output.append(b"latest-output");
    assert_eq!(output.text(), "a".repeat(OUTPUT_LIMIT));
    assert_eq!(
        output.tail_text(),
        format!("{}latest-output", "a".repeat(OUTPUT_LIMIT - 13))
    );
    assert!(output.truncated);
    assert!(output.tail_truncated);
    assert_eq!(output.tail.len(), OUTPUT_LIMIT);
}

#[test]
fn recent_output_remains_bounded_and_keeps_the_end_of_lossy_utf8() {
    let mut output = Output::default();
    output.append(&vec![0xff; OUTPUT_LIMIT]);
    output.append("last π".as_bytes());
    let (tail, truncated) = output.snapshot(OutputWindow::Tail);
    assert!(tail.len() <= OUTPUT_LIMIT);
    assert!(tail.ends_with("last π"));
    assert!(truncated);
}

#[cfg(unix)]
#[tokio::test]
async fn interactive_manager_writes_only_to_its_owned_command_and_rejects_replay() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let mut action = request(
        root.path(),
        &"ab".repeat(32),
        "IFS= read -r line; printf 'received:%s' \"$line\"",
        Duration::from_secs(5),
    );
    action.scope.incarnation = Some(uuid::Uuid::new_v4());
    let noninteractive_approval = action.clone();
    action.interactive = true;
    assert!(manager
        .start(action.clone(), Some(&noninteractive_approval))
        .await
        .is_err());
    manager.start(action.clone(), Some(&action)).await.unwrap();
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    let auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &cancellation,
    };
    let operation = "cd".repeat(32);
    let stopped = crate::v4_agent::interaction::Cancellation::default();
    stopped.cancel();
    let stopped_auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &stopped,
    };
    let expired_auth = InputAuthorization {
        generation: 0,
        expires_at: 0,
        cancellation: &cancellation,
    };
    let revoked_auth = InputAuthorization {
        generation: 1,
        expires_at: i64::MAX,
        cancellation: &cancellation,
    };
    for invalid_auth in [&stopped_auth, &expired_auth, &revoked_auth] {
        assert!(manager
            .write_input_for_actor(
                &action.scope,
                &action.action_id,
                &operation,
                b"wrong\n",
                &action.command,
                invalid_auth
            )
            .is_err());
    }
    let credentials = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    credentials
        .execute(
            "INSERT INTO auth_generations(user_id,generation) VALUES('owner',1)",
            [],
        )
        .unwrap();
    assert!(manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"wrong\n",
            &action.command,
            &revoked_auth
        )
        .is_err());
    credentials
        .execute(
            "UPDATE auth_generations SET generation=0 WHERE user_id='owner'",
            [],
        )
        .unwrap();
    drop(credentials);
    assert!(manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"wrong\n",
            "different command",
            &auth
        )
        .is_err());
    assert!(manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            &vec![b'x'; 513],
            &action.command,
            &auth
        )
        .is_err());
    assert!(manager
        .ledger
        .input_state(&action.scope, &action.action_id, &operation)
        .is_err());
    let mut other = action.scope.clone();
    other.incarnation = Some(uuid::Uuid::new_v4());
    assert!(manager
        .write_input_for_actor(
            &other,
            &action.action_id,
            &operation,
            b"wrong\n",
            &action.command,
            &auth
        )
        .is_err());
    manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"hello\n",
            &action.command,
            &auth,
        )
        .unwrap();
    assert!(manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"hello\n",
            &action.command,
            &auth
        )
        .is_err());
    let snapshot = manager
        .wait(
            &action.scope,
            &action.action_id,
            Duration::from_secs(5),
            &cancellation,
        )
        .await
        .unwrap();
    assert_eq!(snapshot.state, BackgroundState::Exited { code: Some(0) });
    assert_eq!(
        manager
            .reviewable_output(&action.scope, &action.action_id)
            .await
            .unwrap()
            .stdout,
        "received:hello"
    );
    assert_eq!(
        manager
            .ledger
            .input_state(&action.scope, &action.action_id, &operation)
            .unwrap(),
        ledger::InputReceiptState::Delivered
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn input_refuses_cancelled_turns_and_noninteractive_commands_without_claiming() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let mut action = request(
        root.path(),
        &"ab".repeat(32),
        "sleep 5",
        Duration::from_secs(10),
    );
    action.scope.incarnation = Some(uuid::Uuid::new_v4());
    manager.start(action.clone(), Some(&action)).await.unwrap();
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    cancellation.cancel();
    let auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &cancellation,
    };
    let active = crate::v4_agent::interaction::Cancellation::default();
    let active_auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &active,
    };
    let operation = "cd".repeat(32);
    assert!(manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"text",
            &action.command,
            &auth
        )
        .is_err());
    assert!(manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"text",
            &action.command,
            &active_auth
        )
        .is_err());
    assert!(manager
        .ledger
        .input_state(&action.scope, &action.action_id, &operation)
        .is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn failed_close_receipt_stays_uncertain_after_eof_and_cannot_be_replayed() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let mut action = request(
        root.path(),
        &"ab".repeat(32),
        "cat > marker",
        Duration::from_secs(10),
    );
    action.scope.incarnation = Some(uuid::Uuid::new_v4());
    action.interactive = true;
    manager.start(action.clone(), Some(&action)).await.unwrap();
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    let auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &cancellation,
    };
    manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &"cd".repeat(32),
            b"hello",
            &action.command,
            &auth,
        )
        .unwrap();
    assert!(manager
        .close_input_for_actor(
            &action.scope,
            &action.action_id,
            &"cd".repeat(32),
            &action.command,
            &auth
        )
        .is_err());
    let ledger_db =
        rusqlite::Connection::open(root.path().join("ledger/receipts.sqlite3")).unwrap();
    ledger_db.execute_batch("CREATE TRIGGER reject_close_receipt BEFORE UPDATE ON background_input_receipts BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END;").unwrap();
    let close_operation = "ef".repeat(32);
    let error = manager
        .close_input_for_actor(
            &action.scope,
            &action.action_id,
            &close_operation,
            &action.command,
            &auth,
        )
        .unwrap_err();
    assert!(error.contains("uncertain"));
    assert_eq!(
        manager
            .wait(
                &action.scope,
                &action.action_id,
                Duration::from_secs(5),
                &cancellation
            )
            .await
            .unwrap()
            .state,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("marker")).unwrap(),
        "hello"
    );
    assert_eq!(
        manager
            .ledger
            .input_state(&action.scope, &action.action_id, &close_operation)
            .unwrap(),
        ledger::InputReceiptState::Uncertain
    );
    assert!(manager
        .close_input_for_actor(
            &action.scope,
            &action.action_id,
            &close_operation,
            &action.command,
            &auth
        )
        .is_err());
    drop(ledger_db);
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn interactive_input_receipt_survives_shutdown_without_persisting_text_or_replaying() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(&path, gate.clone()).unwrap();
    let mut action = request(
        root.path(),
        &"ab".repeat(32),
        "IFS= read -r line; printf '%s' \"$line\" > marker; sleep 30",
        Duration::from_secs(40),
    );
    action.scope.incarnation = Some(uuid::Uuid::new_v4());
    action.interactive = true;
    manager.start(action.clone(), Some(&action)).await.unwrap();
    let cancel = crate::v4_agent::interaction::Cancellation::default();
    let auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &cancel,
    };
    let operation = "cd".repeat(32);
    manager
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"synthetic-private-input\n",
            &action.command,
            &auth,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while std::fs::read_to_string(root.path().join("marker"))
            .ok()
            .as_deref()
            != Some("synthetic-private-input")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager.shutdown().await.unwrap();
    drop(manager);
    assert!(!std::fs::read(path.join("receipts.sqlite3"))
        .unwrap()
        .windows(b"synthetic-private-input".len())
        .any(|window| window == b"synthetic-private-input"));
    let reopened = BackgroundProcesses::open_controlled(&path, gate).unwrap();
    assert_eq!(
        reopened
            .ledger
            .input_state(&action.scope, &action.action_id, &operation)
            .unwrap(),
        ledger::InputReceiptState::Delivered
    );
    assert!(reopened
        .write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"synthetic-private-input\n",
            &action.command,
            &auth
        )
        .is_err());
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn input_receipts_prevent_replay_across_restart_and_session_retirement() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let action = "ab".repeat(32);
    let operation = "cd".repeat(32);
    let command_key = manager.ledger.claim(&scope, &action).unwrap();
    let other_action = "12".repeat(32);
    let other_key = manager.ledger.claim(&scope, &other_action).unwrap();
    let stale_claim = manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .unwrap();
    assert_eq!(
        manager
            .ledger
            .input_state(&scope, &action, &operation)
            .unwrap(),
        ledger::InputReceiptState::Uncertain
    );
    assert!(manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .is_err());
    assert!(manager
        .ledger
        .claim_input(&scope, &other_action, &operation)
        .is_err());
    let mut foreign = scope.clone();
    foreign.owner = "other".into();
    assert!(manager
        .ledger
        .input_state(&foreign, &action, &operation)
        .is_err());
    drop(manager);

    let manager = BackgroundProcesses::open(&path).unwrap();
    assert_eq!(
        manager
            .ledger
            .input_state(&scope, &action, &operation)
            .unwrap(),
        ledger::InputReceiptState::Uncertain
    );
    assert!(manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .is_err());
    assert!(manager
        .ledger
        .finish_input(stale_claim, ledger::InputReceiptState::Delivered)
        .is_err());
    let second = "ef".repeat(32);
    let claim = manager
        .ledger
        .claim_input(&scope, &action, &second)
        .unwrap();
    manager
        .ledger
        .finish_input(claim, ledger::InputReceiptState::Delivered)
        .unwrap();
    assert_eq!(
        manager
            .ledger
            .input_state(&scope, &action, &second)
            .unwrap(),
        ledger::InputReceiptState::Delivered
    );
    assert!(manager
        .ledger
        .claim_input(&scope, &action, &second)
        .is_err());
    manager
        .ledger
        .finish(&command_key, &BackgroundState::Cancelled)
        .unwrap();
    manager
        .ledger
        .finish(&other_key, &BackgroundState::Cancelled)
        .unwrap();
    manager
        .ledger
        .retire_session(&scope.owner, &scope.session)
        .unwrap();
    assert!(manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn input_receipt_migration_is_durable_and_missing_upgraded_table_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let guard = root.path().join(".ledger.background-guard");
    assert_eq!(
        std::fs::read(&guard).unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let action = "ab".repeat(32);
    manager.ledger.claim(&scope, &action).unwrap();
    manager
        .ledger
        .claim_input(&scope, &action, &"cd".repeat(32))
        .unwrap();
    drop(manager);
    assert_eq!(
        std::fs::read(&guard).unwrap(),
        b"v4-background-ledger-v3-ready\n"
    );
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute("DROP TABLE background_input_receipts", [])
        .unwrap();
    drop(db);
    assert!(BackgroundProcesses::open(&path).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_input_scope_does_not_upgrade_the_ledger() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    assert!(manager
        .ledger
        .claim_input(&scope, &"ab".repeat(32), &"cd".repeat(32))
        .is_err());
    assert_eq!(
        std::fs::read(root.path().join(".ledger.background-guard")).unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_input_outcome_commit_stays_uncertain_and_rejects_replay() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let action = "ab".repeat(32);
    let operation = "cd".repeat(32);
    manager.ledger.claim(&scope, &action).unwrap();
    let claim = manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .unwrap();
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_input_update BEFORE UPDATE ON background_input_receipts BEGIN SELECT RAISE(FAIL, 'test failure'); END;").unwrap();
    assert!(manager
        .ledger
        .finish_input(claim, ledger::InputReceiptState::Delivered)
        .is_err());
    drop(db);
    drop(manager);
    let manager = BackgroundProcesses::open(&path).unwrap();
    assert_eq!(
        manager
            .ledger
            .input_state(&scope, &action, &operation)
            .unwrap(),
        ledger::InputReceiptState::Uncertain
    );
    assert!(manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn input_receipt_capacity_rejects_new_operations_until_session_retirement() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let action = "ab".repeat(32);
    let command_key = manager.ledger.claim(&scope, &action).unwrap();
    let first = "cd".repeat(32);
    let claim = manager.ledger.claim_input(&scope, &action, &first).unwrap();
    manager
        .ledger
        .finish_input(claim, ledger::InputReceiptState::Delivered)
        .unwrap();
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1023) INSERT INTO background_input_receipts(key,owner_key,session_key,action_key,state) SELECT CAST('filler-' || n AS BLOB), owner_key, session_key, action_key, 'delivered' FROM background_input_receipts CROSS JOIN seq WHERE length(key)=32;").unwrap();
    drop(db);
    assert!(manager
        .ledger
        .claim_input(&scope, &action, &"ef".repeat(32))
        .unwrap_err()
        .contains("capacity"));
    assert_eq!(
        manager.ledger.input_state(&scope, &action, &first).unwrap(),
        ledger::InputReceiptState::Delivered
    );
    manager
        .ledger
        .finish(&command_key, &BackgroundState::Cancelled)
        .unwrap();
    manager
        .ledger
        .retire_session(&scope.owner, &scope.session)
        .unwrap();
    assert!(manager.ledger.input_state(&scope, &action, &first).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn input_replay_record_survives_pruning_of_the_command_receipt() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let action = "ab".repeat(32);
    let operation = "cd".repeat(32);
    let key = manager.ledger.claim(&scope, &action).unwrap();
    let claim = manager
        .ledger
        .claim_input(&scope, &action, &operation)
        .unwrap();
    manager
        .ledger
        .finish_input(claim, ledger::InputReceiptState::Delivered)
        .unwrap();
    manager
        .ledger
        .finish(&key, &BackgroundState::Cancelled)
        .unwrap();
    for index in 0..40 {
        let key = manager
            .ledger
            .claim(&scope, &format!("{index:064x}"))
            .unwrap();
        manager
            .ledger
            .finish(&key, &BackgroundState::Cancelled)
            .unwrap();
    }
    assert!(manager.ledger.read(&scope, &action).is_err());
    assert_eq!(
        manager
            .ledger
            .input_state(&scope, &action, &operation)
            .unwrap(),
        ledger::InputReceiptState::Delivered
    );
    let other = "ef".repeat(32);
    manager.ledger.claim(&scope, &other).unwrap();
    assert!(manager
        .ledger
        .claim_input(&scope, &other, &operation)
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn receipt_keys_bind_session_incarnation_and_reject_legacy_replay() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger.sqlite"))
            .unwrap();
    let mut first = request(
        root.path(),
        "incarnation-action",
        "printf done",
        Duration::from_secs(3),
    );
    first.scope.incarnation = Some(uuid::Uuid::new_v4());
    manager
        .ledger
        .claim(&first.scope, &first.action_id)
        .unwrap();
    assert!(matches!(
        manager.ledger.read(&first.scope, &first.action_id),
        Ok(BackgroundState::Unknown)
    ));
    let mut recreated = first.scope.clone();
    recreated.incarnation = Some(uuid::Uuid::new_v4());
    assert!(manager.ledger.read(&recreated, &first.action_id).is_err());
    let legacy = request(
        root.path(),
        "legacy-action",
        "printf done",
        Duration::from_secs(3),
    );
    manager
        .ledger
        .claim(&legacy.scope, &legacy.action_id)
        .unwrap();
    let mut upgraded = legacy.scope.clone();
    upgraded.incarnation = Some(uuid::Uuid::new_v4());
    assert!(manager.ledger.claim(&upgraded, &legacy.action_id).is_err());
}
use std::time::Duration;

#[cfg(unix)]
#[tokio::test]
async fn output_notification_is_bounded_and_cancel_does_not_stop_command() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let id = "ab".repeat(32);
    let (cancel, _) = watch::channel(false);
    let (done, _) = watch::channel(false);
    let entry = Arc::new(Entry {
        action_id: id.clone(),
        scope: scope.clone(),
        state: Mutex::new(BackgroundState::Running),
        stdout: Mutex::new(Output::default()),
        stderr: Mutex::new(Output::default()),
        cancel,
        done,
        output_revision: watch::channel(0).0,
        #[cfg(unix)]
        input: Mutex::new(None),
        authorization_generation: Some(0),
    });
    manager
        .registry
        .lock()
        .await
        .entries
        .insert(Ledger::key(&scope, &id).unwrap(), entry.clone());
    entry.output_revision.send_modify(|revision| *revision = 1);
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    assert_eq!(
        manager
            .wait_output_revision(&scope, &id, 0, Duration::from_secs(1), &cancellation)
            .await
            .unwrap(),
        1
    );
    assert!(manager
        .wait_output_revision(&scope, &id, 2, Duration::from_secs(1), &cancellation)
        .await
        .is_err());
    let waiting = {
        let manager = manager.clone();
        let scope = scope.clone();
        let id = id.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            manager
                .wait_output_revision(&scope, &id, 1, Duration::from_secs(5), &cancellation)
                .await
        })
    };
    tokio::task::yield_now().await;
    cancellation.cancel();
    assert!(waiting.await.unwrap().is_err());
    assert!(!*entry.cancel.borrow());
}

#[cfg(unix)]
#[tokio::test]
async fn list_for_actor_excludes_other_scopes_and_withholds_output() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let mut other_owner = scope.clone();
    other_owner.owner = "other".into();
    let mut other_session = scope.clone();
    other_session.session = "other".into();
    let mut other_workspace = scope.clone();
    other_workspace.workspace = root.path().join("other");
    let mut other_incarnation = scope.clone();
    other_incarnation.incarnation = Some(uuid::Uuid::new_v4());
    {
        let mut registry = manager.registry.lock().await;
        for (number, candidate) in [
            scope.clone(),
            other_owner,
            other_session,
            other_workspace,
            other_incarnation,
        ]
        .into_iter()
        .enumerate()
        {
            let key = vec![number as u8];
            let (cancel, _) = watch::channel(false);
            let (done, _) = watch::channel(true);
            registry.entries.insert(
                key.clone(),
                Arc::new(Entry {
                    output_revision: watch::channel(0).0,
                    #[cfg(unix)]
                    input: Mutex::new(None),
                    authorization_generation: Some(0),
                    scope: candidate,
                    action_id: format!("{number:064x}"),
                    state: Mutex::new(BackgroundState::Exited { code: Some(0) }),
                    stdout: Mutex::new(Output {
                        bytes: b"sensitive output".to_vec(),
                        ..Default::default()
                    }),
                    stderr: Mutex::new(Output::default()),
                    cancel,
                    done,
                }),
            );
            registry.order.push_back(key);
        }
    }
    let result = manager
        .list_for_actor(
            &scope,
            0,
            i64::MAX,
            &crate::v4_agent::interaction::Cancellation::default(),
        )
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].0, format!("{:064x}", 0));
    assert!(result[0].1.stdout.is_empty());
    assert!(result[0].1.output_withheld);
}

#[cfg(unix)]
#[tokio::test]
async fn list_for_actor_recovers_bounded_receipts_without_crossing_scope() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let first = "ab".repeat(32);
    let second = "cd".repeat(32);
    let manager = BackgroundProcesses::create_controlled(&path, gate.clone()).unwrap();
    let key = manager.ledger.claim(&scope, &first).unwrap();
    manager
        .ledger
        .finish(&key, &BackgroundState::Exited { code: Some(0) })
        .unwrap();
    let unknown = manager.ledger.claim(&scope, &second).unwrap();
    let mut other_workspace = scope.clone();
    other_workspace.workspace = root.path().join("other");
    let other = manager
        .ledger
        .claim(&other_workspace, &"ef".repeat(32))
        .unwrap();
    manager
        .ledger
        .finish(&other, &BackgroundState::Cancelled)
        .unwrap();
    let mut other_owner = scope.clone();
    other_owner.owner = "other".into();
    let other = manager
        .ledger
        .claim(&other_owner, &"23".repeat(32))
        .unwrap();
    manager
        .ledger
        .finish(&other, &BackgroundState::Cancelled)
        .unwrap();
    let mut other_session = scope.clone();
    other_session.session = "other".into();
    let other = manager
        .ledger
        .claim(&other_session, &"45".repeat(32))
        .unwrap();
    manager
        .ledger
        .finish(&other, &BackgroundState::Cancelled)
        .unwrap();
    let mut other_incarnation = scope.clone();
    other_incarnation.incarnation = Some(uuid::Uuid::new_v4());
    let other = manager
        .ledger
        .claim(&other_incarnation, &"01".repeat(32))
        .unwrap();
    manager
        .ledger
        .finish(&other, &BackgroundState::Cancelled)
        .unwrap();
    drop(manager);
    let manager = BackgroundProcesses::open_controlled(&path, gate.clone()).unwrap();
    let cancel = crate::v4_agent::interaction::Cancellation::default();
    let listed = manager
        .list_for_actor(&scope, 0, i64::MAX, &cancel)
        .unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|(id, snapshot)| (id.clone(), snapshot.state.clone(), snapshot.output_withheld))
            .collect::<Vec<_>>(),
        vec![
            (second, BackgroundState::Unknown, true),
            (first, BackgroundState::Exited { code: Some(0) }, true),
        ]
    );
    assert!(listed
        .iter()
        .all(|(_, snapshot)| snapshot.stdout.is_empty() && snapshot.stderr.is_empty()));
    manager
        .ledger
        .finish(&unknown, &BackgroundState::FailedToStart)
        .unwrap();
    manager
        .ledger
        .retire_session(&scope.owner, &scope.session)
        .unwrap();
    assert!(manager
        .list_for_actor(&scope, 0, i64::MAX, &cancel)
        .unwrap()
        .is_empty());
    assert_eq!(
        manager.ledger.read(&other_owner, &"23".repeat(32)).unwrap(),
        BackgroundState::Cancelled
    );
    assert_eq!(
        manager
            .ledger
            .read(&other_session, &"45".repeat(32))
            .unwrap(),
        BackgroundState::Cancelled
    );
    cancel.cancel();
    assert!(manager
        .list_for_actor(&scope, 0, i64::MAX, &cancel)
        .is_err());
    gate.hold("owner", "logout-fixture").unwrap();
    assert!(manager
        .list_for_actor(
            &scope,
            0,
            i64::MAX,
            &crate::v4_agent::interaction::Cancellation::default()
        )
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn receipt_index_migration_preserves_legacy_status_without_inventing_a_list_entry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let old_id = "ab".repeat(32);
    let manager = BackgroundProcesses::create_controlled(&path, gate.clone()).unwrap();
    let key = manager.ledger.claim(&scope, &old_id).unwrap();
    manager
        .ledger
        .finish(&key, &BackgroundState::Exited { code: Some(7) })
        .unwrap();
    drop(manager);
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute("ALTER TABLE receipts DROP COLUMN action_id", [])
        .unwrap();
    drop(db);
    let manager = BackgroundProcesses::open_controlled(&path, gate).unwrap();
    assert_eq!(
        manager.ledger.read(&scope, &old_id).unwrap(),
        BackgroundState::Exited { code: Some(7) }
    );
    let cancel = crate::v4_agent::interaction::Cancellation::default();
    assert!(manager
        .list_for_actor(&scope, 0, i64::MAX, &cancel)
        .unwrap()
        .is_empty());
    let new_id = "cd".repeat(32);
    let key = manager.ledger.claim(&scope, &new_id).unwrap();
    manager
        .ledger
        .finish(&key, &BackgroundState::Cancelled)
        .unwrap();
    let list = manager
        .list_for_actor(&scope, 0, i64::MAX, &cancel)
        .unwrap();
    assert_eq!(
        list.iter()
            .map(|(id, snapshot)| (id.clone(), snapshot.state.clone()))
            .collect::<Vec<_>>(),
        vec![(new_id, BackgroundState::Cancelled)]
    );
    assert!(manager.ledger.claim(&scope, &old_id).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn receipt_index_migration_recovers_identifiers_from_retained_launch_metadata() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let id = "ef".repeat(32);
    let manager = BackgroundProcesses::create_controlled(&path, gate.clone()).unwrap();
    let key = manager.ledger.claim(&scope, &id).unwrap();
    manager
        .ledger
        .record_launch(&key, &scope, &id, 12345, 12345, None)
        .unwrap();
    let finished_id = "cd".repeat(32);
    let finished_key = manager.ledger.claim(&scope, &finished_id).unwrap();
    manager
        .ledger
        .record_launch(&finished_key, &scope, &finished_id, 12346, 12346, None)
        .unwrap();
    manager
        .ledger
        .finish_launched(
            &finished_key,
            &BackgroundState::Exited { code: Some(3) },
            None,
        )
        .unwrap();
    drop(manager);
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute("ALTER TABLE receipts DROP COLUMN action_id", [])
        .unwrap();
    drop(db);
    let manager = BackgroundProcesses::open_controlled(&path, gate).unwrap();
    let cancel = crate::v4_agent::interaction::Cancellation::default();
    let listed = manager
        .list_for_actor(&scope, 0, i64::MAX, &cancel)
        .unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|(id, snapshot)| (id.clone(), snapshot.state.clone()))
            .collect::<Vec<_>>(),
        vec![
            (finished_id, BackgroundState::Exited { code: Some(3) }),
            (id, BackgroundState::Unknown),
        ]
    );
    let mut other = scope.clone();
    other.incarnation = Some(uuid::Uuid::new_v4());
    assert!(manager
        .list_for_actor(&other, 0, i64::MAX, &cancel)
        .unwrap()
        .is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn indexed_list_respects_pruning_and_failed_claim_rolls_back_everything() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "session".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::new_v4()),
    };
    let manager = BackgroundProcesses::create_controlled(&path, gate).unwrap();
    for index in 0..40 {
        let id = format!("{index:064x}");
        let key = manager.ledger.claim(&scope, &id).unwrap();
        manager
            .ledger
            .finish(&key, &BackgroundState::Exited { code: Some(0) })
            .unwrap();
    }
    let cancel = crate::v4_agent::interaction::Cancellation::default();
    let ids = || {
        manager
            .list_for_actor(&scope, 0, i64::MAX, &cancel)
            .unwrap()
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>()
    };
    let before = ids();
    assert_eq!(
        before,
        (8..40)
            .rev()
            .map(|index| format!("{index:064x}"))
            .collect::<Vec<_>>()
    );
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_index BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
    let rejected = format!("{:064x}", 40);
    assert!(manager.ledger.claim(&scope, &rejected).is_err());
    assert!(manager.ledger.read(&scope, &rejected).is_err());
    assert_eq!(ids(), before);
    db.execute_batch("DROP TRIGGER reject_index").unwrap();
    manager.ledger.claim(&scope, &rejected).unwrap();
    assert_eq!(
        manager.ledger.read(&scope, &rejected).unwrap(),
        BackgroundState::Unknown
    );
}

#[cfg(unix)]
#[tokio::test]
async fn indexed_list_rejects_nil_incarnation_even_when_no_receipts_exist() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let scope = BackgroundScope {
        owner: "owner".into(),
        session: "empty".into(),
        workspace: root.path().canonicalize().unwrap(),
        incarnation: Some(uuid::Uuid::nil()),
    };
    assert!(manager
        .list_for_actor(
            &scope,
            0,
            i64::MAX,
            &crate::v4_agent::interaction::Cancellation::default()
        )
        .is_err());
}

#[cfg(unix)]
fn initialize_controlled_gate(db: &rusqlite::Connection) {
    db.execute_batch("CREATE TABLE IF NOT EXISTS auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
    owner_gate::OwnerGate::initialize(db).unwrap();
}

fn request(
    root: &std::path::Path,
    id: &str,
    command: &str,
    timeout: Duration,
) -> BackgroundRequest {
    BackgroundRequest {
        interactive: false,
        scope: BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: root.canonicalize().unwrap(),
            incarnation: None,
        },
        authorization_generation: Some(0),
        action_id: id.into(),
        command: command.into(),
        timeout,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn controlled_start_rejects_missing_or_revoked_authorization_after_logout_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let mut stale = request(
        root.path(),
        "stale",
        "printf launched > marker",
        Duration::from_secs(2),
    );
    stale.authorization_generation = Some(0);
    let mut missing = stale.clone();
    missing.action_id = "missing".into();
    missing.authorization_generation = None;
    assert!(manager
        .start(missing.clone(), Some(&missing))
        .await
        .is_err());
    assert!(manager
        .snapshot(&missing.scope, &missing.action_id)
        .await
        .is_err());
    let mut db = rusqlite::Connection::open(database).unwrap();
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    owner_gate::OwnerGate::hold_in_transaction(&tx, "owner", "logout").unwrap();
    tx.execute(
        "INSERT INTO auth_generations (user_id, generation) VALUES ('owner', 1)",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    manager.service_owner_holds().await.unwrap();
    gate.release("owner", "logout").unwrap();
    assert!(manager.start(stale.clone(), Some(&stale)).await.is_err());
    assert!(manager
        .snapshot(&stale.scope, &stale.action_id)
        .await
        .is_err());
    assert!(!root.path().join("marker").exists());
    let mut fresh = stale;
    fresh.action_id = "fresh".into();
    fresh.authorization_generation = Some(1);
    manager.start(fresh.clone(), Some(&fresh)).await.unwrap();
    assert_eq!(
        finished(&manager, &fresh).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    assert!(root.path().join("marker").exists());
    manager.shutdown().await.unwrap();
}

async fn finished(
    manager: &BackgroundProcesses,
    request: &BackgroundRequest,
) -> BackgroundSnapshot {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let snapshot = manager
                .snapshot(&request.scope, &request.action_id)
                .await
                .unwrap();
            if !matches!(snapshot.state, BackgroundState::Running) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process did not finish")
}

#[cfg(unix)]
#[tokio::test]
async fn approval_is_bound_to_exact_action_and_replay_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(root.path(), "one", "printf hello", Duration::from_secs(2));
    let mut other = request.clone();
    other.command = "printf wrong".into();
    assert!(manager.start(request.clone(), Some(&other)).await.is_err());
    assert!(manager.start(request.clone(), None).await.is_err());
    assert!(matches!(
        manager
            .start(request.clone(), Some(&request))
            .await
            .unwrap()
            .state,
        BackgroundState::Running
    ));
    let snapshot = finished(&manager, &request).await;
    assert_eq!(snapshot.state, BackgroundState::Exited { code: Some(0) });
    assert_eq!(snapshot.stdout, "");
    assert!(snapshot.output_withheld);
    assert!(manager
        .start(request.clone(), Some(&request))
        .await
        .is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn scope_is_required_for_read_and_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(root.path(), "scope", "sleep 10", Duration::from_secs(20));
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    for scope in [
        BackgroundScope {
            owner: "other".into(),
            ..request.scope.clone()
        },
        BackgroundScope {
            session: "other".into(),
            ..request.scope.clone()
        },
        BackgroundScope {
            workspace: root.path().join("other"),
            ..request.scope.clone()
        },
    ] {
        assert!(manager.snapshot(&scope, &request.action_id).await.is_err());
        assert!(manager.cancel(&scope, &request.action_id).await.is_err());
    }
    manager
        .cancel(&request.scope, &request.action_id)
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &request).await.state,
        BackgroundState::Cancelled
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn output_remains_bounded_utf8_while_both_pipes_are_drained() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let command = "python3 -c 'import os; os.write(1, (\"é\" * 70000).encode()); os.write(2, b\"x\" * 140000)'";
    let request = request(root.path(), "output", command, Duration::from_secs(5));
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    let snapshot = finished(&manager, &request).await;
    assert_eq!(snapshot.state, BackgroundState::Exited { code: Some(0) });
    assert!(snapshot.stdout.len() <= OUTPUT_LIMIT && snapshot.stderr.len() <= OUTPUT_LIMIT);
    assert!(snapshot.stdout_truncated && snapshot.stderr_truncated);
    assert!(snapshot.stdout.is_empty() && snapshot.stderr.is_empty());
    assert!(snapshot.output_withheld);
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_and_shutdown_stop_and_reap_children() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let timed = request(root.path(), "timed", "sleep 10", Duration::from_millis(100));
    manager.start(timed.clone(), Some(&timed)).await.unwrap();
    assert_eq!(
        finished(&manager, &timed).await.state,
        BackgroundState::TimedOut
    );
    let running = request(root.path(), "shutdown", "sleep 10", Duration::from_secs(20));
    manager
        .start(running.clone(), Some(&running))
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
    assert_eq!(
        manager
            .snapshot(&running.scope, &running.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Cancelled
    );
    assert!(manager
        .start(running.clone(), Some(&running))
        .await
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_after_exit_preserves_the_exit_result() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(
        root.path(),
        "already-exited",
        "exit 7",
        Duration::from_secs(3),
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &request).await.state,
        BackgroundState::Exited { code: Some(7) }
    );
    manager
        .cancel(&request.scope, &request.action_id)
        .await
        .unwrap();
    assert_eq!(
        manager
            .snapshot(&request.scope, &request.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Exited { code: Some(7) }
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_reaps_the_running_root_process() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(
        root.path(),
        "pid",
        "echo $$; exec sleep 30",
        Duration::from_secs(40),
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    let pid: i32 = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let entry = manager
                .entry(&request.scope, &request.action_id)
                .await
                .unwrap();
            let output = entry.stdout.lock().unwrap().text();
            if let Ok(pid) = output.trim().parse() {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    manager.shutdown().await.unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "root was not reaped");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_stops_an_observed_separate_session_descendant() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("fixture.py");
    std::fs::write(&script, r#"
import subprocess, sys, time
source = "import signal,time,pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(1.5); pathlib.Path('escaped').write_text('unexpected')"
subprocess.Popen([sys.executable, '-c', source], start_new_session=True)
print('ready', flush=True)
time.sleep(30)
"#).unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(
        root.path(),
        "descendant",
        "exec python3 fixture.py",
        Duration::from_secs(10),
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if manager
                .entry(&request.scope, &request.action_id)
                .await
                .unwrap()
                .stdout
                .lock()
                .unwrap()
                .text()
                .contains("ready")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    manager
        .cancel(&request.scope, &request.action_id)
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &request).await.state,
        BackgroundState::Cancelled
    );
    manager.shutdown().await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!root.path().join("escaped").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn interrupted_shutdown_does_not_lose_the_reaping_barrier() {
    let root = tempfile::tempdir().unwrap();
    let manager = std::sync::Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    let request = request(
        root.path(),
        "shutdown-interrupted",
        "trap '' TERM; echo ready; sleep 30",
        Duration::from_secs(40),
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if manager
                .entry(&request.scope, &request.action_id)
                .await
                .unwrap()
                .stdout
                .lock()
                .unwrap()
                .text()
                .contains("ready")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let first_manager = manager.clone();
    let first = tokio::spawn(async move { first_manager.shutdown().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    first.abort();
    let _ = first.await;
    tokio::time::timeout(Duration::from_secs(4), manager.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        manager
            .snapshot(&request.scope, &request.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Cancelled
    );
}

#[cfg(unix)]
#[tokio::test]
async fn durable_receipts_reject_replay_and_preserve_scope_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let request = request(
        root.path(),
        "durable",
        "printf harmless",
        Duration::from_secs(3),
    );
    let manager = BackgroundProcesses::create(&path).unwrap();
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &request).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    let receipt = reopened
        .snapshot(&request.scope, &request.action_id)
        .await
        .unwrap();
    assert_eq!(receipt.state, BackgroundState::Exited { code: Some(0) });
    assert_eq!(receipt.stdout, "");
    assert!(reopened
        .start(request.clone(), Some(&request))
        .await
        .is_err());
    let mut other = request.clone();
    other.scope.owner = "different".into();
    assert!(reopened
        .snapshot(&other.scope, &other.action_id)
        .await
        .is_err());
    reopened.start(other.clone(), Some(&other)).await.unwrap();
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn opening_a_missing_receipt_directory_never_initializes_a_new_ledger() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    assert!(BackgroundProcesses::open(&path).is_err());
    assert!(!path.exists());
    let manager = BackgroundProcesses::create(&path).unwrap();
    assert!(BackgroundProcesses::create(&path).is_err());
    manager.shutdown().await.unwrap();
    drop(manager);
    std::fs::remove_dir_all(&path).unwrap();
    assert!(BackgroundProcesses::open(&path).is_err());
    assert!(!path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn lost_receipt_directory_cannot_be_replaced_by_explicit_creation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let request = request(root.path(), "retained", "exit 0", Duration::from_secs(3));
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &request).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
    drop(manager);
    std::fs::remove_dir_all(&path).unwrap();
    assert!(BackgroundProcesses::create(&path).is_err());
    assert!(!path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn missing_or_damaged_provision_guard_cannot_reopen_or_recreate_the_ledger() {
    for guard_value in [
        Some(&b"v4-background-ledger-v2-pending\n"[..]),
        Some(&b"v4-background-ledger-v1-ready\n"[..]),
        None,
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap().join("ledger");
        let guard = root.path().join(".ledger.background-guard");
        let manager = BackgroundProcesses::create(&path).unwrap();
        manager.shutdown().await.unwrap();
        drop(manager);
        if let Some(value) = guard_value {
            std::fs::write(&guard, value).unwrap();
        } else {
            std::fs::remove_file(&guard).unwrap();
        }
        assert!(BackgroundProcesses::open(&path).is_err());
        assert!(BackgroundProcesses::create(&path).is_err());
        assert!(BackgroundProcesses::open(&path).is_err());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn missing_or_empty_receipt_database_cannot_be_reinitialized() {
    for empty_replacement in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap().join("ledger");
        let manager = BackgroundProcesses::create(&path).unwrap();
        let request = request(root.path(), "retained", "exit 0", Duration::from_secs(3));
        manager
            .start(request.clone(), Some(&request))
            .await
            .unwrap();
        assert_eq!(
            finished(&manager, &request).await.state,
            BackgroundState::Exited { code: Some(0) }
        );
        manager.shutdown().await.unwrap();
        drop(manager);
        let database = path.join("receipts.sqlite3");
        std::fs::remove_file(&database).unwrap();
        if empty_replacement {
            use std::os::unix::fs::PermissionsExt;
            std::fs::File::create(&database).unwrap();
            std::fs::set_permissions(&database, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(
            BackgroundProcesses::open(&path).is_err(),
            "lost receipt database must not be recreated"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn reopening_does_not_recreate_a_missing_ledger_lock() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    manager.shutdown().await.unwrap();
    drop(manager);
    let lock = path.join("owner.lock");
    std::fs::remove_file(&lock).unwrap();
    assert!(BackgroundProcesses::open(&path).is_err());
    assert!(!lock.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn missing_retirement_table_is_not_recreated_when_reopening() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    manager.shutdown().await.unwrap();
    drop(manager);
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("DROP TABLE retired_sessions").unwrap();
    drop(db);
    assert!(BackgroundProcesses::open(&path).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn unfinished_claim_is_unknown_and_excludes_replay_after_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let request = request(
        root.path(),
        "crash",
        "printf harmless",
        Duration::from_secs(3),
    );
    let manager = BackgroundProcesses::create(&path).unwrap();
    manager
        .ledger
        .claim(&request.scope, &request.action_id)
        .unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    assert_eq!(
        reopened
            .snapshot(&request.scope, &request.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Unknown
    );
    assert!(reopened
        .start(request.clone(), Some(&request))
        .await
        .is_err());
    assert!(reopened
        .cancel(&request.scope, &request.action_id)
        .await
        .is_err());
    assert!(reopened
        .cleanup_session(&request.scope.owner, &request.scope.session)
        .await
        .is_err());
    assert!(reopened.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn restart_with_unknown_process_blocks_new_actions_until_recovery_is_confirmed() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let original = request(root.path(), "crashed", "exit 0", Duration::from_secs(3));
    manager
        .ledger
        .claim(&original.scope, &original.action_id)
        .unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    let mut other = request(
        root.path(),
        "fresh",
        "printf ran > marker",
        Duration::from_secs(3),
    );
    other.scope.owner = "other-owner".into();
    other.scope.session = "other-session".into();
    assert!(reopened.start(other.clone(), Some(&other)).await.is_err());
    assert!(!root.path().join("marker").exists());
    assert_eq!(
        reopened
            .snapshot(&original.scope, &original.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Unknown
    );
    assert!(reopened
        .cleanup_session(&original.scope.owner, &original.scope.session)
        .await
        .is_err());
    assert!(reopened
        .retire_session(&original.scope.owner, &original.scope.session)
        .await
        .is_err());
    assert!(reopened.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn malformed_outcome_blocks_recovery_and_session_retirement() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let original = request(root.path(), "damaged", "exit 0", Duration::from_secs(3));
    manager
        .ledger
        .claim(&original.scope, &original.action_id)
        .unwrap();
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute("UPDATE receipts SET state='invalid'", [])
        .unwrap();
    drop(db);
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    let mut other = original.clone();
    other.scope.session = "other".into();
    other.action_id = "new".into();
    assert!(reopened.start(other.clone(), Some(&other)).await.is_err());
    assert!(reopened
        .cleanup_session(&original.scope.owner, &original.scope.session)
        .await
        .is_err());
    assert!(reopened
        .retire_session(&original.scope.owner, &original.scope.session)
        .await
        .is_err());
    assert!(reopened.shutdown().await.is_err());
}

#[cfg(unix)]
#[test]
fn dropped_ledger_releases_locks_even_when_a_forked_child_inherits_descriptors() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let mut ready = [-1; 2];
    let mut release = [-1; 2];
    unsafe {
        assert_eq!(libc::pipe(ready.as_mut_ptr()), 0);
        assert_eq!(libc::pipe(release.as_mut_ptr()), 0);
        let pid = libc::fork();
        assert!(pid >= 0);
        if pid == 0 {
            libc::close(ready[0]);
            libc::close(release[1]);
            manager.ledger.release_owned_locks();
            let byte = [1_u8];
            libc::write(ready[1], byte.as_ptr().cast(), 1);
            let mut signal = [0_u8];
            libc::read(release[0], signal.as_mut_ptr().cast(), 1);
            libc::_exit(0);
        }
        libc::close(ready[1]);
        libc::close(release[0]);
        let mut signal = [0_u8];
        assert_eq!(libc::read(ready[0], signal.as_mut_ptr().cast(), 1), 1);
        let premature = BackgroundProcesses::open(&path);
        drop(manager);
        let reopened = BackgroundProcesses::open(&path);
        let byte = [1_u8];
        libc::write(release[1], byte.as_ptr().cast(), 1);
        libc::close(ready[0]);
        libc::close(release[1]);
        let mut status = 0;
        assert_eq!(libc::waitpid(pid, &mut status, 0), pid);
        assert!(
            premature.is_err(),
            "a forked child released its parent's ledger lock"
        );
        assert!(
            reopened.is_ok(),
            "a forked child retained the dropped ledger lock"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn one_owner_of_ledger_and_session_cleanup_are_barriers() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    assert!(BackgroundProcesses::open(&path).is_err());
    let request = request(root.path(), "cleanup", "sleep 30", Duration::from_secs(40));
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    manager
        .cleanup_session(&request.scope.owner, &request.scope.session)
        .await
        .unwrap();
    assert_eq!(
        manager
            .snapshot(&request.scope, &request.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Cancelled
    );
    assert!(manager
        .start(request.clone(), Some(&request))
        .await
        .is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn retiring_a_session_reclaims_capacity_and_prevents_all_replay_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let first = request(root.path(), "claim-0", "exit 0", Duration::from_secs(3));
    // Per-session and per-owner caps spread the global budget across scopes.
    for (owner, session) in [
        ("owner", "session"),
        ("owner", "s1"),
        ("owner-b", "s2"),
        ("owner-b", "s3"),
    ] {
        let mut scope = first.scope.clone();
        scope.owner = owner.into();
        scope.session = session.into();
        for i in 0..MAX_SESSION_ACTIONS {
            let key = manager.ledger.claim(&scope, &format!("claim-{i}")).unwrap();
            manager
                .ledger
                .finish(&key, &BackgroundState::Exited { code: Some(0) })
                .unwrap();
        }
    }
    assert_eq!(4 * MAX_SESSION_ACTIONS, MAX_ACTIONS);
    let mut other = first.clone();
    other.scope.session = "different".into();
    manager
        .retire_session(&first.scope.owner, &first.scope.session)
        .await
        .unwrap();
    assert!(manager.start(first.clone(), Some(&first)).await.is_err());
    let mut new_id = first.clone();
    new_id.action_id = "new-id".into();
    assert!(manager.start(new_id.clone(), Some(&new_id)).await.is_err());
    manager.start(other.clone(), Some(&other)).await.unwrap();
    assert_eq!(
        finished(&manager, &other).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    assert!(reopened.start(first.clone(), Some(&first)).await.is_err());
    assert!(reopened.start(new_id.clone(), Some(&new_id)).await.is_err());
    let mut another_owner = first.clone();
    another_owner.scope.owner = "another-owner".into();
    reopened
        .start(another_owner.clone(), Some(&another_owner))
        .await
        .unwrap();
    assert_eq!(
        finished(&reopened, &another_owner).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn retirement_cancels_or_rejects_a_concurrent_start_before_returning() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let req = request(
        root.path(),
        "racing",
        "sleep 1; printf should-not-run > marker",
        Duration::from_secs(3),
    );
    let (_started, retired) = tokio::join!(
        manager.start(req.clone(), Some(&req)),
        manager.retire_session(&req.scope.owner, &req.scope.session),
    );
    retired.unwrap();
    assert!(manager.start(req.clone(), Some(&req)).await.is_err());
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!root.path().join("marker").exists());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn exhausted_retirement_capacity_keeps_existing_replay_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let req = request(root.path(), "kept", "exit 0", Duration::from_secs(3));
    let key = manager.ledger.claim(&req.scope, &req.action_id).unwrap();
    manager
        .ledger
        .finish(&key, &BackgroundState::Exited { code: Some(0) })
        .unwrap();
    let mut db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    let tx = db.transaction().unwrap();
    for i in 0..ledger::MAX_RETIRED_SESSIONS {
        let mut tombstone = [0u8; 32];
        tombstone[..8].copy_from_slice(&i.to_be_bytes());
        tx.execute(
            "INSERT INTO retired_sessions(session_key) VALUES(?1)",
            rusqlite::params![&tombstone[..]],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    assert!(manager
        .retire_session(&req.scope.owner, &req.scope.session)
        .await
        .is_err());
    assert_eq!(
        manager
            .snapshot(&req.scope, &req.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    assert!(reopened.start(req.clone(), Some(&req)).await.is_err());
    assert_eq!(
        reopened
            .snapshot(&req.scope, &req.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Exited { code: Some(0) }
    );
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn failed_unstarted_claim_receipt_blocks_new_background_actions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let first = request(root.path(), "unstarted", "exit 0", Duration::from_secs(3));
    let key = manager
        .ledger
        .claim(&first.scope, &first.action_id)
        .unwrap();
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER prevent_failed_start BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert!(manager.finish_unstarted_claim(&key).is_err());

    let mut second = request(
        root.path(),
        "second",
        "printf unexpected > marker",
        Duration::from_secs(3),
    );
    second.scope.owner = "different-owner".into();
    second.scope.session = "different-session".into();
    assert!(manager.ensure_session_open(&second.scope).await.is_err());
    assert!(manager.start(second.clone(), Some(&second)).await.is_err());
    assert!(!root.path().join("marker").exists());
    assert!(manager.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn unconfirmed_live_result_blocks_new_background_actions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER prevent_completion BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    let first = request(root.path(), "first", "exit 0", Duration::from_secs(3));
    manager.start(first.clone(), Some(&first)).await.unwrap();
    assert_eq!(
        finished(&manager, &first).await.state,
        BackgroundState::Unknown
    );

    let mut second = request(
        root.path(),
        "second",
        "printf unexpected > marker",
        Duration::from_secs(3),
    );
    second.scope.owner = "different-owner".into();
    second.scope.session = "different-session".into();
    assert!(manager.ensure_session_open(&second.scope).await.is_err());
    assert!(manager.start(second.clone(), Some(&second)).await.is_err());
    assert!(!root.path().join("marker").exists());
    assert!(manager.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn failed_retirement_rolls_back_tombstone_and_preserves_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let req = request(root.path(), "kept", "exit 0", Duration::from_secs(3));
    let key = manager.ledger.claim(&req.scope, &req.action_id).unwrap();
    manager
        .ledger
        .finish(&key, &BackgroundState::Exited { code: Some(0) })
        .unwrap();
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER prevent_retirement BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert!(manager
        .retire_session(&req.scope.owner, &req.scope.session)
        .await
        .is_err());
    assert_eq!(
        manager
            .snapshot(&req.scope, &req.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    assert!(reopened.start(req.clone(), Some(&req)).await.is_err());
    let mut new_req = req.clone();
    new_req.action_id = "new-action".into();
    reopened
        .start(new_req.clone(), Some(&new_req))
        .await
        .unwrap();
    assert_eq!(
        finished(&reopened, &new_req).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn unknown_outcomes_prevent_retirement_and_remain_recoverable() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let req = request(root.path(), "unknown", "exit 0", Duration::from_secs(3));
    manager.ledger.claim(&req.scope, &req.action_id).unwrap();
    assert!(manager
        .retire_session(&req.scope.owner, &req.scope.session)
        .await
        .is_err());
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    assert_eq!(
        reopened
            .snapshot(&req.scope, &req.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Unknown
    );
    assert!(reopened.start(req.clone(), Some(&req)).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_claims_launch_only_once_and_retention_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    let request = request(
        root.path(),
        "race",
        "printf run >> executions",
        Duration::from_secs(3),
    );
    let (a, b) = tokio::join!(
        manager.start(request.clone(), Some(&request)),
        manager.start(request.clone(), Some(&request))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(
        finished(&manager, &request).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("executions")).unwrap(),
        "run"
    );
    for i in 1..MAX_ACTIONS {
        let mut scope = request.scope.clone();
        scope.owner = format!("owner-{}", i / 64);
        scope.session = format!("s{}", i / 32 + 1);
        manager.ledger.claim(&scope, &format!("claim-{i}")).unwrap();
    }
    assert!(manager.ledger.claim(&request.scope, "overflow").is_err());
    assert!(manager.shutdown().await.is_err());
    drop(manager);
    let reopened =
        BackgroundProcesses::open(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    assert!(reopened.ledger.claim(&request.scope, "overflow").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn background_crash_fixture() {
    let Some(root) = std::env::var_os("V4_BACKGROUND_CRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    let manager = BackgroundProcesses::create(&root.join("ledger")).unwrap();
    let request = request(
        &root,
        "actual-crash",
        "printf ran > marker; sleep 1; printf survived > after_crash",
        Duration::from_secs(3),
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !root.join("marker").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    unsafe { libc::_exit(0) }
}

#[cfg(unix)]
#[tokio::test]
async fn background_input_crash_fixture() {
    let Some(root) = std::env::var_os("V4_BACKGROUND_INPUT_CRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    let mode = std::env::var("V4_BACKGROUND_INPUT_CRASH_MODE").unwrap();
    let db = rusqlite::Connection::open(root.join("app.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(&root.join("ledger"), gate).unwrap();
    let mut action = request(
        &root,
        &"ab".repeat(32),
        "IFS= read -r line; printf '%s' \"$line\" > marker; sleep 2; printf survived > after_crash",
        Duration::from_secs(10),
    );
    action.scope.incarnation = Some(uuid::Uuid::from_u128(42));
    action.interactive = true;
    manager.start(action.clone(), Some(&action)).await.unwrap();
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    let auth = InputAuthorization {
        generation: 0,
        expires_at: i64::MAX,
        cancellation: &cancellation,
    };
    if mode == "close" {
        manager
            .write_input_for_actor(
                &action.scope,
                &action.action_id,
                &"01".repeat(32),
                b"synthetic-private-input",
                &action.command,
                &auth,
            )
            .unwrap();
    }
    let marker = root.join("marker");
    manager.after_input_effect_for_test(Box::new(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::fs::read_to_string(&marker).ok().as_deref() != Some("synthetic-private-input") {
            if std::time::Instant::now() >= deadline {
                unsafe { libc::_exit(9) }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe { libc::_exit(0) }
    }));
    let operation = "cd".repeat(32);
    if mode == "close" {
        let _ = manager.close_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            &action.command,
            &auth,
        );
    } else {
        let _ = manager.write_input_for_actor(
            &action.scope,
            &action.action_id,
            &operation,
            b"synthetic-private-input\n",
            &action.command,
            &auth,
        );
    }
    panic!("input crash hook was not invoked");
}

#[cfg(unix)]
#[tokio::test]
async fn crash_after_input_effect_keeps_receipt_uncertain_and_never_replays() {
    for mode in ["write", "close"] {
        let root = tempfile::tempdir().unwrap();
        let mut unrelated = tokio::process::Command::new("/bin/sleep")
            .arg("10")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let module = module_path!()
            .split_once("::")
            .map_or(module_path!(), |(_, path)| path);
        let fixture = format!("{module}::background_input_crash_fixture");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &fixture, "--nocapture"])
            .env(
                "V4_BACKGROUND_INPUT_CRASH_FIXTURE",
                root.path().canonicalize().unwrap(),
            )
            .env("V4_BACKGROUND_INPUT_CRASH_MODE", mode)
            .status()
            .unwrap();
        assert!(status.success(), "{mode}: fixture failed: {status}");
        let path = root.path().canonicalize().unwrap().join("ledger");
        let manager = BackgroundProcesses::open(&path).unwrap();
        let mut action = request(
            root.path(),
            &"ab".repeat(32),
            "unused",
            Duration::from_secs(10),
        );
        action.scope.incarnation = Some(uuid::Uuid::from_u128(42));
        let operation = "cd".repeat(32);
        assert_eq!(
            manager
                .ledger
                .input_state(&action.scope, &action.action_id, &operation)
                .unwrap(),
            ledger::InputReceiptState::Uncertain,
            "{mode}"
        );
        let error = manager
            .ledger
            .claim_input(&action.scope, &action.action_id, &operation)
            .err()
            .expect("operation was replayed");
        assert!(error.contains("replay rejected"), "{mode}: {error}");
        assert_eq!(
            std::fs::read_to_string(root.path().join("marker")).unwrap(),
            "synthetic-private-input"
        );
        assert!(!std::fs::read(path.join("receipts.sqlite3"))
            .unwrap()
            .windows(b"synthetic-private-input".len())
            .any(|part| part == b"synthetic-private-input"));
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(
            !root.path().join("after_crash").exists(),
            "{mode}: command survived its supervisor"
        );
        manager.recover_unconfirmed().await.unwrap();
        assert_eq!(
            manager
                .ledger
                .input_state(&action.scope, &action.action_id, &operation)
                .unwrap(),
            ledger::InputReceiptState::Uncertain,
            "{mode}: startup recovery changed the input outcome"
        );
        assert!(
            manager
                .ledger
                .claim_input(&action.scope, &action.action_id, &operation)
                .is_err(),
            "{mode}: startup recovery allowed a replay"
        );
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "{mode}: unrelated process stopped"
        );
        unrelated.kill().await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn crash_after_spawn_is_unknown_and_cannot_launch_again() {
    let root = tempfile::tempdir().unwrap();
    let mut unrelated = tokio::process::Command::new("/bin/sleep")
        .arg("10")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let module = module_path!()
        .split_once("::")
        .map_or(module_path!(), |(_, path)| path);
    let fixture = format!("{module}::background_crash_fixture");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &fixture, "--nocapture"])
        .env(
            "V4_BACKGROUND_CRASH_FIXTURE",
            root.path().canonicalize().unwrap(),
        )
        .status()
        .unwrap();
    assert!(status.success());
    let manager =
        BackgroundProcesses::open(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(
        root.path(),
        "actual-crash",
        "printf ran > marker; sleep 1; printf survived > after_crash",
        Duration::from_secs(3),
    );
    assert_eq!(
        manager
            .snapshot(&request.scope, &request.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Unknown
    );
    assert!(manager
        .start(request.clone(), Some(&request))
        .await
        .is_err());
    let mut other = request.clone();
    other.scope.session = "other-session".into();
    other.action_id = "after-crash".into();
    other.command = "printf denied > should_not_start".into();
    assert!(manager.start(other.clone(), Some(&other)).await.is_err());
    assert!(!root.path().join("should_not_start").exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("marker")).unwrap(),
        "ran"
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        unrelated.try_wait().unwrap().is_none(),
        "unrelated process was stopped"
    );
    unrelated.kill().await.unwrap();
    assert!(
        !root.path().join("after_crash").exists(),
        "same-session command survived its supervisor"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn command_and_output_are_neither_persisted_nor_released() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let request = request(
        root.path(),
        "confidential",
        "printf synthetic_credential_7d12",
        Duration::from_secs(3),
    );
    manager
        .start(request.clone(), Some(&request))
        .await
        .unwrap();
    let snapshot = finished(&manager, &request).await;
    assert!(snapshot.output_withheld);
    assert!(snapshot.stdout.is_empty() && snapshot.stderr.is_empty());
    manager.shutdown().await.unwrap();
    drop(manager);
    let database = std::fs::read(path.join("receipts.sqlite3")).unwrap();
    assert!(!database
        .windows(b"synthetic_credential_7d12".len())
        .any(|part| part == b"synthetic_credential_7d12"));
    let reopened = BackgroundProcesses::open(&path).unwrap();
    assert!(
        reopened
            .snapshot(&request.scope, &request.action_id)
            .await
            .unwrap()
            .output_withheld
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unknown_receipt_only_blocks_its_own_session_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = request(
        root.path(),
        "orphan",
        "printf harmless",
        Duration::from_secs(3),
    );
    manager
        .ledger
        .claim(&request.scope, &request.action_id)
        .unwrap();
    assert!(manager
        .cleanup_session("another-owner", &request.scope.session)
        .await
        .is_ok());
    assert!(manager
        .cleanup_session(&request.scope.owner, "another-session")
        .await
        .is_ok());
    assert!(manager
        .cleanup_session(&request.scope.owner, &request.scope.session)
        .await
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn owner_cleanup_receipt_never_confirms_an_unknown_background_outcome() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let action = request(
        root.path(),
        "unknown",
        "printf fixture",
        Duration::from_secs(1),
    );
    manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    gate.hold("owner", "logout-unknown").unwrap();
    assert!(manager
        .confirm_owner_hold("owner", "logout-unknown")
        .await
        .is_err());
    assert_eq!(gate.status("owner", "logout-unknown").unwrap(), "held");
    assert!(gate.release("owner", "logout-unknown").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_receipt_cannot_release_a_newer_logout_hold() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    gate.hold("owner", "logout-old").unwrap();
    let receipt = manager
        .confirm_owner_hold("owner", "logout-old")
        .await
        .unwrap();
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute(
        "UPDATE background_owner_holds SET request='logout-new',state='held' WHERE owner='owner'",
        [],
    )
    .unwrap();
    assert!(manager.release_owner_hold(receipt).is_err());
    assert_eq!(gate.status("owner", "logout-new").unwrap(), "held");
    let receipt = manager
        .confirm_owner_hold("owner", "logout-new")
        .await
        .unwrap();
    manager.release_owner_hold(receipt).unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_cleanup_receipt_keeps_hold_until_coordinator_releases_it() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let action = request(root.path(), "running", "sleep 30", Duration::from_secs(60));
    manager.start(action.clone(), Some(&action)).await.unwrap();
    gate.hold("owner", "logout-one").unwrap();

    let receipt = manager
        .confirm_owner_hold("owner", "logout-one")
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &action).await.state,
        BackgroundState::Cancelled
    );
    assert_eq!(gate.status("owner", "logout-one").unwrap(), "acknowledged");
    let mut later = action.clone();
    later.action_id = "after-cleanup".into();
    assert!(manager.start(later.clone(), Some(&later)).await.is_err());

    manager.release_owner_hold(receipt).unwrap();
    assert!(manager.start(later.clone(), Some(&later)).await.is_ok());
    manager
        .cancel(&later.scope, &later.action_id)
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn renewed_logout_invalidates_inflight_cleanup_receipt() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = Arc::new(
        BackgroundProcesses::create_controlled(
            &root.path().canonicalize().unwrap().join("ledger"),
            gate.clone(),
        )
        .unwrap(),
    );
    let scope = request(root.path(), "stalled", "sleep 30", Duration::from_secs(60)).scope;
    let (cancel, mut cancelled) = watch::channel(false);
    let (done, _) = watch::channel(false);
    let entry = Arc::new(Entry {
        output_revision: watch::channel(0).0,
        #[cfg(unix)]
        input: Mutex::new(None),
        authorization_generation: Some(0),
        action_id: "00".repeat(32),
        scope,
        state: Mutex::new(BackgroundState::Running),
        stdout: Mutex::new(Output::default()),
        stderr: Mutex::new(Output::default()),
        cancel,
        done,
    });
    manager
        .registry
        .lock()
        .await
        .entries
        .insert(b"fixture".to_vec(), entry.clone());
    gate.hold("owner", "logout-old").unwrap();
    let waiting = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.confirm_owner_hold("owner", "logout-old").await })
    };
    tokio::time::timeout(Duration::from_secs(2), cancelled.changed())
        .await
        .unwrap()
        .unwrap();
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute(
        "UPDATE background_owner_holds SET request='logout-new',state='held' WHERE owner='owner'",
        [],
    )
    .unwrap();
    *entry.state.lock().unwrap() = BackgroundState::Cancelled;
    entry.done.send_replace(true);
    assert!(waiting.await.unwrap().is_err());
    assert_eq!(gate.status("owner", "logout-new").unwrap(), "held");
    let receipt = manager
        .confirm_owner_hold("owner", "logout-new")
        .await
        .unwrap();
    assert_eq!(gate.status("owner", "logout-new").unwrap(), "acknowledged");
    manager.release_owner_hold(receipt).unwrap();
    manager
        .registry
        .lock()
        .await
        .entries
        .remove(b"fixture".as_slice());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_cleanup_receipt_waits_for_concurrent_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = Arc::new(
        BackgroundProcesses::create_controlled(
            &root.path().canonicalize().unwrap().join("ledger"),
            gate.clone(),
        )
        .unwrap(),
    );
    let action = request(root.path(), "running", "sleep 30", Duration::from_secs(60));
    manager.start(action.clone(), Some(&action)).await.unwrap();
    gate.hold("owner", "shutdown-hold").unwrap();
    let shutdown = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.shutdown().await })
    };
    let receipt = tokio::time::timeout(
        Duration::from_secs(8),
        manager.confirm_owner_hold("owner", "shutdown-hold"),
    )
    .await
    .unwrap()
    .unwrap();
    shutdown.await.unwrap().unwrap();
    assert_eq!(
        finished(&manager, &action).await.state,
        BackgroundState::Cancelled
    );
    assert_eq!(
        gate.status("owner", "shutdown-hold").unwrap(),
        "acknowledged"
    );
    manager.release_owner_hold(receipt).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_review_is_exact_hold_bound_and_preserves_unknown_receipts() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("application.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    initialize_controlled_gate(&db);
    db.execute_batch(
        "CREATE TABLE structured_owner_holds(owner TEXT PRIMARY KEY,request TEXT NOT NULL)",
    )
    .unwrap();
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager =
        BackgroundProcesses::create_controlled(&root.join("ledger"), gate.clone()).unwrap();
    let first = request(&root, "first", "ignored", Duration::from_secs(1));
    let mut other = request(&root, "second", "ignored", Duration::from_secs(1));
    other.scope.owner = "other".into();
    manager
        .ledger
        .claim(&first.scope, &first.action_id)
        .unwrap();
    manager
        .ledger
        .claim(&other.scope, &other.action_id)
        .unwrap();
    gate.hold("owner", "hold-one").unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO structured_owner_holds(owner,request) VALUES('owner','hold-one')",
            [],
        )
        .unwrap();
    let operation = uuid::Uuid::new_v4();
    assert!(manager
        .review_unknown_owner("owner", "hold-one", operation, false)
        .await
        .is_err());
    assert!(manager
        .review_unknown_owner("owner", "wrong-hold", operation, true)
        .await
        .is_err());
    assert!(manager.ledger.has_unknown_owner("owner").unwrap());
    assert_eq!(
        manager
            .review_unknown_owner("owner", "hold-one", operation, true)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        manager
            .review_unknown_owner("owner", "hold-one", operation, true)
            .await
            .unwrap(),
        1
    );
    assert!(!manager.ledger.has_unknown_owner("owner").unwrap());
    assert!(manager.ledger.has_unknown_owner("other").unwrap());
    assert_eq!(
        manager.ledger.read(&first.scope, &first.action_id).unwrap(),
        BackgroundState::Unknown
    );
    assert!(manager
        .ledger
        .claim(&first.scope, &first.action_id)
        .is_err());
    assert!(manager
        .confirm_owner_hold("owner", "hold-one")
        .await
        .is_ok());
    drop(manager);
    let reopened = BackgroundProcesses::open_controlled(&root.join("ledger"), gate).unwrap();
    assert!(!reopened.ledger.has_unknown_owner("owner").unwrap());
    assert!(reopened.ledger.has_unknown_owner("other").unwrap());
    assert_eq!(
        reopened
            .ledger
            .read(&first.scope, &first.action_id)
            .unwrap(),
        BackgroundState::Unknown
    );
    assert!(reopened
        .ledger
        .claim(&first.scope, &first.action_id)
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn owner_review_cannot_attest_while_a_tracked_process_is_running() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let db = rusqlite::Connection::open(root.join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    db.execute_batch("CREATE TABLE structured_owner_holds(owner TEXT PRIMARY KEY,request TEXT NOT NULL); INSERT INTO structured_owner_holds VALUES('owner','hold-one')").unwrap();
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager =
        BackgroundProcesses::create_controlled(&root.join("ledger"), gate.clone()).unwrap();
    let running = request(&root, "running", "sleep 30", Duration::from_secs(60));
    manager
        .start(running.clone(), Some(&running))
        .await
        .unwrap();
    gate.hold("owner", "hold-one").unwrap();
    assert!(manager
        .review_unknown_owner("owner", "hold-one", uuid::Uuid::new_v4(), true)
        .await
        .is_err());
    assert!(manager.ledger.has_unknown_owner("owner").unwrap());
    manager
        .cancel(&running.scope, &running.action_id)
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn authorized_background_review_rechecks_credential_and_exact_durable_hold() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let app = crate::state::AppState::new(terminal_v4_core::AppConfig {
        data_dir: root.clone(),
        ..Default::default()
    })
    .unwrap();
    app.provision_owner_cleanup().unwrap();
    let manager = {
        let mut db = app.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(&root, &mut db).unwrap())
    };
    let action = request(&root, "unknown", "ignored", Duration::from_secs(1));
    manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    app.logout_user("owner").unwrap();
    let hold: String = app
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM structured_owner_holds WHERE owner='owner'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let future = crate::v4_agent::interaction::now_ms() + 60_000;
    let fresh = crate::auth::LocalAuthority::for_test("owner", 1, future);
    let revoked = crate::auth::LocalAuthority::for_test("owner", 0, future);
    let expired = crate::auth::LocalAuthority::for_test("owner", 1, 0);
    let operation = uuid::Uuid::new_v4();
    for authority in [revoked, expired] {
        let (manager, app, hold) = (manager.clone(), app.clone(), hold.clone());
        assert!(tokio::task::spawn_blocking(move || manager
            .review_unknown_owner_authorized(&app, "owner", &authority, &hold, operation, true))
        .await
        .unwrap()
        .is_err());
    }
    let (copy, state) = (manager.clone(), app.clone());
    assert!(tokio::task::spawn_blocking(move || copy
        .review_unknown_owner_authorized(&state, "owner", &fresh, "stale", operation, true))
    .await
    .unwrap()
    .is_err());
    assert!(manager.ledger.has_unknown_owner("owner").unwrap());
    let authority = crate::auth::LocalAuthority::for_test("owner", 1, future);
    let (copy, state, request_id) = (manager.clone(), app.clone(), hold.clone());
    assert_eq!(
        tokio::task::spawn_blocking(move || copy.review_unknown_owner_authorized(
            &state,
            "owner",
            &authority,
            &request_id,
            operation,
            true
        ))
        .await
        .unwrap()
        .unwrap(),
        1
    );
    assert!(!manager.ledger.has_unknown_owner("owner").unwrap());
    assert_eq!(
        manager
            .ledger
            .read(&action.scope, &action.action_id)
            .unwrap(),
        BackgroundState::Unknown
    );
    assert!(manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .is_err());
    assert_eq!(
        app.lock_db()
            .unwrap()
            .execute(
                "DELETE FROM structured_owner_background_reviews WHERE owner='owner'",
                []
            )
            .unwrap(),
        1
    );
    let receipt = manager.confirm_owner_hold("owner", &hold).await.unwrap();
    assert!(manager.release_owner_hold(receipt).is_err());
    {
        let mut db = app.lock_db().unwrap();
        let tx = db.transaction().unwrap();
        assert!(super::super::background_quiescence::release_in_transaction(
            &tx, &root, "owner", &hold
        )
        .is_err());
    }
    let authority = crate::auth::LocalAuthority::for_test("owner", 1, future);
    let (copy, state, request_id) = (manager.clone(), app.clone(), hold.clone());
    assert_eq!(
        tokio::task::spawn_blocking(move || copy.review_unknown_owner_authorized(
            &state,
            "owner",
            &authority,
            &request_id,
            operation,
            true
        ))
        .await
        .unwrap()
        .unwrap(),
        1
    );
    {
        let mut db = app.lock_db().unwrap();
        let tx = db.transaction().unwrap();
        assert!(super::super::background_quiescence::release_in_transaction(
            &tx, &root, "owner", &hold
        )
        .is_ok());
    }
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_recovery_unblocks_retained_manager_without_replaying_unknown_action() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let app = crate::state::AppState::new(terminal_v4_core::AppConfig {
        data_dir: root.clone(),
        ..Default::default()
    })
    .unwrap();
    app.provision_owner_cleanup().unwrap();
    let manager = {
        let mut db = app.lock_db().unwrap();
        bootstrap::open_or_provision(&root, &mut db).unwrap()
    };
    let action = request(&root, "unknown-recovery", "ignored", Duration::from_secs(1));
    manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    drop(manager);
    let manager = {
        let mut db = app.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(&root, &mut db).unwrap())
    };
    let mut other = request(&root, "new-after-review", "exit 0", Duration::from_secs(5));
    other.scope.owner = "another-owner".into();
    other.authorization_generation = Some(0);
    assert!(manager.start(other.clone(), Some(&other)).await.is_err());
    app.logout_user("owner").unwrap();
    let hold: String = app
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM structured_owner_holds WHERE owner='owner'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let authority = crate::auth::LocalAuthority::for_test(
        "owner",
        1,
        super::super::interaction::now_ms() + 60_000,
    );
    let (copy, state) = (manager.clone(), app.clone());
    let operation = uuid::Uuid::new_v4();
    assert_eq!(
        tokio::task::spawn_blocking(move || copy
            .review_unknown_owner_authorized(&state, "owner", &authority, &hold, operation, true))
        .await
        .unwrap()
        .unwrap(),
        1
    );
    assert!(manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .is_err());
    manager.start(other.clone(), Some(&other)).await.unwrap();
    assert_eq!(
        finished(&manager, &other).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn retained_manager_waits_until_every_unknown_owner_has_been_reviewed() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let app = crate::state::AppState::new(terminal_v4_core::AppConfig {
        data_dir: root.clone(),
        ..Default::default()
    })
    .unwrap();
    app.provision_owner_cleanup().unwrap();
    let manager = {
        let mut db = app.lock_db().unwrap();
        bootstrap::open_or_provision(&root, &mut db).unwrap()
    };
    for owner in ["owner", "second-owner"] {
        let mut action = request(&root, "unknown", "ignored", Duration::from_secs(1));
        action.scope.owner = owner.into();
        manager
            .ledger
            .claim(&action.scope, &action.action_id)
            .unwrap();
    }
    drop(manager);
    let manager = {
        let mut db = app.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(&root, &mut db).unwrap())
    };
    let mut third = request(&root, "third-action", "exit 0", Duration::from_secs(5));
    third.scope.owner = "third-owner".into();
    third.authorization_generation = Some(0);
    for (index, owner) in ["owner", "second-owner"].into_iter().enumerate() {
        app.logout_user(owner).unwrap();
        let hold: String = app
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT request FROM structured_owner_holds WHERE owner=?1",
                [owner],
                |row| row.get(0),
            )
            .unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            owner,
            1,
            super::super::interaction::now_ms() + 60_000,
        );
        let (copy, state, owner) = (manager.clone(), app.clone(), owner.to_owned());
        let operation = uuid::Uuid::new_v4();
        assert_eq!(
            tokio::task::spawn_blocking(move || copy.review_unknown_owner_authorized(
                &state, &owner, &authority, &hold, operation, true
            ))
            .await
            .unwrap()
            .unwrap(),
            1
        );
        if index == 0 {
            assert!(manager.start(third.clone(), Some(&third)).await.is_err());
        }
    }
    manager.start(third.clone(), Some(&third)).await.unwrap();
    assert_eq!(
        finished(&manager, &third).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn background_review_http_is_owner_authenticated_and_records_attestation() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let app = crate::state::AppState::new(terminal_v4_core::AppConfig {
        data_dir: root.clone(),
        jwt_secret: "background-review-http".into(),
        ..Default::default()
    })
    .unwrap();
    let manager = app.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    manager
        .bind_delegation_supervisor(
            crate::v4_agent::delegation_outbox::provision_supervisor(&root).unwrap(),
        )
        .unwrap();
    manager
        .bind_owner_cleanup(app.provision_owner_cleanup().unwrap())
        .unwrap();
    app.create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    app.create_local_user_for_test("bob", "fixture-password")
        .unwrap();
    let alice = app
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let bob = app.login("bob", "fixture-password").await.unwrap().unwrap();
    let background = {
        let mut db = app.lock_db().unwrap();
        bootstrap::open_or_provision(&root, &mut db).unwrap()
    };
    let mut action = request(&root, "unknown", "ignored", Duration::from_secs(1));
    action.scope.owner = alice.user.id.clone();
    background
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    app.logout_user(&alice.user.id).unwrap();
    let hold: String = app
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM structured_owner_holds WHERE owner=?1",
            [&alice.user.id],
            |row| row.get(0),
        )
        .unwrap();
    drop(background);
    let renewed = app
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let operation = uuid::Uuid::new_v4();
    let post = |token: &str, acknowledged: bool| {
        Request::builder().method("POST").uri("/api/structured/owner-cleanup/background-review")
        .header("authorization", format!("Bearer {token}")).header("content-type", "application/json")
        .body(Body::from(serde_json::json!({"requestId":hold,"operationId":operation,"acknowledged":acknowledged}).to_string())).unwrap()
    };
    let router = crate::app(app.clone());
    assert_ne!(
        router
            .clone()
            .oneshot(post(&alice.tokens.access_token, true))
            .await
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );
    assert_ne!(
        router
            .clone()
            .oneshot(post(&bob.tokens.access_token, true))
            .await
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post(&renewed.tokens.access_token, false))
            .await
            .unwrap()
            .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    let response = router
        .clone()
        .oneshot(post(&renewed.tokens.access_token, true))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let result: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        result,
        serde_json::json!({"status":"reviewed","requestId":hold,"operationId":operation,"reviewedCount":1})
    );
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/structured/owner-cleanup")
                .header(
                    "authorization",
                    format!("Bearer {}", renewed.tokens.access_token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let status: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status["backgroundReview"], "user_attested");
    let held: bool = app
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
            [&alice.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(held);
    manager.start_owner_cleanup_workers().unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let held: bool = app
                .lock_db()
                .unwrap()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
                    [&alice.user.id],
                    |row| row.get(0),
                )
                .unwrap();
            if !held {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("reviewed background cleanup did not finish");
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/structured/owner-cleanup")
                .header(
                    "authorization",
                    format!("Bearer {}", renewed.tokens.access_token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status["state"], "complete");
    assert_eq!(status["backgroundReview"], "user_attested");
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn exact_owner_confirmation_does_not_service_another_owners_hold() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    gate.hold("owner", "request-one").unwrap();
    gate.hold("other", "request-two").unwrap();
    manager
        .confirm_owner_hold("owner", "request-one")
        .await
        .unwrap();
    assert_eq!(gate.status("owner", "request-one").unwrap(), "acknowledged");
    assert_eq!(gate.status("other", "request-two").unwrap(), "held");
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_cleanup_receipt_recovers_acknowledged_hold_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let ledger = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create_controlled(&ledger, gate.clone()).unwrap();
    gate.hold("owner", "logout-persisted").unwrap();
    let receipt = manager
        .confirm_owner_hold("owner", "logout-persisted")
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
    drop(manager);
    let manager = BackgroundProcesses::open_controlled(&ledger, gate.clone()).unwrap();
    let recovered = manager
        .confirm_owner_hold("owner", "logout-persisted")
        .await
        .unwrap();
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute("UPDATE background_owner_holds SET request='logout-renewed',state='held' WHERE owner='owner'", []).unwrap();
    assert!(manager.release_owner_hold(recovered).is_err());
    assert!(manager.release_owner_hold(receipt).is_err());
    let renewed = manager
        .confirm_owner_hold("owner", "logout-renewed")
        .await
        .unwrap();
    manager.release_owner_hold(renewed).unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn remote_owner_hold_cancels_only_that_owner_and_blocks_new_starts() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let first = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&first);
    let owner_gate = Arc::new(owner_gate::OwnerGate::open(first).unwrap());
    let other_server =
        owner_gate::OwnerGate::open(rusqlite::Connection::open(&database).unwrap()).unwrap();
    let ledger_path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create_controlled(&ledger_path, owner_gate).unwrap();
    let own = request(root.path(), "own", "sleep 30", Duration::from_secs(60));
    let mut other = request(root.path(), "other", "sleep 30", Duration::from_secs(60));
    other.scope.owner = "another-owner".into();
    manager.start(own.clone(), Some(&own)).await.unwrap();
    manager.start(other.clone(), Some(&other)).await.unwrap();
    other_server.hold("owner", "logout-1").unwrap();
    let later = request(root.path(), "later", "sleep 30", Duration::from_secs(60));
    assert!(manager.start(later.clone(), Some(&later)).await.is_err());
    assert_eq!(other_server.status("owner", "logout-1").unwrap(), "held");
    assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
    assert_eq!(
        other_server.status("owner", "logout-1").unwrap(),
        "acknowledged"
    );
    assert_eq!(
        finished(&manager, &own).await.state,
        BackgroundState::Cancelled
    );
    assert_eq!(
        manager
            .snapshot(&other.scope, &other.action_id)
            .await
            .unwrap()
            .state,
        BackgroundState::Running
    );
    assert!(manager.start(later.clone(), Some(&later)).await.is_err());
    manager
        .cancel(&other.scope, &other.action_id)
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
    drop(manager);
    let reopened =
        BackgroundProcesses::open_controlled(&ledger_path, Arc::new(other_server)).unwrap();
    assert!(reopened.start(later.clone(), Some(&later)).await.is_err());
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_hold_is_not_acknowledged_with_unknown_owner_receipts() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let action = request(
        root.path(),
        "unknown",
        "printf fixture",
        Duration::from_secs(1),
    );
    manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    gate.hold("owner", "logout-2").unwrap();
    assert!(manager.service_owner_holds().await.is_err());
    assert_eq!(gate.status("owner", "logout-2").unwrap(), "held");
}

#[cfg(unix)]
#[tokio::test]
async fn unknown_owner_does_not_prevent_other_owner_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let mut other = request(root.path(), "active", "sleep 30", Duration::from_secs(60));
    other.scope.owner = "z-owner".into();
    manager.start(other.clone(), Some(&other)).await.unwrap();
    let mut unknown = request(
        root.path(),
        "unknown",
        "printf fixture",
        Duration::from_secs(1),
    );
    unknown.scope.owner = "a-owner".into();
    manager
        .ledger
        .claim(&unknown.scope, &unknown.action_id)
        .unwrap();
    gate.hold("a-owner", "unknown-hold").unwrap();
    gate.hold("z-owner", "healthy-hold").unwrap();
    assert!(manager.service_owner_holds().await.is_err());
    assert_eq!(gate.status("a-owner", "unknown-hold").unwrap(), "held");
    assert_eq!(
        gate.status("z-owner", "healthy-hold").unwrap(),
        "acknowledged"
    );
    assert_eq!(
        finished(&manager, &other).await.state,
        BackgroundState::Cancelled
    );
    assert!(manager.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn ledger_without_owner_bound_receipts_is_not_silently_reopened() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    manager.shutdown().await.unwrap();
    drop(manager);
    let db = rusqlite::Connection::open(path.join("receipts.sqlite3")).unwrap();
    db.execute_batch("DROP TABLE receipts; CREATE TABLE receipts (key BLOB PRIMARY KEY, session_key BLOB NOT NULL, state TEXT NOT NULL, code INTEGER);").unwrap();
    drop(db);
    assert!(BackgroundProcesses::open(&path).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn owner_hold_monitor_services_remote_requests_and_stops() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let remote = owner_gate::OwnerGate::open(rusqlite::Connection::open(path).unwrap()).unwrap();
    let manager = Arc::new(
        BackgroundProcesses::create_controlled(
            &root.path().canonicalize().unwrap().join("ledger"),
            gate,
        )
        .unwrap(),
    );
    let action = request(root.path(), "active", "sleep 30", Duration::from_secs(60));
    manager.start(action.clone(), Some(&action)).await.unwrap();
    let (shutdown, rx) = watch::channel(false);
    let monitoring = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.monitor_owner_holds(rx).await })
    };
    remote.hold("owner", "logout-monitor").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while remote.status("owner", "logout-monitor").unwrap() != "acknowledged" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        finished(&manager, &action).await.state,
        BackgroundState::Cancelled
    );
    shutdown.send_replace(true);
    monitoring.await.unwrap().unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_hold_monitor_reports_a_lost_shutdown_controller() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let (shutdown, receiver) = watch::channel(false);
    drop(shutdown);
    assert!(manager.monitor_owner_holds(receiver).await.is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stalled_owner_cleanup_does_not_block_another_owner_start() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = Arc::new(
        BackgroundProcesses::create_controlled(
            &root.path().canonicalize().unwrap().join("ledger"),
            gate.clone(),
        )
        .unwrap(),
    );
    let scope = request(root.path(), "stalled", "sleep 30", Duration::from_secs(60)).scope;
    let (cancel, mut cancelled) = watch::channel(false);
    let (done, _) = watch::channel(false);
    manager.registry.lock().await.entries.insert(
        b"test-stalled".to_vec(),
        Arc::new(Entry {
            output_revision: watch::channel(0).0,
            #[cfg(unix)]
            input: Mutex::new(None),
            authorization_generation: Some(0),
            action_id: "00".repeat(32),
            scope,
            state: Mutex::new(BackgroundState::Running),
            stdout: Mutex::new(Output::default()),
            stderr: Mutex::new(Output::default()),
            cancel,
            done,
        }),
    );
    gate.hold("owner", "stalled-hold").unwrap();
    let service = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.service_owner_holds().await })
    };
    tokio::time::timeout(Duration::from_secs(2), cancelled.changed())
        .await
        .unwrap()
        .unwrap();
    let mut other = request(
        root.path(),
        "independent",
        "sleep 30",
        Duration::from_secs(60),
    );
    other.scope.owner = "another-owner".into();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        manager.start(other.clone(), Some(&other)),
    )
    .await;
    service.abort();
    let _ = service.await;
    if matches!(result, Ok(Ok(_))) {
        manager
            .cancel(&other.scope, &other.action_id)
            .await
            .unwrap();
    }
    manager
        .registry
        .lock()
        .await
        .entries
        .remove(b"test-stalled".as_slice());
    manager.shutdown().await.unwrap();
    assert!(
        matches!(result, Ok(Ok(_))),
        "another owner must not wait for stalled cleanup"
    );
    assert_eq!(gate.status("owner", "stalled-hold").unwrap(), "held");
}

#[cfg(unix)]
#[tokio::test]
async fn stalled_owner_does_not_delay_an_independent_owner_hold() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = Arc::new(
        BackgroundProcesses::create_controlled(
            &root.path().canonicalize().unwrap().join("ledger"),
            gate.clone(),
        )
        .unwrap(),
    );
    let mut scope = request(root.path(), "stalled", "sleep 30", Duration::from_secs(60)).scope;
    scope.owner = "a-owner".into();
    let (cancel, mut cancelled) = watch::channel(false);
    let (done, _) = watch::channel(false);
    manager.registry.lock().await.entries.insert(
        b"fixture-stalled".to_vec(),
        Arc::new(Entry {
            output_revision: watch::channel(0).0,
            #[cfg(unix)]
            input: Mutex::new(None),
            authorization_generation: Some(0),
            action_id: "00".repeat(32),
            scope,
            state: Mutex::new(BackgroundState::Running),
            stdout: Mutex::new(Output::default()),
            stderr: Mutex::new(Output::default()),
            cancel,
            done,
        }),
    );
    gate.hold("a-owner", "first").unwrap();
    gate.hold("b-owner", "second").unwrap();
    let service = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.service_owner_holds().await })
    };
    tokio::time::timeout(Duration::from_secs(2), cancelled.changed())
        .await
        .unwrap()
        .unwrap();
    let independent = tokio::time::timeout(Duration::from_secs(2), async {
        while gate.status("b-owner", "second").unwrap() != "acknowledged" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    service.abort();
    let _ = service.await;
    manager
        .registry
        .lock()
        .await
        .entries
        .remove(b"fixture-stalled".as_slice());
    manager.shutdown().await.unwrap();
    assert!(
        independent.is_ok(),
        "one stalled owner must not delay another owner's cleanup"
    );
    assert_eq!(gate.status("a-owner", "first").unwrap(), "held");
    assert_eq!(gate.status("b-owner", "second").unwrap(), "acknowledged");
}

#[cfg(unix)]
#[tokio::test]
async fn stalled_owner_cleanup_does_not_prevent_another_owner_acknowledgment() {
    let root = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(root.path().join("application.sqlite")).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let mut scope = request(root.path(), "stalled", "sleep 30", Duration::from_secs(60)).scope;
    scope.owner = "a-owner".into();
    let (cancel, _) = watch::channel(false);
    let (done, _) = watch::channel(false);
    manager.registry.lock().await.entries.insert(
        b"test-stalled".to_vec(),
        Arc::new(Entry {
            output_revision: watch::channel(0).0,
            #[cfg(unix)]
            input: Mutex::new(None),
            authorization_generation: Some(0),
            action_id: "00".repeat(32),
            scope,
            state: Mutex::new(BackgroundState::Running),
            stdout: Mutex::new(Output::default()),
            stderr: Mutex::new(Output::default()),
            cancel,
            done,
        }),
    );
    gate.hold("a-owner", "stalled-hold").unwrap();
    gate.hold("z-owner", "healthy-hold").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(8), manager.service_owner_holds())
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(gate.status("a-owner", "stalled-hold").unwrap(), "held");
    assert_eq!(
        gate.status("z-owner", "healthy-hold").unwrap(),
        "acknowledged"
    );
    manager
        .registry
        .lock()
        .await
        .entries
        .remove(b"test-stalled".as_slice());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stalled_session_cleanup_does_not_block_other_owners_or_reopen_the_session() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap(),
    );
    let mut first = request(root.path(), "stalled", "sleep 30", Duration::from_secs(60));
    first.scope.owner = "first-owner".into();
    let (cancel, mut cancellation) = watch::channel(false);
    let (done, _) = watch::channel(false);
    let entry = Arc::new(Entry {
        output_revision: watch::channel(0).0,
        #[cfg(unix)]
        input: Mutex::new(None),
        authorization_generation: Some(0),
        action_id: "00".repeat(32),
        scope: first.scope.clone(),
        state: Mutex::new(BackgroundState::Running),
        stdout: Mutex::new(Output::default()),
        stderr: Mutex::new(Output::default()),
        cancel,
        done,
    });
    manager
        .registry
        .lock()
        .await
        .entries
        .insert(b"stalled-session".to_vec(), entry.clone());
    let cleanup_manager = manager.clone();
    let owner = first.scope.owner.clone();
    let session = first.scope.session.clone();
    let cleanup =
        tokio::spawn(async move { cleanup_manager.cleanup_session(&owner, &session).await });
    tokio::time::timeout(Duration::from_secs(2), cancellation.changed())
        .await
        .unwrap()
        .unwrap();

    let mut second = request(root.path(), "independent", "exit 0", Duration::from_secs(5));
    second.scope.owner = "second-owner".into();
    let independent = tokio::time::timeout(
        Duration::from_secs(2),
        manager.start(second.clone(), Some(&second)),
    )
    .await;
    let closed = tokio::time::timeout(
        Duration::from_secs(2),
        manager.start(first.clone(), Some(&first)),
    )
    .await;

    *entry.state.lock().unwrap() = BackgroundState::Exited { code: Some(0) };
    entry.done.send_replace(true);
    cleanup.await.unwrap().unwrap();
    manager
        .registry
        .lock()
        .await
        .entries
        .remove(b"stalled-session".as_slice());
    if matches!(independent, Ok(Ok(_))) {
        assert_eq!(
            finished(&manager, &second).await.state,
            BackgroundState::Exited { code: Some(0) }
        );
    }
    manager.shutdown().await.unwrap();
    assert!(
        matches!(independent, Ok(Ok(_))),
        "another owner could not start while cleanup was stalled"
    );
    assert!(
        matches!(closed, Ok(Err(_))),
        "the session being cleaned must remain closed"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn coordinated_owner_release_is_atomic_and_rejects_stale_receipts() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    db.execute_batch("CREATE TABLE background_ledger_installation (id INTEGER PRIMARY KEY, state TEXT NOT NULL); INSERT INTO background_ledger_installation VALUES(1, 'ready'); CREATE TABLE shared_holds(owner TEXT PRIMARY KEY, request TEXT NOT NULL);").unwrap();
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let ledger = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create_controlled(&ledger, gate.clone()).unwrap();
    let mut coordinator = rusqlite::Connection::open(&database).unwrap();
    {
        let tx = coordinator.transaction().unwrap();
        owner_gate::hold_logout_if_installed_with_request(&tx, "owner", "request-one").unwrap();
        tx.execute("INSERT INTO shared_holds VALUES('owner','request-one')", [])
            .unwrap();
        tx.commit().unwrap();
    }
    let receipt = manager
        .confirm_owner_hold("owner", "request-one")
        .await
        .unwrap();
    {
        let tx = coordinator.transaction().unwrap();
        owner_gate::hold_logout_if_installed_with_request(&tx, "owner", "request-one").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(gate.status("owner", "request-one").unwrap(), "acknowledged");
    {
        let tx = coordinator.transaction().unwrap();
        tx.execute("UPDATE background_owner_holds SET request='request-new', state='held' WHERE owner='owner'", []).unwrap();
        assert!(manager
            .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
            .is_err());
        tx.rollback().unwrap();
    }
    let action = request(root.path(), "uncertain", "exit 0", Duration::from_secs(1));
    let claim = manager
        .ledger
        .claim(&action.scope, &action.action_id)
        .unwrap();
    {
        let tx = coordinator.transaction().unwrap();
        assert!(manager
            .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
            .is_err());
        tx.rollback().unwrap();
    }
    manager
        .ledger
        .finish(&claim, &BackgroundState::FailedToStart)
        .unwrap();
    {
        let tx = coordinator.transaction().unwrap();
        let guard = manager
            .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
            .unwrap();
        tx.execute("DELETE FROM shared_holds WHERE owner='owner'", [])
            .unwrap();
        tx.rollback().unwrap();
        drop(guard);
    }
    assert_eq!(gate.status("owner", "request-one").unwrap(), "acknowledged");
    assert_eq!(
        coordinator
            .query_row("SELECT COUNT(*) FROM shared_holds", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    {
        let tx = coordinator.transaction().unwrap();
        assert!(manager
            .release_owner_hold_in_transaction(&receipt, "foreign", "request-one", &tx)
            .is_err());
        assert!(manager
            .release_owner_hold_in_transaction(&receipt, "owner", "request-other", &tx)
            .is_err());
        let guard = manager
            .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
            .unwrap();
        tx.execute("DELETE FROM shared_holds WHERE owner='owner'", [])
            .unwrap();
        tx.commit().unwrap();
        drop(guard);
    }
    assert!(gate.status("owner", "request-one").is_err());
    assert_eq!(
        coordinator
            .query_row("SELECT COUNT(*) FROM shared_holds", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    gate.hold("owner", "request-two").unwrap();
    let closing_receipt = manager
        .confirm_owner_hold("owner", "request-two")
        .await
        .unwrap();
    manager.shutdown().await.unwrap();
    let tx = coordinator.transaction().unwrap();
    assert!(manager
        .release_owner_hold_in_transaction(&closing_receipt, "owner", "request-two", &tx)
        .is_err());
    tx.rollback().unwrap();
    assert_eq!(gate.status("owner", "request-two").unwrap(), "acknowledged");
    drop(manager);
    let reopened = BackgroundProcesses::open_controlled(&ledger, gate.clone()).unwrap();
    let tx = coordinator.transaction().unwrap();
    assert!(reopened
        .release_owner_hold_in_transaction(&closing_receipt, "owner", "request-two", &tx)
        .is_err());
    tx.rollback().unwrap();
    let current = reopened
        .confirm_owner_hold("owner", "request-two")
        .await
        .unwrap();
    let tx = coordinator.transaction().unwrap();
    let guard = reopened
        .release_owner_hold_in_transaction(&current, "owner", "request-two", &tx)
        .unwrap();
    tx.commit().unwrap();
    drop(guard);
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn coordinated_owner_release_rejects_foreign_and_replaced_databases() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    gate.hold("owner", "request-one").unwrap();
    let receipt = manager
        .confirm_owner_hold("owner", "request-one")
        .await
        .unwrap();
    let foreign = root.path().join("foreign.sqlite");
    let mut other = rusqlite::Connection::open(&foreign).unwrap();
    initialize_controlled_gate(&other);
    other
        .execute(
            "INSERT INTO background_owner_holds VALUES('owner','request-one','acknowledged')",
            [],
        )
        .unwrap();
    let tx = other.transaction().unwrap();
    assert!(manager
        .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
        .is_err());
    tx.rollback().unwrap();
    assert_eq!(gate.status("owner", "request-one").unwrap(), "acknowledged");
    std::fs::rename(&database, root.path().join("old.sqlite")).unwrap();
    let mut replacement = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&replacement);
    replacement
        .execute(
            "INSERT INTO background_owner_holds VALUES('owner','request-one','acknowledged')",
            [],
        )
        .unwrap();
    let tx = replacement.transaction().unwrap();
    assert!(manager
        .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
        .is_err());
    tx.rollback().unwrap();
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn coordinated_owner_release_fences_shutdown_until_commit() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    initialize_controlled_gate(&db);
    let gate = Arc::new(owner_gate::OwnerGate::open(db).unwrap());
    let manager = Arc::new(
        BackgroundProcesses::create_controlled(
            &root.path().canonicalize().unwrap().join("ledger"),
            gate.clone(),
        )
        .unwrap(),
    );
    gate.hold("owner", "request-one").unwrap();
    let receipt = manager
        .confirm_owner_hold("owner", "request-one")
        .await
        .unwrap();
    let mut coordinator = rusqlite::Connection::open(&database).unwrap();
    let tx = coordinator.transaction().unwrap();
    let guard = manager
        .release_owner_hold_in_transaction(&receipt, "owner", "request-one", &tx)
        .unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let other = manager.clone();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        ready_tx.send(()).unwrap();
        done_tx.send(runtime.block_on(other.shutdown())).unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
    tx.commit().unwrap();
    drop(guard);
    done_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
}

#[cfg(unix)]
#[test]
fn receipt_capacity_is_bounded_per_session_and_per_owner_without_blocking_others() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let base = request(root.path(), "unused", "exit 0", Duration::from_secs(3)).scope;
    let scope = |owner: &str, session: &str| BackgroundScope {
        owner: owner.into(),
        session: session.into(),
        ..base.clone()
    };
    let session_a = scope("owner", "a");
    for i in 0..MAX_SESSION_ACTIONS {
        manager.ledger.claim(&session_a, &format!("a-{i}")).unwrap();
    }
    let refused = manager.ledger.claim(&session_a, "a-extra").unwrap_err();
    assert!(refused.contains("capacity"), "{refused}");
    let session_b = scope("owner", "b");
    for i in 0..MAX_OWNER_ACTIONS - MAX_SESSION_ACTIONS {
        manager.ledger.claim(&session_b, &format!("b-{i}")).unwrap();
    }
    assert!(manager.ledger.claim(&scope("owner", "c"), "c-0").is_err());
    manager
        .ledger
        .claim(&scope("another-owner", "a"), "a-0")
        .unwrap();
    assert!(manager.ledger.read(&session_a, "a-extra").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn running_slots_are_released_when_a_command_finishes_and_refusal_claims_nothing() {
    let root = tempfile::tempdir().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    manager.set_running_limits_for_test(1, 8);
    let first = request(root.path(), "slot-1", "sleep 30", Duration::from_secs(40));
    manager.start(first.clone(), Some(&first)).await.unwrap();
    let second = request(
        root.path(),
        "slot-2",
        "printf ran > marker",
        Duration::from_secs(3),
    );
    let refused = manager
        .start(second.clone(), Some(&second))
        .await
        .unwrap_err();
    assert!(refused.contains("Too many"), "{refused}");
    assert!(manager.ledger.read(&second.scope, "slot-2").is_err());
    assert!(!root.path().join("marker").exists());
    let mut other_owner = request(root.path(), "slot-3", "exit 0", Duration::from_secs(3));
    other_owner.scope.owner = "another-owner".into();
    manager
        .start(other_owner.clone(), Some(&other_owner))
        .await
        .unwrap();
    assert_eq!(
        finished(&manager, &other_owner).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.cancel(&first.scope, "slot-1").await.unwrap();
    manager
        .wait(
            &first.scope,
            "slot-1",
            Duration::from_secs(10),
            &Default::default(),
        )
        .await
        .unwrap();
    manager.start(second.clone(), Some(&second)).await.unwrap();
    assert_eq!(
        finished(&manager, &second).await.state,
        BackgroundState::Exited { code: Some(0) }
    );
    manager.shutdown().await.unwrap();
}
