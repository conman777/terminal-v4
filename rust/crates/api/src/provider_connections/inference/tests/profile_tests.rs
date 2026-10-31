use super::*;
use crate::v4_agent::{
    self,
    interaction::{ApprovalRequest, Cancellation, Interaction, TurnResources},
    profile::Binding,
    TurnOptions,
};
use terminal_v4_core::StructuredSessionEvent;
#[derive(Default)]
struct Events(tokio::sync::Mutex<Vec<StructuredSessionEvent>>);
#[async_trait::async_trait]
impl Interaction for Events {
    async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
        self.0.lock().await.push(event);
        Ok(())
    }
    async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
        Err("unexpected approval".into())
    }
}

fn script_server(
    listener: TcpListener,
    responses: Vec<Value>,
) -> (Arc<AtomicBool>, std::thread::JoinHandle<Vec<Value>>) {
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(12);
        for response in responses {
            loop {
                if done.load(Ordering::Acquire) || Instant::now() > deadline {
                    return requests;
                }
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        requests.push(read(&mut socket).1);
                        let response = response.to_string();
                        write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        }
        requests
    });
    (stop, server)
}
fn chat(text: &str) -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":text}}]})
}
struct RestoreReceipt<'a> {
    db: &'a rusqlite::Connection,
    request: String,
    original: String,
}
impl Drop for RestoreReceipt<'_> {
    fn drop(&mut self) {
        let _ = self.db.execute(
            "UPDATE provider_connection_actors SET stop_evidence_json=?1 WHERE request_id=?2",
            rusqlite::params![self.original, self.request],
        );
    }
}
async fn settled(
    manager: &crate::structured::StructuredSessionManager,
    id: &str,
    request: &str,
) -> terminal_v4_core::StructuredSessionSnapshot {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let receipt = manager
            .request_receipt("owner-A", id, request)
            .await
            .unwrap()
            .unwrap();
        if [
            "completed",
            "failed",
            "cancelled",
            "reconciliation_required",
        ]
        .contains(&receipt.status.as_str())
        {
            return manager.get_session("owner-A", id).await.unwrap().unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "structured request did not settle"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
async fn submit(
    manager: &crate::structured::StructuredSessionManager,
    id: &str,
    text: &str,
) -> String {
    let request = uuid::Uuid::new_v4().to_string();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match manager.submit("owner-A", id, text, Some(&request)).await {
            Ok(_) => return request,
            Err(error) if error.message.contains("busy") && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(2)).await
            }
            Err(error) => panic!("structured admission failed: {error:?}"),
        }
    }
}

#[tokio::test]
async fn integration_saved_profile_consecutive_turns_compaction_receipt_and_cleanup_repair() {
    use crate::structured::StructuredSessionManager;
    use terminal_v4_core::AppConfig;
    let (root, manager) = setup();
    let workspace = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let provider = Binding::provider_id(PROFILE, &selection.revision, Transport::OpenAiChat);
    let summary=json!({"goals":["independent model workflow"],"constraints":[],"decisions":[],"completed":["first answer"],"inProgress":[],"blocked":[],"files":[],"nextSteps":["continue"],"criticalContext":[]}).to_string();
    let (stop, server) = script_server(
        listener,
        vec![
            chat("first answer"),
            chat("second answer"),
            chat(&summary),
            chat("after compaction"),
        ],
    );
    let sessions = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().into(),
        ..Default::default()
    });
    sessions.bind_provider_connections(manager.clone()).unwrap();
    let session = sessions
        .create_session(
            "owner-A",
            workspace.path().to_str().unwrap(),
            Some(&provider),
            Some("selected"),
            None,
        )
        .await
        .unwrap();
    for prompt in ["first independent request", "second independent request"] {
        let request = submit(&sessions, &session.id, prompt).await;
        let snapshot = settled(&sessions, &session.id, &request).await;
        assert!(snapshot.events.iter().any(|event|matches!(event,StructuredSessionEvent::TurnCompleted{status,..} if status=="completed")));
    }
    let (entered, release) = v4_agent::profile::compaction_test_gate::install(root.path());
    let request = uuid::Uuid::new_v4().to_string();
    let receipt = sessions
        .compact("owner-A", &session.id, &request, None, None)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    let db = actor_db(root.path());
    let(request_id,original):(String,String)=db.query_row("SELECT request_id,stop_evidence_json FROM provider_connection_actors WHERE consumer_kind='structured-compact'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    db.execute("UPDATE provider_connection_actors SET stop_evidence_json='synthetic-post-commit-failure' WHERE request_id=?1",[&request_id]).unwrap();
    release.send(()).unwrap();
    let restore = RestoreReceipt {
        db: &db,
        request: request_id.clone(),
        original,
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let snapshot = loop {
        let snapshot = sessions
            .get_session("owner-A", &session.id)
            .await
            .unwrap()
            .unwrap();
        if matches!(snapshot.status.as_deref(),Some("reconciliation_required"|"cleanup_required")) && snapshot.events.iter().any(|event|matches!(event,StructuredSessionEvent::TurnCompleted{turn_id,..} if Some(turn_id)==receipt.turn_id.as_ref())) {break snapshot;}
        assert!(
            Instant::now() < deadline,
            "missing retained cleanup state: {:?}",
            snapshot.status
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    };
    let committed=snapshot.events.iter().any(|event|matches!(event,StructuredSessionEvent::Compaction{turn_id,status,receipt:Some(_),..} if Some(turn_id)==receipt.turn_id.as_ref() && status=="completed"));
    drop(restore);
    sessions.interrupt("owner-A", &session.id).await.unwrap();
    let follow = submit(&sessions, &session.id, "continue after exact repair").await;
    let last = settled(&sessions, &session.id, &follow).await;
    sessions.shutdown().await.unwrap();
    assert!(manager.shutdown().await);
    stop.store(true, Ordering::Release);
    let requests = server.join().unwrap();
    assert!(
        committed,
        "a committed compaction lost its completion receipt after cleanup verification failed"
    );
    assert_eq!(requests.len(), 4);
    assert!(requests[2].get("tools").is_none());
    assert!(requests[3]
        .to_string()
        .contains("independent model workflow"));
    assert!(!requests[3].to_string().contains("_v4HostEvidence"));
    assert!(last.events.iter().any(|event|matches!(event,StructuredSessionEvent::MessageCompleted{content,..} if content=="after compaction")));
}

#[test]
fn saved_profile_binding_keeps_protocol_and_revision_without_fabricating_capabilities() {
    let provider = Binding::provider_id(PROFILE, OP, Transport::OpenAiChat);
    let binding = Binding::parse(&provider).expect("saved profile binding unavailable");
    assert_eq!(binding.profile_id, PROFILE);
    assert_eq!(binding.revision, OP);
    assert_eq!(binding.transport, Transport::OpenAiChat);
    assert!(v4_agent::supports(&provider));
    assert!(!v4_agent::supports_tasks(&provider));
    assert!(v4_agent::resolve_selection(&provider, None, None).is_err());
    assert_eq!(
        v4_agent::resolve_selection(&provider, Some("selected"), None).unwrap(),
        "selected"
    );
    assert!(v4_agent::resolve_selection(&provider, Some("selected"), Some("high")).is_err());
    for invalid in [
        provider.replace(PROFILE, "../private"),
        provider.to_uppercase(),
        format!("{provider}:extra"),
        provider.replace("chat", "anthropic"),
    ] {
        assert!(Binding::parse(&invalid).is_none());
    }
}

#[tokio::test]
async fn saved_profile_structured_turn_runs_own_tool_cycle_and_preserves_canonical_history() {
    let (root, manager) = setup();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("notes.txt"),
        "independent profile tool result",
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let provider = Binding::provider_id(PROFILE, &selection.revision, Transport::OpenAiChat);
    let stop = Arc::new(AtomicBool::new(false));
    let finish = stop.clone();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        while requests.len() < 2 && !finish.load(Ordering::Acquire) && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    let (headers, body) = read(&mut socket);
                    assert!(headers
                        .to_ascii_lowercase()
                        .contains("authorization: bearer synthetic-manager-inference-key"));
                    assert!(headers.starts_with("POST /v1/chat/completions "));
                    requests.push(body);
                    let body=if requests.len()==1 {json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"own-call","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes.txt\"}"}}]}}]})} else {json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Own saved profile completed"}}]})}.to_string();
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(error) => panic!("{error}"),
            }
        }
        requests
    });
    let id = uuid::Uuid::new_v4().to_string();
    let events = Arc::new(Events::default());
    let resources = Arc::new(TurnResources::default());
    let result = v4_agent::run_structured_turn(
        TurnOptions {
            data_dir: root.path().into(),
            owner: "owner-A".into(),
            session_id: id.clone(),
            canonical_session_id: "ss-own-profile".into(),
            turn_id: uuid::Uuid::new_v4().to_string(),
            provider: provider.clone(),
            model: Some("selected".into()),
            reasoning: None,
            workspace: workspace.path().into(),
            prompt: "Read notes.txt and answer".into(),
            attachments: vec![],
            recovery_events: vec![],
            local_authority: None,
            #[cfg(unix)]
            paired_authority: None,
        },
        events.clone(),
        Cancellation::default(),
        resources.clone(),
        Some(manager.clone()),
    )
    .await;
    stop.store(true, Ordering::Release);
    let requests = server.join().unwrap();
    let cleaned = resources.close().await;
    assert!(manager.shutdown().await);
    assert!(result.is_ok(), "saved profile turn failed: {result:?}");
    assert!(cleaned.is_ok());
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["model"], "selected");
    assert_eq!(requests[0]["stream"], true);
    assert!(requests[1]["messages"]
        .to_string()
        .contains("independent profile tool result"));
    assert!(events.0.lock().await.iter().any(|event|matches!(event,StructuredSessionEvent::MessageCompleted{content,..} if content=="Own saved profile completed")));
    let history_root = root
        .path()
        .join("v4-agent-history")
        .join(hex::encode(Sha256::digest(b"owner-A")));
    let canonical_workspace = workspace.path().canonicalize().unwrap();
    let normalized =
        crate::session_search::normalize_workspace_path(&canonical_workspace.to_string_lossy());
    let saved: Value = serde_json::from_slice(
        &std::fs::read(
            history_root
                .join(hex::encode(Sha256::digest(normalized.as_bytes())))
                .join(format!("{id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["provider"], provider);
    assert!(saved["history"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["role"] == "tool"));
}
