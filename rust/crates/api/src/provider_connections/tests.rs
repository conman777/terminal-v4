use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc as channel,
};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;
const PROFILE: &str = "10000000-0000-4000-8000-000000000001";
const JOB: &str = "50000000-0000-4000-8000-000000000001";
const OP: &str = "60000000-0000-4000-8000-000000000001";
fn setup() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: root.path().join("data"),
        jwt_secret: "synthetic-provider-api-secret".into(),
        ..AppConfig::default()
    };
    let state = AppState::new(config).unwrap();
    (root, state)
}
fn input(base: &str) -> Value {
    json!({"operationId":OP,"expectedRevision":null,"provider":"actual","mode":"local","baseUrl":base,"auth":{"type":"none"}})
}
async fn call(
    state: &AppState,
    owner: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(owner) = owner {
        request = request.header(
            "authorization",
            format!(
                "Bearer {}",
                crate::auth::issue_access_token(&state.config().jwt_secret, owner, owner)
            ),
        );
    }
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            body.to_string()
        }
        None => String::new(),
    };
    let response = crate::app(state.clone())
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn put_profile(state: &AppState, base: &str) -> Value {
    let (status, value) = call(
        state,
        Some("owner-A"),
        "PUT",
        &format!("/api/agent/connections/{PROFILE}"),
        Some(input(base)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    value
}
async fn begin(state: &AppState, request: &str) -> Value {
    let (status, value) = call(
        state,
        Some("owner-A"),
        "POST",
        &format!("/api/agent/connections/{PROFILE}/discoveries"),
        Some(json!({"requestId":request})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    value
}
async fn terminal(state: &AppState, request: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        let (status, job) = call(
            state,
            Some("owner-A"),
            "GET",
            &format!("/api/agent/connection-discoveries/{request}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if matches!(
            job["status"].as_str(),
            Some("succeeded" | "empty" | "failed" | "stale" | "cancelled")
        ) && job["cleanupPending"] == false
        {
            return job;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
struct Fixture {
    base: String,
    seen: channel::Receiver<String>,
    release: Option<channel::Sender<()>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<usize>>,
}
impl Fixture {
    fn new(held: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (send, seen) = channel::channel();
        let (release, wait) = channel::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut count = 0;
            while !stopping.load(Ordering::Acquire) && Instant::now() < deadline {
                let mut stream = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture accept {e}"),
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
                count += 1;
                send.send(String::from_utf8(request).unwrap()).unwrap();
                if held {
                    stream.write_all(b"HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nContent-Length: 999\r\nConnection: close\r\n\r\n{").unwrap();
                    let _ = wait.recv_timeout(Duration::from_secs(5));
                } else {
                    let body = r#"{"data":[{"id":"api-owned-synthetic-model"}]}"#;
                    stream.write_all(format!("HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
                }
            }
            count
        });
        Self {
            base,
            seen,
            release: Some(release),
            stop,
            thread: Some(thread),
        }
    }
    fn reached(&self) -> String {
        self.seen.recv_timeout(Duration::from_secs(3)).unwrap()
    }
    fn finish(mut self) -> usize {
        self.stop.store(true, Ordering::Release);
        if let Some(tx) = self.release.take() {
            let _ = tx.send(());
        }
        self.thread.take().unwrap().join().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(tx) = self.release.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[tokio::test]
async fn authentication_precedes_provider_storage_and_no_scope_is_accepted_from_json() {
    let (root, state) = setup();
    assert_eq!(
        call(&state, None, "GET", "/api/agent/connections", None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(!root.path().join("data/provider-connections").exists());
    let mut body = input("http://127.0.0.1:9/v1");
    body["ownerId"] = json!("owner-B");
    assert_eq!(
        call(
            &state,
            Some("owner-A"),
            "PUT",
            &format!("/api/agent/connections/{PROFILE}"),
            Some(body)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &state,
            Some("owner-A"),
            "GET",
            "/api/agent/connections",
            None
        )
        .await
        .1["profiles"],
        json!([])
    );
}
#[tokio::test]
async fn profile_api_is_idempotent_conditional_and_owner_scoped() {
    let (_root, state) = setup();
    let saved = put_profile(&state, "http://127.0.0.1:9/v1").await;
    assert_eq!(put_profile(&state, "http://127.0.0.1:9/v1").await, saved);
    assert_eq!(
        call(
            &state,
            Some("owner-B"),
            "GET",
            "/api/agent/connections",
            None
        )
        .await
        .1["profiles"],
        json!([])
    );
    assert_eq!(
        call(
            &state,
            Some("owner-B"),
            "POST",
            &format!("/api/agent/connections/{PROFILE}/discoveries"),
            Some(json!({"requestId":JOB}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let body = json!({"operationId":"60000000-0000-4000-8000-000000000002","expectedRevision":saved["savedRevision"]});
    assert_eq!(
        call(
            &state,
            Some("owner-A"),
            "DELETE",
            &format!("/api/agent/connections/{PROFILE}"),
            Some(body)
        )
        .await
        .1["deleted"],
        true
    );
    assert_eq!(
        call(
            &state,
            Some("owner-A"),
            "GET",
            "/api/agent/connections",
            None
        )
        .await
        .1["profiles"],
        json!([])
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_api_discovery_uses_one_bound_get_and_keeps_unknown_capabilities() {
    let fixture = Fixture::new(false);
    let (_root, state) = setup();
    put_profile(&state, &fixture.base).await;
    assert!(begin(&state, JOB).await["models"].is_null());
    let job = terminal(&state, JOB).await;
    assert_eq!(job["status"], "succeeded");
    assert_eq!(job["models"][0]["id"], "api-owned-synthetic-model");
    assert!(job["models"][0]["imageInput"].is_null());
    assert_eq!(job["receipt"]["inferenceVerified"], false);
    assert_eq!(begin(&state, JOB).await, job);
    assert_eq!(
        call(
            &state,
            Some("owner-B"),
            "GET",
            &format!("/api/agent/connection-discoveries/{JOB}"),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let request = fixture.reached();
    assert!(request.starts_with("GET /v1/models HTTP/1.1"));
    assert!(!request.to_ascii_lowercase().contains("authorization:"));
    assert!(state.provider_connections().shutdown().await);
    assert_eq!(fixture.finish(), 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_api_cancel_waits_for_original_worker_and_shutdown_finishes() {
    let fixture = Fixture::new(true);
    let (_root, state) = setup();
    put_profile(&state, &fixture.base).await;
    begin(&state, JOB).await;
    fixture.reached();
    let (status, job) = call(
        &state,
        Some("owner-A"),
        "POST",
        &format!("/api/agent/connections/{PROFILE}/discoveries/{JOB}/cancel"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job["cancelConfirmed"], false);
    let job = terminal(&state, JOB).await;
    assert_eq!(job["status"], "cancelled");
    assert_eq!(job["cancelConfirmed"], true);
    assert!(state.provider_connections().shutdown().await);
    assert_eq!(fixture.finish(), 1);
    assert_eq!(
        call(
            &state,
            Some("owner-A"),
            "GET",
            "/api/agent/connections",
            None
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_config_change_stops_old_request_before_activation_and_new_discovery() {
    let old = Fixture::new(true);
    let new = Fixture::new(false);
    let (_root, state) = setup();
    let saved = put_profile(&state, &old.base).await;
    begin(&state, JOB).await;
    old.reached();
    let mut body = input(&new.base);
    body["operationId"] = json!("60000000-0000-4000-8000-000000000002");
    body["expectedRevision"] = saved["savedRevision"].clone();
    let (status, receipt) = call(
        &state,
        Some("owner-A"),
        "PUT",
        &format!("/api/agent/connections/{PROFILE}"),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(receipt["settingsSaved"], true);
    assert_eq!(receipt["cleanupConfirmed"], false);
    assert_eq!(terminal(&state, JOB).await["status"], "stale");
    let (status, receipt) = call(
        &state,
        Some("owner-A"),
        "GET",
        &format!(
            "/api/agent/connections/{PROFILE}/operations/60000000-0000-4000-8000-000000000002"
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(receipt["cleanupConfirmed"], true);
    let next = "50000000-0000-4000-8000-000000000002";
    begin(&state, next).await;
    assert_eq!(terminal(&state, next).await["status"], "succeeded");
    assert!(state.provider_connections().shutdown().await);
    assert_eq!(old.finish(), 1);
    assert_eq!(new.finish(), 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn api_state_reopen_preserves_completed_job_and_profile_without_refetch() {
    let fixture = Fixture::new(false);
    let (_root, state) = setup();
    let config = state.config().clone();
    put_profile(&state, &fixture.base).await;
    begin(&state, JOB).await;
    let original = terminal(&state, JOB).await;
    assert!(state.provider_connections().shutdown().await);
    drop(state);
    let loaded = AppState::new(config).unwrap();
    assert_eq!(
        call(
            &loaded,
            Some("owner-A"),
            "GET",
            &format!("/api/agent/connection-discoveries/{JOB}"),
            None
        )
        .await
        .1,
        original
    );
    assert_eq!(begin(&loaded, JOB).await, original);
    assert!(loaded.provider_connections().shutdown().await);
    assert_eq!(fixture.finish(), 1);
}
#[tokio::test]
async fn oversized_profile_body_is_rejected_before_service_creation() {
    let (root, state) = setup();
    let body = json!({"extra":"x".repeat(70_000)});
    assert_eq!(
        call(
            &state,
            Some("owner-A"),
            "PUT",
            &format!("/api/agent/connections/{PROFILE}"),
            Some(body)
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(!root.path().join("data/provider-connections").exists());
}
#[test]
fn existing_paired_capabilities_do_not_authorize_new_connection_routes() {
    for caps in [
        crate::remote_permissions::Capabilities::observer(),
        crate::remote_permissions::Capabilities::operator(),
    ] {
        for (method, path) in [
            ("GET", "/api/agent/connections"),
            ("PUT", "/api/agent/connections/p"),
            ("GET", "/api/agent/connection-discoveries/r"),
            ("POST", "/api/agent/connections/p/discoveries"),
        ] {
            assert!(!caps.allows_http(method, path));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_itself_cancels_an_active_worker_and_saves_its_terminal_history() {
    let fixture = Fixture::new(true);
    let (_root, state) = setup();
    let config = state.config().clone();
    put_profile(&state, &fixture.base).await;
    begin(&state, JOB).await;
    fixture.reached();
    assert!(state.provider_connections().shutdown().await);
    drop(state);
    let loaded = AppState::new(config).unwrap();
    let (status, job) = call(
        &loaded,
        Some("owner-A"),
        "GET",
        &format!("/api/agent/connection-discoveries/{JOB}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job["status"], "cancelled");
    assert_eq!(job["cancelConfirmed"], true);
    assert_eq!(job["cleanupPending"], false);
    assert!(loaded.provider_connections().shutdown().await);
    assert_eq!(fixture.finish(), 1);
}
