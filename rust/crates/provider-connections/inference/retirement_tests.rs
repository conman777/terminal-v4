use super::*;
use crate::fixtures::{OPERATION, PROFILE, REQUEST};
use crate::inference::http_tests::{listener, read_request};
use serde_json::json;
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::atomic::AtomicUsize,
    thread::JoinHandle,
    time::{Duration, Instant},
};

fn root() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
fn open(root: &Path) -> ConnectionService {
    ConnectionService::open_for_authenticated_execution(root, "owner-A", "server-A").unwrap()
}
fn plan(service: &mut ConnectionService, base: &str) -> InferencePlan {
    let saved=service.put(PROFILE,&json!({"operationId":OPERATION,"expectedRevision":null,"provider":"lmstudio","mode":"local","baseUrl":base,"auth":{"type":"none"}})).unwrap();
    service
        .prepare_inference(
            PROFILE,
            saved["savedRevision"].as_str().unwrap(),
            "selected",
        )
        .unwrap()
}
struct Server {
    base: String,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let (listener, base) = listener();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let own_stop = stop.clone();
        let own_requests = requests.clone();
        let worker = std::thread::spawn(move || {
            while !own_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        read_request(&mut stream);
                        own_requests.fetch_add(1, Ordering::AcqRel);
                        let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(error) => panic!("{error:?}"),
                }
            }
        });
        Self {
            base,
            stop,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let result = self.worker.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}
fn complete(service: &mut ConnectionService, ticket: &InferenceTicket) {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match service.poll_inference(ticket).unwrap() {
            InferencePoll::Complete => return,
            InferencePoll::Failed(reason) => panic!("{reason:?}"),
            _ => {}
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn sql(root: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(root.join(storage::DATABASE_FILE)).unwrap()
}

#[test]
fn retained_admission_returns_original_failed_http_ticket_until_caller_releases_it() {
    use std::io::Read;
    let root = root();
    let (listener, base) = listener();
    listener.set_nonblocking(true).unwrap();
    let mut service = open(root.path());
    let plan = plan(&mut service, &base);
    let db = sql(root.path());
    db.execute_batch("CREATE TRIGGER fail_retained_started BEFORE UPDATE OF started ON provider_connection_actors WHEN NEW.started=1 BEGIN SELECT RAISE(ABORT,'synthetic started status failure'); END;").unwrap();
    let failure = service
        .start_inference_retained(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"}),
        )
        .err()
        .expect("status save must fail");
    let (error, disposition) = failure.into_parts();
    assert_eq!(error, ConnectionError::StorageUnavailable);
    let ticket = match disposition {
        InferenceStartDisposition::Owned(ticket) => ticket,
        _ => panic!("actual failed admission lost its original ticket"),
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("{error:?}"),
        }
    };
    socket.set_nonblocking(false).unwrap();
    let (headers, body) = read_request(&mut socket);
    assert!(headers.starts_with("POST /prefix/v1/chat/completions HTTP/1.1"));
    assert_eq!(body["model"], "selected");
    assert!(!service.inference_released(&ticket).unwrap());
    while !service.inference_released(&ticket).unwrap() {
        service.cancel_inference(&ticket).unwrap();
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut byte = [0];
    match socket.read(&mut byte) {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        other => panic!("original socket stayed live: {other:?}"),
    }
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 0,
            retained_requests: 1
        }
    );
    let row: (String, Option<String>) = db
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors WHERE request_id=?1",
            [REQUEST],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "quiescent");
    assert!(row.1.is_some());
    drop(ticket);
    service.tick(10).unwrap();
    assert_eq!(service.inference_usage().retained_requests, 0);
}

#[test]
fn retained_admission_invalid_body_is_proven_no_dispatch_without_an_actor() {
    let root = root();
    let (listener, base) = listener();
    listener.set_nonblocking(true).unwrap();
    let mut service = open(root.path());
    let plan = plan(&mut service, &base);
    let failure = service
        .start_inference_retained(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"wrong"}),
        )
        .err()
        .unwrap();
    let (error, disposition) = failure.into_parts();
    assert_eq!(error, ConnectionError::InvalidInput);
    assert!(matches!(disposition, InferenceStartDisposition::NoDispatch));
    assert!(matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock));
    let count: i64 = sql(root.path())
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn retained_admission_success_keeps_original_normal_response_behavior() {
    let root = root();
    let server = Server::new();
    let mut service = open(root.path());
    let plan = plan(&mut service, &server.base);
    let ticket = service
        .start_inference_retained(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"}),
        )
        .unwrap();
    complete(&mut service, &ticket);
    assert!(service.inference_released(&ticket).unwrap());
    assert_eq!(server.requests.load(Ordering::Acquire), 1);
    drop(ticket);
    service.tick(10).unwrap();
    assert_eq!(service.inference_usage().retained_requests, 0);
}

#[test]
fn legacy_failed_admission_cancels_and_retires_only_after_original_release() {
    use std::io::Read;
    let root = root();
    let (listener, base) = listener();
    listener.set_nonblocking(true).unwrap();
    let mut service = open(root.path());
    let plan = plan(&mut service, &base);
    let db = sql(root.path());
    db.execute_batch("CREATE TRIGGER fail_started_status BEFORE UPDATE OF started ON provider_connection_actors WHEN NEW.started=1 BEGIN SELECT RAISE(ABORT,'synthetic started status failure'); END;").unwrap();
    assert!(matches!(
        service.start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::StorageUnavailable)
    ));
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 1,
            retained_requests: 1
        }
    );
    let status: String = db
        .query_row(
            "SELECT status FROM provider_connection_actors WHERE request_id=?1",
            [REQUEST],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(status, "quiescent");
    // Discarding the legacy failure cancels I/O immediately. Delivery may be
    // absent or partial; it never constitutes a no-dispatch acknowledgement.
    let deadline = Instant::now() + Duration::from_secs(4);
    while service.inference_usage().retained_requests != 0 {
        service.tick(10).unwrap();
        assert!(
            Instant::now() < deadline,
            "failed admission lost original retirement proof"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 0,
            retained_requests: 0
        }
    );
    let mut connections = 0;
    loop {
        match listener.accept() {
            Ok((mut socket, _)) => {
                connections += 1;
                assert!(
                    connections <= 1,
                    "failed admission repeated original HTTP work"
                );
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(4)))
                    .unwrap();
                let mut delivered = 0;
                loop {
                    match socket.read(&mut [0; 4096]) {
                        Ok(0) => break,
                        Ok(bytes) => {
                            delivered += bytes;
                            assert!(delivered <= 16384);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                        other => panic!("original joined socket did not close: {other:?}"),
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("{error:?}"),
        }
    }
    let row: (String, Option<String>) = db
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors WHERE request_id=?1",
            [REQUEST],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "quiescent");
    assert!(row.1.is_some());
    db.execute_batch("DROP TRIGGER fail_started_status;")
        .unwrap();
    drop(service);
    let mut reopened = open(root.path());
    assert!(matches!(
        reopened.start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::Conflict)
    ));
}

#[test]
fn last_ticket_drop_retires_memory_after_join_while_the_replay_receipt_survives_restart() {
    let root = root();
    let server = Server::new();
    let mut service = open(root.path());
    let plan = plan(&mut service, &server.base);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"}),
        )
        .unwrap();
    complete(&mut service, &ticket);
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 0,
            retained_requests: 1
        }
    );
    drop(ticket);
    assert!(service.tick(1).unwrap().local_resources_stopped);
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 0,
            retained_requests: 0
        }
    );
    let row: (String, Option<String>) = sql(root.path())
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "quiescent");
    assert!(row.1.is_some());
    assert!(matches!(
        service.start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::Conflict)
    ));
    drop(service);
    let mut loaded = open(root.path());
    assert!(matches!(
        loaded.start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::Conflict)
    ));
    assert_eq!(server.requests.load(Ordering::Acquire), 1);
}

#[test]
fn more_than128_completed_calls_reuse_memory_without_erasing_original_receipts() {
    let root = root();
    let server = Server::new();
    let mut service = open(root.path());
    let plan = plan(&mut service, &server.base);
    for n in 1..=140 {
        let request = format!("70000000-0000-4000-8000-{n:012}");
        let ticket = service
            .start_inference(
                &plan,
                &request,
                InferenceConsumer::Cli,
                &json!({"model":"selected"}),
            )
            .unwrap();
        complete(&mut service, &ticket);
        drop(ticket);
        service.tick(n).unwrap();
        assert_eq!(
            service.inference_usage(),
            InferenceUsage {
                unreleased_requests: 0,
                retained_requests: 0
            }
        );
    }
    assert_eq!(server.requests.load(Ordering::Acquire), 140);
    let count:i64=sql(root.path()).query_row("SELECT COUNT(*) FROM provider_connection_actors WHERE status='quiescent' AND stop_evidence_json IS NOT NULL",[],|row|row.get(0)).unwrap();
    assert_eq!(count, 140);
}

#[test]
fn a_dropped_ticket_cannot_erase_an_original_proof_whose_durable_write_is_failing() {
    let root = root();
    let server = Server::new();
    let mut service = open(root.path());
    let plan = plan(&mut service, &server.base);
    let db = sql(root.path());
    db.execute_batch("CREATE TRIGGER refuse_retired_stop BEFORE UPDATE OF stop_evidence_json ON provider_connection_actors BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Task,
            &json!({"model":"selected"}),
        )
        .unwrap();
    let connected = Instant::now() + Duration::from_secs(3);
    while server.requests.load(Ordering::Acquire) == 0 {
        assert!(Instant::now() < connected);
        std::thread::sleep(Duration::from_millis(1));
    }
    drop(ticket);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if matches!(service.tick(1), Err(ConnectionError::StorageUnavailable)) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 1,
            retained_requests: 1
        }
    );
    db.execute_batch("DROP TRIGGER refuse_retired_stop;")
        .unwrap();
    assert!(service.tick(2).unwrap().local_resources_stopped);
    assert_eq!(
        service.inference_usage(),
        InferenceUsage {
            unreleased_requests: 0,
            retained_requests: 0
        }
    );
    let row: (String, Option<String>) = db
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "quiescent");
    assert!(row.1.is_some());
}

#[test]
fn scoped_durable_actor_quota_blocks_before_dispatch_and_does_not_reset_on_reopen() {
    let root = root();
    let server = Server::new();
    let mut service = open(root.path());
    let plan = plan(&mut service, &server.base);
    let ticket = service
        .start_inference(
            &plan,
            REQUEST,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"}),
        )
        .unwrap();
    complete(&mut service, &ticket);
    drop(ticket);
    service.tick(1).unwrap();
    let db = sql(root.path());
    db.execute_batch("WITH RECURSIVE ids(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM ids WHERE n<4095) INSERT INTO provider_connection_actors(owner_id,environment_id,profile_id,actor_id,process_instance_id,lease_id,config_revision,credential_generation,reference_json,request_id,consumer_kind,admission_generation,started,stop_evidence_json,status,revocation_operation_id) SELECT owner_id,environment_id,profile_id,printf('b0000000-0000-4000-8000-%012d',n),process_instance_id,printf('c0000000-0000-4000-8000-%012d',n),config_revision,credential_generation,reference_json,printf('d0000000-0000-4000-8000-%012d',n),consumer_kind,admission_generation,0,NULL,'registered_unstarted',NULL FROM (SELECT * FROM provider_connection_actors LIMIT 1),ids;").unwrap();
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 4095);
    let final_ticket = service
        .start_inference(
            &plan,
            "90000000-0000-4000-8000-000000000001",
            InferenceConsumer::Task,
            &json!({"model":"selected"}),
        )
        .unwrap();
    complete(&mut service, &final_ticket);
    drop(final_ticket);
    service.tick(2).unwrap();
    let full: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(full, 4096);
    let request = "90000000-0000-4000-8000-000000000002";
    let result = service.start_inference(
        &plan,
        request,
        InferenceConsumer::Conversation,
        &json!({"model":"selected"}),
    );
    let blocked = matches!(&result, Err(ConnectionError::CapacityReached));
    if let Ok(ticket) = result {
        service.cancel_inference(&ticket).unwrap();
        drop(ticket);
        let _ = service.tick(2);
    }
    assert!(blocked);
    assert_eq!(server.requests.load(Ordering::Acquire), 2);
    drop(service);
    let mut loaded = open(root.path());
    assert!(matches!(
        loaded.start_inference(
            &plan,
            request,
            InferenceConsumer::Conversation,
            &json!({"model":"selected"})
        ),
        Err(ConnectionError::CapacityReached)
    ));
    let remaining: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 4096);
}
