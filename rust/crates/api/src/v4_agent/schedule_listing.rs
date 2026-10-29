use super::{
    interaction::{ActionScope, Cancellation},
    Session,
};
use crate::{session_search::safe_history_text, workspace_tasks::ScheduleRecord};
use serde_json::{json, Value};
use std::future::Future;

const PROMPT_LIMIT: usize = 2_000;
const SCHEDULE_LIMIT: usize = 20;

pub(super) fn definition() -> Value {
    json!({"name":"list_schedules","description":"List the schedules created from this conversation in its current workspace. Unix only; storage can be temporarily busy. Times are Unix milliseconds; prompt excerpts may be redacted or truncated.","parameters":{"type":"object","properties":{},"additionalProperties":false}})
}

/// `read` must use the authenticated owner's task store and return a bounded
/// snapshot without changing it. It must not rely on model-provided paths;
/// cancellation may drop the future while a blocking read is still running.
pub(super) async fn execute<F, Fut>(
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    input: &Value,
    cancellation: &Cancellation,
    read: F,
) -> Result<String, String>
where
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<Vec<ScheduleRecord>, String>>,
{
    if owner.trim().is_empty()
        || scope.owner != owner
        || scope.turn_id.trim().is_empty()
        || !std::path::Path::new(&session.workspace).is_absolute()
        || (scope.session_id != session.id
            && crate::structured::engine_session_id(&scope.session_id)
                .ok()
                .as_deref()
                != Some(session.id.as_str()))
    {
        return Err("Schedule scope does not match this conversation".into());
    }
    if !input.as_object().is_some_and(|object| object.is_empty()) {
        return Err("List schedules accepts no arguments".into());
    }
    cancellation.check()?;
    let records = cancellation
        .run(read(owner.to_owned(), session.workspace.clone()))
        .await?;
    cancellation.check()?;
    if records.len() > SCHEDULE_LIMIT {
        return Err("Saved schedule storage exceeds its limit".into());
    }
    let schedules: Vec<_> = records
        .into_iter()
        .filter(|record| {
            record.input.workspace_path == session.workspace
                && record.input.parent_session_id.as_deref() == Some(scope.session_id.as_str())
        })
        .map(|record| {
            if record.name.chars().count() > 80
                || record.name.chars().any(char::is_control)
                || record.input.prompt.chars().count() > 32_000
                || record.input.provider.chars().count() > 200
                || record.input.provider.chars().any(char::is_control)
                || record.input.model.as_ref().is_some_and(|model| {
                    model.chars().count() > 200 || model.chars().any(char::is_control)
                })
                || record.last_error.as_ref().is_some_and(|error| error.chars().count() > 500)
                || record.skill.as_ref().is_some_and(|skill| {
                    skill.name.chars().count() > 200 || skill.skill_ref.chars().count() > 200
                })
                || record.at.as_ref().is_some_and(|at| {
                    at.cron.as_ref().is_some_and(|cron| cron.chars().count() > 256 || cron.chars().any(char::is_control))
                        || at.weekdays.len() > 7
                        || at.time_zone.as_ref().is_some_and(|zone| {
                            zone.chars().count() > 200 || zone.chars().any(char::is_control)
                        })
                })
            {
                return Err("Saved schedule contains invalid fields".to_string());
            }
            let prompt = safe_history_text(&record.input.prompt);
            let truncated = prompt.chars().count() > PROMPT_LIMIT;
            let redacted = prompt != record.input.prompt;
            let at = record.at.map(|mut at| {
                at.time_zone = at.time_zone.map(|zone| safe_history_text(&zone));
                at
            });
            Ok(json!({
                "id": record.id,
                "name": safe_history_text(&record.name),
                "prompt": prompt.chars().take(PROMPT_LIMIT).collect::<String>(),
                "promptTruncated": truncated,
                "promptRedacted": redacted,
                "provider": safe_history_text(&record.input.provider),
                "model": record.input.model.map(|model| safe_history_text(&model)),
                "enabled": record.enabled,
                "intervalSeconds": record.interval_seconds,
                "at": at,
                "runOnceAt": record.run_once_at,
                "nextRunAt": record.next_run_at,
                "lastRunAt": record.last_run_at,
                "missedRuns": record.missed_runs,
                "lastMissedAt": record.last_missed_at,
                "lastStatus": record.last_status,
                "lastError": record.last_error.map(|error| safe_history_text(&error)),
                "skill": record.skill.map(|skill| json!({"skillRef": skill.skill_ref, "name": safe_history_text(&skill.name), "revision": skill.revision})),
                "lastTaskId": record.last_task_id,
                "createdAt": record.created_at,
            }))
        })
        .collect::<Result<_, String>>()?;
    serde_json::to_string(&json!({"schedules":schedules}))
        .map_err(|_| "Cannot encode schedule list".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_tasks::{CalendarTime, TaskInput};

    fn record(session: &str, workspace: &str, name: &str) -> ScheduleRecord {
        ScheduleRecord {
            id: uuid::Uuid::new_v4(),
            name: name.into(),
            input: TaskInput {
                workspace_path: workspace.into(),
                provider: "openai-api".into(),
                prompt: "Review the project".into(),
                model: Some("fixture".into()),
                parent_session_id: Some(session.into()),
                parent_task_id: None,
            },
            interval_seconds: 60,
            at: None,
            run_once_at: None,
            enabled: true,
            next_run_at: Some(123),
            last_run_at: None,
            last_task_id: None,
            created_at: 1,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
            deliver_to: None,
        }
    }

    fn fixture(workspace: &std::path::Path) -> (Session, ActionScope) {
        let session = super::super::new_session("openai-api", "fixture", workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!(
                "ss-{}",
                uuid::Uuid::parse_str(&session.id).unwrap().simple()
            ),
            turn_id: "turn".into(),
        };
        (session, scope)
    }

    #[tokio::test]
    async fn lists_only_current_session_and_workspace_with_redacted_bounded_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let (session, scope) = fixture(dir.path());
        let mut wanted = record(&scope.session_id, &session.workspace, "Current");
        wanted.input.prompt = format!("password=fixture-secret\n{}", "x".repeat(PROMPT_LIMIT + 1));
        wanted.at = Some(CalendarTime {
            hour: 4,
            minute: 30,
            weekdays: vec![1],
            utc_offset_minutes: 0,
            time_zone: Some("UTC".into()),
            cron: None,
        });
        let mut no_parent = record(&scope.session_id, &session.workspace, "No parent");
        no_parent.input.parent_session_id = None;
        let records = vec![
            wanted,
            record("ss-other", &session.workspace, "Other session"),
            record(
                &format!("ss-{}", session.id),
                &session.workspace,
                "Other spelling",
            ),
            record(&scope.session_id, "/another/workspace", "Other workspace"),
            no_parent,
        ];
        let expected_workspace = session.workspace.clone();
        let json = execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &Cancellation::default(),
            |owner, workspace| async move {
                assert_eq!((owner, workspace), ("owner".into(), expected_workspace));
                Ok(records)
            },
        )
        .await
        .unwrap();
        let result: Value = serde_json::from_str(&json).unwrap();
        let schedules = result["schedules"].as_array().unwrap();
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0]["name"], "Current");
        assert_eq!(schedules[0]["at"]["timeZone"], "UTC");
        assert_eq!(schedules[0]["promptTruncated"], true);
        assert_eq!(schedules[0]["promptRedacted"], true);
        assert_eq!(definition()["name"], "list_schedules");
        assert!(!json.contains("fixture-secret"));
        assert!(!json.contains("Other session"));
        assert!(!json.contains("Other spelling"));
    }

    #[tokio::test]
    async fn rejects_forged_scope_and_model_supplied_arguments_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let (session, scope) = fixture(dir.path());
        for (owner, candidate, input) in [
            ("other", scope.clone(), json!({})),
            (
                "owner",
                ActionScope {
                    session_id: "ss-forged".into(),
                    ..scope.clone()
                },
                json!({}),
            ),
            (
                "owner",
                ActionScope {
                    turn_id: "".into(),
                    ..scope.clone()
                },
                json!({}),
            ),
            ("owner", scope.clone(), json!({"workspace":"/other"})),
            ("owner", scope.clone(), json!(null)),
        ] {
            let result = execute(
                owner,
                &session,
                &candidate,
                &input,
                &Cancellation::default(),
                |_, _| async { panic!("invalid scope or arguments reached storage") },
            )
            .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn rejects_excess_records_and_honors_cancellation_after_read() {
        let dir = tempfile::tempdir().unwrap();
        let (session, scope) = fixture(dir.path());
        let records =
            vec![record(&scope.session_id, &session.workspace, "Current"); SCHEDULE_LIMIT + 1];
        assert!(execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &Cancellation::default(),
            |_, _| async { Ok(records) }
        )
        .await
        .is_err());
        let cancel = Cancellation::default();
        let copy = cancel.clone();
        assert!(execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &cancel,
            |_, _| async move {
                copy.cancel();
                Ok(vec![])
            }
        )
        .await
        .is_err());
        let invalid = record(&scope.session_id, &session.workspace, &"x".repeat(81));
        assert!(execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &Cancellation::default(),
            |_, _| async { Ok(vec![invalid]) }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn reports_unavailable_storage_and_does_not_read_when_already_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let (session, scope) = fixture(dir.path());
        let error = execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &Cancellation::default(),
            |_, _| async { Err("Saved task storage unavailable".to_string()) },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Saved task storage unavailable");
        let cancellation = Cancellation::default();
        cancellation.cancel();
        let error = execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &cancellation,
            |_, _| async { panic!("cancelled listing reached storage") },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Turn cancelled");
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_pending_read_only_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let (session, scope) = fixture(dir.path());
        let cancel = Cancellation::default();
        let task_cancel = cancel.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let mut task = tokio::spawn(async move {
            execute(
                "owner",
                &session,
                &scope,
                &json!({}),
                &task_cancel,
                |_, _| async move {
                    let _ = started.send(());
                    std::future::pending::<Result<Vec<ScheduleRecord>, String>>().await
                },
            )
            .await
        });
        ready.await.unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), &mut task).await;
        if result.is_err() {
            task.abort();
        }
        assert_eq!(
            result
                .expect("cancelled lookup did not stop")
                .unwrap()
                .unwrap_err(),
            "Turn cancelled"
        );
    }

    #[tokio::test]
    async fn projects_a_real_owner_scoped_store_snapshot() {
        use crate::{
            auth::AuthenticatedUser,
            state::AppState,
            workspace_tasks::{self, ScheduleInput},
        };
        use axum::{body::Body, http::Request, Extension};
        use http_body_util::BodyExt;
        use sha2::{Digest, Sha256};
        use tower::ServiceExt;

        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().canonicalize().unwrap();
        let data = workspace.join("data");
        let (session, scope) = fixture(&workspace);
        let make_input = |parent: &str, name: &str| ScheduleInput {
            task: record(parent, &session.workspace, name).input,
            name: name.into(),
            interval_seconds: 60,
            enabled: false,
            at: None,
            run_once_at: None,
            deliver_to: None,
        };
        workspace_tasks::create_owner_schedule(
            data.clone(),
            "owner".into(),
            make_input(&scope.session_id, "Own schedule"),
        )
        .await
        .unwrap();
        workspace_tasks::create_owner_schedule(
            data.clone(),
            "owner".into(),
            make_input("ss-other", "Other session"),
        )
        .await
        .unwrap();
        workspace_tasks::create_owner_schedule(
            data.clone(),
            "foreign".into(),
            make_input(&scope.session_id, "Foreign owner"),
        )
        .await
        .unwrap();
        let file = data
            .join("workspace-tasks")
            .join(format!("{}.json", hex::encode(Sha256::digest(b"owner"))));
        let before = std::fs::read(&file).unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data,
            ..Default::default()
        })
        .unwrap();
        let router = workspace_tasks::routes()
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state);
        // The HTTP adapter is a test fixture only: its legacy migration behavior
        // means it is not the read-only service required for production wiring.
        let output = execute(
            "owner",
            &session,
            &scope,
            &json!({}),
            &Cancellation::default(),
            |owner, _| async move {
                assert_eq!(owner, "owner");
                let response = router
                    .oneshot(
                        Request::get("/api/workspace/tasks")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    return Err("Fixture list failed".into());
                }
                let bytes = response
                    .into_body()
                    .collect()
                    .await
                    .map_err(|e| e.to_string())?
                    .to_bytes();
                let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                serde_json::from_value(value["schedules"].clone()).map_err(|e| e.to_string())
            },
        )
        .await
        .unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["schedules"].as_array().unwrap().len(), 1);
        assert_eq!(value["schedules"][0]["name"], "Own schedule");
        assert!(!output.contains("Foreign owner"));
        assert!(!output.contains("Other session"));
        assert_eq!(std::fs::read(&file).unwrap(), before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_turn_lists_its_own_schedules_without_changing_task_storage() {
        use crate::workspace_tasks::{self, ScheduleInput};
        use axum::{routing::post, Json};
        use std::sync::{Arc, Mutex};

        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut session = super::super::new_session("openai-api", "fixture-model", &root);
        let parent_id = format!(
            "ss-{}",
            uuid::Uuid::parse_str(&session.id).unwrap().simple()
        );
        let make_input = |parent: &str, name: &str| ScheduleInput {
            task: record(parent, &session.workspace, name).input,
            name: name.into(),
            interval_seconds: 60,
            enabled: false,
            at: None,
            run_once_at: None,
            deliver_to: None,
        };
        workspace_tasks::create_owner_schedule(
            data.path().into(),
            "owner".into(),
            make_input(&parent_id, "My schedule"),
        )
        .await
        .unwrap();
        workspace_tasks::create_owner_schedule(
            data.path().into(),
            "owner".into(),
            make_input("other-session", "Other schedule"),
        )
        .await
        .unwrap();
        let bytes_before = std::fs::read_dir(data.path().join("workspace-tasks"))
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .map(|entry| (entry.path(), std::fs::read(entry.path()).unwrap()))
            .unwrap();
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(if requests.len() == 1 {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"list","type":"function","function":{"name":"list_schedules","arguments":"{}"}}]}}]})
                } else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]}) })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let provider = super::super::Provider {
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{addr}/v1/chat/completions"),
            secret: "fixture".into(),
            client: reqwest::Client::new(),
        };
        let interaction = super::super::interaction::CliInteraction {
            session_id: parent_id.clone(),
            interactive: false,
        };
        let context = super::super::TurnContext {
            scope: ActionScope {
                owner: "owner".into(),
                session_id: parent_id,
                turn_id: uuid::Uuid::new_v4().to_string(),
            },
            cancellation: Cancellation::default(),
            interaction: &interaction,
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
                "List schedules",
                None,
                &context,
                &mut integrations
            )
            .await
            .unwrap(),
            "Done"
        );
        let requests = requests.lock().unwrap();
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "list_schedules"));
        let output = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap();
        let result: Value = serde_json::from_str(output).unwrap();
        assert_eq!(result["schedules"].as_array().unwrap().len(), 1);
        assert_eq!(result["schedules"][0]["name"], "My schedule");
        assert!(!output.contains("Other schedule"));
        assert_eq!(std::fs::read(bytes_before.0).unwrap(), bytes_before.1);
        server.abort();
    }

    #[tokio::test]
    async fn reports_last_outcome_cron_and_skill_fields() {
        let dir = tempfile::tempdir().unwrap();
        let (session, scope) = fixture(dir.path());
        let mut failed = record(&scope.session_id, &session.workspace, "Failed");
        failed.last_status = Some(crate::workspace_tasks::TaskStatus::Failed);
        failed.last_error = Some("agent exited".into());
        failed.skill = Some(crate::workspace_tasks::ScheduleSkill {
            skill_ref: "workspace:id".into(),
            name: "Triage".into(),
            revision: "a".repeat(64),
        });
        failed.at = Some(serde_json::from_value(json!({"cron":"*/5 * * * *"})).unwrap());
        failed.missed_runs = 2;
        failed.last_missed_at = Some(9);
        let fresh = record(&scope.session_id, &session.workspace, "Fresh");
        let records = vec![failed, fresh];
        let listed: Value = serde_json::from_str(
            &execute(
                "owner",
                &session,
                &scope,
                &json!({}),
                &Cancellation::default(),
                |_, _| async { Ok(records) },
            )
            .await
            .unwrap(),
        )
        .unwrap();
        let rows = listed["schedules"].as_array().unwrap();
        assert_eq!(
            (
                rows[0]["lastStatus"].clone(),
                rows[0]["lastError"].clone(),
                rows[0]["missedRuns"].clone(),
                rows[0]["lastMissedAt"].clone(),
                rows[0]["at"]["cron"].clone(),
                rows[0]["skill"]["name"].clone(),
                rows[1]["lastStatus"].clone(),
                rows[1]["lastError"].clone(),
                rows[1]["skill"].clone(),
            ),
            (
                json!("failed"),
                json!("agent exited"),
                json!(2),
                json!(9),
                json!("*/5 * * * *"),
                json!("Triage"),
                Value::Null,
                Value::Null,
                Value::Null,
            )
        );
    }
}
