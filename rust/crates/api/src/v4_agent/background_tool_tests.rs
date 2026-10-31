use super::*;
use crate::v4_agent::interaction::{ApprovalRequest, Interaction};
use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use terminal_v4_core::StructuredSessionEvent;

async fn execute(
    manager: &BackgroundProcesses,
    scope: &ActionScope,
    workspace: &Path,
    call_id: &str,
    name: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancellation: &Cancellation,
) -> Result<String, String> {
    let authority = crate::auth::LocalAuthority::for_test(&scope.owner, 0, i64::MAX);
    super::execute_direct(
        manager,
        scope,
        workspace,
        call_id,
        name,
        input,
        interaction,
        cancellation,
        Some(&authority),
    )
    .await
}

struct Reviewer {
    allow: bool,
    cancel: Option<Cancellation>,
    seen: Arc<AtomicBool>,
}
#[async_trait]
impl Interaction for Reviewer {
    async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
        Ok(())
    }
    async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
        assert_eq!(request.tool_name, "background_start");
        assert!(request.description.contains("printf"));
        self.seen.store(true, Ordering::SeqCst);
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        Ok(self.allow)
    }
}
fn scope() -> ActionScope {
    ActionScope {
        owner: "owner".into(),
        session_id: "session".into(),
        turn_id: "turn".into(),
    }
}
fn reviewer(allow: bool, cancel: Option<Cancellation>) -> Reviewer {
    Reviewer {
        allow,
        cancel,
        seen: Arc::new(AtomicBool::new(false)),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn retired_session_cannot_request_a_new_background_approval() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    manager
        .retire_session(&scope.owner, &scope.session_id)
        .await
        .unwrap();
    let reviewer = reviewer(true, None);
    let input = json!({"command":"printf denied > marker", "timeoutSeconds":2});
    assert!(execute(
        &manager,
        &scope,
        &workspace,
        "after-delete",
        "background_start",
        &input,
        &reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    assert!(!reviewer.seen.load(Ordering::SeqCst));
    assert!(!workspace.join("marker").exists());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn retirement_during_pending_approval_rejects_the_action_even_after_restart() {
    struct WaitingReviewer {
        seen: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for WaitingReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.seen.lock().unwrap().take().unwrap().send(()).unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let manager = BackgroundProcesses::create(&path).unwrap();
    let scope = scope();
    let (seen, observed) = tokio::sync::oneshot::channel();
    let waiting_reviewer = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let input = json!({"command":"printf denied > marker", "timeoutSeconds":2});
    let cancel = Cancellation::default();
    {
        let action = execute(
            &manager,
            &scope,
            &workspace,
            "pending",
            "background_start",
            &input,
            &waiting_reviewer,
            &cancel,
        );
        tokio::pin!(action);
        tokio::select! {
            _ = &mut action => panic!("approval unexpectedly completed"),
            observed = observed => observed.unwrap(),
        }
        manager
            .retire_session(&scope.owner, &scope.session_id)
            .await
            .unwrap();
        waiting_reviewer.release.notify_one();
        assert!(action.await.is_err());
    }
    assert!(!workspace.join("marker").exists());
    manager.shutdown().await.unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    let second_reviewer = reviewer(true, None);
    assert!(execute(
        &reopened,
        &scope,
        &workspace,
        "pending",
        "background_start",
        &input,
        &second_reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    assert!(!second_reviewer.seen.load(Ordering::SeqCst));
    assert!(!workspace.join("marker").exists());
    reopened.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn owner_hold_during_approval_prevents_command_launch() {
    struct WaitingReviewer {
        seen: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for WaitingReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.seen.lock().unwrap().take().unwrap().send(()).unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let database = root.path().join("application.sqlite");
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
    super::super::owner_gate::OwnerGate::initialize(&db).unwrap();
    let gate = Arc::new(super::super::owner_gate::OwnerGate::open(db).unwrap());
    let other_server =
        super::super::owner_gate::OwnerGate::open(rusqlite::Connection::open(database).unwrap())
            .unwrap();
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate,
    )
    .unwrap();
    let (seen, observed) = tokio::sync::oneshot::channel();
    let reviewer = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let input = json!({"command":"printf denied > marker", "timeoutSeconds":2});
    let scope = scope();
    let cancellation = Cancellation::default();
    {
        let action = execute(
            &manager,
            &scope,
            &workspace,
            "pending",
            "background_start",
            &input,
            &reviewer,
            &cancellation,
        );
        tokio::pin!(action);
        tokio::select! { _ = &mut action => panic!("approval unexpectedly completed"), seen = observed => seen.unwrap() }
        other_server.hold("owner", "logout").unwrap();
        reviewer.release.notify_one();
        assert!(action.await.is_err());
    }
    assert!(!workspace.join("marker").exists());
    assert_eq!(other_server.status("owner", "logout").unwrap(), "held");
    assert_eq!(manager.service_owner_holds().await.unwrap(), 1);
    manager.shutdown().await.unwrap();
}

#[test]
fn advertised_background_actions_match_dispatch() {
    let names = definitions();
    assert_eq!(
        names
            .iter()
            .map(|definition| definition["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "background_start",
            "background_list",
            "background_status",
            "background_wait",
            "background_wait_output",
            "background_follow_output",
            "background_cancel",
            "background_write",
            "background_write_bytes",
            "background_close_input",
            "background_read_output"
        ]
    );
    assert!(names
        .iter()
        .all(|definition| handles(definition["name"].as_str().unwrap())));
    assert!(!handles("run_command"));
}

#[cfg(unix)]
#[tokio::test]
async fn expired_credential_cannot_start_a_command_after_delayed_approval() {
    struct WaitingReviewer {
        seen: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for WaitingReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.seen.lock().unwrap().take().unwrap().send(()).unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let deadline = interaction::now_ms() + 500;
    let authority = crate::auth::LocalAuthority::for_test(&scope.owner, 0, deadline);
    let (seen, observed) = tokio::sync::oneshot::channel();
    let reviewer = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let cancellation = Cancellation::default();
    let input = json!({"command":"printf unexpected > marker", "timeoutSeconds": 5});
    let action = super::execute_direct(
        &manager,
        &scope,
        &workspace,
        "expiry",
        "background_start",
        &input,
        &reviewer,
        &cancellation,
        Some(&authority),
    );
    tokio::pin!(action);
    tokio::select! { result = &mut action => panic!("approval ended unexpectedly: {result:?}"), seen = observed => seen.unwrap() }
    let delay = deadline.saturating_sub(interaction::now_ms()) as u64 + 50;
    tokio::time::sleep(Duration::from_millis(delay)).await;
    reviewer.release.notify_one();
    assert!(action.await.is_err());
    assert!(!workspace.join("marker").exists());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn expired_credential_cannot_release_output_after_delayed_approval() {
    struct WaitingReviewer {
        seen: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for WaitingReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.seen.lock().unwrap().take().unwrap().send(()).unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let background = BackgroundRequest {
        interactive: false,
        scope: BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: workspace.clone(),
            incarnation: None,
        },
        authorization_generation: Some(0),
        action_id: "a".repeat(64),
        command: "printf private-output".into(),
        timeout: Duration::from_secs(5),
    };
    manager
        .start(background.clone(), Some(&background))
        .await
        .unwrap();
    manager
        .wait(
            &background.scope,
            &background.action_id,
            Duration::from_secs(5),
            &Cancellation::default(),
        )
        .await
        .unwrap();
    let scope = scope();
    let deadline = interaction::now_ms() + 500;
    let authority = crate::auth::LocalAuthority::for_test(&scope.owner, 0, deadline);
    let (seen, observed) = tokio::sync::oneshot::channel();
    let reviewer = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let cancellation = Cancellation::default();
    let input = json!({"actionId": background.action_id});
    let action = super::execute_direct(
        &manager,
        &scope,
        &workspace,
        "read-expired",
        "background_read_output",
        &input,
        &reviewer,
        &cancellation,
        Some(&authority),
    );
    tokio::pin!(action);
    tokio::select! { result = &mut action => panic!("approval ended unexpectedly: {result:?}"), seen = observed => seen.unwrap() }
    let delay = deadline.saturating_sub(interaction::now_ms()) as u64 + 50;
    tokio::time::sleep(Duration::from_millis(delay)).await;
    reviewer.release.notify_one();
    assert!(action.await.is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn logout_during_output_review_rejects_the_stale_release_after_cleanup() {
    struct WaitingReviewer {
        seen: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for WaitingReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
            assert!(request.description.contains("private-output"));
            self.seen.lock().unwrap().take().unwrap().send(()).unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let path = root.path().join("app.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE auth_generations (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0))").unwrap();
    super::super::owner_gate::OwnerGate::initialize(&db).unwrap();
    let gate = Arc::new(super::super::owner_gate::OwnerGate::open(db).unwrap());
    let manager = BackgroundProcesses::create_controlled(
        &root.path().canonicalize().unwrap().join("ledger"),
        gate.clone(),
    )
    .unwrap();
    let background = BackgroundRequest {
        interactive: false,
        scope: BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: workspace.clone(),
            incarnation: None,
        },
        authorization_generation: Some(0),
        action_id: "a".repeat(64),
        command: "printf private-output".into(),
        timeout: Duration::from_secs(5),
    };
    manager
        .start(background.clone(), Some(&background))
        .await
        .unwrap();
    manager
        .wait(
            &background.scope,
            &background.action_id,
            Duration::from_secs(5),
            &Cancellation::default(),
        )
        .await
        .unwrap();
    let (seen, observed) = tokio::sync::oneshot::channel();
    let reviewer = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let input = json!({"actionId": background.action_id});
    let scope = scope();
    let cancellation = Cancellation::default();
    let authority = crate::auth::LocalAuthority::for_test(&scope.owner, 0, i64::MAX);
    let action = super::execute_direct(
        &manager,
        &scope,
        &workspace,
        "read",
        "background_read_output",
        &input,
        &reviewer,
        &cancellation,
        Some(&authority),
    );
    tokio::pin!(action);
    tokio::select! { _ = &mut action => panic!("approval unexpectedly completed"), seen = observed => seen.unwrap() }
    let mut db = rusqlite::Connection::open(path).unwrap();
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    super::super::owner_gate::OwnerGate::hold_in_transaction(&tx, "owner", "logout").unwrap();
    tx.execute(
        "INSERT INTO auth_generations (user_id, generation) VALUES ('owner', 1)",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    manager.service_owner_holds().await.unwrap();
    gate.release("owner", "logout").unwrap();
    reviewer.release.notify_one();
    assert!(action.await.is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn output_is_released_only_after_approval_of_the_exact_scoped_snapshot() {
    struct OutputReviewer {
        allow: bool,
        seen: std::sync::Mutex<Option<String>>,
    }
    #[async_trait]
    impl Interaction for OutputReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
            assert_eq!(request.tool_name, "background_read_output");
            *self.seen.lock().unwrap() = Some(request.description);
            Ok(self.allow)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let started: Value = serde_json::from_str(&execute(&manager, &scope, &workspace, "output-start", "background_start",
        &json!({"command":"printf private-output; printf private-error >&2", "timeoutSeconds":5}),
        &reviewer(true, None), &Cancellation::default()).await.unwrap()).unwrap();
    let id = started["actionId"].as_str().unwrap();
    execute(
        &manager,
        &scope,
        &workspace,
        "wait",
        "background_wait",
        &json!({"actionId":id,"timeoutSeconds":5}),
        &reviewer(true, None),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let denied = OutputReviewer {
        allow: false,
        seen: Default::default(),
    };
    let result = execute(
        &manager,
        &scope,
        &workspace,
        "read-denied",
        "background_read_output",
        &json!({"actionId":id}),
        &denied,
        &Cancellation::default(),
    )
    .await;
    assert!(result.unwrap_err().contains("denied"));
    assert!(denied
        .seen
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .contains("private-output"));
    let mut other = scope.clone();
    other.owner = "other".into();
    let allowed = OutputReviewer {
        allow: true,
        seen: Default::default(),
    };
    assert!(execute(
        &manager,
        &other,
        &workspace,
        "foreign",
        "background_read_output",
        &json!({"actionId":id}),
        &allowed,
        &Cancellation::default()
    )
    .await
    .is_err());
    assert!(allowed.seen.lock().unwrap().is_none());
    let result: Value = serde_json::from_str(
        &execute(
            &manager,
            &scope,
            &workspace,
            "read-approved",
            "background_read_output",
            &json!({"actionId":id}),
            &allowed,
            &Cancellation::default(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (result["stdout"].as_str(), result["stderr"].as_str()),
        (Some("private-output"), Some("private-error"))
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn output_approval_releases_only_reviewed_bytes_and_rejects_deleted_session() {
    struct WaitingReviewer {
        seen: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl Interaction for WaitingReviewer {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
            self.seen
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(request.description)
                .unwrap();
            self.release.notified().await;
            Ok(true)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let started: Value = serde_json::from_str(
        &execute(
            &manager,
            &scope,
            &workspace,
            "output-start",
            "background_start",
            &json!({"command":"printf initial", "timeoutSeconds":5}),
            &reviewer(true, None),
            &Cancellation::default(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let id = started["actionId"].as_str().unwrap();
    execute(
        &manager,
        &scope,
        &workspace,
        "wait",
        "background_wait",
        &json!({"actionId":id,"timeoutSeconds":5}),
        &reviewer(true, None),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let (seen, observed) = tokio::sync::oneshot::channel();
    let waiting = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let input = json!({"actionId":id});
    let cancel = Cancellation::default();
    let action = execute(
        &manager,
        &scope,
        &workspace,
        "read",
        "background_read_output",
        &input,
        &waiting,
        &cancel,
    );
    tokio::pin!(action);
    let shown = tokio::select! { _ = &mut action => panic!("approval unexpectedly completed"), seen = observed => seen.unwrap() };
    assert!(shown.contains("initial"));
    let background_scope = BackgroundScope {
        owner: scope.owner.clone(),
        session: scope.session_id.clone(),
        workspace: workspace.clone(),
        incarnation: None,
    };
    manager
        .entry(&background_scope, id)
        .await
        .unwrap()
        .stdout
        .lock()
        .unwrap()
        .bytes
        .extend_from_slice(b"-later");
    waiting.release.notify_one();
    let result: Value = serde_json::from_str(&action.await.unwrap()).unwrap();
    assert_eq!(result["stdout"], "initial");

    let (seen, observed) = tokio::sync::oneshot::channel();
    let waiting = WaitingReviewer {
        seen: std::sync::Mutex::new(Some(seen)),
        release: tokio::sync::Notify::new(),
    };
    let action = execute(
        &manager,
        &scope,
        &workspace,
        "read-deleted",
        "background_read_output",
        &input,
        &waiting,
        &cancel,
    );
    tokio::pin!(action);
    tokio::select! { _ = &mut action => panic!("approval unexpectedly completed"), seen = observed => { seen.unwrap(); } }
    manager
        .retire_session(&scope.owner, &scope.session_id)
        .await
        .unwrap();
    waiting.release.notify_one();
    assert!(action.await.is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn wait_returns_owned_completion_without_releasing_output() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let reviewer = reviewer(true, None);
    let started: Value = serde_json::from_str(
        &execute(
            &manager,
            &scope,
            &workspace,
            "wait-start",
            "background_start",
            &json!({"command":"printf synthetic-secret; sleep 0.2", "timeoutSeconds":5}),
            &reviewer,
            &Cancellation::default(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let action = started["actionId"].as_str().unwrap();
    let wait_input = json!({"actionId":action,"timeoutSeconds":3});
    let mut other = scope.clone();
    other.owner = "other".into();
    assert!(execute(
        &manager,
        &other,
        &workspace,
        "foreign-wait",
        "background_wait",
        &wait_input,
        &reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    reviewer.seen.store(false, Ordering::SeqCst);
    let result = execute(
        &manager,
        &scope,
        &workspace,
        "wait",
        "background_wait",
        &wait_input,
        &reviewer,
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert!(!reviewer.seen.load(Ordering::SeqCst));
    assert!(!result.contains("synthetic-secret"));
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(
        (
            result["state"].as_str(),
            result["exitCode"].as_i64(),
            result["outputWithheld"].as_bool()
        ),
        (Some("exited"), Some(0), Some(true))
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn wait_times_out_with_running_status_and_rejects_invalid_durations() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let reviewer = reviewer(true, None);
    let started: Value = serde_json::from_str(
        &execute(
            &manager,
            &scope,
            &workspace,
            "wait-timeout-start",
            "background_start",
            &json!({"command":"printf started; sleep 10", "timeoutSeconds":20}),
            &reviewer,
            &Cancellation::default(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let action = started["actionId"].as_str().unwrap();
    for timeout in [0, 31] {
        assert!(execute(
            &manager,
            &scope,
            &workspace,
            "invalid-wait",
            "background_wait",
            &json!({"actionId":action,"timeoutSeconds":timeout}),
            &reviewer,
            &Cancellation::default()
        )
        .await
        .is_err());
    }
    let start = tokio::time::Instant::now();
    let result = execute(
        &manager,
        &scope,
        &workspace,
        "bounded-wait",
        "background_wait",
        &json!({"actionId":action,"timeoutSeconds":1}),
        &reviewer,
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert!(start.elapsed() >= Duration::from_millis(900));
    assert_eq!(
        serde_json::from_str::<Value>(&result).unwrap()["state"],
        "running"
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn wait_returns_unknown_receipt_after_restart_without_replay() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let path = root.path().canonicalize().unwrap().join("ledger");
    let scope = scope();
    let action = action_id(&scope, "unfinished");
    let background_scope = BackgroundScope {
        owner: scope.owner.clone(),
        session: scope.session_id.clone(),
        workspace: workspace.clone(),
        incarnation: None,
    };
    let manager = BackgroundProcesses::create(&path).unwrap();
    manager.ledger.claim(&background_scope, &action).unwrap();
    drop(manager);
    let reopened = BackgroundProcesses::open(&path).unwrap();
    let result = execute(
        &reopened,
        &scope,
        &workspace,
        "unknown-wait",
        "background_wait",
        &json!({"actionId":action,"timeoutSeconds":30}),
        &reviewer(true, None),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result).unwrap()["state"],
        "unknown"
    );
    let retry_reviewer = reviewer(true, None);
    assert!(execute(
        &reopened,
        &scope,
        &workspace,
        "unfinished",
        "background_start",
        &json!({"command":"printf should-not-run > marker", "timeoutSeconds":2}),
        &retry_reviewer,
        &Cancellation::default(),
    )
    .await
    .is_err());
    assert!(!retry_reviewer.seen.load(Ordering::SeqCst));
    assert!(!workspace.join("marker").exists());
    assert!(reopened.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_wait_does_not_cancel_the_background_process() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let reviewer = reviewer(true, None);
    let started: Value = serde_json::from_str(
        &execute(
            &manager,
            &scope,
            &workspace,
            "wait-cancel-start",
            "background_start",
            &json!({"command":"printf started; sleep 10", "timeoutSeconds":20}),
            &reviewer,
            &Cancellation::default(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let action = started["actionId"].as_str().unwrap();
    let wait_input = json!({"actionId":action,"timeoutSeconds":5});
    let cancellation = Cancellation::default();
    let wait = execute(
        &manager,
        &scope,
        &workspace,
        "wait-cancel",
        "background_wait",
        &wait_input,
        &reviewer,
        &cancellation,
    );
    tokio::pin!(wait);
    tokio::select! {
        _ = &mut wait => panic!("wait unexpectedly completed"),
        _ = tokio::time::sleep(Duration::from_millis(50)) => {}
    }
    cancellation.cancel();
    assert!(wait.await.is_err());
    let status = execute(
        &manager,
        &scope,
        &workspace,
        "status",
        "background_status",
        &json!({"actionId":action}),
        &reviewer,
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&status).unwrap()["state"],
        "running"
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_start_status_and_cancel_are_session_scoped_and_withhold_output() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let input = json!({"command":"printf synthetic-secret; sleep 10", "timeoutSeconds":20});
    let scope = scope();
    let reviewer = reviewer(true, None);
    let started = execute(
        &manager,
        &scope,
        &workspace,
        "call-1",
        "background_start",
        &input,
        &reviewer,
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert!(reviewer.seen.load(Ordering::SeqCst));
    let started: Value = serde_json::from_str(&started).unwrap();
    let action = started["actionId"].as_str().unwrap();
    let status_input = json!({"actionId":action});
    let mut wrong = scope.clone();
    wrong.session_id = "other".into();
    assert!(execute(
        &manager,
        &wrong,
        &workspace,
        "status",
        "background_status",
        &status_input,
        &reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    wrong = scope.clone();
    wrong.owner = "other".into();
    assert!(execute(
        &manager,
        &wrong,
        &workspace,
        "cancel",
        "background_cancel",
        &status_input,
        &reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    let other = tempfile::tempdir().unwrap();
    assert!(execute(
        &manager,
        &scope,
        &other.path().canonicalize().unwrap(),
        "status",
        "background_status",
        &status_input,
        &reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    let mut next_turn = scope.clone();
    next_turn.turn_id = "next-turn".into();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let status = execute(
                &manager,
                &next_turn,
                &workspace,
                "status",
                "background_status",
                &status_input,
                &reviewer,
                &Cancellation::default(),
            )
            .await
            .unwrap();
            assert!(!status.contains("synthetic-secret"));
            if serde_json::from_str::<Value>(&status).unwrap()["outputWithheld"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("synthetic process output was not observed");
    execute(
        &manager,
        &next_turn,
        &workspace,
        "cancel",
        "background_cancel",
        &status_input,
        &reviewer,
        &Cancellation::default(),
    )
    .await
    .unwrap();
    manager.cleanup_session("owner", "session").await.unwrap();
    assert!(execute(
        &manager,
        &scope,
        &workspace,
        "call-2",
        "background_start",
        &input,
        &reviewer,
        &Cancellation::default()
    )
    .await
    .is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn denied_cancelled_and_replayed_actions_never_launch() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let scope = scope();
    let input = json!({"command":"printf synthetic > marker", "timeoutSeconds":2});
    assert!(execute(
        &manager,
        &scope,
        &workspace,
        "denied",
        "background_start",
        &input,
        &reviewer(false, None),
        &Cancellation::default()
    )
    .await
    .is_err());
    let cancel = Cancellation::default();
    assert!(execute(
        &manager,
        &scope,
        &workspace,
        "cancelled",
        "background_start",
        &input,
        &reviewer(true, Some(cancel.clone())),
        &cancel
    )
    .await
    .is_err());
    assert!(!workspace.join("marker").exists());
    execute(
        &manager,
        &scope,
        &workspace,
        "once",
        "background_start",
        &input,
        &reviewer(true, None),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert!(execute(
        &manager,
        &scope,
        &workspace,
        "once",
        "background_start",
        &input,
        &reviewer(true, None),
        &Cancellation::default()
    )
    .await
    .is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn expired_or_cancelled_while_waiting_for_admission_never_claims_or_spawns() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = BackgroundRequest {
        interactive: false,
        scope: BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: workspace.clone(),
            incarnation: None,
        },
        authorization_generation: None,
        action_id: "blocked".into(),
        command: "printf synthetic > marker".into(),
        timeout: Duration::from_secs(2),
    };
    let cancel = Cancellation::default();
    let guard = manager.registry.lock().await;
    let wait = manager.start_checked(
        request.clone(),
        Some(&request),
        &cancel,
        interaction::now_ms() + 30,
    );
    tokio::pin!(wait);
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut wait)
        .await
        .is_err());
    drop(guard);
    assert!(wait.await.is_err());
    assert!(!workspace.join("marker").exists());
    assert!(manager
        .snapshot(&request.scope, &request.action_id)
        .await
        .is_err());
    let guard = manager.registry.lock().await;
    let wait = manager.start_checked(
        request.clone(),
        Some(&request),
        &cancel,
        interaction::now_ms() + 10000,
    );
    tokio::pin!(wait);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut wait)
        .await
        .is_err());
    cancel.cancel();
    drop(guard);
    assert!(wait.await.is_err());
    assert!(manager
        .snapshot(&request.scope, &request.action_id)
        .await
        .is_err());
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_replaced_while_waiting_for_admission_is_rejected() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    let replacement = root.path().join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    let manager =
        BackgroundProcesses::create(&root.path().canonicalize().unwrap().join("ledger")).unwrap();
    let request = BackgroundRequest {
        interactive: false,
        scope: BackgroundScope {
            owner: "owner".into(),
            session: "session".into(),
            workspace: workspace.clone(),
            incarnation: None,
        },
        authorization_generation: None,
        action_id: "workspace-change".into(),
        command: "printf synthetic > marker".into(),
        timeout: Duration::from_secs(2),
    };
    let cancel = Cancellation::default();
    let guard = manager.registry.lock().await;
    let wait = manager.start_checked(
        request.clone(),
        Some(&request),
        &cancel,
        interaction::now_ms() + 10000,
    );
    tokio::pin!(wait);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut wait)
        .await
        .is_err());
    std::fs::rename(&workspace, root.path().join("original")).unwrap();
    symlink(&replacement, &workspace).unwrap();
    drop(guard);
    assert!(wait.await.is_err());
    assert!(!replacement.join("marker").exists());
    assert!(manager
        .snapshot(&request.scope, &request.action_id)
        .await
        .is_err());
    manager.shutdown().await.unwrap();
}

#[test]
fn read_only_children_are_never_allowed_any_background_tool() {
    use crate::v4_agent::ToolPolicy;
    for definition in definitions() {
        let name = definition["name"].as_str().unwrap();
        assert!(handles(name));
        assert!(
            !ToolPolicy::ReadOnlyChild.allows(name),
            "{name} must not be available to a read-only child"
        );
        assert!(ToolPolicy::Standard.allows(name));
    }
}
