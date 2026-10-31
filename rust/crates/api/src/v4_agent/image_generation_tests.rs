use super::*;
use crate::v4_agent::interaction::{ActionScope, Interaction};
use async_trait::async_trait;
use axum::{routing::post, Json};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use terminal_v4_core::StructuredSessionEvent;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
fn input() -> Value {
    json!({"prompt":"A bird", "model":"gpt-image-2.5-sunburst", "size":"1024x1024", "quality":"low"})
}

#[test]
fn generation_parameters_are_bounded_and_allow_only_reviewed_settings() {
    assert!(validate(&input()).is_ok());
    let mut edit = input();
    edit["image_path"] = json!("source.png");
    assert!(validate(&edit).is_ok());
    edit["image_path"] = Value::Null;
    assert!(validate(&edit).is_err());
    for input in [
        json!({}),
        json!({"prompt":" ", "model":"gpt-image-2.5-sunburst", "size":"1024x1024", "quality":"low"}),
        json!({"prompt":"x".repeat(32001), "model":"gpt-image-2.5-sunburst", "size":"1024x1024", "quality":"low"}),
        json!({"prompt":"x", "model":"unexpected", "size":"1024x1024", "quality":"low"}),
        json!({"prompt":"x", "model":"gpt-image-2.5-sunburst", "size":"2048x2048", "quality":"low"}),
        json!({"prompt":"x", "model":"gpt-image-2.5-sunburst", "size":"1024x1024", "quality":"maximum"}),
        json!({"prompt":"x", "model":"gpt-image-2.5-sunburst", "size":"1024x1024", "quality":"low", "n":2}),
    ] {
        assert!(
            validate(&input).is_err(),
            "invalid request was accepted: {input}"
        );
    }
}

#[test]
fn editing_and_generation_use_their_documented_fixed_endpoints() {
    assert_eq!(
        endpoint(false),
        "https://api.openai.com/v1/images/generations"
    );
    assert_eq!(endpoint(true), "https://api.openai.com/v1/images/edits");
}

#[test]
fn declaration_requires_opt_in_standard_policy_and_known_image_capability() {
    assert!(declaration(ToolPolicy::Standard, true, Some(true)).is_some());
    assert!(declaration(ToolPolicy::Standard, true, Some(false)).is_some());
    for (policy, enabled, vision) in [
        (ToolPolicy::Standard, false, Some(true)),
        (ToolPolicy::Standard, true, None),
        (ToolPolicy::ReadOnlyChild, true, Some(true)),
    ] {
        assert!(declaration(policy, enabled, vision).is_none());
    }
}

#[tokio::test]
async fn production_destination_rejects_cancellation_before_dns() {
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(
        matches!(production_destination(&cancel, false).await, Err(message) if message == "Turn cancelled")
    );
}

fn add_key(data: &Path, owner: &str, key: &str) {
    let db = rusqlite::Connection::open(data.join("terminal.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS api_key_vault(user_id TEXT, key_name TEXT, key_value TEXT); CREATE TABLE IF NOT EXISTS vault_owner_fences(owner_hash TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL)",
    )
    .unwrap();
    let encrypted = crate::vault::VaultCipher::load(data)
        .unwrap()
        .encrypt(key)
        .unwrap();
    db.execute(
        "INSERT INTO api_key_vault VALUES(?1,?2,?3)",
        rusqlite::params![owner, web_search::IMAGE_VAULT_NAME, encrypted],
    )
    .unwrap();
}

struct Recorder {
    approved: bool,
    rotate: Option<std::path::PathBuf>,
    requests: Mutex<Vec<ApprovalRequest>>,
    events: Mutex<Vec<StructuredSessionEvent>>,
}
impl Recorder {
    fn new(approved: bool) -> Self {
        Self {
            approved,
            rotate: None,
            requests: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
        }
    }
}
#[async_trait]
impl Interaction for Recorder {
    async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
        self.events.lock().unwrap().push(event);
        Ok(())
    }
    async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
        self.requests.lock().unwrap().push(request);
        if let Some(data) = &self.rotate {
            let db = rusqlite::Connection::open(data.join("terminal.db")).unwrap();
            let encrypted = crate::vault::VaultCipher::load(data)
                .unwrap()
                .encrypt("synthetic-rotated-secret")
                .unwrap();
            db.execute(
                "UPDATE api_key_vault SET key_value=?1 WHERE user_id='owner' AND key_name=?2",
                rusqlite::params![encrypted, web_search::IMAGE_VAULT_NAME],
            )
            .unwrap();
        }
        Ok(self.approved)
    }
}

fn scope(session: &Session) -> ActionScope {
    ActionScope {
        owner: "owner".into(),
        session_id: session.id.clone(),
        turn_id: uuid::Uuid::new_v4().to_string(),
    }
}
async fn server(router: axum::Router) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    (
        address,
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() }),
    )
}

#[tokio::test]
async fn approved_workspace_image_edit_sends_reviewed_pixels_and_returns_scoped_artifact() {
    use base64::Engine;
    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let capture = received.clone();
    let router = axum::Router::new().route(
        "/images/edits",
        post(move |Json(body): Json<Value>| {
            let capture = capture.clone();
            async move {
                capture.lock().unwrap().push(body);
                Json(json!({"data":[{"b64_json":PNG}]}))
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    std::fs::write(
        workspace.join("source.png"),
        base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .unwrap(),
    )
    .unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = Recorder::new(true);
    let mut args = input();
    args["image_path"] = json!("source.png");
    let output = TEST_ENDPOINT
        .scope(
            address,
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "edit-call",
                &args,
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &review,
                    cancellation: &Cancellation::default(),
                },
            ),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(output.images.len(), 1);
    let requests = received.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]["images"][0]["image_url"],
        format!("data:image/png;base64,{PNG}")
    );
    assert_eq!(requests[0]["prompt"], "A bird");
    let approvals = review.requests.lock().unwrap();
    assert_eq!(approvals.len(), 1);
    assert!(approvals[0].description.contains("source.png"));
    assert!(approvals[0].description.contains("SHA-256"));
    assert!(approvals[0].description.contains("charges"));
    assert!(artifacts::hydrate_history(
        data.path(),
        "other",
        &workspace,
        &session.id,
        &output.images
    )
    .is_err());
}

#[tokio::test]
async fn changed_workspace_edit_source_is_not_sent_after_approval() {
    use base64::Engine;
    let hits = Arc::new(AtomicUsize::new(0));
    let captured = hits.clone();
    let router = axum::Router::new().route(
        "/images/edits",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                Json(json!({"data":[{"b64_json":PNG}]}))
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    let source = workspace.join("source.png");
    std::fs::write(
        &source,
        base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .unwrap(),
    )
    .unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = Recorder::new(true);
    let entered = Arc::new(tokio::sync::Notify::new());
    let proceed = Arc::new(tokio::sync::Notify::new());
    let mut args = input();
    args["image_path"] = json!("source.png");
    let scope = scope(&session);
    let cancel = Cancellation::default();
    let future = TEST_ENDPOINT.scope(
        address,
        TEST_BEFORE_SEND.scope(
            (entered.clone(), proceed.clone()),
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "edit-call",
                &args,
                ImageTurn {
                    scope: &scope,
                    interaction: &review,
                    cancellation: &cancel,
                },
            ),
        ),
    );
    tokio::pin!(future);
    tokio::select! {
        _ = entered.notified() => {},
        _ = &mut future => panic!("image edit completed before the test barrier"),
    }
    std::fs::remove_file(source).unwrap();
    proceed.notify_one();
    let result = future.await;
    server.abort();
    assert!(result.is_err());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn approved_synthetic_generation_returns_owned_image_and_exact_review() {
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route(
        "/images",
        post(
            move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                let captured = captured.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer synthetic-image-secret");
                    captured.lock().unwrap().push(body);
                    Json(json!({"data":[{"b64_json":PNG}]}))
                }
            },
        ),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = Recorder::new(true);
    let result = TEST_ENDPOINT
        .scope(
            address,
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "call",
                &input(),
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &review,
                    cancellation: &Cancellation::default(),
                },
            ),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(result.images.len(), 1);
    assert_eq!(result.images[0]["type"], "v4_image");
    let captured = requests.lock().unwrap();
    assert_eq!(
        captured.as_slice(),
        &[
            json!({"prompt":"A bird", "model":"gpt-image-2.5-sunburst", "size":"1024x1024", "quality":"low", "n":1, "output_format":"png"})
        ]
    );
    let requests = review.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    for detail in [
        "OpenAI",
        "gpt-image-2.5-sunburst",
        "1024x1024",
        "low",
        "A bird",
        "charges",
    ] {
        assert!(requests[0].description.contains(detail));
    }
    let hydrated = artifacts::hydrate_history(
        data.path(),
        "owner",
        &workspace,
        &session.id,
        &result.images,
    )
    .unwrap();
    assert_eq!(hydrated[0]["data"], PNG);
    assert!(artifacts::hydrate_history(
        data.path(),
        "other",
        &workspace,
        &session.id,
        &result.images
    )
    .is_err());
}

#[tokio::test]
async fn denial_and_credential_rotation_send_no_request() {
    let hits = Arc::new(AtomicUsize::new(0));
    let captured = hits.clone();
    let router = axum::Router::new().route(
        "/images",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                Json(json!({"data":[{"b64_json":PNG}]}))
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let denied = TEST_ENDPOINT
        .scope(
            address,
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "denied",
                &input(),
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &Recorder::new(false),
                    cancellation: &Cancellation::default(),
                },
            ),
        )
        .await;
    assert!(matches!(denied, Err(message) if message == "Image generation was not approved"));
    let rotated = Recorder {
        approved: true,
        rotate: Some(data.path().to_path_buf()),
        requests: Mutex::new(Vec::new()),
        events: Mutex::new(Vec::new()),
    };
    let result = TEST_ENDPOINT
        .scope(
            address,
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "rotated",
                &input(),
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &rotated,
                    cancellation: &Cancellation::default(),
                },
            ),
        )
        .await;
    server.abort();
    assert!(matches!(result, Err(message) if message.contains("configuration changed")));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert!(!data.path().join("v4-agent-artifacts").exists());
}

#[tokio::test]
async fn failed_response_is_uncertain_and_does_not_retry() {
    let hits = Arc::new(AtomicUsize::new(0));
    let captured = hits.clone();
    let router = axum::Router::new().route(
        "/images",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                "malformed"
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let result = TEST_ENDPOINT
        .scope(
            address,
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "call",
                &input(),
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &Recorder::new(true),
                    cancellation: &Cancellation::default(),
                },
            ),
        )
        .await;
    server.abort();
    assert!(matches!(result, Err(message) if message == UNCERTAIN));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_after_provider_receives_request_is_uncertain_and_not_retried() {
    let hits = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(tokio::sync::Notify::new());
    let captured = hits.clone();
    let signal = received.clone();
    let router = axum::Router::new().route(
        "/images",
        post(move || {
            let captured = captured.clone();
            let signal = signal.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                signal.notify_one();
                std::future::pending::<Json<Value>>().await
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let cancel = Cancellation::default();
    let cancel_after_acceptance = async {
        received.notified().await;
        assert!(
            matches!(crate::vault_admission::exclusive(data.path(), "owner"), Err(error) if error == crate::vault_admission::BUSY)
        );
        assert!(crate::vault_admission::exclusive(data.path(), "other-owner").is_ok());
        cancel.cancel();
    };
    let review = Recorder::new(true);
    let turn_scope = scope(&session);
    let parameters = input();
    let action = TEST_ENDPOINT.scope(
        address,
        execute(
            data.path(),
            "owner",
            &workspace,
            &session,
            "call",
            &parameters,
            ImageTurn {
                scope: &turn_scope,
                interaction: &review,
                cancellation: &cancel,
            },
        ),
    );
    let (result, _) = tokio::join!(action, cancel_after_acceptance);
    server.abort();
    assert!(matches!(result, Err(message) if message == UNCERTAIN));
    assert!(crate::vault_admission::exclusive(data.path(), "owner").is_ok());
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert!(!data.path().join("v4-agent-artifacts").exists());
}

#[tokio::test]
async fn redirect_is_uncertain_and_never_followed() {
    let first = Arc::new(AtomicUsize::new(0));
    let second = Arc::new(AtomicUsize::new(0));
    let first_capture = first.clone();
    let second_capture = second.clone();
    let router = axum::Router::new()
        .route(
            "/images",
            post(move || {
                let counter = first_capture.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    (
                        axum::http::StatusCode::TEMPORARY_REDIRECT,
                        [(axum::http::header::LOCATION, "/follow")],
                    )
                }
            }),
        )
        .route(
            "/follow",
            post(move || {
                let counter = second_capture.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Json(json!({"data":[{"b64_json":PNG}]}))
                }
            }),
        );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let result = TEST_ENDPOINT
        .scope(
            address,
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "call",
                &input(),
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &Recorder::new(true),
                    cancellation: &Cancellation::default(),
                },
            ),
        )
        .await;
    server.abort();
    assert!(matches!(result, Err(message) if message == UNCERTAIN));
    assert_eq!(
        (first.load(Ordering::SeqCst), second.load(Ordering::SeqCst)),
        (1, 0)
    );
}

#[tokio::test]
async fn synthetic_provider_turn_approves_and_returns_generated_image() {
    const CHILD: &str = "V4_IMAGE_GENERATION_SYNTHETIC_TEST";
    const TEST_MODEL: &str = "V4_IMAGE_GENERATION_SYNTHETIC_MODEL";
    if std::env::var_os(CHILD).is_none() {
        for model in ["deepseek-v4-flash", "deepseek-v4-pro"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "v4_agent::integrations::image_generation::tests::synthetic_provider_turn_approves_and_returns_generated_image", "--nocapture"])
                .env(CHILD, "1")
                .env(TEST_MODEL, model)
                .env("TERMINAL_V4_IMAGE_GENERATION", "1")
                .output().unwrap();
            assert!(
                output.status.success(),
                "child test for {model} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    }
    let provider_requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = provider_requests.clone();
    let images = Arc::new(AtomicUsize::new(0));
    let image_counter = images.clone();
    let router = axum::Router::new()
        .route("/images", post(move || { let counter = image_counter.clone(); async move { counter.fetch_add(1, Ordering::SeqCst); Json(json!({"data":[{"b64_json":PNG}]})) } }))
        .route("/v1/chat/completions", post(move |Json(body): Json<Value>| { let captured = captured.clone(); async move {
            let mut requests = captured.lock().unwrap();
            requests.push(body);
            Json(if requests.len() == 1 { json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"generate","type":"function","function":{"name":NAME,"arguments":input().to_string()}}]}}]}) }
            else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Generated"}}]}) })
        }}));
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let provider = crate::v4_agent::Provider {
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{address}/v1/chat/completions"),
        secret: "synthetic-model-key".into(),
        client: reqwest::Client::new(),
    };
    let model = std::env::var(TEST_MODEL).unwrap();
    let mut session = crate::v4_agent::new_session("deepseek", &model, &workspace);
    let review = Recorder::new(true);
    let context = crate::v4_agent::TurnContext {
        scope: scope(&session),
        cancellation: Cancellation::default(),
        interaction: &review,
        resources: Arc::new(crate::v4_agent::interaction::TurnResources::default()),
        attachments: &[],
        local_authority: None,
        tool_policy: ToolPolicy::Standard,
    };
    let mut integrations = super::super::Integrations::default();
    let result = TEST_ENDPOINT
        .scope(
            address,
            crate::v4_agent::turn_with_interaction(
                &provider,
                data.path(),
                "owner",
                &mut session,
                "Generate a fixture image",
                None,
                &context,
                &mut integrations,
            ),
        )
        .await;
    server.abort();
    assert_eq!(result.unwrap(), "Generated");
    assert_eq!(images.load(Ordering::SeqCst), 1);
    let requests = provider_requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == NAME));
    let second_request = requests[1].to_string();
    if model == "deepseek-v4-flash" {
        assert!(second_request.contains(&format!("data:image/png;base64,{PNG}")));
    } else {
        assert!(!second_request.contains(PNG));
        assert!(second_request.contains("Do not claim to have inspected the image"));
    }
    assert!(review
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| match event {
            StructuredSessionEvent::ToolCompleted {
                tool_name,
                content: Some(content),
                ..
            } if tool_name == NAME => {
                content
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "v4_image"))
            }
            _ => false,
        }));
    assert_eq!(review.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn approval_that_expires_before_send_is_not_dispatched() {
    let hits = Arc::new(AtomicUsize::new(0));
    let captured = hits.clone();
    let router = axum::Router::new().route(
        "/images",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                Json(json!({"data":[{"b64_json":PNG}]}))
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = Recorder::new(true);
    let cancellation = Cancellation::default();
    let turn_scope = scope(&session);
    let parameters = input();
    let entered = Arc::new(tokio::sync::Notify::new());
    let proceed = Arc::new(tokio::sync::Notify::new());
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
    let delayed = async {
        entered.notified().await;
        clock.store(1_300_000, Ordering::SeqCst);
        proceed.notify_one();
    };
    let action = TEST_ENDPOINT.scope(
        address,
        TEST_CLOCK_MS.scope(
            clock.clone(),
            TEST_BEFORE_SEND.scope(
                (entered.clone(), proceed.clone()),
                execute(
                    data.path(),
                    "owner",
                    &workspace,
                    &session,
                    "call",
                    &parameters,
                    ImageTurn {
                        scope: &turn_scope,
                        interaction: &review,
                        cancellation: &cancellation,
                    },
                ),
            ),
        ),
    );
    let (result, _) = tokio::join!(action, delayed);
    server.abort();
    assert!(matches!(result, Err(message) if message == "Image generation approval expired"));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rotated_or_removed_credential_before_send_is_not_used() {
    for remove in [false, true] {
        let hits = Arc::new(AtomicUsize::new(0));
        let captured = hits.clone();
        let router = axum::Router::new().route(
            "/images",
            post(move || {
                let captured = captured.clone();
                async move {
                    captured.fetch_add(1, Ordering::SeqCst);
                    Json(json!({"data":[{"b64_json":PNG}]}))
                }
            }),
        );
        let (address, server) = server(router).await;
        let data = tempfile::tempdir().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().canonicalize().unwrap();
        add_key(data.path(), "owner", "synthetic-image-secret");
        let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
        let review = Recorder::new(true);
        let cancellation = Cancellation::default();
        let turn_scope = scope(&session);
        let parameters = input();
        let entered = Arc::new(tokio::sync::Notify::new());
        let proceed = Arc::new(tokio::sync::Notify::new());
        let change = async {
            entered.notified().await;
            let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
            if remove {
                db.execute(
                    "DELETE FROM api_key_vault WHERE user_id='owner' AND key_name=?1",
                    rusqlite::params![web_search::IMAGE_VAULT_NAME],
                )
                .unwrap();
            } else {
                let rotated = crate::vault::VaultCipher::load(data.path())
                    .unwrap()
                    .encrypt("synthetic-rotated-secret")
                    .unwrap();
                db.execute(
                    "UPDATE api_key_vault SET key_value=?1 WHERE user_id='owner' AND key_name=?2",
                    rusqlite::params![rotated, web_search::IMAGE_VAULT_NAME],
                )
                .unwrap();
            }
            proceed.notify_one();
        };
        let action = TEST_ENDPOINT.scope(
            address,
            TEST_AT_POST_POLL.scope(
                (entered.clone(), proceed.clone()),
                execute(
                    data.path(),
                    "owner",
                    &workspace,
                    &session,
                    "call",
                    &parameters,
                    ImageTurn {
                        scope: &turn_scope,
                        interaction: &review,
                        cancellation: &cancellation,
                    },
                ),
            ),
        );
        let (result, _) = tokio::join!(action, change);
        server.abort();
        assert!(result.is_err(), "credential change must reject before send");
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn approval_expiry_at_post_admission_is_rejected_before_provider_receives_it() {
    let hits = Arc::new(AtomicUsize::new(0));
    let captured = hits.clone();
    let router = axum::Router::new().route(
        "/images",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                Json(json!({"data":[{"b64_json":PNG}]}))
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = Recorder::new(true);
    let cancellation = Cancellation::default();
    let turn_scope = scope(&session);
    let parameters = input();
    let entered = Arc::new(tokio::sync::Notify::new());
    let proceed = Arc::new(tokio::sync::Notify::new());
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
    let delayed = async {
        entered.notified().await;
        clock.store(1_300_000, Ordering::SeqCst);
        proceed.notify_one();
    };
    let action = TEST_ENDPOINT.scope(
        address,
        TEST_CLOCK_MS.scope(
            clock.clone(),
            TEST_AT_POST_POLL.scope(
                (entered.clone(), proceed.clone()),
                execute(
                    data.path(),
                    "owner",
                    &workspace,
                    &session,
                    "call",
                    &parameters,
                    ImageTurn {
                        scope: &turn_scope,
                        interaction: &review,
                        cancellation: &cancellation,
                    },
                ),
            ),
        ),
    );
    let (result, _) = tokio::join!(action, delayed);
    server.abort();
    assert!(matches!(result, Err(message) if message == "Image generation approval expired"));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancellation_at_final_admission_prevents_provider_request() {
    let hits = Arc::new(AtomicUsize::new(0));
    let observed = hits.clone();
    let router = axum::Router::new().route(
        "/images",
        post(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Json(json!({"data":[{"b64_json":PNG}]}))
            }
        }),
    );
    let (address, server) = server(router).await;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    add_key(data.path(), "owner", "synthetic-image-secret");
    let session = crate::v4_agent::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = Recorder::new(true);
    let cancellation = Cancellation::default();
    let turn_scope = scope(&session);
    let parameters = input();
    let entered = Arc::new(tokio::sync::Notify::new());
    let proceed = Arc::new(tokio::sync::Notify::new());
    let stop = async {
        entered.notified().await;
        cancellation.cancel();
        proceed.notify_one();
    };
    let action = TEST_ENDPOINT.scope(
        address,
        TEST_AT_ADMISSION.scope(
            (entered.clone(), proceed.clone()),
            execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "call",
                &parameters,
                ImageTurn {
                    scope: &turn_scope,
                    interaction: &review,
                    cancellation: &cancellation,
                },
            ),
        ),
    );
    let (result, _) = tokio::join!(action, stop);
    server.abort();
    assert!(matches!(result, Err(message) if message == "Turn cancelled"));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert!(crate::vault_admission::exclusive(data.path(), "owner").is_ok());
}
