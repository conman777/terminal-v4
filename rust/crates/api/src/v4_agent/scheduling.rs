use super::{
    interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction},
    Session,
};
use crate::workspace_tasks::{self, CalendarTime, ScheduleInput, TaskInput};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn definition() -> Value {
    json!({"name":"create_schedule","description":"Create an app-owned scheduled unattended task after explicit review. Supply intervalSeconds, at, or runOnceAt; calendar schedules may also include intervalSeconds. Times are Unix milliseconds. The workspace, owner, provider, model and parent session come from this conversation.","parameters":{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"enabled":{"type":"boolean"},"intervalSeconds":{"type":"integer"},"at":{"type":"object","properties":{"hour":{"type":"integer"},"minute":{"type":"integer"},"weekdays":{"type":"array","items":{"type":"integer"}},"utcOffsetMinutes":{"type":"integer"},"timeZone":{"type":"string"}},"required":["hour","minute","weekdays"],"additionalProperties":false},"runOnceAt":{"type":"integer"}},"required":["name","prompt","enabled"],"additionalProperties":false}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
    name: String,
    prompt: String,
    enabled: bool,
    interval_seconds: Option<u64>,
    at: Option<CalendarTime>,
    run_once_at: Option<u64>,
}

pub(super) async fn execute(
    data: &Path,
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    call_id: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancellation: &Cancellation,
) -> Result<String, String> {
    if scope.owner != owner
        || (scope.session_id != session.id
            && crate::structured::engine_session_id(&scope.session_id)
                .ok()
                .as_deref()
                != Some(session.id.as_str()))
        || scope.turn_id.is_empty()
    {
        return Err("Schedule scope does not match this conversation".into());
    }
    let args: Arguments =
        serde_json::from_value(input.clone()).map_err(|_| "Invalid schedule arguments")?;
    if (args.run_once_at.is_some() && (args.interval_seconds.is_some() || args.at.is_some()))
        || (args.run_once_at.is_none() && args.interval_seconds.is_none() && args.at.is_none())
    {
        return Err("Choose an interval or one-shot time, not both".into());
    }
    let schedule = ScheduleInput {
        task: TaskInput {
            workspace_path: session.workspace.clone(),
            provider: session.provider.clone(),
            prompt: args.prompt,
            model: Some(session.model.clone()),
            parent_session_id: Some(scope.session_id.clone()),
            parent_task_id: None,
        },
        name: args.name,
        interval_seconds: args
            .interval_seconds
            .unwrap_or(if args.at.is_some() { 60 } else { 0 }),
        enabled: args.enabled,
        at: args.at,
        run_once_at: args.run_once_at,
    };
    let reviewed = workspace_tasks::prepare_reviewed_schedule(
        data.to_path_buf(),
        owner.into(),
        scope.session_id.clone(),
        scope.turn_id.clone(),
        schedule,
    )
    .await
    .map_err(|e| e.message)?;
    cancellation.check()?;
    let expires_at = super::interaction::now_ms() + 300_000;
    let details = serde_json::to_value(&reviewed).map_err(|_| "Cannot encode schedule review")?;
    let first_run = details["schedule"]["nextRunAt"]
        .as_u64()
        .and_then(|millis| {
            time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()
        })
        .and_then(|instant| {
            instant
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| {
            details["schedule"]["nextRunAt"]
                .as_u64()
                .map(|millis| format!("{millis} milliseconds since the epoch"))
                .unwrap_or_else(|| "No first run while disabled".into())
        });
    let approved = cancellation.run(interaction.approve(ApprovalRequest {
        id: uuid::Uuid::new_v4().to_string(),
        scope: scope.clone(),
        tool_call_id: call_id.into(),
        tool_name: "create_schedule".into(),
        tool_input: details.clone(),
        description: format!("Create unattended app schedule for owner {owner}\nFirst run (UTC): {first_run}\nExact schedule (times are Unix milliseconds):\n{}", serde_json::to_string_pretty(&details).map_err(|_| "Cannot encode schedule review")?),
        expires_at,
    })).await?;
    if !approved {
        return Err("Schedule was not approved; nothing was saved".into());
    }
    let cancel = cancellation.clone();
    let saved = workspace_tasks::commit_reviewed_schedule(reviewed, expires_at, move || {
        cancel.is_cancelled()
    })
    .await
    .map_err(|e| e.message)?;
    serde_json::to_string(&saved)
        .map_err(|_| "Schedule was saved but its result could not be encoded".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use terminal_v4_core::StructuredSessionEvent;

    struct Gate {
        approved: bool,
        requests: Mutex<Vec<ApprovalRequest>>,
    }
    #[async_trait]
    impl Interaction for Gate {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
            self.requests.lock().unwrap().push(request);
            Ok(self.approved)
        }
    }
    fn input() -> Value {
        json!({"name":"Daily review","prompt":"Inspect the workspace","enabled":true,"intervalSeconds":60})
    }
    fn scope(session: &Session) -> ActionScope {
        ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        }
    }
    #[tokio::test]
    async fn reviewed_schedule_persists_the_exact_displayed_record_and_is_owner_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session("openai-api", "gpt-4.1", workspace.path());
        let gate = Gate {
            approved: true,
            requests: Mutex::new(vec![]),
        };
        let mut structured_scope = scope(&session);
        structured_scope.session_id = format!(
            "ss-{}",
            uuid::Uuid::parse_str(&session.id).unwrap().simple()
        );
        let result = execute(
            dir.path(),
            "owner",
            &session,
            &structured_scope,
            "call",
            &input(),
            &gate,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let saved: Value = serde_json::from_str(&result).unwrap();
        let requests = gate.requests.lock().unwrap();
        let review = &requests[0].tool_input;
        assert_eq!(review["schedule"], saved);
        assert_eq!(
            saved["nextRunAt"].as_u64().unwrap(),
            saved["createdAt"].as_u64().unwrap() + 60_000
        );
        assert_eq!(review["owner"], "owner");
        assert_eq!(review["sessionId"], structured_scope.session_id);
        assert_eq!(saved["parentSessionId"], structured_scope.session_id);
        let files: Vec<_> = std::fs::read_dir(dir.path().join("workspace-tasks"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        assert_eq!(files.len(), 1);
        let persisted: Value =
            serde_json::from_slice(&std::fs::read(files[0].path()).unwrap()).unwrap();
        assert_eq!(persisted["ownerId"], "owner");
        assert_eq!(persisted["schedules"], json!([saved]));
    }
    #[tokio::test]
    async fn denial_foreign_scope_and_unexpected_arguments_never_save() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session("openai-api", "gpt-4.1", workspace.path());
        let gate = Gate {
            approved: false,
            requests: Mutex::new(vec![]),
        };
        let cancel = Cancellation::default();
        assert!(execute(
            dir.path(),
            "owner",
            &session,
            &scope(&session),
            "call",
            &input(),
            &gate,
            &cancel
        )
        .await
        .is_err());
        let mut foreign = scope(&session);
        foreign.owner = "other".into();
        assert!(execute(
            dir.path(),
            "owner",
            &session,
            &foreign,
            "call",
            &input(),
            &gate,
            &cancel
        )
        .await
        .is_err());
        let mut forged = input();
        forged["workspacePath"] = json!("/foreign");
        assert!(execute(
            dir.path(),
            "owner",
            &session,
            &scope(&session),
            "call",
            &forged,
            &gate,
            &cancel
        )
        .await
        .is_err());
        assert_eq!(gate.requests.lock().unwrap().len(), 1);
        assert!(!dir.path().join("workspace-tasks").exists());
    }
    #[tokio::test]
    async fn one_shot_and_iana_calendar_review_the_same_first_run_that_is_saved() {
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session("openai-api", "gpt-4.1", workspace.path());
        let at = super::super::interaction::now_ms() as u64 + 120_000;
        for schedule in [
            json!({"name":"Once","prompt":"Inspect","enabled":true,"runOnceAt":at}),
            json!({"name":"Calendar","prompt":"Inspect","enabled":true,"at":{"hour":9,"minute":30,"weekdays":[1,2,3,4,5],"timeZone":"Africa/Johannesburg"}}),
        ] {
            let data = tempfile::tempdir().unwrap();
            let gate = Gate {
                approved: true,
                requests: Mutex::new(vec![]),
            };
            let result = execute(
                data.path(),
                "owner",
                &session,
                &scope(&session),
                "call",
                &schedule,
                &gate,
                &Cancellation::default(),
            )
            .await
            .unwrap();
            let saved: Value = serde_json::from_str(&result).unwrap();
            let requests = gate.requests.lock().unwrap();
            assert_eq!(requests[0].tool_input["schedule"], saved);
            assert!(requests[0].description.contains("First run (UTC): 20"));
            if schedule.get("runOnceAt").is_some() {
                assert_eq!(saved["nextRunAt"], at);
            } else {
                assert_eq!(saved["at"]["timeZone"], "Africa/Johannesburg");
            }
        }
    }
    #[tokio::test]
    async fn cancelled_and_unattended_requests_do_not_write() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session("openai-api", "gpt-4.1", workspace.path());
        let cancel = Cancellation::default();
        cancel.cancel();
        let gate = Gate {
            approved: true,
            requests: Mutex::new(vec![]),
        };
        assert!(execute(
            data.path(),
            "owner",
            &session,
            &scope(&session),
            "call",
            &input(),
            &gate,
            &cancel
        )
        .await
        .is_err());
        let unattended = super::super::interaction::CliInteraction {
            session_id: session.id.clone(),
            interactive: false,
        };
        assert!(execute(
            data.path(),
            "owner",
            &session,
            &scope(&session),
            "call",
            &input(),
            &unattended,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert!(!data.path().join("workspace-tasks").exists());
    }
    #[tokio::test]
    async fn provider_tool_cycle_requests_review_and_returns_the_persisted_schedule() {
        use axum::{routing::post, Json};
        use std::sync::Arc;
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(if requests.len() == 1 {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"schedule","type":"function","function":{"name":"create_schedule","arguments":input().to_string()}}]}}]})
                } else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Scheduled"}}]}) })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let provider = super::super::Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{addr}/v1/chat/completions"),
            secret: "fixture".into(),
            client: reqwest::Client::new(),
        };
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let mut session = super::super::new_session("openai-api", "gpt-4.1", &root);
        let mut scope = scope(&session);
        scope.session_id = format!(
            "ss-{}",
            uuid::Uuid::parse_str(&session.id).unwrap().simple()
        );
        let gate = Gate {
            approved: true,
            requests: Mutex::new(vec![]),
        };
        let context = super::super::TurnContext {
            scope,
            cancellation: Cancellation::default(),
            interaction: &gate,
            resources: Arc::new(Default::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: super::super::ToolPolicy::Standard,
        };
        let mut integrations = super::super::integrations::Integrations::default();
        let answer = super::super::turn_with_interaction(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Schedule a review",
            None,
            &context,
            &mut integrations,
        )
        .await
        .unwrap();
        assert_eq!(answer, "Scheduled");
        let requests = requests.lock().unwrap();
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "create_schedule"));
        let tool_result: Value = serde_json::from_str(
            requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            gate.requests.lock().unwrap()[0].tool_input["schedule"],
            tool_result
        );
        let saved = std::fs::read_dir(data.path().join("workspace-tasks"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let store: Value = serde_json::from_slice(&std::fs::read(saved).unwrap()).unwrap();
        assert_eq!(store["schedules"], json!([tool_result]));
        server.abort();
    }
}
