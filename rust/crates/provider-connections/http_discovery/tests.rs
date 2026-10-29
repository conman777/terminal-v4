use super::*;
use crate::{fixtures::*, leases::*, *};
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::Instant,
};

const BODY: &str = r#"{"data":[{"id":"synthetic-model"}]}"#;
#[derive(Clone, Debug)]
struct Request {
    line: String,
    headers: BTreeMap<String, String>,
}
enum Reply {
    Fixed {
        status: u16,
        content_type: &'static str,
        extra: String,
        body: Vec<u8>,
        declared: Option<usize>,
    },
    Chunked(Vec<u8>),
    Held {
        reached: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        body_started: bool,
    },
}
fn json(body: &str) -> Reply {
    Reply::Fixed {
        status: 200,
        content_type: "application/json",
        extra: String::new(),
        body: body.as_bytes().to_vec(),
        declared: None,
    }
}
struct Server {
    base: String,
    requests: Arc<Mutex<Vec<Request>>>,
    errors: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    release: Option<mpsc::Sender<()>>,
}
impl Server {
    fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let errors = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, errs, stopping) = (requests.clone(), errors.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !stopping.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => {
                        errs.lock().unwrap().push(error.kind().to_string());
                        break;
                    }
                };
                // macOS accept may retain the listener's nonblocking flag.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let request = match read_request(&mut stream) {
                    Ok(value) => value,
                    Err(error) => {
                        errs.lock().unwrap().push(error);
                        break;
                    }
                };
                seen.lock().unwrap().push(request);
                let Some(reply) = replies.next() else {
                    errs.lock().unwrap().push("Unexpected request".into());
                    break;
                };
                match reply {
                    Reply::Chunked(body) => {
                        let prefix = format!("HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n", body.len());
                        if let Err(error) = stream
                            .write_all(prefix.as_bytes())
                            .and_then(|_| stream.write_all(&body))
                            .and_then(|_| stream.write_all(b"\r\n0\r\n\r\n"))
                        {
                            if body.len() <= discovery::MAX_RESPONSE_BYTES
                                || !matches!(
                                    error.kind(),
                                    std::io::ErrorKind::BrokenPipe
                                        | std::io::ErrorKind::ConnectionReset
                                )
                            {
                                errs.lock().unwrap().push(error.kind().to_string());
                            }
                        }
                    }
                    Reply::Fixed {
                        status,
                        content_type,
                        extra,
                        body,
                        declared,
                    } => {
                        let header = format!("HTTP/1.1 {status} fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", declared.unwrap_or(body.len()));
                        if let Err(error) = stream
                            .write_all(header.as_bytes())
                            .and_then(|_| stream.write_all(&body))
                        {
                            // Only the intentional size-limit response may be cut
                            // off by the real client before its fixture write ends.
                            if body.len() <= discovery::MAX_RESPONSE_BYTES
                                || !matches!(
                                    error.kind(),
                                    std::io::ErrorKind::BrokenPipe
                                        | std::io::ErrorKind::ConnectionReset
                                )
                            {
                                errs.lock().unwrap().push(error.kind().to_string());
                            }
                        }
                    }
                    Reply::Held {
                        reached,
                        release,
                        body_started,
                    } => {
                        if body_started {
                            stream.write_all(b"HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{").unwrap();
                        }
                        let _ = reached.send(());
                        let _ = release.recv_timeout(Duration::from_secs(5));
                    }
                }
            }
        });
        Self {
            base,
            requests,
            errors,
            stop,
            thread: Some(thread),
            release: None,
        }
    }
    fn held(body_started: bool) -> (Self, mpsc::Receiver<()>) {
        let (reached, rx) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let mut server = Self::start(vec![Reply::Held {
            reached,
            release: wait,
            body_started,
        }]);
        server.release = Some(release);
        (server, rx)
    }
    fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
    fn finish(mut self) -> Vec<Request> {
        self.release();
        self.stop.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
        let errors = self.errors.lock().unwrap().clone();
        assert!(errors.is_empty(), "{errors:?}");
        let requests = self.requests.lock().unwrap().clone();
        requests
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.release();
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn read_request(stream: &mut TcpStream) -> std::result::Result<Request, String> {
    let mut bytes = vec![];
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut one = [0u8; 1];
        stream
            .read_exact(&mut one)
            .map_err(|error| error.kind().to_string())?;
        bytes.push(one[0]);
        if bytes.len() > 16_384 {
            return Err("Header limit".into());
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| "Header encoding")?;
    let mut lines = text.split("\r\n");
    Ok(Request {
        line: lines.next().unwrap().into(),
        headers: lines
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
            .collect(),
    })
}
fn snapshot(base: &str, kind: ProfileKind, bearer: bool) -> EffectiveConnection {
    let mut profile = profile(kind);
    profile.base_url = base.into();
    profile.auth = if bearer {
        StoredAuth::Bearer(binding(&profile))
    } else {
        StoredAuth::None
    };
    runtime::resolve(&scope(), &profile, &reference(&profile), None).unwrap()
}
fn prepare(
    snapshot: &EffectiveConnection,
    bearer: bool,
    timeout_ms: u64,
) -> (HttpDiscoveryAction, OutcomeReader) {
    HttpDiscoveryAction::prepare(
        AdmissionOrigin::test_fresh(),
        snapshot,
        if bearer {
            ResolvedAuthorization::Bearer(SecretString::new("synthetic-http-token".into()))
        } else {
            ResolvedAuthorization::None
        },
        Duration::from_millis(timeout_ms),
    )
    .unwrap()
}
fn start(action: HttpDiscoveryAction) -> Box<dyn OwnedRunningResource> {
    match Box::new(action).start() {
        StartOutcome::Started(owner) => owner,
        StartOutcome::FailedOwned { .. } => panic!("Fixture worker did not start"),
    }
}
fn wait_for(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(4);
    while !check() {
        assert!(Instant::now() < deadline, "Fixture wait timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn join(owner: &mut dyn OwnedRunningResource) {
    wait_for(|| match owner.cancel_and_join() {
        Ok(()) => true,
        Err(LeaseError::ResourceStopPending) => false,
        Err(error) => panic!("Unexpected stop result: {error:?}"),
    });
}
fn outcome(action: HttpDiscoveryAction, reader: &OutcomeReader) -> HttpOutcome {
    let mut owner = start(action);
    wait_for(|| reader.outcome_ready());
    join(&mut *owner);
    reader.take_after_join().unwrap().unwrap()
}
fn state(
    base: &str,
    kind: ProfileKind,
    bearer: bool,
) -> (tempfile::TempDir, Coordinator, EffectiveConnection) {
    state_with_secret(base, kind, bearer, "stored-profile-secret")
}
fn state_with_secret(
    base: &str,
    kind: ProfileKind,
    bearer: bool,
    secret: &str,
) -> (tempfile::TempDir, Coordinator, EffectiveConnection) {
    let root = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let mut coordinator = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let mut put = update(
        kind,
        if bearer {
            AuthChange::ReplaceBearer(SecretString::new(secret.into()))
        } else {
            AuthChange::None
        },
    );
    put.base_url = base.into();
    let mut save = ids();
    save.revision = REVISION.into();
    coordinator
        .configure(ConfigMutation::Put(put), save)
        .unwrap();
    let profile = coordinator.profile(PROFILE).unwrap().unwrap();
    let snap = runtime::resolve(&scope(), &profile, &reference(&profile), None).unwrap();
    (root, coordinator, snap)
}
fn observed(coordinator: &mut Coordinator, handle: &LeaseHandle) -> StopEvidence {
    let mut proof = None;
    wait_for(|| match coordinator.observe_stop(handle) {
        Ok(value) => {
            proof = Some(value);
            true
        }
        Err(LeaseError::ResourceStopPending) => false,
        Err(error) => panic!("Unexpected observe: {error:?}"),
    });
    proof.unwrap()
}

#[test]
fn preparation_drop_and_reader_are_inert_before_admission() {
    let server = Server::start(vec![]);
    let snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = prepare(&snap, false, 500);
    assert!(!reader.outcome_ready());
    assert!(matches!(
        reader.take_after_join(),
        Err(LeaseError::ResourceStopPending)
    ));
    drop(action);
    assert!(!reader.outcome_ready());
    assert!(server.finish().is_empty());
}
#[test]
fn local_none_uses_only_exact_get_without_authentication() {
    let server = Server::start(vec![json(BODY)]);
    let snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = prepare(&snap, false, 500);
    let result = outcome(action, &reader);
    let requests = server.finish();
    assert_eq!(result.failure, None);
    assert_eq!(result.attempted_requests, 1);
    assert_eq!(result.receipts[0].body, BODY.as_bytes());
    assert_eq!(result.plan, runtime::discovery_plan(&snap).unwrap());
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].line, "GET /v1/models HTTP/1.1");
    assert!(!requests[0].headers.contains_key("authorization"));
    assert!(!requests[0].headers.contains_key("cookie"));
    assert!(!requests[0].headers.contains_key("x-cluster-id"));
    assert!(reader.take_after_join().unwrap().is_none());
}
#[test]
fn actual_inventory_sends_exact_selected_cluster_header() {
    let server = Server::start(vec![json(BODY)]);
    let mut snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    snap.cluster_id = Some("cl_owned_fixture".into());
    let (action, reader) = prepare(&snap, false, 500);
    let result = outcome(action, &reader);
    let requests = server.finish();
    assert_eq!(result.failure, None);
    assert_eq!(requests[0].headers["x-cluster-id"], "cl_owned_fixture");
    assert_eq!(result.receipts[0].binding.cluster_id, snap.cluster_id);
}
#[test]
fn lmstudio_gets_both_bound_inventories_with_one_explicit_bearer() {
    let metadata = r#"{"models":[{"key":"synthetic-model","type":"llm","display_name":"Own fixture","loaded_instances":[],"max_context_length":8192,"capabilities":{"vision":true,"trained_for_tool_use":true}}]}"#;
    let server = Server::start(vec![json(BODY), json(metadata)]);
    let snap = snapshot(&server.base, ProfileKind::LmStudioLocal, true);
    let (action, reader) = prepare(&snap, true, 500);
    let result = outcome(action, &reader);
    let requests = server.finish();
    assert_eq!(result.failure, None);
    assert_eq!(result.attempted_requests, 2);
    assert_eq!(result.receipts.len(), 2);
    assert_eq!(
        requests.iter().map(|r| r.line.as_str()).collect::<Vec<_>>(),
        ["GET /v1/models HTTP/1.1", "GET /api/v1/models HTTP/1.1"]
    );
    assert!(requests
        .iter()
        .all(|r| r.headers["authorization"] == "Bearer synthetic-http-token"));
    let catalog =
        discovery::normalize::normalize_inventory(&result.plan, &result.receipts[0]).unwrap();
    let enriched =
        discovery::normalize::enrich_lmstudio(&catalog, &result.plan, &result.receipts[1]).unwrap();
    assert_eq!(enriched.models[0].image_input, Some(true));
}
#[test]
fn missing_optional_metadata_preserves_primary_without_fabricating_capabilities() {
    let server = Server::start(vec![
        json(BODY),
        Reply::Fixed {
            status: 404,
            content_type: "application/json",
            extra: String::new(),
            body: b"{}".to_vec(),
            declared: None,
        },
    ]);
    let snap = snapshot(&server.base, ProfileKind::LmStudioLocal, false);
    let (action, reader) = prepare(&snap, false, 500);
    let result = outcome(action, &reader);
    let requests = server.finish();
    assert_eq!(result.failure, None);
    assert_eq!(result.attempted_requests, 2);
    assert_eq!(result.receipts.len(), 1);
    assert_eq!(requests.len(), 2);
    let catalog =
        discovery::normalize::normalize_inventory(&result.plan, &result.receipts[0]).unwrap();
    assert_eq!(catalog.models[0].image_input, None);
}
#[test]
fn redirects_never_forward_bearer_or_fetch_a_different_target() {
    let target = Server::start(vec![]);
    let server = Server::start(vec![Reply::Fixed {
        status: 302,
        content_type: "application/json",
        extra: format!("Location: {}/models\r\n", target.base),
        body: b"{}".to_vec(),
        declared: None,
    }]);
    let snap = snapshot(&server.base, ProfileKind::LmStudioLocal, true);
    let (action, reader) = prepare(&snap, true, 500);
    let result = outcome(action, &reader);
    let requests = server.finish();
    let other = target.finish();
    assert_eq!(result.failure, Some(HttpFailure::Status));
    assert!(result.receipts.is_empty());
    assert_eq!(result.attempted_requests, 1);
    assert_eq!(requests.len(), 1);
    assert!(other.is_empty());
}
#[test]
fn primary_authentication_failure_has_no_raw_body_or_second_request() {
    let server = Server::start(vec![Reply::Fixed {
        status: 401,
        content_type: "application/json",
        extra: String::new(),
        body: b"{\"error\":\"private reflected credential\"}".to_vec(),
        declared: None,
    }]);
    let snap = snapshot(&server.base, ProfileKind::LmStudioLocal, true);
    let (action, reader) = prepare(&snap, true, 500);
    let result = outcome(action, &reader);
    let requests = server.finish();
    assert_eq!(result.failure, Some(HttpFailure::Status));
    assert!(result.receipts.is_empty());
    assert_eq!(requests.len(), 1);
    assert_eq!(format!("{:?}", result.failure), "Some(Status)");
}
#[test]
fn html_response_is_rejected_even_when_body_looks_like_json() {
    let server = Server::start(vec![Reply::Fixed {
        status: 200,
        content_type: "text/html",
        extra: String::new(),
        body: BODY.as_bytes().to_vec(),
        declared: None,
    }]);
    let snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = prepare(&snap, false, 500);
    let result = outcome(action, &reader);
    server.finish();
    assert_eq!(result.failure, Some(HttpFailure::ContentType));
    assert!(result.receipts.is_empty());
}
#[test]
fn declared_oversize_is_rejected_before_accepting_a_body() {
    let server = Server::start(vec![Reply::Fixed {
        status: 200,
        content_type: "application/json",
        extra: String::new(),
        body: vec![],
        declared: Some(discovery::MAX_RESPONSE_BYTES + 1),
    }]);
    let snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = prepare(&snap, false, 500);
    let result = outcome(action, &reader);
    server.finish();
    assert_eq!(result.failure, Some(HttpFailure::BodyTooLarge));
    assert!(result.receipts.is_empty());
}
#[test]
fn chunked_body_is_bounded_without_trusting_content_length() {
    let server = Server::start(vec![Reply::Chunked(vec![
        b' ';
        discovery::MAX_RESPONSE_BYTES + 1
    ])]);
    let snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = prepare(&snap, false, 1000);
    let result = outcome(action, &reader);
    server.finish();
    assert_eq!(result.failure, Some(HttpFailure::BodyTooLarge));
    assert!(result.receipts.is_empty());
}
#[test]
fn held_body_cancellation_requires_actual_owner_join_and_never_starts_metadata() {
    let (mut server, reached) = Server::held(true);
    let snap = snapshot(&server.base, ProfileKind::LmStudioLocal, false);
    let (action, reader) = prepare(&snap, false, 2000);
    let mut owner = start(action);
    let reached = reached.recv_timeout(Duration::from_secs(3));
    let before = reader.take_after_join();
    join(&mut *owner);
    let result = reader.take_after_join();
    server.release();
    let requests = server.finish();
    assert!(reached.is_ok());
    assert!(matches!(before, Err(LeaseError::ResourceStopPending)));
    let result = result.unwrap().unwrap();
    assert_eq!(result.failure, Some(HttpFailure::Cancelled));
    assert!(result.receipts.is_empty());
    assert_eq!(result.attempted_requests, 1);
    assert_eq!(requests.len(), 1);
}
#[test]
fn stalled_headers_timeout_and_join_without_exposing_provider_details() {
    let (mut server, reached) = Server::held(false);
    let snap = snapshot(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = prepare(&snap, false, 100);
    let mut owner = start(action);
    let reached = reached.recv_timeout(Duration::from_secs(3));
    wait_for(|| reader.outcome_ready());
    join(&mut *owner);
    let result = reader.take_after_join();
    server.release();
    server.finish();
    assert!(reached.is_ok());
    assert_eq!(result.unwrap().unwrap().failure, Some(HttpFailure::Timeout));
}
#[test]
fn authenticated_factory_uses_the_exact_stored_credential_and_real_stop_fact() {
    let server = Server::start(vec![json(BODY), json(r#"{"models":[]}"#)]);
    let (_root, mut coordinator, snap) = state(&server.base, ProfileKind::LmStudioLocal, true);
    let (action, reader) = coordinator
        .prepare_http_discovery(&snap, Duration::from_millis(500))
        .unwrap();
    let handle = coordinator
        .admit(REQUEST, &snap, ConsumerKind::Discovery, Box::new(action))
        .unwrap();
    wait_for(|| reader.outcome_ready());
    let proof = observed(&mut coordinator, &handle);
    coordinator.release_completed(&handle, &proof).unwrap();
    let result = reader.take_after_join().unwrap().unwrap();
    let requests = server.finish();
    assert_eq!(result.failure, None);
    assert!(requests
        .iter()
        .all(|r| r.headers["authorization"] == "Bearer stored-profile-secret"));
    assert_eq!(
        coordinator.lease_view(&handle).unwrap().status,
        LeaseStatus::Quiescent
    );
}
#[test]
fn foreign_scope_is_rejected_before_creating_an_http_action() {
    let server = Server::start(vec![]);
    let (_root, mut coordinator, mut snap) = state(&server.base, ProfileKind::ActualLocal, false);
    snap.reference.scope.owner_id = "another-owner".into();
    let result = coordinator.prepare_http_discovery(&snap, Duration::from_millis(500));
    assert!(matches!(result, Err(LeaseError::InvalidScope)));
    assert!(server.finish().is_empty());
}
#[test]
fn config_change_between_prepare_and_admit_sends_nothing_from_old_action() {
    let old = Server::start(vec![]);
    let new = Server::start(vec![json(BODY)]);
    let (_root, mut coordinator, snap) = state(&old.base, ProfileKind::ActualLocal, false);
    let (action, reader) = coordinator
        .prepare_http_discovery(&snap, Duration::from_millis(500))
        .unwrap();
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.operation_id = "60000000-0000-4000-8000-000000000099".into();
    put.expected_revision = Some(REVISION.into());
    put.base_url = new.base.clone();
    coordinator
        .configure(ConfigMutation::Put(put), ids())
        .unwrap();
    let result = coordinator.admit(REQUEST, &snap, ConsumerKind::Discovery, Box::new(action));
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("Stale action was admitted"),
    };
    let (_, disposition) = error.into_disposition();
    let old_requests = old.finish();
    assert!(matches!(
        disposition,
        AdmissionDisposition::NeverDispatched(_)
    ));
    assert!(old_requests.is_empty());
    assert!(!reader.outcome_ready());
    let profile = coordinator.profile(PROFILE).unwrap().unwrap();
    let current = runtime::resolve(&scope(), &profile, &reference(&profile), None).unwrap();
    let (action, reader) = coordinator
        .prepare_http_discovery(&current, Duration::from_millis(500))
        .unwrap();
    let handle = coordinator
        .admit(
            "50000000-0000-4000-8000-000000000099",
            &current,
            ConsumerKind::Discovery,
            Box::new(action),
        )
        .unwrap();
    wait_for(|| reader.outcome_ready());
    let proof = observed(&mut coordinator, &handle);
    coordinator.release_completed(&handle, &proof).unwrap();
    assert_eq!(reader.take_after_join().unwrap().unwrap().failure, None);
    assert_eq!(new.finish().len(), 1);
}
#[test]
fn revoked_live_http_owner_cannot_confirm_cleanup_before_its_actual_stop() {
    let (mut server, reached) = Server::held(true);
    let (_root, mut coordinator, snap) = state(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = coordinator
        .prepare_http_discovery(&snap, Duration::from_secs(2))
        .unwrap();
    let handle = coordinator
        .admit(REQUEST, &snap, ConsumerKind::Discovery, Box::new(action))
        .unwrap();
    let reached = reached.recv_timeout(Duration::from_secs(3));
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.operation_id = "60000000-0000-4000-8000-000000000099".into();
    put.expected_revision = Some(REVISION.into());
    put.base_url = server.base.clone();
    let receipt = coordinator
        .configure(ConfigMutation::Put(put), ids())
        .unwrap();
    let proof = observed(&mut coordinator, &handle);
    let confirmed = coordinator
        .acknowledge(&handle, "60000000-0000-4000-8000-000000000099", &proof)
        .unwrap();
    let result = reader.take_after_join();
    server.release();
    server.finish();
    assert!(reached.is_ok());
    assert!(!receipt.cleanup_confirmed);
    assert!(confirmed.cleanup_confirmed);
    assert_eq!(
        result.unwrap().unwrap().failure,
        Some(HttpFailure::Cancelled)
    );
}

// Negative admission controls keep the original no-dispatch token, and a fresh
// correctly paired action must still execute through the same actual owner path.
fn rejected_before_http(
    coordinator: &mut Coordinator,
    snapshot: &EffectiveConnection,
    consumer: ConsumerKind,
    action: HttpDiscoveryAction,
    reader: &OutcomeReader,
) {
    let failure = match coordinator.admit(REQUEST, snapshot, consumer, Box::new(action)) {
        Err(value) => value,
        Ok(_) => panic!("Mismatched HTTP authority admitted"),
    };
    let (error, disposition) = failure.into_disposition();
    assert_eq!(error, LeaseError::ConfigurationChanged);
    let original = match disposition {
        AdmissionDisposition::NeverDispatched(value) => value,
        _ => panic!("No original no-dispatch proof"),
    };
    coordinator
        .verify_never_dispatched(&original, REQUEST, snapshot, consumer)
        .unwrap();
    assert!(coordinator.admission_status(REQUEST).unwrap().is_none());
    assert!(!reader.outcome_ready());
    assert!(matches!(
        reader.take_after_join(),
        Err(LeaseError::ResourceStopPending)
    ));
}
fn complete_http(coordinator: &mut Coordinator, snapshot: &EffectiveConnection) -> HttpOutcome {
    let (action, reader) = coordinator
        .prepare_http_discovery(snapshot, Duration::from_millis(500))
        .unwrap();
    let handle = coordinator
        .admit(REQUEST, snapshot, ConsumerKind::Discovery, Box::new(action))
        .unwrap();
    wait_for(|| reader.outcome_ready());
    let proof = observed(coordinator, &handle);
    coordinator.release_completed(&handle, &proof).unwrap();
    reader.take_after_join().unwrap().unwrap()
}
#[test]
fn prepared_action_cannot_use_another_valid_profile_snapshot() {
    let first = Server::start(vec![json(BODY)]);
    let other = Server::start(vec![]);
    let (_root, mut coordinator, first_snapshot) =
        state(&first.base, ProfileKind::ActualLocal, false);
    let mut put = update(ProfileKind::ActualLocal, AuthChange::None);
    put.operation_id = "60000000-0000-4000-8000-000000000099".into();
    put.profile_id = "10000000-0000-4000-8000-000000000099".into();
    put.base_url = other.base.clone();
    let other_profile_id = put.profile_id.clone();
    coordinator
        .configure(ConfigMutation::Put(put), ids())
        .unwrap();
    let profile = coordinator.profile(&other_profile_id).unwrap().unwrap();
    let other_snapshot = runtime::resolve(&scope(), &profile, &reference(&profile), None).unwrap();
    let (action, reader) = coordinator
        .prepare_http_discovery(&first_snapshot, Duration::from_millis(500))
        .unwrap();
    rejected_before_http(
        &mut coordinator,
        &other_snapshot,
        ConsumerKind::Discovery,
        action,
        &reader,
    );
    assert_eq!(
        complete_http(&mut coordinator, &first_snapshot).failure,
        None
    );
    assert_eq!(first.finish().len(), 1);
    assert!(other.finish().is_empty());
}
#[test]
fn prepared_action_cannot_cross_coordinators_with_identical_snapshot_ids() {
    let server = Server::start(vec![json(BODY), json(r#"{"models":[]}"#)]);
    let (_first_root, mut first, snap) = state_with_secret(
        &server.base,
        ProfileKind::LmStudioLocal,
        true,
        "first-store-secret",
    );
    let (_other_root, mut other, identical) = state_with_secret(
        &server.base,
        ProfileKind::LmStudioLocal,
        true,
        "other-store-secret",
    );
    assert_eq!(snap, identical);
    let (action, reader) = first
        .prepare_http_discovery(&snap, Duration::from_millis(500))
        .unwrap();
    rejected_before_http(
        &mut other,
        &identical,
        ConsumerKind::Discovery,
        action,
        &reader,
    );
    assert_eq!(complete_http(&mut first, &snap).failure, None);
    let requests = server.finish();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|request| request.headers["authorization"] == "Bearer first-store-secret"));
}
#[test]
fn discovery_action_cannot_be_admitted_as_another_consumer() {
    let server = Server::start(vec![json(BODY)]);
    let (_root, mut coordinator, snap) = state(&server.base, ProfileKind::ActualLocal, false);
    let (action, reader) = coordinator
        .prepare_http_discovery(&snap, Duration::from_millis(500))
        .unwrap();
    rejected_before_http(&mut coordinator, &snap, ConsumerKind::Cli, action, &reader);
    assert_eq!(complete_http(&mut coordinator, &snap).failure, None);
    assert_eq!(server.finish().len(), 1);
}
