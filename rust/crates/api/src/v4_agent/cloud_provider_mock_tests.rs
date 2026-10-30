use super::*;
use axum::{body::Body, http::StatusCode, response::Response};
use std::sync::{Arc, Mutex};

const KEY: &str = "synthetic-cloud-key-0001";

#[derive(Clone, Debug)]
struct Seen {
    target: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

fn sse(events: Vec<Value>) -> Reply {
    let mut body: String = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    body.push_str("data: [DONE]\n\n");
    Reply {
        status: 200,
        content_type: "text/event-stream",
        body,
    }
}

fn chat_tool_call() -> Reply {
    sse(vec![
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"cloud.txt\","}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"content\":\"cloud ok\"}"}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
    ])
}

fn chat_answer() -> Reply {
    sse(vec![
        json!({"choices":[{"index":0,"delta":{"content":"Cloud "},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
    ])
}

fn responses_event(value: Value) -> String {
    format!("data: {value}\n\n")
}

fn responses_tool_call() -> Reply {
    let done = json!({"status":"completed","output":[{"type":"function_call","call_id":"call-1","name":"write_file","arguments":"{\"path\":\"cloud.txt\",\"content\":\"cloud ok\"}"}]});
    Reply {
        status: 200,
        content_type: "text/event-stream",
        body: responses_event(json!({"type":"response.completed","response":done})),
    }
}

fn responses_answer() -> Reply {
    let done = json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Cloud done"}]}]});
    Reply {
        status: 200,
        content_type: "text/event-stream",
        body: [
            responses_event(json!({"type":"response.output_text.delta","delta":"Cloud done"})),
            responses_event(json!({"type":"response.completed","response":done})),
        ]
        .concat(),
    }
}

async fn mock(replies: Vec<Reply>) -> (std::net::SocketAddr, Arc<Mutex<Vec<Seen>>>) {
    let seen = Arc::new(Mutex::new(Vec::<Seen>::new()));
    let replies = Arc::new(Mutex::new(
        replies
            .into_iter()
            .collect::<std::collections::VecDeque<_>>(),
    ));
    let captured = seen.clone();
    let router = axum::Router::new().fallback(move |request: axum::extract::Request| {
        let (captured, replies) = (captured.clone(), replies.clone());
        async move {
            let (parts, body) = request.into_parts();
            let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
            captured.lock().unwrap().push(Seen {
                target: parts.uri.to_string(),
                headers: parts
                    .headers
                    .iter()
                    .map(|(name, value)| {
                        (name.to_string(), value.to_str().unwrap_or("").to_owned())
                    })
                    .collect(),
                body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            });
            let reply = replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected extra request");
            Response::builder()
                .status(StatusCode::from_u16(reply.status).unwrap())
                .header("Content-Type", reply.content_type)
                .body(Body::from(reply.body))
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (addr, seen)
}

fn packed(provider: &str, settings: Value) -> String {
    cloud_provider::pack(provider, KEY, Some(settings.as_object().unwrap()), true).unwrap()
}

struct Case {
    provider: &'static str,
    model: &'static str,
    settings: Value,
    path: &'static str,
    auth_header: (&'static str, String),
    absent_header: &'static str,
    responses: bool,
}

async fn round_trip(case: Case) {
    let (first, second) = if case.responses {
        (responses_tool_call(), responses_answer())
    } else {
        (chat_tool_call(), chat_answer())
    };
    let (addr, seen) = mock(vec![first, second]).await;
    let mut settings = case.settings.clone();
    settings["endpoint"] = json!(format!("http://{addr}"));
    let provider = Provider::with_loopback(
        case.provider,
        packed(case.provider, settings),
        case.model,
        true,
    )
    .unwrap();
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let mut session = new_session(case.provider, case.model, &root);
    session.transport = Some(provider.transport.clone());
    let answer = turn(
        &provider,
        data.path(),
        "owner",
        &mut session,
        "Write it",
        None,
        false,
    )
    .await
    .unwrap();
    assert_eq!(answer, "Cloud done");
    assert_eq!(
        std::fs::read_to_string(root.join("cloud.txt")).unwrap(),
        "cloud ok"
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    for request in seen.iter() {
        assert_eq!(request.target, case.path);
        assert_eq!(
            request.header(case.auth_header.0),
            Some(case.auth_header.1.as_str())
        );
        assert_eq!(request.header(case.absent_header), None);
        assert_eq!(
            request.header("accept"),
            Some("text/event-stream, application/json")
        );
        assert_eq!(request.body["stream"], true);
        assert_eq!(request.body["model"], case.model);
        assert!(!request.body.to_string().contains(KEY));
    }
    let tools = seen[0].body["tools"].as_array().unwrap();
    assert!(tools
        .iter()
        .any(|tool| tool["function"]["name"] == "write_file" || tool["name"] == "write_file"));
    if case.responses {
        assert_eq!(
            seen[1].body["input"].as_array().unwrap().last().unwrap()["type"],
            "function_call_output"
        );
    } else {
        assert_eq!(
            seen[1].body["messages"].as_array().unwrap().last().unwrap()["tool_call_id"],
            "call-1"
        );
    }
    let saved = std::fs::read_to_string(
        directory(data.path(), "owner", &root).join(format!("{}.json", session.id)),
    )
    .unwrap();
    assert!(!saved.contains(KEY));
}

#[tokio::test]
async fn azure_chat_deployment_route_streams_tool_calls_with_api_key_header() {
    round_trip(Case {
        provider: "azure-foundry",
        model: "my-gpt41",
        settings: json!({"apiVersion":"2024-10-21"}),
        path: "/openai/deployments/my-gpt41/chat/completions?api-version=2024-10-21",
        auth_header: ("api-key", KEY.into()),
        absent_header: "authorization",
        responses: false,
    })
    .await;
}

#[tokio::test]
async fn azure_bearer_mode_sends_authorization_and_no_api_key_header() {
    round_trip(Case {
        provider: "azure-foundry",
        model: "gpt-4.1",
        settings: json!({"apiVersion":"v1","authHeader":"bearer"}),
        path: "/openai/v1/chat/completions",
        auth_header: ("authorization", format!("Bearer {KEY}")),
        absent_header: "api-key",
        responses: false,
    })
    .await;
}

#[tokio::test]
async fn azure_responses_route_streams_tool_calls_with_the_deployment_as_model() {
    round_trip(Case {
        provider: "azure-foundry",
        model: "gpt-5",
        settings: json!({"apiVersion":"2025-04-01-preview"}),
        path: "/openai/responses?api-version=2025-04-01-preview",
        auth_header: ("api-key", KEY.into()),
        absent_header: "authorization",
        responses: true,
    })
    .await;
}

#[tokio::test]
async fn bedrock_openai_compatible_route_uses_the_bearer_api_key() {
    round_trip(Case {
        provider: "bedrock",
        model: "openai.gpt-oss-20b-1:0",
        settings: json!({"region":"us-west-2"}),
        path: "/openai/v1/chat/completions",
        auth_header: ("authorization", format!("Bearer {KEY}")),
        absent_header: "api-key",
        responses: false,
    })
    .await;
}

#[tokio::test]
async fn vertex_openapi_route_uses_project_location_and_bearer_token() {
    round_trip(Case {
        provider: "vertex",
        model: "google/gemini-2.5-pro",
        settings: json!({"project":"my-proj-123","location":"europe-west4"}),
        path: "/v1/projects/my-proj-123/locations/europe-west4/endpoints/openapi/chat/completions",
        auth_header: ("authorization", format!("Bearer {KEY}")),
        absent_header: "api-key",
        responses: false,
    })
    .await;
}

#[tokio::test]
async fn provider_errors_map_to_hints_without_leaking_the_secret_or_response_body() {
    for (status, hint) in [
        (401, "rejected the credential"),
        (403, "rejected the credential"),
        (404, "deployment or model name"),
        (429, "rate limit or quota"),
        (503, "server error"),
    ] {
        let (addr, _) = mock(vec![Reply {
            status,
            content_type: "application/json",
            body: format!("{{\"error\":\"echo {KEY} secret-body\"}}"),
        }])
        .await;
        let provider = Provider::with_loopback(
            "azure-foundry",
            packed(
                "azure-foundry",
                json!({"endpoint":format!("http://{addr}"),"apiVersion":"2024-10-21"}),
            ),
            "gpt-4.1",
            true,
        )
        .unwrap();
        let error = provider
            .request(&json!({"model":"gpt-4.1","messages":[]}), &mut |_| Ok(()))
            .await
            .unwrap_err();
        assert!(
            error.starts_with(&format!("Provider returned HTTP {status}.")),
            "{error}"
        );
        assert!(error.contains(hint), "{error}");
        assert!(
            !error.contains(KEY) && !error.contains("secret-body") && !error.contains("127.0.0.1")
        );
    }
    let provider = Provider::with_loopback(
        "bedrock",
        packed(
            "bedrock",
            json!({"region":"us-east-1","endpoint":"http://127.0.0.1:9"}),
        ),
        "openai.gpt-oss-20b-1:0",
        true,
    )
    .unwrap();
    let error = provider
        .request(&json!({"model":"m","messages":[]}), &mut |_| Ok(()))
        .await
        .unwrap_err();
    assert!(
        !error.contains(KEY) && !error.contains("127.0.0.1"),
        "{error}"
    );
}

#[tokio::test]
async fn cancellation_drops_the_in_flight_cloud_request() {
    let hang = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hang_addr = hang.local_addr().unwrap();
    let (opened_tx, opened_rx) = tokio::sync::oneshot::channel::<()>();
    let held = tokio::spawn(async move {
        let (mut socket, _) = hang.accept().await.unwrap();
        let _ = opened_tx.send(());
        let mut buffer = vec![0u8; 65536];
        loop {
            match tokio::io::AsyncReadExt::read(&mut socket, &mut buffer).await {
                Ok(0) | Err(_) => return true,
                Ok(_) => {}
            }
        }
    });
    let provider = Provider::with_loopback(
        "vertex",
        packed("vertex", json!({"project":"my-proj-123","location":"global","endpoint":format!("http://{hang_addr}")})),
        "google/gemini-2.5-pro",
        true,
    )
    .unwrap();
    let cancellation = interaction::Cancellation::default();
    let trigger = cancellation.clone();
    tokio::spawn(async move {
        opened_rx.await.unwrap();
        trigger.cancel();
    });
    let result = cancellation
        .run(provider.request(&json!({"model":"m","messages":[]}), &mut |_| Ok(())))
        .await;
    assert_eq!(result.unwrap_err(), "Turn cancelled");
    assert!(tokio::time::timeout(Duration::from_secs(5), held)
        .await
        .unwrap()
        .unwrap());
}

#[tokio::test]
async fn oversized_requests_are_rejected_before_any_network_call() {
    let (addr, seen) = mock(vec![]).await;
    let provider = Provider::with_loopback(
        "bedrock",
        packed(
            "bedrock",
            json!({"region":"us-east-1","endpoint":format!("http://{addr}")}),
        ),
        "openai.gpt-oss-20b-1:0",
        true,
    )
    .unwrap();
    let huge = "x".repeat(24_100_000);
    let error = provider
        .request(
            &json!({"model":"m","messages":[{"role":"user","content":huge}]}),
            &mut |_| Ok(()),
        )
        .await
        .unwrap_err();
    assert!(error.contains("24 MB"));
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn provider_construction_rejects_unsafe_stored_settings_and_unconfigured_secrets() {
    assert!(
        Provider::with_loopback("bedrock", "plain-key".into(), "m", false)
            .err()
            .unwrap()
            .contains("settings are missing")
    );
    let stored = packed(
        "azure-foundry",
        json!({"endpoint":"http://127.0.0.1:5","apiVersion":"v1"}),
    );
    assert!(Provider::with_loopback("azure-foundry", stored, "gpt-4.1", false).is_err());
    let session_model_with_slash = packed(
        "azure-foundry",
        json!({"endpoint":"http://127.0.0.1:5","apiVersion":"2024-10-21"}),
    );
    assert!(
        Provider::with_loopback("azure-foundry", session_model_with_slash, "a/b", true).is_err()
    );
}
