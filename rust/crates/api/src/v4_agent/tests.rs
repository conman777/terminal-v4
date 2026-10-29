use super::*;
#[test]
fn options_reject_duplicate_identity_and_unsupported_transports() {
    let args = |pairs: &[&str]| pairs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(options(&args(&[
        "--provider",
        "deepseek",
        "--owner-hex",
        "6f776e6572"
    ]))
    .is_ok());
    for extra in [
        ["--owner-hex", "6f74686572"],
        ["--secret", "do-not-accept"],
        ["--reasoning", "unsupported-effort"],
    ] {
        let mut values = args(&["--provider", "deepseek", "--owner-hex", "6f776e6572"]);
        values.extend(args(&extra));
        assert!(options(&values).is_err());
    }
    assert!(options(&args(&[
        "--provider",
        "deepseek",
        "--owner-hex",
        "6f776e6572",
        "--reasoning",
        "high"
    ]))
    .is_ok());
    assert!(options(&args(&[
        "--provider",
        "deepseek",
        "--owner-hex",
        "6f776e6572",
        "--model",
        "custom-unverified-model",
        "--reasoning",
        "high"
    ]))
    .is_err());
    assert!(options(&args(&[
        "--provider",
        "anthropic-api",
        "--owner-hex",
        "6f776e6572",
        "--reasoning",
        "none"
    ]))
    .is_err());
    assert!(!supports("hermes"));
    assert!(!supports("bedrock"));
    assert!(supports("anthropic-api"));
    assert!(supports("openai-api"));
}
#[test]
fn history_is_account_and_workspace_scoped_and_round_trips() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let mut session = new_session("deepseek", "model", &root);
    session.messages.push(Message {
        attachments: Vec::new(),
        role: "user".into(),
        text: "fixture".into(),
    });
    save(data.path(), "owner", &mut session).unwrap();
    assert_eq!(
        load(data.path(), "owner", &root, &session.id)
            .unwrap()
            .messages[0]
            .text,
        "fixture"
    );
    assert!(load(data.path(), "other", &root, &session.id).is_err());
    assert!(load(data.path(), "owner", other.path(), &session.id).is_err());
    assert!(load(data.path(), "owner", &root, "../../outside").is_err());
}
#[test]
fn history_inventory_counts_live_heads_without_storage_sidecars_or_tombstones() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    let mut expected = std::collections::BTreeSet::new();
    for _ in 0..30 {
        let mut session = new_session("deepseek", "model", &root);
        save(data.path(), "owner", &mut session).unwrap();
        expected.insert(session.id);
    }
    let listed = sessions(data.path(), "owner", &root);
    assert_eq!(listed.len(), expected.len());
    assert_eq!(
        listed
            .into_iter()
            .map(|s| s.id)
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );

    for _ in 0..55 {
        let mut deleted = new_session("deepseek", "model", &root);
        save(data.path(), "owner", &mut deleted).unwrap();
        session_store::delete(data.path(), "owner", &root, &deleted.id).unwrap();
    }
    let listed = sessions(data.path(), "owner", &root);
    assert_eq!(listed.len(), expected.len());
    assert_eq!(
        listed
            .into_iter()
            .map(|s| s.id)
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );
    assert!(sessions(data.path(), "other-owner", &root).is_empty());
}

#[test]
fn endpoints_do_not_allow_plaintext_remote_or_inline_credentials() {
    assert_eq!(
        checked_url("http://127.0.0.1:1234/v1/", "openai-chat").unwrap(),
        "http://127.0.0.1:1234/v1/chat/completions"
    );
    for base in [
        "http://example.com/v1",
        "https://key@example.com",
        "https://example.com?key=secret",
        "file:///tmp/fixture",
    ] {
        assert!(checked_url(base, "openai-chat").is_err());
    }
}
#[tokio::test]
async fn local_provider_completes_a_real_tool_cycle_and_preserves_workspace_context() {
    use axum::{routing::post, Json};
    use std::sync::{Arc, Mutex};
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router=axum::Router::new().route("/v1/chat/completions",post(move |headers:axum::http::HeaderMap,Json(body):Json<Value>|{let captured=captured.clone();async move {
        assert_eq!(headers["authorization"],"Bearer fixture-secret");
        let mut requests=captured.lock().unwrap();requests.push(body);
        Json(if requests.len()==1 {json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"write","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"result.txt\",\"content\":\"original V4 tool loop\"}"}}]}}]})} else {json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixture completed"}}]})})
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let provider = Provider {
        #[cfg(unix)]
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{addr}/v1/chat/completions"),
        secret: "fixture-secret".into(),
        client: reqwest::Client::new(),
    };
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let path =
        crate::workspace::profile_path(data.path(), "owner", &root.to_string_lossy()).unwrap();
    crate::workspace::write_profile(
        &path,
        &crate::workspace::WorkspaceProfile {
            memory: "Remember fixture context".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let mut session = new_session("deepseek", "fixture-model", &root);
    assert_eq!(
        turn(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Write the fixture",
            None,
            false
        )
        .await
        .unwrap(),
        "Fixture completed"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("result.txt")).unwrap(),
        "original V4 tool loop"
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0]["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("Remember fixture context"));
    assert_eq!(requests[1]["messages"][3]["tool_call_id"], "write");
    assert!(!std::fs::read_to_string(
        directory(data.path(), "owner", &root).join(format!("{}.json", session.id))
    )
    .unwrap()
    .contains("fixture-secret"));
    server.abort();
}

#[tokio::test]
async fn project_skills_are_discovered_and_read_on_demand_without_losing_saved_guidance() {
    use axum::{routing::post, Json};
    use std::sync::{Arc, Mutex};

    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let skill_dir = root.join(".v4/skills/review");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "Review task guidance\nDistinct full instructions",
    )
    .unwrap();
    std::fs::write(root.join("AGENTS.md"), "Workspace policy fixture").unwrap();
    let data = tempfile::tempdir().unwrap();
    let skill = |name: &str, instructions: &str| crate::workspace::WorkspaceSkill {
        id: uuid::Uuid::new_v4(),
        name: name.into(),
        instructions: instructions.into(),
        activation: None,
        support_files: Default::default(),
    };
    for (path, memory, saved_skill) in [
        (
            crate::workspace::account_profile_path(data.path(), "owner"),
            "Account memory fixture",
            skill("account", "Account saved instructions"),
        ),
        (
            crate::workspace::profile_path(data.path(), "owner", &root.to_string_lossy()).unwrap(),
            "Workspace memory fixture",
            skill("workspace", "Workspace saved instructions"),
        ),
    ] {
        crate::workspace::write_profile(
            &path,
            &crate::workspace::WorkspaceProfile {
                memory: memory.into(),
                skills: vec![saved_skill],
                ..Default::default()
            },
        )
        .unwrap();
    }
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let mut requests = captured.lock().unwrap();
            requests.push(body.clone());
            let call = match requests.len() {
                1 => Some(("discover", "discover_skills", json!({}))),
                2 => {
                    let result: Value = serde_json::from_str(body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap()).unwrap();
                    let reference = result["skills"].as_array().unwrap().iter().find(|s| s["name"] == "review").unwrap()["skillRef"].as_str().unwrap();
                    Some(("read", "read_skill_file", json!({"skillRef":reference,"path":"SKILL.md"})))
                }
                _ => None,
            };
            Json(if let Some((id, name, arguments)) = call {
                json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]}}]})
            } else {
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]})
            })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider = Provider {
        #[cfg(unix)]
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{addr}/v1/chat/completions"),
        secret: "fixture".into(),
        client: reqwest::Client::new(),
    };
    let mut session = new_session("deepseek", "custom-unverified-model", &root);
    assert_eq!(
        turn(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Use the review skill. Explicitly selected composer instructions.",
            None,
            false
        )
        .await
        .unwrap(),
        "Done"
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let system = requests[0]["messages"][0]["content"].as_str().unwrap();
    for expected in [
        "Account memory fixture",
        "Workspace memory fixture",
        "Account saved instructions",
        "Workspace saved instructions",
        "Workspace policy fixture",
        "discover_skills",
        "read_skill_file",
    ] {
        assert!(system.contains(expected), "missing {expected}");
    }
    assert!(!system.contains("Distinct full instructions"));
    assert_eq!(
        requests[0]["messages"][1]["content"],
        "Use the review skill. Explicitly selected composer instructions."
    );
    assert!(
        requests[2]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("Distinct full instructions")
    );
    for name in ["discover_skills", "read_skill_file"] {
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == name));
    }
    server.abort();
}

#[tokio::test]
async fn provider_can_read_a_workspace_file_by_line_range() {
    use axum::{routing::post, Json};
    use std::sync::{Arc, Mutex};

    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    std::fs::write(root.join("notes.txt"), "one\ntwo\nthree\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let mut requests = captured.lock().unwrap();
            requests.push(body);
            Json(if requests.len() == 1 {
                json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"read","type":"function","function":{"name":"read_file","arguments":json!({"path":"notes.txt","start_line":2,"line_count":1}).to_string()}}]}}]})
            } else {
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]})
            })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider = Provider {
        #[cfg(unix)]
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{addr}/v1/chat/completions"),
        secret: "fixture".into(),
        client: reqwest::Client::new(),
    };
    let mut session = new_session("deepseek", "fixture-model", &root);
    assert_eq!(
        turn(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Read line two",
            None,
            false
        )
        .await
        .unwrap(),
        "Done"
    );
    let requests = requests.lock().unwrap();
    let schema = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "read_file")
        .unwrap();
    assert_eq!(
        schema["function"]["parameters"]["properties"]["line_count"]["maximum"],
        2000
    );
    let result: Value = serde_json::from_str(
        requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({"content":"two\n", "startLine":2, "nextLine":3, "totalLines":3})
    );
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn provider_can_search_workspace_filenames_with_a_regex() {
    use axum::{routing::post, Json};
    use std::sync::{Arc, Mutex};
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    std::fs::write(root.join("match.rs"), "fixture").unwrap();
    std::fs::write(root.join("other.txt"), "fixture").unwrap();
    let data = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let mut requests = captured.lock().unwrap();
            requests.push(body);
            Json(if requests.len() == 1 {
                json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"search","type":"function","function":{"name":"search_text","arguments":json!({"path":".","text":"\\.rs$","regex":true,"mode":"files"}).to_string()}}]}}]})
            } else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]}) })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider = Provider {
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{addr}/v1/chat/completions"),
        secret: "fixture".into(),
        client: reqwest::Client::new(),
    };
    let mut session = new_session("deepseek", "fixture-model", &root);
    assert_eq!(
        turn(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Find Rust files",
            None,
            false
        )
        .await
        .unwrap(),
        "Done"
    );
    let requests = requests.lock().unwrap();
    let schema = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "search_text")
        .unwrap();
    assert_eq!(
        schema["function"]["parameters"]["properties"]["mode"]["enum"],
        json!(["content", "files"])
    );
    let result: Value = serde_json::from_str(
        requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["matches"], json!([{"path":"match.rs"}]));
    server.abort();
}

#[test]
fn rewind_creates_an_independent_visible_prefix_and_rejects_source_drift() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let mut original = new_session("deepseek", "fixture-model", &root);
    for (role, text) in [
        ("user", "first"),
        ("assistant", "answer"),
        ("user", "second"),
        ("assistant", "later"),
    ] {
        original.messages.push(Message {
            attachments: Vec::new(),
            role: role.into(),
            text: text.into(),
        });
    }
    original.history = original
        .messages
        .iter()
        .map(|m| json!({"role":m.role,"content":m.text}))
        .collect();
    save(data.path(), "owner", &mut original).unwrap();
    let fingerprint = session_fingerprint(&original);
    let branch = fork(data.path(), "owner", &root, &original.id, 1, &fingerprint).unwrap();
    assert_ne!(branch.id, original.id);
    assert_eq!(branch.messages.len(), 2);
    assert_eq!(branch.messages[1].text, "answer");
    assert_eq!(
        load(data.path(), "owner", &root, &original.id)
            .unwrap()
            .messages
            .len(),
        4
    );
    original.model = "changed-model".into();
    save(data.path(), "owner", &mut original).unwrap();
    assert!(fork(data.path(), "owner", &root, &original.id, 1, &fingerprint).is_err());
    assert!(fork(
        data.path(),
        "other",
        &root,
        &original.id,
        1,
        &session_fingerprint(&original)
    )
    .is_err());
}

#[tokio::test]
async fn streaming_provider_delivers_tokens_while_the_http_response_is_still_open() {
    use axum::{body::Body, response::Response, routing::post};
    use std::convert::Infallible;
    use std::sync::{Arc, Mutex};
    let (release, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    let router=axum::Router::new().route("/v1/chat/completions",post(move |axum::Json(request):axum::Json<Value>| {
        let receiver=release_rx.lock().unwrap().take().unwrap();
        async move {
            assert_eq!(request["stream"],true);
            let (send,recv)=tokio::sync::mpsc::channel::<Result<String,Infallible>>(4);
            send.send(Ok(format!("data: {}\n\n",json!({"choices":[{"index":0,"delta":{"content":"early token"},"finish_reason":null}]})))).await.unwrap();
            tokio::spawn(async move {
                receiver.await.unwrap();
                send.send(Ok(format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})))).await.unwrap();
            });
            Response::builder().header("Content-Type","text/event-stream; charset=utf-8").body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(recv))).unwrap()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let provider = Provider {
        #[cfg(unix)]
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{addr}/v1/chat/completions"),
        secret: "fixture-only".into(),
        client: reqwest::Client::new(),
    };
    let (send, mut recv) = tokio::sync::mpsc::unbounded_channel();
    let mut on_text = |text: &str| {
        send.send(text.to_owned()).unwrap();
        Ok(())
    };
    let request = json!({"model":"fixture-model","messages":[{"role":"user","content":"Stream"}]});
    let future = provider.request(&request, &mut on_text);
    tokio::pin!(future);
    tokio::select! {
        early=recv.recv()=>assert_eq!(early.as_deref(),Some("early token")),
        result=&mut future=>panic!("Provider finished before releasing the final event: {result:?}"),
        _=tokio::time::sleep(Duration::from_secs(3))=>panic!("Provider buffered the stream instead of emitting text"),
    }
    release.send(()).unwrap();
    let body = future.await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "early token");
    server.abort();
}

// TEST-ONLY UNAPPLIED PREVIEW: append inside v4_agent/tests.rs's module.
// Uses the existing actual Provider::new and actual authenticated public routes.
// Constructor probes NEVER call Provider::request or open a socket.
mod anthropic_endpoint_preview {
    use super::*;
    const CHILD: &str = "v4_agent::tests::anthropic_endpoint_preview::isolated_child";
    const SECRET: &str = "synthetic-anthropic-key-no-real-credential";

    fn child(mode: &str, endpoint: Option<&str>) -> std::process::Output {
        let root = tempfile::tempdir().expect("own synthetic fixture root");
        let home = root.path().join("home");
        let temp = root.path().join("tmp");
        let data = root.path().join("data");
        for path in [&home, &temp, &data] {
            std::fs::create_dir(path).unwrap();
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", CHILD, "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("TMPDIR", &temp)
            .env("TMP", &temp)
            .env("TEMP", &temp)
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .env("NO_PROXY", "*")
            .env("no_proxy", "*")
            .env("VAULT_ENCRYPTION_KEY", "synthetic-anthropic-vault-only")
            .env("ANTHROPIC_API_KEY", SECRET)
            .env("V4_ANTHROPIC_ENDPOINT_PREVIEW_CHILD", mode)
            .env("V4_ANTHROPIC_ENDPOINT_PREVIEW_DATA", &data);
        if let Some(endpoint) = endpoint {
            command
                .env("ANTHROPIC_BASE_URL", endpoint)
                .env("V4_ANTHROPIC_ENDPOINT_PREVIEW_EXPECT_BASE", endpoint);
        }
        // Windows can require these OS paths even in an otherwise isolated child.
        for name in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .output()
            .expect("launch the test binary, not the API or vendor CLI")
    }
    fn success(output: std::process::Output) {
        assert!(
            output.status.success(),
            "isolated probe failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn explicit_fixture_loopback(value: Option<&str>) -> Result<String, &'static str> {
        let value = value
            .filter(|value| !value.trim().is_empty())
            .ok_or("explicit loopback fixture override required")?;
        let parsed = url::Url::parse(value).map_err(|_| "invalid fixture URL")?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("fixture must select literal owned loopback HTTP with an explicit port");
        }
        Ok(value.into())
    }

    #[test]
    fn metadata_selects_explicit_anthropic_environment_without_changing_defaults_or_capabilities() {
        let definition = provider_config::definition("anthropic-api").unwrap();
        assert_eq!(definition["baseUrlEnvKey"], "ANTHROPIC_BASE_URL");
        assert_eq!(definition["baseUrl"], "https://api.anthropic.com");
        assert_eq!(definition["auth"], "api-key");
        assert_eq!(definition["authMethods"], json!(["api-key"]));
        let known = provider_config::select("anthropic-api", "claude-fable-5").unwrap();
        assert_eq!(
            known.base_url_env_key.as_deref(),
            Some("ANTHROPIC_BASE_URL")
        );
        assert_eq!(known.transport, "anthropic-messages");
        assert_eq!(known.image_input, Some(true));
        let unknown = provider_config::select("anthropic-api", "custom-unverified-model").unwrap();
        assert_eq!(unknown.image_input, None);
        assert!(unknown.reasoning_levels.is_empty());
        assert!(provider_config::select("not-a-provider", "model").is_err());
    }
    #[test]
    fn actual_constructor_selects_the_explicit_loopback_gateway_before_any_request() {
        let base = "http://127.0.0.1:43197/gateway"; // Constructor only, not a bound port.
        assert!(explicit_fixture_loopback(Some(base)).is_ok());
        success(child("resolved-loopback", Some(base)));
    }
    #[test]
    fn actual_constructor_selects_https_gateway_and_retains_the_existing_messages_suffix() {
        success(child(
            "resolved-https",
            Some("https://gateway.invalid/anthropic-root/"),
        ));
    }
    #[test]
    fn explicitly_invalid_anthropic_overrides_use_the_existing_url_rejector_without_fallback() {
        let mut wrongly_accepted = Vec::new();
        for value in [
            "not a URL",
            "file:///tmp/not-opened",
            "ftp://gateway.invalid",
            "http://gateway.invalid",
            "https://user:fixture@gateway.invalid",
            "https://gateway.invalid?key=synthetic",
            "https://gateway.invalid#fragment",
            "https://gateway.invalid:99999",
        ] {
            let result = child("reject-invalid", Some(value));
            if !result.status.success() {
                wrongly_accepted.push(value);
            }
        }
        assert!(
            wrongly_accepted.is_empty(),
            "existing constructor ignored invalid explicit settings: {wrongly_accepted:?}"
        );
    }
    #[test]
    fn unset_override_retains_the_default_constructor_target_without_sending_http() {
        success(child("default-unset", None));
    }
    #[test]
    fn blank_override_retains_existing_shared_default_semantics_without_sending_http() {
        success(child("default-blank", Some("  ")));
    }
    #[test]
    fn shared_messages_url_validation_stays_strict_and_other_provider_selection_is_unchanged() {
        assert_eq!(
            checked_url("https://gateway.invalid/prefix/", "anthropic-messages").unwrap(),
            "https://gateway.invalid/prefix/v1/messages"
        );
        assert_eq!(
            checked_url("http://127.0.0.1:43197", "anthropic-messages").unwrap(),
            "http://127.0.0.1:43197/v1/messages"
        );
        for value in [
            "http://remote.invalid",
            "https://user:fixture@gateway.invalid",
            "https://gateway.invalid?x=1",
            "https://gateway.invalid#x",
            "file:///tmp/not-opened",
        ] {
            assert!(checked_url(value, "anthropic-messages").is_err());
        }
        assert_eq!(
            provider_config::select("openai-api", "gpt-5.4")
                .unwrap()
                .base_url_env_key
                .as_deref(),
            Some("OPENAI_BASE_URL")
        );
        assert_eq!(
            provider_config::select("deepseek", "deepseek-v4-flash")
                .unwrap()
                .base_url_env_key
                .as_deref(),
            Some("DEEPSEEK_BASE_URL")
        );
        assert_eq!(
            provider_config::select("opencode-go", "minimax-m3")
                .unwrap()
                .base_url_env_key
                .as_deref(),
            Some("OPENCODE_GO_ANTHROPIC_BASE_URL")
        );
        assert!(
            options(
                &[
                    "--provider",
                    "anthropic-api",
                    "--owner-hex",
                    "6f776e6572",
                    "--base-url",
                    "http://127.0.0.1:43197"
                ]
                .map(str::to_owned)
            )
            .is_err(),
            "endpoint is host configuration, not an arbitrary agent CLI argument"
        );
    }
    #[test]
    fn actual_public_catalog_and_key_routes_preserve_owner_credentials_and_model_flags() {
        success(child("catalog", Some("http://127.0.0.1:43197/gateway")));
    }
    #[test]
    fn runtime_fixture_guard_rejects_missing_or_vendor_override_before_launch_or_request() {
        for value in [
            None,
            Some(""),
            Some(" "),
            Some("https://api.anthropic.com"),
            Some("https://gateway.invalid"),
            Some("http://127.0.0.1:43197?key=x"),
            Some("http://user:x@127.0.0.1:43197"),
        ] {
            assert!(explicit_fixture_loopback(value).is_err());
        }
        assert!(explicit_fixture_loopback(Some("http://127.0.0.1:43197/anthropic-root")).is_ok());
    }

    #[test]
    fn isolated_child() {
        let Ok(mode) = std::env::var("V4_ANTHROPIC_ENDPOINT_PREVIEW_CHILD") else {
            return;
        };
        if mode == "catalog" {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(public_catalog());
            return;
        }
        let expected = std::env::var("V4_ANTHROPIC_ENDPOINT_PREVIEW_EXPECT_BASE").ok();
        if mode == "resolved-loopback" {
            // A failing/missing fixture configuration cannot fall back to a vendor.
            explicit_fixture_loopback(expected.as_deref())
                .expect("abort fixture before Provider construction/request");
        }
        let result = Provider::new("anthropic-api", SECRET.into(), "claude-fable-5");
        if mode == "reject-invalid" {
            assert!(
                result.is_err(),
                "explicit invalid override must not silently select default"
            );
            return;
        }
        let provider = result.expect("existing actual constructor");
        assert_eq!(provider.transport, "anthropic-messages");
        assert_eq!(provider.secret, SECRET);
        match mode.as_str() {
            "resolved-loopback" => {
                assert_eq!(provider.url, "http://127.0.0.1:43197/gateway/v1/messages")
            }
            "resolved-https" => assert_eq!(
                provider.url,
                "https://gateway.invalid/anthropic-root/v1/messages"
            ),
            "default-unset" | "default-blank" => {
                assert_eq!(provider.url, "https://api.anthropic.com/v1/messages")
            }
            _ => panic!("unknown isolated probe mode"),
        }
        // Intentionally NO provider.request, listener, DNS, or actual API launch.
    }

    async fn public_catalog() {
        use crate::{
            auth::{issue_access_token, require_auth},
            state::AppState,
        };
        use axum::{
            body::{to_bytes, Body},
            http::{Request, StatusCode},
            middleware,
        };
        use terminal_v4_core::AppConfig;
        use tower::ServiceExt;
        let data = std::path::PathBuf::from(
            std::env::var_os("V4_ANTHROPIC_ENDPOINT_PREVIEW_DATA").unwrap(),
        );
        let state = AppState::new(AppConfig {
            data_dir: data.clone(),
            jwt_secret: "anthropic-config-preview-jwt".into(),
            ..Default::default()
        })
        .unwrap();
        let app = crate::agent_catalog::routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state.clone());
        let request = |method: &str, route: &str, owner: &str, body: &str| {
            Request::builder()
                .method(method)
                .uri(route)
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        issue_access_token("anthropic-config-preview-jwt", owner, owner)
                    ),
                )
                .body(Body::from(body.to_owned()))
                .unwrap()
        };
        async fn body(response: axum::response::Response) -> Value {
            serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                .unwrap()
        }
        let catalog = |value: &Value| {
            value["agents"]
                .as_array()
                .unwrap()
                .iter()
                .find(|agent| agent["id"] == "anthropic-api")
                .unwrap()
                .clone()
        };
        let initial = body(
            app.clone()
                .oneshot(request("GET", "/api/agent/catalog", "owner", ""))
                .await
                .unwrap(),
        )
        .await;
        let initial = catalog(&initial);
        assert_eq!(initial["configured"], false);
        // An ambient synthetic ANTHROPIC_API_KEY does not bypass the owned vault.
        assert!(owned_key(&data, "owner", "anthropic-api").is_err());
        for key in ["", " ", "short", "synthetic\nkey"] {
            let response = app
                .clone()
                .oneshot(request(
                    "PUT",
                    "/api/agent/auth/anthropic-api/api-key",
                    "owner",
                    &json!({"apiKey":key}).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = app
            .clone()
            .oneshot(request(
                "PUT",
                "/api/agent/auth/anthropic-api/api-key",
                "owner",
                &json!({"apiKey":SECRET,"baseUrl":"http://127.0.0.1:43197"}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "existing secret-only strict DTO must not become a request endpoint setting"
        );
        let response = app
            .clone()
            .oneshot(request(
                "PUT",
                "/api/agent/auth/anthropic-api/api-key",
                "owner",
                &json!({"apiKey":SECRET}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(owned_key(&data, "owner", "anthropic-api").unwrap(), SECRET);
        assert!(owned_key(&data, "foreign", "anthropic-api").is_err());
        let owner = body(
            app.clone()
                .oneshot(request("GET", "/api/agent/catalog", "owner", ""))
                .await
                .unwrap(),
        )
        .await;
        assert!(!owner.to_string().contains(SECRET));
        assert!(!owner.to_string().contains("127.0.0.1:43197"));
        let selected = catalog(&owner);
        assert_eq!(selected["configured"], true);
        assert_eq!(selected["runtime"], "v4");
        assert_eq!(selected["capabilities"]["structured"], true);
        let known = selected["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["id"] == "claude-fable-5")
            .unwrap();
        assert_eq!(known["imageInput"], true);
        let unknown = selected["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["id"] == "claude-haiku-4-5-20251001")
            .unwrap();
        assert!(unknown["imageInput"].is_null());
        let foreign = body(
            app.clone()
                .oneshot(request("GET", "/api/agent/catalog", "foreign", ""))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(catalog(&foreign)["configured"], false);
        let auth = body(
            app.oneshot(request("GET", "/api/agent/auth", "owner", ""))
                .await
                .unwrap(),
        )
        .await;
        let auth = auth["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "anthropic-api")
            .unwrap();
        assert_eq!(auth["methods"], json!(["api-key"]));
    }
}

#[test]
fn cli_model_change_rebuilds_transport_and_respects_protocol_history() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let mut session = new_session("opencode-go", "kimi-k3", workspace.path());
    let mut provider = Provider::new("opencode-go", "synthetic".into(), "kimi-k3").unwrap();
    change_cli_model(
        data.path(),
        "owner",
        &mut session,
        &mut provider,
        "minimax-m3",
        None,
    )
    .unwrap();
    assert_eq!(
        (
            session.model.as_str(),
            session.transport.as_deref(),
            provider.transport.as_str()
        ),
        (
            "minimax-m3",
            Some("anthropic-messages"),
            "anthropic-messages"
        )
    );
    assert!(provider.url.ends_with("/v1/messages"));
    session
        .history
        .push(json!({"role":"user","content":"retained"}));
    let before = session_fingerprint(&session);
    let target = provider.url.clone();
    assert!(change_cli_model(
        data.path(),
        "owner",
        &mut session,
        &mut provider,
        "kimi-k3",
        None
    )
    .unwrap_err()
    .contains("different protocol"));
    assert_eq!(
        (session_fingerprint(&session), provider.url),
        (before, target)
    );
}

#[test]
fn cli_selection_validates_resumed_reasoning_and_model_protocol() {
    let workspace = tempfile::tempdir().unwrap();
    let mut session = new_session("opencode-go", "minimax-m3", workspace.path());
    let provider = prepare_cli_selection(&mut session, "synthetic", None).unwrap();
    assert_eq!(provider.transport, "anthropic-messages");
    let mut session = new_session("openai-api", "gpt-4.1", workspace.path());
    assert!(prepare_cli_selection(&mut session, "synthetic", Some("high")).is_err());
}

#[test]
fn cli_failed_model_save_preserves_active_provider_and_session() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let mut session = new_session("opencode-go", "kimi-k3", workspace.path());
    let mut provider = Provider::new("opencode-go", "synthetic".into(), "kimi-k3").unwrap();
    let before = session_fingerprint(&session);
    let invalid_data = data.path().join("file");
    std::fs::write(&invalid_data, b"sentinel").unwrap();
    assert!(change_cli_model(
        &invalid_data,
        "owner",
        &mut session,
        &mut provider,
        "minimax-m3",
        None
    )
    .is_err());
    assert_eq!(
        (session_fingerprint(&session), provider.transport.as_str()),
        (before, "openai-chat")
    );
}

#[tokio::test]
async fn saved_on_demand_skills_are_read_by_scoped_reference_in_provider_turns() {
    use crate::workspace::{SkillActivation, WorkspaceProfile, WorkspaceSkill};
    use axum::{routing::post, Json};
    use std::sync::{Arc, Mutex};
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let other_workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    let other_root = other_workspace.path().canonicalize().unwrap();
    let id = uuid::Uuid::new_v4();
    let workspace_instructions = format!("{}WORKSPACE_TAIL", "x".repeat(4000));
    let account_instructions = format!("{}ACCOUNT_TAIL", "ACCOUNT_INSTRUCTIONS\n".repeat(100));
    let skill = |id, name: &str, instructions: &str, activation| WorkspaceSkill {
        id,
        name: name.into(),
        instructions: instructions.into(),
        activation,
        support_files: [("references/private.md".into(), "SUPPORT_SECRET".into())]
            .into_iter()
            .collect(),
    };
    let legacy: WorkspaceSkill = serde_json::from_value(
        json!({"id":uuid::Uuid::new_v4(),"name":"Legacy","instructions":"LEGACY_INSTRUCTIONS"}),
    )
    .unwrap();
    for (path, memory, skills) in [
        (
            crate::workspace::account_profile_path(data.path(), "owner"),
            "ACCOUNT_MEMORY",
            vec![
                skill(
                    id,
                    "Duplicate\nname",
                    &account_instructions,
                    Some(SkillActivation::OnDemand),
                ),
                legacy,
            ],
        ),
        (
            crate::workspace::profile_path(data.path(), "owner", &root.to_string_lossy()).unwrap(),
            "WORKSPACE_MEMORY",
            vec![
                skill(
                    id,
                    "Duplicate\nname",
                    &workspace_instructions,
                    Some(SkillActivation::OnDemand),
                ),
                skill(
                    uuid::Uuid::new_v4(),
                    "Always",
                    "ALWAYS_INSTRUCTIONS",
                    Some(SkillActivation::AlwaysOn),
                ),
            ],
        ),
    ] {
        crate::workspace::write_profile(
            &path,
            &WorkspaceProfile {
                memory: memory.into(),
                skills,
                ..Default::default()
            },
        )
        .unwrap();
    }
    std::fs::write(root.join("AGENTS.md"), "AGENTS_POLICY").unwrap();
    for (owner, workspace, reference) in [
        ("other", root.as_path(), format!("account:{id}")),
        ("other", root.as_path(), format!("workspace:{id}")),
        ("owner", other_root.as_path(), format!("workspace:{id}")),
    ] {
        assert!(knowledge::dispatch(
            data.path(),
            owner,
            workspace,
            "read_skill_file",
            &json!({"skillRef":reference,"path":"SKILL.md"})
        )
        .is_err());
    }
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let mut requests = captured.lock().unwrap();
            requests.push(body.clone());
            let phase = (requests.len() - 1) % 5;
            let system = body["messages"][0]["content"].as_str().unwrap();
            let entries = system.lines().filter_map(|line| line.strip_prefix("On-demand skill: ")).map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
            let reference = |scope: &str| entries.iter().find(|entry| entry["scope"] == scope).unwrap()["skillRef"].as_str().unwrap().to_owned();
            let args = match phase {
                0 => Some(json!({"skillRef":reference("workspace"),"path":"SKILL.md"})),
                1 => {
                    let result: Value = serde_json::from_str(body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap()).unwrap();
                    assert_eq!(result["lines"][0]["nextCharOffset"], 4000);
                    Some(json!({"skillRef":reference("workspace"),"path":"SKILL.md","startLine":1,"charOffset":4000}))
                }
                2 => Some(json!({"skillRef":reference("account"),"path":"SKILL.md"})),
                3 => {
                    let result: Value = serde_json::from_str(body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap()).unwrap();
                    assert_eq!(result["nextLine"], 101);
                    Some(json!({"skillRef":reference("account"),"path":"SKILL.md","startLine":101}))
                }
                _ => None,
            };
            Json(if let Some(args) = args { json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":format!("read-{phase}"),"type":"function","function":{"name":"read_skill_file","arguments":args.to_string()}}]}}]}) } else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]}) })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider = Provider {
        #[cfg(unix)]
        profile: None,
        transport: "openai-chat".into(),
        url: format!("http://{addr}/v1/chat/completions"),
        secret: "fixture".into(),
        client: reqwest::Client::new(),
    };
    for model in ["deepseek-v4-pro", "custom-unverified-model"] {
        let mut session = new_session("deepseek", model, &root);
        assert_eq!(
            turn(
                &provider,
                data.path(),
                "owner",
                &mut session,
                "Explicit selected instructions",
                None,
                false
            )
            .await
            .unwrap(),
            "Done"
        );
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 10);
    for cycle in requests.chunks_exact(5) {
        let system = cycle[0]["messages"][0]["content"].as_str().unwrap();
        for value in [
            "ACCOUNT_MEMORY",
            "WORKSPACE_MEMORY",
            "LEGACY_INSTRUCTIONS",
            "ALWAYS_INSTRUCTIONS",
            "AGENTS_POLICY",
            "read_skill_file",
            "nextCharOffset",
            "nextLine",
        ] {
            assert!(system.contains(value), "missing {value}");
        }
        for value in [
            "ACCOUNT_INSTRUCTIONS",
            "WORKSPACE_TAIL",
            "SUPPORT_SECRET",
            &"x".repeat(100),
        ] {
            assert!(!system.contains(value), "leaked {value}");
        }
        let metadata = system
            .lines()
            .filter_map(|line| line.strip_prefix("On-demand skill: "))
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            metadata,
            vec![
                json!({"scope":"account","skillRef":format!("account:{id}"),"name":"Duplicate\nname"}),
                json!({"scope":"workspace","skillRef":format!("workspace:{id}"),"name":"Duplicate\nname"})
            ]
        );
        assert!(system.contains("Skill Always:\nALWAYS_INSTRUCTIONS\n"));
        assert!(system.contains("Legacy (id ") && system.contains("):\nLEGACY_INSTRUCTIONS\n"));
        assert_eq!(
            cycle[0]["messages"][1]["content"],
            "Explicit selected instructions"
        );
        assert!(cycle[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "read_skill_file"));
        assert!(
            cycle[2]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("WORKSPACE_TAIL")
        );
        assert!(
            cycle[3]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("ACCOUNT_INSTRUCTIONS")
        );
        assert!(
            cycle[4]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("ACCOUNT_TAIL")
        );
    }
    server.abort();
}
