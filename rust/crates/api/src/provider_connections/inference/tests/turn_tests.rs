use super::*;
use crate::provider_connections::inference::turn::{Event, Group, Target};
use crate::v4_agent::interaction::ActionScope;

fn scope() -> ActionScope {
    ActionScope {
        owner: "owner-A".into(),
        session_id: "70000000-0000-4000-8000-000000000001".into(),
        turn_id: "80000000-0000-4000-8000-000000000001".into(),
    }
}
async fn target(manager: &ProviderConnectionManager, listener: &TcpListener) -> Target {
    Target {
        manager: manager.clone(),
        account: account("owner-A"),
        selection: save(
            manager,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        )
        .await,
        transport: Transport::OpenAiChat,
    }
}
fn body() -> Value {
    json!({"model":"selected","messages":[]})
}
async fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                read(&mut stream);
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "request did not dispatch");
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            Err(error) => panic!("{error}"),
        }
    }
}
fn answer(mut stream: TcpStream) {
    let response=json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"own runtime"}}]}).to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
}
async fn eof(mut stream: TcpStream) {
    stream.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match stream.read(&mut [0; 1]) {
            Ok(0) => return,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            other => panic!("expected provider socket EOF, got {other:?}"),
        };
        assert!(Instant::now() < deadline, "provider socket remained open");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[tokio::test]
async fn turn_group_original_request_finishes_then_cleanup_joins_and_releases() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    let mut exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    assert!(!group.is_confirmed());
    answer(accept(&listener).await);
    match tokio::time::timeout(Duration::from_secs(4), exchange.next())
        .await
        .unwrap()
        .unwrap()
    {
        Event::Finished(Ok((body, false))) => {
            assert_eq!(body["choices"][0]["message"]["content"], "own runtime")
        }
        _ => panic!("missing validated completion"),
    };
    assert!(
        !group.is_confirmed(),
        "completion incorrectly discarded the original worker/client before cleanup"
    );
    group.close().await.unwrap();
    assert!(group.is_confirmed());
    let (status, fact): (String, Option<String>) = actor_db(root.path())
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "quiescent");
    assert!(fact.is_some());
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn turn_group_receiver_loss_stops_actual_http_and_retains_cleanup_until_join() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    let exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    let socket = accept(&listener).await;
    drop(exchange);
    assert!(!group.is_confirmed());
    group.close().await.unwrap();
    eof(socket).await;
    assert!(group.is_confirmed());
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn turn_group_cancelled_close_seals_registration_and_preserves_original_join_for_retry() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    let exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    let socket = accept(&listener).await;
    let release = pause(&manager);
    let mut close = Box::pin(group.close());
    assert!(matches!(once(close.as_mut()), Poll::Pending));
    drop(close);
    let rejected = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .is_err();
    assert!(!group.is_confirmed());
    release.send(()).unwrap();
    group.close().await.unwrap();
    eof(socket).await;
    drop(exchange);
    assert!(group.is_confirmed());
    assert!(manager.shutdown().await);
    assert!(rejected, "registration reopened after cancelled close");
}

#[tokio::test]
async fn turn_group_joined_worker_does_not_clear_until_exact_durable_receipt_is_repaired() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    let mut exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    answer(accept(&listener).await);
    assert!(matches!(
        exchange.next().await,
        Some(Event::Finished(Ok(_)))
    ));
    let db = actor_db(root.path());
    let original: String = db
        .query_row(
            "SELECT stop_evidence_json FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json='forged'",
        [],
    )
    .unwrap();
    let refused = group.close().await.is_err();
    let retained = !group.is_confirmed();
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json=?1",
        [original],
    )
    .unwrap();
    group.close().await.unwrap();
    assert!(group.is_confirmed());
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    assert!(manager.shutdown().await);
    assert!(
        refused && retained,
        "worker join was incorrectly treated as authenticated durable release"
    );
}

#[tokio::test]
async fn turn_group_panic_after_publication_keeps_original_client_for_cleanup() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    group.fail_worker(2);
    let mut exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(4), exchange.next())
            .await
            .unwrap()
            .is_none()
    );
    assert!(!group.is_confirmed());
    group.close().await.unwrap();
    assert!(group.is_confirmed());
    let row: (String, Option<String>) = actor_db(root.path())
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "quiescent");
    assert!(row.1.is_some());
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn turn_group_panic_without_admission_publication_remains_unconfirmed() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    group.fail_worker(1);
    let mut exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(4), exchange.next())
            .await
            .unwrap()
            .is_none()
    );
    assert!(group.close().await.is_err());
    assert!(!group.is_confirmed());
    let count: i64 = actor_db(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        group.close().await.is_err(),
        "unresolved admission became no-dispatch on retry"
    );
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn turn_group_full_text_queue_stays_bounded_and_receiver_loss_unblocks_cleanup() {
    let (_root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    let mut exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    let mut socket = accept(&listener).await;
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {}\n\n",json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"é".repeat(100_000)}}]})).unwrap();
    socket.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while exchange.buffered() < 4 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(exchange.buffered(), 4);
    match exchange.next().await.unwrap() {
        Event::Text(text) => {
            assert_eq!(text.len(), 16_384);
            assert!(text.chars().all(|c| c == 'é'));
        }
        _ => panic!("missing bounded Unicode delta"),
    };
    drop(exchange);
    group.close().await.unwrap();
    eof(socket).await;
    assert!(group.is_confirmed());
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn turn_group_retried_logical_request_reuses_identity_and_cannot_duplicate_dispatch() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let first = Group::default();
    let mut exchange = first
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    answer(accept(&listener).await);
    assert!(matches!(
        exchange.next().await,
        Some(Event::Finished(Ok(_)))
    ));
    first.close().await.unwrap();
    drop(exchange);
    let retry = Group::default();
    let mut exchange = retry
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    assert!(matches!(
        exchange.next().await,
        Some(Event::Finished(Err(_)))
    ));
    retry.close().await.unwrap();
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let count: i64 = actor_db(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn turn_group_concurrent_close_takes_fresh_state_after_the_first_acknowledgement() {
    let (root, manager) = setup();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&manager, &listener).await;
    let group = Group::default();
    let exchange = group
        .start(&target, &scope(), InferenceConsumer::Conversation, body())
        .unwrap();
    let socket = accept(&listener).await;
    let release = pause(&manager);
    let mut first = Box::pin(group.close());
    assert!(matches!(once(first.as_mut()), Poll::Pending));
    let mut second = Box::pin(group.close());
    assert!(matches!(once(second.as_mut()), Poll::Pending));
    release.send(()).unwrap();
    first.await.unwrap();
    eof(socket).await;
    assert!(group.is_confirmed());
    let db = actor_db(root.path());
    let original: String = db
        .query_row(
            "SELECT stop_evidence_json FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json='forged-after-acknowledgement'",
        [],
    )
    .unwrap();
    let idempotent = second.await.is_ok();
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json=?1",
        [original],
    )
    .unwrap();
    drop(exchange);
    assert!(manager.shutdown().await);
    assert!(
        idempotent,
        "a concurrent closer used a stale original-client snapshot after final acknowledgement"
    );
}
