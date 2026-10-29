use super::*;
use std::sync::atomic::AtomicUsize;

struct IdleController;
#[async_trait]
impl StructuredProcessController for IdleController {
    async fn send_input(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn send_approval(&self, _: bool) -> Result<(), String> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn kill(&self) -> Result<(), String> {
        Ok(())
    }
}

struct CountingClaude(Arc<AtomicUsize>);
impl StructuredProvider for CountingClaude {
    fn provider_id(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let (tx, events) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let _tx = tx;
            std::future::pending::<()>().await;
        });
        Ok(SpawnedStructuredProcess {
            controller: Arc::new(IdleController),
            events,
        })
    }
}

fn manager(data: &Path, starts: &Arc<AtomicUsize>) -> StructuredSessionManager {
    StructuredSessionManager::new_with_providers(
        AppConfig {
            data_dir: data.to_path_buf(),
            ..Default::default()
        },
        vec![Arc::new(CountingClaude(starts.clone()))],
    )
}

fn ledger_lines(data: &Path, owner: &str, id: &str) -> Vec<serde_json::Value> {
    let config = AppConfig {
        data_dir: data.to_path_buf(),
        ..Default::default()
    };
    let path =
        request_ledger::session_file(&config, "structured-native-requests", owner, id, "jsonl")
            .unwrap();
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn claude_session(manager: &StructuredSessionManager, cwd: &Path) -> String {
    manager
        .create_session("owner", cwd.to_str().unwrap(), Some("claude"), None, None)
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn native_send_persists_the_request_before_acceptance_is_reported() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    let request = Uuid::new_v4().to_string();
    let receipt = manager
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
    let (message_id, seq) = snapshot
        .events
        .iter()
        .find_map(|event| match event {
            StructuredSessionEvent::MessageCompleted {
                message_id: Some(message_id),
                seq,
                role,
                ..
            } if role == "user" => Some((message_id.clone(), *seq)),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        receipt,
        StructuredReceipt {
            status: "accepted".into(),
            request_id: Some(request.clone()),
            turn_id: None,
            message_id: Some(message_id.clone()),
            accepted_seq: Some(seq),
            input: None,
        }
    );
    assert_eq!(
        ledger_lines(data.path(), "owner", &id),
        vec![serde_json::json!({
            "requestId": request,
            "messageId": message_id,
            "textSha256": request_ledger::text_digest("hello"),
        })]
    );
}

#[tokio::test]
async fn native_retry_returns_the_original_receipt_without_a_second_start() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    let request = Uuid::new_v4().to_string();
    let original = manager
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    let retry = manager
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    assert_eq!((retry, starts.load(Ordering::SeqCst)), (original, 1));
}

#[tokio::test]
async fn native_request_reused_with_different_text_is_rejected() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    let request = Uuid::new_v4().to_string();
    manager
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    let error = manager
        .submit("owner", &id, "different", Some(&request))
        .await
        .unwrap_err();
    assert_eq!(
        (error.message, starts.load(Ordering::SeqCst)),
        ("requestId was already used with different text".into(), 1)
    );
}

#[tokio::test]
async fn restarted_manager_reconciles_an_accepted_request_from_disk() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), &starts);
    let id = claude_session(&first, workspace.path()).await;
    let request = Uuid::new_v4().to_string();
    let original = first
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    drop(first);
    let restarted = manager(data.path(), &starts);
    restarted.get_session("owner", &id).await.unwrap().unwrap();
    let retry = restarted
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    assert_eq!((retry, starts.load(Ordering::SeqCst)), (original, 1));
}

#[tokio::test]
async fn restarted_manager_treats_an_unaccepted_intent_as_absent_and_sends_once() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), &starts);
    let id = claude_session(&first, workspace.path()).await;
    let request = Uuid::new_v4().to_string();
    let crashed_message = Uuid::new_v4().to_string();
    request_ledger::record_intent(
        &first.inner.config,
        "owner",
        &id,
        &request_ledger::IntentRecord {
            request_id: request.clone(),
            message_id: crashed_message.clone(),
            text_sha256: request_ledger::text_digest("hello"),
        },
    )
    .unwrap();
    drop(first);
    let restarted = manager(data.path(), &starts);
    restarted.get_session("owner", &id).await.unwrap().unwrap();
    let receipt = restarted
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    let lines = ledger_lines(data.path(), "owner", &id);
    assert_eq!(
        (
            lines.len(),
            lines[0]["messageId"].as_str().unwrap(),
            lines[1]["messageId"].as_str().map(str::to_owned),
            starts.load(Ordering::SeqCst),
        ),
        (2, crashed_message.as_str(), receipt.message_id, 1)
    );
}

#[tokio::test]
async fn second_manager_started_after_acceptance_returns_the_same_receipt() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), &starts);
    let id = claude_session(&first, workspace.path()).await;
    let request = Uuid::new_v4().to_string();
    let original = first
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    let second = manager(data.path(), &starts);
    second.get_session("owner", &id).await.unwrap().unwrap();
    let retry = second
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    assert_eq!((retry, starts.load(Ordering::SeqCst)), (original, 1));
}

#[tokio::test]
async fn manager_whose_history_was_replaced_fails_closed_and_the_intent_reconciles_as_absent() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), &starts);
    let id = claude_session(&first, workspace.path()).await;
    let second = manager(data.path(), &starts);
    second.get_session("owner", &id).await.unwrap().unwrap();
    let request = Uuid::new_v4().to_string();
    let failed = first
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap_err();
    let accepted = second
        .submit("owner", &id, "hello", Some(&request))
        .await
        .unwrap();
    let lines = ledger_lines(data.path(), "owner", &id);
    assert_eq!(
        (
            failed.message,
            lines.len(),
            lines[1]["messageId"].as_str().map(str::to_owned),
            accepted.message_id,
            starts.load(Ordering::SeqCst),
        ),
        (
            "Structured history file identity changed".into(),
            2,
            lines[1]["messageId"].as_str().map(str::to_owned),
            lines[1]["messageId"].as_str().map(str::to_owned),
            1
        )
    );
}

#[tokio::test]
async fn held_session_lease_blocks_another_manager_without_waiting() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    let held = request_ledger::acquire_lease(&manager.inner.config, "owner", &id).unwrap();
    let error = manager
        .submit("owner", &id, "hello", Some(&Uuid::new_v4().to_string()))
        .await
        .unwrap_err();
    drop(held);
    assert_eq!(
        (error.message, starts.load(Ordering::SeqCst)),
        (
            "Session is being changed by another manager; try again".into(),
            0
        )
    );
}

#[tokio::test]
async fn native_send_without_request_id_keeps_the_legacy_receipt_and_writes_no_ledger() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    let receipt = manager.submit("owner", &id, "hello", None).await.unwrap();
    assert_eq!(
        (
            receipt,
            data.path().join("structured-native-requests").exists()
        ),
        (StructuredReceipt::legacy(), false)
    );
}

#[test]
fn ledger_ignores_a_torn_final_record_and_compacts_when_full() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().to_path_buf(),
        ..Default::default()
    };
    let id = "ss-00000000-0000-0000-0000-000000000000";
    let record = |n: usize| request_ledger::IntentRecord {
        request_id: format!("request-{n}"),
        message_id: format!("message-{n}"),
        text_sha256: "digest".into(),
    };
    for n in 0..request_ledger::MAX_LEDGER_RECORDS {
        request_ledger::record_intent(&config, "owner", id, &record(n)).unwrap();
    }
    request_ledger::record_intent(&config, "owner", id, &record(9999)).unwrap();
    let path =
        request_ledger::session_file(&config, "structured-native-requests", "owner", id, "jsonl")
            .unwrap();
    let mut torn = fs::OpenOptions::new().append(true).open(&path).unwrap();
    std::io::Write::write_all(&mut torn, b"{\"requestId\":\"torn").unwrap();
    request_ledger::record_intent(&config, "owner", id, &record(7777)).unwrap();
    let found = |n: usize| {
        request_ledger::find_intent(&config, "owner", id, &format!("request-{n}")).unwrap()
    };
    assert_eq!(
        (
            found(0),
            found(request_ledger::MAX_LEDGER_RECORDS - 1),
            found(9999),
            found(7777),
            found(5000),
        ),
        (
            None,
            Some(record(request_ledger::MAX_LEDGER_RECORDS - 1)),
            Some(record(9999)),
            Some(record(7777)),
            None
        )
    );
}

fn lease_and_ledger(data: &Path, id: &str) -> (PathBuf, PathBuf) {
    let config = AppConfig {
        data_dir: data.to_path_buf(),
        ..Default::default()
    };
    (
        request_ledger::session_file(&config, "structured-session-leases", "owner", id, "lock")
            .unwrap(),
        request_ledger::session_file(&config, "structured-native-requests", "owner", id, "jsonl")
            .unwrap(),
    )
}

#[tokio::test]
async fn delete_removes_the_lease_and_request_ledger() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    manager
        .submit("owner", &id, "hello", Some(&Uuid::new_v4().to_string()))
        .await
        .unwrap();
    let (lease, ledger) = lease_and_ledger(data.path(), &id);
    assert!(lease.exists() && ledger.exists());
    manager.delete_session("owner", &id).await.unwrap();
    assert!(!lease.exists() && !ledger.exists());
    assert!(manager.get_session("owner", &id).await.unwrap().is_none());
}

#[tokio::test]
async fn delete_is_refused_while_another_manager_holds_the_lease() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    let held = request_ledger::acquire_lease(&manager.inner.config, "owner", &id).unwrap();
    assert!(manager.delete_session("owner", &id).await.is_err());
    assert!(manager.get_session("owner", &id).await.unwrap().is_some());
    drop(held);
    manager.delete_session("owner", &id).await.unwrap();
}

#[tokio::test]
async fn raw_input_to_a_running_provider_is_fenced_by_the_session_lease() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), &starts);
    let id = claude_session(&manager, workspace.path()).await;
    manager
        .submit("owner", &id, "hello", Some(&Uuid::new_v4().to_string()))
        .await
        .unwrap();
    let held = request_ledger::acquire_lease(&manager.inner.config, "owner", &id).unwrap();
    assert!(manager
        .send_input("owner", &id, "typed", false)
        .await
        .is_err());
    drop(held);
    manager
        .send_input("owner", &id, "typed", false)
        .await
        .unwrap();
}
