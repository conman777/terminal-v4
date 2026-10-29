use super::*;
use crate::{fixtures::*, leases::*, *};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Instant,
};
const MODELS: &str = r#"{"data":[{"id":"own-synthetic-model"}]}"#;
struct Fixture {
    base: String,
    seen: mpsc::Receiver<String>,
    release: Option<mpsc::Sender<()>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<usize>>,
    body: Arc<std::sync::Mutex<String>>,
}
impl Fixture {
    fn new(body: impl Into<String>, held: bool) -> Self {
        Self::with_lifetime(body, held, Duration::from_secs(8))
    }
    fn with_lifetime(body: impl Into<String>, held: bool, lifetime: Duration) -> Self {
        let body = Arc::new(std::sync::Mutex::new(body.into()));
        let response_body = body.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (send_seen, seen) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + lifetime;
            let mut requests = 0;
            while !stopping.load(Ordering::Acquire) && Instant::now() < deadline {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("Fixture accept: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = vec![];
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 16_384);
                }
                requests += 1;
                send_seen.send(String::from_utf8(request).unwrap()).unwrap();
                if held {
                    stream.write_all(b"HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nContent-Length: 999\r\nConnection: close\r\n\r\n{").unwrap();
                    let _ = wait.recv_timeout(Duration::from_secs(5));
                } else {
                    let body = response_body.lock().unwrap().clone();
                    let response = format!("HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    stream.write_all(response.as_bytes()).unwrap();
                }
            }
            requests
        });
        Self {
            base,
            seen,
            release: Some(release),
            stop,
            thread: Some(thread),
            body,
        }
    }
    fn set_body(&self, body: &str) {
        *self.body.lock().unwrap() = body.into();
    }
    fn reached(&self) -> String {
        self.seen.recv_timeout(Duration::from_secs(3)).unwrap()
    }
    fn finish(mut self) -> usize {
        self.stop.store(true, Ordering::Release);
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        self.thread.take().unwrap().join().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn service(base: &str) -> (tempfile::TempDir, HttpDiscoveryService) {
    let root = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let mut service = HttpDiscoveryService::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.base_url = base.into();
    let mut save = ids();
    save.revision = REVISION.into();
    service.configure(ConfigMutation::Put(put), save).unwrap();
    (root, service)
}
fn begin(service: &mut HttpDiscoveryService) -> Value {
    service
        .begin(PROFILE, REQUEST, Duration::from_secs(2), 10)
        .unwrap()
}
fn settled(service: &mut HttpDiscoveryService, request: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match service.poll(request, 20) {
            Ok(job)
                if matches!(
                    job["status"].as_str(),
                    Some("succeeded" | "empty" | "failed" | "stale" | "cancelled")
                ) && job["cleanupPending"] == false =>
            {
                return job
            }
            Ok(_) | Err(DrainError::Lease(LeaseError::ResourceStopPending)) => {}
            other => panic!("Unexpected poll: {other:?}"),
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn actual_http_catalog_publishes_only_after_join_and_never_claims_inference() {
    let fixture = Fixture::new(MODELS, false);
    let (_root, mut service) = service(&fixture.base);
    let queued = begin(&mut service);
    assert_eq!(queued["status"], "running");
    assert!(queued["models"].is_null());
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["status"], "succeeded");
    assert_eq!(job["models"][0]["id"], "own-synthetic-model");
    assert_eq!(job["receipt"]["inferenceVerified"], false);
    assert_eq!(job["receipt"]["requestCount"], 1);
    assert!(job["models"][0]["imageInput"].is_null());
    assert!(job["models"][0]["contextWindow"].is_null());
    assert_eq!(service.poll(REQUEST, 99).unwrap(), job);
    assert_eq!(fixture.finish(), 1);
}

#[test]
fn published_inventory_is_current_scoped_historical_metadata_after_restart_without_dispatch() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut service) = service(&fixture.base);
    assert_eq!(
        service.profiles_with_published_inventory().unwrap()[0]["modelInventory"],
        Value::Null
    );
    assert!(fixture.seen.try_recv().is_err());
    begin(&mut service);
    assert_eq!(settled(&mut service, REQUEST)["status"], "succeeded");
    let published = service.profiles_with_published_inventory().unwrap();
    assert_eq!(
        published[0]["modelInventory"]["models"][0]["id"],
        "own-synthetic-model"
    );
    assert_eq!(
        published[0]["modelInventory"]["receipt"]["inferenceVerified"],
        false
    );
    assert!(service.profiles().unwrap()[0]
        .get("modelInventory")
        .is_none());
    assert_eq!(
        fixture.reached().lines().next().unwrap(),
        "GET /v1/models HTTP/1.1"
    );
    drop(service);
    let mut loaded = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        1000,
    )
    .unwrap();
    assert_eq!(
        loaded.profiles_with_published_inventory().unwrap(),
        published
    );
    assert!(loaded.owner.entries.is_empty());
    assert!(loaded.exchanges.is_empty());
    let mut other_scope = scope();
    other_scope.owner_id = "other-owner".into();
    let mut other = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(other_scope),
        1001,
    )
    .unwrap();
    assert_eq!(
        other.profiles_with_published_inventory().unwrap(),
        serde_json::json!([])
    );
    assert_eq!(fixture.finish(), 1);
}

#[test]
fn published_inventory_excludes_unfinished_cleanup_and_old_revisions() {
    let fixture = Fixture::new(MODELS, true);
    let (_root, mut service) = service(&fixture.base);
    begin(&mut service);
    fixture.reached();
    assert_eq!(
        service.profiles_with_published_inventory().unwrap()[0]["modelInventory"],
        Value::Null
    );
    service.cancel(PROFILE, REQUEST, 11).unwrap();
    assert_eq!(
        service.profiles_with_published_inventory().unwrap()[0]["modelInventory"],
        Value::Null
    );
    assert_eq!(settled(&mut service, REQUEST)["status"], "cancelled");
    assert_eq!(fixture.finish(), 1);
    drop(service);

    let fixture = Fixture::new(MODELS, false);
    let (_root, mut service) = self::service(&fixture.base);
    begin(&mut service);
    settled(&mut service, REQUEST);
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.operation_id = "60000000-0000-4000-8000-000000000099".into();
    put.expected_revision = Some(REVISION.into());
    put.base_url = fixture.base.clone();
    let receipt = service.configure(ConfigMutation::Put(put), ids()).unwrap();
    assert_ne!(receipt.saved_revision, REVISION);
    assert_eq!(
        service.profiles_with_published_inventory().unwrap()[0]["modelInventory"],
        Value::Null
    );
    assert_eq!(fixture.finish(), 1);
}

#[test]
fn published_inventory_rejects_stale_service_after_another_service_publishes_empty() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut first) = service(&fixture.base);
    begin(&mut first);
    settled(&mut first, REQUEST);
    assert_eq!(
        first.profiles_with_published_inventory().unwrap()[0]["modelInventory"]["models"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut second = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        1000,
    )
    .unwrap();
    fixture.set_body(r#"{"data":[]}"#);
    let newer = "50000000-0000-4000-8000-000000000002";
    second
        .begin(PROFILE, newer, Duration::from_secs(2), 1001)
        .unwrap();
    assert_eq!(settled(&mut second, newer)["status"], "empty");
    let current = second.profiles_with_published_inventory().unwrap();
    assert_eq!(
        current[0]["modelInventory"]["models"],
        serde_json::json!([])
    );
    assert!(matches!(
        first.profiles_with_published_inventory(),
        Err(DrainError::Lease(LeaseError::PersistenceFailed))
    ));
    first.history_dirty = true;
    assert!(matches!(
        first.profiles_with_published_inventory(),
        Err(DrainError::Lease(LeaseError::PersistenceFailed))
    ));
    drop(first);
    drop(second);
    let mut loaded = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        1002,
    )
    .unwrap();
    assert_eq!(loaded.profiles_with_published_inventory().unwrap(), current);
    assert!(loaded.owner.entries.is_empty());
    assert_eq!(fixture.finish(), 2);
}

#[test]
fn published_inventory_authenticates_clean_and_unchanged_dirty_history_reads() {
    for missing in [false, true] {
        let (root, mut service) = service("http://127.0.0.1:9/v1");
        service.profiles_with_published_inventory().unwrap();
        assert!(!service.history_dirty);
        let db =
            rusqlite::Connection::open(root.path().join(crate::storage::DATABASE_FILE)).unwrap();
        if missing {
            db.execute("DELETE FROM provider_connection_job_checkpoints", [])
                .unwrap();
        } else {
            db.execute(
                "UPDATE provider_connection_job_checkpoints SET payload=?1",
                [b"tampered".as_slice()],
            )
            .unwrap();
        }
        assert!(matches!(
            service.profiles_with_published_inventory(),
            Err(DrainError::Lease(LeaseError::PersistenceFailed))
        ));
        service.history_dirty = true;
        assert!(matches!(
            service.profiles_with_published_inventory(),
            Err(DrainError::Lease(LeaseError::PersistenceFailed))
        ));
        assert!(service.owner.entries.is_empty());
    }
}

#[test]
fn published_inventory_projection_holds_the_history_and_configuration_fence() {
    let (root, mut service) = service("http://127.0.0.1:9/v1");
    let mut writer = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let (start, wait) = mpsc::channel();
    let (blocked, blocked_rx) = mpsc::channel();
    writer.notify_fence_attempt(blocked).unwrap();
    let (done, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
        put.operation_id = "60000000-0000-4000-8000-000000000099".into();
        put.expected_revision = Some(REVISION.into());
        put.base_url = "http://127.0.0.1:9/v1".into();
        done.send(writer.configure(ConfigMutation::Put(put), ids()))
            .unwrap();
    });
    service
        .owner
        .coordinator
        .with_profiles_at_history_generation(
            service.history_generation,
            &service.history_fingerprint.unwrap(),
            |profiles| {
                assert_eq!(profiles[0].revision, REVISION);
                start.send(()).unwrap();
                blocked_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
            },
        )
        .unwrap();
    assert!(
        done_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap()
            .cleanup_confirmed
    );
    worker.join().unwrap();
    let projected = service.profiles_with_published_inventory().unwrap();
    assert_eq!(projected[0]["revision"], NEXT_REVISION);
    assert_eq!(projected[0]["modelInventory"], Value::Null);
}
#[test]
fn repeated_begin_retains_one_original_worker_and_outcome() {
    let fixture = Fixture::new(MODELS, true);
    let (_root, mut service) = service(&fixture.base);
    begin(&mut service);
    assert!(fixture.reached().starts_with("GET /v1/models HTTP/1.1"));
    let replay = begin(&mut service);
    assert_eq!(replay["status"], "running");
    assert_eq!(service.owner.entries.len(), 1);
    assert_eq!(service.exchanges.len(), 1);
    let cancelling = service.cancel(PROFILE, REQUEST, 11).unwrap();
    assert_eq!(cancelling["cancelConfirmed"], false);
    assert_eq!(cancelling["cleanupPending"], true);
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["status"], "cancelled");
    assert_eq!(job["cancelConfirmed"], true);
    assert!(job["models"].is_null());
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn malformed_inventory_becomes_failed_but_real_transport_is_drained() {
    let fixture = Fixture::new(r#"{"data":"wrong"}"#, false);
    let (_root, mut service) = service(&fixture.base);
    begin(&mut service);
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["status"], "failed");
    assert_eq!(job["error"]["code"], "inventory_rejected");
    assert_eq!(job["cleanupPending"], false);
    assert!(job["models"].is_null());
    assert_eq!(service.owner.entries[0].phase, DrainPhase::Settled);
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn empty_inventory_stays_empty_and_does_not_select_a_model() {
    let fixture = Fixture::new(r#"{"data":[]}"#, false);
    let (_root, mut service) = service(&fixture.base);
    begin(&mut service);
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["status"], "empty");
    assert_eq!(job["models"], serde_json::json!([]));
    assert_eq!(job["receipt"]["modelCount"], 0);
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn changed_configuration_stops_old_http_before_cleanup_and_fresh_discovery() {
    let old = Fixture::new(MODELS, true);
    let new = Fixture::new(MODELS, false);
    let (_root, mut service) = service(&old.base);
    begin(&mut service);
    old.reached();
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.operation_id = "60000000-0000-4000-8000-000000000099".into();
    put.expected_revision = Some(REVISION.into());
    put.base_url = new.base.clone();
    let receipt = service.configure(ConfigMutation::Put(put), ids()).unwrap();
    assert!(!receipt.cleanup_confirmed);
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["status"], "stale");
    assert!(job["models"].is_null());
    assert_eq!(job["error"]["code"], "configuration_changed");
    assert!(
        service
            .retry_cleanup(PROFILE, "60000000-0000-4000-8000-000000000099")
            .unwrap()
            .cleanup_confirmed
    );
    let request = "50000000-0000-4000-8000-000000000099";
    service
        .begin(PROFILE, request, Duration::from_secs(2), 30)
        .unwrap();
    assert_eq!(settled(&mut service, request)["status"], "succeeded");
    assert_eq!(old.finish(), 1);
    assert_eq!(new.finish(), 1);
}
#[test]
fn explicit_shutdown_joins_the_original_http_worker() {
    let fixture = Fixture::new(MODELS, true);
    let (_root, mut service) = service(&fixture.base);
    begin(&mut service);
    fixture.reached();
    service.request_shutdown(15).unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !service.poll_all(20).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(service.job(REQUEST).unwrap()["cancelConfirmed"], true);
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn cancellation_before_begin_prevents_any_http_worker() {
    let fixture = Fixture::new(MODELS, false);
    let (_root, mut service) = service(&fixture.base);
    service.cancel(PROFILE, REQUEST, 1).unwrap();
    let job = begin(&mut service);
    assert_eq!(job["status"], "cancelled");
    assert!(service.owner.entries.is_empty());
    assert!(service.exchanges.is_empty());
    assert_eq!(fixture.finish(), 0);
}

#[test]
fn configuration_writer_cannot_cross_the_publication_profile_fence() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut service) = service(&fixture.base);
    let profile = service.owner.coordinator.profile(PROFILE).unwrap().unwrap();
    let snapshot =
        runtime::resolve(&scope(), &profile, &crate::reference_for(&profile), None).unwrap();
    let mut writer = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let (start, wait) = mpsc::channel();
    let (blocked, blocked_rx) = mpsc::channel();
    writer.notify_fence_attempt(blocked).unwrap();
    let (done, done_rx) = mpsc::channel();
    let base = fixture.base.clone();
    let thread = std::thread::spawn(move || {
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
        put.operation_id = "60000000-0000-4000-8000-000000000099".into();
        put.expected_revision = Some(REVISION.into());
        put.base_url = base;
        done.send(writer.configure(ConfigMutation::Put(put), ids()))
            .unwrap();
    });
    service
        .owner
        .coordinator
        .with_current_profile(&snapshot, |current| {
            assert_eq!(current.unwrap().revision, REVISION);
            start.send(()).unwrap();
            blocked_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        })
        .unwrap();
    assert!(
        done_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap()
            .cleanup_confirmed
    );
    thread.join().unwrap();
    assert_eq!(
        service
            .owner
            .coordinator
            .profile(PROFILE)
            .unwrap()
            .unwrap()
            .revision,
        NEXT_REVISION
    );
    assert_eq!(fixture.finish(), 0);
}

#[test]
fn settled_success_and_inventory_failure_release_all_raw_response_slots() {
    for body in [MODELS, r#"{"data":"wrong"}"#] {
        let fixture = Fixture::new(body, false);
        let (_root, mut service) = service(&fixture.base);
        begin(&mut service);
        let job = settled(&mut service, REQUEST);
        assert_eq!(
            job["status"],
            if body == MODELS {
                "succeeded"
            } else {
                "failed"
            }
        );
        assert!(service.exchanges[0].outcome.is_none());
        assert!(service.exchanges[0]
            .reader
            .take_after_join()
            .unwrap()
            .is_none());
        assert_eq!(fixture.finish(), 1);
    }
}
#[test]
fn publication_failure_retains_original_response_until_successful_retry() {
    let fixture = Fixture::new(MODELS, false);
    let (_root, mut service) = service(&fixture.base);
    begin(&mut service);
    service.fail_before_publication = true;
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match service.poll(REQUEST, 20) {
            Err(DrainError::Job(Error::PersistenceFailed)) => break,
            Ok(job) => assert_eq!(job["status"], "running"),
            Err(DrainError::Lease(LeaseError::ResourceStopPending)) => {}
            other => panic!("Unexpected injected failure: {other:?}"),
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(!service.exchanges[0].outcome.as_ref().unwrap().receipts[0]
        .body
        .is_empty());
    assert_eq!(
        service.owner.entries[0].phase,
        DrainPhase::GateCFactAccepted
    );
    assert!(service.owner.entries[0].original_proof.is_some());
    assert_eq!(service.job(REQUEST).unwrap()["status"], "running");
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["models"][0]["id"], "own-synthetic-model");
    assert!(service.exchanges[0].outcome.is_none());
    assert!(service.exchanges[0]
        .reader
        .take_after_join()
        .unwrap()
        .is_none());
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn admission_status_failure_discards_shared_result_only_after_original_drain() {
    let fixture = Fixture::new(MODELS, true);
    let (_root, mut service) = service(&fixture.base);
    service.owner.coordinator.test_fail_returned_owner_status();
    let result = service.begin(PROFILE, REQUEST, Duration::from_secs(2), 10);
    assert!(matches!(
        result,
        Err(DrainError::Lease(LeaseError::PersistenceFailed))
    ));
    fixture.reached();
    assert_eq!(service.job(REQUEST).unwrap()["cleanupPending"], true);
    assert!(matches!(
        service.exchanges[0].reader.take_after_join(),
        Err(LeaseError::ResourceStopPending)
    ));
    let job = settled(&mut service, REQUEST);
    assert_eq!(job["status"], "failed");
    assert_eq!(job["cleanupPending"], false);
    assert!(job["models"].is_null());
    assert!(service.exchanges[0].outcome.is_none());
    assert!(service.exchanges[0]
        .reader
        .take_after_join()
        .unwrap()
        .is_none());
    assert_eq!(fixture.finish(), 1);
}

#[test]
fn completed_http_history_reopens_without_recreating_a_worker_or_refetching() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut service) = service(&fixture.base);
    begin(&mut service);
    let original = settled(&mut service, REQUEST);
    drop(service);
    let mut loaded = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        99,
    )
    .unwrap();
    assert_eq!(loaded.job(REQUEST).unwrap(), original);
    assert_eq!(
        loaded
            .begin(PROFILE, REQUEST, Duration::from_secs(2), 100)
            .unwrap(),
        original
    );
    assert!(loaded.owner.entries.is_empty());
    assert!(loaded.exchanges.is_empty());
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn rejected_running_checkpoint_rolls_back_actor_and_never_starts_http() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut service) = service(&fixture.base);
    let db = rusqlite::Connection::open(root.path().join(crate::storage::DATABASE_FILE)).unwrap();
    db.execute_batch("CREATE TRIGGER reject_test_checkpoint BEFORE UPDATE ON provider_connection_job_checkpoints BEGIN SELECT RAISE(ABORT,'fixture checkpoint rejection'); END;").unwrap();
    let generation = service.history_generation;
    let result = service.begin(PROFILE, REQUEST, Duration::from_secs(2), 10);
    assert!(matches!(
        result,
        Err(DrainError::Lease(LeaseError::PersistenceFailed))
    ));
    assert_eq!(service.history_generation, generation);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM provider_connection_actors", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(service.owner.entries[0].original_never_dispatched.is_some());
    assert!(!service.exchanges[0].reader.outcome_ready());
    db.execute_batch("DROP TRIGGER reject_test_checkpoint;")
        .unwrap();
    service.flush_history().unwrap();
    assert_eq!(service.job(REQUEST).unwrap()["status"], "failed");
    assert_eq!(service.job(REQUEST).unwrap()["cleanupPending"], false);
    assert_eq!(fixture.finish(), 0);
}
#[test]
fn failed_terminal_checkpoint_keeps_raw_response_until_durable_retry() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut service) = service(&fixture.base);
    begin(&mut service);
    let db = rusqlite::Connection::open(root.path().join(crate::storage::DATABASE_FILE)).unwrap();
    db.execute_batch("CREATE TRIGGER reject_test_checkpoint BEFORE UPDATE ON provider_connection_job_checkpoints BEGIN SELECT RAISE(ABORT,'fixture checkpoint rejection'); END;").unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match service.poll(REQUEST, 20) {
            Err(DrainError::Lease(LeaseError::PersistenceFailed))
                if service.owner.entries[0].phase == DrainPhase::Settled =>
            {
                break
            }
            Ok(_)
            | Err(DrainError::Lease(
                LeaseError::ResourceStopPending | LeaseError::PersistenceFailed,
            )) => {}
            other => panic!("Unexpected checkpoint failure {other:?}"),
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(!service.exchanges[0].outcome.as_ref().unwrap().receipts[0]
        .body
        .is_empty());
    let payload: Vec<u8> = db
        .query_row(
            "SELECT payload FROM provider_connection_job_checkpoints",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let persisted: Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(persisted["records"][0]["status"], "running");
    // The background fast path must not skip a failed durable terminal save.
    assert!(matches!(
        service.poll_all(21),
        Err(DrainError::Lease(LeaseError::PersistenceFailed))
    ));
    assert!(service.exchanges[0].outcome.is_some());
    assert!(matches!(
        service.profiles_with_published_inventory(),
        Err(DrainError::Lease(LeaseError::PersistenceFailed))
    ));
    db.execute_batch("DROP TRIGGER reject_test_checkpoint;")
        .unwrap();
    assert!(service.poll_all(22).unwrap());
    assert!(service.exchanges[0].outcome.is_none());
    assert_eq!(settled(&mut service, REQUEST)["status"], "succeeded");
    assert_eq!(
        service.profiles_with_published_inventory().unwrap()[0]["modelInventory"]["models"][0]
            ["id"],
        "own-synthetic-model"
    );
    assert!(service.exchanges[0].outcome.is_none());
    assert_eq!(fixture.finish(), 1);
}
#[test]
fn crash_child_owned_http() {
    if std::env::var("V4_OWNED_HTTP_CRASH_FIXTURE").as_deref() != Ok("v4-owned-http-crash-fixture")
    {
        return;
    }
    let root = std::path::PathBuf::from(std::env::var_os("V4_OWNED_HTTP_FIXTURE_ROOT").unwrap());
    let mut service = HttpDiscoveryService::open_at(
        &root,
        TrustedExecutionContext::from_authenticated_execution(scope()),
        11,
    )
    .unwrap();
    begin(&mut service);
    // Parent reaps this real process while its HTTP body is held by the owned fixture.
    std::thread::sleep(Duration::from_secs(20));
    service.request_shutdown(30).unwrap();
}
#[test]
fn actual_process_restart_preserves_unknown_cleanup_and_creates_no_live_authority() {
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let fixture = Fixture::new(MODELS, true);
    let (root, service) = service(&fixture.base);
    drop(service);
    let mut child = ChildGuard(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "jobs::owned_discovery::http::tests::crash_child_owned_http",
                "--nocapture",
            ])
            .env_clear()
            .env("TMPDIR", "/private/tmp")
            .env("PATH", "/usr/bin:/bin")
            .env("V4_OWNED_HTTP_CRASH_FIXTURE", "v4-owned-http-crash-fixture")
            .env("V4_OWNED_HTTP_FIXTURE_ROOT", root.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    fixture.reached();
    child.0.kill().unwrap();
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    let mut loaded = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        99,
    )
    .unwrap();
    let job = loaded.job(REQUEST).unwrap();
    assert_eq!(job["status"], "failed");
    assert_eq!(job["error"]["code"], "server_restarted");
    assert_eq!(job["cleanupPending"], true);
    assert_eq!(job["cancelConfirmed"], false);
    assert!(job["models"].is_null());
    assert!(loaded.owner.entries.is_empty());
    assert!(loaded.exchanges.is_empty());
    assert!(loaded.poll_all(100).unwrap());
    assert!(!loaded.cleanup_confirmed().unwrap());
    drop(loaded);
    let mut facade = crate::ConnectionService::open_for_authenticated_execution(
        root.path(),
        &scope().owner_id,
        &scope().environment_id,
    )
    .unwrap();
    let report = facade.tick(101).unwrap();
    assert!(report.local_resources_stopped);
    assert!(!report.cleanup_confirmed);
    assert_eq!(facade.job(REQUEST).unwrap()["cleanupPending"], true);
    assert_eq!(fixture.finish(), 1);
}

#[test]
fn aggregate_catalog_limit_rejects_only_new_publication_and_keeps_history_writable() {
    // Thirteen individually valid <2MB inventories exceed the real23MiB
    // aggregate catalog budget. No reduced test-only limit is substituted.
    let body = serde_json::json!({"data":[{"id":"large-synthetic-model","display_name":"x".repeat(1_900_000)}]}).to_string();
    assert!(body.len() < crate::discovery::MAX_RESPONSE_BYTES);
    let fixture = Fixture::with_lifetime(body, false, Duration::from_secs(180));
    let (root, mut service) = service(&fixture.base);
    let first = "50000000-0000-4000-8000-000000000010";
    for index in 0..13 {
        let request = format!("50000000-0000-4000-8000-{:012x}", index + 16);
        service
            .begin(PROFILE, &request, Duration::from_secs(2), 10)
            .unwrap();
        let job = settled(&mut service, &request);
        if index < 12 {
            assert_eq!(job["status"], "succeeded");
        } else {
            assert_eq!(job["status"], "failed");
            assert_eq!(job["error"]["code"], "discovery_history_full");
            assert_eq!(job["cleanupPending"], false);
            assert!(job["models"].is_null());
        }
    }
    assert_eq!(
        service.job(first).unwrap()["models"][0]["label"]
            .as_str()
            .unwrap()
            .len(),
        1_900_000
    );
    // Count the actual JSON projection entry, not timing or a reduced catalog.
    let projections = crate::jobs::public_job_projection_count();
    for now in 30..130 {
        assert!(service.poll_all(now).unwrap());
        assert!(service.cleanup_confirmed().unwrap());
    }
    assert_eq!(crate::jobs::public_job_projection_count(), projections);
    let tombstone = "50000000-0000-4000-8000-000000000099";
    assert_eq!(
        service.cancel(PROFILE, tombstone, 30).unwrap()["status"],
        "cancelled"
    );
    drop(service);
    let loaded = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        99,
    )
    .unwrap();
    assert_eq!(loaded.job(first).unwrap()["status"], "succeeded");
    assert_eq!(loaded.job(tombstone).unwrap()["status"], "cancelled");
    assert_eq!(fixture.finish(), 13);
}

#[test]
fn public_cleanup_confirmation_authenticates_every_quiescent_actor_fact() {
    let fixture = Fixture::new(MODELS, false);
    let (root, mut service) = service(&fixture.base);
    begin(&mut service);
    assert_eq!(settled(&mut service, REQUEST)["status"], "succeeded");
    let second = "50000000-0000-4000-8000-000000000002";
    service
        .begin(PROFILE, second, Duration::from_secs(2), 30)
        .unwrap();
    assert_eq!(settled(&mut service, second)["status"], "succeeded");
    drop(service);
    let db = rusqlite::Connection::open(root.path().join(crate::storage::DATABASE_FILE)).unwrap();
    let fact = |request: &str| {
        db.query_row(
        "SELECT stop_evidence_json FROM provider_connection_actors WHERE request_id=?1 AND status='quiescent'",
        [request], |row| row.get::<_, String>(0)).unwrap()
    };
    let original = fact(REQUEST);
    let other_actor = fact(second);
    assert_ne!(original, other_actor);
    let mut facade = crate::ConnectionService::open_for_authenticated_execution(
        root.path(),
        &scope().owner_id,
        &scope().environment_id,
    )
    .unwrap();
    let report = facade.tick(40).unwrap();
    assert!(report.local_resources_stopped);
    assert!(report.cleanup_confirmed);
    for invalid in [None, Some("forged"), Some(other_actor.as_str())] {
        assert_eq!(
            db.execute(
                "UPDATE provider_connection_actors SET stop_evidence_json=?1 WHERE request_id=?2",
                rusqlite::params![invalid, REQUEST]
            )
            .unwrap(),
            1
        );
        let report = facade.tick(41).unwrap();
        assert!(report.local_resources_stopped);
        assert!(!report.cleanup_confirmed);
        assert_eq!(facade.job(REQUEST).unwrap()["status"], "succeeded");
    }
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json=?1 WHERE request_id=?2",
        rusqlite::params![original, REQUEST],
    )
    .unwrap();
    let report = facade.tick(42).unwrap();
    assert!(report.local_resources_stopped);
    assert!(report.cleanup_confirmed);
    assert_eq!(fixture.finish(), 2);
}

struct CleanupThread;
struct CleanupThreadOwner(Option<JoinHandle<()>>);
impl StartOwnedResource for CleanupThread {
    fn start(self: Box<Self>) -> StartOutcome {
        StartOutcome::Started(Box::new(CleanupThreadOwner(Some(std::thread::spawn(
            || {},
        )))))
    }
}
impl OwnedRunningResource for CleanupThreadOwner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        self.0
            .take()
            .unwrap()
            .join()
            .map_err(|_| LeaseError::ResourceStopPending)
    }
}
fn cleanup_id(namespace: u32, index: usize) -> String {
    format!("{namespace:08x}-0000-4000-8000-{index:012x}")
}
fn cleanup_replacement(
    service: &mut HttpDiscoveryService,
    index: usize,
) -> (LeaseHandle, ConfigReceipt) {
    let profile = cleanup_id(0x11000000, index);
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.profile_id = profile.clone();
    put.operation_id = cleanup_id(0x61000000, index);
    let mut save = ids();
    save.revision = cleanup_id(0x21000000, index);
    let created = service.configure(ConfigMutation::Put(put), save).unwrap();
    assert!(created.cleanup_confirmed);
    let stored = service
        .owner
        .coordinator
        .profile(&profile)
        .unwrap()
        .unwrap();
    let snapshot = runtime::resolve(
        service.owner.coordinator.authenticated_scope(),
        &stored,
        &reference_for(&stored),
        None,
    )
    .unwrap();
    let handle = service
        .owner
        .coordinator
        .admit(
            &cleanup_id(0x51000000, index),
            &snapshot,
            ConsumerKind::Discovery,
            Box::new(CleanupThread),
        )
        .unwrap();
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.profile_id = profile;
    put.operation_id = cleanup_id(0x62000000, index);
    put.expected_revision = Some(created.saved_revision);
    let mut save = ids();
    save.revision = cleanup_id(0x22000000, index);
    let replacement = service.configure(ConfigMutation::Put(put), save).unwrap();
    assert!(!replacement.cleanup_confirmed);
    (handle, replacement)
}
fn cleanup_backlog() -> (
    tempfile::TempDir,
    HttpDiscoveryService,
    Vec<LeaseHandle>,
    Vec<ConfigReceipt>,
) {
    let root = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let mut service = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        1,
    )
    .unwrap();
    let mut handles = vec![];
    let mut receipts = vec![];
    // Each pending replacement may legally be deleted, retaining both receipts.
    for index in 0..64 {
        let (handle, replacement) = cleanup_replacement(&mut service, index);
        let deleted = service
            .configure(
                ConfigMutation::Delete(DeleteProfile {
                    operation_id: cleanup_id(0x63000000, index),
                    profile_id: replacement.profile_id.clone(),
                    expected_revision: replacement.saved_revision.clone(),
                }),
                ids(),
            )
            .unwrap();
        assert!(!deleted.cleanup_confirmed);
        handles.push(handle);
        let replacement = service
            .operation(&replacement.profile_id, &replacement.operation_id)
            .unwrap();
        receipts.extend([replacement, deleted]);
    }
    assert_eq!(
        service
            .owner
            .coordinator
            .pending_configurations()
            .unwrap()
            .len(),
        128
    );
    (root, service, handles, receipts)
}
fn release_cleanup_worker(service: &mut HttpDiscoveryService, handle: &LeaseHandle) {
    let proof = service.owner.coordinator.observe_stop(handle).unwrap();
    service
        .owner
        .coordinator
        .release_completed(handle, &proof)
        .unwrap();
}
fn cleanup_activation(service: &mut HttpDiscoveryService, profile: &str) -> Activation {
    service
        .owner
        .coordinator
        .profile(profile)
        .unwrap()
        .unwrap()
        .activation
}

#[test]
fn reconciliation_reaches_ready_configuration_after_128_unknown_receipts() {
    let (root, mut original, handles, receipts) = cleanup_backlog();
    original.reconcile_configurations().unwrap();
    drop(handles);
    drop(original);
    let mut service = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        2,
    )
    .unwrap();
    let (handle, later) = cleanup_replacement(&mut service, 64);
    release_cleanup_worker(&mut service, &handle);
    assert!(matches!(
        service.prepare_inference(&later.profile_id, &later.saved_revision, "synthetic-model"),
        Err(DrainError::Job(Error::CleanupPending))
    ));
    let mut foreign_services = vec![];
    for foreign_scope in [
        Scope {
            owner_id: "other-owner".into(),
            ..scope()
        },
        Scope {
            environment_id: "other-environment".into(),
            ..scope()
        },
    ] {
        let mut foreign = HttpDiscoveryService::open_at(
            root.path(),
            TrustedExecutionContext::from_authenticated_execution(foreign_scope),
            2,
        )
        .unwrap();
        let (handle, receipt) = cleanup_replacement(&mut foreign, 64);
        release_cleanup_worker(&mut foreign, &handle);
        foreign_services.push((foreign, receipt));
    }
    let db = rusqlite::Connection::open(root.path().join(crate::storage::DATABASE_FILE)).unwrap();
    let actors = || {
        let mut query = db.prepare("SELECT reference_json,actor_id,process_instance_id,lease_id,admission_generation,status,stop_evidence_json FROM provider_connection_actors ORDER BY rowid").unwrap();
        query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let original_actors = actors();
    assert_eq!(
        original_actors
            .iter()
            .filter(|actor| actor.6.is_none())
            .count(),
        64
    );
    service.reconcile_configurations().unwrap();
    assert_eq!(
        cleanup_activation(&mut service, &later.profile_id),
        Activation::CleanupPending
    );
    for _ in 0..4 {
        assert!(!service.cleanup_confirmed().unwrap());
        assert_eq!(
            service
                .owner
                .coordinator
                .pending_configurations()
                .unwrap()
                .len(),
            128
        );
    }
    service.reconcile_configurations().unwrap();
    assert_eq!(
        cleanup_activation(&mut service, &later.profile_id),
        Activation::Ready
    );
    service
        .prepare_inference(&later.profile_id, &later.saved_revision, "synthetic-model")
        .unwrap();
    for _ in 0..3 {
        service.reconcile_configurations().unwrap();
    }
    assert_eq!(actors(), original_actors);
    for receipt in receipts {
        assert_eq!(
            service
                .operation(&receipt.profile_id, &receipt.operation_id)
                .unwrap(),
            receipt
        );
    }
    for (mut foreign, receipt) in foreign_services {
        assert_eq!(
            cleanup_activation(&mut foreign, &receipt.profile_id),
            Activation::CleanupPending
        );
    }
    assert!(!service.cleanup_confirmed().unwrap());
    let (handle, ticked) = cleanup_replacement(&mut service, 65);
    release_cleanup_worker(&mut service, &handle);
    drop(service);
    let mut facade = ConnectionService::open_for_authenticated_execution(
        root.path(),
        &scope().owner_id,
        &scope().environment_id,
    )
    .unwrap();
    for expected_activation in ["cleanup-pending", "ready"] {
        let report = facade.tick(4).unwrap();
        assert!(report.local_resources_stopped);
        assert!(!report.cleanup_confirmed);
        let profiles = facade.profiles().unwrap();
        let profile = profiles
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["profileId"] == ticked.profile_id)
            .unwrap();
        assert_eq!(profile["activation"], expected_activation);
    }
}

#[test]
fn reconciliation_wraps_without_probe_advancement_and_restarts_from_the_beginning() {
    let (root, mut service, handles, _receipts) = cleanup_backlog();
    let (later_handle, later) = cleanup_replacement(&mut service, 64);
    // Reach the second page while every receipt is still unconfirmable.
    service.reconcile_configurations().unwrap();
    for handle in &handles {
        release_cleanup_worker(&mut service, handle);
    }
    release_cleanup_worker(&mut service, &later_handle);
    for _ in 0..3 {
        assert!(!service.cleanup_confirmed().unwrap());
        assert_eq!(
            service
                .owner
                .coordinator
                .pending_configurations()
                .unwrap()
                .len(),
            128
        );
    }
    service.reconcile_configurations().unwrap();
    assert_eq!(
        cleanup_activation(&mut service, &later.profile_id),
        Activation::Ready
    );
    assert_eq!(
        service
            .owner
            .coordinator
            .pending_configurations()
            .unwrap()
            .len(),
        128
    );
    let (inserted_handle, inserted) = cleanup_replacement(&mut service, 65);
    release_cleanup_worker(&mut service, &inserted_handle);
    service.reconcile_configurations().unwrap();
    assert_eq!(
        service.owner.coordinator.pending_configurations().unwrap(),
        vec![(inserted.profile_id.clone(), inserted.operation_id.clone())]
    );
    assert_eq!(
        cleanup_activation(&mut service, &inserted.profile_id),
        Activation::CleanupPending
    );
    drop(service);
    let mut reopened = HttpDiscoveryService::open_at(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
        3,
    )
    .unwrap();
    assert!(!reopened.cleanup_confirmed().unwrap());
    reopened.reconcile_configurations().unwrap();
    assert_eq!(
        cleanup_activation(&mut reopened, &inserted.profile_id),
        Activation::Ready
    );
    assert!(reopened.cleanup_confirmed().unwrap());
    for _ in 0..3 {
        reopened.reconcile_configurations().unwrap();
        assert!(reopened.cleanup_confirmed().unwrap());
    }
    let (handle, after_empty) = cleanup_replacement(&mut reopened, 66);
    release_cleanup_worker(&mut reopened, &handle);
    reopened.reconcile_configurations().unwrap();
    assert_eq!(
        cleanup_activation(&mut reopened, &after_empty.profile_id),
        Activation::Ready
    );
    assert!(reopened.cleanup_confirmed().unwrap());
}
