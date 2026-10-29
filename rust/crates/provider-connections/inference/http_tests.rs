use super::*;
use crate::fixtures::{OPERATION, PROFILE, REQUEST};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    sync::mpsc,
    time::{Duration, Instant},
};
const NEXT_OPERATION: &str = "80000000-0000-4000-8000-000000000002";

fn service() -> (tempfile::TempDir, ConnectionService) {
    let root = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let service =
        ConnectionService::open_for_authenticated_execution(root.path(), "owner-A", "server-A")
            .unwrap();
    (root, service)
}
fn input(base: &str, lm: bool, bearer: bool) -> Value {
    json!({"operationId":OPERATION,"expectedRevision":null,"provider":if lm{"lmstudio"}else{"actual"},"mode":"local","baseUrl":base,"clusterId":if lm{None}else{Some("cluster-own")},"auth":if bearer{json!({"type":"bearer","credentialAction":"replace","secret":"synthetic-inference-token"})}else{json!({"type":"none"})}})
}
fn plan(service: &mut ConnectionService, base: &str, lm: bool, bearer: bool) -> InferencePlan {
    let saved = service.put(PROFILE, &input(base, lm, bearer)).unwrap();
    service
        .prepare_inference(
            PROFILE,
            saved["savedRevision"].as_str().unwrap(),
            "selected",
        )
        .unwrap()
}
pub(super) fn read_request(stream: &mut TcpStream) -> (String, Value) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = vec![];
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 16_384);
    }
    let header = String::from_utf8(bytes).unwrap();
    let length = header
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    assert!(length < 24_000_000);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (header, serde_json::from_slice(&body).unwrap())
}
pub(super) fn listener() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/prefix/v1", listener.local_addr().unwrap());
    (listener, base)
}
fn terminal(service: &mut ConnectionService, ticket: &InferenceTicket) -> InferencePoll {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let poll = service.poll_inference(ticket).unwrap();
        if matches!(poll, InferencePoll::Complete | InferencePoll::Failed(_)) {
            return poll;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn state(root: &std::path::Path) -> Vec<(String, Option<String>)> {
    let db = rusqlite::Connection::open(root.join(storage::DATABASE_FILE)).unwrap();
    let mut q = db
        .prepare("SELECT status,stop_evidence_json FROM provider_connection_actors")
        .unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

#[test]
fn authenticated_preparation_is_inert_and_a_stale_revision_never_starts_a_request() {
    let (_root, mut service) = service();
    let plan = plan(&mut service, "http://127.0.0.1:9/v1", false, false);
    assert_eq!(plan.model(), "selected");
    assert!(matches!(
        service.prepare_inference(PROFILE, "20000000-0000-4000-8000-000000000001", "selected"),
        Err(ConnectionError::Conflict)
    ));
    assert!(matches!(
        service.start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"other"})
        ),
        Err(ConnectionError::InvalidInput)
    ));
    assert!(service.tick(1).unwrap().cleanup_confirmed);
}

#[test]
fn both_transports_stream_before_completion_with_exact_routes_auth_and_bodies() {
    for (lm, bearer) in [(false, false), (true, true)] {
        let (root, mut service) = service();
        let (server, base) = listener();
        let plan = plan(&mut service, &base, lm, bearer);
        let (observed_tx, observed) = mpsc::channel();
        let (finish_tx, finish) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let request = read_request(&mut stream);
            observed_tx.send(request).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n").unwrap();
            finish.recv_timeout(Duration::from_secs(4)).unwrap();
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        let body = if lm {
            json!({"model":"selected","messages":[{"role":"user","content":"hello"}]})
        } else {
            json!({"model":"selected","input":[{"role":"user","content":"hello"}]})
        };
        let ticket = service
            .start_inference(&plan, REQUEST, InferenceConsumer::Conversation, &body)
            .unwrap();
        let (header, sent) = observed.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(header.starts_with(if lm {
            "POST /prefix/v1/chat/completions HTTP/1.1"
        } else {
            "POST /prefix/v1/responses HTTP/1.1"
        }));
        assert_eq!(
            header
                .to_lowercase()
                .contains("authorization: bearer synthetic-inference-token"),
            bearer
        );
        assert_eq!(
            header.to_lowercase().contains("x-cluster-id: cluster-own"),
            !lm
        );
        let mut expected = body;
        expected["stream"] = json!(true);
        assert_eq!(sent, expected);
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut head = false;
        let mut chunk = vec![];
        while chunk.is_empty() {
            match service.poll_inference(&ticket).unwrap() {
                InferencePoll::Pending => {}
                InferencePoll::Head { streaming } => {
                    assert!(streaming);
                    head = true;
                }
                InferencePoll::Chunk(bytes) => chunk.extend(bytes),
                _ => panic!("ended before held response"),
            };
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(head);
        assert_eq!(chunk, b"first");
        assert!(!service.tick(1).unwrap().local_resources_stopped);
        finish_tx.send(()).unwrap();
        assert!(matches!(
            terminal(&mut service, &ticket),
            InferencePoll::Complete
        ));
        worker.join().unwrap();
        let rows = state(root.path());
        assert_eq!(rows.len(), 1);
        assert!(rows
            .iter()
            .all(|(status, fact)| status == "quiescent" && fact.is_some()));
        assert!(service.tick(2).unwrap().cleanup_confirmed);
    }
}

fn held() -> (
    TcpListener,
    String,
    mpsc::Sender<()>,
    mpsc::Receiver<()>,
    std::thread::JoinHandle<()>,
) {
    let (server, base) = listener();
    let duplicate = server.try_clone().unwrap();
    let (seen_tx, seen) = mpsc::channel();
    let (hold_tx, hold) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        read_request(&mut stream);
        seen_tx.send(()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("original socket did not close: {other:?}"),
        };
        let _ = hold.recv_timeout(Duration::from_secs(3));
    });
    (duplicate, base, hold_tx, seen, worker)
}
#[test]
fn cancellation_joins_the_original_socket_owner_and_persists_a_real_stop_fact() {
    let (root, mut service) = service();
    let (_listener, base, release, seen, worker) = held();
    let plan = plan(&mut service, &base, false, false);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Cli,
            &json!({"model":"selected","input":"hello"}),
        )
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(matches!(
        service.cancel_inference(&ticket).unwrap(),
        InferencePoll::Pending | InferencePoll::Failed(InferenceFailure::Cancelled)
    ));
    assert!(matches!(
        terminal(&mut service, &ticket),
        InferencePoll::Failed(InferenceFailure::Cancelled)
    ));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert!(state(root.path())
        .iter()
        .all(|(s, f)| s == "quiescent" && f.is_some()));
}
#[test]
fn replacing_a_profile_revokes_held_inference_and_new_settings_wait_for_its_stop() {
    let (root, mut service) = service();
    let (_listener, base, release, seen, worker) = held();
    let plan = plan(&mut service, &base, false, false);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Compaction,
            &json!({"model":"selected","input":"hello"}),
        )
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    let mut changed = input(&base, false, false);
    changed["operationId"] = json!(NEXT_OPERATION);
    changed["expectedRevision"] = json!(plan.snapshot.reference.revision);
    let saved = service.put(PROFILE, &changed).unwrap();
    assert_eq!(saved["cleanupConfirmed"], false);
    assert!(matches!(
        terminal(&mut service, &ticket),
        InferencePoll::Failed(InferenceFailure::ConfigurationChanged)
    ));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert!(service.tick(2).unwrap().cleanup_confirmed);
    assert_eq!(
        service.operation(PROFILE, NEXT_OPERATION).unwrap()["cleanupConfirmed"],
        true
    );
    assert!(matches!(
        service.start_inference(
            &plan,
            "70000000-0000-4000-8000-000000000002",
            InferenceConsumer::Task,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::Conflict)
    ));
    assert!(state(root.path())
        .iter()
        .all(|(s, f)| s == "quiescent" && f.is_some()));
}
#[test]
fn a_plan_and_ticket_cannot_be_rebound_to_another_authenticated_service() {
    let (_root, mut first) = service();
    let mut second =
        ConnectionService::open_for_authenticated_execution(_root.path(), "owner-B", "server-A")
            .unwrap();
    let plan = plan(&mut first, "http://127.0.0.1:9/v1", false, false);
    assert!(matches!(
        second.start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Task,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::NotFound | ConnectionError::Conflict)
    ));
    let ticket = first
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Task,
            &json!({"model":"selected"}),
        )
        .unwrap();
    assert!(matches!(
        second.poll_inference(&ticket),
        Err(ConnectionError::NotFound)
    ));
    assert!(matches!(
        terminal(&mut first, &ticket),
        InferencePoll::Failed(InferenceFailure::Transport)
    ));
}

#[test]
fn eight_live_requests_bound_admission_and_shutdown_drains_every_socket() {
    let (root, mut service) = service();
    let (server, base) = listener();
    let plan = plan(&mut service, &base, false, false);
    let (seen_tx, seen) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut streams = vec![];
        for _ in 0..8 {
            let (mut stream, _) = server.accept().unwrap();
            read_request(&mut stream);
            streams.push(stream);
            seen_tx.send(()).unwrap();
        }
        for mut stream in streams {
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut byte = [0];
            match stream.read(&mut byte) {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                other => panic!("request stayed live: {other:?}"),
            }
        }
    });
    let mut tickets = vec![];
    for n in 1..=8 {
        let request = format!("70000000-0000-4000-8000-{n:012}");
        tickets.push(
            service
                .start_inference(
                    &plan,
                    &request,
                    InferenceConsumer::Task,
                    &json!({"model":"selected"}),
                )
                .unwrap(),
        );
        seen.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    let ninth = service.start_inference(
        &plan,
        "70000000-0000-4000-8000-000000000009",
        InferenceConsumer::Task,
        &json!({"model":"selected"}),
    );
    service.request_shutdown(1).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !service.tick(2).unwrap().local_resources_stopped {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    worker.join().unwrap();
    assert!(matches!(ninth, Err(ConnectionError::CapacityReached)));
    assert_eq!(state(root.path()).len(), 8);
    assert!(state(root.path())
        .iter()
        .all(|(s, f)| s == "quiescent" && f.is_some()));
}
#[test]
fn dropping_the_only_ticket_is_cancellation_owned_by_background_tick() {
    let (root, mut service) = service();
    let (_listener, base, release, seen, worker) = held();
    let plan = plan(&mut service, &base, false, false);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Task,
            &json!({"model":"selected"}),
        )
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(ticket);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !service.tick(1).unwrap().local_resources_stopped {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    release.send(()).unwrap();
    worker.join().unwrap();
    assert!(state(root.path())
        .iter()
        .all(|(s, f)| s == "quiescent" && f.is_some()));
}

#[test]
fn a_storage_read_failure_stops_io_without_claiming_durable_cleanup() {
    let (root, mut service) = service();
    let (_listener, base, release, seen, worker) = held();
    let plan = plan(&mut service, &base, false, false);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"}),
        )
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    db.execute_batch(
        "ALTER TABLE provider_connection_profiles RENAME TO temporarily_unavailable_profiles;",
    )
    .unwrap();
    assert!(matches!(
        service.poll_inference(&ticket),
        Err(ConnectionError::StorageUnavailable)
    ));
    // The fixture thread returns only after EOF/reset; a read timeout is a failure.
    release.send(()).unwrap();
    worker.join().unwrap();
    db.execute_batch(
        "ALTER TABLE temporarily_unavailable_profiles RENAME TO provider_connection_profiles;",
    )
    .unwrap();
    assert!(matches!(
        terminal(&mut service, &ticket),
        InferencePoll::Failed(InferenceFailure::Cancelled)
    ));
    assert!(service.tick(1).unwrap().cleanup_confirmed);
}

#[test]
fn a_failed_stop_fact_write_keeps_the_original_proof_and_response_for_retry() {
    let (root, mut service) = service();
    let (server, base) = listener();
    let plan = plan(&mut service, &base, true, false);
    let (ready_tx, ready) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        read_request(&mut stream);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"answer\":\"ok\"}").unwrap();
        ready_tx.send(()).unwrap();
    });
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    db.execute_batch("CREATE TRIGGER refuse_inference_stop BEFORE UPDATE OF stop_evidence_json ON provider_connection_actors BEGIN SELECT RAISE(ABORT,'synthetic unavailable'); END;").unwrap();
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"}),
        )
        .unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    worker.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if matches!(service.tick(1), Err(ConnectionError::StorageUnavailable)) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(state(root.path())
        .iter()
        .all(|(status, fact)| status != "quiescent" && fact.is_none()));
    assert!(matches!(
        service.poll_inference(&ticket),
        Err(ConnectionError::StorageUnavailable)
    ));
    db.execute_batch("DROP TRIGGER refuse_inference_stop;")
        .unwrap();
    assert!(service.tick(2).unwrap().cleanup_confirmed);
    let mut bytes = vec![];
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(Instant::now() < deadline);
        match service.poll_inference(&ticket).unwrap() {
            InferencePoll::Chunk(part) => bytes.extend(part),
            InferencePoll::Head { streaming } => assert!(!streaming),
            InferencePoll::Complete => break,
            InferencePoll::Pending => {}
            InferencePoll::Failed(reason) => panic!("retry lost result: {reason:?}"),
        }
    }
    assert_eq!(bytes, b"{\"answer\":\"ok\"}");
    assert!(state(root.path())
        .iter()
        .all(|(status, fact)| status == "quiescent" && fact.is_some()));
}

#[test]
fn redirects_http_errors_content_type_and_size_fail_without_exposing_response_bodies() {
    for (response,expected) in [
        ("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:9/stolen\r\nContent-Length: 0\r\n\r\n",InferenceFailure::HttpStatus(307)),
        ("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 8\r\n\r\nsecret!!",InferenceFailure::HttpStatus(401)),
        ("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 8\r\n\r\nsecret!!",InferenceFailure::ContentType),
        ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8000001\r\n\r\n",InferenceFailure::ResponseTooLarge),
    ] {
        let (_root,mut service)=service(); let (server,base)=listener();let plan=plan(&mut service,&base,true,true);
        let worker=std::thread::spawn(move||{let(mut stream,_)=server.accept().unwrap();read_request(&mut stream);stream.write_all(response.as_bytes()).unwrap();});
        let ticket=service.start_inference(&plan,REQUEST,InferenceConsumer::Task,&json!({"model":"selected"})).unwrap();
        assert!(matches!(terminal(&mut service,&ticket),InferencePoll::Failed(reason) if reason==expected));worker.join().unwrap();
    }
}

#[test]
fn explicit_shutdown_stops_held_inference_and_reopening_does_not_reissue_it() {
    let (root, mut service) = service();
    let (listener, base, release, seen, worker) = held();
    let plan = plan(&mut service, &base, false, false);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Task,
            &json!({"model":"selected"}),
        )
        .unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    service.request_shutdown(1).unwrap();
    assert!(matches!(
        service.start_inference(
            &plan,
            "70000000-0000-4000-8000-000000000003",
            InferenceConsumer::Task,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::CleanupPending)
    ));
    assert!(matches!(
        terminal(&mut service, &ticket),
        InferencePoll::Failed(InferenceFailure::Cancelled)
    ));
    release.send(()).unwrap();
    worker.join().unwrap();
    drop(ticket);
    drop(service);
    let mut reopened =
        ConnectionService::open_for_authenticated_execution(root.path(), "owner-A", "server-A")
            .unwrap();
    assert!(reopened.tick(2).unwrap().cleanup_confirmed);
    let replay = reopened.start_inference(
        &plan,
        REQUEST,
        InferenceConsumer::Task,
        &json!({"model":"selected"}),
    );
    let rejected = matches!(&replay, Err(ConnectionError::Conflict));
    if let Ok(ticket) = replay {
        reopened.cancel_inference(&ticket).unwrap();
        terminal(&mut reopened, &ticket);
    }
    assert!(
        rejected,
        "a retained request must not dispatch twice after restart"
    );
    listener.set_nonblocking(true).unwrap();
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
}

#[test]
fn chunked_response_byte_limits_apply_to_actual_bytes_with_and_without_streaming() {
    for (streaming, limit) in [(true, 16_000_000usize), (false, 8_000_000usize)] {
        for excess in [0, 1] {
            let (_root, mut service) = service();
            let (server, base) = listener();
            let plan = plan(&mut service, &base, true, false);
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = server.accept().unwrap();
                read_request(&mut stream);
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",if streaming{"text/event-stream"}else{"application/json"}).unwrap();
                let part = vec![b'x'; 32_768];
                let mut remaining = limit + excess;
                while remaining > 0 {
                    let count = remaining.min(part.len());
                    if write!(stream, "{count:x}\r\n")
                        .and_then(|_| stream.write_all(&part[..count]))
                        .and_then(|_| stream.write_all(b"\r\n"))
                        .is_err()
                    {
                        return;
                    }
                    remaining -= count;
                }
                let _ = stream.write_all(b"0\r\n\r\n");
            });
            let ticket = service
                .start_inference(
                    &plan,
                    REQUEST,
                    InferenceConsumer::Conversation,
                    &json!({"model":"selected"}),
                )
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut bytes = 0;
            let mut heads = 0;
            let terminal = loop {
                assert!(Instant::now() < deadline);
                match service.poll_inference(&ticket).unwrap() {
                    InferencePoll::Head { streaming: actual } => {
                        assert_eq!(actual, streaming);
                        heads += 1;
                    }
                    InferencePoll::Chunk(part) => {
                        assert!(part.len() <= 65_536);
                        bytes += part.len();
                        assert!(bytes <= limit);
                    }
                    InferencePoll::Pending => std::thread::sleep(Duration::from_millis(1)),
                    result => break result,
                }
            };
            if excess == 0 {
                assert!(matches!(terminal, InferencePoll::Complete));
                assert_eq!(bytes, limit);
                assert_eq!(heads, 1);
            } else {
                assert!(matches!(
                    terminal,
                    InferencePoll::Failed(InferenceFailure::ResponseTooLarge)
                ));
            }
            worker.join().unwrap();
            assert!(service.tick(1).unwrap().cleanup_confirmed);
        }
    }
}
