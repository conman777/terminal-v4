use super::*;
use serde_json::json;

#[test]
fn completion_keeps_explicit_tool_identity() {
    let seq = AtomicUsize::new(0);
    let mut text = String::new();
    let mut tools = HashMap::new();
    map_claude_message(
        &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-a","name":"Read","input":{}}]}}),
        &seq,
        &mut text,
        &mut tools,
    );
    let completed = map_claude_message(
        &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-a","content":"contents"}]},"tool_use_result":"contents"}),
        &seq,
        &mut text,
        &mut tools,
    );
    assert!(
        matches!(&completed[..], [StructuredSessionEvent::ToolCompleted { tool_call_id: Some(id), tool_name, result, .. }] if id=="call-a" && tool_name=="Read" && result=="contents")
    );
}

struct HeldController;
#[async_trait]
impl StructuredProcessController for HeldController {
    async fn send_input(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn send_approval(&self, _: bool) -> Result<(), String> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn kill(&self) -> Result<(), String> {
        Ok(())
    }
}
struct HeldProvider;
impl StructuredProvider for HeldProvider {
    fn provider_id(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        let (tx, events) = mpsc::unbounded_channel();
        // Hold this fixture open until the runtime shuts down.
        tokio::spawn(async move {
            let _tx = tx;
            std::future::pending::<()>().await;
        });
        Ok(SpawnedStructuredProcess {
            controller: Arc::new(HeldController),
            events,
        })
    }
}
#[tokio::test]
async fn native_prompt_is_durable_and_broadcast_once() {
    let dir = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let manager =
        StructuredSessionManager::new_with_providers(config.clone(), vec![Arc::new(HeldProvider)]);
    let session = manager
        .create_session(
            "owner",
            dir.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let (_, mut receiver) = manager.subscribe("owner", &session.id).await.unwrap();
    manager
        .send_message("owner", &session.id, "Keep this question")
        .await
        .unwrap();
    let saved = StructuredSessionManager::new(config)
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(&saved.events[..], [StructuredSessionEvent::MessageCompleted {role,content,..}] if role=="user" && content=="Keep this question")
    );
    assert!(
        matches!(receiver.try_recv().unwrap(), StructuredSessionEvent::MessageCompleted {role,..} if role=="user")
    );
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn retired_session_metadata_cannot_recreate_deleted_storage() {
    let dir = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    });
    let snapshot = manager
        .create_session(
            "owner",
            dir.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let session = manager
        .owned_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    session.state.lock().await.deleting = true;
    assert!(manager
        .rename_session("owner", &snapshot.id, "Renamed")
        .await
        .is_err());
    assert!(manager
        .update_thread(
            "owner",
            &snapshot.id,
            StructuredThreadUpdate {
                pinned: Some(true),
                ..Default::default()
            }
        )
        .await
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn claude_stop_removes_owned_descendant() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let survivor = dir.path().join("survivor");
    let child = Command::new("python3").args(["-c", "import subprocess,sys,pathlib,time; p=subprocess.Popen([sys.executable,'-c','import time,pathlib,sys; time.sleep(1); pathlib.Path(sys.argv[1]).write_text(\"alive\"); time.sleep(60)',sys.argv[2]]); pidfile=pathlib.Path(sys.argv[1]); temporary=pidfile.with_suffix('.tmp'); temporary.write_text(str(p.pid)); temporary.replace(pidfile); time.sleep(60)"]).arg(&pidfile).arg(&survivor).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).process_group(0).spawn().unwrap();
    let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child).unwrap();
    let controller = ClaudeStructuredProcessController {
        tree,
        blocked: AtomicBool::new(false),
        child: Arc::new(Mutex::new(child)),
        stdin: Mutex::new(None),
        interrupted: Arc::new(AtomicBool::new(false)),
        browser: Mutex::new(None),
    };
    let pid = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Some(pid) = fs::read_to_string(&pidfile)
                .ok()
                .and_then(|text| text.parse::<i32>().ok())
                .filter(|pid| *pid > 1)
            {
                break pid;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Synthetic Claude must atomically publish its descendant PID");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let stopped = controller.interrupt().await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let survived = survivor.exists();
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    stopped.unwrap();
    assert!(
        !survived,
        "Owned Claude command continued after confirmed Stop"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_claude_resume_reaches_synthetic_executable() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("claude-fixture");
    fs::write(&executable,"#!/bin/sh\nprintf '%s\\n' \"$@\" > args\nprintf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\"}'\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut spawned = ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: dir.path().to_str().unwrap().into(),
            session_id: Some("thread-exact".into()),
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: None,
        },
        executable.to_str().unwrap(),
    )
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while spawned.events.recv().await.is_some() {}
    })
    .await
    .unwrap();
    let args = fs::read_to_string(dir.path().join("args")).unwrap();
    assert!(args
        .lines()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|pair| pair == ["--resume", "thread-exact"]));
    assert!(!args.lines().any(|arg| arg == "--continue"));
}

#[test]
fn shared_browser_keeps_native_permissions_and_adds_only_its_named_mcp_server() {
    let dir = tempfile::tempdir().unwrap();
    let browser = crate::workspace_browser::agent_connection(
        &AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        },
        "owner",
        "claude:fixture:turn",
    )
    .unwrap();
    let options = StructuredSpawnOptions {
        prompt: "Question".into(),
        cwd: dir.path().to_str().unwrap().into(),
        session_id: Some("thread-exact".into()),
        model: Some("fixture-model".into()),
        reasoning: None,
        service_tier: None,
        access_mode: None,
        plan: false,
        turn_id: None,
        browser: Some(browser.clone()),
    };
    let args = ClaudeStructuredProvider::args(&options, true);
    assert!(!args.iter().any(|arg| matches!(
        arg.as_str(),
        "--dangerously-skip-permissions"
            | "--allow-dangerously-skip-permissions"
            | "--strict-mcp-config"
            | "--tools"
            | "--settings"
    )));
    let allowed = args
        .windows(2)
        .find(|pair| pair[0] == "--allowedTools")
        .expect("Owned browser transport must reach the parent approval queue in print mode");
    let expected = [
        "browser_open",
        "browser_navigate",
        "browser_snapshot",
        "browser_get_images",
        "browser_click",
        "browser_type",
        "browser_select",
        "browser_scroll",
        "browser_wait",
        "browser_back",
        "browser_forward",
        "browser_screenshot",
        "browser_evaluate",
        "browser_tabs",
        "browser_close",
        "browser_release_control",
    ]
    .map(|name| format!("mcp__terminal_v4_browser__{name}"));
    assert_eq!(allowed[1].split(',').collect::<Vec<_>>(), expected);
    let mut advertised = crate::v4_agent::browser::definitions()
        .iter()
        .map(|tool| {
            format!(
                "mcp__terminal_v4_browser__{}",
                tool["name"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>();
    advertised.push("mcp__terminal_v4_browser__browser_release_control".into());
    assert_eq!(expected.as_slice(), advertised);
    assert_eq!(
        args.iter().filter(|arg| *arg == "--allowedTools").count(),
        1
    );
    assert_eq!(args, ClaudeStructuredProvider::args(&options, false));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "acceptEdits"]));
    let config = args
        .windows(2)
        .find(|pair| pair[0] == "--mcp-config")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&config[1]).unwrap(),
        json!({"mcpServers": {"terminal_v4_browser": {
            "type": "http", "url": browser.url, "headers": {"Authorization": format!("Bearer {}", browser.token)}
        }}})
    );
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--append-system-prompt", SHARED_BROWSER_INSTRUCTIONS]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--resume", "thread-exact"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--model", "fixture-model"]));

    let mut ordinary = options;
    ordinary.browser = None;
    let args = ClaudeStructuredProvider::args(&ordinary, false);
    assert!(!args.iter().any(|arg| matches!(
        arg.as_str(),
        "--allowedTools" | "--mcp-config" | "--dangerously-skip-permissions"
    )));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "acceptEdits"]));
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Requires REAL_CLAUDE_BIN; isolated CLI and loopback synthetic model only, no paid calls"]
async fn real_claude_browser_transport_waits_for_parent_review_and_preserves_native_permissions() {
    use axum::{routing::post, Extension, Json};
    use std::time::Duration;

    let executable = std::env::var("REAL_CLAUDE_BIN")
        .expect("Set REAL_CLAUDE_BIN to the absolute installed Claude executable");
    assert!(Path::new(&executable).is_absolute());
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("editable.txt");
    fs::write(&file, "original").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        port: address.port(),
        ..Default::default()
    };
    crate::v4_agent::browser::save_config(
        &config.data_dir,
        "fixture-owner",
        &crate::v4_agent::browser::BrowserConfig {
            enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    let state = crate::state::AppState::new(config.clone()).unwrap();
    let messages = Arc::new(AtomicUsize::new(0));
    let observed = messages.clone();
    let edit_file = file.clone();
    let app = browser_fixture_router(&config)
        .merge(crate::workspace_browser::routes()
            .layer(Extension(crate::auth::AuthenticatedUser {
                user_id: "fixture-owner".into(), username: "fixture-owner".into(),
            }))
            .with_state(state))
        .route("/v1/messages/count_tokens", post(|| async { Json(json!({"input_tokens":100})) }))
        .route("/v1/messages", post(move |Json(request): Json<Value>| {
            let turn = observed.fetch_add(1, Ordering::SeqCst);
            let edit_file = edit_file.clone();
            async move {
                assert_eq!(request["stream"], true);
                let content = if turn == 0 {
                    vec![
                        json!({"type":"tool_use","id":"fixture-browser","name":"mcp__terminal_v4_browser__browser_tabs","input":{}}),
                        json!({"type":"tool_use","id":"fixture-read","name":"Read","input":{"file_path":edit_file}}),
                        json!({"type":"tool_use","id":"fixture-shell","name":"Bash","input":{"command":"touch shell-marker","description":"Synthetic permission regression"}}),
                        json!({"type":"tool_use","id":"fixture-edit","name":"Edit","input":{"file_path":edit_file,"old_string":"original","new_string":"changed"}}),
                    ]
                } else if turn == 1 {
                    vec![json!({"type":"tool_use","id":"fixture-approved-browser","name":"mcp__terminal_v4_browser__browser_tabs","input":{}})]
                } else { vec![json!({"type":"text","text":"Local fixture finished"})] };
                let mut events = vec![("message_start", json!({"type":"message_start","message":{
                    "id":"fixture-message","type":"message","role":"assistant","content":[],
                    "model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,
                    "usage":{"input_tokens":100,"output_tokens":0}
                }}))];
                for (index, block) in content.iter().enumerate() {
                    let (start, delta) = if block["type"] == "tool_use" {
                        (json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":{}}),
                         json!({"type":"input_json_delta","partial_json":block["input"].to_string()}))
                    } else {
                        (json!({"type":"text","text":""}), json!({"type":"text_delta","text":block["text"]}))
                    };
                    events.extend([
                        ("content_block_start", json!({"type":"content_block_start","index":index,"content_block":start})),
                        ("content_block_delta", json!({"type":"content_block_delta","index":index,"delta":delta})),
                        ("content_block_stop", json!({"type":"content_block_stop","index":index})),
                    ]);
                }
                events.extend([
                    ("message_delta", json!({"type":"message_delta","delta":{"stop_reason":if turn < 2 {"tool_use"} else {"end_turn"},"stop_sequence":null},"usage":{"output_tokens":20}})),
                    ("message_stop", json!({"type":"message_stop"})),
                ]);
                let body = events.into_iter().map(|(name, value)| format!("event: {name}\ndata: {value}\n\n")).collect::<String>();
                ([("content-type", "text/event-stream")], body)
            }
        }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let browser =
        crate::workspace_browser::agent_connection(&config, "fixture-owner", "Claude CLI fixture")
            .unwrap();
    let args = ClaudeStructuredProvider::args(
        &StructuredSpawnOptions {
            prompt: "Run the synthetic local permission fixture".into(),
            cwd: dir.path().to_string_lossy().into(),
            session_id: None,
            model: Some("claude-sonnet-4-6".into()),
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: Some(browser.clone()),
        },
        true,
    );
    // Bare mode and an empty home prevent private config, histories, hooks and keychain access.
    // The only model endpoint is this test's loopback SSE fixture with a synthetic key.
    let mut child = Command::new(executable)
        .args(args)
        .args([
            "--bare",
            "--no-session-persistence",
            "--setting-sources",
            "",
        ])
        .env_clear()
        .env("HOME", dir.path())
        .env("CLAUDE_CONFIG_DIR", dir.path().join("claude"))
        .env("PATH", "/usr/bin:/bin")
        .env("ANTHROPIC_API_KEY", "synthetic-loopback-only")
        .env("ANTHROPIC_BASE_URL", format!("http://{address}"))
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env("DISABLE_AUTOUPDATER", "1")
        .current_dir(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let approval_url = format!("http://{address}/api/workspace-browser/approvals");
    let pending = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let response: Value = client
                .get(&approval_url)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            if let Some(row) = response["requests"].as_array().unwrap().first() {
                break row.clone();
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "CLI exited before reaching the parent approval queue"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Real Claude must discover and call the owned HTTP MCP server");
    assert_eq!(
        (&pending["name"], &pending["arguments"], &pending["label"]),
        (
            &json!("browser_tabs"),
            &json!({}),
            &json!("Claude CLI fixture")
        )
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        messages.load(Ordering::SeqCst),
        1,
        "No browser result may reach the CLI before pane review"
    );
    assert!(child.try_wait().unwrap().is_none());
    client
        .post(format!(
            "{approval_url}/{}",
            pending["id"].as_str().unwrap()
        ))
        .json(&json!({"approved":false}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let next = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let response: Value = client
                .get(&approval_url)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            if let Some(row) = response["requests"].as_array().unwrap().first() {
                break row.clone();
            }
            assert!(child.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The next browser call must need its own pane decision");
    assert_ne!(next["id"], pending["id"]);
    assert_eq!(
        (&next["name"], &next["arguments"]),
        (&json!("browser_tabs"), &json!({}))
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(messages.load(Ordering::SeqCst), 2);
    assert!(child.try_wait().unwrap().is_none());
    client
        .post(format!("{approval_url}/{}", next["id"].as_str().unwrap()))
        .json(&json!({"approved":true}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "Isolated Claude failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let init = events
        .iter()
        .find(|event| event["type"] == "system" && event["subtype"] == "init")
        .unwrap();
    assert_eq!(init["permissionMode"], "default");
    assert!(init["mcp_servers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|server| server["name"] == "terminal_v4_browser" && server["status"] == "connected"));
    let results = events
        .iter()
        .filter(|event| event["type"] == "user")
        .flat_map(|event| event["message"]["content"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    assert!(results
        .iter()
        .any(|result| result["tool_use_id"] == "fixture-browser"
            && result["is_error"] == true
            && result["content"]
                .as_str()
                .is_some_and(|text| text.contains("user denied this browser action"))));
    let approved = results
        .iter()
        .find(|result| result["tool_use_id"] == "fixture-approved-browser")
        .unwrap();
    assert_ne!(approved["is_error"], true);
    let approved_text = approved["content"]
        .as_str()
        .or_else(|| approved["content"][0]["text"].as_str())
        .expect("The approved MCP result must contain text");
    assert_eq!(
        serde_json::from_str::<Value>(approved_text).unwrap(),
        json!({"tabs":[],"activeTabId":null})
    );
    assert!(results
        .iter()
        .any(|result| result["tool_use_id"] == "fixture-read"
            && result["is_error"] != true
            && result["content"].to_string().contains("original")));
    let result = events
        .iter()
        .find(|event| event["type"] == "result")
        .unwrap();
    let mut denied = result["permission_denials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["tool_name"].as_str().unwrap())
        .collect::<Vec<_>>();
    denied.sort_unstable();
    assert_eq!(denied, ["Bash", "Edit"]);
    assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    assert!(!dir.path().join("shell-marker").exists());
    assert_eq!(messages.load(Ordering::SeqCst), 3);
}

#[cfg(unix)]
#[tokio::test]
async fn shared_browser_claude_config_reaches_process_and_echoed_secrets_are_redacted() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("claude-fixture");
    fs::write(&executable, r#"#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
config = json.loads(args[args.index('--mcp-config') + 1])
pathlib.Path('config.json').write_text(json.dumps(config))
print(json.dumps({'type':'fixture-config', 'config': config}), flush=True)
print(config['mcpServers']['terminal_v4_browser']['headers']['Authorization'], file=sys.stderr, flush=True)
sys.exit(1)
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let browser = crate::workspace_browser::agent_connection(
        &AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        },
        "owner",
        "claude:fixture:turn",
    )
    .unwrap();
    let mut spawned = ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: dir.path().to_str().unwrap().into(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: Some(browser.clone()),
        },
        executable.to_str().unwrap(),
    )
    .unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut events = vec![];
        while let Some(event) = spawned.events.recv().await {
            events.push(event);
        }
        events
    })
    .await
    .unwrap();
    let config: Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("config.json")).unwrap()).unwrap();
    assert_eq!(
        config["mcpServers"]["terminal_v4_browser"]["headers"]["Authorization"],
        format!("Bearer {}", browser.token)
    );
    let visible = serde_json::to_string(&events).unwrap();
    assert!(!visible.contains(&browser.token));
    assert!(events.iter().any(|event| matches!(event, StructuredSessionEvent::Error { message, .. } if message.contains("[redacted]"))));
    assert!(
        matches!(events.last(), Some(StructuredSessionEvent::SessionEnded { reason, .. }) if reason == "error")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_browser_capability_is_retained_until_natural_exit_or_confirmed_stop() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let router = browser_fixture_router(&config);
    let executable = dir.path().join("claude-fixture");
    fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import pathlib, select, sys, time
print('{"type":"system","subtype":"init","session_id":"fixture"}', flush=True)
while not pathlib.Path('finish').exists(): time.sleep(.01)
if select.select([sys.stdin], [], [], 0)[0]: pathlib.Path('approval-input').write_text(sys.stdin.readline())
print('{"type":"result","subtype":"success"}', flush=True)
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    for stop in [false, true] {
        let _ = fs::remove_file(dir.path().join("finish"));
        let browser =
            crate::workspace_browser::agent_connection(&config, "owner", "claude-fixture-turn")
                .unwrap();
        let token = browser.token.clone();
        let mut spawned = ClaudeStructuredProvider::spawn_binary(
            StructuredSpawnOptions {
                prompt: "Question".into(),
                cwd: dir.path().to_str().unwrap().into(),
                session_id: None,
                model: None,
                reasoning: None,
                service_tier: None,
                access_mode: None,
                plan: false,
                turn_id: None,
                browser: Some(browser),
            },
            executable.to_str().unwrap(),
        )
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(event) = spawned.events.recv().await {
                if matches!(event, StructuredSessionEvent::SessionStarted { .. }) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            browser_fixture_status(&router, &token).await,
            axum::http::StatusCode::OK
        );
        assert!(spawned.controller.send_approval(true).await.is_err());
        assert!(spawned.controller.send_approval(false).await.is_err());
        if stop {
            spawned.controller.interrupt().await.unwrap();
        } else {
            fs::write(dir.path().join("finish"), "done").unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while spawned.events.recv().await.is_some() {}
        })
        .await
        .unwrap();
        assert!(!dir.path().join("approval-input").exists());
        assert_eq!(
            browser_fixture_status(&router, &token).await,
            axum::http::StatusCode::UNAUTHORIZED
        );
    }
    let browser =
        crate::workspace_browser::agent_connection(&config, "owner", "failed-claude-spawn")
            .unwrap();
    let token = browser.token.clone();
    assert!(ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: dir.path().to_str().unwrap().into(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: Some(browser),
        },
        dir.path().join("missing-executable").to_str().unwrap()
    )
    .is_err());
    assert_eq!(
        browser_fixture_status(&router, &token).await,
        axum::http::StatusCode::UNAUTHORIZED
    );
}

#[test]
fn concurrent_tool_results_keep_their_individual_identity_and_errors() {
    let seq = AtomicUsize::new(0);
    let mut text = String::new();
    let mut tools = HashMap::new();
    map_claude_message(
        &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-read","name":"Read"},{"type":"tool_use","id":"call-write","name":"Write"}]}}),
        &seq,
        &mut text,
        &mut tools,
    );
    let events = map_claude_message(
        &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-write","content":"denied","is_error":true},{"type":"tool_result","tool_use_id":"call-read","content":"contents"}]}}),
        &seq,
        &mut text,
        &mut tools,
    );
    let actual: Vec<_> = events
        .iter()
        .filter_map(|event| {
            if let StructuredSessionEvent::ToolCompleted {
                tool_call_id,
                tool_name,
                result,
                is_error,
                ..
            } = event
            {
                Some((
                    tool_call_id.as_deref(),
                    tool_name.as_str(),
                    result.as_str(),
                    *is_error,
                ))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        actual,
        vec![
            (Some("call-write"), "Write", "denied", true),
            (Some("call-read"), "Read", "contents", false)
        ]
    );
    assert!(tools.is_empty());
}

#[tokio::test]
async fn failed_native_launch_preserves_question_and_failure() {
    struct Fails;
    impl StructuredProvider for Fails {
        fn provider_id(&self) -> &'static str {
            "claude"
        }
        fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
            Err("Synthetic provider missing".into())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let manager =
        StructuredSessionManager::new_with_providers(config.clone(), vec![Arc::new(Fails)]);
    let session = manager
        .create_session(
            "owner",
            dir.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        manager
            .send_message("owner", &session.id, "Preserved failed question")
            .await,
        Err("Synthetic provider missing".into())
    );
    let snapshot = StructuredSessionManager::new(config)
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(&snapshot.events[..],[StructuredSessionEvent::MessageCompleted {role,content,..},StructuredSessionEvent::Error {message,..}] if role=="user" && content=="Preserved failed question" && message.contains("Synthetic provider missing"))
    );
}

#[cfg(unix)]
#[tokio::test]
async fn fast_claude_exit_keeps_ownership_until_late_stop() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("fast-claude");
    fs::write(&executable, r#"#!/usr/bin/env python3
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, '-c', 'import pathlib,time; time.sleep(1.5); pathlib.Path("survivor").write_text("alive"); time.sleep(60)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pathlib.Path('child.pid').write_text(str(child.pid))
print('{"type":"result","subtype":"success"}', flush=True)
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut spawned = ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: dir.path().to_str().unwrap().into(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: None,
        },
        executable.to_str().unwrap(),
    )
    .unwrap();
    // Let the synthetic CLI exit before the runtime's observation task first runs.
    std::thread::sleep(std::time::Duration::from_millis(250));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(event) = spawned.events.recv().await {
            if matches!(event, StructuredSessionEvent::SessionEnded { .. }) {
                break;
            }
        }
    })
    .await
    .unwrap();
    let pid: i32 = fs::read_to_string(dir.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    let stopped = spawned.controller.interrupt().await;
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
    let survived = dir.path().join("survivor").exists();
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    stopped.unwrap();
    assert!(
        !survived,
        "A CLI exiting before the observer ran lost its owned descendant"
    );
}

#[tokio::test]
async fn active_claude_composer_submission_rejects_and_preserves_explicit_raw_input() {
    let dir = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let manager =
        StructuredSessionManager::new_with_providers(config.clone(), vec![Arc::new(HeldProvider)]);
    let session = manager
        .create_session(
            "owner",
            dir.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    manager
        .send_message("owner", &session.id, "First question")
        .await
        .unwrap();
    let before = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    let result = manager
        .send_input("owner", &session.id, "Second question\n", true)
        .await;
    assert!(
        result.is_err(),
        "Ordinary active input must not report accepted unless durable"
    );
    // Explicit raw/control callers retain their existing stdin contract.
    manager
        .send_input("owner", &session.id, "\u{3}", false)
        .await
        .unwrap();
    let replay = StructuredSessionManager::new(config)
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(replay.events).unwrap(),
        serde_json::to_value(before.events).unwrap()
    );
}

#[cfg(unix)]
struct ScriptedClaudeProvider {
    executable: String,
}
#[cfg(unix)]
impl StructuredProvider for ScriptedClaudeProvider {
    fn provider_id(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        ClaudeStructuredProvider::spawn_binary(options, &self.executable)
    }
}

#[cfg(unix)]
async fn scripted_claude_turn(script: &str) -> Vec<StructuredSessionEvent> {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("synthetic-claude");
    fs::write(&executable, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(ScriptedClaudeProvider {
            executable: executable.to_str().unwrap().into(),
        })],
    );
    let session = manager
        .create_session(
            "owner",
            dir.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let (_, mut live) = manager.subscribe("owner", &session.id).await.unwrap();
    manager
        .send_message("owner", &session.id, "Question")
        .await
        .unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut events = Vec::new();
        loop {
            let event = live.recv().await.unwrap();
            let ended = matches!(event, StructuredSessionEvent::SessionEnded { .. });
            events.push(event);
            if ended {
                break events;
            }
        }
    })
    .await
    .unwrap();
    let replay = StructuredSessionManager::new(config)
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&events).unwrap(),
        serde_json::to_value(&replay.events).unwrap()
    );
    events
}

#[cfg(unix)]
#[tokio::test]
async fn stderr_only_failure_is_visible_sanitized_bounded_and_durable() {
    let events = scripted_claude_turn("printf '\\033[31mSynthetic sign-in failed\\033[0m\\nAPI_TOKEN=fixture-private-value\\n' >&2\nhead -c 100000 /dev/zero | tr '\\000' x >&2\nexit 7").await;
    let errors: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            StructuredSessionEvent::Error { message, .. } => Some(message.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        errors.len(),
        1,
        "A process failure must produce one visible durable Error"
    );
    assert!(errors[0].contains("Synthetic sign-in failed"));
    assert!(!errors[0].contains("fixture-private-value"));
    assert!(!errors[0].contains("\u{1b}"));
    assert!(errors[0].len() <= 5000);
    assert!(
        matches!(events.last(), Some(StructuredSessionEvent::SessionEnded { reason, .. }) if reason == "error")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn process_failure_does_not_duplicate_structured_error_or_report_success_stderr() {
    for (script, expected) in [
        ("printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"error_during_execution\"}'; printf 'stderr diagnostic' >&2; exit 2", vec!["CLI result: error_during_execution"]),
        ("printf 'harmless diagnostic' >&2; printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\"}'", vec![]),
        ("exit 3", vec!["Claude process exited unsuccessfully"]),
    ] {
        let events = scripted_claude_turn(script).await;
        let errors: Vec<_> = events.iter().filter_map(|event| match event { StructuredSessionEvent::Error { message, .. } => Some(message.as_str()), _ => None }).collect();
        assert_eq!(errors, expected);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn claude_text_completes_around_tool_boundaries_without_repeating_preamble() {
    let records = [
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"Before."},{"type":"tool_use","id":"read-a","name":"Read","input":{}}]}}),
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read-a","content":"file"}]}}),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"After."}]}}),
        json!({"type":"result","subtype":"success","result":"After."}),
    ];
    let script = records
        .iter()
        .map(|record| format!("printf '%s\\n' '{record}'"))
        .collect::<Vec<_>>()
        .join("\n");
    let events = scripted_claude_turn(&script).await;
    let actual: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            StructuredSessionEvent::MessageCompleted { role, content, .. } => {
                Some((role.as_str(), content.as_str()))
            }
            StructuredSessionEvent::ToolStarted { tool_name, .. } => {
                Some(("tool_started", tool_name.as_str()))
            }
            StructuredSessionEvent::ToolCompleted { result, .. } => {
                Some(("tool_completed", result.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        actual,
        vec![
            ("user", "Question"),
            ("assistant", "Before."),
            ("tool_started", "Read"),
            ("tool_completed", "file"),
            ("assistant", "After.")
        ]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_failure_diagnostic_is_bounded_with_invalid_utf8() {
    let events =
        scripted_claude_turn("head -c 100000 /dev/zero | tr '\\000' '\\377' >&2; exit 9").await;
    let errors: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            StructuredSessionEvent::Error { message, .. } => Some(message),
            _ => None,
        })
        .collect();
    assert_eq!(errors.len(), 1);
    assert!(errors[0].starts_with("Claude process exited unsuccessfully: "));
    assert!(errors[0].len() <= 5000);
}

#[test]
fn claude_tool_only_turn_and_text_after_tool_start_complete_without_duplicates() {
    for trailing_text in [false, true] {
        let seq = AtomicUsize::new(0);
        let mut text = String::new();
        let mut tools = HashMap::new();
        let mut content = vec![json!({"type":"tool_use","id":"call-a","name":"Read","input":{}})];
        if trailing_text {
            content.push(json!({"type":"text","text":"Working."}));
        }
        let mut events = Vec::new();
        for record in [
            json!({"type":"assistant","message":{"content":content}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-a","content":"file"}]}}),
            json!({"type":"result","subtype":"success"}),
        ] {
            events.extend(map_claude_message(&record, &seq, &mut text, &mut tools));
        }
        let completed: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                StructuredSessionEvent::MessageCompleted { content, .. } => Some(content.as_str()),
                StructuredSessionEvent::ToolCompleted { result, .. } => Some(result.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            completed,
            if trailing_text {
                vec!["Working.", "file"]
            } else {
                vec!["file"]
            }
        );
        assert!(text.is_empty());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn claude_exit_stops_stdout_holders_and_preserves_buffered_cleanup_output() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("retained-stdout-claude");
    fs::write(&executable, r#"#!/usr/bin/env python3
import json, pathlib, signal, subprocess, sys, time
child_code = r'''
import json, pathlib, signal, sys, time
def cleanup(*_):
    print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'T' * 100000}]}}), flush=True)
    print(json.dumps({'type':'result','subtype':'success'}), flush=True)
signal.signal(signal.SIGTERM, cleanup)
pathlib.Path('ready').write_text('ready')
time.sleep(60)
'''
child = subprocess.Popen([sys.executable, '-c', child_code], stdin=subprocess.DEVNULL)
pathlib.Path('child.pid').write_text(str(child.pid))
while not pathlib.Path('ready').exists(): time.sleep(.01)
print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'B' * 100000}]}}), flush=True)
print(json.dumps({'type':'result','subtype':'success'}), flush=True)
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut spawned = ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: dir.path().to_str().unwrap().into(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: None,
        },
        executable.to_str().unwrap(),
    )
    .unwrap();
    let mut events = Vec::new();
    let drained = tokio::time::timeout(std::time::Duration::from_secs(4), async {
        while let Some(event) = spawned.events.recv().await {
            let ended = matches!(event, StructuredSessionEvent::SessionEnded { .. });
            events.push(event);
            if ended {
                return;
            }
        }
        panic!("Provider closed without a confirmed terminal outcome");
    })
    .await;
    // Always clean up the owned fixture, including the failing pre-fix case.
    spawned.controller.kill().await.unwrap();
    drained.expect("Exited Claude must stop its owned pipe holders without manual Stop");
    let completed: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            StructuredSessionEvent::MessageCompleted { content, .. } => Some(content.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(completed, vec!["B".repeat(100000), "T".repeat(100000)]);
    assert_eq!(events.iter().filter(|event| matches!(event, StructuredSessionEvent::SessionEnded { reason, .. } if reason == "completed")).count(), 1);
    assert!(!events
        .iter()
        .any(|event| matches!(event, StructuredSessionEvent::Error { .. })));
}

#[cfg(unix)]
#[tokio::test]
async fn claude_stdout_eof_does_not_end_a_still_running_direct_child() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("early-eof-claude");
    fs::write(&executable, "#!/usr/bin/env python3\nimport json, os, pathlib, time\nprint(json.dumps({'type':'result','subtype':'success'}),flush=True)\nos.close(1)\ntime.sleep(.3)\npathlib.Path('finished').write_text('done')\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut spawned = ClaudeStructuredProvider::spawn_binary(
        StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: dir.path().to_str().unwrap().into(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: None,
            plan: false,
            turn_id: None,
            browser: None,
        },
        executable.to_str().unwrap(),
    )
    .unwrap();
    let drained = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while let Some(event) = spawned.events.recv().await {
            if matches!(event, StructuredSessionEvent::SessionEnded { .. }) {
                return;
            }
        }
        panic!("Expected terminal outcome");
    })
    .await;
    spawned.controller.kill().await.unwrap();
    drained.unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("finished")).unwrap(),
        "done"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_retained_stdout_releases_next_durable_message_without_manual_stop() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("next-turn-claude");
    fs::write(&executable, r#"#!/usr/bin/env python3
import json, subprocess, sys
if sys.argv[sys.argv.index('-p') + 1] == 'First':
    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], stdin=subprocess.DEVNULL)
print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Answer'}]}}),flush=True)
print(json.dumps({'type':'result','subtype':'success'}),flush=True)
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let config = AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config.clone(),
        vec![Arc::new(ScriptedClaudeProvider {
            executable: executable.to_str().unwrap().into(),
        })],
    );
    let session = manager
        .create_session(
            "owner",
            dir.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let (_, mut live) = manager.subscribe("owner", &session.id).await.unwrap();
    manager
        .send_message("owner", &session.id, "First")
        .await
        .unwrap();
    let finished = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !matches!(
            live.recv().await.unwrap(),
            StructuredSessionEvent::SessionEnded { .. }
        ) {}
    })
    .await;
    if finished.is_err() {
        manager.interrupt("owner", &session.id).await.unwrap();
    }
    finished.expect("Natural native completion must publish its terminal event");
    let admitted = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match manager
                .send_input("owner", &session.id, "Second\n", true)
                .await
            {
                Ok(()) => break,
                Err(error) if error.contains("busy") => tokio::task::yield_now().await,
                Err(error) => panic!("Unexpected admission error: {error}"),
            }
        }
    })
    .await;
    manager.interrupt("owner", &session.id).await.unwrap();
    admitted.expect("Finished native turn must release durable message admission");
    let replay = StructuredSessionManager::new(config)
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        replay
            .events
            .iter()
            .filter_map(|event| match event {
                StructuredSessionEvent::MessageCompleted { role, content, .. }
                    if role == "user" =>
                    Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        vec!["First", "Second"]
    );
}

#[test]
fn claude_args_pass_the_selected_effort_level() {
    let options = StructuredSpawnOptions {
        prompt: "Question".into(),
        cwd: String::new(),
        session_id: None,
        model: None,
        reasoning: Some("high".into()),
        service_tier: None,
        access_mode: None,
        plan: false,
        turn_id: None,
        browser: None,
    };
    let args = ClaudeStructuredProvider::args(&options, false);
    assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
}

#[tokio::test]
async fn claude_chat_accepts_supported_effort_and_rejects_unknown_levels() {
    let dir = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    });
    let cwd = dir.path().to_str().unwrap();
    let accepted = manager
        .create_with_selection("owner", cwd, Some("claude"), None, Some("xhigh"), None)
        .await
        .unwrap();
    let rejected = manager
        .create_with_selection("owner", cwd, Some("claude"), None, Some("extreme"), None)
        .await;
    assert_eq!(
        (accepted.reasoning.as_deref(), rejected.unwrap_err()),
        (Some("xhigh"), "Unsupported Claude effort level".to_string())
    );
}

#[tokio::test]
async fn claude_chat_changes_model_and_effort_between_turns() {
    let dir = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: dir.path().join("data"),
        ..Default::default()
    });
    let cwd = dir.path().to_str().unwrap();
    let session = manager
        .create_with_selection(
            "owner",
            cwd,
            Some("claude"),
            Some("sonnet"),
            Some("medium"),
            None,
        )
        .await
        .unwrap();
    let updated = manager
        .update_codex_options("owner", &session.id, "opus", Some("max"), None)
        .await
        .unwrap();
    let ultra = manager
        .update_codex_options("owner", &session.id, "opus", Some("ultra"), None)
        .await;
    let speed = manager
        .update_codex_options("owner", &session.id, "opus", None, Some(Some("fast")))
        .await;
    assert_eq!(
        (
            updated.model.as_deref(),
            updated.reasoning.as_deref(),
            ultra.is_err(),
            speed.is_err()
        ),
        (Some("opus"), Some("max"), true, true)
    );
}

#[test]
fn claude_access_modes_choose_how_tools_are_permitted() {
    let flags = |access: Option<&str>| {
        let options = StructuredSpawnOptions {
            prompt: "Question".into(),
            cwd: String::new(),
            session_id: None,
            model: None,
            reasoning: None,
            service_tier: None,
            access_mode: access.map(Into::into),
            plan: false,
            turn_id: None,
            browser: None,
        };
        let args = ClaudeStructuredProvider::args(&options, false);
        let mode = args
            .windows(2)
            .find(|pair| pair[0] == "--permission-mode")
            .map(|pair| pair[1].clone());
        (
            mode,
            args.iter()
                .any(|arg| arg == "--dangerously-skip-permissions"),
        )
    };
    assert_eq!(
        [None, Some("auto-edit"), Some("supervised"), Some("full")].map(flags),
        [
            (Some("acceptEdits".to_owned()), false),
            (Some("acceptEdits".to_owned()), false),
            (Some("manual".to_owned()), false),
            (None, true),
        ]
    );
}

#[tokio::test]
async fn access_mode_changes_between_turns_and_is_remembered() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let changed = manager
        .update_access_mode("owner", &session.id, "full")
        .await
        .unwrap();
    let invalid = manager
        .update_access_mode("owner", &session.id, "root")
        .await
        .unwrap_err();
    let restored = StructuredSessionManager::new(config)
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            changed.access_mode.as_deref(),
            invalid.code,
            restored.access_mode.as_deref()
        ),
        (Some("full"), "invalid", Some("full"))
    );
}

#[tokio::test]
async fn supervised_claude_asks_in_the_conversation_and_waits_for_the_decision() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    manager
        .update_access_mode("owner", &session.id, "supervised")
        .await
        .unwrap();
    let pending_approval = |manager: StructuredSessionManager, id: String| async move {
        loop {
            let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
            if let Some(found) = snapshot.events.iter().rev().find_map(|event| match event {
                StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(approval),
                    tool_name,
                    tool_input,
                    ..
                } => Some((approval.clone(), tool_name.clone(), tool_input.clone())),
                _ => None,
            }) {
                if !snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &found.0)) {
                    return found;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    };
    let decide = |approved: bool| {
        let manager = manager.clone();
        let id = session.id.clone();
        async move {
            let asking = tokio::spawn({
                let manager = manager.clone();
                let id = id.clone();
                async move {
                    manager
                        .request_claude_permission(
                            "owner",
                            &id,
                            "Edit",
                            json!({"file_path": "/work/a.txt"}),
                        )
                        .await
                }
            });
            let (approval, tool, input) = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                pending_approval(manager.clone(), id.clone()),
            )
            .await
            .unwrap();
            let intruder = manager
                .approve_bound("intruder", &id, Some(&approval), true, None)
                .await
                .is_err();
            manager
                .approve_bound("owner", &id, Some(&approval), approved, None)
                .await
                .unwrap();
            (asking.await.unwrap().unwrap(), tool, input, intruder)
        }
    };
    assert_eq!(
        [decide(true).await, decide(false).await],
        [
            (
                true,
                "Edit".to_owned(),
                json!({"file_path": "/work/a.txt"}),
                true
            ),
            (
                false,
                "Edit".to_owned(),
                json!({"file_path": "/work/a.txt"}),
                true
            ),
        ]
    );
}

#[tokio::test]
async fn claude_tools_allowed_for_the_session_are_not_asked_about_again() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let asking = tokio::spawn({
        let manager = manager.clone();
        let id = session.id.clone();
        async move {
            manager
                .request_claude_permission("owner", &id, "Bash", json!({"command": "ls"}))
                .await
        }
    });
    let approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot = manager
                .get_session("owner", &session.id)
                .await
                .unwrap()
                .unwrap();
            if let Some(id) = snapshot.events.iter().find_map(|event| match event {
                StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(id),
                    ..
                } => Some(id.clone()),
                _ => None,
            }) {
                return id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager
        .approve_bound_for_session("owner", &session.id, &approval)
        .await
        .unwrap();
    let first = asking.await.unwrap().unwrap();
    let again = manager
        .request_claude_permission("owner", &session.id, "Bash", json!({"command": "pwd"}))
        .await
        .unwrap();
    let asked = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap()
        .events
        .iter()
        .filter(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { .. }))
        .count();
    assert_eq!((first, again, asked), (true, true, 1));
}

#[test]
fn plan_turns_run_claude_in_its_read_only_plan_mode() {
    let options = StructuredSpawnOptions {
        prompt: "[Plan] Add search".into(),
        cwd: String::new(),
        session_id: None,
        model: None,
        reasoning: None,
        service_tier: None,
        access_mode: Some("full".into()),
        plan: true,
        turn_id: None,
        browser: None,
    };
    let args = ClaudeStructuredProvider::args(&options, true);
    assert_eq!(
        (
            args.windows(2)
                .find(|pair| pair[0] == "--permission-mode")
                .map(|pair| pair[1].clone()),
            args.iter()
                .any(|arg| arg == "--dangerously-skip-permissions"),
            is_plan_request(&options.prompt),
            is_plan_request("Add search"),
        ),
        (Some("plan".to_owned()), false, true, false)
    );
}
