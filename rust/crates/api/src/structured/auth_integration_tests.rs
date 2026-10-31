//! Isolated HTTP-to-provider checks for background-command authority.
use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::post,
    Extension, Json, Router,
};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tower::ServiceExt;

const JWT: &str = "structured-background-fixture-jwt";
const VAULT: &str = "structured-background-fixture-vault";
const OWNER: &str = "synthetic-owner";

async fn issue_raw_operation(
    state: &crate::state::AppState,
    access_token: &str,
    session: &str,
) -> (String, String) {
    let request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/sessions/{session}/input-operation"
        ))
        .header("authorization", format!("Bearer {access_token}"))
        .body(Body::empty())
        .unwrap();
    let response = crate::app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    (
        value["requestId"].as_str().unwrap().into(),
        value["deliveryToken"].as_str().unwrap().into(),
    )
}

struct RawInputFixture {
    _data: tempfile::TempDir,
    _workspace: tempfile::TempDir,
    state: crate::state::AppState,
    manager: StructuredSessionManager,
    owner: String,
    token: String,
    id: String,
    live: Arc<StructuredLiveSession>,
    process: Arc<CountingRawInput>,
}

async fn raw_input_fixture() -> RawInputFixture {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let process = Arc::new(CountingRawInput {
        writes: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    RawInputFixture {
        _data: data,
        _workspace: workspace,
        state,
        manager,
        owner: user.user_id,
        token: login.tokens.access_token,
        id: session.id,
        live,
        process,
    }
}

struct RevokedNativeProbe {
    provider: &'static str,
    spawns: Arc<AtomicUsize>,
}

struct BlockingNativeProbe {
    entered: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

struct LateNativeProbe {
    entered: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    events: std::sync::Mutex<Option<mpsc::UnboundedSender<StructuredSessionEvent>>>,
}

impl StructuredProvider for LateNativeProbe {
    fn provider_id(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        if let Some(entered) = self.entered.lock().unwrap().take() {
            let _ = entered.send(());
        }
        self.release
            .lock()
            .unwrap()
            .recv()
            .map_err(|error| error.to_string())?;
        let (sender, events) = mpsc::unbounded_channel();
        *self.events.lock().unwrap() = Some(sender);
        Ok(SpawnedStructuredProcess {
            controller: Arc::new(CountingRawInput {
                writes: AtomicUsize::new(0),
            }),
            events,
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_native_request_retains_and_registers_late_provider() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let provider = Arc::new(LateNativeProbe {
        entered: std::sync::Mutex::new(Some(entered)),
        release: std::sync::Mutex::new(wait_release),
        events: std::sync::Mutex::new(None),
    });
    let manager =
        StructuredSessionManager::new_with_providers(config.clone(), vec![provider.clone()]);
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let launch = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = user.user_id.clone();
        let id = session.id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "late launch",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    launch.abort();
    let _ = launch.await;
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if live.state.lock().await.process.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let accepted = live.state.lock().await.events.iter().filter(|event| matches!(event, StructuredSessionEvent::MessageCompleted {role, content, ..} if role == "user" && content == "late launch")).count();
    assert_eq!(accepted, 1);
    manager.interrupt(&user.user_id, &session.id).await.unwrap();
    provider.events.lock().unwrap().take();
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn service_shutdown_waits_for_stalled_native_launch() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let provider = Arc::new(LateNativeProbe {
        entered: std::sync::Mutex::new(Some(entered)),
        release: std::sync::Mutex::new(wait_release),
        events: std::sync::Mutex::new(None),
    });
    let manager =
        StructuredSessionManager::new_with_providers(config.clone(), vec![provider.clone()]);
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let launch = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = user.user_id.clone();
        let id = session.id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "launch before cleanup",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    let mut cleanup = tokio::spawn({
        let state = state.clone();
        async move { crate::shutdown_services(&state).await }
    });
    let waited = tokio::time::timeout(Duration::from_millis(200), &mut cleanup)
        .await
        .is_err();
    release.send(()).unwrap();
    cleanup.await.unwrap();
    let _ = launch.await;
    provider.events.lock().unwrap().take();
    assert!(
        waited,
        "cleanup reported completion while native spawn was still blocked"
    );
    assert!(live.state.lock().await.process.is_none());
}

impl StructuredProvider for BlockingNativeProbe {
    fn provider_id(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        if let Some(entered) = self.entered.lock().unwrap().take() {
            let _ = entered.send(());
        }
        let _ = self.release.lock().unwrap().recv();
        Err("synthetic launch ended".into())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_native_launch_does_not_block_another_owner_logout() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(BlockingNativeProbe {
            entered: std::sync::Mutex::new(Some(entered)),
            release: std::sync::Mutex::new(wait_release),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("alice", "fixture-password")
        .unwrap();
    state
        .create_local_user_for_test("bob", "fixture-password")
        .unwrap();
    let alice = state
        .login("alice", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let bob = state
        .login("bob", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &alice.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let launch = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = user.user_id.clone();
        let id = session.id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "synthetic launch",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    let mut logout = tokio::task::spawn_blocking({
        let state = state.clone();
        let owner = bob.user.id.clone();
        move || state.logout_user(&owner)
    });
    let outcome = tokio::time::timeout(Duration::from_millis(300), &mut logout).await;
    let unrelated_completed = matches!(&outcome, Ok(Ok(Ok(()))));
    let timed_out = outcome.is_err();
    release.send(()).unwrap();
    if timed_out {
        let _ = logout.await;
    }
    let _ = launch.await;
    manager.close_owner(&user.user_id).await.unwrap();
    assert!(
        unrelated_completed,
        "another owner's logout did not succeed while the provider spawn was blocked: {outcome:?}"
    );
}

struct PausedRawInput {
    entered: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    release: tokio::sync::Mutex<Option<oneshot::Receiver<()>>>,
    deliveries: AtomicUsize,
}

struct PartialRawInput {
    writes: AtomicUsize,
}

struct CountingRawInput {
    writes: AtomicUsize,
}

#[async_trait]
impl StructuredProcessController for CountingRawInput {
    async fn send_input(&self, _: &str) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn send_input_before_expiry(&self, text: &str, expires_at_ms: i64) -> Result<(), String> {
        if crate::v4_agent::interaction::now_ms() >= expires_at_ms {
            return Err("Credential expired".into());
        }
        self.send_input(text).await
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

#[async_trait]
impl StructuredProcessController for PartialRawInput {
    async fn send_input_before_expiry(&self, text: &str, expires_at_ms: i64) -> Result<(), String> {
        if crate::v4_agent::interaction::now_ms() >= expires_at_ms {
            return Err("Credential expired".into());
        }
        self.send_input(text).await
    }
    async fn send_input(&self, _: &str) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        std::future::pending().await
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

#[async_trait]
impl StructuredProcessController for PausedRawInput {
    async fn send_input_before_expiry(&self, text: &str, expires_at_ms: i64) -> Result<(), String> {
        if crate::v4_agent::interaction::now_ms() >= expires_at_ms {
            return Err("Credential expired".into());
        }
        self.send_input(text).await
    }
    async fn send_input(&self, _: &str) -> Result<(), String> {
        if let Some(entered) = self.entered.lock().unwrap().take() {
            let _ = entered.send(());
        }
        if let Some(release) = self.release.lock().await.take() {
            let _ = release.await;
        }
        self.deliveries.fetch_add(1, Ordering::SeqCst);
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

#[tokio::test]
async fn active_raw_input_finishes_before_local_logout() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let (entered, wait_entered) = oneshot::channel();
    let (release, wait_release) = oneshot::channel();
    let process = Arc::new(PausedRawInput {
        entered: std::sync::Mutex::new(Some(entered)),
        release: tokio::sync::Mutex::new(Some(wait_release)),
        deliveries: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"raw input", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let mut logout = tokio::task::spawn_blocking({
        let state = state.clone();
        let owner = user.user_id.clone();
        move || state.logout_user(&owner)
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut logout)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    assert_eq!(
        response.await.unwrap().unwrap().status(),
        StatusCode::ACCEPTED
    );
    logout.await.unwrap().unwrap();
    assert_eq!(process.deliveries.load(Ordering::SeqCst), 1);
    live.state.lock().await.process = None;
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
async fn supervised_raw_input_survives_caller_cancellation_and_precedes_logout() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let (entered, wait_entered) = oneshot::channel();
    let (release, wait_release) = oneshot::channel();
    let process = Arc::new(PausedRawInput {
        entered: std::sync::Mutex::new(Some(entered)),
        release: tokio::sync::Mutex::new(Some(wait_release)),
        deliveries: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    let (operation, delivery_token) =
        issue_raw_operation(&state, &login.tokens.access_token, &session.id).await;
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/supervised-input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"raw input", "fallbackToMessage":false, "requestId": operation, "deliveryToken": delivery_token})
                .to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    response.abort();
    let logout_request = Request::builder()
        .method("POST")
        .uri("/api/auth/logout")
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    let mut logout = tokio::spawn(crate::app(state.clone()).oneshot(logout_request));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut logout)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    let logout = tokio::time::timeout(Duration::from_secs(5), logout)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(logout.status(), StatusCode::OK);
    assert_eq!(process.deliveries.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .input_receipt(&user.user_id, &session.id, &operation)
            .unwrap()
            .as_deref(),
        Some("delivered")
    );
    assert_eq!(
        state
            .input_receipt("other-owner", &session.id, &operation)
            .unwrap(),
        None
    );
    live.state.lock().await.process = None;
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
async fn supervised_partial_raw_input_reports_uncertainty_and_does_not_retry() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let process = Arc::new(PartialRawInput {
        writes: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    let (operation, delivery_token) =
        issue_raw_operation(&state, &login.tokens.access_token, &session.id).await;
    let request = || {
        Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{}/supervised-input", session.id))
            .header(
                "authorization",
                format!("Bearer {}", login.tokens.access_token),
            )
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"text":"raw input", "fallbackToMessage":false, "requestId": operation, "deliveryToken": delivery_token})
                    .to_string(),
            ))
            .unwrap()
    };
    let response = crate::app(state.clone()).oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("may be partial"));
    assert_eq!(
        state
            .input_receipt(&user.user_id, &session.id, &operation)
            .unwrap()
            .as_deref(),
        Some("uncertain")
    );
    let receipts_request = Request::builder()
        .method("GET")
        .uri(format!(
            "/api/structured/sessions/{}/input-receipts",
            session.id
        ))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    let receipts = crate::app(state.clone())
        .oneshot(receipts_request)
        .await
        .unwrap();
    assert_eq!(receipts.status(), StatusCode::OK);
    let receipts_body = axum::body::to_bytes(receipts.into_body(), 8192)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&receipts_body).unwrap(),
        json!({"receipts": [{"requestId": operation, "status": "uncertain"}]})
    );
    assert_eq!(
        crate::app(state.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(process.writes.load(Ordering::SeqCst), 1);
    live.state.lock().await.process = None;
    manager
        .delete_session(&user.user_id, &session.id)
        .await
        .unwrap();
    let list = Request::builder()
        .method("GET")
        .uri("/api/structured/input-receipts")
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    let list = crate::app(state.clone()).oneshot(list).await.unwrap();
    let body = axum::body::to_bytes(list.into_body(), 8192).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"receipts": [{"sessionId": session.id, "requestId": operation, "status": "uncertain"}], "nextCursor":null})
    );
    let review = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/input-receipts/{}/{}/review",
            session.id, operation
        ))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(state.clone())
            .oneshot(review)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        state
            .input_receipt(&user.user_id, &session.id, &operation)
            .unwrap()
            .as_deref(),
        Some("reviewed")
    );
    let logout = tokio::task::spawn_blocking({
        let state = state.clone();
        let owner = user.user_id.clone();
        move || state.logout_user(&owner)
    })
    .await
    .unwrap();
    assert!(logout.is_ok());
    manager.close_owner(&user.user_id).await.unwrap();
}

#[test]
#[ignore = "subprocess fixture"]
fn supervised_input_logout_process_fixture() {
    let Some(root) = std::env::var_os("V4_INPUT_LOGOUT_ROOT") else {
        return;
    };
    let owner = std::env::var("V4_INPUT_LOGOUT_OWNER").unwrap();
    let root = Path::new(&root);
    let state = crate::state::AppState::new(AppConfig {
        data_dir: root.into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    std::fs::write(root.join("input-logout-ready"), b"ready").unwrap();
    state.logout_user(&owner).unwrap();
    std::fs::write(root.join("input-logout-done"), b"done").unwrap();
}

#[tokio::test]
async fn supervised_raw_input_orders_cross_process_logout() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let (entered, wait_entered) = oneshot::channel();
    let (release, wait_release) = oneshot::channel();
    let process = Arc::new(PausedRawInput {
        entered: std::sync::Mutex::new(Some(entered)),
        release: tokio::sync::Mutex::new(Some(wait_release)),
        deliveries: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"raw input", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::auth_integration_tests::supervised_input_logout_process_fixture",
            "--ignored",
        ])
        .env("V4_INPUT_LOGOUT_ROOT", data.path())
        .env("V4_INPUT_LOGOUT_OWNER", &user.user_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = data.path().join("input-logout-ready");
    let done = data.path().join("input-logout-done");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !ready.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let was_ready = ready.exists();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let completed_early = done.exists();
    let _ = release.send(());
    let _ = response.await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !done.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let completed_after = done.exists();
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert!((was_ready, !completed_early, completed_after) == (true, true, true));
    assert_eq!(process.deliveries.load(Ordering::SeqCst), 1);
    live.state.lock().await.process = None;
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
#[ignore = "subprocess fixture"]
async fn paired_grant_revocation_process_fixture() {
    let Some(root) = std::env::var_os("V4_PAIRED_REVOKE_ROOT") else {
        return;
    };
    let root = std::path::Path::new(&root);
    let token = std::env::var("V4_PAIRED_REVOKE_TOKEN").unwrap();
    let grant = std::env::var("V4_PAIRED_REVOKE_GRANT").unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: root.into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    std::fs::write(root.join("paired-revoke-ready"), b"ready").unwrap();
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = crate::app(state).oneshot(request).await.unwrap();
    std::fs::write(
        root.join("paired-revoke-result"),
        response.status().as_u16().to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn paired_grant_revocation_waits_for_owner_lock_across_processes() {
    let fixture = raw_input_fixture().await;
    let (grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let held = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::auth_integration_tests::paired_grant_revocation_process_fixture",
            "--ignored",
        ])
        .env("V4_PAIRED_REVOKE_ROOT", fixture._data.path())
        .env("V4_PAIRED_REVOKE_TOKEN", &fixture.token)
        .env("V4_PAIRED_REVOKE_GRANT", grant)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = fixture._data.path().join("paired-revoke-ready");
    let result = fixture._data.path().join("paired-revoke-result");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !ready.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let was_ready = ready.exists();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let finished_early = result.exists();
    drop(held);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !result.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let code = std::fs::read_to_string(result).unwrap_or_default();
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert_eq!(
        (was_ready, finished_early, code.as_str()),
        (true, false, "204")
    );
    assert!(crate::paired_environments::authorize_request(
        &fixture.state,
        &paired_token,
        "POST",
        &format!("/api/structured/sessions/{}/input", fixture.id)
    )
    .is_none());
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

struct AcceptingPairedProvider {
    spawns: Arc<AtomicUsize>,
}
impl StructuredProvider for AcceptingPairedProvider {
    fn provider_id(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let (tx, events) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            drop(tx);
        });
        Ok(SpawnedStructuredProcess {
            controller: Arc::new(CountingRawInput {
                writes: AtomicUsize::new(0),
            }),
            events,
        })
    }
}

#[tokio::test]
async fn stalled_paired_snapshots_do_not_exhaust_other_owner_admission() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let spawns = Arc::new(AtomicUsize::new(0));
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(AcceptingPairedProvider {
            spawns: spawns.clone(),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let mut submissions = Vec::new();
    let mut releases = Vec::new();
    let mut owners = Vec::new();
    for index in 0..5 {
        let name = format!("fixture-{index}");
        state
            .create_local_user_for_test(&name, "fixture-password")
            .unwrap();
        let login = state
            .login(&name, "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (user, _) =
            crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token)
                .unwrap();
        let session = manager
            .create_session(
                &user.user_id,
                workspace.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let (_, paired_token) =
            crate::paired_environments::synthetic_input_grant(&state, &user.user_id);
        let pause = if index < 4 {
            Some(manager.inner.turn_starts.pause_next_begin())
        } else {
            None
        };
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{}/message", session.id))
            .header("authorization", format!("Bearer {paired_token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"text":"paired parallel admission", "requestId":Uuid::new_v4().to_string()})
                    .to_string(),
            ))
            .unwrap();
        let task = tokio::spawn(crate::app(state.clone()).oneshot(request));
        owners.push(user.user_id);
        if let Some((entered, release)) = pause {
            tokio::time::timeout(Duration::from_secs(5), entered)
                .await
                .unwrap()
                .unwrap();
            submissions.push(task);
            releases.push(release);
        } else {
            let fifth = tokio::time::timeout(Duration::from_secs(5), task).await;
            for release in releases.drain(..) {
                let _ = release.send(());
            }
            for task in submissions.drain(..) {
                let _ = task.await;
            }
            let response = fifth
                .expect("unrelated paired submission stalled")
                .unwrap()
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::ACCEPTED,
                "unrelated owner lost admission capacity"
            );
        }
    }
    for owner in owners {
        manager.close_owner(&owner).await.unwrap();
    }
}

#[tokio::test]
async fn cancelled_paired_snapshot_does_not_hold_owner_admission() {
    let fixture = raw_input_fixture().await;
    fixture.live.state.lock().await.process = None;
    let (_, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let (entered, release) = fixture.manager.inner.turn_starts.pause_next_begin();
    let input = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/message", fixture.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"cancelled preparation", "requestId":Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let input = tokio::spawn(crate::app(fixture.state.clone()).oneshot(input));
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    input.abort();
    assert!(input.await.unwrap_err().is_cancelled());
    assert!(release.send(()).is_err());
    let exclusive = crate::workspace_activity::exclusive(fixture._workspace.path()).unwrap();
    drop(exclusive);
    let guard = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    drop(guard);
    assert!(!fixture.manager.inner.turn_starts.has_open(&fixture.id));
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_prepared_snapshot_is_rejected_after_session_generation_changes() {
    let fixture = raw_input_fixture().await;
    fixture.live.state.lock().await.process = None;
    let (_, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let (entered, release) = fixture.manager.inner.turn_starts.pause_next_begin();
    let input = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/message", fixture.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"stale prepared message", "requestId":Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let input = tokio::spawn(crate::app(fixture.state.clone()).oneshot(input));
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    fixture.live.state.lock().await.generation += 1;
    release.send(()).unwrap();
    assert_eq!(input.await.unwrap().unwrap().status(), StatusCode::CONFLICT);
    let state = fixture.live.state.lock().await;
    assert!(!state.events.iter().any(|event| matches!(event, StructuredSessionEvent::MessageCompleted { content, .. } if content == "stale prepared message")));
    drop(state);
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

struct PairedDecisionProbe {
    decisions: AtomicUsize,
}
#[async_trait]
impl StructuredProcessController for PairedDecisionProbe {
    async fn send_input(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn send_approval(&self, _: bool) -> Result<(), String> {
        self.decisions.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    #[cfg(unix)]
    async fn send_paired_decision(
        &self,
        id: Option<&str>,
        approved: bool,
        _: Option<Value>,
        _: bool,
        context: Arc<PairedDecisionContext>,
    ) -> Result<DecisionReceipt, String> {
        context.check()?;
        self.send_approval(approved).await?;
        Ok(DecisionReceipt {
            status: "accepted".into(),
            approval_id: id.unwrap_or("").into(),
            approved,
        })
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn kill(&self) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
async fn valid_paired_http_and_websocket_approvals_are_delivered() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    for websocket in [false, true] {
        let fixture = raw_input_fixture().await;
        let process = Arc::new(PairedDecisionProbe {
            decisions: AtomicUsize::new(0),
        });
        fixture.live.state.lock().await.process = Some(process.clone());
        let (_, paired_token) =
            crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
        if websocket {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn({
                let app = crate::app(fixture.state.clone());
                async move { axum::serve(listener, app).await.unwrap() }
            });
            let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
                .into_client_request()
                .unwrap();
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {paired_token}").parse().unwrap(),
            );
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            let request_id = Uuid::new_v4().to_string();
            socket
                .send(Message::Text(
                    json!({"type":"approve", "approved":true, "requestId":request_id})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(Ok(message)) = socket.next().await {
                    if let Message::Text(text) = message {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        if value["requestId"] == request_id {
                            return value["type"].as_str().unwrap_or("").to_owned();
                        }
                    }
                }
                String::new()
            })
            .await
            .unwrap();
            assert_eq!(result, "command_receipt");
            server.abort();
        } else {
            let request = Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{}/approve", fixture.id))
                .header("authorization", format!("Bearer {paired_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"approved":true}).to_string()))
                .unwrap();
            assert_eq!(
                crate::app(fixture.state.clone())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        assert_eq!(process.decisions.load(Ordering::SeqCst), 1);
        fixture.live.state.lock().await.process = None;
        fixture.manager.close_owner(&fixture.owner).await.unwrap();
    }
}

struct CrashApprovalProbe {
    marker: PathBuf,
    before_write: bool,
}
#[async_trait]
impl StructuredProcessController for CrashApprovalProbe {
    async fn send_input(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn send_approval(&self, _: bool) -> Result<(), String> {
        Ok(())
    }
    async fn send_bound_approval(&self, _: &str, _: bool) -> Result<DecisionReceipt, String> {
        if self.before_write {
            std::fs::write(self.marker.with_file_name("before-write"), b"ready")
                .map_err(|error| error.to_string())?;
            return std::future::pending().await;
        }
        std::fs::write(&self.marker, b"written").map_err(|error| error.to_string())?;
        std::future::pending().await
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn kill(&self) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
#[ignore = "subprocess fixture"]
async fn codex_approval_crash_fixture() {
    let Some(root) = std::env::var_os("V4_CODEX_APPROVAL_CRASH_ROOT") else {
        return;
    };
    let root = std::path::Path::new(&root);
    let config = AppConfig {
        data_dir: root.join("data"),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config);
    let id = manager
        .create_session("owner", root.to_str().unwrap(), Some("codex"), None, None)
        .await
        .unwrap()
        .id;
    let approval = Uuid::new_v4().to_string();
    manager
        .record_event_generation(
            "owner",
            &id,
            None,
            StructuredSessionEvent::ApprovalRequired {
                ts: now_ts(),
                seq: 0,
                approval_id: Some(approval.clone()),
                turn_id: Some("turn".into()),
                tool_call_id: Some("tool".into()),
                expires_at: None,
                tool_name: "run_command".into(),
                tool_input: json!({"command":"synthetic"}),
                description: "synthetic".into(),
            },
        )
        .await
        .unwrap();
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    session.state.lock().await.process = Some(Arc::new(CrashApprovalProbe {
        marker: root.join("approval-written"),
        before_write: std::env::var_os("V4_CODEX_CRASH_BEFORE_WRITE").is_some(),
    }));
    std::fs::write(root.join("session-id"), &id).unwrap();
    std::fs::write(root.join("approval-id"), &approval).unwrap();
    let _ = manager
        .approve_bound("owner", &id, Some(&approval), true, None)
        .await;
}

#[tokio::test]
async fn codex_approval_claim_survives_crash_before_write() {
    let root = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::auth_integration_tests::codex_approval_crash_fixture",
            "--ignored",
        ])
        .env("V4_CODEX_APPROVAL_CRASH_ROOT", root.path())
        .env("V4_CODEX_CRASH_BEFORE_WRITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = root.path().join("before-write");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let reached = ready.exists();
    let _ = child.kill();
    let _ = child.wait();
    assert!(reached, "approval fixture did not reach the write boundary");
    assert!(!root.path().join("approval-written").exists());
    let id = std::fs::read_to_string(root.path().join("session-id")).unwrap();
    let approval = std::fs::read_to_string(root.path().join("approval-id")).unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionStarted { approval_id, .. } if approval_id == &approval)));
    assert!(!snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &approval)));
    assert!(manager
        .approve_bound("owner", &id, Some(&approval), true, None)
        .await
        .is_err());
}

#[tokio::test]
async fn codex_approval_claim_survives_crash_after_write_without_replay_or_false_denial() {
    let root = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::auth_integration_tests::codex_approval_crash_fixture",
            "--ignored",
        ])
        .env("V4_CODEX_APPROVAL_CRASH_ROOT", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let marker = root.path().join("approval-written");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !marker.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let written = marker.exists();
    let _ = child.kill();
    let _ = child.wait();
    assert!(written, "approval fixture did not reach its write");
    let id = std::fs::read_to_string(root.path().join("session-id")).unwrap();
    let approval = std::fs::read_to_string(root.path().join("approval-id")).unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionStarted { approval_id, .. } if approval_id == &approval)));
    assert!(!snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &approval)), "uncertain delivery must not be reported as denied");
    assert!(manager
        .approve_bound("owner", &id, Some(&approval), true, None)
        .await
        .is_err());
    assert_eq!(std::fs::read(&marker).unwrap(), b"written");
    let next_turn = manager
        .submit(
            "owner",
            &id,
            "must wait for review",
            Some(&Uuid::new_v4().to_string()),
        )
        .await;
    assert!(
        next_turn.is_err(),
        "an unresolved approval must fence new turns"
    );
    let state = crate::state::AppState::new_with_services(
        AppConfig {
            data_dir: root.path().join("data"),
            jwt_secret: JWT.into(),
            ..Default::default()
        },
        None,
        manager.clone(),
    )
    .unwrap();
    let token = crate::auth::issue_access_token(JWT, "owner", "owner");
    let foreign = crate::auth::issue_access_token(JWT, "foreign", "foreign");
    let path = format!("/api/structured/sessions/{id}/approval-claims/{approval}/review");
    let review = |credential: &str| {
        Request::builder()
            .method("POST")
            .uri(&path)
            .header("authorization", format!("Bearer {credential}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        crate::app(state.clone())
            .oneshot(review(&foreign))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let live = manager.owned_session("owner", &id).await.unwrap().unwrap();
    live.state.lock().await.process = Some(Arc::new(CrashApprovalProbe {
        marker: root.path().join("never-written"),
        before_write: false,
    }));
    let other = Uuid::new_v4().to_string();
    manager
        .record_event_generation(
            "owner",
            &id,
            None,
            StructuredSessionEvent::ApprovalRequired {
                ts: now_ts(),
                seq: 0,
                approval_id: Some(other.clone()),
                turn_id: Some("new-turn".into()),
                tool_call_id: Some("new-tool".into()),
                expires_at: None,
                tool_name: "run_command".into(),
                tool_input: json!({"command":"another"}),
                description: "another".into(),
            },
        )
        .await
        .unwrap();
    let blocked = tokio::time::timeout(
        Duration::from_millis(200),
        manager.approve_bound("owner", &id, Some(&other), true, None),
    )
    .await;
    assert!(
        matches!(blocked, Ok(Err(_))),
        "a second approval must not pass an unresolved claim"
    );
    assert!(!root.path().join("never-written").exists());
    assert_eq!(
        crate::app(state.clone())
            .oneshot(review(&token))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    live.state.lock().await.process = None;
    for _ in 0..2 {
        let response = crate::app(state.clone())
            .oneshot(review(&token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value, json!({"approvalId":approval,"status":"reviewed"}));
    }
    let missing_path = format!("/api/structured/sessions/{id}/approval-claims/{other}/review");
    let missing = Request::builder()
        .method("POST")
        .uri(missing_path)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(state.clone())
            .oneshot(missing)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    live.state.lock().await.process = Some(Arc::new(CrashApprovalProbe {
        marker: root.path().join("never-written"),
        before_write: false,
    }));
    let replay = tokio::time::timeout(
        Duration::from_millis(200),
        manager.approve_bound("owner", &id, Some(&other), true, None),
    )
    .await;
    assert!(
        matches!(replay, Ok(Err(_))),
        "a reviewed missing claim must fence a delayed original request"
    );
    assert!(!root.path().join("never-written").exists());
    live.state.lock().await.process = None;
    let (_, paired) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    assert_eq!(
        crate::app(state.clone())
            .oneshot(review(&paired))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(manager
        .approve_bound("owner", &id, Some(&approval), true, None)
        .await
        .is_err());
    let reviewed = manager.get_session("owner", &id).await.unwrap().unwrap();
    assert!(!unresolved_codex_approval(&reviewed.events));
    assert!(reviewed.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReviewed { approval_id, .. } if approval_id == &approval)));
    assert_eq!(std::fs::read(&marker).unwrap(), b"written");
    drop(live);
    drop(state);
    drop(manager);
    let restarted = StructuredSessionManager::new(AppConfig {
        data_dir: root.path().join("data"),
        ..Default::default()
    });
    let recovered = restarted.get_session("owner", &id).await.unwrap().unwrap();
    assert!(recovered.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReviewed { approval_id, .. } if approval_id == &approval)));
    assert!(recovered.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReviewed { approval_id, .. } if approval_id == &other)));
    assert!(!unresolved_codex_approval(&recovered.events));
    assert!(restarted
        .approve_bound("owner", &id, Some(&approval), true, None)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn claude_permission_rechecks_expiry_after_waiting_for_permission_locks() {
    for for_session in [true, false] {
        let fixture = raw_input_fixture().await;
        let approval = Uuid::new_v4().to_string();
        let (decision, mut receiver) = oneshot::channel();
        fixture
            .manager
            .inner
            .claude_permissions
            .lock()
            .unwrap()
            .insert(
                approval.clone(),
                ClaudePermission {
                    owner: fixture.owner.clone(),
                    session_id: fixture.id.clone(),
                    tool_name: "fixture-tool".into(),
                    decision,
                },
            );
        let (locked, wait_locked) = std::sync::mpsc::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let manager = fixture.manager.clone();
        let holder = std::thread::spawn(move || {
            if for_session {
                let _guard = manager.inner.claude_session_allows.lock().unwrap();
                locked.send(()).unwrap();
                wait_release.recv().unwrap();
            } else {
                let _guard = manager.inner.claude_permissions.lock().unwrap();
                locked.send(()).unwrap();
                wait_release.recv().unwrap();
            }
        });
        wait_locked.recv_timeout(Duration::from_secs(2)).unwrap();
        let (_, initial) =
            crate::auth::authenticate_local_with_authority(&fixture.state, &fixture.token).unwrap();
        let generation = initial.generation_for(&fixture.owner).unwrap();
        let expires = crate::v4_agent::interaction::now_ms() + 1_000;
        let authority = crate::auth::LocalAuthority::for_test(&fixture.owner, generation, expires);
        let (entered, wait_entered) = oneshot::channel();
        *fixture
            .manager
            .inner
            .claude_permission_entered
            .lock()
            .unwrap() = Some(entered);
        let request = {
            let manager = fixture.manager.clone();
            let state = fixture.state.clone();
            let owner = fixture.owner.clone();
            let id = fixture.id.clone();
            let approval = approval.clone();
            tokio::spawn(async move {
                manager
                    .approve_with_paired(
                        &owner,
                        &id,
                        Some(&approval),
                        true,
                        None,
                        for_session,
                        None,
                        Some(&authority),
                        None,
                        &state,
                    )
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(5), wait_entered)
            .await
            .unwrap()
            .unwrap();
        while crate::v4_agent::interaction::now_ms() <= expires {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        release.send(()).unwrap();
        holder.join().unwrap();
        assert!(
            request.await.unwrap().is_err(),
            "session approval: {for_session}"
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(fixture
            .manager
            .inner
            .claude_permissions
            .lock()
            .unwrap()
            .contains_key(&approval));
        assert!(!fixture
            .manager
            .inner
            .claude_session_allows
            .lock()
            .unwrap()
            .get(&fixture.id)
            .is_some_and(|tools| tools.contains("fixture-tool")));
        fixture
            .manager
            .inner
            .claude_permissions
            .lock()
            .unwrap()
            .remove(&approval);
        fixture.live.state.lock().await.process = None;
        fixture.manager.close_owner(&fixture.owner).await.unwrap();
    }
}

#[tokio::test]
async fn claude_session_approval_records_permission_only_after_delivery() {
    let fixture = raw_input_fixture().await;
    let (decision, receiver) = oneshot::channel();
    drop(receiver);
    fixture
        .manager
        .inner
        .claude_permissions
        .lock()
        .unwrap()
        .insert(
            "closed".into(),
            ClaudePermission {
                owner: fixture.owner.clone(),
                session_id: fixture.id.clone(),
                tool_name: "synthetic-tool".into(),
                decision,
            },
        );
    assert!(fixture
        .manager
        .approve_bound_for_session(&fixture.owner, &fixture.id, "closed")
        .await
        .is_err());
    assert!(!fixture
        .manager
        .inner
        .claude_session_allows
        .lock()
        .unwrap()
        .get(&fixture.id)
        .is_some_and(|tools| tools.contains("synthetic-tool")));
    let (decision, receiver) = oneshot::channel();
    fixture
        .manager
        .inner
        .claude_permissions
        .lock()
        .unwrap()
        .insert(
            "live".into(),
            ClaudePermission {
                owner: fixture.owner.clone(),
                session_id: fixture.id.clone(),
                tool_name: "synthetic-tool".into(),
                decision,
            },
        );
    assert_eq!(
        fixture
            .manager
            .approve_bound_for_session(&fixture.owner, &fixture.id, "live")
            .await
            .unwrap()
            .status,
        "accepted"
    );
    assert!(receiver.await.unwrap());
    assert!(fixture
        .manager
        .inner
        .claude_session_allows
        .lock()
        .unwrap()
        .get(&fixture.id)
        .is_some_and(|tools| tools.contains("synthetic-tool")));
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn claude_session_approval_keeps_pending_when_allowlist_lock_is_poisoned() {
    let fixture = raw_input_fixture().await;
    let (decision, mut receiver) = oneshot::channel();
    fixture
        .manager
        .inner
        .claude_permissions
        .lock()
        .unwrap()
        .insert(
            "pending".into(),
            ClaudePermission {
                owner: fixture.owner.clone(),
                session_id: fixture.id.clone(),
                tool_name: "synthetic-tool".into(),
                decision,
            },
        );
    let manager = fixture.manager.clone();
    let _ = std::thread::spawn(move || {
        let _held = manager.inner.claude_session_allows.lock().unwrap();
        panic!("synthetic lock poisoning");
    })
    .join();
    assert!(fixture
        .manager
        .approve_bound_for_session(&fixture.owner, &fixture.id, "pending")
        .await
        .is_err());
    assert!(fixture
        .manager
        .inner
        .claude_permissions
        .lock()
        .unwrap()
        .contains_key("pending"));
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    fixture
        .manager
        .inner
        .claude_permissions
        .lock()
        .unwrap()
        .remove("pending");
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

async fn codex_reservation_fixture() -> (RawInputFixture, String, Arc<PairedDecisionProbe>) {
    let fixture = raw_input_fixture().await;
    let approval = Uuid::new_v4().to_string();
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    {
        let mut state = fixture.live.state.lock().await;
        state.provider = "codex".into();
        state.process = Some(process.clone());
        fixture
            .manager
            .persist_snapshot(
                &fixture.owner,
                &snapshot_from_state(&state),
                state.session_incarnation,
            )
            .unwrap();
    }
    fixture
        .manager
        .record_event_generation(
            &fixture.owner,
            &fixture.id,
            None,
            StructuredSessionEvent::ApprovalRequired {
                ts: now_ts(),
                seq: 0,
                approval_id: Some(approval.clone()),
                turn_id: Some("turn".into()),
                tool_call_id: Some("tool".into()),
                expires_at: None,
                tool_name: "run_command".into(),
                tool_input: json!({}),
                description: "fixture".into(),
            },
        )
        .await
        .unwrap();
    (fixture, approval, process)
}

#[test]
fn unsupported_platform_capability_and_legacy_fence_preserve_protected_history() {
    let reserved = StructuredSessionEvent::ApprovalDecisionReserved {
        ts: 1,
        seq: 1,
        approval_id: "protected".into(),
        turn_id: "turn".into(),
        reservation_id: "reservation".into(),
        token_hash: "hash".into(),
    };
    let reviewed = StructuredSessionEvent::ApprovalDecisionReviewed {
        ts: 2,
        seq: 2,
        approval_id: "protected".into(),
        turn_id: "turn".into(),
    };
    assert_eq!(
        codex_approval_capability("codex", &[], false),
        ("legacy", false)
    );
    assert_eq!(
        codex_approval_capability("codex", std::slice::from_ref(&reserved), false),
        ("recovery_required", true)
    );
    assert!(legacy_codex_approval_fence(
        std::slice::from_ref(&reserved),
        "other"
    ));
    let events = vec![reserved, reviewed];
    assert_eq!(
        codex_approval_capability("codex", &events, false),
        ("legacy", false)
    );
    assert!(legacy_codex_approval_fence(&events, "protected"));
    assert!(!legacy_codex_approval_fence(&events, "other"));
    let mut mixed = events;
    mixed.push(StructuredSessionEvent::ApprovalDecisionStarted {
        ts: 3,
        seq: 3,
        approval_id: "other".into(),
        turn_id: "next".into(),
        approved: true,
        for_session: false,
    });
    assert_eq!(
        codex_approval_capability("codex", &mixed, false),
        ("recovery_required", true)
    );
    mixed.push(StructuredSessionEvent::ApprovalResolved {
        ts: 4,
        seq: 4,
        approval_id: "other".into(),
        turn_id: "next".into(),
        approved: true,
        reason: None,
    });
    assert_eq!(
        codex_approval_capability("codex", &mixed, false),
        ("legacy", false)
    );
    assert!(legacy_codex_approval_fence(&mixed, "other"));
    assert!(!legacy_codex_approval_fence(&mixed, "fresh"));
}

#[tokio::test]
async fn codex_approval_capability_is_owner_scoped_and_available_to_paired_operators() {
    let (fixture, approval, _) = codex_reservation_fixture().await;
    let (_, paired) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let capability = format!(
        "/api/structured/sessions/{}/approval-capability",
        fixture.id
    );
    let request = |token: &str| {
        Request::builder()
            .uri(&capability)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    fixture
        .state
        .create_local_user_for_test("other", "other-password")
        .unwrap();
    let other = fixture
        .state
        .login("other", "other-password")
        .await
        .unwrap()
        .unwrap()
        .tokens
        .access_token;
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(request(&other))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    for token in [&fixture.token, &paired] {
        let response = crate::app(fixture.state.clone())
            .oneshot(request(token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            body,
            json!({"protocol":1,"mode":"reservation","outstanding":false})
        );
    }
    let reserve = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&reserve, Some(&fixture.token), json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(request(&paired))
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"protocol":1,"mode":"reservation","outstanding":true})
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn busy_session_reservation_reports_not_started_without_journaling() {
    let (fixture, approval, _) = codex_reservation_fixture().await;
    let (entered, entered_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    *fixture.manager.inner.approval_reserve_pause.lock().unwrap() = Some((entered, release_rx));
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let request = post_request(&path, Some(&fixture.token), json!({}));
    let request = tokio::spawn(crate::app(fixture.state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), entered_rx)
        .await
        .unwrap()
        .unwrap();
    let guard = fixture.live.state.lock().await;
    release.send(()).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["status"], "not_started");
    assert!(!guard.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReserved { approval_id, .. } if approval_id == &approval)));
    drop(guard);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn saturated_reservation_supervisor_reports_not_started_without_journaling() {
    let (fixture, approval, _) = codex_reservation_fixture().await;
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let mut releases = Vec::new();
    let mut replies = Vec::new();
    for _ in 0..4 {
        let (release, wait_release) = std::sync::mpsc::channel();
        let entered = entered.clone();
        replies.push(
            fixture
                .manager
                .inner
                .native_launches
                .start(move || {
                    entered.send(()).unwrap();
                    wait_release.recv().unwrap();
                })
                .unwrap(),
        );
        releases.push(release);
    }
    for _ in 0..4 {
        wait_entered.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["status"], "not_started");
    let current = fixture.live.state.lock().await;
    assert!(!current.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReserved { approval_id, .. } if approval_id == &approval)));
    drop(current);
    for release in releases {
        release.send(()).unwrap();
    }
    for reply in replies {
        reply.await.unwrap();
    }
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn codex_stop_does_not_fabricate_denial_for_a_reserved_approval() {
    let (fixture, approval, _) = codex_reservation_fixture().await;
    let reserve = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&reserve, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for reason in [
        "Codex turn ended",
        "Codex is no longer waiting for this action",
    ] {
        fixture
            .manager
            .record_event_generation(
                &fixture.owner,
                &fixture.id,
                None,
                StructuredSessionEvent::ApprovalResolved {
                    ts: now_ts(),
                    seq: 0,
                    approval_id: approval.clone(),
                    turn_id: "turn".into(),
                    approved: false,
                    reason: Some(reason.into()),
                },
            )
            .await
            .unwrap();
        let snapshot = fixture
            .manager
            .get_session(&fixture.owner, &fixture.id)
            .await
            .unwrap()
            .unwrap();
        assert!(unresolved_codex_approval(&snapshot.events), "{reason}");
        assert!(!snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &approval)), "{reason}");
    }
    let other = Uuid::new_v4().to_string();
    fixture
        .manager
        .record_event_generation(
            &fixture.owner,
            &fixture.id,
            None,
            StructuredSessionEvent::ApprovalResolved {
                ts: now_ts(),
                seq: 0,
                approval_id: other.clone(),
                turn_id: "other".into(),
                approved: false,
                reason: Some("Codex turn ended".into()),
            },
        )
        .await
        .unwrap();
    let snapshot = fixture
        .manager
        .get_session(&fixture.owner, &fixture.id)
        .await
        .unwrap()
        .unwrap();
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &other)));
    fixture.live.state.lock().await.process = None;
    let review = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/review",
        fixture.id
    );
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&review, Some(&fixture.token), json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn actual_codex_decision_resolves_a_reserved_approval() {
    let (fixture, approval, _) = codex_reservation_fixture().await;
    let reserve = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&reserve, Some(&fixture.token), json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    fixture
        .manager
        .record_event_generation(
            &fixture.owner,
            &fixture.id,
            None,
            StructuredSessionEvent::ApprovalResolved {
                ts: now_ts(),
                seq: 0,
                approval_id: approval.clone(),
                turn_id: "turn".into(),
                approved: false,
                reason: None,
            },
        )
        .await
        .unwrap();
    let snapshot = fixture
        .manager
        .get_session(&fixture.owner, &fixture.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!unresolved_codex_approval(&snapshot.events));
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, reason: None, .. } if approval_id == &approval)));
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn reserved_codex_approval_blocks_other_clients_and_late_dispatch() {
    let (fixture, approval, process) = codex_reservation_fixture().await;
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    let reservation = body["reservationId"].as_str().unwrap();
    let token = body["deliveryToken"].as_str().unwrap();
    assert_eq!(body["approvalId"], approval);
    let approve = format!("/api/structured/sessions/{}/approve", fixture.id);
    let unreserved = crate::app(fixture.state.clone())
        .oneshot(post_request(
            &approve,
            Some(&fixture.token),
            json!({"approvalId":approval,"approved":true}),
        ))
        .await
        .unwrap();
    assert_ne!(unreserved.status(), StatusCode::OK);
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    let review = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/review",
        fixture.id
    );
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&review, Some(&fixture.token), json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    fixture.live.state.lock().await.process = Some(process.clone());
    let late = crate::app(fixture.state.clone())
        .oneshot(post_request(
            &approve,
            Some(&fixture.token),
            json!({"approvalId":approval,"reservationId":reservation,"reservationToken":token,"approved":true}),
        ))
        .await
        .unwrap();
    assert_ne!(late.status(), StatusCode::OK);
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn reserved_codex_approval_dispatches_once_and_hides_delivery_token() {
    let (fixture, approval, process) = codex_reservation_fixture().await;
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    let reservation = body["reservationId"].as_str().unwrap();
    let token = body["deliveryToken"].as_str().unwrap();
    let snapshot = fixture
        .manager
        .get_session(&fixture.owner, &fixture.id)
        .await
        .unwrap()
        .unwrap();
    let history = serde_json::to_string(&snapshot.events).unwrap();
    assert!(!history.contains(token));
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReserved { approval_id, reservation_id, .. } if approval_id == &approval && reservation_id == reservation)));
    let second_reserve = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    assert_ne!(second_reserve.status(), StatusCode::OK);
    let approve = format!("/api/structured/sessions/{}/approve", fixture.id);
    let wrong = crate::app(fixture.state.clone()).oneshot(post_request(&approve, Some(&fixture.token), json!({"approvalId":approval,"reservationId":reservation,"reservationToken":"0".repeat(64),"approved":true}))).await.unwrap();
    assert_ne!(wrong.status(), StatusCode::OK);
    let payload = json!({"approvalId":approval,"reservationId":reservation,"reservationToken":token,"approved":true});
    let first = crate::app(fixture.state.clone()).oneshot(post_request(
        &approve,
        Some(&fixture.token),
        payload.clone(),
    ));
    let second = crate::app(fixture.state.clone()).oneshot(post_request(
        &approve,
        Some(&fixture.token),
        payload,
    ));
    let (first, second) = tokio::join!(first, second);
    let statuses = [first.unwrap().status(), second.unwrap().status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(process.decisions.load(Ordering::SeqCst), 1);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn reserved_codex_session_approval_cannot_be_replayed() {
    let (fixture, approval, process) = codex_reservation_fixture().await;
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    let payload = json!({"approvalId":approval,"reservationId":body["reservationId"],"reservationToken":body["deliveryToken"],"approved":true,"forSession":true});
    let approve = format!("/api/structured/sessions/{}/approve", fixture.id);
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(
                &approve,
                Some(&fixture.token),
                payload.clone()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_ne!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&approve, Some(&fixture.token), payload))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(process.decisions.load(Ordering::SeqCst), 1);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_reservation_dispatch_is_owner_scoped() {
    let (fixture, approval, process) = codex_reservation_fixture().await;
    fixture
        .state
        .create_local_user_for_test("other", "other-password")
        .unwrap();
    let other = fixture
        .state
        .login("other", "other-password")
        .await
        .unwrap()
        .unwrap()
        .tokens
        .access_token;
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&path, Some(&other), json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let (_, paired) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&paired), json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    let approve = format!("/api/structured/sessions/{}/approve", fixture.id);
    let payload = json!({"approvalId":approval,"reservationId":body["reservationId"],"reservationToken":body["deliveryToken"],"approved":true});
    assert_ne!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&approve, Some(&other), payload.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(post_request(&approve, Some(&paired), payload))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(process.decisions.load(Ordering::SeqCst), 1);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn codex_reservation_survives_restart_and_review_fences_its_token() {
    let (fixture, approval, process) = codex_reservation_fixture().await;
    let path = format!(
        "/api/structured/sessions/{}/approval-claims/{approval}/reserve",
        fixture.id
    );
    let response = crate::app(fixture.state.clone())
        .oneshot(post_request(&path, Some(&fixture.token), json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    let reservation = body["reservationId"].as_str().unwrap().to_owned();
    let token = body["deliveryToken"].as_str().unwrap().to_owned();
    let config = fixture.state.config().clone();
    let owner = fixture.owner.clone();
    let access = fixture.token.clone();
    let id = fixture.id.clone();
    fixture
        .manager
        .record_event_generation(
            &owner,
            &id,
            None,
            StructuredSessionEvent::ApprovalResolved {
                ts: now_ts(),
                seq: 0,
                approval_id: approval.clone(),
                turn_id: "turn".into(),
                approved: false,
                reason: Some("Codex turn ended".into()),
            },
        )
        .await
        .unwrap();
    fixture.live.state.lock().await.process = None;
    let RawInputFixture {
        _data: data,
        _workspace: workspace,
        state,
        manager,
        live,
        ..
    } = fixture;
    drop(live);
    drop(manager);
    drop(state);
    let recovered = StructuredSessionManager::new(config.clone());
    let snapshot = recovered.get_session(&owner, &id).await.unwrap().unwrap();
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalDecisionReserved { approval_id, .. } if approval_id == &approval)));
    assert!(!snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &approval)));
    assert!(unresolved_codex_approval(&snapshot.events));
    let recovered_state =
        crate::state::AppState::new_with_services(config, None, recovered.clone()).unwrap();
    let review = format!("/api/structured/sessions/{id}/approval-claims/{approval}/review");
    assert_eq!(
        crate::app(recovered_state.clone())
            .oneshot(post_request(&review, Some(&access), json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let live = recovered.owned_session(&owner, &id).await.unwrap().unwrap();
    live.state.lock().await.process = Some(process.clone());
    let approve = format!("/api/structured/sessions/{id}/approve");
    let late = crate::app(recovered_state.clone()).oneshot(post_request(&approve, Some(&access), json!({"approvalId":approval,"reservationId":reservation,"reservationToken":token,"approved":true}))).await.unwrap();
    assert_ne!(late.status(), StatusCode::OK);
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    live.state.lock().await.process = None;
    recovered.close_owner(&owner).await.unwrap();
    drop((data, workspace));
}

#[tokio::test]
async fn valid_local_http_approval_is_delivered() {
    let fixture = raw_input_fixture().await;
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(process.clone());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/approve", fixture.id))
        .header("authorization", format!("Bearer {}", fixture.token))
        .header("content-type", "application/json")
        .body(Body::from(json!({"approved":true}).to_string()))
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(process.decisions.load(Ordering::SeqCst), 1);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn local_http_approval_is_not_delivered_after_logout() {
    let fixture = raw_input_fixture().await;
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(process.clone());
    let held = fixture.live.state.lock().await;
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/approve", fixture.id))
        .header("authorization", format!("Bearer {}", fixture.token))
        .header("content-type", "application/json")
        .body(Body::from(json!({"approved":true}).to_string()))
        .unwrap();
    let decision = tokio::spawn(crate::app(fixture.state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    fixture.state.logout_user(&fixture.owner).unwrap();
    drop(held);
    assert_ne!(decision.await.unwrap().unwrap().status(), StatusCode::OK);
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn local_approval_rechecks_expiry_after_waiting_for_owner_lock() {
    let fixture = raw_input_fixture().await;
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(process.clone());
    let (_, initial) =
        crate::auth::authenticate_local_with_authority(&fixture.state, &fixture.token).unwrap();
    let generation = initial.generation_for(&fixture.owner).unwrap();
    let expires = crate::v4_agent::interaction::now_ms() + 150;
    let authority = crate::auth::LocalAuthority::for_test(&fixture.owner, generation, expires);
    let held = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let decision = {
        let manager = fixture.manager.clone();
        let state = fixture.state.clone();
        let owner = fixture.owner.clone();
        let id = fixture.id.clone();
        tokio::spawn(async move {
            manager
                .approve_with_paired(
                    &owner,
                    &id,
                    None,
                    true,
                    None,
                    false,
                    None,
                    Some(&authority),
                    None,
                    &state,
                )
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    while crate::v4_agent::interaction::now_ms() <= expires {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    drop(held);
    assert!(decision.await.unwrap().is_err());
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn local_websocket_approval_is_not_delivered_after_logout() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let fixture = raw_input_fixture().await;
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(process.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::app(fixture.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", fixture.token).parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let held = fixture.live.state.lock().await;
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({"type":"approve", "approved":true, "requestId":request_id})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    fixture.state.logout_user(&fixture.owner).unwrap();
    drop(held);
    let reply = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value["requestId"] == request_id {
                    return value;
                }
            }
        }
        panic!("missing approval reply")
    })
    .await
    .unwrap();
    assert_ne!(reply["status"], "accepted");
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    server.abort();
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_http_approval_is_not_delivered_after_revocation() {
    let fixture = raw_input_fixture().await;
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(process.clone());
    let (grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let held = fixture.live.state.lock().await;
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let decision = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/approve", fixture.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(json!({"approved":true}).to_string()))
        .unwrap();
    let decision = tokio::spawn(crate::app(fixture.state.clone()).oneshot(decision));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let revoke = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(revoke)
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    drop(held);
    assert_ne!(decision.await.unwrap().unwrap().status(), StatusCode::OK);
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_websocket_approval_is_not_delivered_after_revocation() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let fixture = raw_input_fixture().await;
    let process = Arc::new(PairedDecisionProbe {
        decisions: AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(process.clone());
    let (grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::app(fixture.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {paired_token}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let held = fixture.live.state.lock().await;
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({"type":"approve", "approved":true, "requestId":request_id})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let revoke = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(revoke)
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    drop(held);
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message {
                if serde_json::from_str::<Value>(&text)
                    .ok()
                    .is_some_and(|value| value["requestId"] == request_id)
                {
                    break;
                }
            }
        }
    })
    .await;
    assert_eq!(process.decisions.load(Ordering::SeqCst), 0);
    server.abort();
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_snapshot_does_not_delay_grant_revocation() {
    let fixture = raw_input_fixture().await;
    fixture.live.state.lock().await.process = None;
    let (grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let (entered, release) = fixture.manager.inner.turn_starts.pause_next_begin();
    let input = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/message", fixture.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"snapshot-paused message", "requestId":Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let input = tokio::spawn(crate::app(fixture.state.clone()).oneshot(input));
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    let revoke = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    let mut revoke = tokio::spawn(crate::app(fixture.state.clone()).oneshot(revoke));
    let early = tokio::time::timeout(Duration::from_millis(500), &mut revoke).await;
    release.send(()).unwrap();
    let completed_early = early.is_ok();
    let response = match early {
        Ok(result) => result.unwrap().unwrap(),
        Err(_) => revoke.await.unwrap().unwrap(),
    };
    let input = input.await.unwrap().unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(completed_early, "grant revocation waited for the snapshot");
    assert_ne!(input.status(), StatusCode::ACCEPTED);
    let state = fixture.live.state.lock().await;
    assert!(!state.events.iter().any(|event| matches!(event, StructuredSessionEvent::MessageCompleted { content, .. } if content == "snapshot-paused message")));
    drop(state);
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn valid_paired_http_and_websocket_messages_are_accepted() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    for websocket in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: JWT.into(),
            ..Default::default()
        };
        let spawns = Arc::new(AtomicUsize::new(0));
        let manager = StructuredSessionManager::new_with_providers(
            config.clone(),
            vec![Arc::new(AcceptingPairedProvider {
                spawns: spawns.clone(),
            })],
        );
        let state =
            crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (user, _) =
            crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token)
                .unwrap();
        let session = manager
            .create_session(
                &user.user_id,
                workspace.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let (_, paired_token) =
            crate::paired_environments::synthetic_input_grant(&state, &user.user_id);
        let request_id = Uuid::new_v4().to_string();
        if websocket {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn({
                let app = crate::app(state.clone());
                async move { axum::serve(listener, app).await.unwrap() }
            });
            let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", session.id)
                .into_client_request()
                .unwrap();
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {paired_token}").parse().unwrap(),
            );
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            socket.send(Message::Text(json!({"type":"message", "text":"valid paired message", "requestId":request_id}).to_string().into())).await.unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(Ok(message)) = socket.next().await {
                    if let Message::Text(text) = message {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        if value["requestId"] == request_id {
                            return value["type"].as_str().unwrap_or("").to_owned();
                        }
                    }
                }
                String::new()
            })
            .await
            .unwrap();
            assert_eq!(result, "command_receipt");
            server.abort();
        } else {
            let request = Request::builder()
                .method("POST")
                .uri(format!("/api/structured/sessions/{}/message", session.id))
                .header("authorization", format!("Bearer {paired_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"text":"valid paired message", "requestId":request_id}).to_string(),
                ))
                .unwrap();
            assert_eq!(
                crate::app(state.clone())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::ACCEPTED
            );
        }
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        manager.close_owner(&user.user_id).await.unwrap();
    }
}

#[tokio::test]
async fn paired_http_message_and_fallback_reject_after_revocation_while_session_locked() {
    for fallback in [false, true] {
        let fixture = raw_input_fixture().await;
        fixture.live.state.lock().await.process = None;
        let (grant, paired_token) =
            crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
        let held = fixture.live.state.lock().await;
        let (entered, wait_entered) = oneshot::channel();
        *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
        let path = if fallback {
            format!("/api/structured/sessions/{}/input", fixture.id)
        } else {
            format!("/api/structured/sessions/{}/message", fixture.id)
        };
        let mut body = json!({"text":"revoked message", "requestId":Uuid::new_v4().to_string()});
        if fallback {
            body["fallbackToMessage"] = json!(true);
        }
        let input = Request::builder()
            .method("POST")
            .uri(path)
            .header("authorization", format!("Bearer {paired_token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let input = tokio::spawn(crate::app(fixture.state.clone()).oneshot(input));
        tokio::time::timeout(Duration::from_secs(5), wait_entered)
            .await
            .unwrap()
            .unwrap();
        let revoke = Request::builder()
            .method("DELETE")
            .uri(format!("/api/environments/grants/{grant}"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            crate::app(fixture.state.clone())
                .oneshot(revoke)
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        drop(held);
        let response = input.await.unwrap().unwrap();
        assert_ne!(response.status(), StatusCode::ACCEPTED);
        let state = fixture.live.state.lock().await;
        assert!(!state.events.iter().any(|event| matches!(event, StructuredSessionEvent::MessageCompleted { content, .. } if content == "revoked message")));
        drop(state);
        fixture.manager.close_owner(&fixture.owner).await.unwrap();
    }
}

#[tokio::test]
async fn paired_codex_and_v4_messages_reject_after_revocation_while_session_locked() {
    for provider in ["codex", "deepseek"] {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: JWT.into(),
            ..Default::default()
        };
        let spawns = Arc::new(AtomicUsize::new(0));
        let manager = StructuredSessionManager::new_with_providers(
            config.clone(),
            vec![Arc::new(RevokedNativeProbe {
                provider: "codex",
                spawns: spawns.clone(),
            })],
        );
        let state =
            crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (user, _) =
            crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token)
                .unwrap();
        let session = manager
            .create_session(
                &user.user_id,
                workspace.path().to_str().unwrap(),
                Some(provider),
                if provider == "deepseek" {
                    Some("deepseek-chat")
                } else {
                    None
                },
                None,
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&session.id)
            .unwrap()
            .clone();
        let (grant, paired_token) =
            crate::paired_environments::synthetic_input_grant(&state, &user.user_id);
        let held = live.state.lock().await;
        let (entered, wait_entered) = oneshot::channel();
        *manager.inner.get_session_entered.lock().unwrap() = Some(entered);
        let input = Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{}/message", session.id))
            .header("authorization", format!("Bearer {paired_token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"text":"revoked provider message", "requestId":Uuid::new_v4().to_string()})
                    .to_string(),
            ))
            .unwrap();
        let input = tokio::spawn(crate::app(state.clone()).oneshot(input));
        tokio::time::timeout(Duration::from_secs(5), wait_entered)
            .await
            .unwrap()
            .unwrap();
        let revoke = Request::builder()
            .method("DELETE")
            .uri(format!("/api/environments/grants/{grant}"))
            .header(
                "authorization",
                format!("Bearer {}", login.tokens.access_token),
            )
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            crate::app(state.clone())
                .oneshot(revoke)
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        drop(held);
        assert_ne!(input.await.unwrap().unwrap().status(), StatusCode::ACCEPTED);
        let live_state = live.state.lock().await;
        assert!(!live_state.events.iter().any(|event| matches!(event, StructuredSessionEvent::UserMessageAccepted { content, .. } if content == "revoked provider message")), "{provider}");
        drop(live_state);
        assert_eq!(spawns.load(Ordering::SeqCst), 0);
        manager.close_owner(&user.user_id).await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_v4_message_expires_between_validation_and_capture_without_publication() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let session = manager
        .create_session(
            &user.id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let before = manager
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    let (grant, paired_token) = crate::paired_environments::synthetic_input_grant(&state, &user.id);
    let expires = time::OffsetDateTime::now_utc().unix_timestamp() + 3;
    state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_grants SET expires=?1 WHERE id=?2",
            rusqlite::params![expires, grant],
        )
        .unwrap();
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    *manager.inner.v4_before_paired_capture.lock().unwrap() = Some((entered, wait_release));
    struct Release(Option<std::sync::mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let mut release = Release(Some(release));
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/message", session.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"must not be accepted", "requestId":Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let request = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(8)))
        .await
        .unwrap()
        .unwrap();
    let remaining = (expires * 1000 - crate::v4_agent::interaction::now_ms()).max(0) as u64;
    tokio::time::sleep(Duration::from_millis(remaining + 50)).await;
    release.0.take().unwrap().send(()).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(8), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_ne!(response.status(), StatusCode::ACCEPTED);
    let after = manager
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(after.events).unwrap(),
        serde_json::to_value(&before.events).unwrap()
    );
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_v4_valid_grant_publishes_message() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let session = manager
        .create_session(
            &user.id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let (_, paired_token) = crate::paired_environments::synthetic_input_grant(&state, &user.id);
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/message", session.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"valid paired message", "requestId":Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(8), crate::app(state).oneshot(request))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let after = manager
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    assert!(after.events.iter().any(|event| matches!(event, StructuredSessionEvent::UserMessageAccepted { content, .. } if content == "valid paired message")));
    manager.close_owner(&user.id).await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_v4_grant_expiring_at_checkpoint_prevents_publication() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let session = manager
        .create_session(
            &user.id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let before = manager
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    let config = state.config().clone();
    let checkpoint_path = structured_session_path(&config, &user.id, &session.id);
    let checkpoint_before = std::fs::read(&checkpoint_path).unwrap();
    let (grant, paired_token) = crate::paired_environments::synthetic_input_grant(&state, &user.id);
    let expires = time::OffsetDateTime::now_utc().unix_timestamp() + 3;
    state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_grants SET expires=?1 WHERE id=?2",
            rusqlite::params![expires, grant],
        )
        .unwrap();
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    *manager.inner.checkpoint_before_publication.lock().unwrap() = Some((entered, wait_release));
    struct Release(Option<std::sync::mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let mut release = Release(Some(release));
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/message", session.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"must not be accepted", "requestId":Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let request = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(8)))
        .await
        .unwrap()
        .unwrap();
    let remaining = (expires * 1000 - crate::v4_agent::interaction::now_ms()).max(0) as u64;
    tokio::time::sleep(Duration::from_millis(remaining + 50)).await;
    release.0.take().unwrap().send(()).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(8), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_ne!(response.status(), StatusCode::ACCEPTED);
    let after = manager
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(after.events).unwrap(),
        serde_json::to_value(&before.events).unwrap()
    );
    assert_eq!(std::fs::read(checkpoint_path).unwrap(), checkpoint_before);
    manager.shutdown().await.unwrap();
    drop(state);
    drop(manager);
    let reopened = StructuredSessionManager::new(config);
    let restored = reopened
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(restored.events).unwrap(),
        serde_json::to_value(before.events).unwrap()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_revocation_waits_for_checkpoint_and_blocks_later_messages() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let user = state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let local = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let session = manager
        .create_session(
            &user.id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, &user.id);
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    *manager.inner.checkpoint_before_publication.lock().unwrap() = Some((entered, wait_release));
    struct Release(Option<std::sync::mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let mut release = Release(Some(release));
    let make_message = |text: &str| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{}/message", session.id))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"text":text,"requestId":Uuid::new_v4().to_string()}).to_string(),
            ))
            .unwrap()
    };
    let first = tokio::spawn(crate::app(state.clone()).oneshot(make_message("before revocation")));
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(8)))
        .await
        .unwrap()
        .unwrap();
    assert!(
        state.try_acquire_input_guard(&user.id).is_err(),
        "publication retains the owner guard"
    );
    let revoke_request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header(
            "authorization",
            format!("Bearer {}", local.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    let (started, wait_started) = tokio::sync::oneshot::channel();
    let revoke_state = state.clone();
    let revoke = tokio::spawn(async move {
        let _ = started.send(());
        crate::app(revoke_state).oneshot(revoke_request).await
    });
    wait_started.await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !revoke.is_finished(),
        "revocation must wait until publication releases the owner guard"
    );
    release.0.take().unwrap().send(()).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(8), first)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let revoke = tokio::time::timeout(Duration::from_secs(8), revoke)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);
    let after_revoke = crate::app(state)
        .oneshot(make_message("after revocation"))
        .await
        .unwrap();
    assert_ne!(after_revoke.status(), StatusCode::ACCEPTED);
    let snapshot = manager
        .get_session(&user.id, &session.id)
        .await
        .unwrap()
        .unwrap();
    let accepted: Vec<&str> = snapshot
        .events
        .iter()
        .filter_map(|event| match event {
            StructuredSessionEvent::UserMessageAccepted { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(accepted, vec!["before revocation"]);
    manager.close_owner(&user.id).await.unwrap();
}

#[tokio::test]
async fn paired_websocket_message_rejects_after_revocation_while_session_locked() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let fixture = raw_input_fixture().await;
    fixture.live.state.lock().await.process = None;
    let (grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::app(fixture.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {paired_token}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let held = fixture.live.state.lock().await;
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({"type":"message", "text":"revoked websocket", "requestId":request_id})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let revoke = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(revoke)
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    drop(held);
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message {
                if serde_json::from_str::<Value>(&text)
                    .ok()
                    .is_some_and(|value| value["requestId"] == request_id)
                {
                    break;
                }
            }
        }
    })
    .await;
    let state = fixture.live.state.lock().await;
    assert!(!state.events.iter().any(|event| matches!(event, StructuredSessionEvent::MessageCompleted { content, .. } if content == "revoked websocket")));
    drop(state);
    server.abort();
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_raw_input_is_ordered_with_grant_revocation() {
    let fixture = raw_input_fixture().await;
    let (grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let held = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.input_waiting_owner.lock().unwrap() = Some(entered);
    let input = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", fixture.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"paired", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    let input = tokio::spawn(crate::app(fixture.state.clone()).oneshot(input));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let revoke = Request::builder()
        .method("DELETE")
        .uri(format!("/api/environments/grants/{grant}"))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    let revoke = tokio::spawn({
        let app = crate::app(fixture.state.clone());
        let process = fixture.process.clone();
        async move {
            let response = app.oneshot(revoke).await.unwrap();
            (response.status(), process.writes.load(Ordering::SeqCst))
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(held);
    let (revoked, writes_when_revoked) = revoke.await.unwrap();
    let _ = input.await.unwrap().unwrap();
    assert_eq!(revoked, StatusCode::NO_CONTENT);
    assert_eq!(
        fixture.process.writes.load(Ordering::SeqCst),
        writes_when_revoked,
        "paired input must not be delivered after revocation"
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_raw_input_is_ordered_with_grant_release() {
    let fixture = raw_input_fixture().await;
    let (_grant, paired_token) =
        crate::paired_environments::synthetic_input_grant(&fixture.state, &fixture.owner);
    let held = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.input_waiting_owner.lock().unwrap() = Some(entered);
    let input = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", fixture.id))
        .header("authorization", format!("Bearer {paired_token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"paired", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    let input = tokio::spawn(crate::app(fixture.state.clone()).oneshot(input));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let revoke = Request::builder()
        .method("POST")
        .uri("/api/environments/release")
        .header("authorization", format!("Bearer {paired_token}"))
        .body(Body::empty())
        .unwrap();
    let revoke = tokio::spawn({
        let app = crate::app(fixture.state.clone());
        let process = fixture.process.clone();
        async move {
            let response = app.oneshot(revoke).await.unwrap();
            (response.status(), process.writes.load(Ordering::SeqCst))
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(held);
    let (revoked, writes_when_revoked) = revoke.await.unwrap();
    let _ = input.await.unwrap().unwrap();
    assert_eq!(revoked, StatusCode::NO_CONTENT);
    assert_eq!(
        fixture.process.writes.load(Ordering::SeqCst),
        writes_when_revoked,
        "paired input must not be delivered after revocation"
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn uninstalled_raw_input_orders_cross_process_logout() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let (entered, wait_entered) = oneshot::channel();
    let (release, wait_release) = oneshot::channel();
    let process = Arc::new(PausedRawInput {
        entered: std::sync::Mutex::new(Some(entered)),
        release: tokio::sync::Mutex::new(Some(wait_release)),
        deliveries: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"raw input", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::auth_integration_tests::supervised_input_logout_process_fixture",
            "--ignored",
        ])
        .env("V4_INPUT_LOGOUT_ROOT", data.path())
        .env("V4_INPUT_LOGOUT_OWNER", &user.user_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = data.path().join("input-logout-ready");
    let done = data.path().join("input-logout-done");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !ready.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let was_ready = ready.exists();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let completed_early = done.exists();
    let _ = release.send(());
    let _ = response.await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !done.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let completed_after = done.exists();
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert!((was_ready, !completed_early, completed_after) == (true, true, true));
    assert_eq!(process.deliveries.load(Ordering::SeqCst), 1);
    live.state.lock().await.process = None;
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
async fn default_off_app_state_honors_installed_input_owner_lock() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let first = crate::state::AppState::new(config.clone()).unwrap();
    let second = crate::state::AppState::new(config).unwrap();
    first.enable_supervised_input_for_test();
    assert!(!second.supervised_input_enabled());
    let guard = first.acquire_input_guard("fixture-owner").unwrap();
    let mut logout = tokio::task::spawn_blocking(move || second.logout_user("fixture-owner"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut logout)
            .await
            .is_err()
    );
    drop(guard);
    tokio::time::timeout(Duration::from_secs(5), logout)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_installation_cannot_overtake_logout_marker_check() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let first = crate::state::AppState::new(config.clone()).unwrap();
    let second = crate::state::AppState::new(config).unwrap();
    let (entered, release) = first.pause_logout_marker_for_test();
    let logout = tokio::task::spawn_blocking(move || first.logout_user("fixture-owner"));
    tokio::task::spawn_blocking(move || entered.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    let mut installation = tokio::task::spawn_blocking({
        let second = second.clone();
        move || second.enable_supervised_input_for_test()
    });
    let blocked = tokio::time::timeout(Duration::from_millis(100), &mut installation)
        .await
        .is_err();
    release.send(()).unwrap();
    logout.await.unwrap().unwrap();
    if blocked {
        installation.await.unwrap();
    }
    assert!(blocked);
    assert!(second.supervised_input_enabled());
}

#[tokio::test]
async fn legacy_local_input_rechecks_expiry_after_native_stdin_lock() {
    let fixture = raw_input_fixture().await;
    let disabled = crate::state::AppState::new(fixture.state.config().clone()).unwrap();
    let (_, original) =
        crate::auth::authenticate_local_with_authority(&disabled, &fixture.token).unwrap();
    let (generation, _) = original
        .valid_for(&fixture.owner, crate::v4_agent::interaction::now_ms())
        .unwrap();
    let expires = crate::v4_agent::interaction::now_ms() + 1_200;
    let authority = crate::auth::LocalAuthority::for_test(&fixture.owner, generation, expires);
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args(["-c", "exec /bin/cat > captured-expiry-input"])
        .current_dir(fixture._workspace.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn().unwrap();
    let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child).unwrap();
    let stdin = child.stdin.take();
    let controller = Arc::new(ClaudeStructuredProcessController {
        child: Arc::new(Mutex::new(child)),
        stdin: Mutex::new(stdin),
        interrupted: Arc::new(AtomicBool::new(false)),
        tree,
        blocked: AtomicBool::new(false),
        browser: Mutex::new(None),
    });
    fixture.live.state.lock().await.process = Some(controller.clone());
    let held_stdin = controller.stdin.lock().await;
    let task = tokio::spawn({
        let manager = fixture.manager.clone();
        let state = disabled.clone();
        let owner = fixture.owner.clone();
        let session = fixture.id.clone();
        async move {
            manager
                .send_input_with_authority(
                    &owner,
                    &session,
                    "late input",
                    false,
                    None,
                    None,
                    Some(&authority),
                    None,
                    Some(&state),
                )
                .await
        }
    });
    tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            if fixture.live.state.try_lock().is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("input did not reach native stdin while the mutex was held");
    while crate::v4_agent::interaction::now_ms() < expires {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(held_stdin);
    let result = task.await.unwrap();
    assert!(result.is_err(), "expired input was accepted");
    controller.kill().await.unwrap();
    assert_eq!(
        std::fs::read(fixture._workspace.path().join("captured-expiry-input")).unwrap_or_default(),
        b""
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn supervised_input_rechecks_expiry_after_claim_before_write() {
    let fixture = raw_input_fixture().await;
    let (_, original) =
        crate::auth::authenticate_local_with_authority(&fixture.state, &fixture.token).unwrap();
    let (generation, _) = original
        .valid_for(&fixture.owner, crate::v4_agent::interaction::now_ms())
        .unwrap();
    let authority = crate::auth::LocalAuthority::for_test(
        &fixture.owner,
        generation,
        crate::v4_agent::interaction::now_ms() + 300,
    );
    let (entered, wait_entered) = oneshot::channel();
    let (release, wait_release) = oneshot::channel();
    *fixture.manager.inner.input_claim_pause.lock().unwrap() = Some((entered, wait_release));
    let task = tokio::spawn({
        let manager = fixture.manager.clone();
        let state = fixture.state.clone();
        let owner = fixture.owner.clone();
        let id = fixture.id.clone();
        async move {
            manager
                .send_input_with_authority(
                    &owner,
                    &id,
                    "raw input",
                    false,
                    None,
                    None,
                    Some(&authority),
                    None,
                    Some(&state),
                )
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    release.send(()).unwrap();
    assert!(task.await.unwrap().is_err());
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn issued_raw_input_token_rejects_a_new_process_generation() {
    let fixture = raw_input_fixture().await;
    let (operation, token) = issue_raw_operation(&fixture.state, &fixture.token, &fixture.id).await;
    fixture.live.state.lock().await.generation += 1;
    let request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/sessions/{}/supervised-input",
            fixture.id
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"input", "fallbackToMessage":false, "requestId":operation, "deliveryToken":token}).to_string(),
        ))
        .unwrap();
    let response = crate::app(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn paired_style_router_cannot_use_supervised_route_without_local_authority() {
    let fixture = raw_input_fixture().await;
    let router = Router::new()
        .route(
            "/api/structured/sessions/{id}/supervised-input",
            post(crate::send_supervised_input),
        )
        .layer(Extension(crate::auth::AuthenticatedUser {
            user_id: fixture.owner.clone(),
            username: "paired-fixture".into(),
        }))
        .with_state(fixture.state.clone());
    let request = Request::builder().method("POST").uri(format!("/api/structured/sessions/{}/supervised-input", fixture.id)).header("content-type", "application/json").body(Body::from(json!({"text":"input", "fallbackToMessage":false, "requestId":Uuid::new_v4(), "deliveryToken":"fabricated"}).to_string())).unwrap();
    assert_eq!(
        router.oneshot(request).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .state
            .list_unresolved_input_receipts(&fixture.owner, 0)
            .unwrap(),
        (Vec::new(), None)
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn input_watermark_requires_local_authority_and_returns_owner_floor() {
    let fixture = raw_input_fixture().await;
    let request = Request::builder()
        .uri("/api/structured/input-watermark")
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    let response = crate::app(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["protocol"], 1);
    let floor = value["rejectBefore"].as_i64().unwrap();
    assert!(floor > 0 && floor < crate::v4_agent::interaction::now_ms());
    let paired = Router::new()
        .route(
            "/api/structured/input-watermark",
            axum::routing::get(crate::supervised_input_watermark),
        )
        .layer(Extension(crate::auth::AuthenticatedUser {
            user_id: fixture.owner.clone(),
            username: "paired-fixture".into(),
        }))
        .with_state(fixture.state.clone());
    let denied = paired
        .oneshot(
            Request::builder()
                .uri("/api/structured/input-watermark")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn modern_session_reports_supervised_input_capability_without_creating_receipts() {
    let fixture = raw_input_fixture().await;
    let request = Request::builder()
        .uri(format!(
            "/api/structured/sessions/{}/input-capabilities",
            fixture.id
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    let response = crate::app(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value, json!({"protocol":1}));
    assert_eq!(
        fixture
            .state
            .list_unresolved_input_receipts(&fixture.owner, 0)
            .unwrap(),
        (Vec::new(), None)
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn restored_legacy_session_reports_no_supervised_capability_and_accepts_raw_input() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let first = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state =
        crate::state::AppState::new_with_services(config.clone(), None, first.clone()).unwrap();
    state.enable_supervised_input_for_test();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = first
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let path = structured_session_path(&config, &user.user_id, &session.id);
    drop(state);
    drop(first);
    let mut checkpoint: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    checkpoint
        .as_object_mut()
        .unwrap()
        .remove("sessionIncarnation");
    let mut bytes = serde_json::to_vec(&checkpoint).unwrap();
    bytes.push(b'\n');
    std::fs::write(&path, bytes).unwrap();
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state.enable_supervised_input_for_test();
    let restored = manager
        .get_session(&user.user_id, &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.id, session.id);
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    assert!(live.state.lock().await.session_incarnation.is_none());
    let process = Arc::new(CountingRawInput {
        writes: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(process.clone());
    let capability = Request::builder()
        .uri(format!(
            "/api/structured/sessions/{}/input-capabilities",
            session.id
        ))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(state.clone())
            .oneshot(capability)
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        state
            .list_unresolved_input_receipts(&user.user_id, 0)
            .unwrap(),
        (Vec::new(), None)
    );
    let input = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"x", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        crate::app(state.clone())
            .oneshot(input)
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(process.writes.load(Ordering::SeqCst), 1);
    live.state.lock().await.process = None;
    manager.close_owner(&user.user_id).await.unwrap();
}

async fn raw_child_fixture(workspace: &std::path::Path) -> SpawnedStructuredProcess {
    use std::os::unix::fs::PermissionsExt;
    let executable = workspace.join("synthetic-claude");
    std::fs::write(&executable, "#!/bin/sh\nexec /bin/cat > captured-input\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "fixture".into(),
            cwd: workspace.to_str().unwrap().into(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: None,
        },
        executable.to_str().unwrap(),
    )
    .unwrap()
}

async fn wait_for_captured_input(workspace: &std::path::Path, expected: &[u8]) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read(workspace.join("captured-input")).unwrap_or_default() == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("synthetic provider did not receive expected input");
}

#[tokio::test]
async fn installed_disabled_restart_exposes_recovery_and_fences_new_browser_legacy_input() {
    let fixture = raw_input_fixture().await;
    let (operation, _) = issue_raw_operation(&fixture.state, &fixture.token, &fixture.id).await;
    let config = fixture.state.config().clone();
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let restarted =
        crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    assert!(!restarted.supervised_input_enabled());
    manager
        .get_session(&fixture.owner, &fixture.id)
        .await
        .unwrap()
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&fixture.id)
        .unwrap()
        .clone();
    let child = raw_child_fixture(fixture._workspace.path()).await;
    live.state.lock().await.process = Some(child.controller.clone());
    let request = |method: &str, path: String, body: Value| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let capability = crate::app(restarted.clone())
        .oneshot(request(
            "GET",
            "/api/structured/input-capabilities".into(),
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(capability.status(), StatusCode::OK);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(capability.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value, json!({"protocol":1,"enabled":false}));
    let list = crate::app(restarted.clone())
        .oneshot(request(
            "GET",
            "/api/structured/input-receipts".into(),
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let value: Value =
        serde_json::from_slice(&axum::body::to_bytes(list.into_body(), 8192).await.unwrap())
            .unwrap();
    assert_eq!(
        value,
        json!({"receipts":[{"sessionId":fixture.id,"requestId":operation,"status":"issued"}],"nextCursor":null})
    );
    let input_path = format!("/api/structured/sessions/{}/input", fixture.id);
    let blocked = crate::app(restarted.clone())
        .oneshot(request(
            "POST",
            input_path.clone(),
            json!({"text":"x","fallbackToMessage":false}),
        ))
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read(fixture._workspace.path().join("captured-input")).unwrap_or_default(),
        b""
    );
    let paired = Router::new()
        .route(
            "/api/structured/sessions/{id}/input",
            post(crate::send_structured_input),
        )
        .layer(Extension(crate::auth::AuthenticatedUser {
            user_id: fixture.owner.clone(),
            username: "paired-fixture".into(),
        }))
        .with_state(restarted.clone());
    let paired_input = Request::builder()
        .method("POST")
        .uri(&input_path)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"x","fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        paired.oneshot(paired_input).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        std::fs::read(fixture._workspace.path().join("captured-input")).unwrap_or_default(),
        b""
    );
    let review = crate::app(restarted.clone())
        .oneshot(request(
            "POST",
            format!(
                "/api/structured/input-receipts/{}/{}/review",
                fixture.id, operation
            ),
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(review.status(), StatusCode::OK);
    let allowed = crate::app(restarted.clone())
        .oneshot(request(
            "POST",
            input_path,
            json!({"text":"x","fallbackToMessage":false}),
        ))
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::ACCEPTED);
    wait_for_captured_input(fixture._workspace.path(), b"x").await;
    restarted
        .lock_db()
        .unwrap()
        .execute("DROP TABLE owner_input_receipts", [])
        .unwrap();
    let corrupt_capability = crate::app(restarted.clone())
        .oneshot(request(
            "GET",
            "/api/structured/input-capabilities".into(),
            json!({}),
        ))
        .await
        .unwrap();
    assert_ne!(corrupt_capability.status(), StatusCode::NOT_FOUND);
    assert_ne!(corrupt_capability.status(), StatusCode::OK);
    let corrupt_input = crate::app(restarted.clone())
        .oneshot(request(
            "POST",
            format!("/api/structured/sessions/{}/input", fixture.id),
            json!({"text":"y", "fallbackToMessage":false}),
        ))
        .await
        .unwrap();
    assert_eq!(corrupt_input.status(), StatusCode::CONFLICT);
    wait_for_captured_input(fixture._workspace.path(), b"x").await;
    child.controller.kill().await.unwrap();
    live.state.lock().await.process = None;
    manager.close_owner(&fixture.owner).await.unwrap();
    fixture.live.state.lock().await.process = None;
}

#[tokio::test]
async fn uninstalled_claude_route_delivers_explicit_raw_keys_but_rejects_active_composer() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: Arc::new(AtomicUsize::new(0)),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let child = raw_child_fixture(workspace.path()).await;
    live.state.lock().await.process = Some(child.controller.clone());
    for text in ["a", "\u{1b}[A"] {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{}/input", session.id))
            .header(
                "authorization",
                format!("Bearer {}", login.tokens.access_token),
            )
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"text":text,"fallbackToMessage":false}).to_string(),
            ))
            .unwrap();
        assert_eq!(
            crate::app(state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::ACCEPTED
        );
    }
    let composer = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"new draft","fallbackToMessage":true}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        crate::app(state.clone())
            .oneshot(composer)
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    wait_for_captured_input(workspace.path(), b"a\x1b[A").await;
    child.controller.kill().await.unwrap();
    let partial = Arc::new(PartialRawInput {
        writes: AtomicUsize::new(0),
    });
    live.state.lock().await.process = Some(partial.clone());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"partial", "fallbackToMessage":false}).to_string(),
        ))
        .unwrap();
    let response = crate::app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["outcome"], "uncertain");
    assert_eq!(partial.writes.load(Ordering::SeqCst), 1);
    live.state.lock().await.process = None;
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
async fn settling_issued_input_fences_delayed_submission() {
    let fixture = raw_input_fixture().await;
    let (operation, token) = issue_raw_operation(&fixture.state, &fixture.token, &fixture.id).await;
    let malformed = Request::builder().method("POST").uri(format!("/api/structured/sessions/{}/supervised-input", fixture.id)).header("authorization", format!("Bearer {}", fixture.token)).header("content-type", "application/json").body(Body::from(json!({"text":"input", "fallbackToMessage":true, "requestId":operation,"deliveryToken":token}).to_string())).unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(malformed)
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    let second = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/sessions/{}/input-operation",
            fixture.id
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(second)
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let list = Request::builder()
        .method("GET")
        .uri("/api/structured/input-receipts")
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    let list = crate::app(fixture.state.clone())
        .oneshot(list)
        .await
        .unwrap();
    let body = axum::body::to_bytes(list.into_body(), 8192).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"receipts":[{"sessionId":fixture.id,"requestId":operation,"status":"issued"}], "nextCursor":null})
    );
    let review = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/input-receipts/{}/{}/review",
            fixture.id, operation
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(review)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let send = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/sessions/{}/supervised-input",
            fixture.id
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"input", "fallbackToMessage":false, "requestId":operation,"deliveryToken":token}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        crate::app(fixture.state.clone())
            .oneshot(send)
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .state
            .input_receipt(&fixture.owner, &fixture.id, &operation)
            .unwrap()
            .as_deref(),
        Some("reviewed")
    );
    fixture.live.state.lock().await.process = None;
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn supervised_input_does_not_write_a_controller_stopped_while_waiting_for_owner() {
    let fixture = raw_input_fixture().await;
    let (operation, token) = issue_raw_operation(&fixture.state, &fixture.token, &fixture.id).await;
    let guard = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.input_waiting_owner.lock().unwrap() = Some(entered);
    let request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/sessions/{}/supervised-input",
            fixture.id
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"input", "fallbackToMessage":false, "requestId":operation, "deliveryToken":token}).to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(fixture.state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    fixture
        .manager
        .interrupt(&fixture.owner, &fixture.id)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(
        response.await.unwrap().unwrap().status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

#[tokio::test]
async fn supervised_input_does_not_write_a_deleted_session_waiting_for_owner() {
    let fixture = raw_input_fixture().await;
    let (operation, token) = issue_raw_operation(&fixture.state, &fixture.token, &fixture.id).await;
    let guard = fixture.state.acquire_input_guard(&fixture.owner).unwrap();
    let (entered, wait_entered) = oneshot::channel();
    *fixture.manager.inner.input_waiting_owner.lock().unwrap() = Some(entered);
    let request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/structured/sessions/{}/supervised-input",
            fixture.id
        ))
        .header("authorization", format!("Bearer {}", fixture.token))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"input", "fallbackToMessage":false, "requestId":operation, "deliveryToken":token}).to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(fixture.state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    fixture
        .manager
        .delete_session(&fixture.owner, &fixture.id)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(
        response.await.unwrap().unwrap().status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fixture.process.writes.load(Ordering::SeqCst), 0);
    fixture.manager.close_owner(&fixture.owner).await.unwrap();
}

impl StructuredProvider for RevokedNativeProbe {
    fn provider_id(&self) -> &'static str {
        self.provider
    }
    fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        Err("synthetic native process must not start".into())
    }
}

#[tokio::test]
async fn cancelled_native_snapshot_never_spawns_a_provider() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let spawns = Arc::new(AtomicUsize::new(0));
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: spawns.clone(),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let (entered, _release) = manager.inner.turn_starts.pause_next_begin();
    let task = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = user.user_id.clone();
        let id = session.id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "snapshot before launch",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(spawns.load(Ordering::SeqCst), 0);
    task.abort();
    let _ = task.await;
    assert!(!manager.inner.turn_starts.has_open(&session.id));
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
async fn revoked_http_claude_fallback_cannot_spawn() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let spawns = Arc::new(AtomicUsize::new(0));
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(RevokedNativeProbe {
            provider: "claude",
            spawns: spawns.clone(),
        })],
    );
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, _) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let guard = live.state.lock().await;
    let (entered, wait_entered) = tokio::sync::oneshot::channel();
    *manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{}/input", session.id))
        .header(
            "authorization",
            format!("Bearer {}", login.tokens.access_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"text":"revoked fallback", "fallbackToMessage":true}).to_string(),
        ))
        .unwrap();
    let response = tokio::spawn(crate::app(state.clone()).oneshot(request));
    tokio::time::timeout(Duration::from_secs(5), wait_entered)
        .await
        .unwrap()
        .unwrap();
    state.logout_user(&user.user_id).unwrap();
    drop(guard);
    let _ = response.await.unwrap().unwrap();
    let accepted = live.state.lock().await.events.iter().any(|event| matches!(event, StructuredSessionEvent::MessageCompleted { role, content, .. } if role == "user" && content == "revoked fallback"));
    assert_eq!((accepted, spawns.load(Ordering::SeqCst)), (false, 0));
    manager.close_owner(&user.user_id).await.unwrap();
}

#[tokio::test]
async fn revoked_local_authority_cannot_accept_a_waiting_native_turn() {
    let mut outcomes = Vec::new();
    for provider in ["codex", "claude"] {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: JWT.into(),
            ..Default::default()
        };
        let spawns = Arc::new(AtomicUsize::new(0));
        let manager = StructuredSessionManager::new_with_providers(
            config.clone(),
            vec![Arc::new(RevokedNativeProbe {
                provider,
                spawns: spawns.clone(),
            })],
        );
        let state =
            crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (user, authority) =
            crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token)
                .unwrap();
        let session = manager
            .create_session(
                &user.user_id,
                workspace.path().to_str().unwrap(),
                Some(provider),
                None,
                None,
            )
            .await
            .unwrap();
        let live = manager
            .inner
            .sessions
            .lock()
            .await
            .get(&session.id)
            .unwrap()
            .clone();
        let guard = live.state.lock().await;
        let request = {
            let manager = manager.clone();
            let state = state.clone();
            let owner = user.user_id.clone();
            let id = session.id.clone();
            tokio::spawn(async move {
                manager
                    .submit_authorized(
                        &owner,
                        &id,
                        "revoked native prompt",
                        Some(&Uuid::new_v4().to_string()),
                        Some(&authority),
                        &state,
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        state.logout_user(&user.user_id).unwrap();
        drop(guard);
        let _ = request.await.unwrap();
        let accepted = live
            .state
            .lock()
            .await
            .events
            .iter()
            .any(|event| match event {
                StructuredSessionEvent::UserMessageAccepted { content, .. } => {
                    content == "revoked native prompt"
                }
                StructuredSessionEvent::MessageCompleted { role, content, .. } => {
                    role == "user" && content == "revoked native prompt"
                }
                _ => false,
            });
        manager.close_owner(&user.user_id).await.unwrap();
        outcomes.push((provider, accepted, spawns.load(Ordering::SeqCst)));
    }
    assert_eq!(outcomes, vec![("codex", false, 0), ("claude", false, 0)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_expiry_after_publication_adopts_acceptance_and_records_failure() {
    for provider in ["claude", "codex"] {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            jwt_secret: JWT.into(),
            ..Default::default()
        };
        let spawns = Arc::new(AtomicUsize::new(0));
        let manager = StructuredSessionManager::new_with_providers(
            config.clone(),
            vec![Arc::new(RevokedNativeProbe {
                provider,
                spawns: spawns.clone(),
            })],
        );
        let state =
            crate::state::AppState::new_with_services(config.clone(), None, manager.clone())
                .unwrap();
        state.enable_supervised_input_for_test();
        state
            .create_local_user_for_test("fixture", "fixture-password")
            .unwrap();
        let login = state
            .login("fixture", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let (user, current) =
            crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token)
                .unwrap();
        let (generation, _) = current
            .valid_for(&user.user_id, crate::v4_agent::interaction::now_ms())
            .unwrap();
        let session = manager
            .create_session(
                &user.user_id,
                workspace.path().to_str().unwrap(),
                Some(provider),
                None,
                None,
            )
            .await
            .unwrap();
        let (_, mut events) = manager.subscribe(&user.user_id, &session.id).await.unwrap();
        let (entered, wait_entered) = std::sync::mpsc::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        *manager.inner.native_after_publication.lock().unwrap() = Some((entered, wait_release));
        let expiry = crate::v4_agent::interaction::now_ms() + 1500;
        let authority = crate::auth::LocalAuthority::for_test(&user.user_id, generation, expiry);
        let request_id = Uuid::new_v4().to_string();
        let task = tokio::spawn({
            let manager = manager.clone();
            let state = state.clone();
            let owner = user.user_id.clone();
            let id = session.id.clone();
            let request_id = request_id.clone();
            async move {
                manager
                    .submit_authorized(
                        &owner,
                        &id,
                        "published before expiry",
                        Some(&request_id),
                        Some(&authority),
                        &state,
                    )
                    .await
            }
        });
        tokio::task::spawn_blocking(move || {
            wait_entered.recv_timeout(Duration::from_secs(8)).unwrap()
        })
        .await
        .unwrap();
        while crate::v4_agent::interaction::now_ms() < expiry {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        release.send(()).unwrap();
        let result = task.await.unwrap();
        assert_eq!(
            spawns.load(Ordering::SeqCst),
            0,
            "{provider} spawned after expiry"
        );
        let snapshot = manager
            .get_session(&user.user_id, &session.id)
            .await
            .unwrap()
            .unwrap();
        let accepted = snapshot
            .events
            .iter()
            .filter(|event| match event {
                StructuredSessionEvent::UserMessageAccepted { content, .. } => {
                    content == "published before expiry"
                }
                StructuredSessionEvent::MessageCompleted { role, content, .. } => {
                    role == "user" && content == "published before expiry"
                }
                _ => false,
            })
            .count();
        assert_eq!(
            accepted, 1,
            "{provider}: accepted event missing or repeated"
        );
        assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::Error {message, ..} if message.contains("expired"))), "{provider}: terminal failure was not recorded");
        assert!(
            events.try_recv().is_ok(),
            "{provider}: accepted event was not broadcast"
        );
        if provider == "codex" {
            assert_eq!(result.unwrap().status, "failed");
            assert_eq!(
                manager
                    .request_receipt(&user.user_id, &session.id, &request_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                "failed"
            );
        } else {
            assert!(result.is_err());
        }
        manager.close_owner(&user.user_id).await.unwrap();
        let after_close = manager
            .get_session(&user.user_id, &session.id)
            .await
            .unwrap()
            .unwrap();
        let restored = StructuredSessionManager::new_with_providers(
            config,
            vec![Arc::new(RevokedNativeProbe {
                provider,
                spawns: Arc::new(AtomicUsize::new(0)),
            })],
        );
        let durable = restored
            .get_session(&user.user_id, &session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(after_close.events).unwrap(),
            serde_json::to_value(durable.events).unwrap(),
            "{provider}: in-memory and durable events diverged"
        );
    }
}

#[test]
fn queued_admission_handle_is_bound_to_the_manager_data_root() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let config = |path: &Path| AppConfig {
        data_dir: path.into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let state = crate::state::AppState::new(config(first.path())).unwrap();
    let foreign = crate::state::AppState::new(config(second.path())).unwrap();
    let manager = state.structured_session_manager();
    assert!(manager
        .bind_local_admission(foreign.local_admission().unwrap())
        .is_err());
    assert!(manager
        .bind_local_admission(state.local_admission().unwrap())
        .is_ok());
    assert!(manager
        .bind_local_admission(state.local_admission().unwrap())
        .is_err());
}

#[tokio::test]
async fn revoked_local_authority_cannot_admit_a_waiting_v4_turn() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let live = manager
        .inner
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .clone();
    let guard = live.state.lock().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let request = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = user.user_id.clone();
        let id = session.id.clone();
        async move {
            let _ = started.send(());
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "hello",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    ready.await.unwrap();
    state.logout_user(&user.user_id).unwrap();
    drop(guard);
    let result = request.await.unwrap();
    manager.close_owner(&user.user_id).await.unwrap();
    assert!(
        result.is_err(),
        "a turn was accepted after its credential was revoked: {result:?}"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v4_post_publication_expiry_keeps_origin_and_cannot_delegate_unproven() {
    use crate::v4_agent::interaction::{
        ActionScope, ApprovalRequest, Cancellation, Interaction, TurnResources,
    };
    struct NoApproval(AtomicUsize);
    #[async_trait::async_trait]
    impl Interaction for NoApproval {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
    }
    struct Release(Option<std::sync::mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let supervisor = crate::v4_agent::delegation_outbox::provision_supervisor(data.path()).unwrap();
    manager
        .bind_delegation_supervisor(supervisor.clone())
        .unwrap();
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let expiry = crate::v4_agent::interaction::now_ms() + 3_000;
    let authority = crate::auth::LocalAuthority::for_test("owner", 0, expiry);
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let (observed, wait_observed) = std::sync::mpsc::channel();
    *manager.inner.v4_after_publication.lock().unwrap() = Some((entered, wait_release, observed));
    let mut release = Release(Some(release));
    let request = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let id = session.id.clone();
        async move {
            manager
                .submit_authorized(
                    "owner",
                    &id,
                    "fixture request",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    tokio::task::spawn_blocking(move || wait_entered.recv_timeout(Duration::from_secs(8)))
        .await
        .unwrap()
        .unwrap();
    let remaining = (expiry - crate::v4_agent::interaction::now_ms()).max(0) as u64;
    tokio::time::sleep(Duration::from_millis(remaining + 50)).await;
    release.0.take().unwrap().send(()).unwrap();
    let receipt = tokio::time::timeout(Duration::from_secs(8), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(receipt.status, "accepted");
    let retained =
        tokio::task::spawn_blocking(move || wait_observed.recv_timeout(Duration::from_secs(8)))
            .await
            .unwrap()
            .unwrap();
    assert!(retained.as_ref().is_some_and(|authority| authority
        .valid_for("owner", crate::v4_agent::interaction::now_ms())
        .is_none()));
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: session.id.clone(),
        turn_id: Uuid::new_v4().to_string(),
    };
    let turn = Arc::new(
        crate::v4_agent::delegation_outbox::DelegationTurn::new(
            manager.clone(),
            supervisor,
            scope.clone(),
            1,
        )
        .unwrap(),
    );
    let engine: crate::v4_agent::Session = serde_json::from_value(json!({
        "id": engine_session_id(&session.id).unwrap(), "provider":"deepseek", "model":"deepseek-chat", "workspace":workspace.path().canonicalize().unwrap(), "messages":[], "history":[], "updated_at":""
    })).unwrap();
    let interaction = NoApproval(AtomicUsize::new(0));
    let cancellation = Cancellation::default();
    let resources = Arc::new(TurnResources::default());
    let result = turn
        .execute(
            data.path(),
            &engine,
            "post-publication",
            &json!({"prompt":"inspect"}),
            crate::v4_agent::delegation_outbox::DelegationInvocation {
                scope: &scope,
                interaction: &interaction,
                cancellation: &cancellation,
                resources: &resources,
                authority: retained.as_ref(),
            },
        )
        .await;
    assert!(result.unwrap_err().contains("expired"));
    assert_eq!(interaction.0.load(Ordering::SeqCst), 0);
    manager.close_owner("owner").await.unwrap();
}

#[tokio::test]
async fn replaced_auth_database_cannot_split_logout_from_v4_acceptance() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    };
    let first = crate::state::AppState::new(config.clone()).unwrap();
    first
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = first
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&first, &login.tokens.access_token).unwrap();
    let manager = first.structured_session_manager();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let original = data.path().join("terminal.db");
    let moved = data.path().join("original.db");
    std::fs::rename(&original, &moved).unwrap();
    std::fs::copy(&moved, &original).unwrap();
    let second = crate::state::AppState::new(config).unwrap();
    second.logout_user(&user.user_id).unwrap();
    let result = manager
        .submit_authorized(
            &user.user_id,
            &session.id,
            "stale",
            Some(&Uuid::new_v4().to_string()),
            Some(&authority),
            &first,
        )
        .await;
    manager.close_owner(&user.user_id).await.unwrap();
    assert!(
        result.is_err(),
        "replaced database admitted a revoked turn: {result:?}"
    );
}

async fn admission_fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    crate::state::AppState,
    String,
    crate::auth::LocalAuthority,
    StructuredSessionManager,
    String,
) {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let manager = state.structured_session_manager();
    let session = manager
        .create_session(
            &user.user_id,
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    (
        data,
        workspace,
        state,
        user.user_id,
        authority,
        manager,
        session.id,
    )
}

async fn wait_for_blocked_publication(data: &Path, config: &AppConfig, owner: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let directory = structured_user_dir(config, owner);
        let staged = std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".tmp"));
        let gate = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.join("auth-admission.lock"))
            .unwrap();
        let busy = match gate.try_lock() {
            Ok(()) => {
                gate.unlock().unwrap();
                false
            }
            Err(std::fs::TryLockError::WouldBlock) => true,
            Err(error) => panic!("cannot inspect admission lock: {error}"),
        };
        if staged && busy {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "acceptance did not reach its publication fence"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn logout_waits_for_canonical_acceptance_then_revokes_later_turns() {
    let (data, _workspace, state, owner, authority, manager, id) = admission_fixture().await;
    let second = crate::state::AppState::new(state.config().clone()).unwrap();
    let cursor = manager.inner.storage_cursors.lock().unwrap();
    let request_id = Uuid::new_v4().to_string();
    let submit = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = owner.clone();
        let id = id.clone();
        let request_id = request_id.clone();
        let authority = authority.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "accepted before logout",
                    Some(&request_id),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    wait_for_blocked_publication(data.path(), state.config(), &owner).await;
    let mut logout = tokio::task::spawn_blocking({
        let owner = owner.clone();
        move || second.logout_user(&owner)
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut logout)
            .await
            .is_err()
    );
    drop(cursor);
    assert!(submit.await.unwrap().is_ok());
    assert!(logout.await.unwrap().is_ok());
    assert!(manager
        .request_receipt(&owner, &id, &request_id)
        .await
        .unwrap()
        .is_some());
    assert!(manager
        .submit_authorized(
            &owner,
            &id,
            "after logout",
            Some(&Uuid::new_v4().to_string()),
            Some(&authority),
            &state
        )
        .await
        .is_err());
    manager.close_owner(&owner).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_during_publication_keeps_the_canonical_receipt() {
    let (data, _workspace, state, owner, authority, manager, id) = admission_fixture().await;
    let cursor = manager.inner.storage_cursors.lock().unwrap();
    let request_id = Uuid::new_v4().to_string();
    let submit = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = owner.clone();
        let id = id.clone();
        let request_id = request_id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "accepted despite lost response",
                    Some(&request_id),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    wait_for_blocked_publication(data.path(), state.config(), &owner).await;
    submit.abort();
    drop(cursor);
    let _ = submit.await;
    assert!(manager
        .request_receipt(&owner, &id, &request_id)
        .await
        .unwrap()
        .is_some());
    manager.close_owner(&owner).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expiry_before_publication_leaves_no_accepted_receipt() {
    let (data, _workspace, state, owner, _authority, manager, id) = admission_fixture().await;
    let authority = crate::auth::LocalAuthority::for_test(
        &owner,
        0,
        crate::v4_agent::interaction::now_ms() + 400,
    );
    let cursor = manager.inner.storage_cursors.lock().unwrap();
    let request_id = Uuid::new_v4().to_string();
    let submit = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = owner.clone();
        let id = id.clone();
        let request_id = request_id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "expired",
                    Some(&request_id),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    wait_for_blocked_publication(data.path(), state.config(), &owner).await;
    tokio::time::sleep(Duration::from_millis(450)).await;
    drop(cursor);
    assert!(submit.await.unwrap().is_err());
    assert!(manager
        .request_receipt(&owner, &id, &request_id)
        .await
        .unwrap()
        .is_none());
    manager.close_owner(&owner).await.unwrap();
}

#[test]
#[ignore = "invoked by the isolated cross-process admission test"]
fn cross_process_logout_fixture() {
    let root = PathBuf::from(std::env::var_os("V4_FENCE_TEST_ROOT").unwrap());
    let owner = std::env::var("V4_FENCE_TEST_OWNER").unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: root.clone(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    std::fs::write(root.join("child-ready"), "ready").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !root.join("child-go").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    state.logout_user(&owner).unwrap();
    std::fs::write(root.join("child-finished"), "done").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn another_process_cannot_logout_during_canonical_publication() {
    let (data, _workspace, state, owner, authority, manager, id) = admission_fixture().await;
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::auth_integration_tests::cross_process_logout_fixture",
            "--ignored",
        ])
        .env("V4_FENCE_TEST_ROOT", data.path())
        .env("V4_FENCE_TEST_OWNER", &owner)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !data.path().join("child-ready").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "logout process did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let cursor = manager.inner.storage_cursors.lock().unwrap();
    let submit = tokio::spawn({
        let manager = manager.clone();
        let state = state.clone();
        let owner = owner.clone();
        let id = id.clone();
        async move {
            manager
                .submit_authorized(
                    &owner,
                    &id,
                    "before logout",
                    Some(&Uuid::new_v4().to_string()),
                    Some(&authority),
                    &state,
                )
                .await
        }
    });
    wait_for_blocked_publication(data.path(), state.config(), &owner).await;
    std::fs::write(data.path().join("child-go"), "go").unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!data.path().join("child-finished").exists());
    drop(cursor);
    assert!(submit.await.unwrap().is_ok());
    let status = tokio::task::spawn_blocking(move || child.wait().unwrap())
        .await
        .unwrap();
    assert!(status.success());
    assert!(data.path().join("child-finished").exists());
    manager.close_owner(&owner).await.unwrap();
}

pub(super) fn post_request(path: &str, token: Option<&str>, payload: Value) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("Content-Type", "application/json");
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    request.body(Body::from(payload.to_string())).unwrap()
}

async fn wait_approval(manager: &StructuredSessionManager, id: &str) -> String {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = manager.get_session(OWNER, id).await.unwrap().unwrap();
            if let Some(approval) = snapshot.events.iter().find_map(|event| match event {
                StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(approval),
                    tool_name,
                    ..
                } if tool_name == "background_start" => Some(approval.clone()),
                _ => None,
            }) {
                return approval;
            }
            assert!(
                !snapshot
                    .events
                    .iter()
                    .any(|event| matches!(event, StructuredSessionEvent::TurnCompleted { .. })),
                "turn ended before approval: {:?}",
                snapshot.events
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background approval was not emitted")
}

async fn wait_turn(manager: &StructuredSessionManager, id: &str) -> StructuredSessionSnapshot {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = manager.get_session(OWNER, id).await.unwrap().unwrap();
            if snapshot
                .events
                .iter()
                .any(|event| matches!(event, StructuredSessionEvent::TurnCompleted { .. }))
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background turn did not finish")
}

async fn session(manager: &StructuredSessionManager, workspace: &Path) -> String {
    manager
        .create_session(
            OWNER,
            workspace.to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap()
        .id
}

fn marker_command_error(snapshot: &StructuredSessionSnapshot) -> bool {
    snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ToolCompleted { tool_name, is_error: true, .. } if tool_name == "background_start"))
}

fn token_with_expiry(generation: u64, expires_at: i64) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub":OWNER,"username":"fixture","iat":expires_at-30,"exp":expires_at,"token_kind":"access","generation":generation}),
        &jsonwebtoken::EncodingKey::from_secret(JWT.as_bytes()),
    ).unwrap()
}

async fn confirm_allowed(
    app: &Router,
    manager: &StructuredSessionManager,
    id: &str,
    token: &str,
    workspace: &Path,
) {
    let approval = wait_approval(manager, id).await;
    assert!(!workspace.join("marker").exists());
    let response = app
        .clone()
        .oneshot(post_request(
            &format!("/api/structured/sessions/{id}/approve"),
            Some(token),
            json!({"approvalId":approval,"approved":true}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!marker_command_error(&wait_turn(manager, id).await));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !workspace.join("marker").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    std::fs::remove_file(workspace.join("marker")).unwrap();
}

async fn websocket_message(
    address: std::net::SocketAddr,
    id: &str,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let mut request = format!("ws://{address}/api/structured/sessions/{id}/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({"type":"message","text":"websocket background case","requestId":request_id})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let message = socket.next().await.expect("websocket closed").unwrap();
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["requestId"] == request_id {
                    assert_eq!(
                        value["type"], "command_receipt",
                        "websocket send was rejected: {value}"
                    );
                    break;
                }
            }
        }
    })
    .await
    .expect("websocket command receipt was not emitted");
    socket
}

#[tokio::test]
#[ignore = "invoked by the isolated parent test"]
async fn http_background_authority_fixture() {
    use crate::v4_agent::background_process::{bootstrap, owner_gate::OwnerGate};
    let data = PathBuf::from(std::env::var_os("V4_AUTH_FIXTURE_DATA").unwrap());
    let workspace = PathBuf::from(std::env::var_os("V4_AUTH_FIXTURE_WORKSPACE").unwrap());
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.clone(),
        jwt_secret: JWT.into(),
        ..Default::default()
    })
    .unwrap();
    let user = crate::auth::AuthenticatedUser {
        user_id: OWNER.into(),
        username: "fixture".into(),
    };
    state
        .add_vault_key(
            &user,
            "fixture",
            "terminal-v4:provider:deepseek",
            &crate::vault::encrypt_secret("synthetic-provider-key", VAULT).unwrap(),
            "2026-01-01",
        )
        .unwrap();
    let background = {
        let mut db = state.lock_db().unwrap();
        Arc::new(bootstrap::open_or_provision(&data, &mut db).unwrap())
    };
    let manager = state.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    background.enable_commands();
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    let app = crate::app(state.clone());
    let token = crate::auth::issue_access_token(JWT, OWNER, "fixture");
    let other = crate::auth::issue_access_token(JWT, "synthetic-other", "other");

    let allowed = session(&manager, &workspace).await;
    let message_path = format!("/api/structured/sessions/{allowed}/message");
    let payload = json!({"text":"authorized case", "requestId":Uuid::new_v4()});
    assert_eq!(
        app.clone()
            .oneshot(post_request(&message_path, None, payload.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(post_request(&message_path, Some(&other), payload.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.clone()
            .oneshot(post_request(&message_path, Some(&token), payload))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let approval = wait_approval(&manager, &allowed).await;
    assert!(!workspace.join("marker").exists());
    let approval_path = format!("/api/structured/sessions/{allowed}/approve");
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &approval_path,
                Some(&other),
                json!({"approvalId":approval,"approved":true})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &approval_path,
                Some(&token),
                json!({"approvalId":approval,"approved":true})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let completed = wait_turn(&manager, &allowed).await;
    assert!(!marker_command_error(&completed));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !workspace.join("marker").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    std::fs::remove_file(workspace.join("marker")).unwrap();

    let missing = session(&manager, &workspace).await;
    manager
        .submit(
            OWNER,
            &missing,
            "uncredentialled queued-style case",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    let completed = wait_turn(&manager, &missing).await;
    assert!(marker_command_error(&completed));
    assert!(!completed.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { tool_name, .. } if tool_name == "background_start")));
    assert!(!workspace.join("marker").exists());

    let revoked = session(&manager, &workspace).await;
    let message_path = format!("/api/structured/sessions/{revoked}/message");
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &message_path,
                Some(&token),
                json!({"text":"revoked case", "requestId":Uuid::new_v4()})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let approval = wait_approval(&manager, &revoked).await;
    state.logout_user(OWNER).unwrap();
    let gate =
        OwnerGate::open(rusqlite::Connection::open(data.join("terminal.db")).unwrap()).unwrap();
    let hold: String = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT request FROM background_owner_holds WHERE owner=?1",
            [OWNER],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(background.service_owner_holds().await.unwrap(), 1);
    gate.release(OWNER, &hold).unwrap();
    let fresh = crate::auth::issue_access_token_for_generation(JWT, OWNER, "fixture", 1);
    let approval_path = format!("/api/structured/sessions/{revoked}/approve");
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &approval_path,
                Some(&fresh),
                json!({"approvalId":approval,"approved":true})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let completed = wait_turn(&manager, &revoked).await;
    assert!(marker_command_error(&completed));
    assert!(!workspace.join("marker").exists());

    let expiry = (time::OffsetDateTime::now_utc().unix_timestamp() + 4) as usize;
    let short_token = jsonwebtoken::encode(&jsonwebtoken::Header::default(), &json!({"sub":OWNER,"username":"fixture","iat":expiry-4,"exp":expiry,"token_kind":"access","generation":1}), &jsonwebtoken::EncodingKey::from_secret(JWT.as_bytes())).unwrap();
    let expiring = session(&manager, &workspace).await;
    let message_path = format!("/api/structured/sessions/{expiring}/message");
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &message_path,
                Some(&short_token),
                json!({"text":"expiry case", "requestId":Uuid::new_v4()})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let approval = wait_approval(&manager, &expiring).await;
    let completed = wait_turn(&manager, &expiring).await;
    assert!(marker_command_error(&completed));
    assert!(!workspace.join("marker").exists());
    let approval_path = format!("/api/structured/sessions/{expiring}/approve");
    assert!(!app
        .clone()
        .oneshot(post_request(
            &approval_path,
            Some(&fresh),
            json!({"approvalId":approval,"approved":true})
        ))
        .await
        .unwrap()
        .status()
        .is_success());

    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn({
        let router = app.clone();
        async move { axum::serve(listener, router).await.unwrap() }
    });
    let websocket_session = session(&manager, &workspace).await;
    let websocket_url = format!("ws://{address}/api/structured/sessions/{websocket_session}/ws");
    assert!(
        matches!(tokio_tungstenite::connect_async(websocket_url.as_str()).await, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == StatusCode::UNAUTHORIZED)
    );
    let long_expired =
        token_with_expiry(1, time::OffsetDateTime::now_utc().unix_timestamp() - 3600);
    let mut expired_request = websocket_url.as_str().into_client_request().unwrap();
    expired_request.headers_mut().insert(
        "Authorization",
        format!("Bearer {long_expired}").parse().unwrap(),
    );
    assert!(
        matches!(tokio_tungstenite::connect_async(expired_request).await, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == StatusCode::UNAUTHORIZED)
    );
    let mut foreign_request = websocket_url.as_str().into_client_request().unwrap();
    foreign_request
        .headers_mut()
        .insert("Authorization", format!("Bearer {other}").parse().unwrap());
    assert!(
        matches!(tokio_tungstenite::connect_async(foreign_request).await, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == StatusCode::NOT_FOUND)
    );
    let mut socket = websocket_message(address, &websocket_session, &fresh).await;
    confirm_allowed(&app, &manager, &websocket_session, &fresh, &workspace).await;
    let _ = socket.close(None).await;

    let websocket_expiry = session(&manager, &workspace).await;
    let short_token = token_with_expiry(1, time::OffsetDateTime::now_utc().unix_timestamp() + 4);
    let mut socket = websocket_message(address, &websocket_expiry, &short_token).await;
    let approval = wait_approval(&manager, &websocket_expiry).await;
    assert!(marker_command_error(
        &wait_turn(&manager, &websocket_expiry).await
    ));
    assert!(!workspace.join("marker").exists());
    assert!(!app
        .clone()
        .oneshot(post_request(
            &format!("/api/structured/sessions/{websocket_expiry}/approve"),
            Some(&fresh),
            json!({"approvalId":approval,"approved":true})
        ))
        .await
        .unwrap()
        .status()
        .is_success());
    let _ = socket.close(None).await;
    server.abort();

    use base64::{engine::general_purpose::STANDARD, Engine};
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
    let image_session = manager
        .create_session(
            OWNER,
            workspace.to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-v4-flash"),
            None,
        )
        .await
        .unwrap()
        .id;
    let (image, _, _) = manager
        .upload_image(
            OWNER,
            &image_session,
            &Uuid::new_v4().to_string(),
            "image/png",
            "fixture.png",
            STANDARD.decode(PNG).unwrap(),
        )
        .await
        .unwrap();
    let image_path = format!("/api/structured/sessions/{image_session}/attachments/send");
    let payload =
        json!({"requestId":Uuid::new_v4(),"text":"image background case","attachments":[image]});
    assert_eq!(
        app.clone()
            .oneshot(post_request(&image_path, None, payload.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(post_request(&image_path, Some(&other), payload.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let expired_token =
        token_with_expiry(1, time::OffsetDateTime::now_utc().unix_timestamp() - 3600);
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &image_path,
                Some(&expired_token),
                payload.clone()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(post_request(&image_path, Some(&fresh), payload))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    confirm_allowed(&app, &manager, &image_session, &fresh, &workspace).await;

    let image_expiry = manager
        .create_session(
            OWNER,
            workspace.to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-v4-flash"),
            None,
        )
        .await
        .unwrap()
        .id;
    let (image, _, _) = manager
        .upload_image(
            OWNER,
            &image_expiry,
            &Uuid::new_v4().to_string(),
            "image/png",
            "fixture.png",
            STANDARD.decode(PNG).unwrap(),
        )
        .await
        .unwrap();
    let short_token = token_with_expiry(1, time::OffsetDateTime::now_utc().unix_timestamp() + 4);
    let image_path = format!("/api/structured/sessions/{image_expiry}/attachments/send");
    assert_eq!(
        app.clone()
            .oneshot(post_request(
                &image_path,
                Some(&short_token),
                json!({"requestId":Uuid::new_v4(),"text":"image expiry case","attachments":[image]})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let approval = wait_approval(&manager, &image_expiry).await;
    assert!(marker_command_error(
        &wait_turn(&manager, &image_expiry).await
    ));
    assert!(!workspace.join("marker").exists());
    assert!(!app
        .oneshot(post_request(
            &format!("/api/structured/sessions/{image_expiry}/approve"),
            Some(&fresh),
            json!({"approvalId":approval,"approved":true})
        ))
        .await
        .unwrap()
        .status()
        .is_success());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn authenticated_http_turns_preserve_background_authority_and_revocation() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let provider = Router::new().fallback(post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let completed_tool = body["messages"].as_array().is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool"));
            captured.lock().unwrap().push(body);
            Json(if completed_tool {
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixture completed"}}]})
            } else {
                json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"background-fixture","type":"function","function":{"name":"background_start","arguments":"{\"command\":\"printf fixture > marker\",\"timeoutSeconds\":5}"}}]}}]})
            })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "structured::auth_integration_tests::http_background_authority_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", data.path())
        .env("V4_AUTH_FIXTURE_DATA", data.path())
        .env("V4_AUTH_FIXTURE_WORKSPACE", workspace.path())
        .env("VAULT_ENCRYPTION_KEY", VAULT)
        .env("DEEPSEEK_BASE_URL", format!("http://{address}/v1"))
        .env("NO_PROXY", "*")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        child.spawn().unwrap().wait_with_output(),
    )
    .await
    .expect("fixture timed out")
    .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "fixture failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 16);
    for (index, expected) in [
        (0, true),
        (2, false),
        (4, true),
        (6, true),
        (8, true),
        (10, true),
        (12, true),
        (14, true),
    ] {
        assert_eq!(
            requests[index]["tools"]
                .to_string()
                .contains("background_start"),
            expected,
            "request {index}"
        );
    }
}
