use axum::{routing::post, Json};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::process::Command;

const OWNER: &str = "fixture-owner";
const VAULT_KEY: &str = "synthetic-vault-key";

fn seed(data: &Path, provider: &str) {
    let db = rusqlite::Connection::open(data.join("terminal.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE api_key_vault(user_id TEXT, key_name TEXT, key_value TEXT, created_at TEXT)",
    )
    .unwrap();
    let value =
        terminal_v4_api::vault::encrypt_secret("synthetic-provider-key", VAULT_KEY).unwrap();
    db.execute(
        "INSERT INTO api_key_vault VALUES(?1,?2,?3,'2020')",
        rusqlite::params![OWNER, format!("terminal-v4:provider:{provider}"), value],
    )
    .unwrap();
}

fn child(
    data: &Path,
    workspace: &Path,
    provider: &str,
    endpoint_key: &str,
    endpoint: &str,
    child_id: uuid::Uuid,
) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_terminal-v4-api"));
    command
        .args([
            "agent",
            "--provider",
            provider,
            "--owner-hex",
            &hex::encode(OWNER),
            "--query",
            "fixture",
            "--tool-policy",
            "read-only-child",
            "--child-session",
            &child_id.to_string(),
        ])
        .current_dir(workspace)
        .env("TERMINAL_DATA_DIR", data)
        .env("VAULT_ENCRYPTION_KEY", VAULT_KEY)
        .env(endpoint_key, endpoint)
        .env("NO_PROXY", "*")
        .kill_on_drop(true);
    command
}

fn reply(transport: &str, first: bool) -> Value {
    if !first {
        return match transport {
            "anthropic-messages" => {
                json!({"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]})
            }
            "openai-responses" => {
                json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]})
            }
            _ => {
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}]})
            }
        };
    }
    let calls = [
        ("write_file", json!({"path":"new.txt","content":"evil"})),
        (
            "replace_text",
            json!({"path":"original.txt","old":"original","new":"evil"}),
        ),
        ("run_command", json!({"command":"touch shell-created"})),
        ("create_schedule", json!({})),
        ("propose_knowledge", json!({})),
        ("mcp_call_tool", json!({})),
        ("browser_open", json!({})),
        ("future_mutation", json!({})),
        ("read_file", json!({"path":"original.txt"})),
        ("recall_sessions", json!({})),
    ];
    let items: Vec<Value> = calls.into_iter().enumerate().map(|(i,(name,input))| match transport {
        "anthropic-messages" => json!({"type":"tool_use","id":format!("call{i}"),"name":name,"input":input}),
        "openai-responses" => json!({"type":"function_call","call_id":format!("call{i}"),"name":name,"arguments":input.to_string()}),
        _ => json!({"id":format!("call{i}"),"type":"function","function":{"name":name,"arguments":input.to_string()}}),
    }).collect();
    match transport {
        "anthropic-messages" => json!({"stop_reason":"tool_use","content":items}),
        "openai-responses" => json!({"status":"completed","output":items}),
        _ => {
            json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":items}}]})
        }
    }
}

#[tokio::test]
async fn preallocated_child_identity_is_reserved_once_before_provider_execution() {
    let count = Arc::new(Mutex::new(0usize));
    let captured = count.clone();
    let router = axum::Router::new().fallback(post(move |Json(_): Json<Value>| {
        let captured = captured.clone();
        async move {
            *captured.lock().unwrap() += 1;
            Json(reply("openai-chat", false))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    seed(data.path(), "deepseek");
    let child_id = uuid::Uuid::new_v4();
    let endpoint = format!("http://{addr}/v1");
    let mut first = child(
        data.path(),
        workspace.path(),
        "deepseek",
        "DEEPSEEK_BASE_URL",
        &endpoint,
        child_id,
    );
    let mut second = child(
        data.path(),
        workspace.path(),
        "deepseek",
        "DEEPSEEK_BASE_URL",
        &endpoint,
        child_id,
    );
    let (one, two) = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        tokio::join!(first.output(), second.output())
    })
    .await
    .unwrap();
    let outputs = [one.unwrap(), two.unwrap()];
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.status.success())
            .count(),
        1
    );
    assert_eq!(*count.lock().unwrap(), 1);
    let success = outputs
        .iter()
        .find(|output| output.status.success())
        .unwrap();
    let result: Value = String::from_utf8_lossy(&success.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["type"] == "v4.result")
        .expect("child result event");
    assert_eq!(result["sessionId"], child_id.to_string());
    server.abort();
}

#[tokio::test]
async fn child_enforces_allowlist_against_unadvertised_calls_across_provider_protocols() {
    for (provider, env_key, transport) in [
        ("deepseek", "DEEPSEEK_BASE_URL", "openai-chat"),
        ("openai-api", "OPENAI_BASE_URL", "openai-responses"),
        ("anthropic-api", "ANTHROPIC_BASE_URL", "anthropic-messages"),
    ] {
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().fallback(post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(reply(transport, requests.len() == 1))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        seed(data.path(), provider);
        std::fs::write(workspace.path().join("original.txt"), "original").unwrap();
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            child(
                data.path(),
                workspace.path(),
                provider,
                env_key,
                &format!("http://{addr}/v1"),
                uuid::Uuid::new_v4(),
            )
            .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{provider}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("original.txt")).unwrap(),
            "original"
        );
        assert!(!workspace.path().join("new.txt").exists());
        assert!(!workspace.path().join("shell-created").exists());
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let names: Vec<_> = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| {
                if transport == "openai-chat" {
                    tool["function"]["name"].as_str().unwrap()
                } else {
                    tool["name"].as_str().unwrap()
                }
            })
            .collect();
        assert!(names.contains(&"read_file") && names.contains(&"recall_sessions"));
        assert!(!names.iter().any(|name| [
            "write_file",
            "replace_text",
            "run_command",
            "create_schedule",
            "propose_knowledge",
            "mcp_call_tool",
            "browser_open"
        ]
        .contains(name)));
        let followup = requests[1].to_string();
        assert_eq!(
            followup
                .matches("Tool denied by read-only child policy")
                .count(),
            8,
            "{provider}: {followup}"
        );
        assert!(followup.contains("original"));
        assert!(!followup.contains("Unknown tool"));
        let read_result = match transport {
            "anthropic-messages" => requests[1]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|message| message["content"].as_array().into_iter().flatten())
                .find(|item| item["tool_use_id"] == "call9")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
            "openai-responses" => requests[1]["input"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["call_id"] == "call9" && item["type"] == "function_call_output")
                .unwrap()["output"]
                .as_str()
                .unwrap(),
            _ => requests[1]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["tool_call_id"] == "call9")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        };
        assert!(serde_json::from_str::<Value>(read_result).unwrap()["sessions"].is_array());
        server.abort();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn read_only_child_stops_while_provider_request_is_pending() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let entered = Arc::new(Mutex::new(Some(entered_tx)));
    let router = axum::Router::new().fallback(post(move |Json(_): Json<Value>| {
        let entered = entered.clone();
        async move {
            if let Some(tx) = entered.lock().unwrap().take() {
                let _ = tx.send(());
            }
            std::future::pending::<Json<Value>>().await
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    seed(data.path(), "deepseek");
    let mut process = child(
        data.path(),
        workspace.path(),
        "deepseek",
        "DEEPSEEK_BASE_URL",
        &format!("http://{addr}/v1"),
        uuid::Uuid::new_v4(),
    )
    .spawn()
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), entered_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        unsafe { libc::kill(process.id().unwrap() as i32, libc::SIGTERM) },
        0
    );
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), process.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(130));
    assert_eq!(std::fs::read_dir(workspace.path()).unwrap().count(), 0);
    server.abort();
}
