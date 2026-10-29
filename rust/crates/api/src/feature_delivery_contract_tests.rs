use super::*;
use sha2::{Digest, Sha256};
use terminal_v4_core::{AppConfig, StructuredSessionEvent};

struct Host {
    state: AppState,
    _data: tempfile::TempDir,
    url: String,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Host {
    fn drop(&mut self) {
        self.server.abort();
    }
}
fn token(host: &Host, owner: &str) -> String {
    auth::issue_access_token(&host.state.config().jwt_secret, owner, owner)
}
async fn host(data: tempfile::TempDir) -> Host {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: Uuid::new_v4().to_string(),
        port: listener.local_addr().unwrap().port(),
        ..Default::default()
    };
    let state = AppState::new_with_external_auth(config, None).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = app(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Host {
        state,
        _data: data,
        url,
        server,
    }
}
async fn json_ok(response: reqwest::Response) -> Value {
    let path = response.url().path().to_owned();
    let status = response.status();
    let text = response.text().await.unwrap();
    assert!(status.is_success(), "{status} for {path}: {text}");
    serde_json::from_str(&text).unwrap()
}
async fn pair(
    client: &reqwest::Client,
    home: &Host,
    target: &Host,
    profile: &str,
    capabilities: Option<Value>,
) -> String {
    let mut input = json!({"label":"Synthetic read client","profile":profile});
    if let Some(capabilities) = capabilities {
        input["capabilities"] = capabilities;
    }
    let code = json_ok(
        client
            .post(format!("{}/api/environments/pairing-code", target.url))
            .bearer_auth(token(target, "remote-owner"))
            .json(&input)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let environment = json_ok(
        client
            .post(format!("{}/api/environments/connect", home.url))
            .bearer_auth(token(home, "local-owner"))
            .json(&json!({"url":target.url,"code":code["code"],"label":"Synthetic host"}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    format!(
        "{}/api/environments/{}/proxy",
        home.url,
        environment["id"].as_str().unwrap()
    )
}
async fn interrupted_session(
    data: &FsPath,
    workspace: &FsPath,
    owner: &str,
) -> (String, String, String) {
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.into(),
        ..Default::default()
    });
    let mut snapshot = manager
        .create_session(
            owner,
            workspace.to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-chat"),
            None,
        )
        .await
        .unwrap();
    let request = Uuid::new_v4().to_string();
    let turn = Uuid::new_v4().to_string();
    snapshot
        .events
        .push(StructuredSessionEvent::UserMessageAccepted {
            ts: 1,
            seq: 1,
            request_id: request.clone(),
            turn_id: turn.clone(),
            message_id: Uuid::new_v4().to_string(),
            content: "Synthetic accepted input; never execute".into(),
            attachments: vec![],
        });
    snapshot.events.push(StructuredSessionEvent::TurnStarted {
        ts: 2,
        seq: 2,
        turn_id: turn.clone(),
    });
    let path = data
        .join("structured-sessions")
        .join(hex::encode(Sha256::digest(owner.as_bytes())))
        .join(format!("{}.json", snapshot.id));
    std::fs::write(
        path,
        serde_json::to_vec(&json!({"version":1,"ownerId":owner,"snapshot":snapshot})).unwrap(),
    )
    .unwrap();
    (snapshot.id, request, turn)
}

#[cfg(unix)]
#[tokio::test]
async fn paired_proxy_discovery_falls_back_without_delegating_supervised_input() {
    for preview_enabled in [false, true] {
        let target_data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (id, _, _) =
            interrupted_session(target_data.path(), workspace.path(), "remote-owner").await;
        let home = host(tempfile::tempdir().unwrap()).await;
        let target = host(target_data).await;
        if preview_enabled {
            target.state.enable_supervised_input_for_test();
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let operator = pair(&client, &home, &target, "operator", None).await;
        let observer = pair(&client, &home, &target, "observer", None).await;
        let auth = token(&home, "local-owner");
        for proxy in [&operator, &observer] {
            let capability = client
                .get(format!("{proxy}/api/structured/input-capabilities"))
                .bearer_auth(&auth)
                .send()
                .await
                .unwrap();
            assert_eq!(
                capability.status(),
                StatusCode::NOT_FOUND,
                "preview={preview_enabled}"
            );
            for path in [
                format!("/api/structured/sessions/{id}/input-operation"),
                format!("/api/structured/sessions/{id}/supervised-input"),
            ] {
                let response = client.post(format!("{proxy}{path}")).bearer_auth(&auth).json(&json!({"text":"x","fallbackToMessage":false,"requestId":Uuid::new_v4(),"deliveryToken":"fabricated"})).send().await.unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::FORBIDDEN,
                    "preview={preview_enabled} {path}"
                );
            }
        }
        let legacy = client
            .post(format!("{operator}/api/structured/sessions/{id}/input"))
            .bearer_auth(&auth)
            .json(&json!({"text":"x","fallbackToMessage":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            legacy.status(),
            StatusCode::CONFLICT,
            "operator legacy input must reach the remote session"
        );
        let denied = client
            .post(format!("{observer}/api/structured/sessions/{id}/input"))
            .bearer_auth(&auth)
            .json(&json!({"text":"x","fallbackToMessage":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn paired_operator_recovers_receipts_context_and_queue_without_reexecution_or_grant_widening()
{
    let target_data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (id, request, turn) =
        interrupted_session(target_data.path(), workspace.path(), "remote-owner").await;
    let (foreign, _, _) =
        interrupted_session(target_data.path(), workspace.path(), "foreign-owner").await;
    let home = host(tempfile::tempdir().unwrap()).await;
    let target = host(target_data).await;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let operator = pair(&client, &home, &target, "operator", None).await;
    let local_token = token(&home, "local-owner");
    let client_operation = "/api/preview/4173/client-operation";
    let authorization =
        json!({"kind":"storage","storage":{"type":"sessionStorage","operation":"clear"}});
    assert_eq!(
        json_ok(
            client
                .post(format!("{operator}{client_operation}"))
                .bearer_auth(&local_token)
                .json(&authorization)
                .send()
                .await
                .unwrap()
        )
        .await,
        json!({"authorized":true,"executed":false,"delivery":"preview-client"})
    );
    let receipt_path = format!("/api/structured/sessions/{id}/requests/{request}");
    let receipt = json_ok(
        client
            .get(format!("{operator}{receipt_path}"))
            .bearer_auth(&local_token)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        (
            receipt["requestId"].as_str(),
            receipt["turnId"].as_str(),
            receipt["status"].as_str()
        ),
        (
            Some(request.as_str()),
            Some(turn.as_str()),
            Some("interrupted")
        )
    );
    assert_eq!(
        json_ok(
            client
                .get(format!("{operator}{receipt_path}"))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
        )
        .await,
        receipt
    );
    let context_path = format!("/api/structured/sessions/{id}/context");
    let context = json_ok(
        client
            .get(format!("{operator}{context_path}"))
            .bearer_auth(&local_token)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        (context["sessionId"].as_str(), context["scope"].as_str()),
        (Some(id.as_str()), Some("saved_conversation"))
    );
    let queue_path = format!("/api/structured/sessions/{id}/queue");
    let queue = json_ok(
        client
            .get(format!("{operator}{queue_path}"))
            .bearer_auth(&local_token)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let operation = Uuid::new_v4();
    let item = Uuid::new_v4();
    let mutation = json!({"operationId":operation,"expectedQueueRevision":queue["revision"],"operation":{"kind":"enqueue","itemId":item,"text":"Retain this synthetic follow-up","runWhenIdle":false}});
    let accepted = json_ok(
        client
            .post(format!("{}{queue_path}", target.url))
            .bearer_auth(token(&target, "remote-owner"))
            .json(&mutation)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let queue_receipt_path = format!("{queue_path}/operations/{operation}");
    assert_eq!(
        json_ok(
            client
                .get(format!("{operator}{queue_receipt_path}"))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
        )
        .await,
        accepted
    );
    let queued = json_ok(
        client
            .get(format!("{operator}{queue_path}"))
            .bearer_auth(&local_token)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(queued["order"], json!([item]));
    let history = json_ok(
        client
            .get(format!("{operator}/api/structured/sessions/{id}"))
            .bearer_auth(&local_token)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let events = history.get("session").unwrap_or(&history)["events"]
        .as_array()
        .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "user_message_accepted")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "turn_completed" && event["status"] == "interrupted")
            .count(),
        1
    );
    for profile in ["observer", "custom"] {
        let proxy = pair(
            &client,
            &home,
            &target,
            profile,
            (profile == "custom").then(|| json!({"fileWrite":true,"transfer":true})),
        )
        .await;
        assert_eq!(
            client
                .post(format!("{proxy}{client_operation}"))
                .bearer_auth(&local_token)
                .json(&authorization)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        for path in [
            &receipt_path,
            &context_path,
            &queue_path,
            &queue_receipt_path,
        ] {
            assert_eq!(
                client
                    .get(format!("{proxy}{path}"))
                    .bearer_auth(&local_token)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN,
                "{profile} {path}"
            );
        }
    }
    let agent = pair(
        &client,
        &home,
        &target,
        "custom",
        Some(json!({"agentExecute":true})),
    )
    .await;
    for path in [
        &receipt_path,
        &context_path,
        &queue_path,
        &queue_receipt_path,
    ] {
        assert_eq!(
            client
                .head(format!("{agent}{path}"))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{path}"
        );
    }
    assert_eq!(
        client
            .get(format!(
                "{operator}/api/structured/sessions/{foreign}/context"
            ))
            .bearer_auth(&local_token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!("{operator}{receipt_path}"))
            .bearer_auth(token(&home, "other-home-owner"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    for path in [
        "/api/vault",
        "/api/agent/connections",
        "/api/environments",
        "/api/structured/sessions/fake/attachments/fake",
    ] {
        assert_eq!(
            client
                .get(format!("{operator}{path}"))
                .bearer_auth(&local_token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    let grants = json_ok(
        client
            .get(format!("{}/api/environments", target.url))
            .bearer_auth(token(&target, "remote-owner"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    for grant in grants["grants"].as_array().unwrap() {
        assert_eq!(
            client
                .delete(format!(
                    "{}/api/environments/grants/{}",
                    target.url,
                    grant["id"].as_str().unwrap()
                ))
                .bearer_auth(token(&target, "remote-owner"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    assert!(!client
        .get(format!("{operator}{receipt_path}"))
        .bearer_auth(&local_token)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
}

#[tokio::test]
async fn preview_server_only_storage_and_evaluation_never_claim_undelivered_success() {
    let host = host(tempfile::tempdir().unwrap()).await;
    let client = reqwest::Client::new();
    let bearer = token(&host, "preview-fixture");
    assert_eq!(
        client
            .get(format!("{}/api/preview/4173/storage", host.url))
            .bearer_auth(&bearer)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_IMPLEMENTED
    );
    for storage_type in ["localStorage", "sessionStorage"] {
        let response = client
            .post(format!("{}/api/preview/4173/storage", host.url))
            .bearer_auth(&bearer)
            .json(&json!({"type":storage_type,"operation":"set","key":"synthetic","value":"value"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        assert!(response
            .json::<Value>()
            .await
            .unwrap()
            .get("success")
            .is_none());
    }
    let response = client
        .post(format!("{}/api/preview/4173/evaluate", host.url))
        .bearer_auth(&bearer)
        .json(&json!({"expression":"document.title"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    assert!(response
        .json::<Value>()
        .await
        .unwrap()
        .get("success")
        .is_none());
}

#[tokio::test]
async fn preview_client_operation_authorizes_without_claiming_execution_and_keeps_cookies_real() {
    let host = host(tempfile::tempdir().unwrap()).await;
    let client = reqwest::Client::new();
    let bearer = token(&host, "preview-fixture");
    let input = json!({"kind":"storage","storage":{"type":"localStorage","operation":"set","key":"synthetic","value":"value"}});
    let url = format!("{}/api/preview/4173/client-operation", host.url);
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&bearer)
            .json(&json!({"kind":"evaluate","expression":"document.title"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(&url)
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_ok(
            client
                .post(&url)
                .bearer_auth(&bearer)
                .json(&input)
                .send()
                .await
                .unwrap()
        )
        .await,
        json!({"authorized":true,"executed":false,"delivery":"preview-client"})
    );
    let invalid = json!({"kind":"storage","storage":{"type":"localStorage","operation":"set","key":"synthetic"}});
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&bearer)
            .json(&invalid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let endpoint = format!("{}/api/preview/4173/storage", host.url);
    json_ok(
        client
            .post(endpoint)
            .bearer_auth(&bearer)
            .json(&json!({"type":"cookies","operation":"set","key":"synthetic","value":"stored"}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let jar = json_ok(
        client
            .get(format!("{}/api/preview/4173/cookies", host.url))
            .bearer_auth(&bearer)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(jar["cookies"][0]["value"], "stored");
}

#[tokio::test]
async fn opted_in_evaluation_preflight_authorizes_only_the_client_and_never_claims_queued_execution(
) {
    const TEST: &str = "feature_delivery_contract_tests::opted_in_evaluation_preflight_authorizes_only_the_client_and_never_claims_queued_execution";
    const MARKER: &str = "TERMINAL_V4_PREVIEW_AUTHORIZATION_FIXTURE";
    if std::env::var_os(MARKER).is_none() {
        let directory = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(MARKER, "1")
            .env("PREVIEW_EVAL_ENABLED", "true")
            .env("HOME", directory.path())
            .env("USERPROFILE", directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let host = host(tempfile::tempdir().unwrap()).await;
    let client = reqwest::Client::new();
    let bearer = token(&host, "preview-fixture");
    let authorization = format!("{}/api/preview/4173/client-operation", host.url);
    assert_eq!(
        json_ok(
            client
                .post(&authorization)
                .bearer_auth(&bearer)
                .json(&json!({"kind":"evaluate","expression":"document.title"}))
                .send()
                .await
                .unwrap()
        )
        .await,
        json!({"authorized":true,"executed":false,"delivery":"preview-client"})
    );
    for expression in [String::new(), "x".repeat(10_001)] {
        assert_eq!(
            client
                .post(&authorization)
                .bearer_auth(&bearer)
                .json(&json!({"kind":"evaluate","expression":expression}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        client
            .post(format!("{}/api/preview/4173/evaluate", host.url))
            .bearer_auth(&bearer)
            .json(&json!({"expression":"document.title"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_IMPLEMENTED
    );
}
