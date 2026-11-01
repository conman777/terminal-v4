#![cfg(all(unix, feature = "native-codex-queue-preview"))]

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use terminal_v4_api::{app, ApiState};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "isolated-native-queue-integration-secret";
const FIXTURE: &str = "V4_NATIVE_QUEUE_ROUTE_FIXTURE";

async fn request(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:3020")
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, body)
}

async fn login(router: &Router, username: &str) -> String {
    let (status, login) = request(
        router,
        "POST",
        "/api/auth/local-testing",
        None,
        json!({"username":username}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    login["tokens"]["accessToken"].as_str().unwrap().to_owned()
}

fn run_isolated(test: &str, enable: Option<(&str, &str)>) {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env(FIXTURE, "1")
        .env("DEEPSEEK_BASE_URL", "http://127.0.0.1:9/v1");
    if let Some((name, value)) = enable {
        command.env(name, value);
    }
    let output = command
        .arg("--exact")
        .arg(test)
        .arg("--nocapture")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "isolated fixture failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn router(data: &std::path::Path) -> Router {
    app(ApiState::new_runtime(AppConfig {
        data_dir: data.into(),
        jwt_secret: SECRET.into(),
        local_testing_login: true,
        ..Default::default()
    })
    .unwrap())
}

fn enqueue_body(item: Uuid, revision: &Value) -> Value {
    json!({
        "operationId": Uuid::new_v4(),
        "expectedQueueRevision": revision,
        "operation": {"kind":"enqueue","itemId":item,"text":"queued native text","runWhenIdle":false}
    })
}

#[tokio::test]
async fn native_codex_queue_routes_enforce_owner_and_stay_unavailable_without_the_runtime_switch() {
    if std::env::var_os(FIXTURE).is_none() {
        run_isolated(
            "native_codex_queue_routes_enforce_owner_and_stay_unavailable_without_the_runtime_switch",
            Some(("TERMINAL_V4_NATIVE_CODEX_QUEUE", "1")),
        );
        run_isolated(
            "native_codex_queue_routes_enforce_owner_and_stay_unavailable_without_the_runtime_switch",
            None,
        );
        return;
    }
    let enabled = std::env::var("TERMINAL_V4_NATIVE_CODEX_QUEUE").is_ok_and(|value| value == "1");
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let router = router(data.path());
    let owner = login(&router, "native-owner").await;
    let intruder = login(&router, "native-intruder").await;

    let (status, session) = request(
        &router,
        "POST",
        "/api/structured/sessions",
        Some(&owner),
        json!({"cwd":workspace.path(),"provider":"codex","title":"Native queue"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{session}");
    let url = format!(
        "/api/structured/sessions/{}/queue",
        session["id"].as_str().unwrap()
    );
    let item = Uuid::new_v4();
    let queue_dir = data.path().join("followup-queues");

    let (anonymous, _) = request(&router, "GET", &url, None, Value::Null).await;
    assert_eq!(anonymous, StatusCode::UNAUTHORIZED);

    if !enabled {
        let (status, body) = request(&router, "GET", &url, Some(&owner), Value::Null).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        let (status, body) = request(
            &router,
            "POST",
            &url,
            Some(&owner),
            enqueue_body(item, &json!(0)),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert!(!queue_dir.exists());
        return;
    }

    let (status, queue) = request(&router, "GET", &url, Some(&owner), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    let foreign_operation = Uuid::new_v4();
    for (method, uri, body) in [
        ("GET", url.clone(), Value::Null),
        ("POST", url.clone(), enqueue_body(item, &queue["revision"])),
        (
            "GET",
            format!("{url}/operations/{foreign_operation}"),
            Value::Null,
        ),
    ] {
        let (status, body) = request(&router, method, &uri, Some(&intruder), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {body}");
    }
    let (status, body) = request(
        &router,
        "POST",
        &url,
        Some(&owner),
        enqueue_body(item, &queue["revision"]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, queue) = request(&router, "GET", &url, Some(&owner), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(queue["items"].as_array().unwrap().len(), 1);
    let (status, _) = request(&router, "GET", &url, Some(&intruder), Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = request(
        &router,
        "DELETE",
        url.trim_end_matches("/queue"),
        Some(&intruder),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = request(
        &router,
        "DELETE",
        url.trim_end_matches("/queue"),
        Some(&owner),
        Value::Null,
    )
    .await;
    assert!(status.is_success(), "{status} {body}");
    let (status, _) = request(&router, "GET", &url, Some(&owner), Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
