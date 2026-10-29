use super::integrations::Integrations;
use crate::{
    auth::{issue_access_token, require_auth},
    state::AppState,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use tower::ServiceExt;

async fn configure_mcp(data: &Path, endpoint: &str) {
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data.into(),
        jwt_secret: "lifecycle-fixture".into(),
        ..Default::default()
    })
    .unwrap();
    let router = crate::agent_mcp::routes()
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state);
    let body = json!({"servers":[{
        "id":"fixture", "name":"Owned lifecycle fixture", "enabled":true,
        "timeoutSeconds":3, "transport":{"type":"http","url":endpoint}
    }]});
    let response = router
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/agent/mcp")
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        issue_access_token("lifecycle-fixture", "owner", "owner")
                    ),
                )
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

struct McpFixture {
    endpoint: String,
    first_chunk: Arc<Notify>,
    deletes: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for McpFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl McpFixture {
    async fn start(block_initialize_body: bool) -> Self {
        let first_chunk = Arc::new(Notify::new());
        let deletes = Arc::new(AtomicUsize::new(0));
        let sent = first_chunk.clone();
        let removed = deletes.clone();
        let router =
            Router::new().route(
                "/mcp",
                post(move |Json(request): Json<Value>| {
                    let sent = sent.clone();
                    async move {
                        assert_eq!(request["method"], "initialize");
                        if block_initialize_body {
                            let prefix = format!(
                                "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":",
                                request["id"]
                            );
                            let chunks = stream::once(async move {
                                sent.notify_one();
                                Ok::<_, Infallible>(prefix.into_bytes())
                            })
                            .chain(stream::pending());
                            Response::builder()
                                .status(200)
                                .header("content-type", "application/json")
                                .header("mcp-session-id", "owned-lifecycle-session")
                                .body(Body::from_stream(chunks))
                                .unwrap()
                        } else {
                            ([("mcp-session-id", "owned-lifecycle-session")], Json(json!({
                        "jsonrpc":"2.0", "id":request["id"], "result":{
                            "protocolVersion":"invalid-fixture-version",
                            "serverInfo":{"name":"fixture","version":"1"}, "capabilities":{}
                        }
                    }))).into_response()
                        }
                    }
                })
                .delete(move || {
                    let removed = removed.clone();
                    async move {
                        removed.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint,
            first_chunk,
            deletes,
            server,
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_during_mcp_initialization_awaits_actual_http_session_deletion() {
    let fixture = McpFixture::start(true).await;
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let session = uuid::Uuid::new_v4().to_string();
    configure_mcp(data.path(), &fixture.endpoint).await;
    let mut integrations = Integrations::default();
    let input = json!({"serverId":"fixture"});
    {
        let operation = integrations.dispatch(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "mcp_list_tools",
            &input,
            true,
        );
        tokio::pin!(operation);
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! {
                biased;
                result = &mut operation => panic!("Initialization unexpectedly completed: {:?}", result.err()),
                _ = async {
                    fixture.first_chunk.notified().await;
                    // Let the client consume the received session header while
                    // the fixture deliberately withholds the rest of the body.
                    tokio::time::sleep(Duration::from_millis(30)).await;
                } => {}
            }
        }).await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(3), integrations.close())
        .await
        .unwrap()
        .unwrap();
    // On a single-thread runtime an unawaited Drop cleanup cannot execute
    // between an immediately ready close and this assertion.
    assert_eq!(
        fixture.deletes.load(Ordering::SeqCst),
        1,
        "Explicit shutdown returned before the pending initialized HTTP session was deleted"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_mcp_initialization_closes_its_allocated_http_session_before_returning_error() {
    let fixture = McpFixture::start(false).await;
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let session = uuid::Uuid::new_v4().to_string();
    configure_mcp(data.path(), &fixture.endpoint).await;
    let mut integrations = Integrations::default();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        integrations.dispatch(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "mcp_list_tools",
            &json!({"serverId":"fixture"}),
            true,
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert_eq!(
        fixture.deletes.load(Ordering::SeqCst),
        1,
        "Failed initialization left cleanup scheduled after its error instead of awaiting it"
    );
    integrations.close().await.unwrap();
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn cancelled_standalone_command_future_stops_its_separate_session_tools() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("standalone-command.py");
    let pid_file = root.path().join("tool.pid");
    std::fs::write(&script, r#"
import pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
while True: time.sleep(1)
"#).unwrap();
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let command =
        json!({"command":format!("exec python3 {} {}", quote(&script), quote(&pid_file))});
    let directory = root.path().to_path_buf();
    let running =
        tokio::spawn(async move { super::tools::run_command(&directory, &command, true).await });
    let pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|value| value.parse::<u32>().ok())
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    running.abort();
    assert!(tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .unwrap()
        .unwrap_err()
        .is_cancelled());
    let stopped = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let mut system = sysinfo::System::new();
            system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
                true,
                sysinfo::ProcessRefreshKind::nothing(),
            );
            if system
                .process(sysinfo::Pid::from_u32(pid))
                .is_none_or(|process| process.status() == sysinfo::ProcessStatus::Zombie)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok();
    if !stopped {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    assert!(
        stopped,
        "An approved shell command's separate-session tool survived cancellation of its own future"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn approved_command_drains_large_output_without_waiting_for_its_execution_timeout() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("output-command.py");
    std::fs::write(&script, "import sys\nsys.stdout.write('o' * 1048576)\nsys.stderr.write('e' * 1048576)\nsys.exit(7)\n").unwrap();
    let command = json!({"command":format!("exec python3 '{}'", script.to_string_lossy().replace('\'', "'\\''"))});
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        super::tools::run_command(root.path(), &command, true),
    )
    .await
    .expect("A finite command blocked because its capped output pipes were no longer drained")
    .unwrap();
    let output: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(output["exitCode"], 7);
    assert_eq!(output["truncated"], true);
    assert_eq!(output["stdout"].as_str().unwrap(), "o".repeat(512_000));
    assert_eq!(output["stderr"].as_str().unwrap(), "e".repeat(512_000));
}

struct RetryCleanupFixture {
    endpoint: String,
    delete_started: Arc<Notify>,
    deletes: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for RetryCleanupFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl RetryCleanupFixture {
    async fn start(invalid_initialize: bool, block_first_delete: bool) -> Self {
        let delete_started = Arc::new(Notify::new());
        let deletes = Arc::new(AtomicUsize::new(0));
        let started = delete_started.clone();
        let removed = deletes.clone();
        let router = Router::new().route("/mcp", post(move |Json(request): Json<Value>| async move {
            if request.get("id").is_none() { return StatusCode::ACCEPTED.into_response(); }
            let result = match request["method"].as_str().unwrap() {
                "initialize" => json!({
                    "protocolVersion": if invalid_initialize { "invalid-fixture-version" } else { super::mcp::PROTOCOL_VERSION },
                    "serverInfo":{"name":"retry-fixture","version":"1"}, "capabilities":{"tools":{}}
                }),
                "tools/list" => json!({"tools":[]}),
                other => panic!("Unexpected lifecycle fixture method: {other}"),
            };
            ([("mcp-session-id", "retry-cleanup-session")], Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))).into_response()
        }).delete(move || {
            let started = started.clone(); let removed = removed.clone();
            async move {
                let attempt = removed.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt == 1 {
                    started.notify_one();
                    if block_first_delete { return std::future::pending::<StatusCode>().await; }
                    return StatusCode::INTERNAL_SERVER_ERROR;
                }
                StatusCode::NO_CONTENT
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            endpoint,
            delete_started,
            deletes,
            server,
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn failed_initialization_retains_failed_http_cleanup_for_explicit_retry() {
    let fixture = RetryCleanupFixture::start(true, false).await;
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    configure_mcp(data.path(), &fixture.endpoint).await;
    let mut integrations = Integrations::default();
    let result = integrations
        .dispatch(
            data.path(),
            "owner",
            workspace.path(),
            "session",
            "mcp_list_tools",
            &json!({"serverId":"fixture"}),
            true,
        )
        .await;
    assert!(result.is_err());
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(3), integrations.close())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 2, "Initialization error dropped its failed HTTP cleanup instead of retaining it for awaited retry");
    integrations.close().await.unwrap();
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_stale_connection_cleanup_remains_owned_for_explicit_retry() {
    let fixture = RetryCleanupFixture::start(false, true).await;
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    configure_mcp(data.path(), &fixture.endpoint).await;
    let mut integrations = Integrations::default();
    integrations
        .dispatch(
            data.path(),
            "owner",
            workspace.path(),
            "session",
            "mcp_list_tools",
            &json!({"serverId":"fixture"}),
            true,
        )
        .await
        .unwrap();
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 0);
    configure_mcp(data.path(), &format!("{}/changed", fixture.endpoint)).await;
    {
        let input = json!({});
        let operation = integrations.dispatch(
            data.path(),
            "owner",
            workspace.path(),
            "session",
            "mcp_list_servers",
            &input,
            false,
        );
        tokio::pin!(operation);
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! {
                biased;
                result = &mut operation => panic!("Blocked cleanup unexpectedly returned: {:?}", result.err()),
                _ = fixture.delete_started.notified() => {}
            }
        }).await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(3), integrations.close())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 2, "Cancellation dropped a locally removed connection instead of keeping its HTTP session owned until confirmed cleanup");
    integrations.close().await.unwrap();
    assert_eq!(fixture.deletes.load(Ordering::SeqCst), 2);
}
