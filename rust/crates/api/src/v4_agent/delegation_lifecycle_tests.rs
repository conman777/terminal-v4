//! Cross-component lifecycle tests for owner-scoped read-only background delegation.
//!
//! Each test drives the real path: approval prompt, durable outbox admission, task
//! store, a real child process (this test binary running the V4 runtime in
//! `read-only-child` mode against a local synthetic provider), supervisor, and the
//! parent's durable follow-up queue. Assertions check files, process liveness and
//! queue/outbox/task records on disk, not only returned values.
use super::*;
use crate::followup_queue::{QueueMode, QueueScope, QueueStore};
use crate::structured::StructuredSessionManager;
use crate::v4_agent::interaction::{
    ActionScope, ApprovalRequest, Cancellation, Interaction, TurnResources,
};
use crate::workspace_tasks::TaskStatus;
use axum::{routing::post, Json};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tempfile::TempDir;
use terminal_v4_core::{AppConfig, StructuredSessionEvent};

const WAIT: Duration = Duration::from_secs(30);

/// Scripted provider. `None` from the script holds the request open forever.
type Script = Arc<dyn Fn(usize, &Value) -> Option<Value> + Send + Sync>;

struct Provider {
    address: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Provider {
    async fn start(script: Script) -> Self {
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&requests);
        let router = axum::Router::new().fallback(post(move |Json(body): Json<Value>| {
            let captured = Arc::clone(&captured);
            let script = Arc::clone(&script);
            async move {
                let index = {
                    let mut requests = captured.lock().unwrap();
                    requests.push(body.clone());
                    requests.len()
                };
                match script(index, &body) {
                    Some(response) => Json(response),
                    None => std::future::pending::<Json<Value>>().await,
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            address,
            requests,
            server,
        }
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn answer(text: &str) -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":text}}]})
}

fn tool_calls(calls: &[(&str, &str, Value)]) -> Value {
    let calls: Vec<Value> = calls
        .iter()
        .map(|(id, name, arguments)| {
            json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}})
        })
        .collect();
    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":calls}}]})
}

struct Approvals {
    decision: bool,
    requests: Mutex<Vec<ApprovalRequest>>,
}

impl Approvals {
    fn new(decision: bool) -> Self {
        Self {
            decision,
            requests: Mutex::new(Vec::new()),
        }
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

#[async_trait::async_trait]
impl Interaction for Approvals {
    async fn emit(&self, _: StructuredSessionEvent) -> Result<()> {
        Ok(())
    }
    async fn approve(&self, request: ApprovalRequest) -> Result<bool> {
        self.requests.lock().unwrap().push(request);
        Ok(self.decision)
    }
}

fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_for(label: &str, mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(WAIT, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {label}"));
}

fn read_pid(file: &Path) -> Option<i32> {
    std::fs::read_to_string(file).ok()?.trim().parse().ok()
}

struct Harness {
    data: TempDir,
    workspace: TempDir,
    root: PathBuf,
    config: AppConfig,
    manager: StructuredSessionManager,
    supervisor: Arc<DelegationSupervisor>,
    parent: String,
    queue_scope: QueueScope,
    session: crate::v4_agent::Session,
    provider: Provider,
    cancel: Cancellation,
    resources: Arc<TurnResources>,
    scope: ActionScope,
    turn: Arc<DelegationTurn>,
    launches: usize,
}

impl Harness {
    async fn new(script: Script) -> Self {
        let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("notes"), "original").unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE api_key_vault(user_id TEXT, key_name TEXT, key_value TEXT, created_at TEXT)",
        )
        .unwrap();
        let key =
            crate::vault::encrypt_secret("fixture-provider-key", "fixture-vault-key").unwrap();
        db.execute(
            "INSERT INTO api_key_vault VALUES(?1,?2,?3,'2020')",
            params!["owner", "terminal-v4:provider:deepseek", key],
        )
        .unwrap();
        drop(db);
        let provider = Provider::start(script).await;
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let manager = StructuredSessionManager::new(config.clone());
        manager.bind_live_ownership().unwrap();
        let supervisor = provision_supervisor(&config.data_dir).unwrap();
        manager
            .bind_delegation_supervisor(supervisor.clone())
            .unwrap();
        let snapshot = manager
            .create_session(
                "owner",
                root.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let parent = snapshot.id;
        let cancel = Cancellation::default();
        let resources = manager
            .set_fixture_turn("owner", &parent, Some((7, cancel.clone())))
            .await
            .unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: parent.clone(),
            turn_id: Uuid::new_v4().to_string(),
        };
        let turn = Arc::new(
            DelegationTurn::new(manager.clone(), supervisor.clone(), scope.clone(), 7).unwrap(),
        );
        resources.bind_delegation(&turn).unwrap();
        let mut session = crate::v4_agent::new_session("deepseek", "deepseek-chat", &root);
        session.id = crate::structured::engine_session_id(&parent).unwrap();
        let queue_scope = QueueScope::new("owner", &root, &parent).unwrap();
        Self {
            data,
            workspace,
            root,
            config,
            manager,
            supervisor,
            parent,
            queue_scope,
            session,
            provider,
            cancel,
            resources,
            scope,
            turn,
            launches: 0,
        }
    }

    /// Gracefully stops this server and starts a new one on the same data directory,
    /// as a restart does. The old supervisor must release the outbox first.
    async fn restart(self) -> Restarted {
        let Self {
            data,
            workspace,
            root,
            config,
            manager,
            supervisor,
            parent,
            queue_scope,
            provider,
            turn,
            resources,
            ..
        } = self;
        manager.set_fixture_turn("owner", &parent, None).await;
        manager.shutdown().await.unwrap();
        drop((turn, resources, supervisor, manager));
        let mut attempts = 0;
        let (manager, supervisor) = loop {
            let manager = StructuredSessionManager::new(config.clone());
            manager.bind_live_ownership().unwrap();
            match provision_supervisor(&config.data_dir) {
                Ok(supervisor) => {
                    manager
                        .bind_delegation_supervisor(supervisor.clone())
                        .unwrap();
                    break (manager, supervisor);
                }
                Err(error) if error.contains("already in use") && attempts < 200 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => panic!("restart failed: {error}"),
            }
        };
        Restarted {
            data,
            _workspace: workspace,
            root,
            parent,
            queue_scope,
            provider,
            manager,
            supervisor,
        }
    }

    fn pid_file(&self, launch: usize) -> PathBuf {
        self.data.path().join(format!("child-{launch}.pid"))
    }

    /// Requests a read-only background investigation through the real tool path.
    async fn delegate(&mut self, prompt: &str, approvals: &Approvals) -> Result<Value> {
        self.launches += 1;
        let pid_file = self.pid_file(self.launches);
        let data = self.data.path().to_path_buf();
        let root = self.root.clone();
        let address = self.provider.address;
        self.turn.set_test_command(move |command| {
            let args: Vec<String> = command
                .as_std()
                .get_args()
                .skip(1)
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            let output = data.join(format!("fixture-output-{}.jsonl", Uuid::new_v4()));
            let mut fixture = tokio::process::Command::new("/bin/sh");
            fixture
                .arg("-c")
                .arg("\"$1\" --exact v4_agent::delegation_outbox::tests::provider_child_fixture --nocapture >/dev/null; status=$?; cat \"$V4_DELEGATION_FIXTURE_OUTPUT\"; exit \"$status\"")
                .arg("fixture")
                .arg(std::env::current_exe().unwrap())
                .current_dir(root)
                .env("V4_DELEGATION_FIXTURE_ARGS", serde_json::to_string(&args).unwrap())
                .env("V4_DELEGATION_FIXTURE_DATA", &data)
                .env("V4_DELEGATION_FIXTURE_OUTPUT", output)
                .env("V4_DELEGATION_FIXTURE_PID", pid_file)
                .env("VAULT_ENCRYPTION_KEY", "fixture-vault-key")
                .env("DEEPSEEK_BASE_URL", format!("http://{address}/v1"))
                .env("NO_PROXY", "*");
            *command = fixture;
        });
        let output = self
            .turn
            .execute(
                self.data.path(),
                &self.session,
                &format!("call-{}", self.launches),
                &json!({"prompt": prompt}),
                DelegationInvocation {
                    scope: &self.scope,
                    interaction: approvals,
                    cancellation: &self.cancel,
                    resources: &self.resources,
                    authority: None,
                },
            )
            .await?;
        Ok(serde_json::from_str(&output).unwrap())
    }

    fn records(&self) -> Vec<Record> {
        self.supervisor.outbox.list("owner").unwrap()
    }

    fn only_record(&self) -> Record {
        let mut records = self.records();
        assert_eq!(records.len(), 1, "expected exactly one outbox record");
        records.remove(0)
    }

    fn queue(&self) -> QueueStore {
        QueueStore::new(
            self.data.path(),
            crate::structured::queue::manager_boot_id(&self.manager),
        )
    }

    fn queue_texts(&self) -> Vec<String> {
        self.queue()
            .inspect(&self.queue_scope)
            .unwrap()
            .map(|snapshot| snapshot.items.into_iter().map(|item| item.text).collect())
            .unwrap_or_default()
    }

    async fn task_status(&self, binding: &Binding) -> TaskStatus {
        crate::workspace_tasks::delegated_task_status(
            self.data.path().canonicalize().unwrap(),
            "owner".into(),
            Uuid::parse_str(&binding.task).unwrap(),
            Uuid::parse_str(&binding.child_session).unwrap(),
            binding.task_input(),
        )
        .await
        .unwrap()
    }

    async fn wait_for_child(&self, launch: usize) -> i32 {
        let file = self.pid_file(launch);
        wait_for("the child process to start", || read_pid(&file).is_some()).await;
        read_pid(&file).unwrap()
    }

    async fn wait_for_delivery(&self) {
        wait_for("the result to reach the parent queue", || {
            !self.queue_texts().is_empty()
        })
        .await;
    }

    fn workspace_listing(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

/// The server after a restart: a new manager and supervisor over the same files.
struct Restarted {
    data: TempDir,
    _workspace: TempDir,
    root: PathBuf,
    parent: String,
    queue_scope: QueueScope,
    provider: Provider,
    manager: StructuredSessionManager,
    supervisor: Arc<DelegationSupervisor>,
}

impl Restarted {
    fn queue(&self) -> QueueStore {
        QueueStore::new(
            self.data.path(),
            crate::structured::queue::manager_boot_id(&self.manager),
        )
    }
    fn records(&self) -> Vec<Record> {
        self.supervisor.outbox.list("owner").unwrap()
    }
}

async fn wait_dead(pid: i32) {
    wait_for("the child process to exit", || !pid_alive(pid)).await;
}

fn hanging() -> Script {
    Arc::new(|_, _| None)
}

#[tokio::test]
async fn denied_approval_starts_no_child_and_leaves_no_durable_state() {
    let mut harness = Harness::new(Arc::new(|_, _| Some(answer("never requested")))).await;
    let approvals = Approvals::new(false);
    let error = harness
        .delegate("Inspect the notes", &approvals)
        .await
        .unwrap_err();
    assert!(error.contains("not approved"), "{error}");
    let request = approvals.requests.lock().unwrap()[0].clone();
    assert_eq!(request.tool_name, "delegate_task_background");
    assert!(request.description.contains("read-only"));
    assert!(request.description.contains("Inspect the notes"));
    assert_eq!(
        (
            approvals.count(),
            harness.provider.count(),
            harness.records().len(),
            harness.pid_file(1).exists(),
            harness.data.path().join("workspace-tasks").exists(),
            harness.queue_texts(),
            harness.workspace_listing(),
        ),
        (
            1,
            0,
            0,
            false,
            false,
            Vec::<String>::new(),
            vec!["notes".to_string()]
        )
    );
    harness.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn read_only_child_cannot_write_execute_escalate_or_grant_itself_approval() {
    let marker = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&marker);
    let script: Script = Arc::new(move |index, body| {
        observed.fetch_add(1, Ordering::SeqCst);
        Some(if index == 1 {
            tool_calls(&[
                (
                    "w",
                    "write_file",
                    json!({"path":"created.txt","content":"x"}),
                ),
                (
                    "o",
                    "write_file",
                    json!({"path":"notes","content":"changed"}),
                ),
                (
                    "r",
                    "replace_text",
                    json!({"path":"notes","old":"original","new":"changed"}),
                ),
                ("c", "run_command", json!({"command":"touch ran.txt"})),
                ("d", "delegate_task", json!({"prompt":"nested"})),
                ("b", "delegate_task_background", json!({"prompt":"nested"})),
                (
                    "a",
                    "ask_user",
                    json!({"questions":[{"question":"Approve?","options":["yes","no"]}]}),
                ),
                ("s", "create_schedule", json!({"name":"x"})),
                ("m", "mcp_call_tool", json!({"server":"x","tool":"y"})),
                ("t", "todo_list", json!({})),
                ("f", "future_tool", json!({})),
                ("ok", "read_file", json!({"path":"notes"})),
            ])
        } else {
            assert!(body.to_string().contains("original"));
            answer("Read-only answer")
        })
    });
    let mut harness = Harness::new(script).await;
    let approvals = Approvals::new(true);
    let started = harness
        .delegate("Inspect the notes", &approvals)
        .await
        .unwrap();
    assert_eq!(started["status"], "running");
    harness.wait_for_delivery().await;

    let requests = harness.provider.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    let mut advertised: Vec<String> = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
        .collect();
    advertised.sort();
    let mut allowed = vec![
        "list_files",
        "read_file",
        "search_text",
        "recall_sessions",
        "read_session",
        "read_context_archive",
        "discover_skills",
        "list_skill_files",
        "read_skill_file",
    ];
    allowed.sort();
    assert_eq!(advertised, allowed);
    let results: std::collections::HashMap<String, String> = requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| {
            (
                message["tool_call_id"].as_str().unwrap().to_string(),
                message["content"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(results.len(), 12);
    for denied in ["w", "o", "r", "c", "d", "b", "a", "s", "m", "t", "f"] {
        assert!(
            results[denied].contains("Tool denied by read-only child policy"),
            "{denied}: {}",
            results[denied]
        );
    }
    assert!(results["ok"].contains("original"));

    assert_eq!(
        std::fs::read_to_string(harness.root.join("notes")).unwrap(),
        "original"
    );
    assert_eq!(harness.workspace_listing(), vec!["notes".to_string()]);
    assert_eq!(
        approvals.count(),
        1,
        "only the launch review was ever shown"
    );
    assert_eq!(
        harness.records().len(),
        1,
        "the child created no further delegation"
    );
    let record = harness.only_record();
    assert_eq!(record.binding.permission, Permission::ReadOnlyChild);
    assert_eq!(record.terminal.unwrap().outcome, Outcome::Succeeded);
    harness.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn model_cannot_widen_the_reviewed_scope_with_extra_arguments() {
    let mut harness = Harness::new(Arc::new(|_, _| Some(answer("never requested")))).await;
    let approvals = Approvals::new(true);
    harness.launches += 1;
    for extra in [
        json!({"prompt":"Inspect","permission":"writable"}),
        json!({"prompt":"Inspect","workspace":"/"}),
        json!({"prompt":"Inspect","approved":true}),
    ] {
        let result = harness
            .turn
            .execute(
                harness.data.path(),
                &harness.session,
                "extra",
                &extra,
                DelegationInvocation {
                    scope: &harness.scope,
                    interaction: &approvals,
                    cancellation: &harness.cancel,
                    resources: &harness.resources,
                    authority: None,
                },
            )
            .await;
        assert!(result.is_err());
    }
    assert_eq!(
        (
            approvals.count(),
            harness.records().len(),
            harness.provider.count()
        ),
        (0, 0, 0)
    );
    harness.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn completion_reaches_the_parent_once_across_retries_and_restart() {
    let mut harness = Harness::new(Arc::new(|_, _| Some(answer("Single delivery answer")))).await;
    let approvals = Approvals::new(true);
    harness.delegate("Inspect", &approvals).await.unwrap();
    harness.wait_for_delivery().await;
    wait_for("the receipt to be recorded", || {
        harness.only_record().receipt.is_some()
    })
    .await;
    let first = harness.queue_texts();
    assert_eq!(first.len(), 1);
    assert!(first[0].contains("Single delivery answer"));
    let receipt = harness.only_record().receipt.clone();

    // Duplicate completion and recovery retries are idempotent.
    harness
        .supervisor
        .recover_ready(&harness.manager, "owner")
        .await
        .unwrap();
    harness
        .supervisor
        .recover_ready(&harness.manager, "owner")
        .await
        .unwrap();
    let binding = harness.only_record().binding;
    let _ = harness
        .supervisor
        .outbox
        .stage_persisted_task_result("owner", binding.operation_id, 0)
        .await;
    let _ = harness
        .supervisor
        .outbox
        .deliver_bound_parent(&harness.manager, "owner", binding.operation_id)
        .await;
    assert_eq!(harness.queue_texts(), first);
    assert_eq!(harness.only_record().receipt, receipt);

    // A restarted server finds the receipt and delivers nothing again.
    let provider_requests = harness.provider.count();
    let second = harness.restart().await;
    assert!(second
        .manager
        .get_session("owner", &second.parent)
        .await
        .unwrap()
        .is_some());
    second
        .supervisor
        .recover_ready(&second.manager, "owner")
        .await
        .unwrap();
    second
        .supervisor
        .recover_ready(&second.manager, "owner")
        .await
        .unwrap();
    let after = second
        .queue()
        .inspect(&second.queue_scope)
        .unwrap()
        .unwrap();
    assert_eq!(
        after
            .items
            .iter()
            .map(|item| item.text.clone())
            .collect::<Vec<_>>(),
        first
    );
    assert_eq!(second.records().len(), 1);
    assert_eq!(second.records()[0].receipt, receipt);
    assert_eq!(provider_requests, 1);
    assert_eq!(second.provider.count(), 1, "the child is never relaunched");
    second.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn background_result_is_held_for_review_not_run_automatically() {
    let mut harness = Harness::new(Arc::new(|_, _| Some(answer("Held answer")))).await;
    harness
        .delegate("Inspect", &Approvals::new(true))
        .await
        .unwrap();
    harness.wait_for_delivery().await;
    let snapshot = harness
        .queue()
        .inspect(&harness.queue_scope)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.mode, QueueMode::Held);
    harness.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn parent_cancel_or_user_stop_kills_the_child_and_reports_cancellation_once() {
    let mut harness = Harness::new(hanging()).await;
    harness
        .delegate("Inspect", &Approvals::new(true))
        .await
        .unwrap();
    let pid = harness.wait_for_child(1).await;
    wait_for("the provider request", || harness.provider.count() == 1).await;
    let binding = harness.only_record().binding;
    assert_eq!(harness.task_status(&binding).await, TaskStatus::Running);

    // The user's Stop reaches the parent turn controller, which cancels the turn.
    harness.cancel.cancel();
    wait_dead(pid).await;
    harness.wait_for_delivery().await;
    wait_for("the cancelled outcome", || {
        harness.only_record().terminal.is_some()
    })
    .await;
    assert_eq!(
        harness.only_record().terminal.unwrap().outcome,
        Outcome::Cancelled
    );
    assert_eq!(harness.task_status(&binding).await, TaskStatus::Cancelled);
    let texts = harness.queue_texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("cancelled"), "{}", texts[0]);
    assert_eq!(harness.provider.count(), 1);
    assert!(!harness
        .workspace_listing()
        .contains(&"created.txt".to_string()));
    harness.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn logout_stops_the_child_and_defers_delivery_until_the_owner_resumes() {
    let mut harness = Harness::new(hanging()).await;
    harness
        .delegate("Inspect", &Approvals::new(true))
        .await
        .unwrap();
    let pid = harness.wait_for_child(1).await;
    wait_for("the provider request", || harness.provider.count() == 1).await;
    let binding = harness.only_record().binding;

    harness.manager.close_owner("owner").await.unwrap();
    assert!(!pid_alive(pid), "logout must confirm the child stopped");
    let record = harness.only_record();
    assert_eq!(record.terminal.unwrap().outcome, Outcome::Interrupted);
    assert!(record.receipt.is_none());
    assert_eq!(harness.task_status(&binding).await, TaskStatus::Interrupted);
    assert!(
        harness.queue_texts().is_empty(),
        "nothing is published for a logged-out owner"
    );

    // Signing in again resumes the owner; the interruption is delivered once and the
    // child is never replayed.
    harness.supervisor.resume_owner("owner").unwrap();
    assert!(harness
        .manager
        .get_session("owner", &harness.parent)
        .await
        .unwrap()
        .is_some());
    harness
        .supervisor
        .recover_ready(&harness.manager, "owner")
        .await
        .unwrap();
    wait_for("the interruption to reach the parent", || {
        harness.only_record().receipt.is_some()
    })
    .await;
    harness
        .supervisor
        .recover_ready(&harness.manager, "owner")
        .await
        .unwrap();
    let texts = harness.queue_texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("interrupted"), "{}", texts[0]);
    assert_eq!(harness.provider.count(), 1, "the child is not replayed");
    harness.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_mid_child_stops_it_without_replay_and_delivers_the_interruption_once() {
    let mut harness = Harness::new(hanging()).await;
    harness
        .delegate("Inspect", &Approvals::new(true))
        .await
        .unwrap();
    let pid = harness.wait_for_child(1).await;
    wait_for("the provider request", || harness.provider.count() == 1).await;
    let binding = harness.only_record().binding;
    let marker_pid = pid;
    let second = harness.restart().await;
    assert!(
        !pid_alive(marker_pid),
        "shutdown must confirm the child stopped"
    );
    let record = second.records().remove(0);
    assert_eq!(record.terminal.unwrap().outcome, Outcome::Interrupted);
    assert!(record.receipt.is_none());
    assert!(second
        .queue()
        .inspect(&second.queue_scope)
        .unwrap()
        .is_none_or(|snapshot| snapshot.items.is_empty()));

    assert!(second
        .manager
        .get_session("owner", &second.parent)
        .await
        .unwrap()
        .is_some());
    second
        .supervisor
        .recover_ready(&second.manager, "owner")
        .await
        .unwrap();
    wait_for("the interrupted result to be acknowledged", || {
        second.records()[0].receipt.is_some()
    })
    .await;
    second
        .supervisor
        .recover_ready(&second.manager, "owner")
        .await
        .unwrap();
    let snapshot = second
        .queue()
        .inspect(&second.queue_scope)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.items.len(), 1);
    assert!(snapshot.items[0].text.contains(&binding.task));
    assert!(snapshot.items[0].text.contains("interrupted"));
    assert_eq!(
        snapshot.mode,
        QueueMode::Held,
        "restart keeps the queue held"
    );
    assert_eq!(
        second.provider.count(),
        1,
        "the interrupted child is not replayed"
    );
    assert!(!pid_alive(pid));
    second.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn deleted_parent_stops_the_child_and_is_never_recreated_or_published_to() {
    let mut harness = Harness::new(hanging()).await;
    harness
        .delegate("Inspect", &Approvals::new(true))
        .await
        .unwrap();
    let pid = harness.wait_for_child(1).await;
    wait_for("the provider request", || harness.provider.count() == 1).await;
    let binding = harness.only_record().binding;
    // Establish the parent's durable queue so deletion has something to hold.
    harness.queue().load(&harness.queue_scope).unwrap();

    harness
        .manager
        .set_fixture_turn("owner", &harness.parent, None)
        .await;
    tokio::time::timeout(
        Duration::from_secs(15),
        harness.manager.delete_session("owner", &harness.parent),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!pid_alive(pid), "deleting the parent must stop its child");
    assert!(harness
        .manager
        .get_session("owner", &harness.parent)
        .await
        .unwrap()
        .is_none());
    let record = harness.only_record();
    assert_eq!(record.terminal.unwrap().outcome, Outcome::Interrupted);
    assert!(
        record.receipt.is_none(),
        "an unavailable parent never gets a receipt"
    );
    assert_eq!(
        harness.task_status(&binding).await,
        TaskStatus::Interrupted,
        "the retained task result stays reviewable"
    );
    assert!(
        harness.queue_texts().is_empty(),
        "nothing is published to a deleted parent"
    );

    // A later recovery pass, including after restart, does not recreate or fill the parent.
    harness
        .supervisor
        .recover_ready(&harness.manager, "owner")
        .await
        .unwrap();
    let second = harness.restart().await;
    let _ = second.manager.get_session("owner", &second.parent).await;
    second
        .supervisor
        .recover_ready(&second.manager, "owner")
        .await
        .unwrap();
    assert!(second
        .manager
        .get_session("owner", &second.parent)
        .await
        .unwrap()
        .is_none());
    assert!(second
        .queue()
        .inspect(&second.queue_scope)
        .unwrap()
        .is_none_or(|snapshot| snapshot.items.is_empty()));
    assert!(second.records()[0].receipt.is_none());
    assert_eq!(second.provider.count(), 1);
    assert!(!pid_alive(pid));
    drop(second.root);
    second.manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn without_a_supervisor_the_tool_is_not_offered_and_a_forced_call_has_no_effect() {
    let data = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    manager.bind_live_ownership().unwrap();
    let supervisor = provision_supervisor(data.path()).unwrap();
    // The supervisor was never bound to this manager, so no turn can use it.
    let scope = ActionScope {
        owner: "owner".into(),
        session_id: format!("ss-{}", Uuid::new_v4().simple()),
        turn_id: Uuid::new_v4().to_string(),
    };
    assert!(DelegationTurn::new(manager.clone(), supervisor, scope.clone(), 1).is_err());
    let resources = TurnResources::default();
    for provider in ["deepseek", "openai-api"] {
        assert!(
            super::super::background_delegation_definition(
                &resources,
                &scope,
                provider,
                super::super::ToolPolicy::Standard
            )
            .is_none(),
            "{provider}"
        );
    }
    assert!(!data.path().join("workspace-tasks").exists());
    manager.shutdown().await.unwrap();
}

#[tokio::test]
async fn transient_queue_contention_delays_but_never_strands_or_duplicates_the_result() {
    let mut harness = Harness::new(Arc::new(|index, _| {
        if index == 1 {
            std::thread::sleep(Duration::from_millis(1500));
        }
        Some(answer("Delayed answer"))
    }))
    .await;
    harness
        .delegate("Inspect", &Approvals::new(true))
        .await
        .unwrap();
    // Another operation holds the queue storage while the child finishes.
    let contender = std::fs::File::open(harness.data.path()).unwrap();
    contender.lock().unwrap();
    wait_for("the child to finish", || {
        harness.only_record().terminal.is_some()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    contender.unlock().unwrap();
    harness.wait_for_delivery().await;
    wait_for("the receipt", || harness.only_record().receipt.is_some()).await;
    let texts = harness.queue_texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("Delayed answer"));
    harness.manager.shutdown().await.unwrap();
}
