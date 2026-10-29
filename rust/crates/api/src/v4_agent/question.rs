use super::interaction::{now_ms, ActionScope, ApprovalRequest, Cancellation, Interaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    questions: Vec<Question>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    id: String,
    question: String,
    header: Option<String>,
    options: Option<Vec<OptionItem>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionItem {
    label: String,
    description: Option<String>,
}

fn text_valid(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= max
        && !text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}

fn parse(input: &Value) -> Result<Arguments, String> {
    let args: Arguments =
        serde_json::from_value(input.clone()).map_err(|_| "Invalid question arguments")?;
    if args.questions.is_empty() || args.questions.len() > 4 {
        return Err("Ask one to four questions".into());
    }
    let mut ids = HashSet::new();
    for question in &args.questions {
        if !text_valid(&question.id, 64)
            || !question
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
            || !ids.insert(question.id.as_str())
            || !text_valid(&question.question, 1000)
            || question
                .header
                .as_deref()
                .is_some_and(|s| !text_valid(s, 80))
        {
            return Err("Invalid question text or duplicate ID".into());
        }
        if let Some(options) = &question.options {
            if options.len() < 2 || options.len() > 6 {
                return Err("Provide two to six choices or none".into());
            }
            let mut labels = HashSet::new();
            for option in options {
                if !text_valid(&option.label, 100)
                    || !labels.insert(option.label.as_str())
                    || option
                        .description
                        .as_deref()
                        .is_some_and(|s| !text_valid(s, 300))
                {
                    return Err("Invalid or duplicate question choices".into());
                }
            }
        }
    }
    Ok(args)
}

pub(super) fn validate_questions(input: &Value) -> Result<(), String> {
    parse(input).map(|_| ())
}

pub(super) fn validate_answers(input: &Value, answers: &Value) -> Result<(), String> {
    let questions = parse(input)?.questions;
    let answers = answers.as_object().ok_or("Answers must be an object")?;
    if answers.len() != questions.len() {
        return Err("Answer every question exactly once".into());
    }
    for question in questions {
        let values = answers
            .get(&question.id)
            .and_then(Value::as_array)
            .ok_or("Answer every question exactly once")?;
        if values.len() != 1 || !values[0].as_str().is_some_and(|s| text_valid(s, 4000)) {
            return Err("Each answer must be one non-empty text value".into());
        }
    }
    Ok(())
}

pub(super) fn definition() -> Value {
    json!({"name":"ask_user","description":"Ask one to four clarifying questions in an interactive conversation. The user can choose an option or enter free text; do not request passwords or secrets. Unattended runs cannot answer.","parameters":{"type":"object","properties":{"questions":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9_.-]{1,64}$"},"question":{"type":"string"},"header":{"type":"string"},"options":{"type":"array","minItems":2,"maxItems":6,"items":{"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label"],"additionalProperties":false}}},"required":["id","question"],"additionalProperties":false}}},"required":["questions"],"additionalProperties":false}})
}

pub(super) async fn execute(
    input: &Value,
    scope: &ActionScope,
    call_id: &str,
    interaction: &dyn Interaction,
    cancel: &Cancellation,
) -> Result<String, String> {
    validate_questions(input)?;
    cancel.check()?;
    let answer = interaction
        .question(ApprovalRequest {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.clone(),
            tool_call_id: call_id.into(),
            tool_name: "ask_user".into(),
            tool_input: input.clone(),
            description: "The agent has a question for you.".into(),
            expires_at: now_ms() + 300_000,
        })
        .await?;
    cancel.check()?;
    match answer {
        Some(answers) => {
            validate_answers(input, &answers)?;
            serde_json::to_string(&json!({"answers":answers}))
                .map_err(|_| "Cannot encode answers".into())
        }
        None => Ok(json!({"status":"dismissed"}).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};
    use terminal_v4_core::StructuredSessionEvent;

    fn questions() -> Value {
        json!({"questions":[{"id":"target","header":"Target","question":"Which device?","options":[{"label":"Phone"},{"label":"Desktop"}]}]})
    }
    struct Respond {
        requests: Mutex<Vec<ApprovalRequest>>,
    }
    #[async_trait]
    impl Interaction for Respond {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
            Err("Unexpected approval".into())
        }
        async fn question(&self, request: ApprovalRequest) -> Result<Option<Value>, String> {
            self.requests.lock().unwrap().push(request);
            Ok(Some(json!({"target":["Phone"]})))
        }
    }
    #[test]
    fn rejects_ambiguous_questions_and_incomplete_or_extraneous_answers() {
        assert!(validate_questions(&questions()).is_ok());
        assert!(validate_questions(
            &json!({"questions":[{"id":"x","question":"One?"},{"id":"x","question":"Two?"}]})
        )
        .is_err());
        assert!(validate_questions(
            &json!({"questions":[{"id":"x","question":"One?","isSecret":true}]})
        )
        .is_err());
        assert!(
            validate_questions(&json!({"questions":[{"id":"bad id","question":"One?"}]})).is_err()
        );
        assert!(validate_answers(&questions(), &json!({})).is_err());
        assert!(
            validate_answers(&questions(), &json!({"target":["Phone"],"extra":["x"]})).is_err()
        );
        assert!(validate_answers(&questions(), &json!({"target":["Phone","Desktop"]})).is_err());
        assert!(validate_answers(&questions(), &json!({"target":["Other choice"]})).is_ok());
        assert!(validate_answers(&questions(), &json!({"target":["é".repeat(4000)]})).is_ok());
    }
    #[tokio::test]
    async fn unanswered_unattended_question_fails_without_waiting() {
        let cli = super::super::interaction::CliInteraction {
            session_id: "fixture".into(),
            interactive: false,
        };
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: "session".into(),
            turn_id: "turn".into(),
        };
        assert!(
            execute(&questions(), &scope, "call", &cli, &Cancellation::default())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn provider_receives_the_correlated_user_answer_in_its_tool_result() {
        use axum::{routing::post, Json};
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(if requests.len() == 1 {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"provider-question","type":"function","function":{"name":"ask_user","arguments":questions().to_string()}}]}}]})
                } else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Phone selected"}}]}) })
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
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let responder = Respond {
            requests: Mutex::new(vec![]),
        };
        let context = super::super::TurnContext {
            scope: scope.clone(),
            cancellation: Cancellation::default(),
            interaction: &responder,
            resources: Arc::new(Default::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: super::super::ToolPolicy::Standard,
        };
        let mut integrations = super::super::integrations::Integrations::default();
        let result = super::super::turn_with_interaction(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Ask me",
            None,
            &context,
            &mut integrations,
        )
        .await
        .unwrap();
        assert_eq!(result, "Phone selected");
        let requests = requests.lock().unwrap();
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "ask_user"));
        let tool = requests[1]["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(tool["tool_call_id"], "provider-question");
        assert_eq!(
            serde_json::from_str::<Value>(tool["content"].as_str().unwrap()).unwrap(),
            json!({"answers":{"target":["Phone"]}})
        );
        let asked = responder.requests.lock().unwrap();
        assert_eq!(
            (asked[0].scope.clone(), &asked[0].tool_input),
            (scope, &questions())
        );
        server.abort();
    }

    #[tokio::test]
    async fn provider_question_round_trips_through_the_authenticated_structured_route() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
            routing::post,
            Json,
        };
        use tower::ServiceExt;
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                Json(if requests.len() == 1 {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"provider-question","type":"function","function":{"name":"ask_user","arguments":questions().to_string()}}]}}]})
                } else { json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Phone selected"}}]}) })
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
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "fixture-only".into(),
            ..Default::default()
        };
        let manager = crate::structured::StructuredSessionManager::new(config.clone());
        let app = crate::app(
            crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap(),
        );
        let id = manager
            .create_session(
                "owner",
                root.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap()
            .id;
        let turn_id = uuid::Uuid::new_v4().to_string();
        let interaction =
            crate::structured::v4_question_tests::interactive_fixture(&manager, &id, &turn_id)
                .await;
        let (_, mut events) = manager.subscribe("owner", &id).await.unwrap();
        let mut session = super::super::new_session("openai-api", "gpt-4.1", &root);
        session.id = crate::structured::engine_session_id(&id).unwrap();
        let context = super::super::TurnContext {
            scope: ActionScope {
                owner: "owner".into(),
                session_id: id.clone(),
                turn_id,
            },
            cancellation: Cancellation::default(),
            interaction: interaction.as_ref(),
            resources: Arc::new(Default::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: super::super::ToolPolicy::Standard,
        };
        let mut integrations = super::super::integrations::Integrations::default();
        let run = super::super::turn_with_interaction(
            &provider,
            data.path(),
            "owner",
            &mut session,
            "Ask me",
            None,
            &context,
            &mut integrations,
        );
        let answer = async {
            let approval_id = loop {
                let event = tokio::time::timeout(std::time::Duration::from_secs(3), events.recv())
                    .await
                    .unwrap()
                    .unwrap();
                if let StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(id),
                    tool_name,
                    tool_input,
                    ..
                } = event
                {
                    assert_eq!(tool_name, "ask_user");
                    assert_eq!(tool_input, questions());
                    break id;
                }
            };
            let token = crate::auth::issue_access_token("fixture-only", "owner", "owner");
            let response = app.oneshot(Request::builder().method("POST").uri(format!("/api/structured/sessions/{id}/approve"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(json!({"approvalId":approval_id,"approved":true,"answers":{"target":["Phone"]}}).to_string())).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        };
        let (result, ()) = tokio::join!(run, answer);
        assert_eq!(result.unwrap(), "Phone selected");
        let requests = requests.lock().unwrap();
        let tool = requests[1]["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(tool["tool_call_id"], "provider-question");
        assert_eq!(
            serde_json::from_str::<Value>(tool["content"].as_str().unwrap()).unwrap(),
            json!({"answers":{"target":["Phone"]}})
        );
        server.abort();
    }
}
