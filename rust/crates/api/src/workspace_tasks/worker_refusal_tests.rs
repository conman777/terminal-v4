use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

struct Refused {
    _dir: tempfile::TempDir,
    data: PathBuf,
    workspace: PathBuf,
    state: AppState,
    schedule: ScheduleRecord,
}

async fn send(
    state: &AppState,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let router = routes()
        .layer(Extension(AuthenticatedUser {
            user_id: "owner".into(),
            username: "fixture".into(),
        }))
        .with_state(state.clone());
    let response = router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

fn schedule_json(workspace: &FsPath) -> serde_json::Value {
    serde_json::json!({
        "workspacePath": workspace, "provider": "claude", "prompt": "Review",
        "name": "Review", "intervalSeconds": 60, "enabled": true,
        "parentSessionId": "ss-parent"
    })
}

fn schedule_input(workspace: &FsPath) -> ScheduleInput {
    serde_json::from_value(schedule_json(workspace)).unwrap()
}

async fn refused_fixture(protocol: u64) -> Refused {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let data = root.join("data");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let schedule = create_owner_schedule(data.clone(), "owner".into(), schedule_input(&workspace))
        .await
        .unwrap();
    std::fs::write(
        data.join("workspace-tasks/worker-protocol.json"),
        format!("{{\"protocol\":{protocol}}}"),
    )
    .unwrap();
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    })
    .unwrap();
    start_worker(state.clone());
    Refused {
        _dir: dir,
        data,
        workspace,
        state,
        schedule,
    }
}

#[tokio::test]
async fn refused_worker_reports_status_and_capabilities() {
    let fixture = refused_fixture(999).await;
    let status = await_worker_settled(&fixture.data, std::time::Duration::from_secs(5)).await;
    assert_eq!(
        status,
        Some(WorkerStatus::Refused {
            reason: WORKER_REFUSED_REASON
        })
    );
    let (code, body) = send(
        &fixture.state,
        "GET",
        "/api/workspace/schedules/capabilities",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(
        (code, body),
        (
            StatusCode::OK,
            serde_json::json!({
                "advancedTimingProtocolVersion": 1,
                "workerAvailable": false,
                "workerReason": WORKER_REFUSED_REASON
            })
        )
    );
}

#[tokio::test]
async fn refused_worker_rejects_mutating_routes_but_allows_reads_and_removal() {
    let fixture = refused_fixture(999).await;
    await_worker_settled(&fixture.data, std::time::Duration::from_secs(5)).await;
    let id = fixture.schedule.id;
    let task = serde_json::json!({"workspacePath": fixture.workspace, "provider":"claude", "prompt":"Review"});
    let before = std::fs::read(store_path(&fixture.data, "owner")).ok();
    let mut codes = Vec::new();
    for (method, uri, body) in [
        ("POST", "/api/workspace/tasks".to_string(), task),
        (
            "POST",
            "/api/workspace/schedules".to_string(),
            schedule_json(&fixture.workspace),
        ),
        (
            "POST",
            format!("/api/workspace/schedules/{id}/run"),
            serde_json::json!({}),
        ),
        (
            "PATCH",
            format!("/api/workspace/schedules/{id}"),
            serde_json::json!({"enabled": true}),
        ),
    ] {
        let (code, body) = send(&fixture.state, method, &uri, body).await;
        codes.push((
            uri,
            code,
            body["error"].as_str().map(|m| m.contains("newer version")),
        ));
    }
    assert_eq!(
        codes
            .iter()
            .map(|(_, code, mentions)| (*code, *mentions))
            .collect::<Vec<_>>(),
        vec![(StatusCode::SERVICE_UNAVAILABLE, Some(true)); 4],
        "{codes:?}"
    );
    assert_eq!(
        before,
        std::fs::read(store_path(&fixture.data, "owner")).ok()
    );
    assert_eq!(
        send(
            &fixture.state,
            "GET",
            "/api/workspace/tasks",
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        send(
            &fixture.state,
            "DELETE",
            &format!("/api/workspace/schedules/{id}"),
            serde_json::Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn refused_worker_blocks_agent_schedule_creation_and_start_actions() {
    let fixture = refused_fixture(999).await;
    await_worker_settled(&fixture.data, std::time::Duration::from_secs(5)).await;
    let created = prepare_reviewed_schedule(
        fixture.data.clone(),
        "owner".into(),
        "ss-parent".into(),
        "turn".into(),
        schedule_input(&fixture.workspace),
        None,
    )
    .await;
    assert_eq!(
        created.err().map(|error| error.status),
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );
    let direct = create_owner_schedule(
        fixture.data.clone(),
        "owner".into(),
        schedule_input(&fixture.workspace),
    )
    .await;
    assert_eq!(
        direct.err().map(|error| error.status),
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );
    let mut results = Vec::new();
    for action in [
        ScheduleChange::Resume,
        ScheduleChange::Run,
        ScheduleChange::Pause,
        ScheduleChange::Remove,
    ] {
        let result = prepare_reviewed_schedule_change(
            fixture.data.clone(),
            "owner".into(),
            "ss-parent".into(),
            "turn".into(),
            fixture.workspace.to_string_lossy().into_owned(),
            fixture.schedule.id,
            action,
        )
        .await;
        results.push(match result {
            Ok(_) => "ok".to_string(),
            Err(message) if message.contains("newer version") => "unavailable".to_string(),
            Err(message) => message,
        });
    }
    assert_eq!(results, ["unavailable", "unavailable", "ok", "ok"]);
}

#[tokio::test]
async fn running_worker_reports_available() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().canonicalize().unwrap().join("data");
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data.clone(),
        ..Default::default()
    })
    .unwrap();
    start_worker(state.clone());
    let status = await_worker_settled(&data, std::time::Duration::from_secs(5)).await;
    let (_, body) = send(
        &state,
        "GET",
        "/api/workspace/schedules/capabilities",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(
        (
            status,
            body["workerAvailable"].clone(),
            body["workerReason"].clone()
        ),
        (
            Some(WorkerStatus::Running),
            serde_json::json!(true),
            serde_json::Value::Null
        )
    );
}

#[tokio::test]
async fn unmanaged_data_dir_is_available() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(worker_status(&dir.path().join("data")), None);
    assert!(require_worker(&dir.path().join("data")).is_ok());
}
