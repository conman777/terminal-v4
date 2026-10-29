use super::*;

#[path = "background_turn.rs"]
pub(super) mod background_turn;
use background_turn::BackgroundTurn;
#[path = "background_actor_launch_tests.rs"]
mod launch_tests;

struct Fixture {
    _data: tempfile::TempDir,
    _workspace: tempfile::TempDir,
    app: crate::state::AppState,
    manager: StructuredSessionManager,
    live: Arc<StructuredLiveSession>,
    controller: Arc<V4StructuredController>,
    id: String,
}

async fn fixture() -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let app = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    })
    .unwrap();
    let manager = app.structured_session_manager();
    manager.bind_live_ownership().unwrap();
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let live = manager
        .owned_session("owner", &id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let controller = controller(&manager, &live, &id, 7).await;
    {
        let mut state = live.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    Fixture {
        _data: data,
        _workspace: workspace,
        app,
        manager,
        live,
        controller,
        id,
    }
}

async fn controller(
    manager: &StructuredSessionManager,
    live: &StructuredLiveSession,
    id: &str,
    generation: u64,
) -> Arc<V4StructuredController> {
    controller_for_turn(manager, live, id, generation, format!("turn-{generation}")).await
}

async fn controller_for_turn(
    manager: &StructuredSessionManager,
    live: &StructuredLiveSession,
    id: &str,
    generation: u64,
    turn_id: String,
) -> Arc<V4StructuredController> {
    let sink = Arc::new(StructuredEventSink {
        manager: manager.clone(),
        owner: "owner".into(),
        session_id: id.into(),
        generation,
        pending: Mutex::new(Default::default()),
    });
    let resources = live.state.lock().await.resources.clone();
    let controller = Arc::new(V4StructuredController::new(
        ActionScope {
            owner: "owner".into(),
            session_id: id.into(),
            turn_id,
        },
        sink,
        resources,
    ));
    controller.done.send_replace(true);
    controller
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authorized_stop_signals_v4_cancellation_while_lifecycle_is_busy() {
    let fixture = fixture().await;
    let lifecycle = fixture.live.lifecycle.lock().await;
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    let signalled = tokio::time::timeout(
        std::time::Duration::from_millis(250),
        fixture.controller.cancel.cancelled(),
    )
    .await
    .is_ok();
    drop(lifecycle);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap();
    assert!(
        signalled,
        "Stop should signal the admitted V4 turn before waiting for lifecycle cleanup"
    );
    result.unwrap();
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn stop_never_signals_foreign_revoked_or_expired_authority() {
    let fixture = fixture().await;
    let now = crate::v4_agent::interaction::now_ms();
    for authority in [
        crate::auth::LocalAuthority::for_test("other", 0, i64::MAX),
        crate::auth::LocalAuthority::for_test("owner", 1, i64::MAX),
        crate::auth::LocalAuthority::for_test("owner", 0, now - 1),
    ] {
        assert!(fixture
            .manager
            .interrupt_authorized("owner", &fixture.id, Some(&authority), None, &fixture.app)
            .await
            .is_err());
        assert!(!fixture.controller.cancel.is_cancelled());
    }
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_stop_waiting_on_session_rechecks_revocation() {
    let fixture = fixture().await;
    let held = fixture.live.state.lock().await;
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let stop = tokio::spawn(async move {
        let _ = started.send(());
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    waiting.await.unwrap();
    tokio::task::yield_now().await;
    fixture.app.logout_user("owner").unwrap();
    drop(held);
    assert!(stop.await.unwrap().is_err());
    assert!(!fixture.controller.cancel.is_cancelled());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_stop_waiter_does_not_abandon_admitted_cleanup() {
    let fixture = fixture().await;
    let lifecycle = fixture.live.lifecycle.lock().await;
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        fixture.controller.cancel.cancelled(),
    )
    .await
    .unwrap();
    stop.abort();
    drop(lifecycle);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if fixture.live.state.lock().await.process.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authorized_cancellation_is_retryable_without_blocking_behind_launch() {
    let cancel = Cancellation::default();
    let admission = cancel.clone();
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let held = tokio::task::spawn_blocking(move || {
        admission.admit(|| {
            entered.send(()).unwrap();
            released.recv().unwrap();
            Ok(())
        })
    });
    tokio::task::spawn_blocking(move || waiting.recv().unwrap())
        .await
        .unwrap();
    let waiting_cancel = cancel.clone();
    let mut stop = tokio::task::spawn_blocking(move || waiting_cancel.cancel_checked(&|| Ok(())));
    let prompt = tokio::time::timeout(std::time::Duration::from_millis(250), &mut stop).await;
    release.send(()).unwrap();
    held.await.unwrap().unwrap();
    let was_prompt = prompt.is_ok();
    let result = match prompt {
        Ok(result) => result.unwrap(),
        Err(_) => stop.await.unwrap(),
    };
    assert!(
        was_prompt,
        "Stop should not block an auth fence while a launch holds admission"
    );
    assert!(result.is_err());
    assert!(!cancel.is_cancelled());
    let expired = crate::v4_agent::interaction::now_ms() - 1;
    assert!(cancel
        .cancel_checked(&|| if crate::v4_agent::interaction::now_ms() >= expired {
            Err("expired".into())
        } else {
            Ok(())
        })
        .is_err());
    assert!(!cancel.is_cancelled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn busy_launch_does_not_hold_global_auth_fence_during_stop() {
    let fixture = fixture().await;
    let cancel = fixture.controller.cancel.clone();
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let held = tokio::task::spawn_blocking(move || {
        cancel.admit(|| {
            entered.send(()).unwrap();
            released.recv().unwrap();
            Ok(())
        })
    });
    tokio::task::spawn_blocking(move || waiting.recv().unwrap())
        .await
        .unwrap();
    let (signal_entered, signal_waiting) = tokio::sync::oneshot::channel();
    *fixture.controller.stop_signal_entered.lock().unwrap() = Some(signal_entered);
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), signal_waiting)
        .await
        .unwrap()
        .unwrap();
    let app = fixture.app.clone();
    let mut unrelated_logout = tokio::task::spawn_blocking(move || app.logout_user("other"));
    let prompt =
        tokio::time::timeout(std::time::Duration::from_millis(500), &mut unrelated_logout).await;
    release.send(()).unwrap();
    held.await.unwrap().unwrap();
    let was_prompt = prompt.is_ok();
    let logout = match prompt {
        Ok(result) => result.unwrap(),
        Err(_) => unrelated_logout.await.unwrap(),
    };
    assert!(
        was_prompt,
        "An unrelated logout must not wait for a busy launch"
    );
    logout.unwrap();
    assert!(stop.await.unwrap().is_err());
    assert!(!fixture.controller.cancel.is_cancelled());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_stop_does_not_cancel_replacement_generation() {
    let fixture = fixture().await;
    let lifecycle = fixture.live.lifecycle.lock().await;
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        fixture.controller.cancel.cancelled(),
    )
    .await
    .unwrap();
    let replacement = controller(&fixture.manager, &fixture.live, &fixture.id, 8).await;
    {
        let mut state = fixture.live.state.lock().await;
        state.generation = 8;
        state.process = Some(replacement.clone());
    }
    drop(lifecycle);
    stop.await.unwrap().unwrap();
    assert!(!replacement.cancel.is_cancelled());
    assert!(fixture.live.state.lock().await.process.is_some());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_stop_rejects_revoked_grant_and_wrong_session_path() {
    let fixture = fixture().await;
    let (grant, token) = crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    let mut paired = crate::auth::PairedInputAuthority {
        token,
        method: "POST".into(),
        path: format!("/api/structured/sessions/{}/interrupt", fixture.id),
    };
    let correct_path = paired.path.clone();
    paired.path = "/api/structured/sessions/foreign/interrupt".into();
    assert!(fixture
        .manager
        .interrupt_authorized("owner", &fixture.id, None, Some(&paired), &fixture.app)
        .await
        .is_err());
    assert!(!fixture.controller.cancel.is_cancelled());
    paired.path = correct_path;
    fixture
        .app
        .lock_db()
        .unwrap()
        .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
        .unwrap();
    assert!(fixture
        .manager
        .interrupt_authorized("owner", &fixture.id, None, Some(&paired), &fixture.app)
        .await
        .is_err());
    assert!(!fixture.controller.cancel.is_cancelled());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn paired_websocket_stop_rechecks_agent_control_capability() {
    let fixture = fixture().await;
    let (grant, token) = crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    let paired = crate::auth::PairedInputAuthority {
        token,
        method: "GET".into(),
        path: format!("/api/structured/sessions/{}/ws", fixture.id),
    };
    let guard = fixture.app.acquire_input_guard("owner").unwrap();
    let observer =
        serde_json::to_string(&crate::remote_permissions::Capabilities::observer()).unwrap();
    fixture
        .app
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_grants SET capabilities=?1 WHERE id=?2",
            rusqlite::params![observer, grant],
        )
        .unwrap();
    drop(guard);
    assert!(fixture
        .manager
        .interrupt_authorized("owner", &fixture.id, None, Some(&paired), &fixture.app)
        .await
        .is_err());
    assert!(!fixture.controller.cancel.is_cancelled());
    fixture.manager.shutdown().await.unwrap();
}

struct NativeProbe {
    checked: tokio::sync::Notify,
    stops: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl StructuredProcessController for NativeProbe {
    fn request_cancellation_checked(
        &self,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        self.checked.notify_one();
        Ok(())
    }
    async fn send_input(&self, _: &str) -> Result<(), String> {
        Err("fixture".into())
    }
    async fn send_approval(&self, _: bool) -> Result<(), String> {
        Err("fixture".into())
    }
    async fn interrupt(&self) -> Result<(), String> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn kill(&self) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_stop_rechecks_local_and_paired_revocation_after_lifecycle_wait() {
    for paired_mode in [false, true] {
        let fixture = fixture().await;
        let probe = Arc::new(NativeProbe {
            checked: tokio::sync::Notify::new(),
            stops: std::sync::atomic::AtomicUsize::new(0),
        });
        fixture.live.state.lock().await.process = Some(probe.clone());
        let (grant, token) =
            crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
        let paired = crate::auth::PairedInputAuthority {
            token,
            method: "POST".into(),
            path: format!("/api/structured/sessions/{}/interrupt", fixture.id),
        };
        let lifecycle = fixture.live.lifecycle.lock().await;
        let manager = fixture.manager.clone();
        let app = fixture.app.clone();
        let id = fixture.id.clone();
        let stop = tokio::spawn(async move {
            let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
            if paired_mode {
                manager
                    .interrupt_authorized("owner", &id, None, Some(&paired), &app)
                    .await
            } else {
                manager
                    .interrupt_authorized("owner", &id, Some(&authority), None, &app)
                    .await
            }
        });
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            probe.checked.notified(),
        )
        .await;
        if paired_mode {
            let guard = fixture.app.acquire_input_guard("owner").unwrap();
            fixture
                .app
                .lock_db()
                .unwrap()
                .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
                .unwrap();
            drop(guard);
        } else {
            fixture.app.logout_user("owner").unwrap();
        }
        drop(lifecycle);
        assert!(stop.await.unwrap().is_err());
        assert_eq!(probe.stops.load(Ordering::SeqCst), 0);
        fixture.manager.shutdown().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_native_stop_waiting_for_owner_guard_does_not_hold_session_state() {
    let fixture = fixture().await;
    let probe = Arc::new(NativeProbe {
        checked: tokio::sync::Notify::new(),
        stops: std::sync::atomic::AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(probe.clone());
    let (_, token) = crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    let paired = crate::auth::PairedInputAuthority {
        token,
        method: "POST".into(),
        path: format!("/api/structured/sessions/{}/interrupt", fixture.id),
    };
    let guard = fixture.app.acquire_input_guard("owner").unwrap();
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        manager
            .interrupt_authorized("owner", &id, None, Some(&paired), &app)
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if fixture.live.lifecycle.try_lock().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let state_available = tokio::time::timeout(
        std::time::Duration::from_millis(250),
        fixture.live.state.lock(),
    )
    .await
    .is_ok();
    drop(guard);
    let result = stop.await.unwrap();
    assert!(
        state_available,
        "A paired input holder must be able to finish without waiting for Stop"
    );
    result.unwrap();
    assert_eq!(probe.stops.load(Ordering::SeqCst), 1);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_stop_marks_generation_retiring_before_later_logout() {
    struct NativeGate {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        stops: std::sync::atomic::AtomicUsize,
    }
    #[async_trait::async_trait]
    impl StructuredProcessController for NativeGate {
        async fn send_input(&self, _: &str) -> Result<(), String> {
            Err("fixture".into())
        }
        async fn send_approval(&self, _: bool) -> Result<(), String> {
            Err("fixture".into())
        }
        async fn interrupt(&self) -> Result<(), String> {
            self.entered.notify_one();
            self.release.notified().await;
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn kill(&self) -> Result<(), String> {
            Ok(())
        }
    }
    let fixture = fixture().await;
    let probe = Arc::new(NativeGate {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        stops: std::sync::atomic::AtomicUsize::new(0),
    });
    fixture.live.state.lock().await.process = Some(probe.clone());
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), probe.entered.notified())
        .await
        .unwrap();
    assert!(fixture.live.state.lock().await.retiring);
    fixture.app.logout_user("owner").unwrap();
    probe.release.notify_one();
    stop.await.unwrap().unwrap();
    assert_eq!(probe.stops.load(Ordering::SeqCst), 1);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_stop_with_stale_generation_does_not_retire_replacement() {
    let fixture = fixture().await;
    let probe = Arc::new(NativeProbe {
        checked: tokio::sync::Notify::new(),
        stops: std::sync::atomic::AtomicUsize::new(0),
    });
    {
        let mut state = fixture.live.state.lock().await;
        state.generation = 8;
        state.process = Some(probe.clone());
    }
    let authority = StopAuthority {
        local: Some(crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX)),
        paired: None,
        app: fixture.app.clone(),
    };
    fixture
        .manager
        .retire_session(
            "owner",
            &fixture.id,
            fixture.live.clone(),
            7,
            false,
            Some(authority),
        )
        .await
        .unwrap();
    let state = fixture.live.state.lock().await;
    assert!(!state.retiring);
    assert_eq!(state.generation, 8);
    assert_eq!(probe.stops.load(Ordering::SeqCst), 0);
    drop(state);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_stop_signals_before_lifecycle_wait_with_a_valid_local_token() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    let lifecycle = fixture.live.lifecycle.lock().await;
    let token = crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let request = Request::post(format!("/api/structured/sessions/{}/interrupt", fixture.id))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = tokio::spawn(crate::app(fixture.app.clone()).oneshot(request));
    let signalled = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        fixture.controller.cancel.cancelled(),
    )
    .await
    .is_ok();
    drop(lifecycle);
    let response = response.await.unwrap().unwrap();
    assert!(signalled);
    assert_eq!(response.status(), StatusCode::OK);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_stop_signals_before_lifecycle_wait_with_a_valid_local_token() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let fixture = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::app(fixture.app.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let token = crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let lifecycle = fixture.live.lifecycle.lock().await;
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            serde_json::json!({"type":"interrupt", "requestId":request_id})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let signalled = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        fixture.controller.cancel.cancelled(),
    )
    .await
    .is_ok();
    drop(lifecycle);
    let receipt = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["requestId"] == request_id {
                return value;
            }
        }
        panic!("missing stop receipt")
    })
    .await
    .unwrap();
    assert!(signalled);
    assert_eq!(receipt["type"], "command_receipt");
    socket.close(None).await.unwrap();
    server.abort();
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_stop_waiting_on_session_rejects_a_revoked_local_token() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    let held = fixture.live.state.lock().await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let token = crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let request = Request::post(format!("/api/structured/sessions/{}/interrupt", fixture.id))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = tokio::spawn(crate::app(fixture.app.clone()).oneshot(request));
    tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    fixture.app.logout_user("owner").unwrap();
    drop(held);
    assert_ne!(response.await.unwrap().unwrap().status(), StatusCode::OK);
    assert!(!fixture.controller.cancel.is_cancelled());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_http_stop_waiting_on_session_rejects_a_revoked_grant() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    let (grant, token) = crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    let held = fixture.live.state.lock().await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request = Request::post(format!("/api/structured/sessions/{}/interrupt", fixture.id))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = tokio::spawn(crate::app(fixture.app.clone()).oneshot(request));
    tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    let guard = fixture.app.acquire_input_guard("owner").unwrap();
    fixture
        .app
        .lock_db()
        .unwrap()
        .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
        .unwrap();
    drop(guard);
    drop(held);
    assert_ne!(response.await.unwrap().unwrap().status(), StatusCode::OK);
    assert!(!fixture.controller.cancel.is_cancelled());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_stop_waiting_on_session_rejects_a_revoked_local_token() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let fixture = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::app(fixture.app.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let token = crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let held = fixture.live.state.lock().await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            serde_json::json!({"type":"interrupt", "requestId":request_id})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    fixture.app.logout_user("owner").unwrap();
    drop(held);
    let receipt = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["requestId"] == request_id {
                return value;
            }
        }
        panic!("missing stop response")
    })
    .await
    .unwrap();
    assert_eq!(receipt["type"], "command_rejected");
    assert!(!fixture.controller.cancel.is_cancelled());
    socket.close(None).await.unwrap();
    server.abort();
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_websocket_stop_signals_a_valid_grant_and_rejects_a_revoked_waiter() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    for revoked in [false, true] {
        let fixture = fixture().await;
        let (grant, token) =
            crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = crate::app(fixture.app.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut request = format!("ws://{address}/api/structured/sessions/{}/ws", fixture.id)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let held = fixture.live.state.lock().await;
        let (entered, waiting) = tokio::sync::oneshot::channel();
        *fixture.manager.inner.get_session_entered.lock().unwrap() = Some(entered);
        let request_id = Uuid::new_v4().to_string();
        socket
            .send(Message::Text(
                serde_json::json!({"type":"interrupt", "requestId":request_id})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
            .await
            .unwrap()
            .unwrap();
        if revoked {
            let guard = fixture.app.acquire_input_guard("owner").unwrap();
            fixture
                .app
                .lock_db()
                .unwrap()
                .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
                .unwrap();
            drop(guard);
        }
        drop(held);
        let receipt = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["requestId"] == request_id {
                    return value;
                }
            }
            panic!("missing paired stop response")
        })
        .await
        .unwrap();
        assert_eq!(
            receipt["type"],
            if revoked {
                "command_rejected"
            } else {
                "command_receipt"
            }
        );
        assert_eq!(fixture.controller.cancel.is_cancelled(), !revoked);
        socket.close(None).await.unwrap();
        server.abort();
        fixture.manager.shutdown().await.unwrap();
    }
}
