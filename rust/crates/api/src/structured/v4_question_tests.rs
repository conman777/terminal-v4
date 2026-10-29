use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

pub(crate) async fn interactive_fixture(
    manager: &StructuredSessionManager,
    id: &str,
    turn_id: &str,
) -> Arc<dyn Interaction> {
    let session = manager.owned_session("owner", id).await.unwrap().unwrap();
    let sink = Arc::new(StructuredEventSink {
        manager: manager.clone(),
        owner: "owner".into(),
        session_id: id.into(),
        generation: 7,
        pending: Mutex::new(Default::default()),
    });
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: id.into(),
        turn_id: turn_id.into(),
    };
    let controller = Arc::new(V4StructuredController::new(
        scope,
        sink.clone(),
        Arc::new(TurnResources::default()),
    ));
    {
        let mut state = session.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    Arc::new(V4StructuredInteraction { sink, controller })
}

#[tokio::test]
async fn questions_are_owner_scoped_and_retries_require_identical_answers() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let sink = Arc::new(StructuredEventSink {
        manager: manager.clone(),
        owner: "owner".into(),
        session_id: id.clone(),
        generation: 7,
        pending: Mutex::new(Default::default()),
    });
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: id.clone(),
        turn_id: Uuid::new_v4().to_string(),
    };
    let controller = Arc::new(V4StructuredController::new(
        scope.clone(),
        sink.clone(),
        Arc::new(TurnResources::default()),
    ));
    {
        let mut state = session.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    let (_, mut events) = manager.subscribe("owner", &id).await.unwrap();
    let approval_id = Uuid::new_v4().to_string();
    let request = ApprovalRequest {
        id: approval_id.clone(),
        scope,
        tool_call_id: "provider-call".into(),
        tool_name: "ask_user".into(),
        tool_input: json!({"questions":[{"id":"choice","question":"Which device?"}]}),
        description: "Question".into(),
        expires_at: crate::v4_agent::interaction::now_ms() + 30_000,
    };
    let waiting_controller = controller.clone();
    let waiting = tokio::spawn(async move {
        waiting_controller
            .gate
            .wait_question(
                request,
                waiting_controller.sink.as_ref(),
                &waiting_controller.cancel,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    let answer = json!({"choice":["Phone"]});
    assert!(manager
        .approve_bound("other", &id, Some(&approval_id), true, Some(answer.clone()))
        .await
        .is_err());
    assert!(manager
        .approve_bound("owner", &id, Some(&approval_id), true, Some(json!({})))
        .await
        .is_err());
    assert!(manager
        .approve_bound("owner", &id, Some(&approval_id), true, None)
        .await
        .is_err());
    assert_eq!(
        manager
            .approve_bound("owner", &id, Some(&approval_id), true, Some(answer.clone()))
            .await
            .unwrap()
            .status,
        "accepted"
    );
    assert_eq!(waiting.await.unwrap().unwrap(), Some(answer.clone()));
    assert!(manager
        .approve_bound("owner", &id, Some(&approval_id), true, None)
        .await
        .is_err());
    assert_eq!(
        manager
            .approve_bound("owner", &id, Some(&approval_id), true, Some(answer))
            .await
            .unwrap()
            .status,
        "already_decided"
    );
    assert!(manager
        .approve_bound(
            "owner",
            &id,
            Some(&approval_id),
            true,
            Some(json!({"choice":["Desktop"]}))
        )
        .await
        .is_err());
    let snapshot = manager.get_session("owner", &id).await.unwrap().unwrap();
    assert_eq!(snapshot.events.iter().filter(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id: event_id, .. } if event_id == &approval_id)).count(), 1);
}

#[tokio::test]
async fn authenticated_question_route_accepts_answers_only_for_the_owner() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "fixture-only".into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let app = crate::app(state);
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let sink = Arc::new(StructuredEventSink {
        manager: manager.clone(),
        owner: "owner".into(),
        session_id: id.clone(),
        generation: 7,
        pending: Mutex::new(Default::default()),
    });
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: id.clone(),
        turn_id: Uuid::new_v4().to_string(),
    };
    let controller = Arc::new(V4StructuredController::new(
        scope.clone(),
        sink,
        Arc::new(TurnResources::default()),
    ));
    {
        let mut state = session.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    let (_, mut events) = manager.subscribe("owner", &id).await.unwrap();
    let approval_id = Uuid::new_v4().to_string();
    let request = ApprovalRequest {
        id: approval_id.clone(),
        scope,
        tool_call_id: "tool".into(),
        tool_name: "ask_user".into(),
        tool_input: json!({"questions":[{"id":"choice","question":"Which device?"}]}),
        description: "Question".into(),
        expires_at: crate::v4_agent::interaction::now_ms() + 30_000,
    };
    let waiting_controller = controller.clone();
    let waiting = tokio::spawn(async move {
        waiting_controller
            .gate
            .wait_question(
                request,
                waiting_controller.sink.as_ref(),
                &waiting_controller.cancel,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    let post = |owner: &str, answer: Value| {
        let token = crate::auth::issue_access_token("fixture-only", owner, owner);
        Request::builder()
            .method("POST")
            .uri(format!("/api/structured/sessions/{id}/approve"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(Body::from(
                json!({"approvalId":approval_id,"approved":true,"answers":answer}).to_string(),
            ))
            .unwrap()
    };
    let answer = json!({"choice":["Phone"]});
    assert_eq!(
        app.clone()
            .oneshot(post("other", answer.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.clone()
            .oneshot(post("owner", json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let response = app
        .clone()
        .oneshot(post("owner", answer.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["status"], "accepted");
    assert_eq!(waiting.await.unwrap().unwrap(), Some(answer.clone()));
    let retry = app.clone().oneshot(post("owner", answer)).await.unwrap();
    assert_eq!(retry.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&retry.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["status"], "already_decided");
    assert_eq!(
        app.oneshot(post("owner", json!({"choice":["Desktop"]})))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn restart_resolves_pending_question_and_rejects_late_answers() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let sink = Arc::new(StructuredEventSink {
        manager: manager.clone(),
        owner: "owner".into(),
        session_id: id.clone(),
        generation: 7,
        pending: Mutex::new(Default::default()),
    });
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: id.clone(),
        turn_id: Uuid::new_v4().to_string(),
    };
    let controller = Arc::new(V4StructuredController::new(
        scope.clone(),
        sink,
        Arc::new(TurnResources::default()),
    ));
    {
        let mut state = session.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    let (_, mut events) = manager.subscribe("owner", &id).await.unwrap();
    let approval_id = Uuid::new_v4().to_string();
    let request = ApprovalRequest {
        id: approval_id.clone(),
        scope,
        tool_call_id: "tool".into(),
        tool_name: "ask_user".into(),
        tool_input: json!({"questions":[{"id":"choice","question":"Which device?"}]}),
        description: "Question".into(),
        expires_at: crate::v4_agent::interaction::now_ms() + 30_000,
    };
    let waiting_controller = controller.clone();
    let waiting = tokio::spawn(async move {
        waiting_controller
            .gate
            .wait_question(
                request,
                waiting_controller.sink.as_ref(),
                &waiting_controller.cancel,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    waiting.abort();
    let _ = waiting.await;
    let restarted = StructuredSessionManager::new(config);
    let snapshot = restarted.get_session("owner", &id).await.unwrap().unwrap();
    assert!(snapshot.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id: event_id, approved:false, reason:Some(reason), .. } if event_id == &approval_id && reason == "Session restarted")));
    assert!(restarted
        .approve_bound(
            "owner",
            &id,
            Some(&approval_id),
            true,
            Some(json!({"choice":["Phone"]}))
        )
        .await
        .is_err());
}

#[tokio::test]
async fn paired_approval_expiry_is_rechecked_after_event_session_lock() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let held = session.state.lock().await;
    let (entered, wait_entered) = tokio::sync::oneshot::channel();
    *manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let expires = crate::v4_agent::interaction::now_ms() + 400;
    let approval_id = Uuid::new_v4().to_string();
    let event = StructuredSessionEvent::ApprovalResolved {
        ts: crate::v4_agent::interaction::now_ms(),
        seq: 0,
        approval_id: approval_id.clone(),
        turn_id: "turn".into(),
        approved: true,
        reason: None,
    };
    let task = tokio::spawn({
        let manager = manager.clone();
        let id = id.clone();
        async move {
            manager
                .record_event_generation_with_expiry("owner", &id, None, event, Some(expires))
                .await
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), wait_entered)
        .await
        .unwrap()
        .unwrap();
    while crate::v4_agent::interaction::now_ms() < expires {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    drop(held);
    assert!(task.await.unwrap().is_err());
    let state = session.state.lock().await;
    assert!(!state.events.iter().any(|event| matches!(event, StructuredSessionEvent::ApprovalResolved { approval_id: id, .. } if id == &approval_id)));
}

#[cfg(unix)]
#[tokio::test]
async fn valid_paired_v4_approval_resolves_the_exact_pending_action() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "paired-v4-approval".into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let state = crate::state::AppState::new_with_services(config, None, manager.clone()).unwrap();
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let turn = Uuid::new_v4().to_string();
    let interaction = interactive_fixture(&manager, &id, &turn).await;
    let (_, mut events) = manager.subscribe("owner", &id).await.unwrap();
    let approval_id = Uuid::new_v4().to_string();
    let request = ApprovalRequest {
        id: approval_id.clone(),
        scope: ActionScope {
            owner: "owner".into(),
            session_id: id.clone(),
            turn_id: turn,
        },
        tool_call_id: "synthetic".into(),
        tool_name: "run_command".into(),
        tool_input: json!({"command":"fixture"}),
        description: "synthetic".into(),
        expires_at: crate::v4_agent::interaction::now_ms() + 30_000,
    };
    let waiting = tokio::spawn(async move { interaction.approve(request).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/structured/sessions/{id}/approve"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"approvalId":approval_id, "approved":true}).to_string(),
        ))
        .unwrap();
    let response = crate::app(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(waiting.await.unwrap().unwrap());
}
