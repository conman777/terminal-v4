use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

fn utc(text: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(text)
        .unwrap()
        .timestamp_millis() as u64
}

fn cron_time(expression: &str, zone: Option<&str>) -> CalendarTime {
    serde_json::from_value(serde_json::json!({"cron": expression, "timeZone": zone})).unwrap()
}

fn task_input(workspace: &str) -> TaskInput {
    TaskInput {
        workspace_path: workspace.into(),
        provider: "codex".into(),
        prompt: "Review".into(),
        model: None,
        parent_session_id: None,
        parent_task_id: None,
    }
}

fn schedule(workspace: &str, at: Option<CalendarTime>, next: u64) -> ScheduleRecord {
    ScheduleRecord {
        id: Uuid::new_v4(),
        name: "Cron".into(),
        input: task_input(workspace),
        interval_seconds: 60,
        at,
        run_once_at: None,
        enabled: true,
        next_run_at: Some(next),
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

#[test]
fn cron_time_deserializes_only_consistent_shapes_and_round_trips() {
    let accepted = [
        serde_json::json!({"cron":"0 9 * * 1-5","timeZone":"Europe/Berlin"}),
        serde_json::json!({"cron":"*/5 * * * *","hour":0,"minute":0,"weekdays":[]}),
        serde_json::json!({"hour":9,"minute":0,"weekdays":[1]}),
    ];
    let rejected = [
        serde_json::json!({"cron":"0 9 * * *","hour":9}),
        serde_json::json!({"cron":"0 9 * * *","weekdays":[1]}),
        serde_json::json!({"hour":9,"minute":0}),
        serde_json::json!({"weekdays":[1]}),
        serde_json::json!({"cron":"0 9 * * *","extra":true}),
    ];
    for value in accepted {
        let parsed: CalendarTime = serde_json::from_value(value).unwrap();
        let again: CalendarTime =
            serde_json::from_slice(&serde_json::to_vec(&parsed).unwrap()).unwrap();
        assert_eq!(parsed, again);
    }
    for value in rejected {
        assert!(
            serde_json::from_value::<CalendarTime>(value.clone()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn cron_validation_rejects_malformed_unreachable_and_bad_zone_inputs() {
    for (expression, zone, ok) in [
        ("0 9 * * 1-5", Some("America/New_York"), true),
        ("*/15 * * * *", None, true),
        ("0 0 29 2 *", Some("UTC"), true),
        ("0 9 * *", None, false),
        ("0 9 31 2 *", None, false),
        ("61 * * * *", None, false),
        ("0 9 * * *", Some("Not/A_Zone"), false),
    ] {
        assert_eq!(
            validate_calendar(&cron_time(expression, zone)).is_ok(),
            ok,
            "{expression} {zone:?}"
        );
    }
}

#[test]
fn cron_next_run_honours_fixed_offsets_and_named_zones() {
    let now = utc("2025-01-06T00:00:00Z");
    let mut offset = cron_time("30 8 * * *", None);
    offset.utc_offset_minutes = 330;
    assert_eq!(
        [
            next_calendar_run(now, &offset),
            next_calendar_run(now, &cron_time("30 8 * * *", Some("Asia/Kolkata"))),
            next_calendar_run(now, &cron_time("30 8 * * *", Some("UTC"))),
        ],
        [
            utc("2025-01-06T03:00:00Z"),
            utc("2025-01-06T03:00:00Z"),
            utc("2025-01-06T08:30:00Z"),
        ]
    );
}

fn run_instants(zone: &str, expression: &str, start: &str, runs: usize) -> Vec<u64> {
    let at = cron_time(expression, Some(zone));
    let mut store = TaskStore {
        owner_id: "owner".into(),
        ..Default::default()
    };
    let first = next_calendar_run(utc(start), &at);
    store.schedules.push(schedule("/work", Some(at), first));
    let mut clock = first;
    let mut instants = Vec::new();
    for _ in 0..runs {
        queue_due_schedules(&mut store, clock, |_| true);
        let task = store.tasks.last_mut().unwrap();
        assert_eq!(task.created_at, clock);
        instants.push(task.created_at);
        transition(task, TaskStatus::Completed, "done", clock);
        let next = store.schedules[0].next_run_at.unwrap();
        assert!(next > clock);
        clock = next;
    }
    assert_eq!(store.tasks.len(), runs);
    instants
}

#[test]
fn queued_cron_runs_fire_once_per_day_through_dst_gaps_and_folds() {
    let cases = [
        (
            "America/New_York",
            "30 2 * * *",
            "2025-03-08T00:00:00Z",
            vec![
                "2025-03-08T07:30:00Z",
                "2025-03-09T07:00:00Z",
                "2025-03-10T06:30:00Z",
                "2025-03-11T06:30:00Z",
            ],
        ),
        (
            "America/New_York",
            "30 1 * * *",
            "2025-11-01T00:00:00Z",
            vec![
                "2025-11-01T05:30:00Z",
                "2025-11-02T05:30:00Z",
                "2025-11-03T06:30:00Z",
                "2025-11-04T06:30:00Z",
            ],
        ),
        (
            "Europe/Berlin",
            "30 2 * * *",
            "2025-03-29T00:00:00Z",
            vec![
                "2025-03-29T01:30:00Z",
                "2025-03-30T01:00:00Z",
                "2025-03-31T00:30:00Z",
            ],
        ),
        (
            "Europe/Berlin",
            "30 2 * * *",
            "2025-10-25T00:00:00Z",
            vec![
                "2025-10-25T00:30:00Z",
                "2025-10-26T00:30:00Z",
                "2025-10-27T01:30:00Z",
            ],
        ),
    ];
    for (zone, expression, start, expected) in cases {
        let expected: Vec<_> = expected.into_iter().map(utc).collect();
        assert_eq!(
            run_instants(zone, expression, start, expected.len()),
            expected,
            "{zone} {expression}"
        );
    }
}

#[test]
fn cron_schedule_downtime_is_reported_missed_and_resumes_at_the_next_slot() {
    let at = cron_time("0 9 * * *", Some("Europe/Berlin"));
    let due = utc("2025-03-01T08:00:00Z");
    let mut store = TaskStore {
        owner_id: "owner".into(),
        ..Default::default()
    };
    store.schedules.push(schedule("/work", Some(at), due));
    let now = utc("2025-03-04T12:00:00Z");
    skip_stale_runs(&mut store, now);
    queue_due_schedules(&mut store, now, |_| true);
    assert_eq!(
        (
            store.schedules[0].missed_runs,
            store.schedules[0].next_run_at,
            store.tasks.len()
        ),
        (1, Some(utc("2025-03-05T08:00:00Z")), 0)
    );
}

#[tokio::test]
async fn cron_schedule_persists_with_the_advanced_format_and_survives_restart() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    let mut task = task_input(&workspace.to_string_lossy());
    task.prompt = "Weekday review".into();
    let saved = create_owner_schedule(
        data.path().into(),
        "owner".into(),
        ScheduleInput {
            task,
            name: "Cron".into(),
            interval_seconds: 0,
            enabled: true,
            at: Some(cron_time("0 9 * * 1-5", Some("America/New_York"))),
            run_once_at: None,
            deliver_to: None,
        },
    )
    .await
    .unwrap();
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store_path(data.path(), "owner")).unwrap()).unwrap();
    let stored = &raw["schedules"][0];
    assert_eq!(
        (
            stored["at"]["cron"].clone(),
            stored["at"]["timeZone"].clone(),
            stored["intervalSeconds"].clone(),
            stored.get("lastStatus").is_none(),
        ),
        (
            serde_json::json!("0 9 * * 1-5"),
            serde_json::json!("America/New_York"),
            serde_json::json!({"advancedFormat": 1, "seconds": 0}),
            true
        )
    );
    let reloaded = read_store(data.path(), "owner")
        .unwrap()
        .schedules
        .remove(0);
    assert_eq!(
        (reloaded.at.clone(), reloaded.next_run_at),
        (saved.at.clone(), saved.next_run_at)
    );
    assert_eq!(
        saved.next_run_at,
        Some(next_calendar_run(
            saved.created_at,
            saved.at.as_ref().unwrap()
        ))
    );
    for bad in [cron_time("0 9 * *", None), cron_time("0 0 31 2 *", None)] {
        let mut task = task_input(&workspace.to_string_lossy());
        task.prompt = "Bad".into();
        assert!(create_owner_schedule(
            data.path().into(),
            "owner".into(),
            ScheduleInput {
                task,
                name: "Bad".into(),
                interval_seconds: 0,
                enabled: true,
                at: Some(bad),
                run_once_at: None,
                deliver_to: None,
            },
        )
        .await
        .is_err());
    }
    assert_eq!(read_store(data.path(), "owner").unwrap().schedules.len(), 1);
}

fn outcome_store(data: &FsPath, owner: &str, workspace: &str) -> (TaskStore, Uuid) {
    let mut store = TaskStore {
        owner_id: owner.into(),
        ..Default::default()
    };
    let mut task = enqueue(&mut store, task_input(workspace), None, 10).unwrap();
    task.error = Some(format!("password=hunter2 {}", "x".repeat(2_000)));
    task.exit_code = Some(3);
    transition(&mut task, TaskStatus::Failed, "failed", 20);
    store.tasks[0] = task.clone();
    let mut linked = schedule(workspace, None, 5_000_000_000_000);
    linked.last_task_id = Some(task.id);
    let mut never_ran = schedule(workspace, None, 5_000_000_000_000);
    never_ran.name = "Never ran".into();
    let mut deleted = schedule(workspace, None, 5_000_000_000_000);
    deleted.name = "Deleted task".into();
    deleted.last_task_id = Some(Uuid::new_v4());
    let id = linked.id;
    store.schedules.extend([linked, never_ran, deleted]);
    write_store(data, &store).unwrap();
    (store, id)
}

#[test]
fn last_outcome_is_joined_bounded_redacted_and_never_persisted() {
    let data = tempfile::tempdir().unwrap();
    let (store, linked) = outcome_store(data.path(), "owner", "/work");
    let listed = with_last_outcomes(store.schedules.clone(), &store.tasks);
    let first = listed.iter().find(|item| item.id == linked).unwrap();
    assert_eq!(first.last_status, Some(TaskStatus::Failed));
    let error = first.last_error.as_deref().unwrap();
    assert!(error.chars().count() <= LAST_ERROR_LIMIT);
    assert!(!error.contains("hunter2"));
    assert_eq!(
        listed
            .iter()
            .filter(|item| item.last_status.is_none() && item.last_error.is_none())
            .count(),
        2
    );
    let raw = std::fs::read_to_string(store_path(data.path(), "owner")).unwrap();
    assert!(!raw.contains("lastStatus") && !raw.contains("lastError"));
}

#[test]
fn failed_task_without_message_reports_its_exit_code() {
    let mut store = TaskStore {
        owner_id: "owner".into(),
        ..Default::default()
    };
    let mut task = enqueue(&mut store, task_input("/work"), None, 1).unwrap();
    task.exit_code = Some(7);
    transition(&mut task, TaskStatus::Failed, "failed", 2);
    let mut linked = schedule("/work", None, 9);
    linked.last_task_id = Some(task.id);
    let listed = with_last_outcomes(vec![linked], &[task]);
    assert_eq!(
        (listed[0].last_status.clone(), listed[0].last_error.clone()),
        (Some(TaskStatus::Failed), Some("Exited with code 7".into()))
    );
}

#[cfg(unix)]
#[tokio::test]
async fn read_owner_schedules_joins_the_task_store_per_owner() {
    let data = tempfile::tempdir().unwrap();
    let (_, linked) = outcome_store(data.path(), "owner", "/work");
    let other = {
        let mut store = TaskStore {
            owner_id: "other".into(),
            ..Default::default()
        };
        store.schedules.push(schedule("/work", None, 9));
        write_store(data.path(), &store).unwrap();
        store.schedules[0].id
    };
    let read = |name: &'static str| {
        let data = data.path().to_path_buf();
        async move {
            for _ in 0..200 {
                if let Ok(found) = read_owner_schedules(data.clone(), name.into()).await {
                    return found;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            panic!("schedule storage stayed busy");
        }
    };
    drop(store_file_lock(data.path()).unwrap());
    let owner = read("owner").await;
    let foreign = read("other").await;
    assert_eq!(
        (
            owner
                .iter()
                .find(|item| item.id == linked)
                .map(|item| item.last_status.clone()),
            owner.iter().any(|item| item.id == other),
            foreign.len(),
            foreign[0].last_status.clone(),
        ),
        (Some(Some(TaskStatus::Failed)), false, 1, None)
    );
}

async fn request(
    router: Router,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
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

#[tokio::test]
async fn http_list_reports_last_status_and_error_only_for_the_owner() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().join("data");
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data_dir.clone(),
        ..Default::default()
    })
    .unwrap();
    let router = |owner: &str| {
        routes()
            .layer(Extension(AuthenticatedUser {
                user_id: owner.into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone())
    };
    let workspace = dir.path().canonicalize().unwrap();
    let (status, created) = request(
        router("owner"),
        "POST",
        "/api/workspace/schedules",
        serde_json::json!({"workspacePath": workspace, "provider":"claude", "prompt":"Review", "name":"Cron", "enabled":true, "at":{"cron":"*/10 * * * *","timeZone":"Europe/Berlin"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["at"]["cron"], "*/10 * * * *");
    assert_eq!(
        request(
            router("owner"),
            "POST",
            "/api/workspace/schedules",
            serde_json::json!({"workspacePath": workspace, "provider":"claude", "prompt":"Review", "name":"Bad", "enabled":true, "at":{"cron":"nope"}}),
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let id: Uuid = created["id"].as_str().unwrap().parse().unwrap();
    let mut store = read_store(&data_dir, "owner").unwrap();
    let mut task = enqueue(
        &mut store,
        task_input(&workspace.to_string_lossy()),
        Some(id),
        5,
    )
    .unwrap();
    task.error = Some("agent crashed".into());
    transition(&mut task, TaskStatus::Failed, "failed", 6);
    store.tasks[0] = task.clone();
    store.schedules[0].last_task_id = Some(task.id);
    write_store(&data_dir, &store).unwrap();

    let (_, listed) = request(
        router("owner"),
        "GET",
        "/api/workspace/tasks",
        serde_json::Value::Null,
    )
    .await;
    let (_, foreign) = request(
        router("other"),
        "GET",
        "/api/workspace/tasks",
        serde_json::Value::Null,
    )
    .await;
    let row = &listed["schedules"][0];
    assert_eq!(
        (
            row["lastStatus"].clone(),
            row["lastError"].clone(),
            row["missedRuns"].clone(),
            row["nextRunAt"].is_u64(),
            foreign["schedules"].as_array().unwrap().len(),
        ),
        (
            serde_json::json!("failed"),
            serde_json::json!("agent crashed"),
            serde_json::Value::Null,
            true,
            0
        )
    );
}
