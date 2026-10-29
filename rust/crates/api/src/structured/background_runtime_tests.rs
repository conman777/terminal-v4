use super::launch_tests::{actor_fixture, approvals_shown, tool_call_response, tool_results};
use super::*;
use crate::v4_agent::background_process::BackgroundProcesses;
use axum::{routing::post, Json, Router};
use std::time::Duration;

const NOTICE: &str = "background-completion:";

struct Bench {
    manager: StructuredSessionManager,
    app: crate::state::AppState,
    live: Arc<StructuredLiveSession>,
    id: String,
    data: PathBuf,
    workspace: PathBuf,
}

impl Bench {
    fn of(fixture: &Fixture) -> Self {
        Self {
            manager: fixture.manager.clone(),
            app: fixture.app.clone(),
            live: fixture.live.clone(),
            id: fixture.id.clone(),
            data: fixture._data.path().to_path_buf(),
            workspace: fixture._workspace.path().canonicalize().unwrap(),
        }
    }

    async fn notices(&self) -> Vec<(String, String)> {
        self.manager
            .get_session("owner", &self.id)
            .await
            .unwrap()
            .unwrap()
            .events
            .into_iter()
            .filter_map(|event| match event {
                StructuredSessionEvent::MessageCompleted {
                    message_id: Some(id),
                    content,
                    role,
                    ..
                } if id.starts_with(NOTICE) && role == "system" => {
                    Some((id[NOTICE.len()..].to_owned(), content))
                }
                _ => None,
            })
            .collect()
    }

    async fn notices_for(&self, action: &str) -> usize {
        self.notices()
            .await
            .iter()
            .filter(|(id, _)| id == action)
            .count()
    }

    async fn wait_for_notice(&self, action: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.notices_for(action).await == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("completion notice was not delivered");
    }
}

struct Turn {
    answer: Result<String, String>,
    requests: Vec<Value>,
    approvals: Vec<(String, String)>,
    prior: usize,
}

impl Turn {
    fn results(&self) -> Vec<Value> {
        tool_results(self.requests.last().unwrap())[self.prior..].to_vec()
    }

    fn background_tools_offered(&self, request: usize) -> usize {
        self.requests[request]["tools"]
            .to_string()
            .matches("\"name\":\"background_")
            .count()
    }

    fn tools_offered(&self, request: usize) -> usize {
        self.requests[request]["tools"]
            .as_array()
            .map_or(0, |tools| tools.len())
    }
}

fn stop() -> Value {
    serde_json::json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}]})
}

fn call(id: &str, name: &str, arguments: Value) -> Value {
    tool_call_response(id, name, arguments)
}

fn start(id: &str, command: &str, seconds: u64) -> Value {
    call(
        id,
        "background_start",
        serde_json::json!({"command":command,"timeoutSeconds":seconds}),
    )
}

fn by_action(id: &str, name: &str, action: &Value) -> Value {
    call(id, name, serde_json::json!({"actionId":action}))
}

fn waits(id: &str, action: &Value) -> Value {
    call(
        id,
        "background_wait",
        serde_json::json!({"actionId":action,"timeoutSeconds":10}),
    )
}

async fn scripted_turn(
    bench: &Bench,
    background: &Arc<BackgroundProcesses>,
    script: impl Fn(usize, &[Value]) -> Value + Send + Sync + 'static,
    approve: impl Fn(&str, &str) -> bool + Send + Sync + 'static,
    read_only_child: bool,
) -> Turn {
    let turn_id = Uuid::new_v4().to_string();
    let controller =
        controller_for_turn(&bench.manager, &bench.live, &bench.id, 7, turn_id.clone()).await;
    controller.done.send_replace(false);
    {
        let mut state = bench.live.state.lock().await;
        state.generation = 7;
        state.process = Some(controller.clone());
    }
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: bench.id.clone(),
        turn_id,
    };
    let actor = Arc::new(
        BackgroundTurn::new(
            bench.manager.clone(),
            background.clone(),
            scope.clone(),
            7,
            bench.workspace.clone(),
            controller.clone(),
            crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
        )
        .unwrap(),
    );
    let dyn_actor: Arc<dyn crate::v4_agent::background_process::tool::BackgroundActor> =
        actor.clone();
    controller
        .resources
        .bind_background_actor(&dyn_actor)
        .unwrap();

    let bodies = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = bodies.clone();
    let script = Arc::new(script);
    let prior = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let prior_count = prior.clone();
    let router = Router::new().fallback(post(move |Json(body): Json<Value>| {
        let captured = captured.clone();
        let response = {
            let mut bodies = captured.lock().unwrap();
            let results = tool_results(&body);
            if bodies.is_empty() {
                prior_count.store(results.len(), std::sync::atomic::Ordering::SeqCst);
            }
            let response = script(
                bodies.len(),
                &results[prior_count.load(std::sync::atomic::Ordering::SeqCst)..],
            );
            bodies.push(body);
            response
        };
        async move { Json(response) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let seen = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let already: std::collections::HashSet<String> = bench
        .live
        .state
        .lock()
        .await
        .events
        .iter()
        .filter_map(|event| match event {
            StructuredSessionEvent::ApprovalRequired {
                approval_id: Some(id),
                ..
            } => Some(id.clone()),
            _ => None,
        })
        .collect();
    let decider = {
        let seen = seen.clone();
        let (manager, app, session) = (bench.manager.clone(), bench.app.clone(), bench.id.clone());
        let live = bench.live.clone();
        tokio::spawn(async move {
            let authority = crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX);
            let mut decided = already;
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
                    let allow = approve(&tool, &description);
                    manager
                        .approve_with_paired(
                            "owner",
                            &session,
                            Some(&approval),
                            allow,
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
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };

    let mut session: crate::v4_agent::Session = serde_json::from_value(serde_json::json!({
        "id": engine_session_id(&bench.id).unwrap(), "provider": "deepseek", "model": "deepseek-chat",
        "workspace": bench.workspace.to_str().unwrap(), "messages": [], "history": [], "updated_at": ""
    }))
    .unwrap();
    let sink = V4StructuredInteraction {
        sink: controller.sink.clone(),
        controller: controller.clone(),
    };
    let answer = tokio::time::timeout(
        Duration::from_secs(30),
        crate::v4_agent::test_background_provider_turn_as(
            format!("http://{address}"),
            &bench.data,
            &mut session,
            scope,
            controller.resources.clone(),
            &sink,
            Some(crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX)),
            read_only_child,
        ),
    )
    .await
    .unwrap_or_else(|_| Err("turn timed out".into()));
    decider.abort();
    server.abort();
    controller.done.send_replace(true);
    drop(dyn_actor);
    drop(actor);
    let requests = bodies.lock().unwrap().clone();
    let approvals = seen.lock().unwrap().clone();
    Turn {
        answer,
        requests,
        approvals,
        prior: prior.load(std::sync::atomic::Ordering::SeqCst),
    }
}

fn allow_all(_: &str, _: &str) -> bool {
    true
}

fn gone(pid: i32) -> bool {
    let result = unsafe { libc::kill(pid, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

async fn wait_gone(pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !gone(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("background process survived");
}

async fn read_pid(path: &Path) -> i32 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process did not report its pid")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_completed_command_is_announced_to_its_session_exactly_once_without_its_output() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    fixture.manager.enable_background_commands().unwrap();
    let bench = Bench::of(&fixture);
    let other = fixture
        .manager
        .create_session(
            "owner",
            bench.workspace.to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let turn = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("announce", "printf TOP-SECRET-OUTPUT", 10),
            1 => waits("announce-wait", &results[0]["actionId"]),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(turn.answer, Ok("done".into()));
    let results = turn.results();
    let action = results[0]["actionId"].as_str().unwrap().to_owned();
    bench.wait_for_notice(&action).await;
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(0)
    );
    let notices = bench.notices().await;
    assert_eq!(
        notices,
        vec![(
            action.clone(),
            format!(
                "Background command {action} exited with code 0. Its output is not included; use the reviewed-output action to read it."
            )
        )]
    );
    assert!(!notices[0].1.contains("TOP-SECRET-OUTPUT"));
    assert!(!serde_json::to_string(&results)
        .unwrap()
        .contains("TOP-SECRET-OUTPUT"));
    assert_eq!(background.pending_completions().unwrap(), vec![]);
    let foreign = fixture
        .manager
        .get_session("owner", &other)
        .await
        .unwrap()
        .unwrap()
        .events
        .iter()
        .filter(|event| matches!(event, StructuredSessionEvent::MessageCompleted { role, .. } if role == "system"))
        .count();
    assert_eq!(foreign, 0);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_read_only_child_turn_is_not_offered_and_cannot_call_background_tools() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let turn = scripted_turn(
        &bench,
        &background,
        |index, _| match index {
            0 => start("child-start", "printf child > marker", 10),
            _ => stop(),
        },
        allow_all,
        true,
    )
    .await;
    assert_eq!(turn.answer, Ok("done".into()));
    assert_eq!(turn.background_tools_offered(0), 0);
    assert!(turn.tools_offered(0) > 0);
    assert!(turn.approvals.is_empty());
    let result = turn.requests.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .to_string();
    assert!(
        result.contains("Tool denied by read-only child policy"),
        "{result}"
    );
    assert!(!bench.workspace.join("marker").exists());
    assert_eq!(background.pending_completions().unwrap(), vec![]);

    let standard = scripted_turn(&bench, &background, |_, _| stop(), allow_all, false).await;
    assert_eq!(standard.background_tools_offered(0), 5);
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capacity_is_refused_before_any_approval_through_a_full_turn() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    background.set_running_limits_for_test(1, 8);
    let bench = Bench::of(&fixture);
    let turn = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("slot-1", "sleep 30", 40),
            1 => start("slot-2", "printf second > marker", 10),
            2 => by_action("slot-cancel", "background_cancel", &results[0]["actionId"]),
            3 => waits("slot-wait", &results[0]["actionId"]),
            4 => start("slot-3", "printf third > marker", 10),
            5 => waits("slot-3-wait", &results[4]["actionId"]),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(turn.answer, Ok("done".into()));
    let results = turn.results();
    assert_eq!(results[0]["state"], "running");
    assert!(
        results[1].as_str().unwrap().contains("Too many"),
        "{:?}",
        results[1]
    );
    assert_eq!(results[3]["state"], "cancelled");
    assert_eq!(results[5]["state"], "exited");
    assert_eq!(
        turn.approvals
            .iter()
            .map(|(tool, _)| tool.as_str())
            .collect::<Vec<_>>(),
        ["background_start", "background_start"],
        "the refused start never asked for approval"
    );
    assert_eq!(
        std::fs::read_to_string(bench.workspace.join("marker")).unwrap(),
        "third"
    );
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn denied_approvals_neither_start_a_process_nor_release_output() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let denied_start = scripted_turn(
        &bench,
        &background,
        |index, _| match index {
            0 => start("deny-start", "printf denied > marker", 10),
            _ => stop(),
        },
        |_, _| false,
        false,
    )
    .await;
    assert_eq!(denied_start.answer, Ok("done".into()));
    assert_eq!(denied_start.approvals.len(), 1);
    assert!(!bench.workspace.join("marker").exists());
    assert_eq!(background.pending_completions().unwrap(), vec![]);

    let turn = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("out-start", "printf visible-output", 10),
            1 => waits("out-wait", &results[0]["actionId"]),
            2 => by_action(
                "out-read",
                "background_read_output",
                &results[0]["actionId"],
            ),
            _ => stop(),
        },
        |tool, _| tool == "background_start",
        false,
    )
    .await;
    assert_eq!(turn.answer, Ok("done".into()));
    let results = turn.results();
    assert_eq!(results[1]["state"], "exited");
    assert!(
        results[2].as_str().unwrap().contains("denied"),
        "{:?}",
        results[2]
    );
    assert!(!serde_json::to_string(&results)
        .unwrap()
        .contains("visible-output"));
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_changed_session_incarnation_rejects_every_action_until_it_is_restored() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let first = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("inc-start", "printf kept", 10),
            1 => waits("inc-wait", &results[0]["actionId"]),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    let action = first.results()[0]["actionId"].clone();
    let original = fixture.live.state.lock().await.session_incarnation;
    fixture.live.state.lock().await.session_incarnation = Some(SessionIncarnation(Uuid::new_v4()));
    let shown = approvals_shown(&fixture).await;
    let stale_action = action.clone();
    let stale = scripted_turn(
        &bench,
        &background,
        move |index, _| match index {
            0 => by_action("inc-status", "background_status", &stale_action),
            1 => by_action("inc-cancel", "background_cancel", &stale_action),
            2 => by_action("inc-read", "background_read_output", &stale_action),
            3 => start("inc-new", "printf late > marker", 10),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(stale.answer, Ok("done".into()));
    assert!(stale.approvals.is_empty());
    assert_eq!(approvals_shown(&fixture).await, shown);
    for result in stale.results() {
        assert!(result.is_string(), "{result:?}");
    }
    assert!(!bench.workspace.join("marker").exists());

    fixture.live.state.lock().await.session_incarnation = original;
    let restored_action = action.clone();
    let restored = scripted_turn(
        &bench,
        &background,
        move |index, _| match index {
            0 => by_action("inc-ok", "background_status", &restored_action),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(restored.results()[0]["state"], "exited");
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_action_of_another_session_is_invisible_to_a_turn_through_the_tools() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let first = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("scope-start", "sleep 30", 40),
            1 => by_action("scope-status", "background_status", &results[0]["actionId"]),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    let action = first.results()[0]["actionId"].clone();

    let second = fixture
        .manager
        .create_session(
            "owner",
            bench.workspace.to_str().unwrap(),
            Some("deepseek"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    let live = fixture
        .manager
        .owned_session("owner", &second)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let foreign = Bench {
        manager: fixture.manager.clone(),
        app: fixture.app.clone(),
        live,
        id: second,
        data: bench.data.clone(),
        workspace: bench.workspace.clone(),
    };
    let stolen = action.clone();
    let probe = scripted_turn(
        &foreign,
        &background,
        move |index, _| match index {
            0 => by_action("steal-status", "background_status", &stolen),
            1 => by_action("steal-cancel", "background_cancel", &stolen),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(probe.answer, Ok("done".into()));
    for result in probe.results() {
        assert!(result.is_string(), "{result:?}");
    }

    let still = action.clone();
    let owner_again = scripted_turn(
        &bench,
        &background,
        move |index, _| match index {
            0 => by_action("scope-again", "background_status", &still),
            1 => by_action("scope-stop", "background_cancel", &still),
            2 => waits("scope-end", &still),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    let results = owner_again.results();
    assert_eq!(
        results[0]["state"], "running",
        "another session's cancel was ignored"
    );
    assert_eq!(results[2]["state"], "cancelled");
    fixture.manager.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_the_session_reaps_the_process_retires_the_session_and_refuses_a_stale_start() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let turn = scripted_turn(
        &bench,
        &background,
        |index, _| match index {
            0 => start(
                "delete-start",
                "printf '%s' $$ > child.pid; exec sleep 30",
                40,
            ),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(turn.answer, Ok("done".into()));
    let pid = read_pid(&bench.workspace.join("child.pid")).await;
    assert!(!gone(pid));

    let stale_controller =
        controller_for_turn(&bench.manager, &bench.live, &bench.id, 7, "stale".into()).await;
    stale_controller.done.send_replace(false);
    fixture.controller.done.send_replace(true);
    {
        let mut state = bench.live.state.lock().await;
        state.generation = 7;
        state.process = Some(stale_controller.clone());
    }
    let finisher = stale_controller.clone();
    let finish = tokio::spawn(async move {
        finisher.cancel.cancelled().await;
        finisher.done.send_replace(true);
    });
    bench
        .manager
        .delete_session("owner", &bench.id)
        .await
        .unwrap();
    finish.await.unwrap();
    wait_gone(pid).await;
    assert!(
        crate::v4_agent::background_process::session_fence::is_retired(
            &bench.data.canonicalize().unwrap(),
            "owner",
            &bench.id
        )
        .unwrap()
    );
    assert!(bench
        .manager
        .get_session("owner", &bench.id)
        .await
        .map_or(true, |session| session.is_none()));

    let stale = BackgroundTurn::new(
        bench.manager.clone(),
        background.clone(),
        ActionScope {
            owner: "owner".into(),
            session_id: bench.id.clone(),
            turn_id: "stale".into(),
        },
        7,
        bench.workspace.clone(),
        stale_controller.clone(),
        crate::auth::LocalAuthority::for_test("owner", 0, i64::MAX),
    );
    let before = approvals_shown(&fixture).await;
    let attempt = crate::v4_agent::background_process::tool::BackgroundActor::start(
        Arc::new(stale.unwrap()),
        "after-delete",
        "printf late > marker",
        Duration::from_secs(5),
    )
    .await;
    assert!(attempt.is_err());
    assert_eq!(approvals_shown(&fixture).await, before);
    assert!(!bench.workspace.join("marker").exists());
    let ghost = crate::v4_agent::background_process::BackgroundScope {
        owner: "owner".into(),
        session: bench.id.clone(),
        workspace: bench.workspace.clone(),
        incarnation: None,
    };
    assert!(background.ensure_session_open(&ghost).await.is_err());
    let _ = fixture.manager.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn logout_blocks_launches_releases_no_output_and_stops_the_owner_commands() {
    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let first = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("logout-quick", "printf held-output", 10),
            1 => waits("logout-quick-wait", &results[0]["actionId"]),
            2 => start(
                "logout-long",
                "printf '%s' $$ > child.pid; exec sleep 60",
                80,
            ),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(first.answer, Ok("done".into()));
    let results = first.results();
    let quick = results[0]["actionId"].clone();
    let long = results[2]["actionId"].clone();
    let pid = read_pid(&bench.workspace.join("child.pid")).await;

    fixture.app.logout_user("owner").unwrap();
    let before = approvals_shown(&fixture).await;
    let serviced = background.service_owner_holds().await;
    assert!(serviced.is_ok(), "{serviced:?}");
    wait_gone(pid).await;

    let after = scripted_turn(
        &bench,
        &background,
        move |index, _| match index {
            0 => by_action("lo-status", "background_status", &quick),
            1 => by_action("lo-read", "background_read_output", &quick),
            2 => start("lo-start", "printf late > marker", 10),
            3 => by_action("lo-cancel", "background_cancel", &long),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(after.answer, Ok("done".into()));
    assert!(after.approvals.is_empty());
    assert_eq!(approvals_shown(&fixture).await, before);
    for result in after.results() {
        let text = serde_json::to_string(&result).unwrap();
        assert!(
            result.is_string() && !text.contains("held-output"),
            "{text}"
        );
    }
    assert!(!bench.workspace.join("marker").exists());
    let _ = fixture.manager.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_keeps_markers_blocks_on_a_crash_left_unknown_until_the_review_route_clears_it() {
    use axum::{body::Body, http::Request, Extension};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let fixture = fixture().await;
    let (background, _, _) = actor_fixture(&fixture).await;
    let bench = Bench::of(&fixture);
    let first = scripted_turn(
        &bench,
        &background,
        |index, results| match index {
            0 => start("r-ok", "printf finished", 10),
            1 => start("r-fail", "exit 3", 10),
            2 => start("r-crash", "sleep 30", 40),
            3 => waits("r-ok-wait", &results[0]["actionId"]),
            4 => waits("r-fail-wait", &results[1]["actionId"]),
            5 => by_action(
                "r-crash-status",
                "background_status",
                &results[2]["actionId"],
            ),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(first.answer, Ok("done".into()));
    let results = first.results();
    let ids: Vec<String> = (0..3)
        .map(|index| results[index]["actionId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(results[5]["state"], "running");
    let markers: Vec<String> = background
        .pending_completions()
        .unwrap()
        .into_iter()
        .map(|(_, completion)| completion.action_id)
        .collect();
    assert!(
        markers.contains(&ids[0]) && markers.contains(&ids[1]),
        "{markers:?}"
    );

    fixture.controller.done.send_replace(true);
    fixture.manager.shutdown().await.unwrap();
    let Fixture {
        _data: data,
        _workspace: workspace,
        app,
        manager,
        live,
        controller,
        id,
    } = fixture;
    drop((background, bench, controller, live, manager, app));
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
            match crate::state::AppState::new_runtime_with_background_commands(config.clone(), true)
            {
                Ok(state) => break state,
                Err(error) if attempt < 100 => {
                    attempt += 1;
                    let _ = error;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => panic!("runtime did not reopen: {error}"),
            }
        }
    };
    let manager = state.structured_session_manager();
    let background = manager.background_processes_for_test().unwrap();
    assert!(background.commands_enabled());
    let live = manager
        .owned_session("owner", &id)
        .await
        .unwrap()
        .unwrap()
        .session
        .clone();
    let bench = Bench {
        manager: manager.clone(),
        app: state.clone(),
        live,
        id: id.clone(),
        data: data.path().to_path_buf(),
        workspace: workspace.path().canonicalize().unwrap(),
    };
    bench.wait_for_notice(&ids[0]).await;
    bench.wait_for_notice(&ids[1]).await;
    assert_eq!(
        manager.deliver_background_completions().await.map(|_| ()),
        Ok(())
    );
    assert_eq!(bench.notices_for(&ids[0]).await, 1);
    assert_eq!(bench.notices_for(&ids[1]).await, 1);

    let (a, b, c) = (
        serde_json::json!(ids[0]),
        serde_json::json!(ids[1]),
        serde_json::json!(ids[2]),
    );
    let blocked = scripted_turn(
        &bench,
        &background,
        move |index, _| match index {
            0 => by_action("rs-a", "background_status", &a),
            1 => by_action("rs-b", "background_status", &b),
            2 => by_action("rs-c", "background_status", &c),
            3 => by_action("rs-c-cancel", "background_cancel", &c),
            4 => by_action("rs-a-read", "background_read_output", &a),
            5 => start("rs-new", "printf blocked > marker", 10),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(blocked.answer, Ok("done".into()));
    assert!(blocked.approvals.is_empty());
    let results = blocked.results();
    assert_eq!(
        (
            results[0]["state"].as_str(),
            results[0]["exitCode"].as_i64()
        ),
        (Some("exited"), Some(0))
    );
    assert_eq!(
        (
            results[1]["state"].as_str(),
            results[1]["exitCode"].as_i64()
        ),
        (Some("exited"), Some(3))
    );
    assert_eq!(results[2]["state"], "unknown");
    assert!(results[3].is_string() && results[4].is_string());
    assert!(
        results[5].as_str().unwrap().contains("recovery"),
        "{:?}",
        results[5]
    );
    assert!(!bench.workspace.join("marker").exists());

    let router = crate::structured::ownership_recovery::routes()
        .layer(Extension(crate::auth::AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        }))
        .layer(Extension(crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            i64::MAX,
        )))
        .with_state(state.clone());
    let operation = Uuid::new_v4();
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/structured/background-review")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"operationId":operation,"acknowledged":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["reviewedCount"], 1, "{body}");

    let c = serde_json::json!(ids[2]);
    let cleared = scripted_turn(
        &bench,
        &background,
        move |index, results| match index {
            0 => start("rs-after-review", "printf resumed > marker", 10),
            1 => waits("rs-after-wait", &results[0]["actionId"]),
            2 => by_action("rs-c-again", "background_status", &c),
            _ => stop(),
        },
        allow_all,
        false,
    )
    .await;
    assert_eq!(cleared.answer, Ok("done".into()));
    let results = cleared.results();
    assert_eq!(results[1]["state"], "exited");
    assert_eq!(results[2]["state"], "unknown");
    assert_eq!(
        std::fs::read_to_string(bench.workspace.join("marker")).unwrap(),
        "resumed"
    );
    let _ = manager.shutdown().await;
}

mod production {
    use super::*;
    use crate::structured::auth_integration_tests::post_request;
    use axum::{body::Body, http::Request};
    use std::process::Stdio;
    use tower::ServiceExt;

    const JWT: &str = "background-runtime-jwt";
    const VAULT: &str = "background-runtime-vault";
    const FIXTURE: &str =
        "structured::background_actor::runtime_tests::production::runtime_turn_fixture";

    async fn session_events(
        manager: &StructuredSessionManager,
        id: &str,
    ) -> Vec<StructuredSessionEvent> {
        manager
            .get_session("owner", id)
            .await
            .unwrap()
            .unwrap()
            .events
    }

    async fn wait_background_approval(manager: &StructuredSessionManager, id: &str) -> String {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let events = session_events(manager, id).await;
                if let Some(approval) = events.iter().find_map(|event| match event {
                    StructuredSessionEvent::ApprovalRequired {
                        approval_id: Some(approval),
                        tool_name,
                        ..
                    } if tool_name == "background_start" => Some(approval.clone()),
                    _ => None,
                }) {
                    return approval;
                }
                assert!(
                    !events
                        .iter()
                        .any(|event| matches!(event, StructuredSessionEvent::TurnCompleted { .. })),
                    "turn ended before approval: {events:?}"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("background approval was not emitted")
    }

    async fn wait_turn_events(
        manager: &StructuredSessionManager,
        id: &str,
    ) -> Vec<StructuredSessionEvent> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let events = session_events(manager, id).await;
                if events
                    .iter()
                    .any(|event| matches!(event, StructuredSessionEvent::TurnCompleted { .. }))
                {
                    return events;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("turn did not finish")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "invoked by the isolated parent tests"]
    async fn runtime_turn_fixture() {
        let data = PathBuf::from(std::env::var_os("V4_BG_DATA").unwrap());
        let workspace = PathBuf::from(std::env::var_os("V4_BG_WORKSPACE").unwrap());
        let expect = std::env::var("V4_BG_EXPECT").unwrap();
        let state = crate::state::AppState::new_runtime(AppConfig {
            data_dir: data.clone(),
            jwt_secret: JWT.into(),
            ..Default::default()
        })
        .unwrap();
        let user = crate::auth::AuthenticatedUser {
            user_id: "owner".into(),
            username: "fixture".into(),
        };
        state
            .add_vault_key(
                &user,
                "fixture",
                "terminal-v4:provider:deepseek",
                &crate::vault::encrypt_secret("synthetic-provider-key", VAULT).unwrap(),
                "2026-01-01",
            )
            .unwrap();
        let manager = state.structured_session_manager();
        let app = crate::app(state.clone());
        let token = crate::auth::issue_access_token(JWT, "owner", "fixture");
        let id = manager
            .create_session(
                "owner",
                workspace.to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap()
            .id;
        std::fs::write(data.join("fixture-session-id"), &id).unwrap();
        let accepted = app
            .clone()
            .oneshot(post_request(
                &format!("/api/structured/sessions/{id}/message"),
                Some(&token),
                serde_json::json!({"text":"run it","requestId":Uuid::new_v4()}),
            ))
            .await
            .unwrap();
        assert_eq!(accepted.status(), axum::http::StatusCode::ACCEPTED);
        if expect == "none" {
            let events = wait_turn_events(&manager, &id).await;
            assert!(!events
                .iter()
                .any(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { .. })));
            assert!(events.iter().any(|event| matches!(event, StructuredSessionEvent::ToolCompleted { tool_name, is_error: true, .. } if tool_name == "background_start")));
            assert!(!workspace.join("marker").exists());
            assert!(manager
                .background_processes_for_test()
                .is_none_or(|background| !background.commands_enabled()));
            manager.shutdown().await.unwrap();
            return;
        }
        let approval = wait_background_approval(&manager, &id).await;
        assert!(!workspace.join("marker").exists());
        let approved = app
            .clone()
            .oneshot(post_request(
                &format!("/api/structured/sessions/{id}/approve"),
                Some(&token),
                serde_json::json!({"approvalId":approval,"approved":true}),
            ))
            .await
            .unwrap();
        assert_eq!(approved.status(), axum::http::StatusCode::OK);
        let events = wait_turn_events(&manager, &id).await;
        assert!(!events.iter().any(|event| matches!(event, StructuredSessionEvent::ToolCompleted { is_error: true, tool_name, .. } if tool_name == "background_start")));
        if expect == "crash" {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !workspace.join("child.pid").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            std::process::abort();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !workspace.join("marker").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let background = manager.background_processes_for_test().unwrap();
        let bench_notices = || async {
            session_events(&manager, &id)
                .await
                .into_iter()
                .filter(|event| matches!(event, StructuredSessionEvent::MessageCompleted { message_id: Some(message), .. } if message.starts_with(NOTICE)))
                .count()
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            while bench_notices().await == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("completion notice was not delivered");
        assert_eq!(manager.deliver_background_completions().await, Ok(0));
        assert_eq!(bench_notices().await, 1);
        assert_eq!(background.pending_completions().unwrap(), vec![]);
        manager.shutdown().await.unwrap();
    }

    struct Isolated {
        status: std::process::ExitStatus,
        output: String,
        requests: Vec<Value>,
        data: tempfile::TempDir,
        workspace: tempfile::TempDir,
    }

    async fn run_isolated(flag: Option<&str>, expect: &str, command: &str) -> Isolated {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let command = command.to_owned();
        let router = Router::new().fallback(post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            let command = command.clone();
            async move {
                let mut bodies = captured.lock().unwrap();
                let response = if bodies.is_empty() {
                    start("production-start", &command, 300)
                } else {
                    stop()
                };
                bodies.push(body);
                Json(response)
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", FIXTURE, "--ignored", "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", data.path())
            .env("V4_BG_DATA", data.path())
            .env("V4_BG_WORKSPACE", workspace.path().canonicalize().unwrap())
            .env("V4_BG_EXPECT", expect)
            .env("VAULT_ENCRYPTION_KEY", VAULT)
            .env("DEEPSEEK_BASE_URL", format!("http://{address}/v1"))
            .env("NO_PROXY", "*")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(flag) = flag {
            child.env("TERMINAL_V4_BACKGROUND_COMMANDS", flag);
        }
        let output = tokio::time::timeout(
            Duration::from_secs(90),
            child.spawn().unwrap().wait_with_output(),
        )
        .await
        .expect("fixture timed out")
        .unwrap();
        server.abort();
        let requests = requests.lock().unwrap().clone();
        Isolated {
            status: output.status,
            output: format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
            requests,
            data,
            workspace,
        }
    }

    fn offered(request: &Value) -> usize {
        request["tools"]
            .to_string()
            .matches("\"name\":\"background_")
            .count()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_turns_do_not_offer_or_accept_background_tools_unless_explicitly_enabled() {
        for flag in [None, Some("true"), Some("0"), Some("")] {
            let run = run_isolated(flag, "none", "printf x > marker").await;
            assert!(run.status.success(), "{flag:?}: {}", run.output);
            assert_eq!(run.requests.len(), 2, "{flag:?}: {}", run.output);
            assert_eq!(offered(&run.requests[0]), 0, "{flag:?}");
            assert!(run.requests[0]["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty()));
            assert!(
                tool_results(&run.requests[1])[0]
                    .as_str()
                    .is_some_and(|text| text.contains("unavailable")),
                "{flag:?}: {:?}",
                run.requests[1]
            );
            assert!(!run.workspace.path().join("marker").exists());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_environment_switch_offers_the_tools_and_delivers_one_completion_notice() {
        let run = run_isolated(Some("1"), "approve", "printf enabled > marker").await;
        assert!(run.status.success(), "{}", run.output);
        assert_eq!(run.requests.len(), 2, "{}", run.output);
        assert_eq!(offered(&run.requests[0]), 5);
        assert_eq!(
            std::fs::read_to_string(run.workspace.path().join("marker")).unwrap(),
            "enabled"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_crashed_host_is_recovered_at_startup_and_the_next_turn_can_launch() {
        let run = run_isolated(
            Some("1"),
            "crash",
            "printf '%s' $$ > child.pid; exec sleep 300",
        )
        .await;
        assert!(!run.status.success());
        assert_eq!(run.requests.len(), 2, "{}", run.output);
        let action = tool_results(&run.requests[1])[0]["actionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let pid: i32 = read_pid(&run.workspace.path().join("child.pid")).await;
        let id = std::fs::read_to_string(run.data.path().join("fixture-session-id")).unwrap();
        let config = AppConfig {
            data_dir: run.data.path().into(),
            jwt_secret: JWT.into(),
            ..Default::default()
        };
        let state = {
            let mut attempt = 0;
            loop {
                match crate::state::AppState::new_runtime_with_background_commands(
                    config.clone(),
                    true,
                ) {
                    Ok(state) => break state,
                    Err(error) if attempt < 100 => {
                        attempt += 1;
                        let _ = error;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(error) => panic!("runtime did not reopen: {error}"),
                }
            }
        };
        wait_gone(pid).await;
        let manager = state.structured_session_manager();
        let background = manager.background_processes_for_test().unwrap();
        let review = crate::structured::ownership_recovery::routes()
            .layer(axum::Extension(crate::auth::AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            }))
            .with_state(state.clone());
        let inspected = review
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/structured/ownership")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status: Value = serde_json::from_slice(
            &http_body_util::BodyExt::collect(inspected.into_body())
                .await
                .unwrap()
                .to_bytes(),
        )
        .unwrap();
        assert_eq!(status["state"], "unconfirmed", "{status}");
        let reconciled = review
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/structured/ownership/reconcile")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"epoch":status["epoch"],"operationId":Uuid::new_v4(),"acknowledged":true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.status(), axum::http::StatusCode::NO_CONTENT);
        let live = manager
            .owned_session("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .session
            .clone();
        let bench = Bench {
            manager: manager.clone(),
            app: state.clone(),
            live,
            id,
            data: run.data.path().to_path_buf(),
            workspace: run.workspace.path().canonicalize().unwrap(),
        };
        assert_eq!(
            manager.deliver_background_completions().await.map(|_| ()),
            Ok(())
        );
        assert_eq!(bench.notices_for(&action).await, 1);
        assert_eq!(manager.deliver_background_completions().await, Ok(0));
        assert_eq!(bench.notices_for(&action).await, 1);

        let crashed = serde_json::json!(action);
        let next = scripted_turn(
            &bench,
            &background,
            move |index, results| match index {
                0 => by_action("crash-status", "background_status", &crashed),
                1 => start("crash-next", "printf recovered > marker", 10),
                2 => waits("crash-next-wait", &results[1]["actionId"]),
                _ => stop(),
            },
            allow_all,
            false,
        )
        .await;
        assert_eq!(next.answer, Ok("done".into()));
        let results = next.results();
        assert_eq!(results[0]["state"], "cancelled");
        assert_eq!(results[2]["state"], "exited");
        assert_eq!(
            std::fs::read_to_string(bench.workspace.join("marker")).unwrap(),
            "recovered"
        );
        let _ = manager.shutdown().await;
    }
}
