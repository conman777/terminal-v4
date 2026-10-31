use super::super::interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction};
use super::*;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{path::PathBuf, sync::Mutex};
use terminal_v4_core::StructuredSessionEvent;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";

struct Recorder {
    approved: bool,
    replace: Option<PathBuf>,
    requests: Mutex<Vec<ApprovalRequest>>,
}
#[async_trait]
impl Interaction for Recorder {
    async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
        Ok(())
    }
    async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
        self.requests.lock().unwrap().push(request);
        if let Some(path) = &self.replace {
            let mut changed = STANDARD.decode(PNG).unwrap();
            changed[45] ^= 1;
            std::fs::write(path, changed).unwrap();
        }
        Ok(self.approved)
    }
}

fn recorder(approved: bool) -> Recorder {
    Recorder {
        approved,
        replace: None,
        requests: Mutex::new(Vec::new()),
    }
}

fn scope(session: &Session) -> ActionScope {
    ActionScope {
        owner: "owner".into(),
        session_id: session.id.clone(),
        turn_id: "turn".into(),
    }
}

#[test]
fn declaration_requires_explicit_enablement_and_confirmed_vision_support() {
    assert!(declaration(ToolPolicy::Standard, true, Some(true)).is_some());
    for (policy, enabled, supports_images) in [
        (ToolPolicy::Standard, false, Some(true)),
        (ToolPolicy::Standard, true, Some(false)),
        (ToolPolicy::Standard, true, None),
        (ToolPolicy::ReadOnlyChild, true, Some(true)),
    ] {
        assert!(declaration(policy, enabled, supports_images).is_none());
    }
}

#[tokio::test]
async fn protected_workspace_root_and_ancestors_are_rejected_before_review() {
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    for protected in [".ssh", ".ENV-private", ".git"] {
        let root = temp.path().join(protected);
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        for path in [&root, &nested] {
            std::fs::write(path.join("picture.png"), STANDARD.decode(PNG).unwrap()).unwrap();
            let workspace = path.canonicalize().unwrap();
            let session = super::super::new_session("anthropic-api", "claude-sonnet-5", &workspace);
            let review = recorder(true);
            let result = execute(
                data.path(),
                "owner",
                &workspace,
                &session,
                "call",
                &json!({"path":"picture.png"}),
                ImageTurn {
                    scope: &scope(&session),
                    interaction: &review,
                    cancellation: &Cancellation::default(),
                },
            )
            .await;
            assert!(
                matches!(result, Err(message) if message == "Workspace path is protected"),
                "workspace {protected}"
            );
            assert!(review.requests.lock().unwrap().is_empty());
        }
    }
    assert!(!data.path().join("v4-agent-artifacts").exists());
}

#[tokio::test]
async fn approved_image_is_retained_as_an_owned_artifact_and_review_includes_digest() {
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    std::fs::write(workspace.join("picture.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let session = super::super::new_session("anthropic-api", "claude-sonnet-5", &workspace);
    let approved = recorder(true);
    let output = execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &scope(&session),
            interaction: &approved,
            cancellation: &Cancellation::default(),
        },
    )
    .await
    .unwrap();
    assert_eq!(output.images.len(), 1);
    assert_eq!(output.images[0]["type"], "v4_image");
    let requests = approved.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].description.contains("picture.png"));
    assert!(requests[0].description.contains("SHA-256"));
    assert!(requests[0].description.contains("provider"));
    let hydrated = super::super::artifacts::hydrate_history(
        data.path(),
        "owner",
        &workspace,
        &session.id,
        &output.images,
    )
    .unwrap();
    assert_eq!(hydrated[0]["data"], PNG);
    assert!(super::super::artifacts::hydrate_history(
        data.path(),
        "other",
        &workspace,
        &session.id,
        &output.images
    )
    .is_err());
}

#[tokio::test]
async fn canonical_structured_scope_can_review_its_own_image() {
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    std::fs::write(workspace.join("picture.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let session = super::super::new_session("anthropic-api", "claude-sonnet-5", &workspace);
    let mut structured = scope(&session);
    structured.session_id = format!(
        "ss-{}",
        uuid::Uuid::parse_str(&session.id).unwrap().simple()
    );
    let review = recorder(true);
    let result = execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &structured,
            interaction: &review,
            cancellation: &Cancellation::default(),
        },
    )
    .await
    .unwrap();
    assert_eq!(result.images.len(), 1);
    assert_eq!(review.requests.lock().unwrap()[0].scope, structured);
}

#[tokio::test]
async fn unsupported_model_and_cancelled_turn_do_not_request_approval() {
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    std::fs::write(workspace.join("picture.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let mut session = super::super::new_session("anthropic-api", "unknown-model", &workspace);
    let review = recorder(true);
    assert!(execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &scope(&session),
            interaction: &review,
            cancellation: &Cancellation::default()
        },
    )
    .await
    .is_err());
    session.model = "claude-sonnet-5".into();
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &scope(&session),
            interaction: &review,
            cancellation: &cancel
        },
    )
    .await
    .is_err());
    assert!(review.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_during_approval_publishes_no_image() {
    struct CancellingApproval(Cancellation);
    #[async_trait]
    impl Interaction for CancellingApproval {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.0.cancel();
            Ok(true)
        }
    }
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    std::fs::write(workspace.join("picture.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let session = super::super::new_session("anthropic-api", "claude-sonnet-5", &workspace);
    let cancel = Cancellation::default();
    let result = execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &scope(&session),
            interaction: &CancellingApproval(cancel.clone()),
            cancellation: &cancel,
        },
    )
    .await;
    assert!(matches!(result, Err(message) if message == "Turn cancelled"));
    assert!(!data.path().join("v4-agent-artifacts").exists());
}

#[tokio::test]
async fn denial_and_changed_review_do_not_publish_images() {
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    let image = workspace.join("picture.png");
    std::fs::write(&image, STANDARD.decode(PNG).unwrap()).unwrap();
    let session = super::super::new_session("anthropic-api", "claude-sonnet-5", &workspace);
    let cancel = Cancellation::default();
    let denied = execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &scope(&session),
            interaction: &recorder(false),
            cancellation: &cancel,
        },
    )
    .await;
    assert!(matches!(denied, Err(message) if message == "Image inspection was not approved"));
    let changed = Recorder {
        approved: true,
        replace: Some(image),
        requests: Mutex::new(Vec::new()),
    };
    let result = execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"picture.png"}),
        ImageTurn {
            scope: &scope(&session),
            interaction: &changed,
            cancellation: &cancel,
        },
    )
    .await;
    assert!(
        matches!(result, Err(message) if message == "Image or workspace changed after approval; review it again")
    );
    assert!(!data.path().join("v4-agent-artifacts").exists());
}

#[tokio::test]
async fn outside_protected_symlink_and_other_owner_paths_are_rejected_without_review() {
    use std::os::unix::fs::symlink;
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(
        outside.path().join("private.png"),
        STANDARD.decode(PNG).unwrap(),
    )
    .unwrap();
    symlink(outside.path(), workspace.join("link")).unwrap();
    std::fs::create_dir(workspace.join(".ssh")).unwrap();
    std::fs::write(
        workspace.join(".ssh/private.png"),
        STANDARD.decode(PNG).unwrap(),
    )
    .unwrap();
    std::fs::write(workspace.join("allowed.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let session = super::super::new_session("anthropic-api", "claude-sonnet-5", &workspace);
    let review = recorder(true);
    for path in [
        "../private.png",
        "link/private.png",
        ".ssh/private.png",
        "/tmp/private.png",
    ] {
        assert!(execute(
            data.path(),
            "owner",
            &workspace,
            &session,
            "call",
            &json!({"path":path}),
            ImageTurn {
                scope: &scope(&session),
                interaction: &review,
                cancellation: &Cancellation::default()
            },
        )
        .await
        .is_err());
    }
    let mut foreign = scope(&session);
    foreign.owner = "other".into();
    assert!(execute(
        data.path(),
        "owner",
        &workspace,
        &session,
        "call",
        &json!({"path":"allowed.png"}),
        ImageTurn {
            scope: &foreign,
            interaction: &review,
            cancellation: &Cancellation::default()
        },
    )
    .await
    .is_err());
    assert!(review.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn provider_turn_sends_approved_image_in_next_request() {
    const CHILD: &str = "V4_IMAGE_INSPECTION_SYNTHETIC_TEST";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "v4_agent::image_inspection::tests::provider_turn_sends_approved_image_in_next_request", "--nocapture"])
            .env(CHILD, "1")
            .env("TERMINAL_V4_IMAGE_INSPECTION", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use axum::{routing::post, Json};
    use std::sync::Arc;

    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let mut requests = captured.lock().unwrap();
            requests.push(body);
            Json(if requests.len() == 1 {
                json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"image-call","type":"function","function":{"name":NAME,"arguments":"{\"path\":\"picture.png\"}"}}]}}]})
            } else {
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Image reviewed"}}]})
            })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider = super::super::Provider {
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{address}/v1/chat/completions"),
        secret: "synthetic-test-key".into(),
        client: reqwest::Client::new(),
    };
    let data = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    std::fs::write(workspace.join("picture.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let mut session = super::super::new_session("deepseek", "deepseek-v4-flash", &workspace);
    let review = recorder(true);
    let mut turn_scope = scope(&session);
    turn_scope.turn_id = uuid::Uuid::new_v4().to_string();
    let context = super::super::TurnContext {
        scope: turn_scope,
        cancellation: Cancellation::default(),
        interaction: &review,
        resources: Arc::new(super::super::interaction::TurnResources::default()),
        attachments: &[],
        local_authority: None,
        tool_policy: ToolPolicy::Standard,
    };
    let mut integrations = super::super::integrations::Integrations::default();
    let result = super::super::turn_with_interaction(
        &provider,
        data.path(),
        "owner",
        &mut session,
        "Inspect the fixture",
        None,
        &context,
        &mut integrations,
    )
    .await;
    server.abort();
    assert_eq!(result.unwrap(), "Image reviewed");
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert!(captured[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == NAME));
    assert!(captured[1]
        .to_string()
        .contains(&format!("data:image/png;base64,{PNG}")));
    assert_eq!(review.requests.lock().unwrap().len(), 1);
}
