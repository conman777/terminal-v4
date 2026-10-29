use super::*;
use crate::v4_agent::interaction::now_ms;
use async_trait::async_trait;
use std::sync::Mutex;
use terminal_v4_core::StructuredSessionEvent;

const STANDARD: ToolPolicy = ToolPolicy::Standard;

fn input(script: &str) -> Value {
    json!({"script":script})
}

async fn run_script_for_test(root: &Path, script: &str) -> Value {
    let output = run_with_timeout(
        root,
        &input(script),
        true,
        STANDARD,
        &Cancellation::default(),
        Duration::from_secs(20),
    )
    .await
    .unwrap();
    serde_json::from_str(&output).unwrap()
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn assert_dead(pid: i32) {
    for _ in 0..100 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("process {pid} survived");
}

struct Recorder {
    approve: bool,
    requests: Mutex<Vec<ApprovalRequest>>,
}
#[async_trait]
impl Interaction for Recorder {
    async fn emit(&self, _event: StructuredSessionEvent) -> Result<(), String> {
        Ok(())
    }
    async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
        self.requests.lock().unwrap().push(request);
        Ok(self.approve)
    }
}

fn scope() -> ActionScope {
    ActionScope {
        owner: "owner".into(),
        session_id: "session".into(),
        turn_id: "turn".into(),
    }
}

#[test]
fn script_text_accepts_only_a_single_bounded_script_field() {
    assert_eq!(script_text(&input("print(1)")), Ok("print(1)"));
    for bad in [
        json!({}),
        json!({"script":""}),
        json!({"script":"  \n"}),
        json!({"script":"a\u{0}b"}),
        json!({"script":"x","extra":1}),
        json!({"script":7}),
        json!({"script":"x".repeat(MAX_SCRIPT_BYTES + 1)}),
    ] {
        assert_eq!(script_text(&bad), Err("Invalid script".into()), "{bad}");
    }
}

#[test]
fn read_only_child_never_sees_or_may_use_execute_code() {
    assert!(!ToolPolicy::ReadOnlyChild.allows(NAME));
    assert!(ToolPolicy::Standard.allows(NAME));
    let names = |policy| -> Vec<String> {
        super::super::tool_definitions(policy, Path::new("/nonexistent"), "owner")
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap().to_owned())
            .collect()
    };
    assert!(!names(ToolPolicy::ReadOnlyChild).contains(&NAME.to_owned()));
    assert!(names(STANDARD).contains(&NAME.to_owned()));
}

#[test]
fn nested_tools_follow_the_parent_policy() {
    assert_eq!(
        nested_tools(ToolPolicy::ReadOnlyChild),
        ["list_files", "read_file", "search_text"]
    );
    assert_eq!(nested_tools(STANDARD), NESTED_TOOLS);
    let root = tempfile::tempdir().unwrap();
    for tool in [
        "write_file",
        "replace_text",
        "apply_patch",
        "run_command",
        "execute_code",
        "mcp_call_tool",
    ] {
        let policy = if NESTED_TOOLS.contains(&tool) {
            ToolPolicy::ReadOnlyChild
        } else {
            STANDARD
        };
        assert_eq!(
            dispatch_nested(root.path(), policy, tool, &json!({})),
            Err("Tool is not available to execute_code".into()),
            "{tool}"
        );
    }
}

#[tokio::test]
async fn unapproved_scripts_never_start() {
    let root = tempfile::tempdir().unwrap();
    let result = run(
        root.path(),
        &input("open('ran','w').write('x')"),
        false,
        STANDARD,
        &Cancellation::default(),
    )
    .await;
    assert_eq!(
        result,
        Err("Code execution permission required. Unattended tasks cannot approve scripts.".into())
    );
    assert!(!root.path().join("ran").exists());
}

#[tokio::test]
async fn read_only_policy_blocks_execution_even_when_approved() {
    let root = tempfile::tempdir().unwrap();
    let result = run(
        root.path(),
        &input("open('ran','w').write('x')"),
        true,
        ToolPolicy::ReadOnlyChild,
        &Cancellation::default(),
    )
    .await;
    assert_eq!(result, Err("Tool denied by read-only child policy".into()));
    assert!(!root.path().join("ran").exists());
}

#[tokio::test]
async fn approval_request_binds_the_exact_script_and_declined_runs_nothing() {
    let root = tempfile::tempdir().unwrap();
    let call = input("open('ran','w').write('x')\n# exact text");
    let declined = Recorder {
        approve: false,
        requests: Mutex::new(Vec::new()),
    };
    let result = execute(
        root.path(),
        &call,
        STANDARD,
        &scope(),
        "call-1",
        &declined,
        &Cancellation::default(),
    )
    .await;
    assert_eq!(
        result,
        Err("Code execution permission required. Unattended tasks cannot approve scripts.".into())
    );
    assert!(!root.path().join("ran").exists());
    let requests = declined.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].tool_name, NAME);
    assert_eq!(requests[0].tool_input, call);
    assert_eq!(requests[0].tool_call_id, "call-1");
    assert!(requests[0]
        .description
        .ends_with("Script:\nopen('ran','w').write('x')\n# exact text"));
    assert!(requests[0].expires_at > now_ms());
}

#[tokio::test]
async fn approved_script_runs_and_nested_calls_use_workspace_file_tools() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.txt"), "alpha").unwrap();
    let approving = Recorder {
        approve: true,
        requests: Mutex::new(Vec::new()),
    };
    let output = execute(
        root.path(),
        &input("from v4_tools import read_file, write_file\nwrite_file(path='b.txt', content=read_file(path='a.txt') + '!')\nprint('done')"),
        STANDARD,
        &scope(),
        "call-2",
        &approving,
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["stdout"], "done\n");
    assert_eq!(value["exitCode"], 0);
    assert_eq!(value["untrusted"], true);
    assert_eq!(value["toolCalls"], json!(["read_file", "write_file"]));
    assert_eq!(
        std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
        "alpha!"
    );
}

#[tokio::test]
async fn script_cannot_reach_tools_outside_the_nested_set_or_protected_paths() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(".env"), "SECRET=1").unwrap();
    let value = run_script_for_test(
        root.path(),
        "import v4_tools\nfor tool, args in [('run_command', {'command': 'touch ran'}), ('read_file', {'path': '.env'}), ('read_file', {'path': '../x'})]:\n    try:\n        v4_tools._call(tool, args)\n        print('allowed', tool)\n    except v4_tools.ToolError:\n        print('denied', tool)\n",
    )
    .await;
    assert_eq!(
        value["stdout"],
        "denied run_command\ndenied read_file\ndenied read_file\n"
    );
    assert!(!root.path().join("ran").exists());
}

#[tokio::test]
async fn nested_call_count_is_limited() {
    let root = tempfile::tempdir().unwrap();
    let value = run_script_for_test(
        root.path(),
        "from v4_tools import list_files, ToolError\nokay = 0\nfor _ in range(60):\n    try:\n        list_files(path='.')\n        okay += 1\n    except ToolError:\n        pass\nprint(okay)\n",
    )
    .await;
    assert_eq!(value["stdout"], format!("{MAX_NESTED_CALLS}\n"));
}

#[tokio::test]
async fn stdout_and_stderr_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let value = run_script_for_test(
        root.path(),
        "import sys\nsys.stdout.write('a' * 300000)\nsys.stderr.write('b' * 300000)\n",
    )
    .await;
    assert_eq!(value["stdout"].as_str().unwrap().len(), MAX_STREAM_BYTES);
    assert_eq!(value["stderr"].as_str().unwrap().len(), MAX_STREAM_BYTES);
    assert_eq!(value["truncated"], true);
}

#[tokio::test]
async fn environment_is_scrubbed_to_the_allowlist_plus_channel_variables() {
    let root = tempfile::tempdir().unwrap();
    let value = run_script_for_test(
        root.path(),
        "import os, json\nprint(json.dumps(sorted(os.environ)))\n",
    )
    .await;
    let names: Vec<String> = serde_json::from_str(value["stdout"].as_str().unwrap()).unwrap();
    let allowed = [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "TERM",
        "V4_RPC_SOCKET",
        "PYTHONPATH",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONIOENCODING",
        "LC_CTYPE",
        "__CF_USER_TEXT_ENCODING",
        "CPATH",
        "LIBRARY_PATH",
        "MANPATH",
        "SDKROOT",
    ];
    let unexpected: Vec<&String> = names
        .iter()
        .filter(|name| !allowed.contains(&name.as_str()))
        .collect();
    assert_eq!(unexpected, Vec::<&String>::new());
    assert!(names.contains(&"V4_RPC_SOCKET".to_owned()));
}

#[tokio::test]
async fn network_connections_are_refused_by_default() {
    let root = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let value = run_script_for_test(
        root.path(),
        &format!("import socket\ntry:\n    socket.create_connection(('127.0.0.1', {port}), timeout=3)\n    print('connected')\nexcept PermissionError:\n    print('blocked')\n"),
    )
    .await;
    assert_eq!(value["stdout"], "blocked\n");
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}

#[tokio::test]
async fn timeout_kills_the_whole_process_group() {
    let root = tempfile::tempdir().unwrap();
    let result = run_with_timeout(
        root.path(),
        &input("import subprocess, time\np = subprocess.Popen(['sleep', '300'])\nopen('pid', 'w').write(str(p.pid))\ntime.sleep(300)\n"),
        true,
        STANDARD,
        &Cancellation::default(),
        Duration::from_secs(2),
    )
    .await;
    assert_eq!(result, Err("Script timed out after 2 seconds".into()));
    let pid: i32 = std::fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_dead(pid).await;
}

#[tokio::test]
async fn cancellation_kills_the_whole_process_group() {
    let root = tempfile::tempdir().unwrap();
    let cancel = Cancellation::default();
    let trigger = cancel.clone();
    let path = root.path().to_path_buf();
    tokio::spawn(async move {
        for _ in 0..200 {
            if path.join("pid").exists()
                && !std::fs::read_to_string(path.join("pid"))
                    .unwrap()
                    .is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        trigger.cancel();
    });
    let result = run_with_timeout(
        root.path(),
        &input("import subprocess, time\np = subprocess.Popen(['sleep', '300'])\nopen('pid', 'w').write(str(p.pid))\ntime.sleep(300)\n"),
        true,
        STANDARD,
        &cancel,
        Duration::from_secs(30),
    )
    .await;
    assert_eq!(result, Err("Turn cancelled".into()));
    let pid: i32 = std::fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_dead(pid).await;
}

#[tokio::test]
async fn leftover_background_children_are_killed_when_the_script_exits() {
    let root = tempfile::tempdir().unwrap();
    let value = run_script_for_test(
        root.path(),
        "import subprocess\np = subprocess.Popen(['sleep', '300'])\nopen('pid', 'w').write(str(p.pid))\nprint('exit')\n",
    )
    .await;
    assert_eq!(value["stdout"], "exit\n");
    let pid: i32 = std::fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_dead(pid).await;
}
