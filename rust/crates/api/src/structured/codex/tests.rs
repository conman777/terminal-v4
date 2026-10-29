use super::*;

fn options(path: &Path, prompt: &str) -> StructuredSpawnOptions {
    StructuredSpawnOptions {
        prompt: prompt.into(),
        cwd: path.to_string_lossy().into(),
        session_id: None,
        model: Some("fixture-model".into()),
        reasoning: Some("high".into()),
        service_tier: Some("fast".into()),
        access_mode: None,
        plan: false,
        turn_id: Some("app-turn".into()),
        browser: None,
    }
}

fn command(directory: &Path) -> Command {
    let fixture = directory.join("codex-fixture.py");
    std::fs::write(&fixture, include_str!("fixture.py")).unwrap();
    let mut command = Command::new("python3");
    command.arg(fixture);
    command.env("CODEX_FIXTURE_LOG", directory.join("requests.jsonl"));
    command
}

async fn collect(process: &mut SpawnedStructuredProcess) -> Vec<StructuredSessionEvent> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut events = Vec::new();
        while let Some(event) = process.events.recv().await {
            events.push(event);
        }
        events
    })
    .await
    .expect("Fixture must finish")
}

async fn next_approval(
    events: &mut mpsc::UnboundedReceiver<StructuredSessionEvent>,
) -> (String, String, Value) {
    while let Some(event) = events.recv().await {
        if let StructuredSessionEvent::ApprovalRequired {
            approval_id: Some(id),
            tool_name,
            tool_input,
            ..
        } = event
        {
            return (id, tool_name, tool_input);
        }
    }
    panic!("Missing approval")
}

#[test]
fn default_manager_registers_native_codex() {
    let manager = StructuredSessionManager::new(AppConfig::default());
    assert!(manager.inner.providers.contains_key("codex"));
}

#[tokio::test]
async fn browser_mcp_is_added_to_start_and_resume_without_replacing_other_overrides() {
    let directory = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: directory.path().join("data"),
        ..Default::default()
    };
    for session_id in [None, Some("native-fixture".to_owned())] {
        let browser =
            crate::workspace_browser::agent_connection(&config, "owner", "fixture-turn").unwrap();
        let mut request = options(directory.path(), "browser-echo");
        request.session_id = session_id.clone();
        request.browser = Some(browser.clone());
        let mut process = spawn_command(command(directory.path()), request).unwrap();
        let events = collect(&mut process).await;
        let visible = serde_json::to_string(&events).unwrap();
        assert!(!visible.contains(&browser.token));
        assert!(visible.contains("[redacted]"));
        let requests: Vec<Value> = fs::read_to_string(directory.path().join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let method = if session_id.is_some() {
            "thread/resume"
        } else {
            "thread/start"
        };
        let params = &requests
            .iter()
            .rev()
            .find(|request| request["method"] == method)
            .unwrap()["params"];
        assert_eq!(
            params["config"],
            json!({
                "model_reasoning_effort": "high",
                "mcp_servers.terminal_v4_browser": {
                    "url": browser.url,
                    "http_headers": {"Authorization": format!("Bearer {}", browser.token)},
                    "default_tools_approval_mode": "approve"
                }
            })
        );
        assert_eq!(params["serviceTier"], "fast");
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["approvalsReviewer"], "user");
        assert_eq!(params["developerInstructions"], SHARED_BROWSER_INSTRUCTIONS);
        assert!(!requests.iter().any(|request| request["method"]
            .as_str()
            .is_some_and(|method| method.starts_with("config/"))));
    }
}

#[tokio::test]
async fn absent_owned_browser_keeps_native_configuration_and_approval_policy() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "Complete"),
    )
    .unwrap();
    collect(&mut process).await;
    let requests: Vec<Value> = fs::read_to_string(directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let params = &requests
        .iter()
        .find(|request| request["method"] == "thread/start")
        .unwrap()["params"];
    assert_eq!(params["config"], json!({"model_reasoning_effort":"high"}));
    assert_eq!(params["approvalPolicy"], "on-request");
    assert!(params.get("approvalsReviewer").is_none());
    assert!(params.get("developerInstructions").is_none());
}

#[tokio::test]
async fn browser_native_approvals_bind_exact_action_and_never_remember_decisions() {
    for prompt in ["browser-approval-question", "browser-approval-elicitation"] {
        for approved in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let config = AppConfig {
                data_dir: directory.path().join("data"),
                ..Default::default()
            };
            let mut request = options(directory.path(), prompt);
            request.browser = Some(
                crate::workspace_browser::agent_connection(&config, "owner", "fixture-turn")
                    .unwrap(),
            );
            let mut process = spawn_command(command(directory.path()), request).unwrap();
            let (id, tool, input) =
                tokio::time::timeout(Duration::from_secs(5), next_approval(&mut process.events))
                    .await
                    .unwrap();
            assert_eq!(
                (tool, input),
                (
                    "terminal_v4_browser.browser_navigate".into(),
                    json!({"url":"http://localhost:5173/example"})
                )
            );
            assert!(process
                .controller
                .send_bound_approval("stale", true)
                .await
                .is_err());
            process
                .controller
                .send_bound_approval(&id, approved)
                .await
                .unwrap();
            assert!(collect(&mut process).await.iter().any(|event| matches!(event,StructuredSessionEvent::ApprovalResolved{approval_id,approved:decision,..} if approval_id == &id && *decision == approved)));
            let requests: Vec<Value> = fs::read_to_string(directory.path().join("requests.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let response = &requests
                .iter()
                .find(|request| request["id"] == "browser-approval")
                .unwrap()["result"];
            let expected = if prompt.ends_with("question") {
                json!({"answers":{"mcp_tool_call_approval_browser-call":{"answers":[if approved {"Allow"} else {"Cancel"}]}}})
            } else {
                json!({"action":if approved {"accept"} else {"decline"},"content":null})
            };
            assert_eq!(response, &expected);
        }
    }
}

#[tokio::test]
async fn browser_capability_lives_through_process_work_and_is_revoked_on_all_exit_paths() {
    let directory = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: directory.path().join("data"),
        ..Default::default()
    };
    let router = browser_fixture_router(&config);
    for (prompt, signed_out) in [("hold", false), ("Complete", false), ("Inspect", true)] {
        let browser = crate::workspace_browser::agent_connection(&config, "owner", prompt).unwrap();
        let token = browser.token.clone();
        let mut request = options(directory.path(), prompt);
        request.browser = Some(browser);
        let mut cmd = command(directory.path());
        if signed_out {
            cmd.env("CODEX_FIXTURE_SIGNED_OUT", "1");
        }
        let mut process = spawn_command(cmd, request).unwrap();
        if prompt == "hold" {
            tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(event) = process.events.recv().await {
                    if matches!(event, StructuredSessionEvent::MessageDelta { .. }) {
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
            process.controller.interrupt().await.unwrap();
        }
        collect(&mut process).await;
        assert_eq!(
            browser_fixture_status(&router, &token).await,
            axum::http::StatusCode::UNAUTHORIZED
        );
    }
    let browser =
        crate::workspace_browser::agent_connection(&config, "owner", "failed-spawn").unwrap();
    let token = browser.token.clone();
    let mut request = options(directory.path(), "Inspect");
    request.browser = Some(browser);
    assert!(spawn_command(
        Command::new(directory.path().join("missing-executable")),
        request
    )
    .is_err());
    assert_eq!(
        browser_fixture_status(&router, &token).await,
        axum::http::StatusCode::UNAUTHORIZED
    );
}

#[test]
fn browser_approval_refuses_unbound_ambiguous_and_nonapproval_elicitations() {
    let item = json!({"server":"terminal_v4_browser","tool":"browser_navigate","arguments":{"url":"http://localhost:5173"}});
    let mut items = HashMap::from([("call".into(), item.clone())]);
    let mut params = json!({"serverName":"terminal_v4_browser","mode":"form","requestedSchema":{"type":"object","properties":{}},"_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":{"url":"http://localhost:5173"}}});
    assert!(browser_approval("mcpServer/elicitation/request", &params, &items).is_some());
    items.insert("concurrent".into(), item);
    assert!(browser_approval("mcpServer/elicitation/request", &params, &items).is_none());
    items.remove("concurrent");
    params["_meta"]["tool_params"]["url"] = json!("http://other.example");
    assert!(browser_approval("mcpServer/elicitation/request", &params, &items).is_none());
    params["_meta"]["tool_params"]["url"] = json!("http://localhost:5173");
    params["_meta"]["codex_approval_kind"] = json!("browser_auth");
    assert!(browser_approval("mcpServer/elicitation/request", &params, &items).is_none());
}

#[tokio::test]
async fn native_protocol_preserves_prompt_selection_and_resumes_same_thread() {
    let directory = tempfile::tempdir().unwrap();
    let prompt = "Inspect literal $(never-execute) and `text`";
    let mut process =
        spawn_command(command(directory.path()), options(directory.path(), prompt)).unwrap();
    let events = collect(&mut process).await;
    assert!(events.iter().any(|e| matches!(e, StructuredSessionEvent::SessionStarted{session_id,provider,..} if session_id=="native-fixture" && provider=="codex")));
    assert!(events.iter().any(|e| matches!(e, StructuredSessionEvent::MessageCompleted{content,turn_id,..} if content=="Local Codex reply" && turn_id.as_deref()==Some("app-turn"))));
    assert!(
        matches!(events.last(), Some(StructuredSessionEvent::SessionEnded{reason,..}) if reason=="completed")
    );
    let requests: Vec<Value> = std::fs::read_to_string(directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let start = requests
        .iter()
        .find(|r| r["method"] == "thread/start")
        .unwrap();
    assert_eq!(start["params"]["serviceTier"], "fast");
    let turn = requests
        .iter()
        .find(|r| r["method"] == "turn/start")
        .unwrap();
    assert_eq!(
        (
            turn["params"]["effort"].as_str(),
            turn["params"]["summary"].as_str(),
            turn["params"]["serviceTier"].as_str()
        ),
        (Some("high"), Some("detailed"), Some("fast"))
    );

    assert_eq!(
        (
            start["params"]["model"].as_str(),
            start["params"]["config"]["model_reasoning_effort"].as_str(),
            start["params"]["sandbox"].as_str(),
            start["params"]["approvalPolicy"].as_str()
        ),
        (
            Some("fixture-model"),
            Some("high"),
            Some("workspace-write"),
            Some("on-request")
        )
    );
    assert_eq!(
        requests
            .iter()
            .find(|r| r["method"] == "turn/start")
            .unwrap()["params"]["input"],
        json!([{"type":"text","text":prompt}])
    );
    let mut resumed = options(directory.path(), "Continue");
    resumed.session_id = Some("native-fixture".into());
    resumed.model = Some("next-model".into());
    resumed.reasoning = Some("medium".into());
    resumed.service_tier = Some("default".into());
    let mut process = spawn_command(command(directory.path()), resumed).unwrap();
    assert!(collect(&mut process).await.iter().any(
        |e| matches!(e,StructuredSessionEvent::SessionEnded{reason,..} if reason=="completed")
    ));
    let requests = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    assert!(requests
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .any(|r| r["method"] == "thread/resume"
            && r["params"]["threadId"] == "native-fixture"
            && r["params"]["excludeTurns"] == true
            && r["params"]["model"] == "next-model"
            && r["params"]["config"]["model_reasoning_effort"] == "medium"
            && r["params"]["serviceTier"] == "default"));
}

#[tokio::test]
async fn approval_rejects_stale_ids_and_binds_native_response_to_displayed_action() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "approval"),
    )
    .unwrap();
    let id = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = process.events.recv().await {
            if let StructuredSessionEvent::ApprovalRequired {
                approval_id: Some(id),
                ..
            } = event
            {
                return id;
            }
        }
        panic!("Missing approval")
    })
    .await
    .unwrap();
    assert!(process
        .controller
        .send_bound_approval("stale", true)
        .await
        .is_err());
    let receipt = process
        .controller
        .send_bound_approval(&id, false)
        .await
        .unwrap();
    assert_eq!((receipt.approval_id, receipt.approved), (id.clone(), false));
    let events = collect(&mut process).await;
    assert!(events.iter().any(|e|matches!(e,StructuredSessionEvent::ApprovalResolved{approval_id,approved:false,..} if approval_id==&id)));
    let requests = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    assert!(requests
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .any(|r| r["id"] == "native-approval" && r["result"]["decision"] == "decline"));
}

#[tokio::test]
async fn concurrent_approvals_are_presented_in_order_and_keep_exact_native_identity() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "approval-pair"),
    )
    .unwrap();
    let (first, name, _) =
        tokio::time::timeout(Duration::from_secs(5), next_approval(&mut process.events))
            .await
            .unwrap();
    assert_eq!(name, "run_command");
    assert!(!matches!(
        tokio::time::timeout(Duration::from_millis(100), process.events.recv()).await,
        Ok(Some(StructuredSessionEvent::ApprovalRequired { .. }))
    ));
    process
        .controller
        .send_bound_approval(&first, true)
        .await
        .unwrap();
    let (second, name, input) =
        tokio::time::timeout(Duration::from_secs(5), next_approval(&mut process.events))
            .await
            .unwrap();
    assert_eq!(name, "edit_files");
    assert_eq!(
        input["changes"],
        json!([{"path":"/fixture/example.txt","kind":{"type":"add"},"diff":"+fixture"}])
    );
    assert!(input.get("threadId").is_none());
    assert_ne!(first, second);
    assert_eq!(
        process
            .controller
            .send_bound_approval(&first, true)
            .await
            .unwrap()
            .status,
        "already_decided"
    );
    assert!(process
        .controller
        .send_bound_approval(&first, false)
        .await
        .is_err());
    process
        .controller
        .send_bound_approval(&second, false)
        .await
        .unwrap();
    assert!(
        matches!(collect(&mut process).await.last(), Some(StructuredSessionEvent::SessionEnded { reason, .. }) if reason == "completed")
    );
    let requests: Vec<Value> = std::fs::read_to_string(directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(requests
        .iter()
        .any(|r| r["id"] == "native-approval" && r["result"]["decision"] == "accept"));
    assert!(requests
        .iter()
        .any(|r| r["id"] == "native-approval-two" && r["result"]["decision"] == "decline"));
}

#[tokio::test]
async fn approval_during_a_split_protocol_packet_preserves_the_partial_frame() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "approval-fragment"),
    )
    .unwrap();
    let id = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = process.events.recv().await {
            if let StructuredSessionEvent::ApprovalRequired {
                approval_id: Some(id),
                ..
            } = event
            {
                return id;
            }
        }
        panic!("Missing approval")
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !directory.path().join("requests.jsonl.fragment").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    process
        .controller
        .send_bound_approval(&id, true)
        .await
        .unwrap();
    let events = collect(&mut process).await;
    assert!(events.iter().any(
        |e| matches!(e,StructuredSessionEvent::MessageDelta{content,..} if content=="fragment")
    ));
    assert!(
        matches!(events.last(),Some(StructuredSessionEvent::SessionEnded{reason,..}) if reason=="completed")
    );
}

#[tokio::test]
async fn stop_confirms_process_cleanup_and_emits_interrupted_outcome() {
    let directory = tempfile::tempdir().unwrap();
    let mut process =
        spawn_command(command(directory.path()), options(directory.path(), "hold")).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = process.events.recv().await {
            if matches!(event, StructuredSessionEvent::MessageDelta { .. }) {
                break;
            }
        }
    })
    .await
    .unwrap();
    process.controller.interrupt().await.unwrap();
    assert!(collect(&mut process).await.iter().any(
        |e| matches!(e,StructuredSessionEvent::TurnCompleted{status,..} if status=="interrupted")
    ));
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn fast_exiting_codex_does_not_leave_a_child_running() {
    let directory = tempfile::tempdir().unwrap();
    let survivor = directory.path().join("survivor");
    let sibling_marker = directory.path().join("unrelated-sibling");
    let child_code = "import pathlib,sys,time; time.sleep(0.9); pathlib.Path(sys.argv[1]).write_text('still running')";
    let mut sibling = Command::new("python3")
        .args(["-c", child_code])
        .arg(&sibling_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let script = "import subprocess,sys,time; time.sleep(0.1); subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)";
    let mut cmd = Command::new("python3");
    cmd.args(["-c", script, child_code]).arg(&survivor);
    let mut process = spawn_command(cmd, options(directory.path(), "Inspect")).unwrap();
    // Hold the executor until the leader has exited, so the periodic ancestry
    // tracker cannot observe its child before it is reparented.
    std::thread::sleep(Duration::from_millis(500));
    let events = collect(&mut process).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let sibling_result = tokio::time::timeout(Duration::from_secs(3), sibling.wait()).await;
    assert!(
        !survivor.exists(),
        "Codex left a child running after cleanup"
    );
    assert!(matches!(sibling_result, Ok(Ok(status)) if status.success()));
    assert!(
        sibling_marker.exists(),
        "Cleanup stopped an unrelated process"
    );
    assert!(!process.controller.is_blocked());
    assert!(events
        .iter()
        .any(|event| matches!(event, StructuredSessionEvent::SessionEnded { .. })));
}

#[cfg(unix)]
#[tokio::test]
async fn exited_codex_is_detected_when_a_child_keeps_stdout_open() {
    let directory = tempfile::tempdir().unwrap();
    let child_pid = directory.path().join("child-pid");
    let script = "import pathlib,subprocess,sys; sys.stdin.readline(); child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(6)']); pathlib.Path(sys.argv[1]).write_text(str(child.pid))";
    let mut cmd = Command::new("python3");
    cmd.args(["-c", script]).arg(&child_pid);
    let mut process = spawn_command(cmd, options(directory.path(), "Inspect")).unwrap();
    let _pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(pid) = fs::read_to_string(&child_pid)
                .ok()
                .and_then(|value| value.parse::<i32>().ok())
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Synthetic Codex must start its child");
    let result = tokio::time::timeout(Duration::from_secs(3), collect(&mut process)).await;
    if result.is_err() {
        let _ = process.controller.interrupt().await;
    }
    let events = result.expect("Exited Codex remained busy while its child held stdout");
    assert!(!process.controller.is_blocked());
    assert!(events.iter().any(|event| matches!(event, StructuredSessionEvent::SessionEnded { reason, .. } if reason == "failed")));
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn buffered_codex_completion_is_delivered_after_leader_exit() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "exit-after-burst"),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = process.events.recv().await {
            if matches!(event, StructuredSessionEvent::TurnStarted { .. }) {
                return;
            }
        }
        panic!("Synthetic Codex did not start its turn");
    })
    .await
    .unwrap();
    // Hold the reader and consumer while the leader writes more than the
    // packet-channel capacity, then exits with a child holding stdout open.
    std::thread::sleep(Duration::from_millis(500));
    let events = collect(&mut process).await;
    assert_eq!(events.iter().filter(|event| matches!(event, StructuredSessionEvent::MessageDelta { content, .. } if content == "x")).count(), 32);
    assert!(events.iter().any(|event| matches!(event, StructuredSessionEvent::TurnCompleted { status, .. } if status == "completed")));
    assert!(!process.controller.is_blocked());
}

#[tokio::test]
async fn missing_sign_in_is_actionable_and_never_starts_inference() {
    let directory = tempfile::tempdir().unwrap();
    let mut cmd = command(directory.path());
    cmd.env("CODEX_FIXTURE_SIGNED_OUT", "1");
    let mut process = spawn_command(cmd, options(directory.path(), "Inspect")).unwrap();
    let events = collect(&mut process).await;
    assert!(events.iter().any(
        |e| matches!(e,StructuredSessionEvent::Error{message,..} if message.contains("codex login"))
    ));
    assert!(
        !std::fs::read_to_string(directory.path().join("requests.jsonl"))
            .unwrap()
            .contains("turn/start")
    );
}

#[tokio::test]
#[ignore = "Requires an installed Codex binary in CODEX_PROTOCOL_BINARY; uses an empty Codex home and makes no model request"]
async fn installed_codex_signed_out_protocol_is_compatible() {
    let directory = tempfile::tempdir().unwrap();
    let binary = std::env::var_os("CODEX_PROTOCOL_BINARY").expect("Set CODEX_PROTOCOL_BINARY");
    let mut command = Command::new(binary);
    command
        .env_clear()
        .env("HOME", directory.path())
        .env("CODEX_HOME", directory.path())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    let mut process = spawn_command(
        command,
        options(directory.path(), "Must not reach inference"),
    )
    .unwrap();
    let events = collect(&mut process).await;
    assert!(events.iter().any(|event| matches!(event, StructuredSessionEvent::Error { message, .. } if message.contains("codex login"))));
    assert!(!events
        .iter()
        .any(|event| matches!(event, StructuredSessionEvent::TurnStarted { .. })));
    assert!(
        matches!(events.last(), Some(StructuredSessionEvent::SessionEnded { reason, .. }) if reason == "failed")
    );
}

async fn installed_fixture_rpc(
    stdin: &mut ChildStdin,
    output: &mut BufReader<tokio::process::ChildStdout>,
    request: Value,
) -> Value {
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.unwrap();
    stdin.flush().await.unwrap();
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let packet = read_packet(output)
                .await
                .expect("Installed Codex protocol packet");
            if packet.get("id") == request.get("id") {
                assert!(
                    packet.get("error").is_none(),
                    "Installed Codex rejected fixture RPC {}",
                    request["method"]
                );
                return packet["result"].clone();
            }
        }
    })
    .await
    .expect("Installed Codex fixture RPC deadline")
}

#[tokio::test]
#[ignore = "Requires CODEX_PROTOCOL_BINARY; isolated home and local MCP only, never submits a model turn"]
async fn installed_codex_initializes_parent_http_mcp_and_preserves_user_servers_without_inference()
{
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = AppConfig {
        data_dir: directory.path().join("data"),
        port: address.port(),
        ..Default::default()
    };
    let router = browser_fixture_router(&config);
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let browser = crate::workspace_browser::agent_connection(
        &config,
        "fixture-owner",
        "installed-codex-handshake",
    )
    .unwrap();
    let native_home = directory.path().join("codex-home");
    fs::create_dir(&native_home).unwrap();
    let user_config = format!("[mcp_servers.user_fixture]\nurl={:?}\n[mcp_servers.user_fixture.http_headers]\nAuthorization={:?}\n", browser.url, format!("Bearer {}", browser.token));
    fs::write(native_home.join("config.toml"), &user_config).unwrap();
    let binary = std::env::var_os("CODEX_PROTOCOL_BINARY").expect("Set CODEX_PROTOCOL_BINARY");
    let mut child = Command::new(binary)
        .args(["app-server", "--listen", "stdio://"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", directory.path())
        .env("CODEX_HOME", &native_home)
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let tree = crate::process_tree::ProcessTree::attach(&child).unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    installed_fixture_rpc(&mut stdin, &mut output, json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"terminal_v4_fixture","version":"1.0"},"capabilities":{"experimentalApi":true}}})).await;
    stdin
        .write_all(b"{\"method\":\"initialized\"}\n")
        .await
        .unwrap();
    let thread = installed_fixture_rpc(&mut stdin, &mut output, json!({"id":2,"method":"thread/start","params":{
        "cwd":directory.path(),"ephemeral":true,"model":"fixture-model","sandbox":"workspace-write","approvalPolicy":"on-request","approvalsReviewer":"user",
        "config":{
            "model_provider":"fixture",
            "model_providers.fixture":{"name":"Offline fixture","base_url":format!("http://{address}/no-inference"),"wire_api":"responses","requires_openai_auth":false},
            "mcp_servers.terminal_v4_browser":{"url":browser.url,"http_headers":{"Authorization":format!("Bearer {}",browser.token)},"default_tools_approval_mode":"prompt"}
        }
    }})).await;
    let status = installed_fixture_rpc(&mut stdin, &mut output, json!({"id":3,"method":"mcpServerStatus/list","params":{"threadId":thread["thread"]["id"]}})).await;
    for name in ["terminal_v4_browser", "user_fixture"] {
        let entry = status["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .expect("Both app-owned and user MCP servers must survive config merging");
        assert!(
            entry["tools"].get("browser_navigate").is_some(),
            "Native HTTP MCP discovery failed for {name}"
        );
        assert_eq!(entry["serverInfo"]["name"], "terminal-v4-browser");
    }
    assert_eq!(
        fs::read_to_string(native_home.join("config.toml")).unwrap(),
        user_config
    );
    drop(stdin);
    tree.stop(Duration::from_millis(500)).await.unwrap();
    child.wait().await.unwrap();
    server.abort();
}

#[tokio::test]
#[ignore = "Requires CODEX_PROTOCOL_BINARY and bundled browser Node; isolated CLI, synthetic loopback inference, no paid calls"]
async fn installed_codex_browser_transport_has_one_broker_decision_and_keeps_other_mcp_prompts() {
    use axum::Extension;

    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = AppConfig {
        data_dir: directory.path().join("data"),
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
    let _session = crate::workspace_browser::register_shared_test_session(
        &config.data_dir,
        "fixture-owner",
        json!({"tabs":[],"activeTabId":null}),
    )
    .await;
    let state = crate::state::AppState::new(config.clone()).unwrap();
    let router = browser_fixture_router(&config).merge(
        crate::workspace_browser::routes()
            .layer(Extension(crate::auth::AuthenticatedUser {
                user_id: "fixture-owner".into(),
                username: "fixture-owner".into(),
            }))
            .with_state(state),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let browser =
        crate::workspace_browser::agent_connection(&config, "fixture-owner", "Codex CLI fixture")
            .unwrap();

    // Replay the actual adapter's thread configuration, rather than a hand-written policy.
    let mut request = options(directory.path(), "Complete");
    request.browser = Some(browser.clone());
    let mut adapter = spawn_command(command(directory.path()), request).unwrap();
    collect(&mut adapter).await;
    let recorded: Vec<Value> = fs::read_to_string(directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let mut params = recorded
        .iter()
        .find(|row| row["method"] == "thread/start")
        .unwrap()["params"]
        .clone();

    let mut inference = Command::new("/usr/bin/python3")
        .arg(directory.path().join("codex-fixture.py"))
        .arg("--responses-fixture")
        .env_clear()
        .env("HOME", directory.path())
        .env("PATH", "/usr/bin:/bin")
        .env("CODEX_FIXTURE_RESPONSES_DIR", directory.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut inference_output = BufReader::new(inference.stdout.take().unwrap());
    let mut endpoint = String::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        inference_output.read_line(&mut endpoint),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    params["ephemeral"] = json!(true);
    params["model"] = json!("gpt-5.1-codex");
    params["serviceTier"] = Value::Null;
    params["config"]["model_provider"] = json!("fixture");
    params["config"]["model_providers.fixture"] = json!({
        "name":"Offline fixture", "base_url":endpoint.trim(), "wire_api":"responses",
        "requires_openai_auth":false,
    });
    let native_home = directory.path().join("codex-home");
    fs::create_dir(&native_home).unwrap();
    let user_config = format!(
        "[mcp_servers.user_fixture]\nurl={:?}\ndefault_tools_approval_mode=\"prompt\"\n[mcp_servers.user_fixture.http_headers]\nAuthorization={:?}\n",
        browser.url, format!("Bearer {}", browser.token),
    );
    fs::write(native_home.join("config.toml"), &user_config).unwrap();
    let binary = std::env::var_os("CODEX_PROTOCOL_BINARY").expect("Set CODEX_PROTOCOL_BINARY");
    let mut child = Command::new(binary)
        .args(["app-server", "--listen", "stdio://"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", directory.path())
        .env("CODEX_HOME", &native_home)
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let tree = crate::process_tree::ProcessTree::attach(&child).unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    installed_fixture_rpc(&mut stdin, &mut output, json!({"id":1,"method":"initialize","params":{
        "clientInfo":{"name":"terminal_v4_fixture","version":"1.0"},"capabilities":{"experimentalApi":true},
    }})).await;
    stdin
        .write_all(b"{\"method\":\"initialized\"}\n")
        .await
        .unwrap();
    let thread = installed_fixture_rpc(
        &mut stdin,
        &mut output,
        json!({"id":2,"method":"thread/start","params":params}),
    )
    .await;
    let status = installed_fixture_rpc(&mut stdin, &mut output, json!({"id":3,"method":"mcpServerStatus/list","params":{"threadId":thread["thread"]["id"]}})).await;
    for name in ["terminal_v4_browser", "user_fixture"] {
        assert!(status["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["name"] == name && row["tools"].get("browser_close").is_some()));
    }
    installed_fixture_rpc(&mut stdin, &mut output, json!({"id":4,"method":"turn/start","params":{
        "threadId":thread["thread"]["id"],"input":[{"type":"text","text":"Run the local synthetic fixture"}],
    }})).await;
    let (send, mut packets) = mpsc::unbounded_channel();
    let reader = tokio::spawn(async move {
        loop {
            let packet = read_packet(&mut output).await;
            let failed = packet.is_err();
            if send.send(packet).is_err() || failed {
                break;
            }
        }
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let approvals = format!("http://{address}/api/workspace-browser/approvals");
    let mut observed = Vec::new();
    let mut first_target = Value::Null;
    for (index, approved) in [false, true].into_iter().enumerate() {
        let pending = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                while let Ok(packet) = packets.try_recv() {
                    let packet = packet.unwrap();
                    assert!(
                        packet.get("id").is_none(),
                        "Unexpected native approval before broker review: {packet}"
                    );
                    assert_ne!(
                        packet["method"], "turn/completed",
                        "CLI ended before broker review: {observed:?}"
                    );
                    observed.push(packet);
                }
                let response: Value = client
                    .get(&approvals)
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
        .expect("Installed CLI must reach the real parent broker without a native prompt");
        assert_eq!(
            (&pending["label"], &pending["name"], &pending["arguments"]),
            (
                &json!("Codex CLI fixture"),
                &json!("browser_close"),
                &json!({})
            )
        );
        if index == 0 {
            assert!(pending["target"]["sessionId"].is_string());
            first_target = pending["target"].clone();
        } else {
            assert_eq!(
                pending["target"], first_target,
                "Deny must not close or change the reviewed browser session"
            );
            let next_request: Value = serde_json::from_str(
                &fs::read_to_string(directory.path().join("response-request-1.json")).unwrap(),
            )
            .unwrap();
            assert!(next_request["input"]
                .to_string()
                .contains("user denied this browser action"));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !directory
                .path()
                .join(format!("response-request-{}.json", index + 1))
                .exists(),
            "No tool result or next inference may run before exact broker review"
        );
        assert_eq!(
            client
                .get(format!(
                    "http://{address}/api/workspace-browser/sessions/{}",
                    pending["target"]["sessionId"].as_str().unwrap()
                ))
                .send()
                .await
                .unwrap()
                .status(),
            axum::http::StatusCode::OK,
            "The real helper must remain open before either broker decision"
        );
        while let Ok(packet) = packets.try_recv() {
            let packet = packet.unwrap();
            assert!(
                packet.get("id").is_none(),
                "Browser transport must not ask for native approval: {packet}"
            );
            observed.push(packet);
        }
        client
            .post(format!("{approvals}/{}", pending["id"].as_str().unwrap()))
            .json(&json!({"approved":approved}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    // An identically named tool from a user server still needs a native decision.
    let native = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let packet = packets.recv().await.unwrap().unwrap();
            if packet.get("id").is_some() {
                break packet;
            }
            assert_ne!(
                packet["method"], "turn/completed",
                "Missing unrelated native MCP approval"
            );
            observed.push(packet);
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        native["method"].as_str(),
        Some("mcpServer/elicitation/request" | "item/tool/requestUserInput")
    ));
    assert!(
        native["params"].to_string().contains("user_fixture"),
        "Wrong server requested native approval: {native}"
    );
    let response: Value = client
        .get(&approvals)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["requests"], json!([]));
    let result = if native["method"] == "mcpServer/elicitation/request" {
        json!({"action":"decline","content":null})
    } else {
        let id = native["params"]["questions"][0]["id"].as_str().unwrap();
        json!({"answers":{id:{"answers":["Cancel"]}}})
    };
    stdin
        .write_all(format!("{}\n", json!({"id":native["id"],"result":result})).as_bytes())
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let packet = packets.recv().await.unwrap().unwrap();
            assert!(
                packet.get("id").is_none(),
                "Unexpected extra native decision: {packet}"
            );
            let completed = packet["method"] == "turn/completed";
            observed.push(packet);
            if completed {
                break;
            }
        }
    })
    .await
    .unwrap();
    let closed = observed
        .iter()
        .find(|packet| {
            packet["method"] == "item/completed"
                && packet["params"]["item"]["server"] == "terminal_v4_browser"
                && packet["params"]["item"]["result"]["content"][0]["text"] == r#"{"closed":true}"#
        })
        .expect("Allow must dispatch the real broker action");
    assert_eq!(closed["params"]["item"]["status"], "completed");
    assert_eq!(
        client
            .get(format!(
                "http://{address}/api/workspace-browser/sessions/{}",
                first_target["sessionId"].as_str().unwrap()
            ))
            .send()
            .await
            .unwrap()
            .status(),
        axum::http::StatusCode::NOT_FOUND,
        "Allow must close the disposable shared session"
    );
    assert_eq!(
        fs::read_to_string(native_home.join("config.toml")).unwrap(),
        user_config
    );
    drop(stdin);
    tree.stop(Duration::from_millis(500)).await.unwrap();
    child.wait().await.unwrap();
    inference.kill().await.unwrap();
    reader.abort();
    server.abort();
}

#[tokio::test]
async fn failed_resume_never_silently_creates_a_new_conversation() {
    let directory = tempfile::tempdir().unwrap();
    let mut cmd = command(directory.path());
    cmd.env("CODEX_FIXTURE_RESUME_ERROR", "1");
    let mut request = options(directory.path(), "Continue");
    request.session_id = Some("native-fixture".into());
    let mut process = spawn_command(cmd, request).unwrap();
    assert!(collect(&mut process).await.iter().any(
        |e| matches!(e,StructuredSessionEvent::Error{message,..} if message.contains("preserved"))
    ));
    let log = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    assert!(!log.contains("thread/start") && !log.contains("turn/start"));
}

#[tokio::test]
async fn malformed_and_oversized_packets_fail_before_unbounded_allocation() {
    assert!(read_packet(&mut BufReader::new(&b"invalid\n"[..]))
        .await
        .is_err());
    assert!(
        read_packet(&mut BufReader::new(&vec![b'x'; PACKET_LIMIT + 1][..]))
            .await
            .is_err()
    );
}

#[test]
fn provider_private_reasoning_and_unknown_events_never_enter_the_transcript() {
    assert!(map_notification(&json!({"method":"item/completed","params":{"item":{"id":"private","type":"reasoning","text":"private"}}}),"turn").is_empty());
    assert!(map_notification(&json!({"method":"item/completed","params":{"item":{"id":"private","type":"reasoning","summary":[],"content":["raw chain of thought"]}}}),"turn").is_empty());
    assert!(map_notification(&json!({"method":"item/reasoning/textDelta","params":{"itemId":"private","delta":"raw chain of thought"}}),"turn").is_empty());
    let event = map_notification(
        &json!({"method":"item/completed","params":{"item":{"id":"cmd","type":"commandExecution","command":"false","aggregatedOutput":"failed","exitCode":1}}}),
        "turn",
    );
    assert!(
        matches!(&event[..],[StructuredSessionEvent::ToolCompleted{is_error:true,result,..}] if result=="failed")
    );
    assert!(
        matches!(&map_notification(&json!({"method":"item/commandExecution/outputDelta","params":{"itemId":"cmd","delta":"running tests"}}), "turn")[..], [StructuredSessionEvent::ToolOutput { output, tool_call_id: Some(id), .. }] if output == "running tests" && id == "cmd")
    );
}

struct FixtureProvider(PathBuf);
impl StructuredProvider for FixtureProvider {
    fn provider_id(&self) -> &'static str {
        "codex"
    }
    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        spawn_command(command(&self.0), options)
    }
}

async fn wait_idle(manager: &StructuredSessionManager, id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let live = manager.owned_session("owner", id).await.unwrap().unwrap();
            if live.state.lock().await.process.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn manager_stop_saves_terminal_outcome_and_idle_status_before_accepting_more_work() {
    let directory = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new_with_providers(
        AppConfig {
            data_dir: directory.path().join("data"),
            ..AppConfig::default()
        },
        vec![Arc::new(FixtureProvider(directory.path().into()))],
    );
    let session = manager
        .create_with_selection(
            "owner",
            directory.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let request = Uuid::new_v4().to_string();
    manager
        .submit("owner", &session.id, "hold", Some(&request))
        .await
        .unwrap();
    manager.interrupt("owner", &session.id).await.unwrap();
    let receipt = manager
        .request_receipt("owner", &session.id, &request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.status, "interrupted");
    let stopped = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(stopped.events.last(), Some(StructuredSessionEvent::Status { status, .. }) if status == "idle")
    );
    manager
        .submit(
            "owner",
            &session.id,
            "Continue",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    wait_idle(&manager, &session.id).await;
    let saved = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        saved
            .events
            .iter()
            .filter(|event| matches!(event, StructuredSessionEvent::TurnCompleted { .. }))
            .count(),
        2
    );
}

#[tokio::test]
async fn manager_persists_user_messages_deduplicates_requests_and_restores_native_resume() {
    let directory = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: directory.path().join("data"),
        ..AppConfig::default()
    };
    let make_manager = || {
        StructuredSessionManager::new_with_providers(
            config.clone(),
            vec![Arc::new(FixtureProvider(directory.path().into()))],
        )
    };
    let manager = make_manager();
    let snapshot = manager
        .create_with_selection(
            "owner",
            directory.path().to_str().unwrap(),
            Some("codex"),
            Some("fixture-model"),
            Some("high"),
            Some("Local Codex"),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.runtime.as_deref(), Some("codex"));
    let request = Uuid::new_v4().to_string();
    let receipt = manager
        .submit("owner", &snapshot.id, "Inspect", Some(&request))
        .await
        .unwrap();
    let duplicate = manager
        .submit("owner", &snapshot.id, "Inspect", Some(&request))
        .await
        .unwrap();
    assert_eq!(receipt.turn_id, duplicate.turn_id);
    assert!(manager
        .submit("owner", &snapshot.id, "Different", Some(&request))
        .await
        .is_err());
    wait_idle(&manager, &snapshot.id).await;
    assert!(manager
        .request_receipt("other", &snapshot.id, &request)
        .await
        .is_err());
    drop(manager);
    let manager = make_manager();
    let restored = manager
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        last_cli_session_id(&restored.events).as_deref(),
        Some("native-fixture")
    );
    manager
        .submit(
            "owner",
            &snapshot.id,
            "Continue",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    wait_idle(&manager, &snapshot.id).await;
    let restored = manager
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((restored.events.iter().filter(|e|matches!(e,StructuredSessionEvent::UserMessageAccepted{..})).count(),restored.events.iter().filter(|e|matches!(e,StructuredSessionEvent::MessageCompleted{role,..} if role=="assistant")).count()),(2,2));
    let requests = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    assert_eq!(
        requests
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|r| r["method"] == "turn/start")
            .count(),
        2
    );
}

#[test]
fn access_modes_choose_the_codex_sandbox_and_approval_policy() {
    assert_eq!(
        [None, Some("auto-edit"), Some("supervised"), Some("full")]
            .map(|access| codex_access_policy(access, false)),
        [
            ("workspace-write", "on-request"),
            ("workspace-write", "on-request"),
            ("workspace-write", "untrusted"),
            ("danger-full-access", "never"),
        ]
    );
    assert_eq!(
        codex_access_policy(Some("full"), true),
        ("read-only", "never")
    );
}

#[tokio::test]
async fn codex_questions_reach_the_user_and_their_answers_reach_codex() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "question"),
    )
    .unwrap();
    let (id, tool, input) =
        tokio::time::timeout(Duration::from_secs(5), next_approval(&mut process.events))
            .await
            .unwrap();
    let invalid = process
        .controller
        .send_bound_answers(&id, json!({"unknown": ["Indigo"]}))
        .await
        .is_err();
    let receipt = process
        .controller
        .send_bound_answers(&id, json!({"colour": ["Indigo"]}))
        .await
        .unwrap();
    collect(&mut process).await;
    let requests = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    let reply = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|request| request["id"] == "user-question")
        .unwrap();
    assert_eq!(
        (
            tool.as_str(),
            input["questions"][0]["question"].clone(),
            invalid,
            receipt.approved,
            reply["result"].clone()
        ),
        (
            "ask_user",
            json!("Which accent colour?"),
            true,
            true,
            json!({"answers": {"colour": {"answers": ["Indigo"]}}})
        )
    );
}

#[tokio::test]
async fn allowing_for_the_session_tells_codex_not_to_ask_again() {
    let directory = tempfile::tempdir().unwrap();
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "approval"),
    )
    .unwrap();
    let (id, _, _) =
        tokio::time::timeout(Duration::from_secs(5), next_approval(&mut process.events))
            .await
            .unwrap();
    process
        .controller
        .send_bound_session_approval(&id)
        .await
        .unwrap();
    collect(&mut process).await;
    let requests = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    let reply = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|request| request["id"] == "native-approval")
        .unwrap();
    assert_eq!(reply["result"], json!({"decision": "acceptForSession"}));
}

#[test]
fn codex_token_updates_become_context_usage() {
    let events = map_notification(
        &json!({"method": "thread/tokenUsage/updated", "params": {"tokenUsage": {
            "total": {"inputTokens": 9000, "cachedInputTokens": 4000, "outputTokens": 700},
            "last": {"inputTokens": 3000, "outputTokens": 200},
            "modelContextWindow": 272000
        }}}),
        "turn-1",
    );
    let usage = match &events[..] {
        [StructuredSessionEvent::ContextUsage { usage, turn_id, .. }] if turn_id == "turn-1" => {
            usage.clone()
        }
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(
        usage,
        json!({"inputTokens": 9000, "outputTokens": 700, "cacheReadTokens": 4000, "contextTokens": 3200, "contextWindow": 272000, "costUsd": null})
    );
}

#[test]
fn reasoning_summaries_and_plan_updates_reach_the_thread() {
    let map = |packet: Value| map_notification(&packet, "turn-1");
    let messages: Vec<(String, Option<String>, String, bool)> = [
        map(json!({"method":"item/reasoning/summaryPartAdded","params":{"itemId":"r1","summaryIndex":0}})),
        map(json!({"method":"item/reasoning/summaryTextDelta","params":{"itemId":"r1","delta":"Reading the layout"}})),
        map(json!({"method":"item/reasoning/summaryPartAdded","params":{"itemId":"r1","summaryIndex":1}})),
        map(json!({"method":"item/completed","params":{"item":{"id":"r1","type":"reasoning","summary":["Reading the layout","Checking tests"],"content":["raw"]}}})),
        map(json!({"method":"turn/plan/updated","params":{"explanation":"Two steps","plan":[{"step":"Fix CSS","status":"completed"},{"step":"Run tests","status":"inProgress"},{"status":"pending"}]}})),
        map(json!({"method":"turn/plan/updated","params":{"plan":[]}})),
    ]
    .into_iter()
    .flatten()
    .map(|event| match event {
        StructuredSessionEvent::MessageDelta { role, message_id, content, .. } => (role, message_id, content, false),
        StructuredSessionEvent::MessageCompleted { role, message_id, content, .. } => (role, message_id, content, true),
        other => panic!("unexpected event {other:?}"),
    })
    .collect();
    let plan = json!({"explanation":"Two steps","steps":[{"step":"Fix CSS","status":"completed"},{"step":"Run tests","status":"inProgress"}]}).to_string();
    let reasoning = |content: &str, done| {
        (
            "reasoning".to_owned(),
            Some("r1".to_owned()),
            content.to_owned(),
            done,
        )
    };
    assert_eq!(
        messages,
        vec![
            reasoning("Reading the layout", false),
            reasoning("\n\n", false),
            reasoning("Reading the layout\n\nChecking tests", true),
            (
                "plan".to_owned(),
                Some("plan-turn-1".to_owned()),
                plan,
                true
            ),
        ]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn queued_local_approval_retains_owner_fence_after_caller_timeout() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "synthetic-local-approval".into(),
        ..Default::default()
    })
    .unwrap();
    state
        .create_local_user_for_test("fixture", "fixture-password")
        .unwrap();
    let login = state
        .login("fixture", "fixture-password")
        .await
        .unwrap()
        .unwrap();
    let (user, authority) =
        crate::auth::authenticate_local_with_authority(&state, &login.tokens.access_token).unwrap();
    let guard = state.acquire_input_guard(&user.user_id).unwrap();
    let context = Arc::new(super::super::PairedDecisionContext {
        guard: Arc::new(guard),
        state: state.clone(),
        owner: user.user_id.clone(),
        authority: super::super::DecisionAuthority::Local(authority),
    });
    context.check().unwrap();
    let (sender, receiver) = mpsc::channel(1);
    let (reply, mut response) = oneshot::channel();
    sender
        .send(Control::Approval {
            id: "synthetic".into(),
            approved: true,
            answers: None,
            for_session: false,
            paired: Some(context),
            reply,
        })
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut response)
            .await
            .is_err()
    );
    let mut competing = tokio::task::spawn_blocking({
        let state = state.clone();
        let owner = user.user_id.clone();
        move || state.acquire_input_guard(&owner)
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut competing)
            .await
            .is_err()
    );
    drop(receiver);
    drop(
        tokio::time::timeout(Duration::from_secs(3), competing)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    );
}

#[cfg(unix)]
#[tokio::test]
async fn queued_paired_approval_retains_owner_fence_after_caller_timeout() {
    let data = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "synthetic-paired-approval".into(),
        ..Default::default()
    })
    .unwrap();
    let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    let guard = state.acquire_input_guard("owner").unwrap();
    state.verify_owner_input_guard(&guard).unwrap();
    let context = Arc::new(super::super::PairedDecisionContext {
        guard: Arc::new(guard),
        state: state.clone(),
        owner: "owner".into(),
        authority: super::super::DecisionAuthority::Paired(crate::auth::PairedInputAuthority {
            token,
            method: "POST".into(),
            path: "/api/structured/sessions/test/approve".into(),
        }),
    });
    context.check().unwrap();
    let (sender, receiver) = mpsc::channel(1);
    let (reply, mut response) = oneshot::channel();
    sender
        .send(Control::Approval {
            id: "synthetic".into(),
            approved: true,
            answers: None,
            for_session: false,
            paired: Some(context),
            reply,
        })
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut response)
            .await
            .is_err()
    );
    let mut competing = tokio::task::spawn_blocking({
        let state = state.clone();
        move || state.acquire_input_guard("owner")
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut competing)
            .await
            .is_err()
    );
    drop(receiver);
    let guard = tokio::time::timeout(Duration::from_secs(3), competing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(guard);
}

#[cfg(unix)]
#[tokio::test]
async fn paired_codex_approval_reaches_the_bound_native_action() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::new(AppConfig {
        data_dir: directory.path().join("data"),
        jwt_secret: "synthetic-paired-codex".into(),
        ..Default::default()
    })
    .unwrap();
    let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    let guard = state.acquire_input_guard("owner").unwrap();
    state.verify_owner_input_guard(&guard).unwrap();
    let context = Arc::new(super::super::PairedDecisionContext {
        guard: Arc::new(guard),
        state,
        owner: "owner".into(),
        authority: super::super::DecisionAuthority::Paired(crate::auth::PairedInputAuthority {
            token,
            method: "POST".into(),
            path: "/api/structured/sessions/test/approve".into(),
        }),
    });
    let mut process = spawn_command(
        command(directory.path()),
        options(directory.path(), "approval"),
    )
    .unwrap();
    let (id, _, _) =
        tokio::time::timeout(Duration::from_secs(5), next_approval(&mut process.events))
            .await
            .unwrap();
    let receipt = process
        .controller
        .send_paired_decision(Some(&id), false, None, false, context)
        .await
        .unwrap();
    assert_eq!((receipt.approval_id, receipt.approved), (id.clone(), false));
    let events = collect(&mut process).await;
    assert!(events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id, approved:false, .. } if approval_id == &id)));
    let requests = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
    assert!(requests
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|request| request["id"] == "native-approval"
            && request["result"]["decision"] == "decline"));
}

struct ApprovalFlushFailure {
    bytes_written: Arc<AtomicUsize>,
}

struct PausedApprovalFlush {
    stdin: tokio::process::ChildStdin,
    entered: Option<oneshot::Sender<()>>,
    release: oneshot::Receiver<()>,
    approval_written: bool,
}

impl tokio::io::AsyncWrite for PausedApprovalFlush {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if bytes
            .windows(b"native-approval".len())
            .any(|part| part == b"native-approval")
        {
            self.approval_written = true;
        }
        std::pin::Pin::new(&mut self.stdin).poll_write(cx, bytes)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if !self.approval_written {
            return std::pin::Pin::new(&mut self.stdin).poll_flush(cx);
        }
        if let Some(entered) = self.entered.take() {
            let _ = entered.send(());
        }
        match std::future::Future::poll(std::pin::Pin::new(&mut self.release), cx) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready(_) => std::task::Poll::Ready(Err(std::io::Error::other(
                "synthetic post-write flush failure",
            ))),
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

#[tokio::test]
async fn stopping_during_failed_approval_flush_preserves_uncertainty() {
    let directory = tempfile::tempdir().unwrap();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut process = spawn_command_inner(
        command(directory.path()),
        options(directory.path(), "approval"),
        Some(Box::new(move |stdin| {
            Box::new(PausedApprovalFlush {
                stdin,
                entered: Some(entered_tx),
                release: release_rx,
                approval_written: false,
            })
        })),
    )
    .unwrap();
    let (id, _, _) = next_approval(&mut process.events).await;
    let controller = process.controller.clone();
    let decision_id = id.clone();
    let decision =
        tokio::spawn(async move { controller.send_bound_approval(&decision_id, true).await });
    tokio::time::timeout(Duration::from_secs(5), entered_rx)
        .await
        .unwrap()
        .unwrap();

    let mut stop = Box::pin(process.controller.kill());
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(stop.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    release_tx.send(()).unwrap();
    assert!(decision.await.unwrap().is_err());
    stop.await.unwrap();
    let events = collect(&mut process).await;
    assert!(events.iter().any(|event| matches!(event,
        StructuredSessionEvent::Error { code: Some(code), .. }
            if code == &format!("codex_approval_uncertain:{id}")
    )));
    assert!(!events.iter().any(|event| matches!(event,
        StructuredSessionEvent::ApprovalResolved { approval_id, .. } if approval_id == &id
    )));
}
impl tokio::io::AsyncWrite for ApprovalFlushFailure {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.bytes_written.fetch_add(bytes.len(), Ordering::SeqCst);
        std::task::Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Err(std::io::Error::other(
            "synthetic post-write flush failure",
        )))
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn approval_flush_failure_does_not_allow_repeating_the_packet() {
    let directory = tempfile::tempdir().unwrap();
    let bytes_written = Arc::new(AtomicUsize::new(0));
    let (_, packets) = mpsc::channel(1);
    let (events, _) = mpsc::unbounded_channel();
    let (_, controls) = mpsc::channel(1);
    let (_, cancel) = watch::channel(false);
    let id = "synthetic-approval";
    let mut connection = Connection {
        stdin: Box::new(ApprovalFlushFailure {
            bytes_written: bytes_written.clone(),
        }),
        packets,
        events,
        controls,
        cancel,
        options: options(directory.path(), "approval"),
        turn_id: "turn".into(),
        thread_id: "thread".into(),
        native_turn_id: None,
        emitted_bytes: AtomicUsize::new(0),
        pending: HashMap::new(),
        approval_order: VecDeque::new(),
        decisions: HashMap::new(),
        approval_items: HashMap::new(),
        uncertain_approval: None,
        #[cfg(unix)]
        uncertain_paired: None,
    };
    connection.pending.insert(
        id.into(),
        Pending {
            approval_id: id.into(),
            rpc_id: json!("rpc-id"),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({}),
        },
    );
    connection.approval_order.push_back(id.into());
    assert!(connection
        .approve(
            id,
            true,
            None,
            false,
            #[cfg(unix)]
            None
        )
        .await
        .is_err());
    let first_write = bytes_written.load(Ordering::SeqCst);
    assert!(
        first_write > 0,
        "the fixture must fail only after accepting the packet bytes"
    );
    assert!(connection
        .approve(
            id,
            true,
            None,
            false,
            #[cfg(unix)]
            None
        )
        .await
        .is_err());
    assert_eq!(
        bytes_written.load(Ordering::SeqCst),
        first_write,
        "a retry must not write the approval packet again"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn manager_persists_codex_approval_claim_before_the_resolved_decision() {
    let directory = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: directory.path().join("data"),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new_with_providers(
        config,
        vec![Arc::new(FixtureProvider(directory.path().into()))],
    );
    let session = manager
        .create_session(
            "owner",
            directory.path().to_str().unwrap(),
            Some("codex"),
            Some("fixture-model"),
            None,
        )
        .await
        .unwrap();
    let (_, mut events) = manager.subscribe("owner", &session.id).await.unwrap();
    manager
        .submit(
            "owner",
            &session.id,
            "approval",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    let approval = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let StructuredSessionEvent::ApprovalRequired {
                approval_id: Some(id),
                ..
            } = events.recv().await.unwrap()
            {
                break id;
            }
        }
    })
    .await
    .unwrap();
    let receipt = manager
        .approve_bound("owner", &session.id, Some(&approval), false, None)
        .await
        .unwrap();
    assert_eq!(receipt.status, "accepted");
    wait_idle(&manager, &session.id).await;
    let snapshot = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    let started = snapshot
        .events
        .iter()
        .find_map(|event| match event {
            StructuredSessionEvent::ApprovalDecisionStarted {
                approval_id, seq, ..
            } if approval_id == &approval => Some(*seq),
            _ => None,
        })
        .expect("the claim must be persisted");
    let resolved = snapshot
        .events
        .iter()
        .find_map(|event| match event {
            StructuredSessionEvent::ApprovalResolved {
                approval_id,
                seq,
                approved: false,
                ..
            } if approval_id == &approval => Some(*seq),
            _ => None,
        })
        .expect("the native decision must be persisted");
    assert!(started < resolved);
    assert!(!super::super::unresolved_codex_approval(&snapshot.events));
    assert_eq!(
        manager
            .approve_bound("owner", &session.id, Some(&approval), false, None)
            .await
            .unwrap()
            .status,
        "already_decided"
    );
}
