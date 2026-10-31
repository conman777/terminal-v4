#![cfg(all(unix, not(feature = "queued-authority-preview")))]

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use terminal_v4_api::{app, vault::decrypt_secret, ApiState};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "isolated-default-queue-integration-secret";

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

fn queue_file(data: &Path, owner: &str, workspace: &Path, session: &str) -> std::path::PathBuf {
    let digest = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    data.join("followup-queues")
        .join(digest(owner.as_bytes()))
        .join(digest(
            workspace
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
                .as_bytes(),
        ))
        .join(format!("{session}.json"))
}

fn read_authority(data: &Path, path: &Path, item: Uuid) -> Value {
    let envelope: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let proof = envelope["authorityProofs"][item.to_string()]
        .as_str()
        .unwrap();
    let ciphertext = proof.strip_prefix("queue:v1:").unwrap();
    let key = std::fs::read_to_string(data.join("queue-authority.key")).unwrap();
    serde_json::from_str(&decrypt_secret(ciphertext, &key).unwrap()).unwrap()
}

#[tokio::test]
async fn default_build_binds_queue_edits_to_login_and_holds_legacy_after_upgrade() {
    if std::env::var_os("V4_QUEUE_CUTOVER_FIXTURE").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("V4_QUEUE_CUTOVER_FIXTURE", "1")
            .env("DEEPSEEK_BASE_URL", "http://127.0.0.1:9/v1")
            .arg("--exact")
            .arg("default_build_binds_queue_edits_to_login_and_holds_legacy_after_upgrade")
            .arg("--nocapture")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated fixture failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = ApiState::new_runtime(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: SECRET.into(),
        local_testing_login: true,
        ..Default::default()
    })
    .unwrap();
    let router = app(state);
    let (status, login) = request(
        &router,
        "POST",
        "/api/auth/local-testing",
        None,
        json!({"username":"queue-cutover"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    let owner = login["user"]["id"].as_str().unwrap();
    let username = login["user"]["username"].as_str().unwrap();
    let old_token = login["tokens"]["accessToken"].as_str().unwrap();
    let mut sessions = Vec::new();
    for _ in 0..2 {
        let (status, session) = request(&router, "POST", "/api/structured/sessions", Some(old_token),
            json!({"cwd":workspace.path(),"provider":"deepseek","model":"deepseek-chat","title":"Isolated queue"})).await;
        assert_eq!(status, StatusCode::CREATED, "{session}");
        sessions.push(session["id"].as_str().unwrap().to_owned());
    }
    let legacy_item = Uuid::new_v4();
    let legacy_url = format!("/api/structured/sessions/{}/queue", sessions[0]);
    let (status, result) = request(&router, "POST", &legacy_url, Some(old_token), json!({
        "operationId":Uuid::new_v4(),"expectedQueueRevision":0,
        "operation":{"kind":"enqueue","itemId":legacy_item,"text":"Legacy queued text","runWhenIdle":false}
    })).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let legacy_path = queue_file(data.path(), owner, workspace.path(), &sessions[0]);
    let envelope: Value = serde_json::from_slice(&std::fs::read(&legacy_path).unwrap()).unwrap();
    assert!(envelope.get("authorityProofs").is_none());

    let paired_token = format!("tv4pair.{}", "a".repeat(64));
    let (status, _) = request(
        &router,
        "GET",
        &legacy_url,
        Some(&paired_token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let auth_session = Uuid::new_v4();
    let db = Connection::open(data.path().join("terminal.db")).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    db.execute(
        "INSERT INTO paired_grants(id,hash,owner,username,label,created,expires,profile,capabilities) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![Uuid::new_v4().to_string(), format!("{:x}", Sha256::digest(paired_token.as_bytes())), owner,
            username, "synthetic", now as i64, (now + 3600) as i64, "operator", json!({"agentExecute":true}).to_string()],
    ).unwrap();
    db.execute("UPDATE users SET auth_protocol_min=1 WHERE id=?1", [owner])
        .unwrap();
    db.execute("INSERT INTO auth_generations(user_id,generation) VALUES (?1,1) ON CONFLICT(user_id) DO UPDATE SET generation=1", [owner]).unwrap();
    db.execute("INSERT INTO auth_sessions(id,user_id,generation,logout_capability_hash,revoked_at,created_at) VALUES (?1,?2,1,?3,NULL,?4)",
        params![auth_session.to_string(), owner, "0".repeat(64), "2026-01-01T00:00:00Z"]).unwrap();
    let token = encode(&Header::default(), &json!({"sub":owner,"username":username,"iat":now,"exp":now+3600,
        "token_kind":"access","generation":1,"auth_protocol":1,"session_id":auth_session.to_string()}),
        &EncodingKey::from_secret(SECRET.as_bytes())).unwrap();

    let (status, queue) = request(
        &router,
        "GET",
        &legacy_url,
        Some(&paired_token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    for operation in [
        json!({"kind":"enqueue","itemId":Uuid::new_v4(),"text":"Disallowed paired text","runWhenIdle":false}),
        json!({"kind":"edit","itemId":legacy_item,"expectedItemRevision":1,"text":"Disallowed paired edit"}),
    ] {
        let (status, result) = request(&router, "POST", &legacy_url, Some(&paired_token), json!({
            "operationId":Uuid::new_v4(),"expectedQueueRevision":queue["revision"],"operation":operation
        })).await;
        assert_eq!(status, StatusCode::CONFLICT, "{result}");
    }
    let (status, unchanged) = request(
        &router,
        "GET",
        &legacy_url,
        Some(&paired_token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unchanged}");
    assert_eq!(unchanged, queue);

    let signed_url = format!("/api/structured/sessions/{}/queue", sessions[1]);
    let item = Uuid::new_v4();
    let (status, result) = request(&router, "POST", &signed_url, Some(&token), json!({
        "operationId":Uuid::new_v4(),"expectedQueueRevision":0,
        "operation":{"kind":"enqueue","itemId":item,"text":"Authorized initial text","runWhenIdle":false}
    })).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let signed_path = queue_file(data.path(), owner, workspace.path(), &sessions[1]);
    let before = read_authority(data.path(), &signed_path, item);
    assert_eq!(before["version"], 3);
    assert_eq!(before["authProtocol"], 1);
    assert_eq!(before["authSessionId"], auth_session.to_string());
    assert_eq!(before["owner"], owner);
    assert_eq!(before["parentSessionId"], sessions[1]);
    let (status, queue) = request(&router, "GET", &signed_url, Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    let (status, result) = request(&router, "POST", &signed_url, Some(&token), json!({
        "operationId":Uuid::new_v4(),"expectedQueueRevision":queue["revision"],
        "operation":{"kind":"edit","itemId":item,"expectedItemRevision":1,"text":"Authorized edited text"}
    })).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let after = read_authority(data.path(), &signed_path, item);
    assert_eq!(after["version"], 3);
    assert_eq!(after["authSessionId"], auth_session.to_string());
    assert_ne!(before["textDigest"], after["textDigest"]);
    assert_eq!(
        after["textDigest"],
        format!("{:x}", Sha256::digest(b"Authorized edited text"))
    );

    let (status, queue) = request(&router, "GET", &legacy_url, Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    let (status, result) = request(&router, "POST", &legacy_url, Some(&token), json!({
        "operationId":Uuid::new_v4(),"expectedQueueRevision":queue["revision"],"operation":{"kind":"resume"}
    })).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let queue = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, queue) = request(&router, "GET", &legacy_url, Some(&token), Value::Null).await;
            if queue["holdReason"] == "dispatch_error" {
                break queue;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("legacy queue did not hold after protocol upgrade");
    assert_eq!(queue["mode"], "held");
    assert_eq!(queue["items"][0]["state"], "pending");
    let (status, session) = request(
        &router,
        "GET",
        &format!("/api/structured/sessions/{}", sessions[0]),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert!(!session["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["type"] == "user_message_accepted"));
}
