use super::*;
use crate::v4_agent::background_process::{
    tool::{execute_actor, BackgroundActor},
    BackgroundProcesses, BackgroundRequest, BackgroundScope, BackgroundState,
};

const TEST_CALL: &str = "fixture-background-call";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_paired_grant_cannot_approve_a_previously_previewed_output() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let bound: Arc<dyn BackgroundActor> = actor.clone();
    fixture
        .controller
        .resources
        .bind_background_actor(&bound)
        .unwrap();
    let action = started_through_actor(
        &fixture,
        &actor,
        "paired-revoke-start",
        "printf synthetic",
        5,
    )
    .await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "paired-revoke-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) =
        wait_tool_approval(&fixture, "paired-revoke-review", "background_read_output").await;
    let (grant_id, paired) =
        crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    let local = crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let base = format!("/api/structured/sessions/{}/private-output", fixture.id);
    let post = |path: String, credential: &str, body: Value| {
        Request::post(path)
            .header("authorization", format!("Bearer {credential}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let app = crate::app(fixture.app.clone());
    let response = app
        .clone()
        .oneshot(post(
            format!("{base}/preview"),
            &paired,
            serde_json::json!({"approvalId":id,"actionId":action}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let preview: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1_048_576).await.unwrap()).unwrap();
    let revoked = app
        .clone()
        .oneshot(
            Request::delete(format!("/api/environments/grants/{grant_id}"))
                .header("authorization", format!("Bearer {local}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let denied = app.clone().oneshot(post(format!("{base}/approve"), &paired, serde_json::json!({"approvalId":id,"actionId":action,"previewToken":preview["previewToken"]}))).await.unwrap();
    assert_ne!(denied.status(), StatusCode::OK);
    let rejected = app
        .oneshot(post(
            format!("/api/structured/sessions/{}/approve", fixture.id),
            &local,
            serde_json::json!({"approvalId":id,"approved":false}),
        ))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::OK);
    assert!(task.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_review_http_allows_an_authorized_paired_owner() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let bound: Arc<dyn BackgroundActor> = actor.clone();
    fixture
        .controller
        .resources
        .bind_background_actor(&bound)
        .unwrap();
    let action = started_through_actor(
        &fixture,
        &actor,
        "paired-private-start",
        "printf synthetic",
        5,
    )
    .await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "paired-private-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) =
        wait_tool_approval(&fixture, "paired-private-review", "background_read_output").await;
    let (_, paired) = crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    let (_, foreign) = crate::paired_environments::synthetic_input_grant(&fixture.app, "other");
    let (observer_id, observer) =
        crate::paired_environments::synthetic_input_grant(&fixture.app, "owner");
    fixture
        .app
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_grants SET capabilities=?1 WHERE id=?2",
            rusqlite::params![
                serde_json::to_string(&crate::remote_permissions::Capabilities::observer())
                    .unwrap(),
                observer_id
            ],
        )
        .unwrap();
    let base = format!("/api/structured/sessions/{}/private-output", fixture.id);
    let post = |path: String, credential: &str, body: Value| {
        Request::post(path)
            .header("authorization", format!("Bearer {credential}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let app = crate::app(fixture.app.clone());
    let body = serde_json::json!({"approvalId":id,"actionId":action});
    let denied = app
        .clone()
        .oneshot(post(format!("{base}/preview"), &foreign, body.clone()))
        .await
        .unwrap();
    assert_ne!(denied.status(), StatusCode::OK);
    let read_only = app
        .clone()
        .oneshot(post(format!("{base}/preview"), &observer, body.clone()))
        .await
        .unwrap();
    assert_ne!(read_only.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(post(format!("{base}/preview"), &paired, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("no-store"));
    let preview: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1_048_576).await.unwrap()).unwrap();
    assert_eq!(preview["output"]["stdout"], "synthetic");
    let accepted = app.oneshot(post(format!("{base}/approve"), &paired, serde_json::json!({"approvalId":id,"actionId":action,"previewToken":preview["previewToken"]}))).await.unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(
        actor
            .release_output(task.await.unwrap().unwrap())
            .await
            .unwrap()
            .stdout,
        "synthetic"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_review_http_denial_never_journals_the_previewed_output() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    fn contains(path: &std::path::Path, needle: &[u8]) -> bool {
        std::fs::read_dir(path)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    contains(&path, needle)
                } else {
                    std::fs::read(path)
                        .is_ok_and(|bytes| bytes.windows(needle.len()).any(|part| part == needle))
                }
            })
    }
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let bound: Arc<dyn BackgroundActor> = actor.clone();
    fixture
        .controller
        .resources
        .bind_background_actor(&bound)
        .unwrap();
    let secret = b"SYNTHETIC_DENIED_PRIVATE_OUTPUT";
    std::fs::write(fixture._workspace.path().join("secret-fixture"), secret).unwrap();
    let action =
        started_through_actor(&fixture, &actor, "denial-start", "cat secret-fixture", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "denial-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "denial-review", "background_read_output").await;
    let access =
        crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let app = crate::app(fixture.app.clone());
    let post = |path: String, body: Value| {
        Request::post(path)
            .header("authorization", format!("Bearer {access}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = app
        .clone()
        .oneshot(post(
            format!(
                "/api/structured/sessions/{}/private-output/preview",
                fixture.id
            ),
            serde_json::json!({"approvalId":id,"actionId":action}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let preview = to_bytes(response.into_body(), 1_048_576).await.unwrap();
    assert!(preview.windows(secret.len()).any(|part| part == secret));
    let denied = app
        .oneshot(post(
            format!("/api/structured/sessions/{}/approve", fixture.id),
            serde_json::json!({"approvalId":id,"approved":false}),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::OK);
    assert!(task.await.unwrap().is_err());
    assert!(!format!("{:?}", fixture.live.state.lock().await.events)
        .contains(std::str::from_utf8(secret).unwrap()));
    assert!(!contains(fixture._data.path(), secret));
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_review_http_requires_owner_preview_and_exact_decision() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let bound: Arc<dyn BackgroundActor> = actor.clone();
    fixture
        .controller
        .resources
        .bind_background_actor(&bound)
        .unwrap();
    std::fs::write(
        fixture._workspace.path().join("secret-fixture"),
        b"SYNTHETIC_PRIVATE_OUTPUT",
    )
    .unwrap();
    let action = started_through_actor(
        &fixture,
        &actor,
        "http-private-start",
        "cat secret-fixture",
        5,
    )
    .await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "http-private-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) =
        wait_tool_approval(&fixture, "http-private-review", "background_read_output").await;
    let access =
        crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "owner", "owner");
    let foreign =
        crate::auth::issue_access_token(&fixture.app.config().jwt_secret, "other", "other");
    let base = format!("/api/structured/sessions/{}/private-output", fixture.id);
    let post = |path: String, credential: &str, body: Value| {
        Request::post(path)
            .header("authorization", format!("Bearer {credential}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let body = serde_json::json!({"approvalId": id, "actionId": action});
    let app = crate::app(fixture.app.clone());
    let denied = app
        .clone()
        .oneshot(post(format!("{base}/preview"), &foreign, body.clone()))
        .await
        .unwrap();
    assert_ne!(denied.status(), StatusCode::OK);
    let generic = app
        .clone()
        .oneshot(post(
            format!("/api/structured/sessions/{}/approve", fixture.id),
            &access,
            serde_json::json!({"approvalId":id,"approved":true}),
        ))
        .await
        .unwrap();
    assert_ne!(generic.status(), StatusCode::OK);
    let session_approval = app
        .clone()
        .oneshot(post(
            format!("/api/structured/sessions/{}/approve", fixture.id),
            &access,
            serde_json::json!({"approvalId":id,"approved":true,"forSession":true}),
        ))
        .await
        .unwrap();
    assert_ne!(session_approval.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(post(format!("{base}/preview"), &access, body.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("no-store"));
    let preview: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1_048_576).await.unwrap()).unwrap();
    assert_eq!(preview["output"]["stdout"], "SYNTHETIC_PRIVATE_OUTPUT");
    let token = preview["previewToken"].as_str().unwrap();
    let bad = app
        .clone()
        .oneshot(post(
            format!("{base}/approve"),
            &access,
            serde_json::json!({"approvalId":id,"actionId":action,"previewToken":"bad"}),
        ))
        .await
        .unwrap();
    assert_ne!(bad.status(), StatusCode::OK);
    let wrong_action = app
        .clone()
        .oneshot(post(
            format!("{base}/approve"),
            &access,
            serde_json::json!({"approvalId":id,"actionId":"f".repeat(64),"previewToken":token}),
        ))
        .await
        .unwrap();
    assert_ne!(wrong_action.status(), StatusCode::OK);
    let accepted = app
        .clone()
        .oneshot(post(
            format!("{base}/approve"),
            &access,
            serde_json::json!({"approvalId":id,"actionId":action,"previewToken":token}),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let retry = app
        .oneshot(post(
            format!("{base}/approve"),
            &access,
            serde_json::json!({"approvalId":id,"actionId":action,"previewToken":token}),
        ))
        .await
        .unwrap();
    assert_eq!(retry.status(), StatusCode::OK);
    let receipt: Value =
        serde_json::from_slice(&to_bytes(retry.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(receipt["status"], "already_decided");
    let output = actor
        .release_output(task.await.unwrap().unwrap())
        .await
        .unwrap();
    assert_eq!(output.stdout, "SYNTHETIC_PRIVATE_OUTPUT");
    assert!(!format!("{:?}", fixture.live.state.lock().await.events)
        .contains("SYNTHETIC_PRIVATE_OUTPUT"));
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_decision_rejects_a_reviewer_revoked_after_preview() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(&fixture, &actor, "revoke-start", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "revoke-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "revoke-review", "background_read_output").await;
    let reviewer = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
    let (token, _) = actor
        .private_output_preview(&id, &action, &reviewer)
        .await
        .unwrap();
    fixture.app.logout_user("owner").unwrap();
    let context = Arc::new(PairedDecisionContext {
        guard: Arc::new(fixture.app.acquire_input_guard("owner").unwrap()),
        state: fixture.app.clone(),
        authority: DecisionAuthority::Local(reviewer),
        owner: "owner".into(),
    });
    assert!(actor
        .private_output_decision(&id, &action, &token, &context)
        .await
        .is_err());
    drop(context);
    fixture.controller.cancel.cancel();
    assert!(task.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_decision_requires_live_owner_action_and_matching_preview() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action =
        started_through_actor(&fixture, &actor, "decision-start", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "decision-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "decision-review", "background_read_output").await;
    let reviewer = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
    let (token, _) = actor
        .private_output_preview(&id, &action, &reviewer)
        .await
        .unwrap();
    let wrong_guard = Arc::new(PairedDecisionContext {
        guard: Arc::new(fixture.app.acquire_input_guard("other").unwrap()),
        state: fixture.app.clone(),
        authority: DecisionAuthority::Local(reviewer.clone()),
        owner: "owner".into(),
    });
    assert!(actor
        .private_output_decision(&id, &action, &token, &wrong_guard)
        .await
        .is_err());
    drop(wrong_guard);
    let foreign_root = tempfile::tempdir().unwrap();
    let foreign_app = crate::state::AppState::new(AppConfig {
        data_dir: foreign_root.path().into(),
        ..Default::default()
    })
    .unwrap();
    let wrong_root = Arc::new(PairedDecisionContext {
        guard: Arc::new(foreign_app.acquire_input_guard("owner").unwrap()),
        state: fixture.app.clone(),
        authority: DecisionAuthority::Local(reviewer.clone()),
        owner: "owner".into(),
    });
    assert!(actor
        .private_output_decision(&id, &action, &token, &wrong_root)
        .await
        .is_err());
    drop(wrong_root);
    let context = Arc::new(PairedDecisionContext {
        guard: Arc::new(fixture.app.acquire_input_guard("owner").unwrap()),
        state: fixture.app.clone(),
        authority: DecisionAuthority::Local(reviewer),
        owner: "owner".into(),
    });
    assert!(actor
        .private_output_decision(&id, &"f".repeat(64), &token, &context)
        .await
        .is_err());
    assert!(actor
        .private_output_decision(&id, &action, "wrong-token", &context)
        .await
        .is_err());
    let workspace = fixture._workspace.path();
    let backup = fixture._data.path().join("decision-original-workspace");
    std::fs::rename(workspace, &backup).unwrap();
    std::fs::create_dir(workspace).unwrap();
    let replaced = actor
        .private_output_decision(&id, &action, &token, &context)
        .await;
    std::fs::remove_dir(workspace).unwrap();
    std::fs::rename(&backup, workspace).unwrap();
    assert!(replaced.is_err());
    assert!(
        actor
            .private_output_decision(&id, &action, &token, &context)
            .await
            .unwrap()
            .approved
    );
    assert_eq!(
        actor
            .private_output_decision(&id, &action, &token, &context)
            .await
            .unwrap()
            .status,
        "already_decided"
    );
    let output = actor
        .release_output(task.await.unwrap().unwrap())
        .await
        .unwrap();
    assert_eq!(output.stdout, "private");
    drop(context);
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_preview_requires_matching_action_and_live_origin_authority() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let action =
        started_through_actor(&fixture, &actor, "preview-start", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "preview-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let task = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "preview-review", "background_read_output").await;
    let reviewer = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
    let other_actor = BackgroundTurn::new(
        fixture.manager.clone(),
        background,
        actor_scope(&actor),
        7,
        request.scope.workspace,
        fixture.controller.clone(),
        reviewer.clone(),
    )
    .unwrap();
    let foreign = crate::auth::LocalAuthority::for_test("other", 0, i64::MAX);
    let expired = crate::auth::LocalAuthority::for_test("owner", 0, 1);
    let newer_generation = crate::auth::LocalAuthority::for_test("owner", 1, i64::MAX);
    assert!(actor
        .private_output_preview(&id, &"f".repeat(64), &reviewer)
        .await
        .is_err());
    assert!(actor
        .private_output_preview(&id, &action, &foreign)
        .await
        .is_err());
    assert!(actor
        .private_output_preview(&id, &action, &expired)
        .await
        .is_err());
    assert!(actor
        .private_output_preview(&id, &action, &newer_generation)
        .await
        .is_err());
    assert!(other_actor
        .private_output_preview(&id, &action, &reviewer)
        .await
        .is_err());
    let workspace = fixture._workspace.path();
    let backup = fixture._data.path().join("preview-original-workspace");
    std::fs::rename(workspace, &backup).unwrap();
    std::fs::create_dir(workspace).unwrap();
    let replaced_preview = actor.private_output_preview(&id, &action, &reviewer).await;
    std::fs::remove_dir(workspace).unwrap();
    std::fs::rename(&backup, workspace).unwrap();
    assert!(replaced_preview.is_err());
    let (token, preview) = actor
        .private_output_preview(&id, &action, &reviewer)
        .await
        .unwrap();
    assert_eq!(preview["stdout"], "private");
    assert!(fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            other_actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(())
        )
        .await
        .is_err());
    assert!(fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            (u64::MAX, u64::MAX),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(())
        )
        .await
        .is_err());
    fixture.app.logout_user("owner").unwrap();
    assert!(actor
        .private_output_preview(&id, &action, &reviewer)
        .await
        .is_err());
    fixture.controller.cancel.cancel();
    assert!(task.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_background_review_cannot_release_after_stop_or_session_replacement() {
    for replace_session in [false, true] {
        let fixture = fixture().await;
        let (_background, actor, _) = actor_fixture(&fixture).await;
        let action =
            started_through_actor(&fixture, &actor, "identity-start", "printf private", 5).await;
        assert_eq!(
            terminal(&actor, &action).await,
            BackgroundState::Exited { code: Some(0) }
        );
        let prepared = actor
            .prepare_output(&action, "identity-review")
            .await
            .unwrap();
        let approving = actor.clone();
        let approval = tokio::spawn(async move { approving.approve_output(prepared).await });
        let (id, _) =
            wait_tool_approval(&fixture, "identity-review", "background_read_output").await;
        let (token, _) = fixture
            .controller
            .gate
            .private_output_preview_checked(&id, &|| Ok(()))
            .await
            .unwrap();
        fixture
            .controller
            .gate
            .decide_private_output_with_expiry(
                &id,
                &action,
                &token,
                actor.review_origin_for_test(),
                actor.review_workspace_for_test(),
                fixture.controller.sink.as_ref(),
                i64::MAX,
                &|| Ok(()),
            )
            .await
            .unwrap();
        let approved = approval.await.unwrap().unwrap();
        if replace_session {
            fixture.live.state.lock().await.session_incarnation =
                Some(SessionIncarnation(Uuid::new_v4()));
        } else {
            fixture.controller.cancel.cancel();
        }
        assert!(actor.release_output(approved).await.is_err());
        fixture.controller.done.send_replace(true);
        fixture.manager.shutdown().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_background_review_is_bound_to_its_originating_actor() {
    let fixture = fixture().await;
    let (background, actor, request) = actor_fixture(&fixture).await;
    let action = started_through_actor(&fixture, &actor, "actor-start", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let other = BackgroundTurn::new(
        fixture.manager.clone(),
        background,
        actor_scope(&actor),
        7,
        request.scope.workspace.clone(),
        fixture.controller.clone(),
        crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
    )
    .unwrap();
    let before = approvals_shown(&fixture).await;
    let prepared = actor
        .prepare_output(&action, "foreign-review")
        .await
        .unwrap();
    assert!(other.approve_output(prepared).await.is_err());
    assert_eq!(approvals_shown(&fixture).await, before);

    let prepared = actor
        .prepare_output(&action, "origin-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let approval = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "origin-review", "background_read_output").await;
    let (token, _) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(()),
        )
        .await
        .unwrap();
    assert!(other
        .release_output(approval.await.unwrap().unwrap())
        .await
        .is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_background_review_does_not_prompt_after_logout() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action =
        started_through_actor(&fixture, &actor, "before-logout", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "after-logout-review")
        .await
        .unwrap();
    let before = approvals_shown(&fixture).await;
    fixture.app.logout_user("owner").unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        actor.approve_output(prepared),
    )
    .await;
    assert!(
        matches!(result, Ok(Err(_))),
        "revoked output should not reach review"
    );
    assert_eq!(approvals_shown(&fixture).await, before);
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_background_review_releases_only_the_frozen_snapshot() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(
        &fixture,
        &actor,
        "freeze-start",
        "printf initial; while [ ! -f continue ]; do sleep 0.05; done; printf later",
        10,
    )
    .await;
    actor
        .wait_output(&action, 0, std::time::Duration::from_secs(5))
        .await
        .unwrap();
    let prepared = actor
        .prepare_output(&action, "freeze-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let approval = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "freeze-review", "background_read_output").await;
    let (token, preview) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    assert_eq!(preview["stdout"], "initial");
    std::fs::write(fixture._workspace.path().join("continue"), b"go").unwrap();
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(()),
        )
        .await
        .unwrap();
    let released = actor
        .release_output(approval.await.unwrap().unwrap())
        .await
        .unwrap();
    assert_eq!(released.stdout, "initial");
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn followed_background_tail_requires_review_and_preserves_latest_output() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(
        &fixture,
        &actor,
        "tail-start",
        "head -c 66000 /dev/zero | tr '\\000' a; printf TAIL_END",
        10,
    )
    .await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let following: Arc<dyn BackgroundActor> = actor.clone();
    let following_action = action.clone();
    let task = tokio::spawn(async move {
        execute_actor(
            &following,
            "tail-review",
            "background_follow_output",
            &serde_json::json!({"actionId":following_action,"afterRevision":0,"timeoutSeconds":1}),
        )
        .await
    });
    let (id, _) = wait_tool_approval(&fixture, "tail-review", "background_read_output").await;
    assert!(!task.is_finished());
    let (token, preview) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    assert_eq!(preview["window"], "tail");
    assert_eq!(preview["stdoutTruncated"], true);
    assert!(preview["stdout"].as_str().unwrap().ends_with("TAIL_END"));
    fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(()),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&task.await.unwrap().unwrap()).unwrap();
    assert_eq!(value["window"], "tail");
    assert_eq!(value["stdout"], preview["stdout"]);
    assert_eq!(value["outputWithheld"], false);
    assert!(value["outputRevision"].as_u64().unwrap() > 0);
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn follow_waits_without_requesting_review_when_output_has_not_changed() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(&fixture, &actor, "quiet-start", "sleep 5", 10).await;
    let before = approvals_shown(&fixture).await;
    let bound: Arc<dyn BackgroundActor> = actor.clone();
    let output = execute_actor(
        &bound,
        "quiet-follow",
        "background_follow_output",
        &serde_json::json!({"actionId":action,"afterRevision":0,"timeoutSeconds":1}),
    )
    .await
    .unwrap();
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["outputRevision"], 0);
    assert_eq!(value["outputChanged"], false);
    assert_eq!(value["outputWithheld"], false);
    assert!(value.get("stdout").is_none());
    assert_eq!(approvals_shown(&fixture).await, before);
    actor.cancel(&action).await.unwrap();
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn followed_tail_freezes_review_and_denial_never_releases_output() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    std::fs::write(
        fixture._workspace.path().join("later-fixture"),
        b"SYNTHETIC_TAIL_TWO",
    )
    .unwrap();
    let action = started_through_actor(&fixture, &actor, "follow-freeze-start", "printf SYNTHETIC_TAIL_ONE; while [ ! -f continue ]; do sleep 0.05; done; cat later-fixture", 10).await;
    actor
        .wait_output(&action, 0, std::time::Duration::from_secs(5))
        .await
        .unwrap();
    let following: Arc<dyn BackgroundActor> = actor.clone();
    let selected = action.clone();
    let task = tokio::spawn(async move {
        execute_actor(
            &following,
            "follow-freeze-review",
            "background_follow_output",
            &serde_json::json!({"actionId":selected,"afterRevision":0,"timeoutSeconds":1}),
        )
        .await
    });
    let (id, _) =
        wait_tool_approval(&fixture, "follow-freeze-review", "background_read_output").await;
    let (token, preview) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    assert_eq!(preview["stdout"], "SYNTHETIC_TAIL_ONE");
    std::fs::write(fixture._workspace.path().join("continue"), b"go").unwrap();
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(()),
        )
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&task.await.unwrap().unwrap()).unwrap();
    assert_eq!(value["stdout"], "SYNTHETIC_TAIL_ONE");
    let following: Arc<dyn BackgroundActor> = actor.clone();
    let selected = action.clone();
    let revision = value["outputRevision"].as_u64().unwrap();
    let denied = tokio::spawn(async move {
        execute_actor(
            &following,
            "follow-denied-review",
            "background_follow_output",
            &serde_json::json!({"actionId":selected,"afterRevision":revision,"timeoutSeconds":1}),
        )
        .await
    });
    let (id, _) =
        wait_tool_approval(&fixture, "follow-denied-review", "background_read_output").await;
    let (_, preview) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    assert_eq!(preview["stdout"], "SYNTHETIC_TAIL_ONESYNTHETIC_TAIL_TWO");
    decide(&fixture, &id, false).await;
    assert!(denied.await.unwrap().unwrap_err().contains("denied"));
    let events = format!("{:?}", fixture.live.state.lock().await.events);
    assert!(!events.contains("SYNTHETIC_TAIL_TWO"));
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn followed_tail_cannot_be_released_after_logout() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action =
        started_through_actor(&fixture, &actor, "follow-logout-start", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let following: Arc<dyn BackgroundActor> = actor.clone();
    let selected = action.clone();
    let task = tokio::spawn(async move {
        execute_actor(
            &following,
            "follow-logout-review",
            "background_follow_output",
            &serde_json::json!({"actionId":selected,"afterRevision":0,"timeoutSeconds":1}),
        )
        .await
    });
    let (id, _) =
        wait_tool_approval(&fixture, "follow-logout-review", "background_read_output").await;
    let (token, _) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    fixture.app.logout_user("owner").unwrap();
    let _ = fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(()),
        )
        .await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_background_review_cannot_release_after_logout() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = started_through_actor(&fixture, &actor, "logout-start", "printf private", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let prepared = actor
        .prepare_output(&action, "logout-review")
        .await
        .unwrap();
    let approving = actor.clone();
    let approval = tokio::spawn(async move { approving.approve_output(prepared).await });
    let (id, _) = wait_tool_approval(&fixture, "logout-review", "background_read_output").await;
    let (token, _) = fixture
        .controller
        .gate
        .private_output_preview_checked(&id, &|| Ok(()))
        .await
        .unwrap();
    fixture
        .controller
        .gate
        .decide_private_output_with_expiry(
            &id,
            &action,
            &token,
            actor.review_origin_for_test(),
            actor.review_workspace_for_test(),
            fixture.controller.sink.as_ref(),
            i64::MAX,
            &|| Ok(()),
        )
        .await
        .unwrap();
    let approved = approval.await.unwrap().unwrap();
    fixture.app.logout_user("owner").unwrap();
    assert!(actor.release_output(approved).await.is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denied_background_output_never_enters_history_or_durable_storage() {
    fn tree_contains(path: &std::path::Path, needle: &[u8]) -> bool {
        std::fs::read_dir(path)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    tree_contains(&path, needle)
                } else {
                    std::fs::read(path).is_ok_and(|bytes| {
                        bytes.windows(needle.len()).any(|window| window == needle)
                    })
                }
            })
    }
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let secret = b"SYNTHETIC_DENIED_OUTPUT_MUST_NOT_BE_PERSISTED";
    std::fs::write(fixture._workspace.path().join("output-fixture"), secret).unwrap();
    let action =
        started_through_actor(&fixture, &actor, "privacy-start", "cat output-fixture", 5).await;
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    let before = approvals_shown(&fixture).await;
    let reviewing = actor.clone();
    let review_action = action.clone();
    let result = tokio::spawn(async move {
        BackgroundActor::review_output(reviewing.as_ref(), "privacy-review", &review_action).await
    });
    let (id, _) = wait_tool_approval(&fixture, "privacy-review", "background_read_output").await;
    decide(&fixture, &id, false).await;
    assert!(result.await.unwrap().unwrap_err().contains("denied"));
    assert_eq!(approvals_shown(&fixture).await, before + 1);
    let events = format!("{:?}", fixture.live.state.lock().await.events);
    assert!(
        !events
            .as_bytes()
            .windows(secret.len())
            .any(|window| window == secret),
        "denied output entered session history"
    );
    assert!(
        !tree_contains(fixture._data.path(), secret),
        "denied output entered durable storage"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_wait_output_notifies_without_releasing_output_and_rechecks_logout() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 1; printf private; sleep 2".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    let tool: Arc<dyn BackgroundActor> = actor.clone();
    let input =
        serde_json::json!({"actionId": request.action_id, "afterRevision": 0, "timeoutSeconds": 5});
    let notification = crate::v4_agent::background_process::tool::execute_actor(
        &tool,
        "follow-call",
        "background_wait_output",
        &input,
    )
    .await
    .unwrap();
    let notification: serde_json::Value = serde_json::from_str(&notification).unwrap();
    assert!(notification["outputRevision"].as_u64().unwrap() > 0);
    assert_eq!(notification["retention"], "current_server_memory_only");
    assert!(!notification.to_string().contains("private"));
    assert!(notification.get("stdout").is_none());
    fixture.app.logout_user("owner").unwrap();
    assert!(crate::v4_agent::background_process::tool::execute_actor(
        &tool,
        "follow-call",
        "background_wait_output",
        &input,
    )
    .await
    .is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_wait_output_does_not_return_after_logout_while_waiting() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 1".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    let tool: Arc<dyn BackgroundActor> = actor.clone();
    let input =
        serde_json::json!({"actionId": request.action_id, "afterRevision": 0, "timeoutSeconds": 3});
    let waiting = tokio::spawn(async move {
        crate::v4_agent::background_process::tool::execute_actor(
            &tool,
            "follow-call",
            "background_wait_output",
            &input,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    fixture.app.logout_user("owner").unwrap();
    assert!(waiting.await.unwrap().is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_list_returns_only_current_session_metadata_and_rechecks_logout() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.command = "sleep 30".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    let tool: Arc<dyn BackgroundActor> = actor.clone();
    let listed = crate::v4_agent::background_process::tool::execute_actor(
        &tool,
        "list-call",
        "background_list",
        &serde_json::json!({}),
    )
    .await
    .unwrap();
    let listed: serde_json::Value = serde_json::from_str(&listed).unwrap();
    assert_eq!(listed["retention"], "bounded_durable_and_memory");
    assert_eq!(listed["historyIncomplete"], true);
    assert_eq!(listed["memoryOnlyEntriesMayDisappear"], true);
    assert_eq!(listed["actions"].as_array().unwrap().len(), 1);
    assert_eq!(listed["actions"][0]["actionId"], request.action_id);
    assert_eq!(listed["actions"][0]["state"], "running");
    assert!(listed["actions"][0].get("stdout").is_none());
    fixture.app.logout_user("owner").unwrap();
    assert!(crate::v4_agent::background_process::tool::execute_actor(
        &tool,
        "list-call",
        "background_list",
        &serde_json::json!({}),
    )
    .await
    .is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

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
async fn revoked_origin_session_cannot_access_cancel_review_or_write_background_action() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.interactive = true;
    request.command = "printf synthetic; IFS= read -r line; printf '%s' \"$line\" > marker".into();
    let prepared = actor.prepare(&request).await.unwrap();
    let approved = approve_prepared(&fixture, &actor, prepared).await;
    actor.start_approved(approved).await.unwrap();
    let old_session = Uuid::new_v4().to_string();
    let fresh_session = Uuid::new_v4().to_string();
    {
        let db = fixture.app.lock_db().unwrap();
        db.execute("INSERT INTO users(id,username,password_hash,created_at,updated_at,auth_protocol_min) VALUES ('owner','fixture','fixture','now','now',1)", []).unwrap();
        for session in [&old_session, &fresh_session] {
            db.execute("INSERT INTO auth_sessions(id,user_id,generation,logout_capability_hash,revoked_at,created_at) VALUES (?1,'owner',0,'fixture',NULL,'now')", [session]).unwrap();
        }
    }
    let old_authority =
        crate::auth::LocalAuthority::for_test_session("owner", 0, i64::MAX, &old_session);
    let fresh_authority =
        crate::auth::LocalAuthority::for_test_session("owner", 0, i64::MAX, &fresh_session);
    let old = Arc::new(actor.with_test_authority(old_authority.clone()));
    let fresh = Arc::new(actor.with_test_authority(fresh_authority));
    let deadline = crate::v4_agent::interaction::now_ms() + 500;
    let mut callback_ran = false;
    let expired_result = _background.with_output_for_actor(
        &request.scope,
        &request.action_id,
        0,
        deadline,
        &fixture.controller.cancel,
        &old_authority,
        &fixture.app.local_admission().unwrap(),
        |_| {
            callback_ran = true;
            std::thread::sleep(std::time::Duration::from_millis(650));
            Ok("private output")
        },
    );
    assert!(callback_ran, "the read callback must run before expiry");
    assert!(
        expired_result.is_err(),
        "expired output must not be returned"
    );
    assert!(old.status(&request.action_id).await.is_ok());
    assert!(old.list().await.is_ok());
    assert!(old
        .prepare_output(&request.action_id, "before-revoke")
        .await
        .is_ok());
    assert!(fixture
        .app
        .logout_user_authorized("owner", &old_authority)
        .unwrap());
    assert!(old.status(&request.action_id).await.is_err());
    assert!(old.list().await.is_err());
    assert!(old.cancel(&request.action_id).await.is_err());
    assert!(old
        .prepare_output(&request.action_id, "after-revoke")
        .await
        .is_err());
    assert!(BackgroundActor::write_input(
        old.as_ref(),
        "write-after-revoke",
        &request.action_id,
        "unapproved\n"
    )
    .await
    .is_err());
    assert!(
        BackgroundActor::close_input(old.as_ref(), "close-after-revoke", &request.action_id)
            .await
            .is_err()
    );
    assert!(!fixture._workspace.path().join("marker").exists());
    assert!(fresh.status(&request.action_id).await.is_ok());
    assert!(fresh.cancel(&request.action_id).await.is_ok());
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
async fn interactive_start_approval_explicitly_discloses_input_capability() {
    let fixture = fixture().await;
    let (_background, actor, mut request) = actor_fixture(&fixture).await;
    request.interactive = true;
    let prepared = actor.prepare(&request).await.unwrap();
    let approving = actor.clone();
    let approval = tokio::spawn(async move { approving.approve(prepared, TEST_CALL).await });
    let event = decide_background_approval(&fixture, TEST_CALL, true).await;
    let StructuredSessionEvent::ApprovalRequired {
        tool_input,
        description,
        ..
    } = event
    else {
        panic!("expected approval")
    };
    assert_eq!(tool_input["interactive"], true);
    assert!(description.to_lowercase().contains("interactive input"));
    assert!(approval.await.unwrap().is_ok());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interactive_tool_requires_exact_input_approval_before_writing() {
    use crate::v4_agent::background_process::tool::{execute_actor, BackgroundActor};
    assert!(crate::v4_agent::background_process::tool::handles(
        "background_write"
    ));
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let start_actor: Arc<dyn BackgroundActor> = actor.clone();
    let start = tokio::spawn(async move {
        execute_actor(&start_actor, "interactive-start", "background_start", &serde_json::json!({"command":"IFS= read -r line; printf '%s' \"$line\" > marker", "timeoutSeconds":10, "interactive":true})).await
    });
    let (approval, description) =
        wait_tool_approval(&fixture, "interactive-start", "background_start").await;
    assert!(description.to_lowercase().contains("interactive input"));
    decide(&fixture, &approval, true).await;
    let started: serde_json::Value = serde_json::from_str(&start.await.unwrap().unwrap()).unwrap();
    let action = started["actionId"].as_str().unwrap().to_owned();

    let denied_actor: Arc<dyn BackgroundActor> = actor.clone();
    let denied_action = action.clone();
    let denied = tokio::spawn(async move {
        execute_actor(
            &denied_actor,
            "input-denied",
            "background_write",
            &serde_json::json!({"actionId":denied_action,"text":"denied\n"}),
        )
        .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "input-denied", "background_write").await;
    decide(&fixture, &approval, false).await;
    assert!(denied.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());

    let writer: Arc<dyn BackgroundActor> = actor.clone();
    let write_action = action.clone();
    let written = tokio::spawn(async move {
        execute_actor(
            &writer,
            "input-approved",
            "background_write",
            &serde_json::json!({"actionId":write_action,"text":"hello\u{202e}\n"}),
        )
        .await
    });
    let (approval, description) =
        wait_tool_approval(&fixture, "input-approved", "background_write").await;
    assert!(description.contains("hello\\u{202e}\\n"));
    assert!(!description.contains('\u{202e}'));
    assert!(description.contains("IFS= read -r line"));
    decide(&fixture, &approval, true).await;
    let result: serde_json::Value = serde_json::from_str(&written.await.unwrap().unwrap()).unwrap();
    assert_eq!(result["state"], "written_to_pipe");
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        std::fs::read_to_string(fixture._workspace.path().join("marker")).unwrap(),
        "hello\u{202e}"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interactive_close_requires_approval_and_allows_eof_dependent_command_to_finish() {
    use crate::v4_agent::background_process::tool::{execute_actor, BackgroundActor};
    assert!(crate::v4_agent::background_process::tool::handles(
        "background_close_input"
    ));
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let starter: Arc<dyn BackgroundActor> = actor.clone();
    let start = tokio::spawn(async move {
        execute_actor(
            &starter,
            "eof-start",
            "background_start",
            &serde_json::json!({"command":"cat > marker", "timeoutSeconds":10, "interactive":true}),
        )
        .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "eof-start", "background_start").await;
    decide(&fixture, &approval, true).await;
    let started: Value = serde_json::from_str(&start.await.unwrap().unwrap()).unwrap();
    let action = started["actionId"].as_str().unwrap().to_owned();
    let writer: Arc<dyn BackgroundActor> = actor.clone();
    let write_action = action.clone();
    let write = tokio::spawn(async move {
        execute_actor(
            &writer,
            "eof-write",
            "background_write",
            &serde_json::json!({"actionId":write_action,"text":"hello"}),
        )
        .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "eof-write", "background_write").await;
    decide(&fixture, &approval, true).await;
    assert!(write.await.unwrap().is_ok());
    let closer: Arc<dyn BackgroundActor> = actor.clone();
    let denied_action = action.clone();
    let denied = tokio::spawn(async move {
        execute_actor(
            &closer,
            "eof-denied",
            "background_close_input",
            &serde_json::json!({"actionId":denied_action}),
        )
        .await
    });
    let (approval, description) =
        wait_tool_approval(&fixture, "eof-denied", "background_close_input").await;
    assert!(description.contains("cat > marker"));
    assert!(description.to_lowercase().contains("end-of-file"));
    decide(&fixture, &approval, false).await;
    assert!(denied.await.unwrap().is_err());
    assert_eq!(
        actor.status(&action).await.unwrap().state,
        BackgroundState::Running
    );
    let closer: Arc<dyn BackgroundActor> = actor.clone();
    let close_action = action.clone();
    let close = tokio::spawn(async move {
        execute_actor(
            &closer,
            "eof-approved",
            "background_close_input",
            &serde_json::json!({"actionId":close_action}),
        )
        .await
    });
    let (approval, _) =
        wait_tool_approval(&fixture, "eof-approved", "background_close_input").await;
    decide(&fixture, &approval, true).await;
    let result: Value = serde_json::from_str(&close.await.unwrap().unwrap()).unwrap();
    assert_eq!(result["state"], "input_closed");
    assert_eq!(result["eofConsumptionConfirmed"], false);
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        std::fs::read_to_string(fixture._workspace.path().join("marker")).unwrap(),
        "hello"
    );
    let receipts = rusqlite::Connection::open(
        fixture
            ._data
            .path()
            .join("background-processes/receipts.sqlite3"),
    )
    .unwrap();
    let delivered: i64 = receipts
        .query_row(
            "SELECT COUNT(*) FROM background_input_receipts WHERE state='delivered'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(delivered, 2);
    drop(receipts);
    let closer: Arc<dyn BackgroundActor> = actor.clone();
    assert!(execute_actor(
        &closer,
        "eof-approved",
        "background_close_input",
        &serde_json::json!({"actionId":action})
    )
    .await
    .is_err());
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interactive_binary_input_requires_exact_review_and_preserves_bytes() {
    use crate::v4_agent::background_process::tool::{execute_actor, BackgroundActor};
    use base64::Engine;
    assert!(crate::v4_agent::background_process::tool::handles(
        "background_write_bytes"
    ));
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let starter: Arc<dyn BackgroundActor> = actor.clone();
    let start = tokio::spawn(async move {
        execute_actor(
            &starter,
            "binary-start",
            "background_start",
            &serde_json::json!({"command":"cat > marker", "timeoutSeconds":10, "interactive":true}),
        )
        .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "binary-start", "background_start").await;
    decide(&fixture, &approval, true).await;
    let started: Value = serde_json::from_str(&start.await.unwrap().unwrap()).unwrap();
    let action = started["actionId"].as_str().unwrap().to_owned();
    let direct: Arc<dyn BackgroundActor> = actor.clone();
    let approvals_before = approvals_shown(&fixture).await;
    assert!(execute_actor(
        &direct,
        "invalid-binary",
        "background_write_bytes",
        &serde_json::json!({"actionId":&action,"base64":"not base64"})
    )
    .await
    .is_err());
    let too_large = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 513]);
    assert!(execute_actor(
        &direct,
        "oversized-binary",
        "background_write_bytes",
        &serde_json::json!({"actionId":&action,"base64":too_large})
    )
    .await
    .is_err());
    assert_eq!(approvals_shown(&fixture).await, approvals_before);
    let writer: Arc<dyn BackgroundActor> = actor.clone();
    let write_action = action.clone();
    let write = tokio::spawn(async move {
        execute_actor(
            &writer,
            "binary-write",
            "background_write_bytes",
            &serde_json::json!({"actionId":write_action,"base64":"AP+AQQ=="}),
        )
        .await
    });
    let (approval, description) =
        wait_tool_approval(&fixture, "binary-write", "background_write_bytes").await;
    assert!(description.contains("00 ff 80 41"));
    assert!(description.contains("cat > marker"));
    decide(&fixture, &approval, true).await;
    let written: Value = serde_json::from_str(&write.await.unwrap().unwrap()).unwrap();
    assert_eq!(written["bytes"], 4);
    let closer: Arc<dyn BackgroundActor> = actor.clone();
    let close_action = action.clone();
    let close = tokio::spawn(async move {
        execute_actor(
            &closer,
            "binary-close",
            "background_close_input",
            &serde_json::json!({"actionId":close_action}),
        )
        .await
    });
    let (approval, _) =
        wait_tool_approval(&fixture, "binary-close", "background_close_input").await;
    decide(&fixture, &approval, true).await;
    assert!(close.await.unwrap().is_ok());
    assert_eq!(
        terminal(&actor, &action).await,
        BackgroundState::Exited { code: Some(0) }
    );
    assert_eq!(
        std::fs::read(fixture._workspace.path().join("marker")).unwrap(),
        [0x00, 0xff, 0x80, 0x41]
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_close_approval_does_not_send_eof_or_claim_an_operation() {
    use crate::v4_agent::background_process::tool::{execute_actor, BackgroundActor};
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let starter: Arc<dyn BackgroundActor> = actor.clone();
    let start = tokio::spawn(async move {
        execute_actor(&starter, "cancel-eof-start", "background_start", &serde_json::json!({"command":"cat >/dev/null; printf finished > marker", "timeoutSeconds":10, "interactive":true})).await
    });
    let (approval, _) = wait_tool_approval(&fixture, "cancel-eof-start", "background_start").await;
    decide(&fixture, &approval, true).await;
    let started: Value = serde_json::from_str(&start.await.unwrap().unwrap()).unwrap();
    let closer: Arc<dyn BackgroundActor> = actor.clone();
    let action = started["actionId"].clone();
    let close = tokio::spawn(async move {
        execute_actor(
            &closer,
            "cancel-eof",
            "background_close_input",
            &serde_json::json!({"actionId":action}),
        )
        .await
    });
    wait_tool_approval(&fixture, "cancel-eof", "background_close_input").await;
    fixture.controller.cancel.cancel();
    assert!(close.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    assert_eq!(
        std::fs::read(
            fixture
                ._data
                .path()
                .join(".background-processes.background-guard")
        )
        .unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

async fn start_interactive_fixture(
    fixture: &Fixture,
    actor: &Arc<BackgroundTurn>,
    call: &str,
) -> String {
    let starter = actor.clone();
    let call_id = call.to_owned();
    let task = tokio::spawn(async move {
        BackgroundActor::start_interactive(
            starter,
            &call_id,
            "IFS= read -r line; printf '%s' \"$line\" > marker",
            std::time::Duration::from_secs(10),
        )
        .await
    });
    let (approval, _) = wait_tool_approval(fixture, call, "background_start").await;
    decide(fixture, &approval, true).await;
    task.await.unwrap().unwrap().0
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_turn_during_input_approval_never_writes_or_claims() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = start_interactive_fixture(&fixture, &actor, "cancel-input-start").await;
    let writer = actor.clone();
    let task = tokio::spawn(async move {
        BackgroundActor::write_input(writer.as_ref(), "cancel-input", &action, "should-not-run\n")
            .await
    });
    wait_tool_approval(&fixture, "cancel-input", "background_write").await;
    fixture.controller.cancel.cancel();
    assert!(task.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    assert_eq!(
        std::fs::read(
            fixture
                ._data
                .path()
                .join(".background-processes.background-guard")
        )
        .unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approved_input_does_not_write_after_command_is_cancelled() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = start_interactive_fixture(&fixture, &actor, "stopped-input-start").await;
    let writer = actor.clone();
    let write_action = action.clone();
    let task = tokio::spawn(async move {
        BackgroundActor::write_input(
            writer.as_ref(),
            "stopped-input",
            &write_action,
            "should-not-run\n",
        )
        .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "stopped-input", "background_write").await;
    actor.cancel(&action).await.unwrap();
    assert_eq!(terminal(&actor, &action).await, BackgroundState::Cancelled);
    decide(&fixture, &approval, true).await;
    assert!(task.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    assert_eq!(
        std::fs::read(
            fixture
                ._data
                .path()
                .join(".background-processes.background-guard")
        )
        .unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approved_input_does_not_cross_a_replaced_session_identity() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = start_interactive_fixture(&fixture, &actor, "replaced-input-start").await;
    let writer = actor.clone();
    let task = tokio::spawn(async move {
        BackgroundActor::write_input(
            writer.as_ref(),
            "replaced-input",
            &action,
            "should-not-run\n",
        )
        .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "replaced-input", "background_write").await;
    fixture.live.state.lock().await.session_incarnation = Some(SessionIncarnation(Uuid::new_v4()));
    fixture
        .controller
        .gate
        .decide(&approval, true, fixture.controller.sink.as_ref())
        .await
        .unwrap();
    assert!(task.await.unwrap().is_err());
    assert!(!fixture._workspace.path().join("marker").exists());
    assert_eq!(
        std::fs::read(
            fixture
                ._data
                .path()
                .join(".background-processes.background-guard")
        )
        .unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logout_during_input_approval_never_writes_to_the_command() {
    let fixture = fixture().await;
    let (_background, actor, _) = actor_fixture(&fixture).await;
    let action = start_interactive_fixture(&fixture, &actor, "logout-input-start").await;
    let writer = actor.clone();
    let task = tokio::spawn(async move {
        BackgroundActor::write_input(writer.as_ref(), "logout-input", &action, "should-not-run\n")
            .await
    });
    let (approval, _) = wait_tool_approval(&fixture, "logout-input", "background_write").await;
    fixture.app.logout_user("owner").unwrap();
    let _ = fixture
        .controller
        .gate
        .decide(&approval, true, fixture.controller.sink.as_ref())
        .await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(!fixture._workspace.path().join("marker").exists());
    assert_eq!(
        std::fs::read(
            fixture
                ._data
                .path()
                .join(".background-processes.background-guard")
        )
        .unwrap(),
        b"v4-background-ledger-v2-ready\n"
    );
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
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
        interactive: false,
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
async fn output_is_withheld_when_private_review_is_denied() {
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

    let before = approvals_shown(&fixture).await;
    let reviewing = actor.clone();
    let result = tokio::spawn(async move {
        BackgroundActor::review_output(reviewing.as_ref(), "review", &action).await
    });
    let (id, _) = wait_tool_approval(&fixture, "review", "background_read_output").await;
    decide(&fixture, &id, false).await;
    assert!(result.await.unwrap().unwrap_err().contains("denied"));
    assert_eq!(approvals_shown(&fixture).await, before + 1);
    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
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
    let listed = actor.list().await.unwrap();
    let state_for = |id: &str| {
        listed
            .iter()
            .find(|(action, _)| action == id)
            .map(|(_, snapshot)| snapshot.state.clone())
    };
    assert_eq!(
        state_for(&finished),
        Some(BackgroundState::Exited { code: Some(0) })
    );
    assert_eq!(
        state_for(&failed),
        Some(BackgroundState::Exited { code: Some(3) })
    );
    assert_eq!(state_for(&crashed), Some(BackgroundState::Unknown));
    assert!(listed
        .iter()
        .all(|(_, snapshot)| snapshot.stdout.is_empty() && snapshot.stderr.is_empty()));
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
async fn real_agent_turn_requires_private_review_before_releasing_background_output() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        routing::post,
        Json, Router,
    };
    use tower::ServiceExt;
    let fixture = fixture().await;
    std::fs::write(
        fixture._workspace.path().join("denied-output-file"),
        b"SYNTHETIC_DENIED_PROVIDER_OUTPUT",
    )
    .unwrap();
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
                6 => tool_call_response("bg-output", "background_follow_output", serde_json::json!({"actionId":action(0),"afterRevision":0,"timeoutSeconds":1})),
                7 => tool_call_response("bg-denied-start", "background_start", serde_json::json!({"command":"cat denied-output-file","timeoutSeconds":10})),
                8 => tool_call_response("bg-denied-wait", "background_wait", serde_json::json!({"actionId":action(7),"timeoutSeconds":10})),
                9 => tool_call_response("bg-denied-read", "background_read_output", serde_json::json!({"actionId":action(7)})),
                10 => tool_call_response("bg-list", "background_list", serde_json::json!({})),
                11 => tool_call_response("bg-follow", "background_wait_output", serde_json::json!({"actionId":action(3),"afterRevision":0,"timeoutSeconds":1})),
                12 => tool_call_response("bg-interactive", "background_start", serde_json::json!({"command":"cat > interactive-marker","timeoutSeconds":10,"interactive":true})),
                13 => tool_call_response("bg-input", "background_write", serde_json::json!({"actionId":action(12),"text":"scripted-hello\n"})),
                14 => tool_call_response("bg-eof", "background_close_input", serde_json::json!({"actionId":action(12)})),
                15 => tool_call_response("bg-interactive-wait", "background_wait", serde_json::json!({"actionId":action(12),"timeoutSeconds":10})),
                16 => tool_call_response("bg-binary-start", "background_start", serde_json::json!({"command":"cat > binary-marker","timeoutSeconds":10,"interactive":true})),
                17 => tool_call_response("bg-binary-write", "background_write_bytes", serde_json::json!({"actionId":action(16),"base64":"AP+AQQ=="})),
                18 => tool_call_response("bg-binary-close", "background_close_input", serde_json::json!({"actionId":action(16)})),
                19 => tool_call_response("bg-binary-wait", "background_wait", serde_json::json!({"actionId":action(16),"timeoutSeconds":10})),
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
            let (_, paired) = crate::paired_environments::synthetic_input_grant(&app, "owner");
            let router = crate::app(app.clone());
            let mut decided = std::collections::HashSet::new();
            let mut read_count = 0;
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
                            tool_call_id,
                            tool_input,
                            ..
                        } if tool_name.starts_with("background_") && !decided.contains(id) => {
                            Some((
                                id.clone(),
                                tool_name.clone(),
                                description.clone(),
                                tool_call_id.clone(),
                                tool_input.clone(),
                            ))
                        }
                        _ => None,
                    })
                    .collect();
                for (approval, tool, description, _call, input) in pending {
                    if tool == "background_read_output" && read_count == 0 {
                        let base = format!("/api/structured/sessions/{session}/private-output");
                        let post = |path: String, body: Value| {
                            Request::post(path)
                                .header("authorization", format!("Bearer {paired}"))
                                .header("content-type", "application/json")
                                .body(Body::from(body.to_string()))
                                .unwrap()
                        };
                        let mut response = router.clone().oneshot(post(format!("{base}/preview"), serde_json::json!({"approvalId":approval,"actionId":input["actionId"]}))).await.unwrap();
                        for _ in 0..20 {
                            if response.status() != StatusCode::CONFLICT {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                            response = router.clone().oneshot(post(format!("{base}/preview"), serde_json::json!({"approvalId":approval,"actionId":input["actionId"]}))).await.unwrap();
                        }
                        assert_eq!(response.status(), StatusCode::OK);
                        let preview: Value = serde_json::from_slice(
                            &to_bytes(response.into_body(), 1_048_576).await.unwrap(),
                        )
                        .unwrap();
                        assert_eq!(preview["output"]["stdout"], "out-ok");
                        let response = router.clone().oneshot(post(format!("{base}/approve"), serde_json::json!({"approvalId":approval,"actionId":input["actionId"],"previewToken":preview["previewToken"]}))).await.unwrap();
                        assert_eq!(response.status(), StatusCode::OK);
                    } else {
                        manager
                            .approve_with_paired(
                                "owner",
                                &session,
                                Some(&approval),
                                tool != "background_read_output",
                                None,
                                false,
                                None,
                                Some(&authority),
                                None,
                                &app,
                            )
                            .await
                            .unwrap();
                    }
                    if tool == "background_read_output" {
                        read_count += 1;
                    }
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
            "background_read_output",
            "background_start",
            "background_read_output",
            "background_start",
            "background_write",
            "background_close_input",
            "background_start",
            "background_write_bytes",
            "background_close_input"
        ]
    );

    let bodies = bodies.lock().unwrap();
    let results = tool_results(bodies.last().unwrap());
    assert_eq!(
        results.len(),
        20,
        "{:?}",
        bodies.last().unwrap()["messages"]
    );
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
        results[6]["stdout"], "out-ok",
        "reviewed tool result: {:?}",
        results[6]
    );
    assert_eq!(results[6]["stderr"], "err-ok");
    assert_eq!(results[6]["window"], "tail");
    assert_eq!(results[6]["outputChanged"], true);
    assert!(!bodies
        .last()
        .unwrap()
        .to_string()
        .contains("SYNTHETIC_DENIED_PROVIDER_OUTPUT"));
    assert_eq!(
        results[10]["retention"], "bounded_durable_and_memory",
        "background_list result: {:?}",
        results[10]
    );
    assert_eq!(results[10]["actions"].as_array().unwrap().len(), 3);
    assert!(results[10]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["actionId"] == results[0]["actionId"]));
    assert!(!results[10].to_string().contains("out-ok"));
    assert_eq!(results[11]["retention"], "current_server_memory_only");
    assert_eq!(results[11]["state"], "cancelled");
    assert!(results[11]["outputRevision"].is_u64());
    assert!(results[11].get("stdout").is_none());
    assert_eq!(results[12]["state"], "running");
    assert_eq!(results[13]["state"], "written_to_pipe");
    assert_eq!(results[13]["consumptionConfirmed"], false);
    assert_eq!(results[14]["state"], "input_closed");
    assert_eq!(results[14]["eofConsumptionConfirmed"], false);
    assert_eq!(results[15]["state"], "exited");
    assert_eq!(
        std::fs::read_to_string(root.join("interactive-marker")).unwrap(),
        "scripted-hello\n"
    );
    assert_eq!(results[16]["state"], "running");
    assert_eq!(results[17]["state"], "written_to_pipe");
    assert_eq!(results[17]["bytes"], 4);
    assert_eq!(results[18]["state"], "input_closed");
    assert_eq!(results[19]["state"], "exited");
    assert_eq!(
        std::fs::read(root.join("binary-marker")).unwrap(),
        [0x00, 0xff, 0x80, 0x41]
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
