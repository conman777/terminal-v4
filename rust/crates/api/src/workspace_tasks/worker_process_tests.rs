use super::*;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::time::Duration;

const ENTRY: &str = "workspace_tasks::worker_process_tests::worker_child_entry";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_child_entry() {
    let Some(data_dir) = std::env::var_os("TASK_WORKER_CHILD_DIR") else {
        return;
    };
    let data_dir = PathBuf::from(data_dir);
    let name = std::env::var("TASK_WORKER_CHILD_NAME").unwrap();
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data_dir.clone(),
        ..Default::default()
    })
    .unwrap();
    start_worker(state);
    std::fs::write(data_dir.join(format!("{name}.started")), "1").unwrap();
    let stop = data_dir.join(format!("{name}.stop"));
    tokio::time::timeout(Duration::from_secs(120), async {
        while !stop.exists() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("worker child was never stopped");
    shutdown_workers().await;
    std::fs::write(data_dir.join(format!("{name}.stopped")), "1").unwrap();
}

struct Child {
    process: std::process::Child,
    data: PathBuf,
    name: String,
}

impl Child {
    fn stop_file(&self) -> PathBuf {
        self.data.join(format!("{}.stop", self.name))
    }
    fn pid(&self) -> u32 {
        self.process.id()
    }
    fn kill9(&mut self) -> std::process::ExitStatus {
        unsafe {
            libc::kill(self.process.id() as i32, libc::SIGKILL);
        }
        self.process.wait().unwrap()
    }
    async fn graceful_exit(&mut self) -> std::process::ExitStatus {
        std::fs::write(self.stop_file(), "stop").unwrap();
        wait_until("worker child exits", 20, || {
            self.process.try_wait().unwrap().is_some()
        })
        .await;
        self.process.wait().unwrap()
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

async fn wait_until(what: &str, seconds: u64, mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while !condition() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

struct Rig {
    _root: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    workspace: PathBuf,
    script: PathBuf,
}

impl Rig {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let data = base.join("data");
        let workspace = base.join("workspace");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(base.join("home")).unwrap();
        let script = base.join("fake-codex");
        std::fs::write(
            &script,
            r#"#!/bin/sh
printf '%s\n' "$$" >> "$FAKE_ROOT/pids"
printf 'run|%s|%s\n' "$PPID" "$*" >> "$FAKE_ROOT/runs.log"
corrupt() {
  cp "$FAKE_CORRUPT_STORE" "$FAKE_ROOT/store.backup"
  printf corrupt > "$FAKE_CORRUPT_STORE"
  rm -rf "$FAKE_ROOT/data/workspace-tasks/completions"
  printf blocked > "$FAKE_ROOT/data/workspace-tasks/completions"
}
[ "$FAKE_CORRUPT_PHASE" = start ] && corrupt
sleep "${FAKE_SLEEP:-0}"
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"fake done"}}'
[ "$FAKE_CORRUPT_PHASE" = end ] && corrupt
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _root: root,
            root: base,
            data,
            workspace,
            script,
        }
    }

    fn spawn(&self, name: &str, extra: &[(&str, String)]) -> Child {
        let log = std::fs::File::create(self.root.join(format!("{name}.log"))).unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", ENTRY, "--nocapture"])
            .env("TASK_WORKER_CHILD_DIR", &self.data)
            .env("TASK_WORKER_CHILD_NAME", name)
            .env("CODEX_BIN", &self.script)
            .env("FAKE_ROOT", &self.root)
            .env("HOME", self.root.join("home"))
            .stdout(log.try_clone().unwrap())
            .stderr(log);
        for (key, value) in extra {
            command.env(key, value);
        }
        Child {
            process: command.spawn().unwrap(),
            data: self.data.clone(),
            name: name.into(),
        }
    }

    fn runs(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.join("runs.log"))
            .unwrap_or_default()
            .split("run|")
            .skip(1)
            .map(str::to_owned)
            .collect()
    }

    fn input(&self, prompt: &str) -> TaskInput {
        TaskInput {
            workspace_path: self.workspace.to_string_lossy().into_owned(),
            provider: "codex".into(),
            prompt: prompt.into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        }
    }

    fn seed_due_schedule(&self) -> Uuid {
        let now = now_ms();
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let id = Uuid::new_v4();
        store.schedules.push(ScheduleRecord {
            id,
            name: "Due".into(),
            input: self.input("Scheduled review"),
            interval_seconds: 3600,
            at: None,
            run_once_at: None,
            enabled: true,
            next_run_at: Some(now.saturating_sub(1_000)),
            last_run_at: None,
            last_task_id: None,
            created_at: now - 10_000,
            missed_runs: 0,
            last_missed_at: None,
            skill: None,
            last_status: None,
            last_error: None,
        });
        write_store(&self.data, &store).unwrap();
        id
    }

    fn seed_queued_task(&self, prompt: &str) -> Uuid {
        let mut store = TaskStore {
            owner_id: "owner".into(),
            ..Default::default()
        };
        let task = enqueue(&mut store, self.input(prompt), None, now_ms()).unwrap();
        write_store(&self.data, &store).unwrap();
        task.id
    }

    fn store(&self) -> TaskStore {
        read_store(&self.data, "owner").unwrap()
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_workers_run_a_due_schedule_once_and_the_standby_takes_over_after_kill_9() {
    let rig = Rig::new();
    let schedule = rig.seed_due_schedule();
    let env = [("FAKE_SLEEP", "4".to_string())];
    let first = rig.spawn("a", &env);
    let second = rig.spawn("b", &env);
    wait_until("exactly one worker ran the schedule", 30, || {
        rig.runs().len() == 1
    })
    .await;
    let holder = rig.runs()[0].split('|').next().unwrap().to_owned();
    let (mut leader, mut standby) = if holder == first.pid().to_string() {
        (first, second)
    } else {
        assert_eq!(holder, second.pid().to_string());
        (second, first)
    };
    let status = leader.kill9();
    assert_eq!(status.signal(), Some(libc::SIGKILL));
    wait_until("standby recovered the unfinished task", 30, || {
        rig.store()
            .tasks
            .iter()
            .all(|task| task.status == TaskStatus::Interrupted)
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let store = rig.store();
    assert_eq!(
        (
            rig.runs().len(),
            store.tasks.len(),
            store.tasks[0].status.clone(),
            store.tasks[0]
                .events
                .last()
                .unwrap()
                .message
                .contains("outcome unknown"),
            store.schedules[0].id == schedule,
            store.schedules[0].next_run_at.unwrap() > now_ms() + 1_000_000,
            store.schedules[0].last_task_id == Some(store.tasks[0].id),
        ),
        (1, 1, TaskStatus::Interrupted, true, true, true, true)
    );
    assert!(standby.graceful_exit().await.success());
    assert_eq!(rig.runs().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_older_worker_refuses_a_newer_protocol_marker_and_runs_nothing() {
    let rig = Rig::new();
    rig.seed_due_schedule();
    let marker = rig.data.join("workspace-tasks/worker-protocol.json");
    std::fs::write(&marker, r#"{"protocol":999}"#).unwrap();
    let mut worker = rig.spawn("old", &[]);
    wait_until("worker process started", 30, || {
        rig.data.join("old.started").exists()
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let refusal = worker_lease(&rig.data).err().map(|error| error.message);
    let store = rig.store();
    assert_eq!(
        (
            rig.runs().len(),
            store.tasks.len(),
            std::fs::read_to_string(&marker).unwrap(),
            refusal.is_some_and(|message| message.contains("refusing")),
            store.schedules[0].last_run_at,
        ),
        (0, 0, r#"{"protocol":999}"#.to_string(), true, None)
    );
    assert!(worker.graceful_exit().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_mid_run_stops_the_agent_records_it_interrupted_and_never_reruns_it() {
    let rig = Rig::new();
    let task_id = rig.seed_queued_task("Long job");
    let mut first = rig.spawn("a", &[("FAKE_SLEEP", "60".to_string())]);
    wait_until("agent launched", 30, || rig.runs().len() == 1).await;
    wait_until("task running", 10, || {
        rig.store().tasks[0].status == TaskStatus::Running
    })
    .await;
    let agent: i32 = std::fs::read_to_string(rig.root.join("pids"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(alive(agent));
    assert!(first.graceful_exit().await.success());
    wait_until("agent process stopped", 10, || !alive(agent)).await;
    let task = rig.store().tasks.remove(0);
    assert_eq!(
        (task.id, task.status.clone(), task.completed_at.is_some()),
        (task_id, TaskStatus::Interrupted, true)
    );
    let mut second = rig.spawn("b", &[("FAKE_SLEEP", "60".to_string())]);
    wait_until("second worker started", 30, || {
        rig.data.join("b.started").exists()
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        (rig.runs().len(), rig.store().tasks[0].status.clone()),
        (1, TaskStatus::Interrupted)
    );
    assert!(second.graceful_exit().await.success());
}

async fn journal_scenario(phase: &str, sleep: &str, status: TaskStatus, result: &str) {
    let rig = Rig::new();
    let task_id = rig.seed_queued_task("Journaled job");
    let store_file = store_path(&rig.data, "owner");
    let mut first = rig.spawn(
        "a",
        &[
            ("FAKE_SLEEP", sleep.to_string()),
            ("FAKE_CORRUPT_PHASE", phase.to_string()),
            (
                "FAKE_CORRUPT_STORE",
                store_file.to_string_lossy().into_owned(),
            ),
        ],
    );
    wait_until("outcome journaled", 40, || {
        read_outcome_journal(&rig.data)
            .iter()
            .any(|entry| entry.record.id == task_id)
    })
    .await;
    let journaled = read_outcome_journal(&rig.data).remove(0);
    assert_eq!(
        (
            journaled.owner.clone(),
            journaled.record.status.clone(),
            journaled.record.result.clone(),
            std::fs::read(&store_file).unwrap(),
        ),
        (
            "owner".into(),
            status.clone(),
            result.into(),
            b"corrupt".to_vec()
        )
    );
    first.kill9();
    std::fs::copy(rig.root.join("store.backup"), &store_file).unwrap();
    std::fs::remove_file(rig.data.join("workspace-tasks/completions")).unwrap();
    assert_eq!(rig.store().tasks[0].status, TaskStatus::Running);
    let mut second = rig.spawn("b", &[]);
    wait_until("journal replayed into the owner store", 30, || {
        rig.store().tasks[0].status != TaskStatus::Running
    })
    .await;
    wait_until("journal cleared", 10, || !journal_path(&rig.data).exists()).await;
    let task = rig.store().tasks.remove(0);
    assert_eq!(
        (task.status, task.result, rig.runs().len()),
        (status, result.to_string(), 1)
    );
    assert!(second.graceful_exit().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_store_loss_after_the_agent_finished_is_journaled_and_replayed_as_completed() {
    journal_scenario("end", "0", TaskStatus::Completed, "fake done").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_store_loss_mid_run_stops_the_agent_and_journals_a_failed_outcome_once() {
    journal_scenario("start", "5", TaskStatus::Failed, "").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_skill_job_reaches_the_real_agent_process_as_its_prompt() {
    let rig = Rig::new();
    let prompt = "Run the saved skill \"Nightly\" (revision abc).\n\nSummarise open issues.";
    rig.seed_queued_task(prompt);
    let mut worker = rig.spawn("a", &[]);
    wait_until("task completed", 30, || {
        rig.store().tasks[0].status == TaskStatus::Completed
    })
    .await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 1);
    assert!(runs[0].contains("exec --json --sandbox workspace-write"));
    assert!(runs[0].contains("Run the saved skill"));
    assert_eq!(rig.store().tasks[0].result, "fake done");
    assert!(worker.graceful_exit().await.success());
}
