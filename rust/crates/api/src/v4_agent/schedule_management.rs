#[cfg(all(test, unix))]
mod tests {
    use super::super::{
        interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction},
        new_session,
    };
    use crate::workspace_tasks::{create_owner_schedule, ScheduleInput, TaskInput};
    use async_trait::async_trait;
    use serde_json::json;
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

    struct CancellingGate(Cancellation);
    #[async_trait]
    impl Interaction for CancellingGate {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            self.0.cancel();
            Ok(true)
        }
    }

    #[test]
    fn read_only_children_cannot_request_schedule_management() {
        assert!(!super::super::ToolPolicy::ReadOnlyChild.allows("manage_schedule"));
    }

    #[tokio::test]
    async fn approved_management_is_reviewed_and_denial_preserves_saved_schedule() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let session = new_session("openai-api", "fixture", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let schedule = create_owner_schedule(
            data.path().into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Review this project".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some(session.id.clone()),
                    parent_task_id: None,
                },
                name: "Review".into(),
                interval_seconds: 60,
                enabled: true,
                at: None,
                run_once_at: None,
                deliver_to: None,
            },
        )
        .await
        .unwrap();
        let input = json!({"scheduleId":schedule.id,"action":"pause"});
        let denied = Gate {
            approved: false,
            requests: Mutex::new(vec![]),
        };
        assert!(super::execute(
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &input,
            &denied,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert!(
            crate::workspace_tasks::read_owner_schedules(data.path().into(), "owner".into())
                .await
                .unwrap()[0]
                .enabled
        );
        let mut foreign = scope.clone();
        foreign.owner = "another-owner".into();
        assert!(super::execute(
            data.path(),
            "owner",
            &session,
            &foreign,
            "call",
            &input,
            &denied,
            &Cancellation::default()
        )
        .await
        .is_err());
        let mut forged = input.clone();
        forged["workspacePath"] = json!("/another-workspace");
        assert!(super::execute(
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &forged,
            &denied,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert_eq!(denied.requests.lock().unwrap().len(), 1);
        let cancelled = Cancellation::default();
        assert!(super::execute(
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &input,
            &CancellingGate(cancelled.clone()),
            &cancelled
        )
        .await
        .is_err());
        assert!(
            crate::workspace_tasks::read_owner_schedules(data.path().into(), "owner".into())
                .await
                .unwrap()[0]
                .enabled
        );
        let approved = Gate {
            approved: true,
            requests: Mutex::new(vec![]),
        };
        let output = super::execute(
            data.path(),
            "owner",
            &session,
            &scope,
            "call",
            &input,
            &approved,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            output,
            json!({"action":"pause","scheduleId":schedule.id,"enabled":false,"nextRunAt":null})
        );
        let requests = approved.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].scope, scope);
        assert_eq!(requests[0].tool_call_id, "call");
        assert_eq!(requests[0].tool_input["schedule"]["id"], json!(schedule.id));
        assert_eq!(requests[0].tool_input["action"], "pause");
        assert!(!output.to_string().contains("Review this project"));
        drop(requests);
        let run = json!({"scheduleId":schedule.id,"action":"run"});
        let result: serde_json::Value = serde_json::from_str(
            &super::execute(
                data.path(),
                "owner",
                &session,
                &scope,
                "run",
                &run,
                &approved,
                &Cancellation::default(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["taskStatus"], "queued");
        assert!(result["taskId"].as_str().is_some());
        assert!(!result.to_string().contains("Review this project"));
        let remove = json!({"scheduleId":schedule.id,"action":"remove"});
        let removed: serde_json::Value = serde_json::from_str(
            &super::execute(
                data.path(),
                "owner",
                &session,
                &scope,
                "remove",
                &remove,
                &approved,
                &Cancellation::default(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            removed,
            json!({"action":"remove","scheduleId":schedule.id,"removed":true})
        );
        let path = std::fs::read_dir(data.path().join("workspace-tasks"))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "json"))
            .unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(stored["tasks"][0]["id"], result["taskId"]);
        assert_eq!(stored["tasks"][0]["status"], "queued");
    }

    #[tokio::test]
    async fn editing_prompt_and_timing_requires_review_and_commits_the_reviewed_record() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let session = new_session("openai-api", "fixture", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let schedule = create_owner_schedule(
            data.path().into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Old prompt".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some(session.id.clone()),
                    parent_task_id: None,
                },
                name: "Review".into(),
                interval_seconds: 60,
                enabled: true,
                at: None,
                run_once_at: None,
                deliver_to: None,
            },
        )
        .await
        .unwrap();
        let input = json!({"scheduleId":schedule.id,"action":"edit","changes":{"prompt":"New prompt", "timing":{"kind":"interval","intervalSeconds":120}}});
        let denied = Gate {
            approved: false,
            requests: Mutex::new(vec![]),
        };
        assert!(super::execute(
            data.path(),
            "owner",
            &session,
            &scope,
            "edit-denied",
            &input,
            &denied,
            &Cancellation::default()
        )
        .await
        .is_err());
        let original =
            crate::workspace_tasks::read_owner_schedules(data.path().into(), "owner".into())
                .await
                .unwrap();
        assert_eq!(original[0].input.prompt, "Old prompt");
        assert_eq!(original[0].interval_seconds, 60);
        let approved = Gate {
            approved: true,
            requests: Mutex::new(vec![]),
        };
        let result: serde_json::Value = serde_json::from_str(
            &super::execute(
                data.path(),
                "owner",
                &session,
                &scope,
                "edit-approved",
                &input,
                &approved,
                &Cancellation::default(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        let requests = approved.requests.lock().unwrap();
        let proposed = &requests[0].tool_input["proposed"];
        assert_eq!(requests[0].scope, scope);
        assert_eq!(requests[0].tool_call_id, "edit-approved");
        assert_eq!(proposed["prompt"], "New prompt");
        assert_eq!(proposed["intervalSeconds"], 120);
        let saved =
            crate::workspace_tasks::read_owner_schedules(data.path().into(), "owner".into())
                .await
                .unwrap();
        assert_eq!(serde_json::to_value(&saved[0]).unwrap(), *proposed);
        assert_eq!(result["action"], "edit");
        assert_eq!(result["nextRunAt"], proposed["nextRunAt"]);
        assert!(!result.to_string().contains("Old prompt"));
    }

    #[tokio::test]
    async fn provider_can_request_reviewed_pause_without_receiving_the_saved_prompt() {
        use axum::{routing::post, Json};
        use serde_json::Value;
        use std::sync::Arc;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("openai-api", "fixture", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let saved = create_owner_schedule(
            data.path().into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Private scheduled instructions".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some(session.id.clone()),
                    parent_task_id: None,
                },
                name: "Fixture".into(),
                interval_seconds: 60,
                enabled: true,
                at: None,
                run_once_at: None,
                deliver_to: None,
            },
        )
        .await
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let arguments = json!({"scheduleId":saved.id,"action":"pause"}).to_string();
        let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone(); let arguments = arguments.clone();
            async move {
                let mut requests = captured.lock().unwrap(); requests.push(body);
                Json(if requests.len() == 1 { json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"manage","type":"function","function":{"name":"manage_schedule","arguments":arguments}}]}}]}) }
                else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Paused"}}]}) })
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
            "Pause the schedule",
            None,
            &context,
            &mut integrations,
        )
        .await
        .unwrap();
        assert_eq!(answer, "Paused");
        let requests = requests.lock().unwrap();
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "manage_schedule"));
        let result: Value = serde_json::from_str(
            requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result,
            json!({"action":"pause","scheduleId":saved.id,"enabled":false,"nextRunAt":null})
        );
        assert!(!result
            .to_string()
            .contains("Private scheduled instructions"));
        assert_eq!(
            gate.requests.lock().unwrap()[0].tool_input["schedule"]["prompt"],
            "Private scheduled instructions"
        );
        assert!(
            !crate::workspace_tasks::read_owner_schedules(data.path().into(), "owner".into())
                .await
                .unwrap()[0]
                .enabled
        );
        server.abort();
    }

    #[tokio::test]
    async fn provider_can_request_an_edit_without_receiving_the_old_prompt() {
        use axum::{routing::post, Json};
        use serde_json::Value;
        use std::sync::Arc;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("openai-api", "fixture", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let saved = create_owner_schedule(
            data.path().into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Private old instructions".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some(session.id.clone()),
                    parent_task_id: None,
                },
                name: "Fixture".into(),
                interval_seconds: 60,
                enabled: false,
                at: None,
                run_once_at: None,
                deliver_to: None,
            },
        )
        .await
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let arguments = json!({"scheduleId":saved.id,"action":"edit","changes":{"prompt":"New instructions","timing":{"kind":"interval","intervalSeconds":120}}}).to_string();
        let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone(); let arguments = arguments.clone();
            async move {
                let mut requests = captured.lock().unwrap(); requests.push(body);
                Json(if requests.len() == 1 { json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"edit","type":"function","function":{"name":"manage_schedule","arguments":arguments}}]}}]}) }
                else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Updated"}}]}) })
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
        assert_eq!(
            super::super::turn_with_interaction(
                &provider,
                data.path(),
                "owner",
                &mut session,
                "Edit the schedule",
                None,
                &context,
                &mut integrations
            )
            .await
            .unwrap(),
            "Updated"
        );
        let requests = requests.lock().unwrap();
        let result: Value = serde_json::from_str(
            requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result,
            json!({"action":"edit","scheduleId":saved.id,"enabled":false,"nextRunAt":null})
        );
        assert!(!result.to_string().contains("Private old instructions"));
        let approval = gate.requests.lock().unwrap();
        assert_eq!(
            approval[0].tool_input["schedule"]["prompt"],
            "Private old instructions"
        );
        assert_eq!(
            approval[0].tool_input["proposed"]["prompt"],
            "New instructions"
        );
        let stored =
            crate::workspace_tasks::read_owner_schedules(data.path().into(), "owner".into())
                .await
                .unwrap();
        assert_eq!(
            (stored[0].input.prompt.as_str(), stored[0].interval_seconds),
            ("New instructions", 120)
        );
        server.abort();
    }
}
use super::{
    interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction},
    Session,
};
use crate::workspace_tasks::{self, ScheduleChange, ScheduleEdit};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn definition() -> Value {
    json!({"name":"manage_schedule","description":"Request review to pause, resume, run now, remove, or edit the prompt or timing of a schedule created by this conversation in its current workspace. For edit, provide changes.prompt and/or changes.timing. Timing uses kind interval with intervalSeconds, once with runOnceAt (Unix milliseconds), or calendar with at. Existing tasks are not changed. Available on Unix.","parameters":{"type":"object","properties":{"scheduleId":{"type":"string","description":"Schedule ID returned by list_schedules."},"action":{"type":"string","enum":["pause","resume","run","remove","edit"]},"changes":{"type":"object","properties":{"prompt":{"type":"string"},"timing":{"type":"object","properties":{"kind":{"type":"string","enum":["interval","once","calendar"]},"intervalSeconds":{"type":"integer"},"runOnceAt":{"type":"integer"},"at":{"type":"object","properties":{"hour":{"type":"integer"},"minute":{"type":"integer"},"weekdays":{"type":"array","items":{"type":"integer"}},"utcOffsetMinutes":{"type":"integer"},"timeZone":{"type":"string"}},"required":["hour","minute","weekdays"],"additionalProperties":false}},"required":["kind"],"additionalProperties":false}},"additionalProperties":false}},"required":["scheduleId","action"],"additionalProperties":false}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
    schedule_id: uuid::Uuid,
    action: ScheduleChange,
    changes: Option<ScheduleEdit>,
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
    if owner.trim().is_empty()
        || scope.owner != owner
        || scope.turn_id.trim().is_empty()
        || (scope.session_id != session.id
            && crate::structured::engine_session_id(&scope.session_id)
                .ok()
                .as_deref()
                != Some(session.id.as_str()))
    {
        return Err("Schedule scope does not match this conversation".into());
    }
    let args: Arguments = serde_json::from_value(input.clone())
        .map_err(|_| "Invalid schedule management arguments")?;
    cancellation.check()?;
    let reviewed = match (args.action, args.changes) {
        (ScheduleChange::Edit, Some(changes)) => {
            workspace_tasks::prepare_reviewed_schedule_edit(
                data.to_path_buf(),
                owner.into(),
                scope.session_id.clone(),
                scope.turn_id.clone(),
                session.workspace.clone(),
                args.schedule_id,
                changes,
            )
            .await?
        }
        (ScheduleChange::Edit, None) => return Err("Schedule edit requires changes".into()),
        (_, Some(_)) => return Err("Changes are only valid for schedule edits".into()),
        (action, None) => {
            workspace_tasks::prepare_reviewed_schedule_change(
                data.to_path_buf(),
                owner.into(),
                scope.session_id.clone(),
                scope.turn_id.clone(),
                session.workspace.clone(),
                args.schedule_id,
                action,
            )
            .await?
        }
    };
    cancellation.check()?;
    let details = serde_json::to_value(&reviewed).map_err(|_| "Cannot encode schedule review")?;
    let expires_at = super::interaction::now_ms() + 300_000;
    let description = format!("Review this schedule action. Running starts an unattended task; removing or editing the schedule does not cancel or change existing tasks. Resuming calculates the next run at commit; an edited timing uses the displayed next run.\nExact schedule and action (times are Unix milliseconds):\n{}", serde_json::to_string_pretty(&details).map_err(|_| "Cannot encode schedule review")?);
    let approved = cancellation
        .run(interaction.approve(ApprovalRequest {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.clone(),
            tool_call_id: call_id.into(),
            tool_name: "manage_schedule".into(),
            tool_input: details,
            description,
            expires_at,
        }))
        .await?;
    if !approved {
        return Err("Schedule action was not approved; nothing was changed".into());
    }
    let cancel = cancellation.clone();
    let saved = workspace_tasks::commit_reviewed_schedule_change(reviewed, expires_at, move || {
        cancel.is_cancelled()
    })
    .await?;
    let action = serde_json::to_value(args.action).map_err(|_| "Cannot encode schedule action")?;
    let mut result = json!({"action":action,"scheduleId":args.schedule_id});
    if let Some(schedule) = saved.get("schedule") {
        result["enabled"] = schedule["enabled"].clone();
        result["nextRunAt"] = schedule["nextRunAt"].clone();
    }
    if let Some(task) = saved.get("task") {
        result["taskId"] = task["id"].clone();
        result["taskStatus"] = task["status"].clone();
    }
    if saved.get("removed").and_then(Value::as_bool) == Some(true) {
        result["removed"] = json!(true);
    }
    serde_json::to_string(&result)
        .map_err(|_| "Schedule action was saved but its result could not be encoded".into())
}
