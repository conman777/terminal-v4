#![cfg(all(unix, feature = "supervised-input-preview"))]

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use terminal_v4_api::{app, ApiState};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;

#[tokio::test]
async fn production_runtime_keeps_supervised_input_unavailable_by_default() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "isolated-preview-test-secret".into(),
        local_testing_login: true,
        ..Default::default()
    };
    let state = ApiState::new_runtime(config).unwrap();
    let login = Request::builder()
        .method("POST")
        .uri("/api/auth/local-testing")
        .header("host", "127.0.0.1:3020")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"username":"preview-fixture"}).to_string(),
        ))
        .unwrap();
    let login = app(state.clone()).oneshot(login).await.unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let login = axum::body::to_bytes(login.into_body(), 8192).await.unwrap();
    let login: Value = serde_json::from_slice(&login).unwrap();
    let token = login["tokens"]["accessToken"].as_str().unwrap();
    let capability = Request::builder()
        .uri("/api/structured/input-capabilities")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app(state).oneshot(capability).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let installed: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='owner_input_receipts')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!installed);
}

#[tokio::test]
async fn fixture_activation_refuses_normal_and_non_loopback_configuration() {
    let normal = tempfile::tempdir().unwrap();
    let state = ApiState::new_runtime(AppConfig {
        data_dir: normal.path().into(),
        jwt_secret: "isolated-preview-test-secret".into(),
        ..Default::default()
    })
    .unwrap();
    assert!(state.enable_supervised_input_loopback_fixture().is_err());
    let remote = tempfile::tempdir().unwrap();
    let state = ApiState::new_runtime(AppConfig {
        host: "0.0.0.0".parse().unwrap(),
        data_dir: remote.path().into(),
        jwt_secret: "isolated-preview-test-secret".into(),
        ..Default::default()
    })
    .unwrap();
    assert!(state.enable_supervised_input_loopback_fixture().is_err());
}

#[tokio::test]
async fn fixture_environment_switch_cannot_enable_a_normal_server() {
    let data = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_terminal-v4-api"));
    command
        .env_clear()
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("JWT_SECRET", "isolated-preview-test-secret")
        .env("TERMINAL_DATA_DIR", data.path())
        .env("TERMINAL_V4_SUPERVISED_INPUT_FIXTURE", "1")
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("requires loopback local-testing mode")
    );
}

#[tokio::test]
#[ignore = "isolated subprocess fixture"]
async fn real_preview_http_fixture() {
    let Some(root) = std::env::var_os("V4_INPUT_HTTP_FIXTURE_ROOT") else {
        return;
    };
    let root = std::path::Path::new(&root);
    let data = root.join("data");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let config = AppConfig {
        data_dir: data,
        jwt_secret: "isolated-preview-test-secret".into(),
        local_testing_login: true,
        ..Default::default()
    };
    let state = ApiState::new_runtime(config).unwrap();
    state.enable_supervised_input_loopback_fixture().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app(state)).await.unwrap();
    });
    let client = reqwest::Client::new();
    let base = format!("http://{address}");
    let login: Value = client
        .post(format!("{base}/api/auth/local-testing"))
        .json(&json!({"username":"fixture"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = login["tokens"]["accessToken"].as_str().unwrap();
    let session: Value = client
        .post(format!("{base}/api/structured/sessions"))
        .bearer_auth(token)
        .json(&json!({"cwd":workspace.to_str().unwrap(),"provider":"claude"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_str().unwrap();
    let start = client
        .post(format!("{base}/api/structured/sessions/{id}/message"))
        .bearer_auth(token)
        .json(&json!({"text":"start synthetic agent"}))
        .send()
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::ACCEPTED);
    let issue = || {
        client
            .post(format!(
                "{base}/api/structured/sessions/{id}/input-operation"
            ))
            .bearer_auth(token)
    };
    let first: Value = issue()
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let first_id = first["requestId"].as_str().unwrap();
    let first_token = first["deliveryToken"].as_str().unwrap();
    let send = |operation: &str, proof: &str, text: &str| {
        client.post(format!("{base}/api/structured/sessions/{id}/supervised-input")).bearer_auth(token).json(&json!({"text":text,"fallbackToMessage":false,"requestId":operation,"deliveryToken":proof}))
    };
    let accepted = send(first_id, first_token, "\n").send().await.unwrap();
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let accepted: Value = accepted.json().await.unwrap();
    assert_eq!(accepted["outcome"], "delivered");
    assert_eq!(
        send(first_id, first_token, "\n")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let acknowledgment: Value = client
        .post(format!(
            "{base}/api/structured/input-receipts/{id}/{first_id}/review"
        ))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(acknowledgment["status"], "acknowledged");
    let repeated: Value = client
        .post(format!(
            "{base}/api/structured/input-receipts/{id}/{first_id}/review"
        ))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(repeated["status"], "acknowledged");
    let second: Value = issue()
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let second_id = second["requestId"].as_str().unwrap();
    let second_token = second["deliveryToken"].as_str().unwrap();
    let partial = send(second_id, second_token, &"x".repeat(100_000))
        .send()
        .await
        .unwrap();
    assert_eq!(partial.status(), StatusCode::CONFLICT);
    let partial: Value = partial.json().await.unwrap();
    assert_eq!(partial["outcome"], "uncertain");
    let receipt: Value = client
        .get(format!(
            "{base}/api/structured/input-receipts/{id}/{second_id}"
        ))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(receipt["status"], "uncertain");
    let review: Value = client
        .post(format!(
            "{base}/api/structured/input-receipts/{id}/{second_id}/review"
        ))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(review["status"], "reviewed");
    let deleted = client
        .delete(format!("{base}/api/structured/sessions/{id}"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert!(deleted.status().is_success());
    server.abort();
}

#[tokio::test]
async fn real_preview_http_flow_uses_isolated_process_and_data() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("synthetic-claude");
    std::fs::write(&executable, "#!/bin/sh\nexec /bin/sleep 8\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "real_preview_http_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("V4_INPUT_HTTP_FIXTURE_ROOT", root.path())
        .env("CLAUDE_BIN", executable)
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "fixture failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}
