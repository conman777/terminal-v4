use super::*;
use crate::v4_agent::background_process::{
    tool::BackgroundActor, BackgroundProcesses, BackgroundRequest, BackgroundScope, BackgroundState,
};

const TEST_CALL: &str = "fixture-background-call";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_actor_status_and_cancel_revalidate_the_live_owner_after_logout() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 1; printf survived > marker".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    assert!(matches!(
        actor.status(&request.action_id).await.unwrap().state,
        crate::v4_agent::background_process::BackgroundState::Running
    ));
    fixture.app.logout_user("owner").unwrap();
    assert!(actor.status(&request.action_id).await.is_err());
    assert!(actor.cancel(&request.action_id).await.is_err());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !fixture._workspace.path().join("marker").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("revoked cancellation interrupted the process");
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_actor_wait_does_not_return_after_its_owner_logs_out() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 1".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    let waiter = actor.clone();
    let action_id = request.action_id.clone();
    let waiting = tokio::spawn(async move {
        waiter
            .wait(&action_id, std::time::Duration::from_secs(3))
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    fixture.app.logout_user("owner").unwrap();
    assert!(waiting.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_actor_cannot_read_or_cancel_after_session_identity_changes() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 1; printf survived > marker".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    fixture.live.state.lock().await.session_incarnation = Some(SessionIncarnation(Uuid::new_v4()));
    assert!(actor.status(&request.action_id).await.is_err());
    assert!(actor.cancel(&request.action_id).await.is_err());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !fixture._workspace.path().join("marker").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("stale-session cancellation interrupted the process");
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_actor_wait_stops_when_its_turn_is_cancelled() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 10".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    let waiter = actor.clone();
    let action_id = request.action_id.clone();
    let waiting = tokio::spawn(async move {
        waiter
            .wait(&action_id, std::time::Duration::from_secs(3))
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    fixture.controller.cancel.cancel();
    assert!(waiting.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

pub(super) async fn wait_background_approval(
    fixture: &Fixture,
    call_id: &str,
) -> StructuredSessionEvent {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let state = fixture.live.state.lock().await;
            if let Some(event) = state.events.iter().rev().find_map(|event| match event {
                StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(_),
                    tool_call_id: Some(call),
                    tool_name,
                    ..
                } if call == call_id && tool_name == "background_start" => Some(event.clone()),
                _ => None,
            }) {
                break event;
            }
            drop(state);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background approval was not shown")
}

pub(super) async fn decide_background_approval(
    fixture: &Fixture,
    call_id: &str,
    approved: bool,
) -> StructuredSessionEvent {
    let approval = wait_background_approval(fixture, call_id).await;
    let StructuredSessionEvent::ApprovalRequired {
        approval_id: Some(id),
        ..
    } = &approval
    else {
        unreachable!()
    };
    let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
    fixture
        .manager
        .approve_with_paired(
            "owner",
            &fixture.id,
            Some(id),
            approved,
            None,
            false,
            None,
            Some(&authority),
            None,
            &fixture.app,
        )
        .await
        .unwrap();
    approval
}

pub(super) async fn approve_prepared(
    fixture: &Fixture,
    actor: &Arc<BackgroundTurn>,
    prepared: background_turn::PreparedStart,
) -> background_turn::ApprovedStart {
    let approving = actor.clone();
    let call_id = TEST_CALL;
    let task_id = call_id;
    let approval = tokio::spawn(async move { approving.approve(prepared, &task_id).await });
    decide_background_approval(fixture, call_id, true).await;
    approval.await.unwrap().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_background_receipt_requires_real_gate_decision_and_is_bound_to_its_actor() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approving = actor.clone();
    let call_id = TEST_CALL;
    let approval = tokio::spawn(async move { approving.approve(prepared, call_id).await });
    let event = decide_background_approval(&fixture, call_id, true).await;
    let StructuredSessionEvent::ApprovalRequired {
        tool_input,
        description,
        turn_id,
        expires_at,
        ..
    } = event
    else {
        panic!("expected approval")
    };
    assert_eq!(
        tool_input,
        serde_json::json!({"command": request.command, "timeoutSeconds": 5})
    );
    assert_eq!(turn_id.as_deref(), Some("turn-7"));
    assert!(description.contains(&request.scope.workspace.display().to_string()));
    assert!(description.contains(&request.action_id));
    assert!(expires_at.is_some_and(|expiry| expiry > crate::v4_agent::interaction::now_ms()));
    let receipt = approval.await.unwrap().unwrap();
    let other = Arc::new(
        BackgroundTurn::new(
            fixture.manager.clone(),
            background,
            ActionScope {
                owner: "owner".into(),
                session_id: fixture.id.clone(),
                turn_id: "turn-7".into(),
            },
            7,
            request.scope.workspace.clone(),
            fixture.controller.clone(),
            crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
        )
        .unwrap(),
    );
    assert!(other.start_approved(receipt).await.is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denied_background_approval_never_yields_a_start_receipt_or_spawns() {
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approving = actor.clone();
    let call_id = TEST_CALL;
    let approval = tokio::spawn(async move { approving.approve(prepared, call_id).await });
    decide_background_approval(&fixture, call_id, false).await;
    assert!(approval.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn another_tool_call_cannot_authorize_a_prepared_background_action() {
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    assert!(actor.approve(prepared, "different-call").await.is_err());
    assert!(!fixture
        .live
        .state
        .lock()
        .await
        .events
        .iter()
        .any(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { .. })));
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reviewed_background_action_keeps_its_original_arguments_after_caller_changes() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    request.command = "printf wrong > changed-marker".into();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while std::fs::read_to_string(fixture._workspace.path().join("marker"))
            .ok()
            .as_deref()
            != Some("started")
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("approved action did not run");
    assert_eq!(
        std::fs::read_to_string(fixture._workspace.path().join("marker")).unwrap(),
        "started"
    );
    assert!(!fixture._workspace.path().join("changed-marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_http_approval_allows_only_the_reviewed_background_command() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approving = actor.clone();
    let approval = tokio::spawn(async move { approving.approve(prepared, TEST_CALL).await });
    let event = wait_background_approval(&fixture, TEST_CALL).await;
    let StructuredSessionEvent::ApprovalRequired {
        approval_id: Some(id),
        ..
    } = event
    else {
        panic!("expected approval")
    };
    let token = crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let response = crate::app(fixture.app.clone())
        .oneshot(
            Request::post(format!("/api/structured/sessions/{}/approve", fixture.id))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"approvalId": id, "approved": true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let approved = approval.await.unwrap().unwrap();
    actor.start_approved(approved).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while std::fs::read_to_string(fixture._workspace.path().join("marker"))
            .ok()
            .as_deref()
            != Some("started")
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("approved action did not run");
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn approved_background_receipt_cannot_start_after_logout() {
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    fixture.app.logout_user("owner").unwrap();
    assert!(actor.start_approved(approved).await.is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_while_approval_is_pending_never_yields_a_start_receipt() {
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approving = actor.clone();
    let approval = tokio::spawn(async move { approving.approve(prepared, TEST_CALL).await });
    wait_background_approval(&fixture, TEST_CALL).await;
    fixture.controller.cancel.cancel();
    assert!(approval.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approved_receipt_cannot_start_after_its_credential_expires() {
    let fixture = fixture().await;
    let (background, _actor, request) = actor_fixture(&fixture).await;
    let expiry = crate::v4_agent::interaction::now_ms() + 1500;
    let actor = Arc::new(
        BackgroundTurn::new(
            fixture.manager.clone(),
            background,
            ActionScope {
                owner: "owner".into(),
                session_id: fixture.id.clone(),
                turn_id: "turn-7".into(),
            },
            7,
            request.scope.workspace.clone(),
            fixture.controller.clone(),
            crate::auth::LocalAuthority::for_test("owner", 0, expiry),
        )
        .unwrap(),
    );
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let wait = (expiry - crate::v4_agent::interaction::now_ms()).max(0) as u64 + 25;
    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
    assert!(actor.start_approved(approved).await.is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approved_action_rejects_a_replaced_directory_at_the_same_workspace_path() {
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let workspace = fixture._workspace.path();
    let backup = fixture._data.path().join("original-workspace");
    std::fs::rename(workspace, &backup).unwrap();
    std::fs::create_dir(workspace).unwrap();
    let result = actor.start_approved(approved).await;
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    let marker = workspace.join("marker");
    let spawned_in_replacement = marker.exists();
    if spawned_in_replacement {
        std::fs::remove_file(marker).unwrap();
    }
    std::fs::remove_dir(workspace).unwrap();
    std::fs::rename(&backup, workspace).unwrap();
    assert!(
        result.is_err(),
        "a replacement directory must not inherit approval"
    );
    assert!(!spawned_in_replacement);
}

#[tokio::test]
async fn actor_rejects_an_ungated_background_manager() {
    let fixture = fixture().await;
    let other_root = tempfile::tempdir().unwrap();
    let path = other_root
        .path()
        .canonicalize()
        .unwrap()
        .join("background-processes");
    let background = Arc::new(BackgroundProcesses::create(&path).unwrap());
    background.enable_commands();
    fixture
        .manager
        .bind_background_processes(background.clone())
        .unwrap();
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: fixture.id.clone(),
        turn_id: "turn-7".into(),
    };
    let result = BackgroundTurn::new(
        fixture.manager.clone(),
        background,
        scope,
        7,
        fixture._workspace.path().canonicalize().unwrap(),
        fixture.controller.clone(),
        crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    assert!(
        result.is_err(),
        "an ungated manager must never authorize a turn"
    );
}

#[tokio::test]
async fn actor_rejects_a_controlled_background_manager_from_another_data_root() {
    let fixture = fixture().await;
    let other_root = tempfile::tempdir().unwrap();
    let other_app = crate::state::AppState::new(AppConfig {
        data_dir: other_root.path().into(),
        ..Default::default()
    })
    .unwrap();
    let background = {
        let mut db = other_app.lock_db().unwrap();
        Arc::new(
            crate::v4_agent::background_process::bootstrap::open_or_provision(
                other_root.path(),
                &mut db,
            )
            .unwrap(),
        )
    };
    background.enable_commands();
    fixture
        .manager
        .bind_background_processes(background.clone())
        .unwrap();
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: fixture.id.clone(),
        turn_id: "turn-7".into(),
    };
    let result = BackgroundTurn::new(
        fixture.manager.clone(),
        background,
        scope,
        7,
        fixture._workspace.path().canonicalize().unwrap(),
        fixture.controller.clone(),
        crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    assert!(
        result.is_err(),
        "another root's owner gate must not authorize this turn"
    );
}

#[tokio::test]
async fn actor_rejects_a_foreign_ledger_even_with_the_correct_owner_gate() {
    let fixture = fixture().await;
    {
        let mut db = fixture.app.lock_db().unwrap();
        drop(
            crate::v4_agent::background_process::bootstrap::open_or_provision(
                fixture._data.path(),
                &mut db,
            )
            .unwrap(),
        );
    }
    let gate = Arc::new(
        crate::v4_agent::background_process::owner_gate::OwnerGate::open(
            rusqlite::Connection::open(fixture._data.path().join("terminal.db")).unwrap(),
        )
        .unwrap(),
    );
    let other_root = tempfile::tempdir().unwrap();
    let path = other_root
        .path()
        .canonicalize()
        .unwrap()
        .join("background-processes");
    let background = Arc::new(BackgroundProcesses::create_controlled(&path, gate).unwrap());
    background.enable_commands();
    fixture
        .manager
        .bind_background_processes(background.clone())
        .unwrap();
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: fixture.id.clone(),
        turn_id: "turn-7".into(),
    };
    let result = BackgroundTurn::new(
        fixture.manager.clone(),
        background,
        scope,
        7,
        fixture._workspace.path().canonicalize().unwrap(),
        fixture.controller.clone(),
        crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    assert!(
        result.is_err(),
        "a foreign ledger must not inherit the local owner gate"
    );
}

pub(super) async fn actor_fixture(
    fixture: &Fixture,
) -> (
    Arc<BackgroundProcesses>,
    Arc<BackgroundTurn>,
    BackgroundRequest,
) {
    fixture.controller.done.send_replace(false);
    let background = {
        let mut db = fixture.app.lock_db().unwrap();
        Arc::new(
            crate::v4_agent::background_process::bootstrap::open_or_provision(
                fixture._data.path(),
                &mut db,
            )
            .unwrap(),
        )
    };
    background.enable_commands();
    fixture
        .manager
        .bind_background_processes(background.clone())
        .unwrap();
    let workspace = fixture._workspace.path().canonicalize().unwrap();
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: fixture.id.clone(),
        turn_id: "turn-7".into(),
    };
    let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
    let actor = Arc::new(
        BackgroundTurn::new(
            fixture.manager.clone(),
            background.clone(),
            scope.clone(),
            7,
            workspace.clone(),
            fixture.controller.clone(),
            authority,
        )
        .unwrap(),
    );
    let request = BackgroundRequest {
        scope: BackgroundScope {
            owner: "owner".into(),
            session: fixture.id.clone(),
            workspace,
            incarnation: Some(
                fixture
                    .live
                    .state
                    .lock()
                    .await
                    .session_incarnation
                    .unwrap()
                    .0,
            ),
        },
        authorization_generation: Some(0),
        action_id: crate::v4_agent::background_process::tool::action_id(&scope, TEST_CALL),
        command: "printf started > marker".into(),
        timeout: std::time::Duration::from_secs(5),
    };
    (background, actor, request)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_during_durable_claim_cancels_owned_background_start_before_spawn() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    background.pause_after_claim_for_test(entered, released);
    let launch_actor = actor.clone();
    let launch = tokio::spawn(async move { launch_actor.start_approved(approved).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    let manager = fixture.manager.clone();
    let app = fixture.app.clone();
    let id = fixture.id.clone();
    let stop = tokio::spawn(async move {
        let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
        manager
            .interrupt_authorized("owner", &id, Some(&authority), None, &app)
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        fixture.controller.cancel.cancelled(),
    )
    .await
    .unwrap();
    release.send(()).unwrap();
    assert!(launch.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    stop.await.unwrap().unwrap();
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_start_waiter_cannot_launch_after_the_bound_turn_is_cleared() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    background.pause_after_claim_for_test(entered, released);
    let launch_actor = actor.clone();
    let launch = tokio::spawn(async move { launch_actor.start_approved(approved).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    launch.abort();
    fixture
        .manager
        .clear_generation("owner", &fixture.id, 7)
        .await
        .unwrap();
    release.send(()).unwrap();
    fixture
        .manager
        .delete_session("owner", &fixture.id)
        .await
        .unwrap();
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logout_during_durable_claim_prevents_the_owned_background_spawn() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    background.pause_after_claim_for_test(entered, released);
    let launch_actor = actor.clone();
    let launch = tokio::spawn(async move { launch_actor.start_approved(approved).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    fixture.app.logout_user("owner").unwrap();
    release.send(()).unwrap();
    assert!(launch.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn actor_rejects_changed_generation_and_workspace() {
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let mut wrong_workspace = request.clone();
    wrong_workspace.scope.workspace = fixture._data.path().canonicalize().unwrap();
    assert!(actor.prepare(&wrong_workspace).await.is_err());
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    fixture.live.state.lock().await.generation = 8;
    assert!(actor.start_approved(approved).await.is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.live.state.lock().await.generation = 7;
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn actor_rejects_foreign_scope_and_changed_durable_incarnation() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let wrong = ActionScope {
        owner: "other".into(),
        session_id: fixture.id.clone(),
        turn_id: "turn-7".into(),
    };
    let authority = crate::auth::LocalAuthority::for_test("other", 0, i64::MAX);
    assert!(BackgroundTurn::new(
        fixture.manager.clone(),
        background,
        wrong,
        7,
        request.scope.workspace.clone(),
        fixture.controller.clone(),
        authority
    )
    .is_err());
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let path = structured_session_path(&fixture.manager.inner.config, "owner", &fixture.id);
    let original = std::fs::read(&path).unwrap();
    let first_newline = original.iter().position(|byte| *byte == b'\n').unwrap();
    let mut checkpoint: Value = serde_json::from_slice(&original[..first_newline]).unwrap();
    checkpoint["sessionIncarnation"] = Uuid::new_v4().to_string().into();
    let mut changed = serde_json::to_vec(&checkpoint).unwrap();
    changed.extend_from_slice(&original[first_newline..]);
    std::fs::write(&path, changed).unwrap();
    let result = actor.start_approved(approved).await;
    std::fs::write(&path, original).unwrap();
    assert!(result.is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_real_child_is_reaped_when_its_owned_session_is_deleted() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "printf '%s' $$ > child.pid; exec sleep 30".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let result = actor.start_approved(approved).await.unwrap();
    assert!(matches!(
        result.state,
        crate::v4_agent::background_process::BackgroundState::Running
    ));
    let pid: i32 = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(fixture._workspace.path().join("child.pid")) {
                if let Ok(pid) = text.parse() {
                    break pid;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let controller = fixture.controller.clone();
    let finish = tokio::spawn(async move {
        controller.cancel.cancelled().await;
        controller.done.send_replace(true);
    });
    fixture
        .manager
        .delete_session("owner", &fixture.id)
        .await
        .unwrap();
    finish.await.unwrap();
    assert!(actor.status(&request.action_id).await.is_err());
    assert!(actor.cancel(&request.action_id).await.is_err());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if unsafe { libc::kill(pid, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("background child survived session deletion");
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actor_start_is_fenced_by_a_cross_process_session_boundary() {
    use std::process::{Command, Stdio};
    let fixture = fixture().await;
    let (_background, actor, request) = actor_fixture(&fixture).await;
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    let ready = fixture._data.path().join("external-boundary-ready");
    let release = fixture._data.path().join("external-boundary-release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "v4_agent::background_process::lifecycle_tests::background_boundary_process_fixture",
            "--ignored",
        ])
        .env("V4_TEST_BOUNDARY_DATA", fixture._data.path())
        .env("V4_TEST_BOUNDARY_OWNER", "owner")
        .env("V4_TEST_BOUNDARY_SESSION", &fixture.id)
        .env("V4_TEST_BOUNDARY_READY", &ready)
        .env("V4_TEST_BOUNDARY_RELEASE", &release)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let entered = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !ready.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    let result = if entered {
        Some(actor.start_approved(approved).await)
    } else {
        None
    };
    std::fs::write(&release, b"release").unwrap();
    let child_ok = tokio::task::spawn_blocking(move || child.wait())
        .await
        .unwrap()
        .unwrap()
        .success();
    assert!(entered && child_ok);
    assert!(result.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

// ---- Production-path lifecycle: tool actions go through the bound actor only.

pub(super) async fn wait_tool_approval(
    fixture: &Fixture,
    call_id: &str,
    tool: &str,
) -> (String, String) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = fixture.live.state.lock().await;
            if let Some(found) = state.events.iter().rev().find_map(|event| match event {
                StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(id),
                    tool_call_id: Some(call),
                    tool_name,
                    description,
                    ..
                } if call == call_id && tool_name == tool => {
                    Some((id.clone(), description.clone()))
                }
                _ => None,
            }) {
                break found;
            }
            drop(state);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("approval was not shown")
}

pub(super) async fn decide(fixture: &Fixture, id: &str, approved: bool) {
    let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
    fixture
        .manager
        .approve_with_paired(
            "owner",
            &fixture.id,
            Some(id),
            approved,
            None,
            false,
            None,
            Some(&authority),
            None,
            &fixture.app,
        )
        .await
        .unwrap();
}

pub(super) async fn approvals_shown(fixture: &Fixture) -> usize {
    fixture
        .live
        .state
        .lock()
        .await
        .events
        .iter()
        .filter(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { .. }))
        .count()
}

pub(super) async fn started_through_actor(
    fixture: &Fixture,
    actor: &Arc<BackgroundTurn>,
    call_id: &str,
    command: &str,
    seconds: u64,
) -> String {
    let starter = actor.clone();
    let (call, command) = (call_id.to_owned(), command.to_owned());
    let start = tokio::spawn(async move {
        BackgroundActor::start(
            starter,
            &call,
            &command,
            std::time::Duration::from_secs(seconds),
        )
        .await
    });
    let (id, _) = wait_tool_approval(fixture, call_id, "background_start").await;
    decide(fixture, &id, true).await;
    let (action, snapshot) = start.await.unwrap().unwrap();
    assert_eq!(snapshot.state, BackgroundState::Running);
    action
}

pub(super) async fn terminal(actor: &BackgroundTurn, action: &str) -> BackgroundState {
    let snapshot = actor
        .wait(action, std::time::Duration::from_secs(10))
        .await
        .unwrap();
    assert_ne!(snapshot.state, BackgroundState::Running);
    snapshot.state
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actor_start_requires_the_user_decision_and_never_prompts_when_refused_early() {
    let fixture = fixture().await;
    let (background, actor, _) = actor_fixture(&fixture).await;
    let denied = {
        let starter = actor.clone();
        let task = tokio::spawn(async move {
            BackgroundActor::start(
                starter,
                "denied-call",
                "printf denied > marker",
                std::time::Duration::from_secs(5),
            )
            .await
        });
        let (id, description) =
            wait_tool_approval(&fixture, "denied-call", "background_start").await;
        assert!(description.contains("printf denied > marker"));
        decide(&fixture, &id, false).await;
        task.await.unwrap()
    };
    assert!(denied.is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    let before = approvals_shown(&fixture).await;
    background.set_running_limits_for_test(0, 0);
    let refused = BackgroundActor::start(
        actor.clone(),
        "over-limit",
        "printf late > marker",
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("Too many"), "{refused}");
    assert_eq!(approvals_shown(&fixture).await, before);
    fixture.app.logout_user("owner").unwrap();
    background.set_running_limits_for_test(8, 32);
    assert!(BackgroundActor::start(
        actor.clone(),
        "after-logout",
        "printf late > marker",
        std::time::Duration::from_secs(5),
    )
    .await
    .is_err());
    assert_eq!(approvals_shown(&fixture).await, before);
    assert!(!fixture._workspace.path().join("marker").exists());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn running_slot_is_released_after_cancel_and_refusal_claims_no_receipt() {
    let fixture = fixture().await;
    let (background, actor, _) = actor_fixture(&fixture).await;
    background.set_running_limits_for_test(1, 8);
    let first = started_through_actor(&fixture, &actor, "slot-first", "sleep 30", 40).await;
    let before = approvals_shown(&fixture).await;
    let refused = BackgroundActor::start(
        actor.clone(),
        "slot-second",
        "printf second > marker",
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("Too many"), "{refused}");
    assert_eq!(approvals_shown(&fixture).await, before);
    let second_id =
        crate::v4_agent::background_process::tool::action_id(&actor_scope(&actor), "slot-second");
    assert!(actor.status(&second_id).await.is_err());
    actor.cancel(&first).await.unwrap();
    assert_eq!(terminal(&actor, &first).await, BackgroundState::Cancelled);
    let second =
        started_through_actor(&fixture, &actor, "slot-second", "printf second > marker", 5).await;
    assert_eq!(
        terminal(&actor, &second).await,
        BackgroundState::Exited { code: Some(0) }
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

pub(super) fn actor_scope(actor: &Arc<BackgroundTurn>) -> ActionScope {
    BackgroundActor::scope(actor.as_ref()).clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_is_withheld_until_the_user_approves_the_exact_bounded_snapshot() {
    std::env::set_var("V4_BACKGROUND_TEST_SECRET", "must-not-reach-child");
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(
        &fixture,
        &actor,
        "output-call",
        "printf 'out:%s' \"${V4_BACKGROUND_TEST_SECRET:-absent}\"; printf err >&2",
        5,
    )
    .await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let status = actor.status(&action).await.unwrap();
    assert!((status.stdout.is_empty() && status.stderr.is_empty()) && status.output_withheld);

    for approved in [false, true] {
        let reviewer = actor.clone();
        let (call, id) = (format!("review-{approved}"), action.clone());
        let call_for_task = call.clone();
        let review = tokio::spawn(async move {
            BackgroundActor::review_output(reviewer.as_ref(), &call_for_task, &id).await
        });
        let (approval, description) =
            wait_tool_approval(&fixture, &call, "background_read_output").await;
        assert!(description.contains("out:absent"), "{description}");
        decide(&fixture, &approval, approved).await;
        let result = review.await.unwrap();
        if approved {
            let released = result.unwrap();
            assert_eq!(
                (released.stdout.as_str(), released.stderr.as_str()),
                ("out:absent", "err")
            );
        } else {
            assert!(result.is_err());
        }
    }
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approved_output_is_not_released_after_logout_or_a_session_identity_change() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(&fixture, &actor, "fence-call", "printf private", 5).await;
    terminal(&actor, &action).await;
    let reviewer = actor.clone();
    let id = action.clone();
    let review = tokio::spawn(async move {
        BackgroundActor::review_output(reviewer.as_ref(), "fence-review", &id).await
    });
    let (approval, _) =
        wait_tool_approval(&fixture, "fence-review", "background_read_output").await;
    let original = fixture.live.state.lock().await.session_incarnation;
    fixture.live.state.lock().await.session_incarnation = Some(SessionIncarnation(Uuid::new_v4()));
    decide(&fixture, &approval, true).await;
    assert!(review.await.unwrap().is_err());
    fixture.live.state.lock().await.session_incarnation = original;

    assert!(review_is_refused_before_prompting_after_logout(&fixture, &actor, &action).await);
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

async fn review_is_refused_before_prompting_after_logout(
    fixture: &Fixture,
    actor: &Arc<BackgroundTurn>,
    action: &str,
) -> bool {
    fixture.app.logout_user("owner").unwrap();
    let before = approvals_shown(fixture).await;
    let result =
        BackgroundActor::review_output(actor.as_ref(), "after-logout-review", action).await;
    result.is_err() && approvals_shown(fixture).await == before
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_outcomes_survive_restart_and_a_crashed_action_stays_honestly_unknown() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let finished =
        started_through_actor(&fixture, &actor, "restart-ok", "printf finished", 5).await;
    let failed = started_through_actor(&fixture, &actor, "restart-fail", "exit 3", 5).await;
    let crashed = started_through_actor(&fixture, &actor, "restart-crash", "sleep 30", 40).await;
    assert_eq!(
        terminal(&actor, &finished).await,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        terminal(&actor, &failed).await,
        BackgroundState::Exited { code: Some(3) }
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    let Fixture {
        _data: data,
        _workspace: workspace,
        app,
        manager,
        live,
        controller: stopped,
        id,
    } = fixture;
    drop((actor, _background, stopped, live, manager, app));
    // A host crash leaves the claim unfinished; a clean shutdown above already
    // reaped the process, so rewrite its receipt to the post-crash state.
    let receipts =
        rusqlite::Connection::open(data.path().join("background-processes/receipts.sqlite3"))
            .unwrap();
    assert_eq!(
        receipts
            .execute(
                "UPDATE receipts SET state='unknown', code=NULL WHERE state='cancelled'",
                []
            )
            .unwrap(),
        1
    );
    drop(receipts);

    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let state = {
        let mut attempt = 0;
        loop {
            match crate::state::AppState::new_runtime_with_background_commands(
                config.clone(),
                false,
            ) {
                Ok(state) => break state,
                Err(error) if attempt < 100 => {
                    attempt += 1;
                    let _ = error;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(error) => panic!("runtime did not reopen: {error}"),
            }
        }
    };
    let manager = state.structured_session_manager();
    let background = manager
        .background_processes_for_test()
        .expect("runtime did not retain the existing background installation");
    background.enable_commands();
    let live = manager
        .owned_session("owner", &id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let controller = controller(&manager, &live, &id, 7).await;
    controller.done.send_replace(false);
    {
        let mut state = live.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    let actor = Arc::new(
        BackgroundTurn::new(
            manager.clone(),
            background,
            ActionScope {
                owner: "owner".into(),
                session_id: id.clone(),
                turn_id: "turn-7".into(),
            },
            7,
            workspace.path().canonicalize().unwrap(),
            controller.clone(),
            crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
        )
        .unwrap(),
    );
    assert_eq!(
        actor.status(&finished).await.unwrap().state,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        actor
            .wait(&failed, std::time::Duration::from_secs(1))
            .await
            .unwrap()
            .state,
        BackgroundState::Exited { code: Some(3) }
    );
    assert!(actor.cancel(&finished).await.is_ok());
    assert_eq!(
        actor.status(&crashed).await.unwrap().state,
        BackgroundState::Unknown
    );
    assert_eq!(
        actor
            .wait(&crashed, std::time::Duration::from_secs(1))
            .await
            .unwrap()
            .state,
        BackgroundState::Unknown
    );
    assert!(actor.cancel(&crashed).await.is_err());
    assert!(
        BackgroundActor::review_output(actor.as_ref(), "after-restart", &finished)
            .await
            .is_err()
    );
    let shown = || async {
        live.state
            .lock()
            .await
            .events
            .iter()
            .filter(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { .. }))
            .count()
    };
    let before = shown().await;
    let refused = BackgroundActor::start(
        actor.clone(),
        "after-crash",
        "printf late > marker",
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("recovery"), "{refused}");
    assert_eq!(shown().await, before);
    assert!(!workspace.path().join("marker").exists());
    controller.done.send_replace(true);
    // Shutdown must keep reporting the unconfirmed outcome rather than hide it.
    assert!(manager.shutdown().await.is_err());
}

pub(super) fn tool_results(body: &Value) -> Vec<Value> {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["role"] == "tool")
        .map(|message| {
            let content = message["content"].as_str().unwrap_or_default();
            serde_json::from_str(content).unwrap_or(Value::String(content.into()))
        })
        .collect()
}

pub(super) fn tool_call_response(id: &str, name: &str, arguments: Value) -> Value {
    serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]}}]})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_agent_turn_runs_launch_status_wait_cancel_and_reviewed_output_through_the_actor() {
    use axum::{routing::post, Json, Router};
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let turn_id = Uuid::new_v4().to_string();
    let live_controller = controller_for_turn(
        &fixture.manager,
        &fixture.live,
        &fixture.id,
        7,
        turn_id.clone(),
    )
    .await;
    live_controller.done.send_replace(false);
    fixture.live.state.lock().await.process = Some(live_controller.clone());
    let actor = Arc::new(
        BackgroundTurn::new(
            fixture.manager.clone(),
            background,
            ActionScope {
                owner: "owner".into(),
                session_id: fixture.id.clone(),
                turn_id,
            },
            7,
            fixture._workspace.path().canonicalize().unwrap(),
            live_controller.clone(),
            crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
        )
        .unwrap(),
    );
    let scope = actor_scope(&actor);
    let bodies = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = bodies.clone();
    let router = Router::new().fallback(post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        async move {
            let mut bodies = captured.lock().unwrap();
            let results = tool_results(&body);
            let action = |index: usize| results[index]["actionId"].clone();
            let response = match bodies.len() {
                0 => tool_call_response("bg-short", "background_start", serde_json::json!({"command":"printf out-ok; printf err-ok >&2; sleep 1","timeoutSeconds":10})),
                1 => tool_call_response("bg-status", "background_status", serde_json::json!({"actionId":action(0)})),
                2 => tool_call_response("bg-wait", "background_wait", serde_json::json!({"actionId":action(0),"timeoutSeconds":10})),
                3 => tool_call_response("bg-long", "background_start", serde_json::json!({"command":"sleep 30","timeoutSeconds":40})),
                4 => tool_call_response("bg-cancel", "background_cancel", serde_json::json!({"actionId":action(3)})),
                5 => tool_call_response("bg-wait-long", "background_wait", serde_json::json!({"actionId":action(3),"timeoutSeconds":10})),
                6 => tool_call_response("bg-output", "background_read_output", serde_json::json!({"actionId":action(0)})),
                _ => serde_json::json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"All done"}}]}),
            };
            bodies.push(body);
            Json(response)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let dyn_actor: Arc<dyn BackgroundActor> = actor.clone();
    live_controller
        .resources
        .bind_background_actor(&dyn_actor)
        .unwrap();
    let seen = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let decider = {
        let seen = seen.clone();
        let (manager, app, session) = (
            fixture.manager.clone(),
            fixture.app.clone(),
            fixture.id.clone(),
        );
        let live = fixture.live.clone();
        tokio::spawn(async move {
            let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
            let mut decided = std::collections::HashSet::new();
            loop {
                let pending: Vec<_> = live
                    .state
                    .lock()
                    .await
                    .events
                    .iter()
                    .filter_map(|event| match event {
                        StructuredSessionEvent::ApprovalRequired {
                            approval_id: Some(id),
                            tool_name,
                            description,
                            ..
                        } if tool_name.starts_with("background_") && !decided.contains(id) => {
                            Some((id.clone(), tool_name.clone(), description.clone()))
                        }
                        _ => None,
                    })
                    .collect();
                for (approval, tool, description) in pending {
                    manager
                        .approve_with_paired(
                            "owner",
                            &session,
                            Some(&approval),
                            true,
                            None,
                            false,
                            None,
                            Some(&authority),
                            None,
                            &app,
                        )
                        .await
                        .unwrap();
                    seen.lock().unwrap().push((tool, description));
                    decided.insert(approval);
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
    };
    let root = fixture._workspace.path().canonicalize().unwrap();
    let mut session: crate::v4_agent::Session = serde_json::from_value(serde_json::json!({
        "id": engine_session_id(&fixture.id).unwrap(), "provider": "deepseek", "model": "deepseek-chat",
        "workspace": root.to_str().unwrap(), "messages": [], "history": [], "updated_at": ""
    }))
    .unwrap();
    let sink = V4StructuredInteraction {
        sink: live_controller.sink.clone(),
        controller: live_controller.clone(),
    };
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        crate::v4_agent::test_background_provider_turn(
            format!("http://{address}"),
            fixture._data.path(),
            &mut session,
            scope.clone(),
            live_controller.resources.clone(),
            &sink,
            Some(crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX)),
        ),
    )
    .await;
    let answer = match answer {
        Ok(result) => result.unwrap(),
        Err(_) => {
            let events: Vec<String> = match fixture.live.state.try_lock() {
                Ok(state) => state
                    .events
                    .iter()
                    .map(|event| format!("{event:?}").chars().take(300).collect())
                    .collect(),
                Err(_) => vec!["state lock is held".into()],
            };
            panic!(
                "turn timed out after {} provider requests; events: {events:#?}",
                bodies.lock().unwrap().len()
            );
        }
    };
    assert_eq!(answer, "All done");
    decider.abort();
    let approvals = seen.lock().unwrap().clone();
    assert_eq!(
        approvals
            .iter()
            .map(|(tool, _)| tool.as_str())
            .collect::<Vec<_>>(),
        [
            "background_start",
            "background_start",
            "background_read_output"
        ]
    );
    assert!(approvals[2].1.contains("out-ok") && approvals[2].1.contains("err-ok"));

    let bodies = bodies.lock().unwrap();
    let results = tool_results(bodies.last().unwrap());
    assert_eq!(results.len(), 7, "{:?}", bodies.last().unwrap()["messages"]);
    assert_eq!(results[0]["state"], "running");
    assert_eq!(results[0]["actionId"], results[1]["actionId"]);
    assert_ne!(results[0]["actionId"], results[3]["actionId"]);
    assert_eq!(results[1]["state"], "running");
    assert_eq!(
        (
            results[2]["state"].as_str(),
            results[2]["exitCode"].as_i64()
        ),
        (Some("exited"), Some(0))
    );
    assert_eq!(results[5]["state"], "cancelled");
    for withheld in &results[..6] {
        assert!(withheld.get("stdout").is_none() && !withheld.to_string().contains("out-ok"));
    }
    assert_eq!(
        (results[6]["stdout"].as_str(), results[6]["stderr"].as_str()),
        (Some("out-ok"), Some("err-ok"))
    );
    drop(bodies);
    server.abort();
    live_controller.done.send_replace(true);
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_terminal_outcome_is_committed_once_and_cannot_be_rewritten_by_later_cancel() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(&fixture, &actor, "once", "exit 0", 5).await;
    let expected = BackgroundState::Exited { code: Some(0) };
    assert_eq!(terminal(&actor, &action).await, expected);
    for _ in 0..2 {
        assert_eq!(actor.cancel(&action).await.unwrap().state, expected);
        assert_eq!(actor.status(&action).await.unwrap().state, expected);
        assert_eq!(
            actor
                .wait(&action, std::time::Duration::from_secs(1))
                .await
                .unwrap()
                .state,
            expected
        );
    }
    let replay = started_replay(&fixture, &actor, "once").await;
    assert!(replay.is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

async fn started_replay(
    fixture: &Fixture,
    actor: &Arc<BackgroundTurn>,
    call_id: &str,
) -> Result<
    (
        String,
        crate::v4_agent::background_process::BackgroundSnapshot,
    ),
    String,
> {
    let starter = actor.clone();
    let call = call_id.to_owned();
    let start = tokio::spawn(async move {
        BackgroundActor::start(
            starter,
            &call,
            "printf replay > marker",
            std::time::Duration::from_secs(5),
        )
        .await
    });
    let shown = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let state = fixture.live.state.lock().await;
            let pending = state.events.iter().rev().find_map(|event| match event {
                StructuredSessionEvent::ApprovalRequired {
                    approval_id: Some(id),
                    tool_call_id: Some(call),
                    description,
                    ..
                } if call == call_id && description.contains("replay > marker") => Some(id.clone()),
                _ => None,
            });
            drop(state);
            if let Some(id) = pending {
                break id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    if let Ok(approval) = shown {
        decide(fixture, &approval, true).await;
    }
    start.await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_reaps_an_actor_started_child_and_its_outcome_stays_durable() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(
        &fixture,
        &actor,
        "shutdown-child",
        "printf '%s' $$ > child.pid; exec sleep 30",
        40,
    )
    .await;
    let pid: i32 = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(pid) = std::fs::read_to_string(fixture._workspace.path().join("child.pid"))
                .map_err(|_| ())
                .and_then(|text| text.parse().map_err(|_| ()))
            {
                break pid;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    let _ = action;
}
