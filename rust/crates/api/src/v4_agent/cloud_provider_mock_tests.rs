use super::*;
use axum::{body::Body, http::StatusCode, response::Response};
use std::sync::{Arc, Mutex};

const KEY: &str = "synthetic-cloud-key-0001";

#[derive(Clone, Debug)]
struct Seen {
    target: String,
    headers: Vec<(String, String)>,
    body: Value,
    raw: String,
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
                raw: String::from_utf8_lossy(&bytes).into_owned(),
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

const AWS_SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const AWS_SESSION: &str = "session-token-for-mock-0001";

fn aws_keys() -> String {
    json!({"accessKeyId":"AKIDEXAMPLE0000001","secretAccessKey":AWS_SECRET,"sessionToken":AWS_SESSION})
        .to_string()
}

fn json_reply(status: u16, body: Value) -> Reply {
    Reply {
        status,
        content_type: "application/json",
        body: body.to_string(),
    }
}

fn converse_tool_call() -> Reply {
    json_reply(
        200,
        json!({"output":{"message":{"role":"assistant","content":[
            {"toolUse":{"toolUseId":"call-1","name":"write_file","input":{"path":"cloud.txt","content":"cloud ok"}}}]}},
            "stopReason":"tool_use","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}),
    )
}

fn converse_answer() -> Reply {
    json_reply(
        200,
        json!({"output":{"message":{"role":"assistant","content":[{"text":"Cloud done"}]}},
            "stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}),
    )
}

fn unix_from_amz_date(date: &str) -> u64 {
    let number = |range: std::ops::Range<usize>| date[range].parse::<i64>().unwrap();
    let (year, month, day) = (number(0..4), number(4..6), number(6..8));
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days * 86_400 + number(9..11) * 3600 + number(11..13) * 60 + number(13..15)) as u64
}

#[tokio::test]
async fn bedrock_sigv4_converse_signs_requests_and_round_trips_tool_calls() {
    let (addr, seen) = mock(vec![converse_tool_call(), converse_answer()]).await;
    let model = "openai.gpt-oss-20b-1:0";
    let stored = cloud_provider::pack(
        "bedrock",
        &aws_keys(),
        Some(
            json!({"region":"us-west-2","endpoint":format!("http://{addr}")})
                .as_object()
                .unwrap(),
        ),
        true,
    )
    .unwrap();
    let provider = Provider::with_loopback("bedrock", stored, model, true).unwrap();
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let mut session = new_session("bedrock", model, &root);
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
        assert_eq!(request.target, "/model/openai.gpt-oss-20b-1%3A0/converse");
        assert_eq!(request.header("x-amz-security-token"), Some(AWS_SESSION));
        assert_eq!(request.header("content-type"), Some("application/json"));
        let date = request.header("x-amz-date").unwrap();
        let expected = cloud_provider::sigv4::sign(
            &cloud_provider::sigv4::Request {
                method: "POST",
                host: &addr.to_string(),
                path: "/model/openai.gpt-oss-20b-1%3A0/converse",
                query: "",
                headers: &[("content-type", "application/json")],
                body: request.raw.as_bytes(),
            },
            &cloud_provider::sigv4::Credentials {
                access_key: "AKIDEXAMPLE0000001",
                secret_key: AWS_SECRET,
                session_token: Some(AWS_SESSION),
            },
            "us-west-2",
            "bedrock",
            unix_from_amz_date(date),
        );
        assert_eq!(
            request.header("authorization"),
            Some(expected.authorization.as_str())
        );
        assert!(expected
            .authorization
            .contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token"));
        assert!(!request.raw.contains(AWS_SECRET) && !request.raw.contains(AWS_SESSION));
        assert!(request.body.get("stream").is_none() && request.body.get("model").is_none());
    }
    assert!(seen[0].body["toolConfig"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["toolSpec"]["name"] == "write_file"));
    assert_eq!(
        seen[1].body["messages"].as_array().unwrap().last().unwrap()["content"][0]["toolResult"]
            ["toolUseId"],
        "call-1"
    );
    let saved = std::fs::read_to_string(
        directory(data.path(), "owner", &root).join(format!("{}.json", session.id)),
    )
    .unwrap();
    assert!(!saved.contains(AWS_SECRET) && !saved.contains(AWS_SESSION));
}

#[tokio::test]
async fn bedrock_sigv4_errors_map_to_hints_without_secrets_or_body() {
    for (status, hint) in [
        (403, "rejected the credential"),
        (429, "rate limit or quota"),
    ] {
        let (addr, _) = mock(vec![json_reply(
            status,
            json!({"message":format!("echo {AWS_SECRET} {AWS_SESSION}")}),
        )])
        .await;
        let stored = cloud_provider::pack(
            "bedrock",
            &aws_keys(),
            Some(
                json!({"region":"us-east-1","endpoint":format!("http://{addr}")})
                    .as_object()
                    .unwrap(),
            ),
            true,
        )
        .unwrap();
        let provider =
            Provider::with_loopback("bedrock", stored, "openai.gpt-oss-20b-1:0", true).unwrap();
        let error = provider
            .request(&json!({"model":"openai.gpt-oss-20b-1:0","messages":[{"role":"user","content":"x"}]}), &mut |_| Ok(()))
            .await
            .unwrap_err();
        assert!(
            error.starts_with(&format!("Provider returned HTTP {status}.")) && error.contains(hint),
            "{error}"
        );
        assert!(
            !error.contains(AWS_SECRET)
                && !error.contains(AWS_SESSION)
                && !error.contains("127.0.0.1")
        );
    }
}

fn vertex_provider(addr: std::net::SocketAddr, key_file: &str) -> Provider {
    let stored = cloud_provider::pack(
        "vertex",
        key_file,
        Some(
            json!({"project":"my-proj-123","location":"global",
                "endpoint":format!("http://{addr}"),"tokenEndpoint":format!("http://{addr}/token")})
            .as_object()
            .unwrap(),
        ),
        true,
    )
    .unwrap();
    Provider::with_loopback("vertex", stored, "google/gemini-2.5-pro", true).unwrap()
}

fn token_reply(token: &str, expires_in: u64) -> Reply {
    json_reply(
        200,
        json!({"access_token":token,"expires_in":expires_in,"token_type":"Bearer"}),
    )
}

#[tokio::test]
async fn vertex_service_account_mints_one_cached_token_for_a_whole_tool_turn() {
    let (private, public) = cloud_provider::vertex::test_keys::rsa_pair();
    let (addr, seen) = mock(vec![
        token_reply("ya29.minted-1", 3600),
        chat_tool_call(),
        chat_answer(),
    ])
    .await;
    let provider = vertex_provider(addr, &cloud_provider::vertex::test_keys::key_file(&private));
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let mut session = new_session("vertex", "google/gemini-2.5-pro", &root);
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
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[0].target, "/token");
    assert_eq!(
        seen[0].header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    let form: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(seen[0].raw.as_bytes())
            .into_owned()
            .collect();
    assert_eq!(
        form["grant_type"],
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
    );
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[format!("http://{addr}/token")]);
    let claims = jsonwebtoken::decode::<Value>(
        &form["assertion"],
        &jsonwebtoken::DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
        &validation,
    )
    .unwrap()
    .claims;
    assert_eq!(claims["iss"], "agent@proj-123.iam.gserviceaccount.com");
    assert_eq!(
        claims["scope"],
        "https://www.googleapis.com/auth/cloud-platform"
    );
    for request in &seen[1..] {
        assert_eq!(
            request.target,
            "/v1/projects/my-proj-123/locations/global/endpoints/openapi/chat/completions"
        );
        assert_eq!(
            request.header("authorization"),
            Some("Bearer ya29.minted-1")
        );
        assert!(!request.raw.contains("PRIVATE"));
    }
    let saved = std::fs::read_to_string(
        directory(data.path(), "owner", &root).join(format!("{}.json", session.id)),
    )
    .unwrap();
    assert!(!saved.contains("PRIVATE") && !saved.contains("ya29.minted-1"));
}

#[tokio::test]
async fn vertex_token_is_reminted_after_it_expires() {
    let (private, _) = cloud_provider::vertex::test_keys::rsa_pair();
    let (addr, seen) = mock(vec![
        token_reply("ya29.short", 1),
        chat_answer(),
        token_reply("ya29.fresh", 3600),
        chat_answer(),
    ])
    .await;
    let provider = vertex_provider(addr, &cloud_provider::vertex::test_keys::key_file(&private));
    let body = json!({"model":"google/gemini-2.5-pro","messages":[{"role":"user","content":"x"}]});
    provider.request(&body, &mut |_| Ok(())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(2100)).await;
    provider.request(&body, &mut |_| Ok(())).await.unwrap();
    let seen = seen.lock().unwrap();
    let auth: Vec<_> = seen
        .iter()
        .filter(|request| request.target != "/token")
        .map(|request| request.header("authorization").unwrap().to_owned())
        .collect();
    assert_eq!(auth, ["Bearer ya29.short", "Bearer ya29.fresh"]);
    assert_eq!(
        seen.iter()
            .filter(|request| request.target == "/token")
            .count(),
        2
    );
}

#[tokio::test]
async fn vertex_token_exchange_failures_never_leak_keys_or_response_bodies() {
    let (private, _) = cloud_provider::vertex::test_keys::rsa_pair();
    let (addr, _) = mock(vec![json_reply(
        401,
        json!({"error":"invalid_grant PRIVATE echo-body"}),
    )])
    .await;
    let provider = vertex_provider(addr, &cloud_provider::vertex::test_keys::key_file(&private));
    let error = provider
        .request(&json!({"model":"m","messages":[]}), &mut |_| Ok(()))
        .await
        .unwrap_err();
    assert!(error.contains("HTTP 401"), "{error}");
    assert!(
        !error.contains("PRIVATE") && !error.contains("echo-body") && !error.contains("127.0.0.1")
    );
    let (addr, _) = mock(vec![json_reply(200, json!({"nope":true}))]).await;
    let provider = vertex_provider(addr, &cloud_provider::vertex::test_keys::key_file(&private));
    let error = provider
        .request(&json!({"model":"m","messages":[]}), &mut |_| Ok(()))
        .await
        .unwrap_err();
    assert!(error.contains("no access token"), "{error}");
}
