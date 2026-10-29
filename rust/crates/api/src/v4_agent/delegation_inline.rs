use super::{
    integrations::Integrations,
    interaction::{self, ActionScope, ApprovalRequest, Cancellation, Interaction, TurnResources},
    Provider, Session, ToolPolicy, TurnContext,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};
use terminal_v4_core::StructuredSessionEvent;

pub(super) fn definition() -> Value {
    json!({"name":"delegate_task", "description":"Run one approved read-only investigation in a separate context and wait for its result.", "parameters":{"type":"object", "properties":{"prompt":{"type":"string"}}, "required":["prompt"], "additionalProperties":false}})
}
pub(super) fn parallel_definition() -> Value {
    json!({"name":"delegate_tasks", "description":"Run two to four approved read-only investigations concurrently in separate contexts and wait for their results.", "parameters":{"type":"object", "properties":{"prompts":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":4}}, "required":["prompts"], "additionalProperties":false}})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    prompt: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParallelInput {
    prompts: Vec<String>,
}

struct WorkspaceGuard {
    path: PathBuf,
    directory: File,
}
impl WorkspaceGuard {
    fn open(path: &Path) -> Result<Self, String> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let directory = options.open(path).map_err(|_| "Workspace unavailable")?;
        let guard = Self {
            path: path.to_owned(),
            directory,
        };
        guard.check()?;
        Ok(guard)
    }
    fn check(&self) -> Result<(), String> {
        let opened = self
            .directory
            .metadata()
            .map_err(|_| "Workspace unavailable")?;
        let current = std::fs::symlink_metadata(&self.path).map_err(|_| "Workspace unavailable")?;
        if !opened.is_dir()
            || !current.is_dir()
            || current.file_type().is_symlink()
            || self.path.canonicalize().ok().as_deref() != Some(self.path.as_path())
        {
            return Err("Workspace scope changed".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if (opened.dev(), opened.ino()) != (current.dev(), current.ino()) {
                return Err("Workspace scope changed".into());
            }
        }
        Ok(())
    }
    fn duplicate(&self) -> Result<Self, String> {
        Ok(Self {
            path: self.path.clone(),
            directory: self
                .directory
                .try_clone()
                .map_err(|_| "Workspace unavailable")?,
        })
    }
}

fn check_scope(
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    call_id: &str,
) -> Result<(), String> {
    let bound_session = scope.session_id == session.id
        || crate::structured::engine_session_id(&scope.session_id)
            .ok()
            .as_deref()
            == Some(session.id.as_str());
    if owner.trim().is_empty()
        || scope.owner != owner
        || !bound_session
        || scope.turn_id.trim().is_empty()
        || call_id.trim().is_empty()
    {
        return Err("Delegation scope does not match this conversation".into());
    }
    Ok(())
}
struct ChildInteraction {
    workspace: WorkspaceGuard,
}
#[async_trait]
impl Interaction for ChildInteraction {
    async fn emit(&self, _event: StructuredSessionEvent) -> Result<(), String> {
        self.workspace.check()
    }
    async fn approve(&self, _request: ApprovalRequest) -> Result<bool, String> {
        Ok(false)
    }
}

pub(super) async fn execute(
    provider: &Provider,
    data: &Path,
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    call_id: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancel: &Cancellation,
    resources: Arc<TurnResources>,
    integrations: &mut Integrations,
) -> Result<String, String> {
    check_scope(owner, session, scope, call_id)?;
    let input: Input =
        serde_json::from_value(input.clone()).map_err(|_| "Invalid delegation arguments")?;
    if input.prompt.trim().is_empty()
        || input.prompt.chars().count() > 32_000
        || input.prompt.contains('\0')
    {
        return Err("Invalid delegation prompt".into());
    }
    let workspace = Path::new(&session.workspace)
        .canonicalize()
        .map_err(|_| "Workspace unavailable")?;
    if workspace != Path::new(&session.workspace) || !workspace.is_dir() {
        return Err("Workspace scope changed".into());
    }
    let workspace_guard = WorkspaceGuard::open(&workspace)?;
    let expires_at = interaction::now_ms() + 300_000;
    let details = json!({"prompt":input.prompt,"workspace":session.workspace,"provider":session.provider,"model":session.model,"permission":"read_only","execution":"foreground"});
    let approved = cancel.run(interaction.approve(ApprovalRequest {
        id:uuid::Uuid::new_v4().to_string(), scope:scope.clone(), tool_call_id:call_id.into(),
        tool_name:"delegate_task".into(), tool_input:details.clone(),
        description:format!("Run a read-only investigation in a separate context and wait for its result. File writes, shell commands and external tools are unavailable. Provider requests use the selected model.\n\n{}", serde_json::to_string_pretty(&details).map_err(|_| "Cannot encode delegation review")?), expires_at,
    })).await?;
    if !approved {
        return Err("Delegation was not approved".into());
    }
    cancel.check()?;
    if interaction::now_ms() >= expires_at {
        return Err("Delegation approval expired".into());
    }
    workspace_guard.check()?;
    let mut child = super::new_session(&session.provider, &session.model, &workspace);
    let child_sink = ChildInteraction {
        workspace: workspace_guard,
    };
    let child_context = TurnContext {
        scope: ActionScope {
            owner: owner.into(),
            session_id: format!("ss-{}", child.id),
            turn_id: uuid::Uuid::new_v4().to_string(),
        },
        cancellation: cancel.clone(),
        interaction: &child_sink,
        resources,
        attachments: &[],
        local_authority: None,
        tool_policy: ToolPolicy::ReadOnlyChild,
    };
    let prompt = format!("You are a read-only delegated investigator. Investigate the task without making changes, running commands, or invoking external tools. Report evidence and uncertainty to the parent.\n\nTask:\n{}", input.prompt);
    let answer = Box::pin(super::turn_with_interaction(
        provider,
        data,
        owner,
        &mut child,
        &prompt,
        None,
        &child_context,
        integrations,
    ))
    .await?;
    cancel.check()?;
    let mut end = answer.len().min(48_000);
    while !answer.is_char_boundary(end) {
        end -= 1;
    }
    Ok(json!({"status":"completed","childSessionId":child.id,"result":&answer[..end],"truncated":end < answer.len()}).to_string())
}

pub(super) async fn execute_parallel(
    provider: &Provider,
    data: &Path,
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    call_id: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancel: &Cancellation,
    resources: Arc<TurnResources>,
) -> Result<String, String> {
    check_scope(owner, session, scope, call_id)?;
    let input: ParallelInput =
        serde_json::from_value(input.clone()).map_err(|_| "Invalid delegation arguments")?;
    if !(2..=4).contains(&input.prompts.len())
        || input.prompts.iter().any(|prompt| {
            prompt.trim().is_empty() || prompt.chars().count() > 32_000 || prompt.contains('\0')
        })
    {
        return Err("Invalid delegation prompts".into());
    }
    let workspace = Path::new(&session.workspace)
        .canonicalize()
        .map_err(|_| "Workspace unavailable")?;
    if workspace != Path::new(&session.workspace) || !workspace.is_dir() {
        return Err("Workspace scope changed".into());
    }
    let workspace_guard = WorkspaceGuard::open(&workspace)?;
    let expires_at = interaction::now_ms() + 300_000;
    let details = json!({"prompts":input.prompts,"workspace":session.workspace,"provider":session.provider,"model":session.model,"permission":"read_only","execution":"parallel_foreground"});
    let approved = cancel.run(interaction.approve(ApprovalRequest {
        id: uuid::Uuid::new_v4().to_string(), scope: scope.clone(), tool_call_id: call_id.into(), tool_name: "delegate_tasks".into(), tool_input: details.clone(),
        description: format!("Run these read-only investigations concurrently in separate contexts and wait for their results. File writes, shell commands and external tools are unavailable. Each child makes provider requests using the selected model.\n\n{}", serde_json::to_string_pretty(&details).map_err(|_| "Cannot encode delegation review")?), expires_at,
    })).await?;
    if !approved {
        return Err("Delegation was not approved".into());
    }
    cancel.check()?;
    if interaction::now_ms() >= expires_at {
        return Err("Delegation approval expired".into());
    }
    workspace_guard.check()?;
    let guards = (0..input.prompts.len())
        .map(|_| workspace_guard.duplicate())
        .collect::<Result<Vec<_>, _>>()?;
    let jobs = input.prompts.into_iter().zip(guards).map(|(prompt, guard)| {
        let resources = resources.clone();
        let workspace = &workspace;
        async move {
            let mut child = super::new_session(&session.provider, &session.model, workspace);
            let child_sink = ChildInteraction { workspace: guard };
            let child_context = TurnContext {
                scope: ActionScope { owner: owner.into(), session_id: format!("ss-{}", child.id), turn_id: uuid::Uuid::new_v4().to_string() },
                cancellation: cancel.clone(), interaction: &child_sink, resources, attachments: &[], local_authority: None, tool_policy: ToolPolicy::ReadOnlyChild,
            };
            let prompt = format!("You are a read-only delegated investigator. Investigate the task without making changes, running commands, or invoking external tools. Report evidence and uncertainty to the parent.\n\nTask:\n{prompt}");
            let mut integrations = Integrations::default();
            match Box::pin(super::turn_with_interaction(provider, data, owner, &mut child, &prompt, None, &child_context, &mut integrations)).await {
                Ok(answer) => {
                    let mut end = answer.len().min(24_000);
                    while !answer.is_char_boundary(end) { end -= 1; }
                    json!({"status":"completed","childSessionId":child.id,"result":&answer[..end],"truncated":end < answer.len()})
                }
                Err(error) => json!({"status":"failed","childSessionId":child.id,"error":error.chars().take(1000).collect::<String>()}),
            }
        }
    });
    let results = futures_util::future::join_all(jobs).await;
    cancel.check()?;
    Ok(json!({"results":results}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::{extract::State, routing::post, Json, Router};
    use std::sync::Mutex;
    use terminal_v4_core::StructuredSessionEvent;

    struct Approval {
        allow: bool,
        requests: Mutex<Vec<super::super::interaction::ApprovalRequest>>,
    }
    #[async_trait]
    impl Interaction for Approval {
        async fn emit(&self, _event: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(
            &self,
            request: super::super::interaction::ApprovalRequest,
        ) -> Result<bool, String> {
            self.requests.lock().unwrap().push(request);
            Ok(self.allow)
        }
    }
    fn fixture_provider(url: String) -> Provider {
        Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url,
            secret: "fixture".into(),
            client: reqwest::Client::new(),
        }
    }
    #[tokio::test]
    async fn approved_parallel_children_run_together_in_separate_read_only_contexts() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let router = Router::new().route("/chat", post({
            let barrier = barrier.clone();
            let seen = seen.clone();
            move |Json(request): Json<Value>| {
                let barrier = barrier.clone();
                let seen = seen.clone();
                async move {
                    let prompt = request["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_owned();
                    seen.lock().unwrap().push(request);
                    barrier.wait().await;
                    let answer = if prompt.contains("Inspect alpha") { "alpha result" } else { "beta result" };
                    Json(json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":answer}}]}))
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: "turn".into(),
        };
        let approval = Approval {
            allow: true,
            requests: Mutex::new(vec![]),
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            execute_parallel(
                &fixture_provider(format!("http://{address}/chat")),
                data.path(),
                "owner",
                &session,
                &scope,
                "call",
                &json!({"prompts":["Inspect alpha", "Inspect beta"]}),
                &approval,
                &Cancellation::default(),
                Arc::new(TurnResources::default()),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            result["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["result"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["alpha result", "beta result"]
        );
        assert_ne!(
            result["results"][0]["childSessionId"],
            result["results"][1]["childSessionId"]
        );
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            assert!(request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|tool| tool["function"]["name"] != "write_file"
                    && tool["function"]["name"] != "delegate_tasks"));
        }
        let reviews = approval.requests.lock().unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(
            reviews[0].tool_input["prompts"],
            json!(["Inspect alpha", "Inspect beta"])
        );
        assert_eq!(reviews[0].tool_input["permission"], "read_only");
        server.abort();
    }
    #[tokio::test]
    async fn parallel_delegation_rejects_invalid_or_denied_requests_before_provider_access() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: "turn".into(),
        };
        let approval = Approval {
            allow: false,
            requests: Mutex::new(vec![]),
        };
        let provider = fixture_provider("http://127.0.0.1:1/chat".into());
        for input in [
            json!({}),
            json!({"prompts":["one"]}),
            json!({"prompts":["one",""]}),
            json!({"prompts":["a","b","c","d","e"]}),
            json!({"prompts":["a","b"],"workspace":"/other"}),
        ] {
            assert!(execute_parallel(
                &provider,
                data.path(),
                "owner",
                &session,
                &scope,
                "call",
                &input,
                &approval,
                &Cancellation::default(),
                Arc::new(TurnResources::default())
            )
            .await
            .is_err());
        }
        assert!(approval.requests.lock().unwrap().is_empty());
        let error = execute_parallel(
            &provider,
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &json!({"prompts":["one","two"]}),
            &approval,
            &Cancellation::default(),
            Arc::new(TurnResources::default()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("not approved"));
        assert_eq!(approval.requests.lock().unwrap().len(), 1);
        let error = execute_parallel(
            &provider,
            data.path(),
            "foreign",
            &session,
            &scope,
            "call",
            &json!({"prompts":["one","two"]}),
            &approval,
            &Cancellation::default(),
            Arc::new(TurnResources::default()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("scope"));
        assert_eq!(approval.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn parallel_delegation_keeps_success_when_one_child_fails() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let router = Router::new().route("/chat", post(|Json(request): Json<Value>| async move {
            let prompt = request["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap();
            if prompt.contains("broken") {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"fixture failure"})))
            } else {
                (axum::http::StatusCode::OK, Json(json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"useful result"}}]})))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: "turn".into(),
        };
        let approval = Approval {
            allow: true,
            requests: Mutex::new(vec![]),
        };
        let result = execute_parallel(
            &fixture_provider(format!("http://{address}/chat")),
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &json!({"prompts":["working","broken"]}),
            &approval,
            &Cancellation::default(),
            Arc::new(TurnResources::default()),
        )
        .await
        .unwrap();
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["results"][0]["status"], "completed");
        assert_eq!(result["results"][0]["result"], "useful result");
        assert_eq!(result["results"][1]["status"], "failed");
        assert!(result["results"][1]["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()));
        server.abort();
    }

    #[tokio::test]
    async fn cancelling_parent_stops_waiting_for_parallel_children() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let router = Router::new().route(
            "/chat",
            post({
                let barrier = barrier.clone();
                move || {
                    let barrier = barrier.clone();
                    async move {
                        barrier.wait().await;
                        std::future::pending::<Json<Value>>().await
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let cancel = Cancellation::default();
        let task = tokio::spawn({
            let cancel = cancel.clone();
            async move {
                let session = super::super::new_session(
                    "deepseek",
                    "deepseek-chat",
                    &workspace.path().canonicalize().unwrap(),
                );
                let scope = ActionScope {
                    owner: "owner".into(),
                    session_id: format!("ss-{}", session.id),
                    turn_id: "turn".into(),
                };
                let approval = Approval {
                    allow: true,
                    requests: Mutex::new(vec![]),
                };
                execute_parallel(
                    &fixture_provider(format!("http://{address}/chat")),
                    data.path(),
                    "owner",
                    &session,
                    &scope,
                    "call",
                    &json!({"prompts":["one","two"]}),
                    &approval,
                    &cancel,
                    Arc::new(TurnResources::default()),
                )
                .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), barrier.wait())
            .await
            .unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parent_provider_receives_all_parallel_child_outcomes() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let router = Router::new().route("/chat", post({
            let seen = seen.clone();
            let barrier = barrier.clone();
            move |Json(request): Json<Value>| {
                let seen = seen.clone();
                let barrier = barrier.clone();
                async move {
                    let last = request["messages"].as_array().unwrap().last().unwrap();
                    let role = last["role"].as_str().unwrap().to_owned();
                    let content = last["content"].as_str().unwrap_or("").to_owned();
                    seen.lock().unwrap().push(request);
                    if role == "tool" {
                        Json(json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"parent received results"}}]}))
                    } else if content.contains("read-only delegated investigator") {
                        barrier.wait().await;
                        let result = if content.contains("alpha") { "alpha found" } else { "beta found" };
                        Json(json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":result}}]}))
                    } else {
                        Json(json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"parallel","type":"function","function":{"name":"delegate_tasks","arguments":"{\"prompts\":[\"alpha\",\"beta\"]}"}}]}}]}))
                    }
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let approval = Approval {
            allow: true,
            requests: Mutex::new(vec![]),
        };
        let context = TurnContext {
            scope: ActionScope {
                owner: "owner".into(),
                session_id: format!("ss-{}", session.id),
                turn_id: uuid::Uuid::new_v4().to_string(),
            },
            cancellation: Cancellation::default(),
            interaction: &approval,
            resources: Arc::new(TurnResources::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: ToolPolicy::Standard,
        };
        let answer = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            super::super::turn_with_interaction(
                &fixture_provider(format!("http://{address}/chat")),
                data.path(),
                "owner",
                &mut session,
                "Investigate project",
                None,
                &context,
                &mut Integrations::default(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(answer, "parent received results");
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "delegate_tasks"));
        let result = requests.last().unwrap()["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(
            result.contains("alpha found") && result.contains("beta found"),
            "{result}"
        );
        server.abort();
    }
    #[tokio::test]
    async fn approved_child_has_separate_context_and_cannot_write() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("notes"), "observed facts").unwrap();
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        async fn respond(
            State(seen): State<Arc<Mutex<Vec<Value>>>>,
            Json(request): Json<Value>,
        ) -> Json<Value> {
            let mut seen = seen.lock().unwrap();
            seen.push(request);
            Json(if seen.len() == 1 {
                json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes\"}"}},{"id":"write","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"notes\",\"content\":\"changed\"}"}}]}}]})
            } else {
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Investigation complete"}}]})
            })
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/chat", post(respond))
            .with_state(seen.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let provider = fixture_provider(format!("http://{address}/chat"));
        let session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: "parent-turn".into(),
        };
        let approval = Approval {
            allow: true,
            requests: Mutex::new(vec![]),
        };
        let result = execute(
            &provider,
            data.path(),
            "owner",
            &session,
            &scope,
            "tool-call",
            &json!({"prompt":"Investigate notes"}),
            &approval,
            &Cancellation::default(),
            Arc::new(TurnResources::default()),
            &mut Integrations::default(),
        )
        .await
        .unwrap();
        assert!(result.contains("Investigation complete"));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("notes")).unwrap(),
            "observed facts"
        );
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let advertised = requests[0]["tools"].as_array().unwrap();
        assert!(advertised
            .iter()
            .any(|tool| tool["function"]["name"] == "read_file"));
        assert!(!advertised
            .iter()
            .any(|tool| tool["function"]["name"] == "write_file"
                || tool["function"]["name"] == "delegate_task"));
        assert!(requests[1]
            .to_string()
            .contains("Tool denied by read-only child policy"));
        let reviews = approval.requests.lock().unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].scope, scope);
        assert_eq!(reviews[0].tool_call_id, "tool-call");
        assert_eq!(
            reviews[0].tool_input,
            json!({"prompt":"Investigate notes", "workspace":session.workspace, "provider":"deepseek", "model":"deepseek-chat", "permission":"read_only", "execution":"foreground"})
        );
        server.abort();
    }
    #[tokio::test]
    async fn denied_or_mismatched_scope_never_calls_provider() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: "turn".into(),
        };
        let approval = Approval {
            allow: false,
            requests: Mutex::new(vec![]),
        };
        let provider = fixture_provider("http://127.0.0.1:1/chat".into());
        let run = |scope: ActionScope| {
            let provider = &provider;
            let data = data.path();
            let session = &session;
            let approval = &approval;
            async move {
                execute(
                    provider,
                    data,
                    "owner",
                    session,
                    &scope,
                    "call",
                    &json!({"prompt":"Investigate"}),
                    approval,
                    &Cancellation::default(),
                    Arc::new(TurnResources::default()),
                    &mut Integrations::default(),
                )
                .await
            }
        };
        assert!(run(scope.clone())
            .await
            .unwrap_err()
            .contains("not approved"));
        assert!(run(ActionScope {
            owner: "foreign".into(),
            ..scope
        })
        .await
        .is_err());
        assert_eq!(approval.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn malformed_arguments_are_rejected_before_approval() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "deepseek-chat",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let approval = Approval {
            allow: true,
            requests: Mutex::new(vec![]),
        };
        let provider = fixture_provider("http://127.0.0.1:1/chat".into());
        for input in [
            json!({}),
            json!({"prompt":""}),
            json!({"prompt":"x","workspace":"/other"}),
            json!({"prompt":"x\0y"}),
            json!({"prompt":"x".repeat(32_001)}),
        ] {
            assert!(execute(
                &provider,
                data.path(),
                "owner",
                &session,
                &scope,
                "call",
                &input,
                &approval,
                &Cancellation::default(),
                Arc::new(TurnResources::default()),
                &mut Integrations::default()
            )
            .await
            .is_err());
        }
        assert!(approval.requests.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_replacement_during_approval_is_rejected() {
        struct ReplaceDirectory {
            path: std::path::PathBuf,
        }
        #[async_trait]
        impl Interaction for ReplaceDirectory {
            async fn emit(&self, _event: StructuredSessionEvent) -> Result<(), String> {
                Ok(())
            }
            async fn approve(
                &self,
                _request: super::super::interaction::ApprovalRequest,
            ) -> Result<bool, String> {
                std::fs::rename(&self.path, self.path.with_extension("original")).unwrap();
                std::fs::create_dir(&self.path).unwrap();
                Ok(true)
            }
        }
        let data = tempfile::tempdir().unwrap();
        let container = tempfile::tempdir().unwrap();
        let workspace = container.path().canonicalize().unwrap().join("project");
        std::fs::create_dir(&workspace).unwrap();
        let session = super::super::new_session("deepseek", "deepseek-chat", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session.id),
            turn_id: "turn".into(),
        };
        let result = execute(
            &fixture_provider("http://127.0.0.1:1/chat".into()),
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &json!({"prompt":"Investigate"}),
            &ReplaceDirectory { path: workspace },
            &Cancellation::default(),
            Arc::new(TurnResources::default()),
            &mut Integrations::default(),
        )
        .await;
        assert!(result.unwrap_err().contains("Workspace scope changed"));
    }

    #[tokio::test]
    async fn cancelling_parent_stops_waiting_for_child_provider() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let router = Router::new().route(
            "/chat",
            post({
                let entered = entered.clone();
                move || {
                    let entered = entered.clone();
                    async move {
                        entered.notify_one();
                        std::future::pending::<Json<Value>>().await
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let cancel = Cancellation::default();
        let task = tokio::spawn({
            let cancel = cancel.clone();
            async move {
                let session = super::super::new_session(
                    "deepseek",
                    "deepseek-chat",
                    &workspace.path().canonicalize().unwrap(),
                );
                let scope = ActionScope {
                    owner: "owner".into(),
                    session_id: format!("ss-{}", session.id),
                    turn_id: "turn".into(),
                };
                let approval = Approval {
                    allow: true,
                    requests: Mutex::new(vec![]),
                };
                execute(
                    &fixture_provider(format!("http://{address}/chat")),
                    data.path(),
                    "owner",
                    &session,
                    &scope,
                    "call",
                    &json!({"prompt":"Investigate"}),
                    &approval,
                    &cancel,
                    Arc::new(TurnResources::default()),
                    &mut Integrations::default(),
                )
                .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parent_tool_cycle_receives_the_read_only_child_result() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        std::fs::write(root.join("notes"), "fixture facts").unwrap();
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        async fn respond(
            State(seen): State<Arc<Mutex<Vec<Value>>>>,
            Json(request): Json<Value>,
        ) -> Json<Value> {
            let mut seen = seen.lock().unwrap();
            seen.push(request);
            Json(match seen.len() {
                1 => {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"delegate","type":"function","function":{"name":"delegate_task","arguments":"{\"prompt\":\"Read the notes\"}"}}]}}]})
                }
                2 => {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes\"}"}}]}}]})
                }
                3 => {
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"child found fixture facts"}}]})
                }
                _ => {
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"parent reports the facts"}}]})
                }
            })
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/chat", post(respond))
            .with_state(seen.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let provider = fixture_provider(format!("http://{address}/chat"));
        let mut session = super::super::new_session("deepseek", "deepseek-chat", &root);
        let approval = Approval {
            allow: true,
            requests: Mutex::new(vec![]),
        };
        let context = TurnContext {
            scope: ActionScope {
                owner: "owner".into(),
                session_id: format!("ss-{}", session.id),
                turn_id: uuid::Uuid::new_v4().to_string(),
            },
            cancellation: Cancellation::default(),
            interaction: &approval,
            resources: Arc::new(TurnResources::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: ToolPolicy::Standard,
        };
        let result = super::super::turn_with_interaction(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Investigate the project",
            None,
            &context,
            &mut Integrations::default(),
        )
        .await
        .unwrap();
        assert_eq!(result, "parent reports the facts");
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "delegate_task"));
        assert!(!requests[1]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "delegate_task"));
        assert!(requests[2].to_string().contains("fixture facts"));
        assert!(requests[3]
            .to_string()
            .contains("child found fixture facts"));
        assert_eq!(approval.requests.lock().unwrap().len(), 1);
        server.abort();
    }
}
