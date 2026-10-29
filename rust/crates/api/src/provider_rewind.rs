use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
const BYTES: u64 = 8 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewindTurn {
    pub id: String,
    pub prompt: String,
    pub ordinal: usize,
    pub supported: bool,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeConversation {
    pub source_id: String,
    pub provider: String,
    pub native_session_id: String,
    pub title: String,
    pub turns: Vec<RewindTurn>,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePlan {
    pub conversation: NativeConversation,
    pub target_turn_id: String,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeFork {
    pub provider: String,
    pub native_session_id: String,
    pub original_session_id: String,
    pub resume_args: Vec<String>,
}

fn fingerprint(body: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(body.as_ref()))
}
fn same_workspace(candidate: &str, workspace: &Path) -> bool {
    std::fs::canonicalize(candidate)
        .ok()
        .zip(std::fs::canonicalize(workspace).ok())
        .is_some_and(|(p, w)| {
            crate::session_search::normalize_workspace_path(&p.to_string_lossy())
                == crate::session_search::normalize_workspace_path(&w.to_string_lossy())
        })
}
fn source_id(owner: &str, workspace: &Path, provider: &str, id: &str) -> String {
    fingerprint(format!(
        "{owner}\0{}\0{provider}\0{id}",
        crate::session_search::normalize_workspace_path(&workspace.to_string_lossy())
    ))
}
fn text(content: &Value) -> String {
    content.as_str().map(str::to_owned).unwrap_or_else(|| {
        content
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    })
}
fn turn(
    id: String,
    prompt: String,
    ordinal: usize,
    supported: bool,
    reason: Option<String>,
) -> RewindTurn {
    RewindTurn {
        id,
        prompt: crate::session_search::safe_history_text(&prompt)
            .chars()
            .take(12000)
            .collect(),
        ordinal,
        supported,
        reason,
    }
}
fn parse_jsonl(
    provider: &str,
    body: &str,
    workspace: &Path,
    owner: &str,
) -> Option<NativeConversation> {
    let records: Vec<Value> = body
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .ok()?;
    let mut native_id = None;
    let mut matching = false;
    let mut turns = Vec::new();
    if provider == "claude" {
        let mut messages = HashMap::new();
        let mut head = None;
        for record in &records {
            if record["isSidechain"] == true || record["isMeta"] == true {
                continue;
            }
            if let Some(cwd) = record["cwd"].as_str() {
                if !same_workspace(cwd, workspace) {
                    return None;
                }
                matching = true;
            }
            if let Some(id) = record["sessionId"].as_str() {
                if native_id.as_deref().is_some_and(|v| v != id) {
                    return None;
                }
                native_id = Some(id.to_owned());
            }
            if matches!(record["type"].as_str(), Some("user" | "assistant")) {
                let id = record["uuid"].as_str()?;
                messages.insert(id, record);
                head = Some(id);
            }
        }
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        while let Some(id) = head {
            if !seen.insert(id) {
                return None;
            }
            let message = messages.get(id)?;
            chain.push(*message);
            head = message["parentUuid"].as_str();
        }
        chain.reverse();
        for message in chain {
            if message["type"] == "user" && !text(&message["message"]["content"]).trim().is_empty()
            {
                let ordinal = turns.len();
                turns.push(turn(
                    message["uuid"].as_str()?.into(),
                    text(&message["message"]["content"]),
                    ordinal,
                    ordinal > 0,
                    (ordinal == 0).then(|| "Claude cannot fork before its first message".into()),
                ));
            }
        }
    } else if provider == "codex" {
        let mut current = None;
        for record in &records {
            let payload = &record["payload"];
            match record["type"].as_str() {
                Some("session_meta") => {
                    native_id = payload["id"].as_str().map(str::to_owned);
                    matching = same_workspace(payload["cwd"].as_str()?, workspace);
                }
                Some("turn_context") => current = payload["turn_id"].as_str().map(str::to_owned),
                Some("event_msg") if payload["type"] == "user_message" => {
                    let id = current.take()?;
                    turns.push(turn(
                        id,
                        payload["message"].as_str()?.into(),
                        turns.len(),
                        true,
                        None,
                    ));
                }
                _ => {}
            }
        }
    } else {
        return None;
    }
    let native_id = native_id?;
    if !matching || turns.is_empty() || turns.len() > 2000 || native_id.len() > 200 {
        return None;
    }
    Some(NativeConversation {
        source_id: source_id(owner, workspace, provider, &native_id),
        provider: provider.into(),
        native_session_id: native_id,
        title: turns[0].prompt.chars().take(100).collect(),
        turns,
        fingerprint: fingerprint(body),
    })
}
fn claude_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
        .join("projects")
}
fn walk(root: &Path, depth: usize, visited: &mut usize, files: &mut Vec<PathBuf>) {
    if depth > 4 || *visited >= 2000 {
        return;
    }
    let Ok(directory) = std::fs::read_dir(root) else {
        return;
    };
    for entry in directory.flatten() {
        *visited += 1;
        if *visited > 2000 {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            walk(&entry.path(), depth + 1, visited, files);
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "jsonl") {
            files.push(entry.path());
        }
    }
}
fn claude_sources(workspace: &Path, owner: &str) -> Vec<(NativeConversation, PathBuf, String)> {
    let root = claude_root();
    let mut files = Vec::new();
    walk(&root, 0, &mut 0, &mut files);
    files.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).and_then(|m| m.modified()).ok()));
    let mut result = Vec::new();
    let mut budget = 0;
    for path in files {
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || metadata.len() > BYTES {
            continue;
        }
        budget += metadata.len();
        if budget > 32 * 1024 * 1024 {
            break;
        }
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut body = String::new();
        if file.take(BYTES + 1).read_to_string(&mut body).is_err() || body.len() as u64 > BYTES {
            continue;
        }
        if let Some(conversation) = parse_jsonl("claude", &body, workspace, owner) {
            result.push((conversation, path, body));
            if result.len() == 50 {
                break;
            }
        }
    }
    result
}
fn codex_command() -> Option<Command> {
    let command = crate::agent_runtime::native_command("codex")?;
    let program = PathBuf::from(command.as_std().get_program());
    let launcher = command
        .as_std()
        .get_args()
        .find_map(|arg| {
            let path = PathBuf::from(arg);
            (path.is_absolute() && path.file_name().is_some_and(|name| name == "codex.js"))
                .then_some(path)
        })
        .or_else(|| {
            std::fs::canonicalize(&program)
                .ok()
                .filter(|p| p.extension().is_some_and(|v| v == "js"))
        });
    if let Some(launcher) = launcher {
        let root = launcher.parent()?.parent()?;
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let (platform, triple, binary) = if cfg!(windows) {
            (
                "win32",
                if arch == "arm64" {
                    "aarch64-pc-windows-msvc"
                } else {
                    "x86_64-pc-windows-msvc"
                },
                "codex.exe",
            )
        } else if cfg!(target_os = "macos") {
            (
                "darwin",
                if arch == "arm64" {
                    "aarch64-apple-darwin"
                } else {
                    "x86_64-apple-darwin"
                },
                "codex",
            )
        } else {
            (
                "linux",
                if arch == "arm64" {
                    "aarch64-unknown-linux-musl"
                } else {
                    "x86_64-unknown-linux-musl"
                },
                "codex",
            )
        };
        let package = format!("codex-{platform}-{arch}");
        for vendor in [
            root.join("node_modules/@openai")
                .join(&package)
                .join("vendor"),
            root.parent()?.join(&package).join("vendor"),
            root.join("vendor"),
        ] {
            let executable = vendor.join(triple).join("bin").join(binary);
            if executable.is_file() {
                return Some(Command::new(executable));
            }
        }
        // Do not leave an npm wrapper's child app-server running after a failed rewind.
        return None;
    }
    Some(command)
}
fn script(name: &str) -> PathBuf {
    std::env::var_os("TERMINAL_V4_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .join("scripts")
        .join(name)
}
async fn output(mut command: Command) -> Result<Value, String> {
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Native history runtime is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Native history output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Native history errors unavailable")?;
    let mut stdout = stdout.take(BYTES + 1);
    let mut stderr = stderr.take(65537);
    let work = async {
        let mut body = Vec::new();
        let mut errors = Vec::new();
        let (read, error_read, status) = tokio::join!(
            stdout.read_to_end(&mut body),
            stderr.read_to_end(&mut errors),
            child.wait()
        );
        read.map_err(|_| "Native history read failed")?;
        error_read.map_err(|_| "Native history read failed")?;
        if body.len() as u64 > BYTES
            || !status
                .map_err(|_| "Native history runtime failed")?
                .success()
        {
            return Err("Native history operation failed; source history is preserved".into());
        }
        serde_json::from_slice(&body).map_err(|_| "Native history returned invalid data".into())
    };
    tokio::time::timeout(Duration::from_secs(30), work)
        .await
        .map_err(|_| "Native history operation timed out".to_string())?
}
struct CodexRpc {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
}
impl CodexRpc {
    async fn start(workspace: &Path) -> Result<Self, String> {
        let mut command =
            codex_command().ok_or("Codex native app-server executable is unavailable")?;
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "Unable to start Codex history service")?;
        let input = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let output = BufReader::new(child.stdout.take().ok_or("Codex stdout unavailable")?);
        let mut rpc = Self {
            child,
            input,
            output,
            sequence: 0,
        };
        rpc.call("initialize",json!({"clientInfo":{"name":"terminal-v4-rewind","version":"1.0.0"},"capabilities":{"experimentalApi":true,"explicitGatewayOauth":true}})).await?;
        rpc.send(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(rpc)
    }
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let body = format!("{}\n", value);
        self.input
            .write_all(body.as_bytes())
            .await
            .map_err(|_| "Codex history connection closed".to_string())?;
        self.input
            .flush()
            .await
            .map_err(|_| "Codex history connection closed".into())
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        let operation = async {
            let mut budget = 0;
            for _ in 0..200 {
                let mut line = String::new();
                let count = (&mut self.output)
                    .take(BYTES + 1)
                    .read_line(&mut line)
                    .await
                    .map_err(|_| "Codex history read failed")?;
                budget += count;
                if count == 0 || budget as u64 > BYTES {
                    return Err("Codex history response exceeds limit".into());
                }
                let frame: Value = serde_json::from_str(&line)
                    .map_err(|_| "Codex history returned invalid data")?;
                if frame["id"] == id {
                    if frame.get("error").is_some() {
                        return Err(format!(
                            "Codex native history operation {method} was rejected"
                        ));
                    }
                    return frame
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Codex native history result unavailable".into());
                }
                if frame.get("id").is_some() && frame.get("method").is_some() {
                    self.send(json!({"id":frame["id"],"error":{"code":-32601,"message":"Rewind worker cannot approve runtime actions"}})).await?;
                }
            }
            Err("Codex history notification budget exceeded".into())
        };
        tokio::time::timeout(Duration::from_secs(20), operation)
            .await
            .map_err(|_| "Codex history operation timed out".to_string())?
    }
    async fn turns(&mut self, id: &str) -> Result<Vec<Value>, String> {
        let mut rows = Vec::new();
        let mut cursor = Value::Null;
        for _ in 0..20 {
            let page=self.call("thread/turns/list",json!({"threadId":id,"cursor":cursor,"limit":100,"sortDirection":"asc","itemsView":"full"})).await?;
            let batch = page["data"]
                .as_array()
                .ok_or("Codex turn history unsupported")?;
            rows.extend(batch.clone());
            if serde_json::to_vec(&rows)
                .map_err(|_| "Codex history cannot be encoded")?
                .len() as u64
                > BYTES
            {
                return Err("Codex conversation exceeds rewind byte limit".into());
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                return Ok(rows);
            }
        }
        Err("Codex conversation exceeds rewind turn limit".into())
    }
}
impl Drop for CodexRpc {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
fn codex_conversation(
    owner: &str,
    workspace: &Path,
    meta: &Value,
    rows: &[Value],
) -> Option<NativeConversation> {
    let native_id = meta["id"].as_str()?;
    if !same_workspace(meta["cwd"].as_str()?, workspace) {
        return None;
    }
    let busy = rows.iter().any(|row| row["status"] == "inProgress");
    let mut turns = Vec::new();
    for row in rows {
        let Some(items) = row["items"].as_array() else {
            continue;
        };
        let prompt = items
            .iter()
            .filter(|item| item["type"] == "userMessage")
            .map(|item| text(&item["content"]))
            .collect::<Vec<_>>()
            .join("\n");
        if prompt.trim().is_empty() {
            continue;
        }
        let ordinal = turns.len();
        let first_legacy = ordinal == 0 && meta["historyMode"] != "paginated";
        let supported = !busy && !first_legacy;
        let reason = if busy {
            Some("Stop the native agent before rewinding".into())
        } else if first_legacy {
            Some("Codex legacy history cannot rewind before its first turn".into())
        } else {
            None
        };
        turns.push(turn(
            row["id"].as_str()?.into(),
            prompt,
            ordinal,
            supported,
            reason,
        ));
    }
    if turns.is_empty() {
        return None;
    }
    Some(NativeConversation {
        source_id: source_id(owner, workspace, "codex", native_id),
        provider: "codex".into(),
        native_session_id: native_id.into(),
        title: turns[0].prompt.chars().take(100).collect(),
        turns,
        fingerprint: fingerprint(
            serde_json::to_vec(&json!({"id":native_id,"cwd":workspace,"turns":rows})).ok()?,
        ),
    })
}
async fn codex_sources(workspace: &Path, owner: &str) -> Result<Vec<NativeConversation>, String> {
    if crate::agent_runtime::native_command("codex").is_none() {
        return Ok(Vec::new());
    }
    let mut rpc = CodexRpc::start(workspace).await?;
    let response = rpc
        .call("thread/list", json!({"cwd":workspace,"limit":50}))
        .await?;
    let rows = response["data"]
        .as_array()
        .ok_or("Codex source history unsupported")?;
    let mut results = Vec::new();
    for meta in rows {
        let Some(id) = meta["id"].as_str() else {
            continue;
        };
        if !same_workspace(meta["cwd"].as_str().unwrap_or(""), workspace) {
            continue;
        }
        let turns = rpc.turns(id).await?;
        if let Some(conversation) = codex_conversation(owner, workspace, meta, &turns) {
            results.push(conversation);
        }
    }
    Ok(results)
}
fn v4_sources(data: &Path, workspace: &Path, owner: &str) -> Vec<NativeConversation> {
    crate::v4_agent::sessions(data, owner, workspace)
        .into_iter()
        .filter_map(|session| {
            let turns = session
                .messages
                .iter()
                .filter(|m| m.role == "user")
                .enumerate()
                .map(|(ordinal, m)| turn(ordinal.to_string(), m.text.clone(), ordinal, true, None))
                .collect::<Vec<_>>();
            if turns.is_empty() {
                return None;
            }
            Some(NativeConversation {
                source_id: source_id(owner, workspace, &session.provider, &session.id),
                provider: session.provider.clone(),
                native_session_id: session.id.clone(),
                title: turns[0].prompt.chars().take(100).collect(),
                turns,
                fingerprint: crate::v4_agent::session_fingerprint(&session),
            })
        })
        .collect()
}
pub(crate) async fn list(
    data: &Path,
    workspace: &Path,
    owner: &str,
) -> Result<Vec<NativeConversation>, String> {
    if !workspace.is_absolute() || !workspace.is_dir() || owner.is_empty() {
        return Err("Select an available workspace and account".into());
    }
    let owned = owner.to_owned();
    let directory = workspace.to_owned();
    let mut rows = tokio::task::spawn_blocking(move || {
        claude_sources(&directory, &owned)
            .into_iter()
            .map(|(row, _, _)| row)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| "Unable to load native Claude history")?;
    rows.extend(v4_sources(data, workspace, owner));
    let mut errors = Vec::new();
    match codex_sources(workspace, owner).await {
        Ok(provider) => rows.extend(provider),
        Err(error) => errors.push(error),
    }
    let mut seen = HashSet::new();
    rows.retain(|row| seen.insert(row.source_id.clone()));
    if rows.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(rows)
}
pub(crate) async fn plan(
    data: &Path,
    workspace: &Path,
    owner: &str,
    source: &str,
    target: &str,
) -> Result<NativePlan, String> {
    let conversation = list(data, workspace, owner)
        .await?
        .into_iter()
        .find(|row| row.source_id == source)
        .ok_or("Native conversation is unavailable for this workspace and account")?;
    let turn = conversation
        .turns
        .iter()
        .find(|turn| turn.id == target)
        .ok_or("Selected turn is unavailable")?;
    if !turn.supported {
        return Err(turn
            .reason
            .clone()
            .unwrap_or_else(|| "Native provider cannot rewind to this turn".into()));
    }
    Ok(NativePlan {
        fingerprint: conversation.fingerprint.clone(),
        conversation,
        target_turn_id: target.into(),
    })
}
pub(crate) async fn apply(
    data: &Path,
    workspace: &Path,
    owner: &str,
    planned: &NativePlan,
) -> Result<NativeFork, String> {
    let current = plan(
        data,
        workspace,
        owner,
        &planned.conversation.source_id,
        &planned.target_turn_id,
    )
    .await?;
    if current != *planned {
        return Err("Conversation changed; review a fresh rewind plan".into());
    }
    let original = &planned.conversation.native_session_id;
    let target = planned
        .conversation
        .turns
        .iter()
        .find(|turn| turn.id == planned.target_turn_id)
        .ok_or("Selected turn unavailable")?;
    let (native_session_id, resume_args) = match planned.conversation.provider.as_str() {
        "claude" => {
            let found = claude_sources(workspace, owner)
                .into_iter()
                .find(|(row, _, _)| row.source_id == planned.conversation.source_id)
                .ok_or("Claude source unavailable")?;
            if found.0.fingerprint != planned.fingerprint {
                return Err("Claude source changed".into());
            }
            let records: Vec<Value> = found
                .2
                .lines()
                .map(serde_json::from_str)
                .collect::<Result<_, _>>()
                .map_err(|_| "Claude native history invalid")?;
            let target = records
                .iter()
                .find(|v| v["uuid"] == planned.target_turn_id)
                .ok_or("Claude target unavailable")?;
            let cursor = target["parentUuid"]
                .as_str()
                .ok_or("Claude cannot fork before its first message")?;
            let mut command = crate::agent_runtime::native_command("node")
                .ok_or("Node.js is required for native Claude history")?;
            command.arg(script("provider-rewind-claude.mjs")).arg(
                json!({"sessionId":original,"workspace":workspace,"cursor":cursor}).to_string(),
            );
            let response = output(command).await?;
            let id = response["sessionId"]
                .as_str()
                .ok_or("Claude fork ID unavailable")?
                .to_owned();
            (id.clone(), vec!["--resume".into(), id])
        }
        "codex" => {
            let mut rpc = CodexRpc::start(workspace).await?;
            let mut params = json!({"threadId":original,"cwd":workspace,"sandbox":"workspace-write","approvalPolicy":"on-request"});
            if target.ordinal > 0 {
                params["lastTurnId"] = json!(planned.conversation.turns[target.ordinal - 1].id);
            }
            let response = rpc.call("thread/fork", params).await?;
            let id = response["thread"]["id"]
                .as_str()
                .ok_or("Codex fork ID unavailable")?
                .to_owned();
            if id == *original {
                return Err("Codex did not create an independent fork".into());
            }
            if target.ordinal == 0 {
                let rows = rpc.turns(&id).await?;
                let before = rows
                    .iter()
                    .find_map(|row| {
                        row["items"]
                            .as_array()
                            .filter(|items| items.iter().any(|item| item["type"] == "userMessage"))
                            .and_then(|_| row["id"].as_str())
                    })
                    .ok_or("Codex fork contains no target turn")?;
                rpc.call(
                    "thread/revert",
                    json!({"threadId":id,"beforeTurnId":before}),
                )
                .await
                .map_err(|error| format!("{error}; original preserved, unused fork {id}"))?;
            }
            let retained = rpc
                .turns(&id)
                .await
                .map_err(|error| format!("{error}; original preserved, unused fork {id}"))?;
            let returned = codex_conversation(
                owner,
                workspace,
                &json!({"id":id,"cwd":workspace,"historyMode":"paginated"}),
                &retained,
            )
            .map(|row| {
                row.turns
                    .into_iter()
                    .map(|turn| turn.prompt)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
            let expected = planned.conversation.turns[..target.ordinal]
                .iter()
                .map(|turn| turn.prompt.clone())
                .collect::<Vec<_>>();
            if returned != expected {
                return Err(format!("Codex native fork did not retain the selected prefix; original preserved, unused fork {id}"));
            }
            (id.clone(), vec!["resume".into(), id])
        }
        provider if crate::v4_agent::supports(provider) => {
            let fork = crate::v4_agent::fork(
                data,
                owner,
                workspace,
                original,
                target.ordinal,
                &planned.fingerprint,
            )?;
            (fork.id.clone(), vec!["--resume".into(), fork.id])
        }
        _ => return Err("This provider has no native conversation rewind adapter".into()),
    };
    if native_session_id.is_empty()
        || native_session_id.len() > 200
        || native_session_id.chars().any(char::is_control)
        || native_session_id == *original
    {
        return Err("Provider returned an invalid independent session".into());
    }
    Ok(NativeFork {
        provider: planned.conversation.provider.clone(),
        native_session_id,
        original_session_id: original.clone(),
        resume_args,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires the locally installed Codex binary; never sends a model request"]
    async fn installed_codex_handshake_supports_native_history_without_model_execution() {
        let folder = tempfile::tempdir().unwrap();
        let mut rpc = CodexRpc::start(folder.path()).await.unwrap();
        let result = rpc
            .call("thread/list", json!({"cwd":folder.path(),"limit":1}))
            .await
            .unwrap();
        assert_eq!(result["data"], json!([]));
    }

    #[test]
    fn claude_turns_follow_active_parent_chain_and_preserve_precise_native_ids() {
        let folder = tempfile::tempdir().unwrap();
        let cwd = folder.path().to_string_lossy();
        let body=[serde_json::json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":"00000000-0000-4000-8000-000000000001","cwd":cwd,"message":{"content":"first"}}),serde_json::json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"content":[{"type":"text","text":"reply"}]}}),serde_json::json!({"type":"user","uuid":"u2","parentUuid":"a1","message":{"content":"second"}})].iter().map(|v|v.to_string()).collect::<Vec<_>>().join("\n");
        let parsed = parse_jsonl("claude", &body, folder.path(), "owner").unwrap();
        assert_eq!(
            parsed.turns,
            vec![
                RewindTurn {
                    id: "u1".into(),
                    prompt: "first".into(),
                    ordinal: 0,
                    supported: false,
                    reason: Some("Claude cannot fork before its first message".into())
                },
                RewindTurn {
                    id: "u2".into(),
                    prompt: "second".into(),
                    ordinal: 1,
                    supported: true,
                    reason: None
                }
            ]
        );
        assert_ne!(
            parsed.source_id,
            parse_jsonl("claude", &body, folder.path(), "another")
                .unwrap()
                .source_id
        );
    }
    #[test]
    fn codex_native_turn_capabilities_distinguish_legacy_paginated_and_busy_history() {
        let directory = tempfile::tempdir().unwrap();
        let id = "00000000-0000-4000-8000-000000000002";
        let legacy = json!({"id":id,"cwd":directory.path(),"historyMode":"legacy"});
        let mut rows = vec![
            json!({"id":"turn-one","status":"completed","items":[{"type":"userMessage","content":[{"type":"text","text":"first"}]}]}),
            json!({"id":"turn-two","status":"completed","items":[{"type":"userMessage","content":[{"type":"text","text":"second"}]}]}),
        ];
        let original = codex_conversation("owner", directory.path(), &legacy, &rows).unwrap();
        assert_eq!(
            original
                .turns
                .iter()
                .map(|turn| (turn.id.as_str(), turn.supported, turn.reason.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (
                    "turn-one",
                    false,
                    Some("Codex legacy history cannot rewind before its first turn")
                ),
                ("turn-two", true, None)
            ]
        );
        let paginated = json!({"id":id,"cwd":directory.path(),"historyMode":"paginated"});
        assert!(
            codex_conversation("owner", directory.path(), &paginated, &rows)
                .unwrap()
                .turns
                .iter()
                .all(|turn| turn.supported)
        );
        assert_ne!(
            original.source_id,
            codex_conversation("other", directory.path(), &legacy, &rows)
                .unwrap()
                .source_id
        );
        assert!(codex_conversation("owner", Path::new("missing"), &legacy, &rows).is_none());
        rows[1]["status"] = json!("inProgress");
        let busy = codex_conversation("owner", directory.path(), &paginated, &rows).unwrap();
        assert!(busy.turns.iter().all(|turn| !turn.supported));
        assert_ne!(original.fingerprint, busy.fingerprint);
    }
}
