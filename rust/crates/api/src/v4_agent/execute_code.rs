use super::{
    execution_backend::scrubbed_host_environment,
    interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction},
    tools, ToolPolicy,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

pub(super) const NAME: &str = "execute_code";
const NESTED_TOOLS: [&str; 6] = [
    "list_files",
    "read_file",
    "search_text",
    "write_file",
    "replace_text",
    "apply_patch",
];
const MAX_SCRIPT_BYTES: usize = 100_000;
const MAX_STREAM_BYTES: usize = 50_000;
const MAX_NESTED_CALLS: usize = 50;
const MAX_RPC_BYTES: usize = 1_048_576;
const TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn nested_tools(policy: ToolPolicy) -> Vec<&'static str> {
    NESTED_TOOLS
        .into_iter()
        .filter(|name| policy.allows(name))
        .collect()
}

pub(super) fn definition() -> Value {
    json!({"name":NAME,"description":"Run a short Python 3 script that orchestrates several workspace tool calls in one step. The script runs on this host after the user approves its exact text; unattended tasks cannot approve it. Inside the script, `from v4_tools import read_file, list_files, search_text` (plus write_file, replace_text, apply_patch when this session may write) and call them with keyword arguments, for example read_file(path=\"a.txt\"); they return the same text as direct calls and raise v4_tools.ToolError on failure. Nested calls use the same policy and workspace checks as direct calls, at most 50 per script. Network access is disabled by default inside Python, and the environment holds no credentials, but there is no OS sandbox: the script has the same host file access as run_command. Maximum 60 seconds; stdout and stderr are bounded and returned as untrusted text.","parameters":{"type":"object","properties":{"script":{"type":"string"}},"required":["script"],"additionalProperties":false}})
}

fn script_text(input: &Value) -> Result<&str, String> {
    let script = input
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get("script"))
        .and_then(Value::as_str)
        .ok_or("Invalid script")?;
    if script.trim().is_empty() || script.len() > MAX_SCRIPT_BYTES || script.contains('\0') {
        return Err("Invalid script".into());
    }
    Ok(script)
}

fn approval_description(root: &Path, policy: ToolPolicy, script: &str) -> String {
    format!(
        "Python script (runs on this host with your file access; no OS sandbox)\nWorkspace: {}\nNested tools: {}\nScript:\n{}",
        root.display(),
        nested_tools(policy).join(", "),
        script
    )
}

pub(super) fn dispatch_nested(
    root: &Path,
    policy: ToolPolicy,
    tool: &str,
    input: &Value,
) -> Result<String, String> {
    if !nested_tools(policy).contains(&tool) {
        return Err("Tool is not available to execute_code".into());
    }
    tools::file_tool(root, tool, input)
}

fn support_files(policy: ToolPolicy) -> [(&'static str, String); 2] {
    let names = nested_tools(policy);
    let wrappers: String = names
        .iter()
        .map(|name| {
            format!("\ndef {name}(**arguments):\n    return _call(\"{name}\", arguments)\n")
        })
        .collect();
    let stub = format!(
        r#"import json
import os
import socket


class ToolError(Exception):
    pass


def _call(tool, arguments):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(os.environ["V4_RPC_SOCKET"])
        connection.sendall((json.dumps({{"tool": tool, "input": arguments}}) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = connection.recv(65536)
            if not chunk:
                break
            data += chunk
    reply = json.loads(data)
    if not reply["ok"]:
        raise ToolError(reply["output"])
    return reply["output"]
{wrappers}"#
    );
    let guard = r#"import socket as _socket


def _deny(*_args, **_kwargs):
    raise PermissionError("network access is disabled in execute_code")


def _guard(original):
    def wrapper(self, *args, **kwargs):
        if self.family != _socket.AF_UNIX:
            _deny()
        return original(self, *args, **kwargs)

    return wrapper


for _name in ("connect", "connect_ex", "sendto"):
    setattr(_socket.socket, _name, _guard(getattr(_socket.socket, _name)))
for _name in ("getaddrinfo", "gethostbyname", "gethostbyname_ex"):
    setattr(_socket, _name, _deny)
"#
    .to_string();
    [("v4_tools.py", stub), ("sitecustomize.py", guard)]
}

async fn read_bounded(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
) -> Result<(Vec<u8>, bool), String> {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    loop {
        let count = pipe
            .read(&mut buffer)
            .await
            .map_err(|_| "Cannot read script output")?;
        if count == 0 {
            return Ok((output, truncated));
        }
        let kept = count.min(MAX_STREAM_BYTES - output.len());
        output.extend_from_slice(&buffer[..kept]);
        truncated |= kept < count;
    }
}

async fn serve_connection(
    stream: tokio::net::UnixStream,
    handle: &(dyn Fn(&str, &Value) -> Result<String, String> + Sync),
) {
    let (reader, mut writer) = stream.into_split();
    let mut line = Vec::new();
    let mut reader = tokio::io::BufReader::new(reader.take(MAX_RPC_BYTES as u64 + 1));
    let reply = match reader.read_until(b'\n', &mut line).await {
        Ok(_) if line.len() > MAX_RPC_BYTES => json!({"ok":false,"output":"Request too large"}),
        Ok(_) => match serde_json::from_slice::<Value>(&line) {
            Ok(request) => match (request["tool"].as_str(), request.get("input")) {
                (Some(tool), Some(input)) => match handle(tool, input) {
                    Ok(output) if output.len() > MAX_RPC_BYTES => {
                        json!({"ok":false,"output":"Result too large"})
                    }
                    Ok(output) => json!({"ok":true,"output":output}),
                    Err(error) => json!({"ok":false,"output":error}),
                },
                _ => json!({"ok":false,"output":"Invalid request"}),
            },
            Err(_) => json!({"ok":false,"output":"Invalid request"}),
        },
        Err(_) => return,
    };
    let _ = writer.write_all(format!("{reply}\n").as_bytes()).await;
}

async fn serve(
    listener: &tokio::net::UnixListener,
    handle: &(dyn Fn(&str, &Value) -> Result<String, String> + Sync),
) -> String {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let _ =
                    tokio::time::timeout(Duration::from_secs(10), serve_connection(stream, handle))
                        .await;
            }
            Err(_) => return "Tool channel failed".into(),
        }
    }
}

async fn run_script(
    root: &Path,
    script: &str,
    policy: ToolPolicy,
    cancel: &Cancellation,
    timeout: Duration,
) -> Result<String, String> {
    cancel.check()?;
    let directory = tempfile::Builder::new()
        .prefix("v4-execute-code-")
        .tempdir()
        .map_err(|_| "Cannot prepare script directory")?;
    for (name, content) in support_files(policy) {
        std::fs::write(directory.path().join(name), content)
            .map_err(|_| "Cannot prepare script directory")?;
    }
    let script_path = directory.path().join("script.py");
    std::fs::write(&script_path, script).map_err(|_| "Cannot prepare script directory")?;
    let socket_path = directory.path().join("rpc.sock");
    let listener =
        tokio::net::UnixListener::bind(&socket_path).map_err(|_| "Cannot open the tool channel")?;

    let mut process = tokio::process::Command::new("python3");
    process
        .arg("-u")
        .arg(&script_path)
        .current_dir(root)
        .env_clear()
        .env("V4_RPC_SOCKET", &socket_path)
        .env("PYTHONPATH", directory.path())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    for (name, value) in scrubbed_host_environment(&|name| std::env::var_os(name)) {
        process.env(name, value);
    }
    let mut child = process.spawn().map_err(|_| "Cannot start python3")?;
    let tree = match crate::process_tree::ProcessTree::attach_new_process_group(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err("Cannot contain script processes".into());
        }
    };
    let mut stdout = child.stdout.take().ok_or("Script output unavailable")?;
    let mut stderr = child.stderr.take().ok_or("Script output unavailable")?;

    let calls = Mutex::new(Vec::<String>::new());
    let handle = |tool: &str, input: &Value| -> Result<String, String> {
        {
            let mut calls = calls.lock().map_err(|_| "Tool call log unavailable")?;
            if calls.len() >= MAX_NESTED_CALLS {
                return Err("execute_code nested tool call limit reached".into());
            }
            calls.push(tool.to_owned());
        }
        dispatch_nested(root, policy, tool, input)
    };

    let outcome = {
        let finished = async {
            let status = child
                .wait()
                .await
                .map_err(|_| "Cannot wait for script".to_string())?;
            tree.stop(Duration::from_millis(500))
                .await
                .map_err(|_| "Script process tree cleanup is unconfirmed".to_string())?;
            Ok::<_, String>(status)
        };
        let collected = async {
            tokio::try_join!(
                finished,
                read_bounded(&mut stdout),
                read_bounded(&mut stderr)
            )
        };
        tokio::pin!(collected);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Turn cancelled".to_string()),
            _ = tokio::time::sleep(timeout) => Err(format!("Script timed out after {} seconds", timeout.as_secs())),
            result = &mut collected => result,
            error = serve(&listener, &handle) => Err(error),
        }
    };
    let stopped = tree.stop(Duration::from_millis(500)).await;
    let reaped = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    if stopped.is_err() || !matches!(reaped, Ok(Ok(_))) {
        return Err("Script process cleanup is unconfirmed".into());
    }
    cancel.check()?;
    let (status, (out, out_truncated), (err, err_truncated)) = outcome?;
    Ok(json!({
        "untrusted": true,
        "exitCode": status.code(),
        "stdout": String::from_utf8_lossy(&out),
        "stderr": String::from_utf8_lossy(&err),
        "truncated": out_truncated || err_truncated,
        "toolCalls": calls.lock().map(|calls| calls.clone()).unwrap_or_default(),
    })
    .to_string())
}

pub(super) async fn run(
    root: &Path,
    input: &Value,
    approved: bool,
    policy: ToolPolicy,
    cancel: &Cancellation,
) -> Result<String, String> {
    run_with_timeout(root, input, approved, policy, cancel, TIMEOUT).await
}

async fn run_with_timeout(
    root: &Path,
    input: &Value,
    approved: bool,
    policy: ToolPolicy,
    cancel: &Cancellation,
    timeout: Duration,
) -> Result<String, String> {
    cancel.check()?;
    if !policy.allows(NAME) {
        return Err("Tool denied by read-only child policy".into());
    }
    if !approved {
        return Err(
            "Code execution permission required. Unattended tasks cannot approve scripts.".into(),
        );
    }
    run_script(root, script_text(input)?, policy, cancel, timeout).await
}

pub(super) async fn execute(
    root: &Path,
    input: &Value,
    policy: ToolPolicy,
    scope: &ActionScope,
    tool_call_id: &str,
    interaction: &dyn Interaction,
    cancel: &Cancellation,
) -> Result<String, String> {
    if !policy.allows(NAME) {
        return Err("Tool denied by read-only child policy".into());
    }
    let script = script_text(input)?;
    let approved = cancel
        .run(interaction.approve(ApprovalRequest {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.clone(),
            tool_call_id: tool_call_id.into(),
            tool_name: NAME.into(),
            tool_input: input.clone(),
            description: approval_description(root, policy, script),
            expires_at: super::interaction::now_ms() + 300_000,
        }))
        .await?;
    cancel.check()?;
    run(root, input, approved, policy, cancel).await
}

#[cfg(test)]
#[path = "execute_code_tests.rs"]
mod tests;
