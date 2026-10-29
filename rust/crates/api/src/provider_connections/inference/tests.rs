use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::{Duration, Instant},
};
const PROFILE: &str = "10000000-0000-4000-8000-000000000001";
const OP: &str = "60000000-0000-4000-8000-000000000001";
const REQUEST: &str = "50000000-0000-4000-8000-000000000001";
fn account(id: &str) -> ExecutionAccount {
    ExecutionAccount {
        user_id: id.into(),
        username: id.into(),
    }
}
fn setup() -> (tempfile::TempDir, ProviderConnectionManager) {
    let root = tempfile::tempdir().unwrap();
    let manager = ProviderConnectionManager::new(root.path()).unwrap();
    (root, manager)
}
async fn save(manager: &ProviderConnectionManager, base: &str) -> Selection {
    let body = json!({"operationId":OP,"expectedRevision":null,"provider":"lmstudio","mode":"local","baseUrl":base,"auth":{"type":"bearer","credentialAction":"replace","secret":"synthetic-manager-inference-key"}});
    let receipt = manager
        .execute(
            &account("owner-A"),
            super::super::Operation::Put {
                profile: PROFILE.into(),
                body,
            },
        )
        .await
        .unwrap();
    Selection {
        profile_id: PROFILE.into(),
        revision: receipt["savedRevision"].as_str().unwrap().into(),
        model: "selected".into(),
    }
}
async fn save_actual(manager: &ProviderConnectionManager, base: &str) -> Selection {
    let body = json!({"operationId":OP,"expectedRevision":null,"provider":"actual","mode":"local","baseUrl":base,"clusterId":"synthetic-cluster","auth":{"type":"none"}});
    let receipt = manager
        .execute(
            &account("owner-A"),
            super::super::Operation::Put {
                profile: PROFILE.into(),
                body,
            },
        )
        .await
        .unwrap();
    Selection {
        profile_id: PROFILE.into(),
        revision: receipt["savedRevision"].as_str().unwrap().into(),
        model: "selected".into(),
    }
}
fn read(stream: &mut TcpStream) -> (String, Value) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    let mut bytes = vec![];
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 16_384);
    }
    let headers = String::from_utf8(bytes).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    assert!(length < 1_000_000);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (headers, serde_json::from_slice(&body).unwrap())
}
async fn next(client: &mut Client) -> InferencePoll {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let poll = client.poll().await.unwrap();
        if !matches!(poll, InferencePoll::Pending) {
            return poll;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
fn stored_stopped(root: &FsPath) -> bool {
    let directory = root
        .join("provider-connections")
        .join(hex::encode(Sha256::digest(b"owner-A")))
        .join(terminal_v4_provider_connections::storage::DATABASE_FILE);
    let db = rusqlite::Connection::open(directory).unwrap();
    let row: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors WHERE request_id=?1",
            [REQUEST],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap();
    row.is_some_and(|(status, fact)| status == "quiescent" && fact.is_some())
}
use rusqlite::OptionalExtension;
mod profile_tests;
mod turn_tests;
fn actor_db(root: &FsPath) -> rusqlite::Connection {
    rusqlite::Connection::open(
        root.join("provider-connections")
            .join(hex::encode(Sha256::digest(b"owner-A")))
            .join(terminal_v4_provider_connections::storage::DATABASE_FILE),
    )
    .unwrap()
}

async fn completed_client() -> (tempfile::TempDir, ProviderConnectionManager, Client) {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_retained_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    let body=json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"complete"}}]}).to_string();
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    drop(socket);
    client.response(&mut |_| Ok(())).await.unwrap();
    assert!(stored_stopped(root.path()));
    (root, manager, client)
}

#[tokio::test]
async fn integration_shutdown_drain_cancels_http_but_keeps_original_receipt_verification_available()
{
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_retained_inference(
            &account("owner-A"),
            selection.clone(),
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    manager.request_drain();
    let new = manager
        .start_retained_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            "50000000-0000-4000-8000-000000000002".into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await;
    let rejected = match new {
        Err(failure) => {
            let (error, cleanup) = failure.into_parts();
            error == ConnectionError::CleanupPending && matches!(cleanup, StartCleanup::NoDispatch)
        }
        Ok(client) => {
            drop(client);
            false
        }
    };
    socket.set_nonblocking(true).unwrap();
    let eof_deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match socket.read(&mut [0; 1]) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            other => panic!("drain did not close the original socket: {other:?}"),
        };
        assert!(Instant::now() < eof_deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if client.cancel_and_confirm_release().await.unwrap() {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(stored_stopped(root.path()));
    drop(client);
    assert!(manager.shutdown().await);
    assert!(rejected, "shutdown drain admitted new provider work");
}

#[tokio::test]
async fn integration_shutdown_drain_rejects_already_queued_begin_before_dispatch() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let owner = account("owner-A");
    let release = pause(&manager);
    let mut begin = Box::pin(manager.start_retained_inference(
        &owner,
        selection,
        Transport::OpenAiChat,
        REQUEST.into(),
        InferenceConsumer::Conversation,
        json!({"model":"selected","messages":[]}),
    ));
    assert!(matches!(once(begin.as_mut()), Poll::Pending));
    manager.request_drain();
    release.send(()).unwrap();
    let failure = begin
        .await
        .err()
        .expect("queued begin dispatched while draining");
    let (error, cleanup) = failure.into_parts();
    assert_eq!(error, ConnectionError::CleanupPending);
    assert!(matches!(cleanup, StartCleanup::NoDispatch));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let count: i64 = actor_db(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn durable_release_confirmation_rechecks_original_fact_and_recovers_only_after_exact_repair()
{
    let (root, manager, mut client) = completed_client().await;
    assert!(client.cancel_and_confirm_release().await.unwrap());
    let profiles = manager
        .execute(&account("owner-A"), super::super::Operation::Profiles)
        .await
        .unwrap();
    let deletion=manager.execute(&account("owner-A"),super::super::Operation::Delete{profile:PROFILE.into(),body:json!({"operationId":"60000000-0000-4000-8000-000000000002","expectedRevision":profiles["profiles"][0]["revision"]})}).await.unwrap();
    assert_eq!(deletion["deleted"], true);
    assert!(
        client.cancel_and_confirm_release().await.unwrap(),
        "original cleanup incorrectly required the deleted current profile"
    );
    let db = actor_db(root.path());
    let original: String = db
        .query_row(
            "SELECT stop_evidence_json FROM provider_connection_actors WHERE request_id=?1",
            [REQUEST],
            |row| row.get(0),
        )
        .unwrap();
    let mut all_refused = true;
    let mut all_repaired = true;
    for invalid in [None, Some("forged")] {
        db.execute(
            "UPDATE provider_connection_actors SET stop_evidence_json=?1 WHERE request_id=?2",
            rusqlite::params![invalid, REQUEST],
        )
        .unwrap();
        all_refused &= !matches!(client.cancel_and_confirm_release().await, Ok(true));
        // Restore before asserting so a failed regression also cleans its
        // deliberately broken fixture without losing the original owner.
        db.execute(
            "UPDATE provider_connection_actors SET stop_evidence_json=?1 WHERE request_id=?2",
            rusqlite::params![original, REQUEST],
        )
        .unwrap();
        all_repaired &= client.cancel_and_confirm_release().await.unwrap();
    }
    drop(client);
    assert!(manager.shutdown().await);
    assert!(
        all_refused,
        "cached local stop was mistaken for current authenticated durable release"
    );
    assert!(all_repaired);
}

#[tokio::test]
async fn queued_input_budget_rejects_an_oversized_body_before_actor_queueing() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let owner = account("owner-A");
    let release = pause(&manager);
    let mut future = Box::pin(manager.start_retained_inference(
        &owner,
        selection,
        Transport::OpenAiChat,
        REQUEST.into(),
        InferenceConsumer::Conversation,
        json!({"model":"selected","payload":"x".repeat(25_000_000)}),
    ));
    let rejected = match once(future.as_mut()) {
        Poll::Ready(Err(failure)) => {
            let (error, cleanup) = failure.into_parts();
            error == ConnectionError::CapacityReached && matches!(cleanup, StartCleanup::NoDispatch)
        }
        Poll::Ready(Ok(client)) => {
            drop(client);
            false
        }
        Poll::Pending => false,
    };
    drop(future);
    release.send(()).unwrap();
    manager
        .execute(&owner, super::super::Operation::Profiles)
        .await
        .unwrap();
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let count: i64 = actor_db(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(manager.shutdown().await);
    assert!(rejected, "oversized request entered the shared actor queue");
}

#[tokio::test]
async fn queued_input_budget_stays_with_cancelled_messages_and_is_reusable_after_actor_drop() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let owner = account("owner-A");
    let release = pause(&manager);
    let body = || json!({"model":"selected","payload":"x".repeat(17_000_000)});
    let mut first = Box::pin(manager.start_retained_inference(
        &owner,
        selection.clone(),
        Transport::OpenAiChat,
        REQUEST.into(),
        InferenceConsumer::Conversation,
        body(),
    ));
    let mut second = Box::pin(manager.start_retained_inference(
        &owner,
        selection.clone(),
        Transport::OpenAiChat,
        "50000000-0000-4000-8000-000000000002".into(),
        InferenceConsumer::Conversation,
        body(),
    ));
    assert!(matches!(once(first.as_mut()), Poll::Pending));
    assert!(matches!(once(second.as_mut()), Poll::Pending));
    drop(first);
    drop(second);
    // Both 17MB messages are still held in the paused actor queue even though
    // their callers are gone. A third exceeds the real48MB aggregate budget.
    let mut third = Box::pin(manager.start_retained_inference(
        &owner,
        selection.clone(),
        Transport::OpenAiChat,
        "50000000-0000-4000-8000-000000000003".into(),
        InferenceConsumer::Conversation,
        body(),
    ));
    let rejected = match once(third.as_mut()) {
        Poll::Ready(Err(failure)) => {
            let (error, cleanup) = failure.into_parts();
            error == ConnectionError::CapacityReached && matches!(cleanup, StartCleanup::NoDispatch)
        }
        Poll::Ready(Ok(client)) => {
            drop(client);
            false
        }
        Poll::Pending => false,
    };
    drop(third);
    release.send(()).unwrap();
    manager
        .execute(&owner, super::super::Operation::Profiles)
        .await
        .unwrap();
    let release = pause(&manager);
    let mut retry = Box::pin(manager.start_retained_inference(
        &owner,
        selection,
        Transport::OpenAiChat,
        "50000000-0000-4000-8000-000000000004".into(),
        InferenceConsumer::Conversation,
        body(),
    ));
    let reused = matches!(once(retry.as_mut()), Poll::Pending);
    drop(retry);
    release.send(()).unwrap();
    manager
        .execute(&owner, super::super::Operation::Profiles)
        .await
        .unwrap();
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    assert!(manager.shutdown().await);
    assert!(
        rejected,
        "cancelled queued bodies lost their aggregate reservation"
    );
    assert!(reused, "actor message drop leaked its input reservation");
}

#[tokio::test]
async fn durable_release_confirmation_does_not_infer_current_fact_from_a_stopped_manager() {
    let (_root, manager, mut client) = completed_client().await;
    assert!(manager.shutdown().await);
    assert!(client.cancel_and_confirm_stop().await.unwrap());
    assert!(matches!(
        client.cancel_and_confirm_release().await,
        Err(ConnectionError::StorageUnavailable)
    ));
}

#[tokio::test]
async fn retained_factory_wrong_protocol_is_no_dispatch_without_actor_or_http() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let failure = manager
        .start_retained_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiResponses,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","input":[]}),
        )
        .await
        .err()
        .unwrap();
    let (error, cleanup) = failure.into_parts();
    assert_eq!(error, ConnectionError::InvalidInput);
    assert!(matches!(cleanup, StartCleanup::NoDispatch));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let count: i64 = actor_db(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn retained_factory_failed_admission_returns_original_client_for_confirmed_cleanup() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let db = actor_db(root.path());
    db.execute_batch("CREATE TRIGGER retain_failed_start BEFORE UPDATE OF started ON provider_connection_actors WHEN NEW.started=1 BEGIN SELECT RAISE(ABORT,'synthetic started status failure'); END;").unwrap();
    let failure = manager
        .start_retained_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .err()
        .unwrap();
    let (error, cleanup) = failure.into_parts();
    assert_eq!(error, ConnectionError::StorageUnavailable);
    let mut client = match cleanup {
        StartCleanup::Owned(client) => client,
        _ => panic!("failed start lost the original cleanup client"),
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    while !client.cancel_and_confirm_stop().await.unwrap() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(stored_stopped(root.path()));
    drop(client);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn retained_factory_full_queue_is_no_dispatch_for_that_attempt() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let release = pause(&manager);
    for _ in 0..128 {
        manager
            .lifetime
            .sender
            .try_send(super::super::Message::Wake)
            .unwrap();
    }
    let failure = manager
        .start_retained_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected"}),
        )
        .await
        .err()
        .unwrap();
    release.send(()).unwrap();
    let (error, cleanup) = failure.into_parts();
    assert_eq!(error, ConnectionError::CapacityReached);
    assert!(matches!(cleanup, StartCleanup::NoDispatch));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    assert!(manager.shutdown().await);
}

async fn json_response(body: Value) -> (Result<Value, String>, bool) {
    json_response_for(false, body).await
}
async fn json_response_for(actual: bool, body: Value) -> (Result<Value, String>, bool) {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let selection = if actual {
        save_actual(&manager, &base).await
    } else {
        save(&manager, &base).await
    };
    let request = if actual {
        json!({"model":"selected","input":[]})
    } else {
        json!({"model":"selected","messages":[]})
    };
    let transport = if actual {
        Transport::OpenAiResponses
    } else {
        Transport::OpenAiChat
    };
    let mut client = manager
        .start_checked_inference(
            &account("owner-A"),
            selection,
            transport,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            request,
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    let (headers, request) = read(&mut socket);
    assert!(headers.starts_with(if actual {
        "POST /v1/responses HTTP/1.1"
    } else {
        "POST /v1/chat/completions HTTP/1.1"
    }));
    assert_eq!(request["stream"], true);
    assert_eq!(request["model"], "selected");
    let body = serde_json::to_vec(&body).unwrap();
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
    socket.write_all(&body).unwrap();
    drop(socket);
    let result = client.response(&mut |_| Ok(())).await;
    let stopped = stored_stopped(root.path());
    drop(client);
    assert!(manager.shutdown().await);
    (result, stopped)
}

#[tokio::test]
async fn profile_response_responses_json_validates_status_roles_and_tool_arguments() {
    let good = json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"own Responses answer"}]}]});
    let (result, stopped) = json_response_for(true, good.clone()).await;
    assert_eq!(result.unwrap(), good);
    assert!(stopped);
    for (body, reason) in [
        (json!({"status":"incomplete","output":[]}), "incomplete"),
        (
            json!({"status":"completed","output":[{"type":"message","role":"user","content":[{"type":"output_text","text":"forged"}]}]}),
            "role",
        ),
        (
            json!({"status":"completed","output":[{"type":"function_call","call_id":"call-own","name":"read_file","arguments":"{"}]}),
            "arguments",
        ),
    ] {
        let (result, stopped) = json_response_for(true, body).await;
        assert!(result.err().unwrap().contains(reason));
        assert!(stopped);
    }
}

#[tokio::test]
async fn profile_response_responses_sse_preserves_the_authoritative_completed_body() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save_actual(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_checked_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiResponses,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","input":[]}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
    let body = json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]},{"type":"function_call","call_id":"own-call","name":"read_file","arguments":"{\"path\":\"README.md\"}"}],"usage":{"input_tokens":10,"output_tokens":2}});
    let events = format!(
        "data: {}\n\ndata: {}\n\n",
        json!({"type":"response.output_text.delta","delta":"answer"}),
        json!({"type":"response.completed","response":body})
    );
    chunk(&mut socket, events.as_bytes());
    socket.write_all(b"0\r\n\r\n").unwrap();
    drop(socket);
    let mut text = String::new();
    let result = client
        .response(&mut |delta| {
            text.push_str(delta);
            Ok(())
        })
        .await;
    assert_eq!(result.unwrap(), body);
    assert_eq!(text, "answer");
    assert!(stored_stopped(root.path()));
    drop(client);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn profile_response_future_loss_cancels_the_socket_before_explicit_cleanup() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_checked_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
    let event = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"visible"},"finish_reason":null}]})
    );
    chunk(&mut socket, event.as_bytes());
    let seen = Arc::new(AtomicBool::new(false));
    let flag = seen.clone();
    let mut callback = move |delta: &str| {
        assert_eq!(delta, "visible");
        flag.store(true, Ordering::Release);
        Ok(())
    };
    let mut future = Box::pin(client.response(&mut callback));
    let deadline = Instant::now() + Duration::from_secs(4);
    while !seen.load(Ordering::Acquire) {
        assert!(matches!(once(future.as_mut()), Poll::Pending));
        assert!(
            Instant::now() < deadline,
            "no text reached the response consumer"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    drop(future);
    // No explicit cancel/stop call may mask a missing response-future guard.
    let mut byte = [0];
    match socket.read(&mut byte) {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        other => panic!("abandoned response did not close socket: {other:?}"),
    }
    while !client.cancel_and_confirm_stop().await.unwrap() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(stored_stopped(root.path()));
    drop(client);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn profile_response_accepts_complete_json_only_after_original_release() {
    let body = json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"own answer"}}]});
    let (result, stopped) = json_response(body.clone()).await;
    assert_eq!(result.unwrap(), body);
    assert!(stopped);
}

#[tokio::test]
async fn profile_response_rejects_json_without_a_model_finish_signal() {
    let (result, _) = json_response(
        json!({"choices":[{"message":{"role":"assistant","content":"partial answer"}}]}),
    )
    .await;
    let message = result
        .err()
        .expect("transport EOF cannot invent model completion");
    assert!(message.to_lowercase().contains("complet"), "{message}");
}

fn chunk(socket: &mut TcpStream, bytes: &[u8]) {
    write!(socket, "{:x}\r\n", bytes.len()).unwrap();
    socket.write_all(bytes).unwrap();
    socket.write_all(b"\r\n").unwrap();
}

#[tokio::test]
async fn profile_response_streams_unicode_before_eof_then_requires_protocol_completion() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_checked_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .unwrap();
    let (seen_tx, seen) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read(&mut socket);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        let delta = format!(
            "data: {}\n\n",
            json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"hello 🌍"},"finish_reason":null}]})
        );
        let split = delta
            .as_bytes()
            .iter()
            .position(|byte| *byte == 0xf0)
            .unwrap()
            + 1;
        chunk(&mut socket, &delta.as_bytes()[..split]);
        chunk(&mut socket, &delta.as_bytes()[split..]);
        if seen.recv_timeout(Duration::from_secs(4)).is_ok() {
            let finish = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
            );
            chunk(&mut socket, finish.as_bytes());
            socket.write_all(b"0\r\n\r\n").unwrap();
        }
    });
    let mut output = String::new();
    let mut callback = |delta: &str| {
        assert!(!stored_stopped(root.path()), "text was withheld until EOF");
        output.push_str(delta);
        seen_tx.send(()).unwrap();
        Ok(())
    };
    let result = client.response(&mut callback).await;
    drop(callback);
    drop(seen_tx);
    server.join().unwrap();
    let body = result.unwrap();
    assert_eq!(output, "hello 🌍");
    assert_eq!(body["choices"][0]["finish_reason"], "stop");
    assert!(stored_stopped(root.path()));
    drop(client);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn profile_response_rejects_transport_eof_before_sse_finish() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_checked_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected"}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
    let delta = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]})
    );
    chunk(&mut socket, delta.as_bytes());
    socket.write_all(b"0\r\n\r\n").unwrap();
    drop(socket);
    let mut output = String::new();
    let result = client
        .response(&mut |delta| {
            output.push_str(delta);
            Ok(())
        })
        .await;
    let message = result
        .err()
        .expect("incomplete SSE cannot become a completed answer");
    assert!(message.to_lowercase().contains("complet"), "{message}");
    assert_eq!(output, "partial");
    drop(client);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn checked_inference_rejects_wrong_protocol_before_admission_or_io() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    assert!(matches!(
        manager
            .start_checked_inference(
                &account("owner-A"),
                selection,
                Transport::OpenAiResponses,
                REQUEST.into(),
                InferenceConsumer::Conversation,
                json!({"model":"selected","input":[]})
            )
            .await,
        Err(ConnectionError::InvalidInput)
    ));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let count: i64 = actor_db(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn checked_inference_uses_the_exact_protocol_and_confirms_original_release() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_checked_inference(
            &account("owner-A"),
            selection,
            Transport::OpenAiChat,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    let (headers, body) = read(&mut socket);
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert_eq!(body["messages"], json!([]));
    assert_eq!(body["stream"], true);
    assert!(!stored_stopped(root.path()));
    let deadline = Instant::now() + Duration::from_secs(4);
    while !client.cancel_and_confirm_stop().await.unwrap() {
        assert!(
            Instant::now() < deadline,
            "original release never confirmed"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let mut byte = [0];
    assert!(matches!(socket.read(&mut byte), Ok(0)));
    assert!(stored_stopped(root.path()));
    assert!(manager.shutdown().await);
    assert!(client.cancel_and_confirm_stop().await.unwrap());
}

#[tokio::test]
async fn stop_confirmation_remains_false_until_original_durable_release_is_repaired() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let mut client = manager
        .start_owned_inference(
            &account("owner-A"),
            selection,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[]}),
        )
        .await
        .unwrap();
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    let db = actor_db(root.path());
    db.execute_batch("CREATE TRIGGER hold_stop BEFORE UPDATE OF stop_evidence_json ON provider_connection_actors BEGIN SELECT RAISE(FAIL,'synthetic stop save unavailable'); END;").unwrap();
    assert!(!client.cancel_and_confirm_stop().await.unwrap());
    let mut byte = [0];
    assert!(matches!(socket.read(&mut byte), Ok(0)));
    // FIFO traffic makes the actor attempt original stop/release while the
    // actual socket is already closed. Physical EOF alone cannot confirm it.
    manager
        .execute(&account("owner-A"), super::super::Operation::Profiles)
        .await
        .unwrap();
    assert!(!client.cancel_and_confirm_stop().await.unwrap());
    assert!(!stored_stopped(root.path()));
    db.execute_batch("DROP TRIGGER hold_stop;").unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !client.cancel_and_confirm_stop().await.unwrap() {
        assert!(
            Instant::now() < deadline,
            "original release never recovered"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(stored_stopped(root.path()));
    assert!(manager.shutdown().await);
}
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
fn once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let waker = futures_util::task::noop_waker();
    future.poll(&mut Context::from_waker(&waker))
}
fn pause(manager: &ProviderConnectionManager) -> mpsc::Sender<()> {
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    manager
        .lifetime
        .sender
        .try_send(super::super::Message::Pause {
            entered: entered_tx,
            release: release_rx,
        })
        .unwrap();
    entered.recv_timeout(Duration::from_secs(3)).unwrap();
    release
}

#[tokio::test]
async fn abandoning_a_started_reply_after_actual_dispatch_keeps_background_cleanup() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let selection = save(
        &manager,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
    )
    .await;
    let owner = account("owner-A");
    let release = pause(&manager);
    let mut future = Box::pin(manager.start_owned_inference(
        &owner,
        selection,
        REQUEST.into(),
        InferenceConsumer::Conversation,
        json!({"model":"selected"}),
    ));
    assert!(matches!(once(future.as_mut()), Poll::Pending));
    release.send(()).unwrap();
    manager
        .execute(&owner, super::super::Operation::Profiles)
        .await
        .unwrap();
    // The still-unpolled future owns the delivered Started reply. The server
    // sees real I/O before we discard that reply and its original ticket.
    let (mut socket, _) = listener.accept().unwrap();
    read(&mut socket);
    assert!(!stored_stopped(root.path()));
    drop(future);
    let mut byte = [0];
    match socket.read(&mut byte) {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        other => panic!("lost Started reply did not stop socket: {other:?}"),
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    while !stored_stopped(root.path()) {
        assert!(
            Instant::now() < deadline,
            "lost Started reply abandoned its durable cleanup"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn a_begin_future_abandoned_in_the_queue_cannot_start_provider_io() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let selection = save(&manager, &base).await;
    let owner = account("owner-A");
    let release = pause(&manager);
    let mut future = Box::pin(manager.start_owned_inference(
        &owner,
        selection,
        REQUEST.into(),
        InferenceConsumer::Conversation,
        json!({"model":"selected"}),
    ));
    assert!(matches!(once(future.as_mut()), Poll::Pending));
    drop(future);
    release.send(()).unwrap();
    manager
        .execute(&owner, super::super::Operation::Profiles)
        .await
        .unwrap();
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let path = root
        .path()
        .join("provider-connections")
        .join(hex::encode(Sha256::digest(b"owner-A")))
        .join(terminal_v4_provider_connections::storage::DATABASE_FILE);
    let db = rusqlite::Connection::open(path).unwrap();
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn abandoning_a_delivered_chunk_reply_cannot_later_report_stream_completion() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let selection = save(&manager, &base).await;
    let owner = account("owner-A");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read(&mut stream);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"text\":\"lost\"}").unwrap();
    });
    let mut client = manager
        .start_owned_inference(
            &owner,
            selection,
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected"}),
        )
        .await
        .unwrap();
    server.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !stored_stopped(root.path()) {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(matches!(
        next(&mut client).await,
        InferencePoll::Head { streaming: false }
    ));
    // The complete small body is queued after the consumed Head, and the worker
    // has already joined/released. FIFO Profiles is a barrier after the poll
    // places that next chunk into its still-live oneshot receiver.
    let release = pause(&manager);
    let mut future = Box::pin(client.poll());
    assert!(matches!(once(future.as_mut()), Poll::Pending));
    release.send(()).unwrap();
    manager
        .execute(&owner, super::super::Operation::Profiles)
        .await
        .unwrap();
    drop(future);
    assert!(matches!(
        next(&mut client).await,
        InferencePoll::Failed(
            terminal_v4_provider_connections::inference::InferenceFailure::Cancelled
        )
    ));
    drop(client);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn manager_shutdown_joins_live_inference_before_confirming_local_stop() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let selection = save(&manager, &base).await;
    let (seen_tx, seen) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read(&mut stream);
        seen_tx.send(()).unwrap();
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("socket stayed live: {other:?}"),
        }
    });
    let mut client = manager
        .start_owned_inference(
            &account("owner-A"),
            selection,
            REQUEST.into(),
            InferenceConsumer::Task,
            json!({"model":"selected"}),
        )
        .await
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(manager.shutdown().await);
    server.join().unwrap();
    assert!(stored_stopped(root.path()));
    assert!(matches!(
        client.poll().await,
        Err(ConnectionError::StorageUnavailable)
    ));
}

#[tokio::test]
async fn shared_manager_streams_bound_credentials_and_leaves_a_durable_original_stop_receipt() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/prefix/v1", listener.local_addr().unwrap());
    let selection = save(&manager, &base).await;
    let (seen_tx, seen) = mpsc::channel();
    let (done_tx, done) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        seen_tx.send(read(&mut stream)).unwrap();
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n").unwrap();
        done.recv_timeout(Duration::from_secs(4)).unwrap();
        stream.write_all(b"0\r\n\r\n").unwrap();
    });
    let mut client = manager
        .start_owned_inference(
            &account("owner-A"),
            selection.clone(),
            REQUEST.into(),
            InferenceConsumer::Conversation,
            json!({"model":"selected","messages":[{"role":"user","content":"hello"}]}),
        )
        .await
        .unwrap();
    assert_eq!(client.transport(), Transport::OpenAiChat);
    let (headers, body) = seen.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(headers.starts_with("POST /prefix/v1/chat/completions HTTP/1.1"));
    assert!(headers
        .to_lowercase()
        .contains("authorization: bearer synthetic-manager-inference-key"));
    assert_eq!(body["model"], "selected");
    assert_eq!(body["stream"], true);
    assert!(matches!(
        next(&mut client).await,
        InferencePoll::Head { streaming: true }
    ));
    assert!(matches!(next(&mut client).await,InferencePoll::Chunk(bytes) if bytes==b"hi"));
    assert!(!stored_stopped(root.path()));
    done_tx.send(()).unwrap();
    assert!(matches!(next(&mut client).await, InferencePoll::Complete));
    drop(client);
    server.join().unwrap();
    assert!(stored_stopped(root.path()));
    assert!(manager.shutdown().await);
    drop(manager);
    let reopened = ProviderConnectionManager::new(root.path()).unwrap();
    assert!(matches!(
        reopened
            .start_owned_inference(
                &account("owner-A"),
                selection,
                REQUEST.into(),
                InferenceConsumer::Conversation,
                json!({"model":"selected"})
            )
            .await,
        Err(ConnectionError::Conflict)
    ));
    assert!(reopened.shutdown().await);
}

#[tokio::test]
async fn foreign_owner_stale_revision_and_wrong_body_model_cannot_dispatch() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let selection = save(&manager, &base).await;
    assert!(matches!(
        manager
            .start_owned_inference(
                &account("owner-B"),
                selection.clone(),
                REQUEST.into(),
                InferenceConsumer::Task,
                json!({"model":"selected"})
            )
            .await,
        Err(ConnectionError::NotFound)
    ));
    let mut stale = selection.clone();
    stale.revision = "20000000-0000-4000-8000-000000000001".into();
    assert!(matches!(
        manager
            .start_owned_inference(
                &account("owner-A"),
                stale,
                REQUEST.into(),
                InferenceConsumer::Conversation,
                json!({"model":"selected"})
            )
            .await,
        Err(ConnectionError::Conflict)
    ));
    assert!(matches!(
        manager
            .start_owned_inference(
                &account("owner-A"),
                selection,
                REQUEST.into(),
                InferenceConsumer::Conversation,
                json!({"model":"different"})
            )
            .await,
        Err(ConnectionError::InvalidInput)
    ));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn dropping_a_client_stops_the_actual_socket_and_background_supervision_finishes_cleanup() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let selection = save(&manager, &base).await;
    let (seen_tx, seen) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read(&mut stream);
        seen_tx.send(()).unwrap();
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("original socket did not close: {other:?}"),
        }
    });
    let client = manager
        .start_owned_inference(
            &account("owner-A"),
            selection,
            REQUEST.into(),
            InferenceConsumer::Compaction,
            json!({"model":"selected"}),
        )
        .await
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(client);
    server.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !stored_stopped(root.path()) {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(manager.shutdown().await);
}
