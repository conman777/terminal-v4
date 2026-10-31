use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

#[path = "file_patch.rs"]
mod file_patch;
#[cfg(all(test, unix))]
#[path = "tools/search_tests.rs"]
mod search_tests;
#[cfg(unix)]
#[path = "tools/search.rs"]
mod secure_search;

const FILE_BYTES: u64 = 512_000;
pub(super) fn definitions() -> Vec<Value> {
    [
        ("list_files", "List a workspace directory. Excludes symlinks and credential files.", json!({"path":{"type":"string"}}),vec!["path"]),
        ("read_file", "Read a UTF-8 workspace file up to 512 KB, or use bounded pagination. Line pages use 1-based start_line and line_count (1-2000) for files up to 512 KB. Byte pages use 0-based start_byte and byte_count (4-512000), including on larger files; follow nextByte and do not mix page types.", json!({"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"line_count":{"type":"integer","minimum":1,"maximum":2000},"start_byte":{"type":"integer","minimum":0,"maximum":9007199254740991u64},"byte_count":{"type":"integer","minimum":4,"maximum":512000}}),vec!["path"]),
        ("search_text", "Search workspace file contents or paths, with bounded results. Defaults to case-sensitive literal content search. On Unix, optional regex, case_sensitive and mode (content or files) are available; regex case folding is ASCII-only and long lines may be skipped. Check truncated for incomplete results.", json!({"path":{"type":"string"},"text":{"type":"string"},"regex":{"type":"boolean"},"case_sensitive":{"type":"boolean"},"mode":{"type":"string","enum":["content","files"]}}),vec!["path","text"]),
        ("write_file", "Create or replace a workspace file. Existing parent directories are required. Never edit unrelated user work.", json!({"path":{"type":"string"},"content":{"type":"string"}}),vec!["path","content"]),
        ("replace_text", "Replace literal occurrences in a workspace file. Defaults to exactly one match; set expected_count to replace exactly that many matches. Fails if the count differs.", json!({"path":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"},"expected_count":{"type":"integer","minimum":1,"maximum":1000}}),vec!["path","old","new"]),
        ("run_command", "Run a shell command in the workspace only after the user approves that exact command. Unattended tasks cannot approve commands. Maximum 60 seconds.", json!({"command":{"type":"string"}}),vec!["command"]),
        ("apply_patch", file_patch::DESCRIPTION, file_patch::properties(), vec!["path","hunks"]),
    ].into_iter().map(|(name,description,properties,required)| json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
pub(super) fn protected(name: &str) -> bool {
    // Lower first so capital sharp S expands through ß -> SS; long s and
    // Kelvin sign also fold to their ASCII filesystem-equivalent spellings.
    let name: String = name
        .chars()
        .flat_map(char::to_lowercase)
        .flat_map(char::to_uppercase)
        .flat_map(char::to_lowercase)
        .collect();
    name == ".git"
        || name.starts_with(".env")
        || [
            ".ssh",
            ".aws",
            ".codex",
            ".hermes",
            "auth.json",
            "credentials.json",
            "terminal.db",
            "vault.key",
        ]
        .contains(&name.as_str())
}
fn checked_path(root: &Path, relative: &str, create: bool) -> Result<PathBuf, String> {
    if relative.len() > 2048 || relative.chars().any(char::is_control) {
        return Err("Invalid workspace path".into());
    }
    let mut path = root.to_owned();
    let components: Vec<_> = Path::new(relative).components().collect();
    for (i, part) in components.iter().enumerate() {
        match part {
            Component::CurDir => continue,
            Component::Normal(name) if !protected(&name.to_string_lossy()) => path.push(name),
            _ => return Err("Path is outside the workspace or protected".into()),
        }
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("Symlink paths are not allowed".into())
            }
            Ok(_) => {}
            Err(e)
                if create
                    && i + 1 == components.len()
                    && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Workspace path is unavailable".into()),
        }
    }
    Ok(path)
}
fn read(path: &Path) -> Result<String, String> {
    if !std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= FILE_BYTES
    }) {
        return Err("File is too large or not a regular file".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|_| "Cannot read workspace file")?;
    if !file
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() <= FILE_BYTES)
    {
        return Err("File is too large or not a regular file".into());
    }
    let mut content = String::new();
    file.take(FILE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|_| "File is not readable UTF-8")?;
    if content.len() as u64 > FILE_BYTES {
        return Err("File exceeds 512 KB".into());
    }
    Ok(content)
}
fn read_byte_page(path: &Path, start: u64, count: u64) -> Result<String, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    if !std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Err("File is not a regular file".into());
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot read workspace file")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect workspace file")?;
    if !metadata.is_file() || metadata.len() > 9_007_199_254_740_991 || start > metadata.len() {
        return Err("Invalid file size or byte offset".into());
    }
    let size = count.min(metadata.len() - start) as usize;
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "Cannot seek workspace file")?;
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes)
        .map_err(|_| "File changed while reading")?;
    let used = match std::str::from_utf8(&bytes) {
        Ok(_) => size,
        Err(error)
            if error.error_len().is_none()
                && start + (size as u64) < metadata.len()
                && error.valid_up_to() > 0 =>
        {
            error.valid_up_to()
        }
        Err(_) => {
            return Err("File page is not readable UTF-8 or starts inside a character".into())
        }
    };
    let content =
        std::str::from_utf8(&bytes[..used]).map_err(|_| "File page is not readable UTF-8")?;
    let end = start + used as u64;
    Ok(json!({"content":content,"startByte":start,"nextByte":if end < metadata.len() {Some(end)} else {None},"fileBytes":metadata.len()}).to_string())
}
fn write(path: &Path, content: &str) -> Result<String, String> {
    if content.len() as u64 > FILE_BYTES {
        return Err("Content exceeds 512 KB".into());
    }
    let parent = path.parent().ok_or("Invalid destination")?;
    if path.is_dir() {
        return Err("Destination is a directory".into());
    }
    let permissions = std::fs::metadata(path).ok().map(|m| m.permissions());
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot create workspace file")?;
    use std::io::Write;
    file.write_all(content.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot write workspace file")?;
    if let Some(permissions) = permissions {
        file.as_file()
            .set_permissions(permissions)
            .map_err(|_| "Cannot preserve file permissions")?;
    }
    file.persist(path)
        .map_err(|_| "Cannot replace workspace file")?;
    Ok(format!("Wrote {} bytes", content.len()))
}
#[cfg(not(unix))]
fn search(
    root: &Path,
    path: &Path,
    needle: &str,
    depth: usize,
    visited: &mut usize,
    output: &mut Vec<Value>,
) {
    if depth > 8 || *visited >= 2000 || output.len() >= 100 {
        return;
    }
    *visited += 1;
    if path.is_file() {
        if let Ok(content) = read(path) {
            for (i, line) in content.lines().enumerate() {
                if line.contains(needle) && output.len() < 100 {
                    output.push(json!({"path":path.strip_prefix(root).unwrap_or(path),"line":i+1,"text":line.chars().take(500).collect::<String>()}));
                }
            }
        }
    } else if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.take(2000).flatten() {
            if protected(&entry.file_name().to_string_lossy())
                || ["node_modules", "target", "dist"]
                    .contains(&entry.file_name().to_string_lossy().as_ref())
                || entry.file_type().is_ok_and(|t| t.is_symlink())
            {
                continue;
            }
            search(root, &entry.path(), needle, depth + 1, visited, output);
        }
    }
}
fn text<'a>(input: &'a Value, name: &str) -> Result<&'a str, String> {
    input[name]
        .as_str()
        .ok_or_else(|| format!("Missing string argument: {name}"))
}
pub(super) fn file_tool(root: &Path, name: &str, input: &Value) -> Result<String, String> {
    let schema = definitions()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .ok_or("Unknown tool")?;
    if input.as_object().is_none_or(|args| {
        args.keys()
            .any(|key| schema["parameters"]["properties"].get(key).is_none())
    }) {
        return Err("Unexpected tool arguments".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "Workspace is unavailable")?;
    if root.components().any(|component| matches!(component, Component::Normal(name) if protected(&name.to_string_lossy()))) {
        return Err("Workspace path is protected".into());
    }
    #[cfg(unix)]
    if name == "search_text" {
        return secure_search::run(&root, text(input, "path")?, input);
    }
    let path = checked_path(&root, text(input, "path")?, name == "write_file")?;
    match name {
        "read_file" => {
            if input.get("start_byte").is_some() || input.get("byte_count").is_some() {
                if input.get("start_line").is_some() || input.get("line_count").is_some() {
                    return Err("Cannot combine line and byte pagination".into());
                }
                let start = match input.get("start_byte") {
                    None => 0,
                    Some(value) => value
                        .as_u64()
                        .filter(|n| *n <= 9_007_199_254_740_991)
                        .ok_or("Invalid start_byte")?,
                };
                let count = match input.get("byte_count") {
                    None => FILE_BYTES,
                    Some(value) => value
                        .as_u64()
                        .filter(|n| (4..=FILE_BYTES).contains(n))
                        .ok_or("Invalid byte_count")?,
                };
                return read_byte_page(&path, start, count);
            }
            if input.get("start_line").is_none() && input.get("line_count").is_none() {
                return read(&path);
            }
            let positive = |key: &str, default: u64, max: u64| -> Result<u64, String> {
                match input.get(key) {
                    None => Ok(default),
                    Some(value) => value
                        .as_u64()
                        .filter(|&n| n > 0 && n <= max)
                        .ok_or_else(|| format!("Invalid {key}")),
                }
            };
            let start = positive("start_line", 1, usize::MAX as u64)? as usize;
            let count = positive("line_count", 200, 2000)? as usize;
            let content = read(&path)?;
            let total = content.split_inclusive('\n').count();
            let page = content
                .split_inclusive('\n')
                .skip(start - 1)
                .take(count)
                .collect::<String>();
            let next = start.checked_add(count).filter(|&line| line <= total);
            Ok(
                json!({"content":page,"startLine":start,"nextLine":next,"totalLines":total})
                    .to_string(),
            )
        }
        "list_files" => {
            let mut rows = Vec::new();
            for entry in std::fs::read_dir(path)
                .map_err(|_| "Cannot list directory")?
                .take(500)
                .flatten()
            {
                let kind = entry.file_type().map_err(|_| "Cannot inspect entry")?;
                if protected(&entry.file_name().to_string_lossy()) || kind.is_symlink() {
                    continue;
                }
                rows.push(
                    json!({"name":entry.file_name().to_string_lossy(),"directory":kind.is_dir()}),
                );
            }
            rows.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_owned());
            Ok(json!({"entries":rows,"limit":500}).to_string())
        }
        "write_file" => write(&path, text(input, "content")?),
        "apply_patch" => file_patch::apply(&path, input),
        "replace_text" => {
            let content = read(&path)?;
            let old = text(input, "old")?;
            let new = text(input, "new")?;
            let expected = match input.get("expected_count") {
                None => 1,
                Some(value) => value
                    .as_u64()
                    .filter(|count| (1..=1000).contains(count))
                    .ok_or("expected_count must be an integer from 1 to 1000")?
                    as usize,
            };
            if old.is_empty() || content.matches(old).take(expected + 1).count() != expected {
                return Err("Matching occurrence count differs; read the file again".into());
            }
            let result_len = content.len() - old.len() * expected;
            if new
                .len()
                .checked_mul(expected)
                .and_then(|size| result_len.checked_add(size))
                .is_none_or(|size| size as u64 > FILE_BYTES)
            {
                return Err("Content exceeds 512 KB".into());
            }
            write(&path, &content.replace(old, new))
        }
        "search_text" => {
            if input.get("regex").is_some()
                || input.get("case_sensitive").is_some()
                || input.get("mode").is_some()
            {
                return Err("Search options are unavailable on this platform".into());
            }
            #[cfg(not(unix))]
            {
                let needle = text(input, "text")?;
                if needle.is_empty() || needle.len() > 1000 {
                    return Err("Search text must be 1-1000 bytes".into());
                }
                let mut rows = Vec::new();
                let mut visited = 0;
                search(&root, &path, needle, 0, &mut visited, &mut rows);
                Ok(json!({"matches":rows,"visited":visited,"limits":{"entries":2000,"matches":100,"depth":8}}).to_string())
            }
            #[cfg(unix)]
            unreachable!()
        }
        _ => Err("Unknown file tool".into()),
    }
}
#[cfg(test)]
pub(super) async fn run_command(
    root: &Path,
    input: &Value,
    approved: bool,
) -> Result<String, String> {
    run_command_with_timeout(root, input, approved, std::time::Duration::from_secs(60)).await
}

struct OwnedCommand {
    // Keep the tree and pipe handles owned even if its I/O future is dropped.
    // Closing a full pipe before discovering descendants could make a writer
    // exit on SIGPIPE before containment has observed its children.
    tree: Option<crate::process_tree::ProcessTree>,
    child: tokio::process::Child,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    cleanup: Option<std::sync::Arc<std::sync::Mutex<super::execution_backend::ContainerCleanup>>>,
}
impl OwnedCommand {
    async fn stop(&mut self) -> Result<(), String> {
        let Self {
            tree,
            child,
            stdout,
            stderr,
            cleanup,
        } = self;
        if tree.is_none() {
            let _ = child.start_kill();
        }
        let (stopped, waited, drained) = tokio::join!(
            async {
                let tree = tree.as_ref().ok_or("Command containment is unavailable")?;
                tree.stop(std::time::Duration::from_millis(500))
                    .await
                    .map_err(|_| "Command process tree cleanup is unconfirmed")
            },
            tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()),
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                tokio::try_join!(
                    discard_command_output(stdout),
                    discard_command_output(stderr)
                )
            }),
        );
        if !matches!(waited, Ok(Ok(_))) {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(std::time::Duration::from_millis(300), child.wait()).await;
        }
        let cleanup_result = if let Some(cleanup) = cleanup {
            let cleanup = std::sync::Arc::clone(cleanup);
            tokio::task::spawn_blocking(move || {
                cleanup
                    .lock()
                    .map_err(|_| "Docker container cleanup is unconfirmed".to_owned())?
                    .force_remove()
            })
            .await
            .map_err(|_| "Docker container cleanup is unconfirmed".to_owned())?
        } else {
            Ok(())
        };
        stopped.map_err(str::to_owned)?;
        if !matches!(waited, Ok(Ok(_))) {
            return Err("Command process exit could not be confirmed".into());
        }
        if !matches!(drained, Ok(Ok(_))) {
            return Err("Command output pipes did not close after cleanup".into());
        }
        cleanup_result?;
        Ok(())
    }
}
async fn discard_command_output(
    pipe: &mut Option<impl tokio::io::AsyncRead + Unpin>,
) -> std::io::Result<u64> {
    match pipe {
        Some(pipe) => tokio::io::copy(pipe, &mut tokio::io::sink()).await,
        None => Ok(0),
    }
}

pub(super) struct CommandResources {
    current: tokio::sync::Mutex<Option<OwnedCommand>>,
    confirmed: std::sync::atomic::AtomicBool,
}
impl Default for CommandResources {
    fn default() -> Self {
        Self {
            current: tokio::sync::Mutex::new(None),
            confirmed: std::sync::atomic::AtomicBool::new(true),
        }
    }
}
impl CommandResources {
    pub(super) fn is_confirmed(&self) -> bool {
        self.confirmed.load(std::sync::atomic::Ordering::SeqCst)
    }
    async fn close_locked(&self, current: &mut Option<OwnedCommand>) -> Result<(), String> {
        if let Some(command) = current.as_mut() {
            if let Err(error) = command.stop().await {
                self.confirmed
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                return Err(error);
            }
            current.take();
        }
        self.confirmed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    pub(super) async fn close(&self) -> Result<(), String> {
        self.close_locked(&mut *self.current.lock().await).await
    }
}

struct CommandProgress<'a> {
    sink: &'a dyn super::interaction::Interaction,
    turn_id: &'a str,
    tool_call_id: &'a str,
}
impl CommandProgress<'_> {
    async fn emit(&self, stream: &str, output: String) -> Result<(), String> {
        if output.is_empty() {
            return Ok(());
        }
        self.sink
            .emit(terminal_v4_core::StructuredSessionEvent::ToolOutput {
                ts: super::interaction::now_ms(),
                seq: 0,
                tool_name: "run_command".into(),
                output,
                stream: Some(stream.into()),
                turn_id: Some(self.turn_id.into()),
                tool_call_id: Some(self.tool_call_id.into()),
            })
            .await
    }
}

pub(super) async fn run_command_cancellable(
    root: &Path,
    input: &Value,
    approved: bool,
    cancel: &super::interaction::Cancellation,
    resources: &CommandResources,
    sink: &dyn super::interaction::Interaction,
    turn_id: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let backend = super::execution_backend::from_environment()?;
    run_command_inner(
        root,
        input,
        approved,
        std::time::Duration::from_secs(60),
        cancel,
        resources,
        Some(CommandProgress {
            sink,
            turn_id,
            tool_call_id,
        }),
        backend.as_ref(),
    )
    .await
}

#[derive(Default)]
struct Utf8Chunks {
    pending: Vec<u8>,
}
impl Utf8Chunks {
    fn push(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        let mut cursor = 0;
        while cursor < self.pending.len() {
            match std::str::from_utf8(&self.pending[cursor..]) {
                Ok(text) => {
                    output.push_str(text);
                    cursor = self.pending.len();
                }
                Err(error) => {
                    let valid = cursor + error.valid_up_to();
                    output.push_str(std::str::from_utf8(&self.pending[cursor..valid]).unwrap());
                    cursor = valid;
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{fffd}');
                            cursor += length;
                        }
                        None if eof => {
                            output.push_str(&String::from_utf8_lossy(&self.pending[cursor..]));
                            cursor = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..cursor);
        output
    }
}

async fn capture_command_output(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    progress: Option<&CommandProgress<'_>>,
    stream: &str,
) -> Result<(Vec<u8>, bool), String> {
    use tokio::io::AsyncReadExt;
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    let mut decoder = Utf8Chunks::default();
    let mut pending = String::new();
    let mut flush_at = None;
    loop {
        let count = tokio::select! {
            biased;
            _ = async {
                match flush_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                if let Some(progress) = progress { progress.emit(stream, std::mem::take(&mut pending)).await?; }
                flush_at = None;
                continue;
            },
            result = pipe.read(&mut buffer) => result.map_err(|_| "Cannot read command output")?,
        };
        if count == 0 {
            if let Some(progress) = progress {
                pending.push_str(&decoder.push(&[], true));
                progress.emit(stream, pending).await?;
            }
            return Ok((output, truncated));
        }
        let retained = count.min((FILE_BYTES as usize).saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..retained]);
        truncated |= retained < count;
        if let Some(progress) = progress {
            pending.push_str(&decoder.push(&buffer[..retained], false));
            if pending.len() >= 4096 {
                progress.emit(stream, std::mem::take(&mut pending)).await?;
                flush_at = None;
            } else if !pending.is_empty() && flush_at.is_none() {
                flush_at = Some(tokio::time::Instant::now() + std::time::Duration::from_millis(50));
            }
        }
        // Continue draining after the retained-output limit, discarding excess.
        // Batching progress by size/time bounds events without splitting UTF-8.
    }
}

#[cfg(test)]
async fn run_command_with_timeout(
    root: &Path,
    input: &Value,
    approved: bool,
    execution_timeout: std::time::Duration,
) -> Result<String, String> {
    let resources = CommandResources::default();
    run_command_inner(
        root,
        input,
        approved,
        execution_timeout,
        &super::interaction::Cancellation::default(),
        &resources,
        None,
        &super::execution_backend::LocalBackend,
    )
    .await
}

#[cfg(all(test, unix))]
pub(super) async fn run_command_with_backend(
    root: &Path,
    input: &Value,
    backend: &dyn super::execution_backend::ExecutionBackend,
) -> Result<String, String> {
    run_command_with_backend_controls(
        root,
        input,
        backend,
        std::time::Duration::from_secs(10),
        &super::interaction::Cancellation::default(),
    )
    .await
}

#[cfg(all(test, unix))]
pub(super) async fn run_command_with_backend_controls(
    root: &Path,
    input: &Value,
    backend: &dyn super::execution_backend::ExecutionBackend,
    timeout: std::time::Duration,
    cancel: &super::interaction::Cancellation,
) -> Result<String, String> {
    let resources = CommandResources::default();
    run_command_inner(
        root, input, true, timeout, cancel, &resources, None, backend,
    )
    .await
}

#[cfg(test)]
pub(super) async fn run_command_with_resources_for_test(
    root: &Path,
    input: &Value,
    backend: &dyn super::execution_backend::ExecutionBackend,
    timeout: std::time::Duration,
    resources: &CommandResources,
) -> Result<String, String> {
    run_command_inner(
        root,
        input,
        true,
        timeout,
        &super::interaction::Cancellation::default(),
        resources,
        None,
        backend,
    )
    .await
}

async fn run_command_inner(
    root: &Path,
    input: &Value,
    approved: bool,
    execution_timeout: std::time::Duration,
    cancel: &super::interaction::Cancellation,
    resources: &CommandResources,
    progress: Option<CommandProgress<'_>>,
    backend: &dyn super::execution_backend::ExecutionBackend,
) -> Result<String, String> {
    cancel.check()?;
    if !approved {
        return Err(
            "Command permission required. Unattended tasks cannot approve shell access.".into(),
        );
    }
    let command = text(input, "command")?;
    if command.is_empty()
        || command.len() > 10000
        || command.contains('\0')
        || input.as_object().is_none_or(|v| v.len() != 1)
    {
        return Err("Invalid command".into());
    }
    let mut current = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("Turn cancelled".into()),
        current = resources.current.lock() => current,
    };
    cancel.check()?;
    if current.is_some() {
        return Err(
            "Previous command cleanup must be confirmed before another command can run".into(),
        );
    }
    let prepared = backend.prepare(root, command)?;
    let cleanup = prepared
        .cleanup
        .map(|value| std::sync::Arc::new(std::sync::Mutex::new(value)));
    let mut process = prepared.command;
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    let mut child = process.spawn().map_err(|_| "Cannot start command")?;
    let tree = crate::process_tree::ProcessTree::attach(&child).ok();
    let contained = tree.is_some();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *current = Some(OwnedCommand {
        tree,
        child,
        stdout,
        stderr,
        cleanup,
    });
    resources
        .confirmed
        .store(false, std::sync::atomic::Ordering::SeqCst);
    if !contained {
        let _ = resources.close_locked(&mut current).await;
        return Err("Cannot contain command processes; cleanup is unconfirmed".into());
    }
    let result = {
        let command = current.as_mut().unwrap();
        match (&mut command.stdout, &mut command.stderr) {
            (Some(stdout), Some(stderr)) => {
                let execute = tokio::time::timeout(execution_timeout, async {
                    tokio::try_join!(
                        async {
                            let status = command
                                .child
                                .wait()
                                .await
                                .map_err(|_| "Cannot wait for command process")?;
                            command
                                .tree
                                .as_ref()
                                .unwrap()
                                .stop(std::time::Duration::from_millis(500))
                                .await
                                .map_err(|_| "Command process tree cleanup is unconfirmed")?;
                            Ok::<_, String>(status)
                        },
                        capture_command_output(stdout, progress.as_ref(), "stdout"),
                        capture_command_output(stderr, progress.as_ref(), "stderr")
                    )
                });
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err("Turn cancelled".into()),
                    result = execute => result.unwrap_or_else(|_| Err(format!("Command timed out after {} seconds", execution_timeout.as_secs()))),
                }
            }
            _ => Err("Command output pipes unavailable".into()),
        }
    };
    // The execution future only borrowed the owned pipes. Cleanup can therefore
    // freeze/discover before any handle closes, and drains without a failed sink.
    resources.close_locked(&mut current).await?;
    cancel.check()?;
    let (status, (out, out_truncated), (err, err_truncated)) = result?;
    Ok(json!({"exitCode":status.code(),"stdout":String::from_utf8_lossy(&out),"stderr":String::from_utf8_lossy(&err),"truncated":out_truncated || err_truncated}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_tools_reject_a_protected_workspace_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join(".ssh");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("id_key"), "private fixture").unwrap();
        for (name, input) in [
            ("read_file", json!({"path":"id_key"})),
            ("list_files", json!({"path":"."})),
            ("search_text", json!({"path":".","text":"private"})),
            (
                "replace_text",
                json!({"path":"id_key","old":"private","new":"changed"}),
            ),
            ("write_file", json!({"path":"id_key","content":"changed"})),
        ] {
            assert!(file_tool(&root, name, &input).is_err(), "{name}");
        }
        #[cfg(unix)]
        {
            let alias = parent.path().join("workspace-alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            assert!(file_tool(&alias, "read_file", &json!({"path":"id_key"})).is_err());
        }
        assert_eq!(
            std::fs::read_to_string(root.join("id_key")).unwrap(),
            "private fixture"
        );
    }
    #[test]
    fn read_file_line_range_preserves_content_and_validates_bounds() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes"), "first\nsecond α\nthird\nlast").unwrap();
        let result: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({"path":"notes", "start_line":2, "line_count":2}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result,
            json!({"content":"second α\nthird\n", "startLine":2, "nextLine":4, "totalLines":4})
        );
        let last: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({"path":"notes", "start_line":4, "line_count":10}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            last,
            json!({"content":"last", "startLine":4, "nextLine":null, "totalLines":4})
        );
        let beyond: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({"path":"notes", "start_line":5}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            beyond,
            json!({"content":"", "startLine":5, "nextLine":null, "totalLines":4})
        );
        std::fs::write(root.path().join("empty"), "").unwrap();
        let empty: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({"path":"empty", "line_count":1}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            empty,
            json!({"content":"", "startLine":1, "nextLine":null, "totalLines":0})
        );
        assert_eq!(
            file_tool(root.path(), "read_file", &json!({"path":"notes"})).unwrap(),
            "first\nsecond α\nthird\nlast"
        );
        for arguments in [
            json!({"start_line":0}),
            json!({"start_line":-1}),
            json!({"start_line":"2"}),
            json!({"line_count":0}),
            json!({"line_count":2001}),
            json!({"start_line":null}),
        ] {
            let mut input = json!({"path":"notes"});
            input
                .as_object_mut()
                .unwrap()
                .extend(arguments.as_object().unwrap().clone());
            assert!(
                file_tool(root.path(), "read_file", &input).is_err(),
                "{input}"
            );
        }
    }
    #[test]
    fn read_file_byte_pages_handle_large_utf8_files_and_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let prefix = "a".repeat(FILE_BYTES as usize + 5);
        std::fs::write(root.path().join("large"), format!("{prefix}🦀tail")).unwrap();
        let page: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({
                    "path":"large", "start_byte": FILE_BYTES, "byte_count": 7
                }),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            page,
            json!({"content":"aaaaa", "startByte":FILE_BYTES, "nextByte":FILE_BYTES + 5, "fileBytes":FILE_BYTES + 13})
        );
        let last: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({
                    "path":"large", "start_byte":FILE_BYTES + 5, "byte_count":8
                }),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            last,
            json!({"content":"🦀tail", "startByte":FILE_BYTES + 5, "nextByte":null, "fileBytes":FILE_BYTES + 13})
        );
        for extra in [
            json!({"start_byte":FILE_BYTES + 6}),
            json!({"byte_count":3}),
            json!({"byte_count":512001}),
            json!({"start_byte":FILE_BYTES + 14}),
            json!({"start_byte":0,"start_line":1}),
        ] {
            let mut input = json!({"path":"large"});
            input
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(
                file_tool(root.path(), "read_file", &input).is_err(),
                "{input}"
            );
        }
        assert!(file_tool(root.path(), "read_file", &json!({"path":"large"})).is_err());
        let end: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "read_file",
                &json!({
                    "path":"large", "start_byte":FILE_BYTES + 13
                }),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            end,
            json!({"content":"", "startByte":FILE_BYTES + 13, "nextByte":null, "fileBytes":FILE_BYTES + 13})
        );
        std::fs::write(root.path().join("invalid"), [b'a', 0xff, b'b']).unwrap();
        assert!(file_tool(
            root.path(),
            "read_file",
            &json!({"path":"invalid", "byte_count":4})
        )
        .is_err());
    }
    #[test]
    fn sharp_s_filesystem_aliases_cannot_access_or_enumerate_protected_directories() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".ssh")).unwrap();
        let canonical = root.path().join(".ssh/key");
        std::fs::write(&canonical, "synthetic marker").unwrap();
        std::fs::write(root.path().join("notes"), "synthetic ordinary").unwrap();
        for directory in [".ẞh", ".ßh", ".ſſh", ".SSH"] {
            let alias = format!("{directory}/key");
            #[cfg(target_os = "macos")]
            {
                use std::os::unix::fs::MetadataExt;
                if let Ok(metadata) = std::fs::metadata(root.path().join(&alias)) {
                    let original = std::fs::metadata(&canonical).unwrap();
                    assert_eq!(
                        (metadata.dev(), metadata.ino()),
                        (original.dev(), original.ino())
                    );
                }
            }
            for (name, input) in [
                ("read_file", json!({"path":alias})),
                (
                    "replace_text",
                    json!({"path":alias,"old":"marker","new":"replaced"}),
                ),
                (
                    "write_file",
                    json!({"path":alias,"content":"synthetic overwritten"}),
                ),
                ("list_files", json!({"path":directory})),
                ("search_text", json!({"path":directory,"text":"synthetic"})),
            ] {
                assert!(
                    file_tool(root.path(), name, &input).is_err(),
                    "{name} {directory}"
                );
            }
        }
        assert_eq!(
            std::fs::read_to_string(&canonical).unwrap(),
            "synthetic marker"
        );
        assert_eq!(
            file_tool(root.path(), "read_file", &json!({"path":"notes"})).unwrap(),
            "synthetic ordinary"
        );
        let stored_alias = tempfile::tempdir().unwrap();
        std::fs::create_dir(stored_alias.path().join(".ẞh")).unwrap();
        std::fs::write(stored_alias.path().join(".ẞh/key"), "synthetic marker").unwrap();
        let listed: Value = serde_json::from_str(
            &file_tool(stored_alias.path(), "list_files", &json!({"path":"."})).unwrap(),
        )
        .unwrap();
        assert_eq!(listed["entries"], json!([]));
        let found: Value = serde_json::from_str(
            &file_tool(
                stored_alias.path(),
                "search_text",
                &json!({"path":".","text":"synthetic"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(found["matches"], json!([]));
    }
    #[test]
    fn repair_t4_case_aliases_of_protected_components_are_denied() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        for path in [".env", "auth.json", ".git/config", "ordinary"] {
            std::fs::write(root.path().join(path), "synthetic marker").unwrap();
        }
        for path in [
            ".ENV",
            "AUTH.JSON",
            ".GIT/config",
            ".EnV.local",
            ".SSH/key",
            "auth.jſon",
            "vault.Key",
        ] {
            for (name, input) in [
                ("read_file", json!({"path":path})),
                ("write_file", json!({"path":path,"content":"changed"})),
                (
                    "replace_text",
                    json!({"path":path,"old":"synthetic","new":"changed"}),
                ),
            ] {
                assert!(
                    file_tool(root.path(), name, &input).is_err(),
                    "{name} {path}"
                );
            }
        }
        assert_eq!(
            file_tool(root.path(), "read_file", &json!({"path":"ordinary"})).unwrap(),
            "synthetic marker"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(".git/config")).unwrap(),
            "synthetic marker"
        );
        std::fs::write(root.path().join("AUTH.JSON"), "synthetic marker").unwrap();
        let listed: Value = serde_json::from_str(
            &file_tool(root.path(), "list_files", &json!({"path":"."})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            listed["entries"],
            json!([{"name":"ordinary","directory":false}])
        );
        let found: Value = serde_json::from_str(
            &file_tool(
                root.path(),
                "search_text",
                &json!({"path":".","text":"synthetic marker"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            found["matches"],
            json!([{"path":"ordinary","line":1,"text":"synthetic marker"}])
        );
    }
    #[test]
    fn regular_utf8_reads_preserve_exact_byte_limit_and_reject_oversize_or_invalid_text() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes");
        let text = "é".repeat((FILE_BYTES / 2) as usize);
        assert_eq!(text.len() as u64, FILE_BYTES);
        std::fs::write(&path, &text).unwrap();
        assert_eq!(
            file_tool(root.path(), "read_file", &json!({"path":"notes"})).unwrap(),
            text
        );
        std::fs::write(&path, vec![b'x'; FILE_BYTES as usize + 1]).unwrap();
        assert!(file_tool(root.path(), "read_file", &json!({"path":"notes"})).is_err());
        std::fs::write(&path, [0xff]).unwrap();
        assert!(file_tool(root.path(), "read_file", &json!({"path":"notes"})).is_err());
    }
    #[test]
    fn file_tools_reject_escape_and_protected_paths_and_preserve_unrelated_text() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes"), "before\nchosen\nafter\n").unwrap();
        for path in ["../outside", "/etc/passwd", ".git/config", ".env.local"] {
            assert!(file_tool(root.path(), "read_file", &json!({"path":path})).is_err());
        }
        file_tool(
            root.path(),
            "replace_text",
            &json!({"path":"notes","old":"chosen","new":"changed"}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes")).unwrap(),
            "before\nchanged\nafter\n"
        );
        assert!(file_tool(
            root.path(),
            "replace_text",
            &json!({"path":"notes","old":"missing","new":"changed"})
        )
        .is_err());
        assert!(file_tool(
            root.path(),
            "write_file",
            &json!({"path":"new","content":"new text","extra":true})
        )
        .is_err());
    }
    #[test]
    fn replace_text_requires_the_expected_number_of_occurrences() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes");
        std::fs::write(&path, "one fish\ntwo fish\n").unwrap();
        for count in [json!(1), json!(3), json!(0), json!(1001), json!("2")] {
            assert!(file_tool(
                root.path(),
                "replace_text",
                &json!({
                    "path":"notes", "old":"fish", "new":"bird", "expected_count":count
                })
            )
            .is_err());
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "one fish\ntwo fish\n"
            );
        }
        assert!(file_tool(
            root.path(),
            "replace_text",
            &json!({
                "path":"notes", "old":"fish", "new":"bird"
            })
        )
        .is_err());
        assert!(file_tool(root.path(), "replace_text", &json!({
            "path":"notes", "old":"fish", "new":"x".repeat(FILE_BYTES as usize), "expected_count":2
        })).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "one fish\ntwo fish\n"
        );
        file_tool(
            root.path(),
            "replace_text",
            &json!({
                "path":"notes", "old":"fish", "new":"bird", "expected_count":2
            }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "one bird\ntwo bird\n"
        );
    }
    #[cfg(unix)]
    #[test]
    fn file_tools_do_not_follow_symlinked_files_or_directories() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(file_tool(
            root.path(),
            "write_file",
            &json!({"path":"escape/new","content":"blocked"})
        )
        .is_err());
        assert!(!outside.path().join("new").exists());
    }
    #[tokio::test]
    async fn unattended_commands_are_denied_before_execution() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            run_command(root.path(), &json!({"command":"touch unexpected"}), false)
                .await
                .unwrap_err()
                .contains("permission")
        );
        assert!(!root.path().join("unexpected").exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn approved_commands_run_in_workspace_without_provider_credentials() {
        let root = tempfile::tempdir().unwrap();
        let result = run_command(
            root.path(),
            &json!({"command":"printf verified; test -z \"$OPENAI_API_KEY\""}),
            true,
        )
        .await
        .unwrap();
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["stdout"], "verified");
        assert_eq!(value["exitCode"], 0);
    }
    #[cfg(unix)]
    async fn assert_fixture_stopped(pid: u32) {
        let stopped = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let mut system = sysinfo::System::new();
                system.refresh_processes_specifics(
                    sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
                    true,
                    sysinfo::ProcessRefreshKind::nothing(),
                );
                if system
                    .process(sysinfo::Pid::from_u32(pid))
                    .is_none_or(|process| process.status() == sysinfo::ProcessStatus::Zombie)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .is_ok();
        if !stopped {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        assert!(
            stopped,
            "An owned command descendant survived command completion"
        );
    }

    #[cfg(unix)]
    async fn command_descendant_fixture(timeout: bool) {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("command-tree.py");
        let pid_file = root.path().join("tool.pid");
        std::fs::write(&script, r#"
import pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
print('verified output', flush=True)
if sys.argv[2] == 'timeout':
    while True: time.sleep(1)
time.sleep(0.2)
sys.exit(7)
"#).unwrap();
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let command = json!({"command":format!("exec python3 {} {} {}", quote(&script), quote(&pid_file), if timeout { "timeout" } else { "normal" })});
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_command_with_timeout(
                root.path(),
                &command,
                true,
                std::time::Duration::from_secs(if timeout { 1 } else { 4 }),
            ),
        )
        .await
        .expect("Command cleanup exceeded its bounded deadline");
        let pid: u32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
        assert_fixture_stopped(pid).await;
        if timeout {
            assert!(result.unwrap_err().contains("timed out"));
        } else {
            let result: Value = serde_json::from_str(&result.unwrap()).unwrap();
            assert_eq!(result["exitCode"], 7);
            assert_eq!(result["stdout"], "verified output\n");
            assert_eq!(result["truncated"], false);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn completed_commands_stop_detached_tools_before_waiting_for_pipe_eof() {
        command_descendant_fixture(false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_commands_await_separate_session_tool_cleanup() {
        command_descendant_fixture(true).await;
    }
}

#[cfg(all(test, unix))]
mod command_interaction_io_tests {
    use super::super::interaction::{ApprovalRequest, Cancellation, Interaction};
    use super::*;
    use async_trait::async_trait;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use terminal_v4_core::StructuredSessionEvent;
    use tokio::sync::{Mutex, Notify};

    #[derive(Default)]
    struct Sink {
        events: Mutex<Vec<Value>>,
        ready: Notify,
        fail: AtomicBool,
        block: AtomicBool,
    }
    #[async_trait]
    impl Interaction for Sink {
        async fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
            let value = serde_json::to_value(event).unwrap();
            if self.block.load(Ordering::SeqCst) {
                self.ready.notify_one();
                return std::future::pending::<Result<(), String>>().await;
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err("fixture progress sink closed".into());
            }
            self.events.lock().await.push(value);
            self.ready.notify_one();
            Ok(())
        }
        async fn approve(&self, _request: ApprovalRequest) -> Result<bool, String> {
            panic!("Command helper receives an existing decision and must not invent approval")
        }
    }
    struct Fixture {
        root: tempfile::TempDir,
        input: Value,
    }
    impl Fixture {
        fn new(large: bool) -> Self {
            let root = tempfile::tempdir().unwrap();
            let script = root.path().join("command.py");
            std::fs::write(&script, r#"
import json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
def stop(*_):
    time.sleep(0.12)
    (root / 'cleanup').write_text('graceful cleanup completed')
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
child_code = "import pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(60)"
child = subprocess.Popen([sys.executable, '-c', child_code, str(root / 'child-ready')], start_new_session=True)
while not (root / 'child-ready').exists(): time.sleep(0.01)
(root / 'pids').write_text(json.dumps([os.getpid(), child.pid]))
os.write(1, b'first: \xe2')
time.sleep(0.04)
os.write(1, b'\x82\xac\n')
os.write(2, b'warning\n')
while not (root / 'release').exists(): time.sleep(0.01)
if sys.argv[2] == 'large':
    os.write(1, b'o' * 1048576)
    os.write(2, b'e' * 1048576)
sys.exit(7)
"#).unwrap();
            let quote =
                |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
            let input = json!({"command":format!("exec python3 {} {} {}",quote(&script),quote(root.path()),if large {"large"} else {"wait"})});
            Self { root, input }
        }
        async fn observe(&self) -> (Vec<u32>, crate::process_tree::ProcessTree) {
            let pids = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(pids) = std::fs::read(self.root.path().join("pids"))
                        .ok()
                        .and_then(|raw| serde_json::from_slice::<Vec<u32>>(&raw).ok())
                    {
                        break pids;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(pids.len(), 2);
            let fixture_cleanup = crate::process_tree::ProcessTree::attach_pid(pids[0]).unwrap();
            (pids, fixture_cleanup)
        }
    }
    fn alive(pid: u32) -> bool {
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system
            .process(sysinfo::Pid::from_u32(pid))
            .is_some_and(|process| process.status() != sysinfo::ProcessStatus::Zombie)
    }
    fn start(
        fixture: &Fixture,
        cancel: Cancellation,
        resources: Arc<CommandResources>,
        sink: Arc<Sink>,
    ) -> tokio::task::JoinHandle<Result<String, String>> {
        let root = fixture.root.path().to_owned();
        let input = fixture.input.clone();
        tokio::spawn(async move {
            run_command_cancellable(
                &root,
                &input,
                true,
                &cancel,
                &resources,
                sink.as_ref(),
                "fixture-turn",
                "fixture-call",
            )
            .await
        })
    }
    #[tokio::test]
    async fn cancellation_awaits_graceful_command_tree_cleanup_and_root_reap() {
        let fixture = Fixture::new(false);
        let cancel = Cancellation::default();
        let resources = Arc::new(CommandResources::default());
        let sink = Arc::new(Sink::default());
        let running = start(&fixture, cancel.clone(), resources.clone(), sink);
        let (pids, _fixture_cleanup) = fixture.observe().await;
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(3), running)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancel"));
        assert!(
            fixture.root.path().join("cleanup").exists(),
            "Cancellation returned without awaiting the command's graceful cleanup handler"
        );
        assert!(
            pids.iter().all(|pid| !alive(*pid)),
            "Cancellation returned while an owned command descendant was alive"
        );
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let waited = unsafe {
            libc::waitid(
                libc::P_PID,
                pids[0] as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        assert_eq!(
            waited, -1,
            "Command cancellation must reap its root before confirming cleanup"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        assert!(resources.is_confirmed());
        resources.close().await.unwrap();
    }
    #[tokio::test]
    async fn command_progress_is_early_utf8_safe_bounded_and_correlated() {
        let fixture = Fixture::new(true);
        let cancel = Cancellation::default();
        let resources = Arc::new(CommandResources::default());
        let sink = Arc::new(Sink::default());
        let running = start(&fixture, cancel.clone(), resources.clone(), sink.clone());
        let (_pids, _fixture_cleanup) = fixture.observe().await;
        let early = tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                if sink
                    .events
                    .lock()
                    .await
                    .iter()
                    .any(|value| value["stream"] == "stdout")
                {
                    break;
                }
                sink.ready.notified().await;
            }
        })
        .await
        .is_ok();
        let finished_before_release = running.is_finished();
        std::fs::write(fixture.root.path().join("release"), "go").unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            early,
            "Command output was buffered until completion instead of streamed"
        );
        assert!(
            !finished_before_release,
            "Fixture must still be running when first output is delivered"
        );
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["exitCode"], 7);
        assert_eq!(result["truncated"], true);
        let events = sink.events.lock().await;
        for stream in ["stdout", "stderr"] {
            let rows = events
                .iter()
                .filter(|value| value["stream"] == stream)
                .collect::<Vec<_>>();
            assert!(!rows.is_empty());
            let text = rows
                .iter()
                .map(|row| row["output"].as_str().unwrap())
                .collect::<String>();
            assert_eq!(text, result[stream].as_str().unwrap());
            assert!(text.len() <= FILE_BYTES as usize);
            assert!(
                !text.contains('�'),
                "A split UTF-8 codepoint was corrupted in progress"
            );
            for row in rows {
                assert_eq!(row["type"], "tool_output");
                assert_eq!(row["toolName"], "run_command");
                assert_eq!(row["toolCallId"], "fixture-call");
                assert_eq!(row["turnId"], "fixture-turn");
            }
        }
        assert!(resources.is_confirmed());
    }
    #[tokio::test]
    async fn progress_sink_failure_awaits_command_cleanup_before_returning() {
        let fixture = Fixture::new(false);
        let cancel = Cancellation::default();
        let resources = Arc::new(CommandResources::default());
        let sink = Arc::new(Sink::default());
        sink.fail.store(true, Ordering::SeqCst);
        let running = start(&fixture, cancel.clone(), resources.clone(), sink);
        let (pids, _fixture_cleanup) = fixture.observe().await;
        let result = tokio::time::timeout(Duration::from_secs(3), running).await;
        if result.is_err() {
            cancel.cancel();
        }
        let result = result
            .expect("A failed progress sink must stop execution, not wait60seconds")
            .unwrap();
        assert!(result.unwrap_err().contains("fixture progress sink closed"));
        assert!(fixture.root.path().join("cleanup").exists());
        assert!(pids.iter().all(|pid| !alive(*pid)));
        assert!(resources.is_confirmed());
    }
    #[tokio::test]
    async fn dropped_command_future_keeps_cleanup_owned_until_explicit_close() {
        let fixture = Fixture::new(false);
        let cancel = Cancellation::default();
        let resources = Arc::new(CommandResources::default());
        let sink = Arc::new(Sink::default());
        let running = start(&fixture, cancel, resources.clone(), sink);
        let (pids, _fixture_cleanup) = fixture.observe().await;
        assert!(!resources.is_confirmed());
        running.abort();
        assert!(running.await.unwrap_err().is_cancelled());
        assert!(
            !resources.is_confirmed(),
            "Dropping I/O must not discard the command cleanup owner"
        );
        tokio::time::timeout(Duration::from_secs(2), resources.close())
            .await
            .unwrap()
            .unwrap();
        assert!(fixture.root.path().join("cleanup").exists());
        assert!(pids.iter().all(|pid| !alive(*pid)));
        assert!(resources.is_confirmed());
        resources.close().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_preempts_a_blocked_progress_sink_before_confirmed_cleanup() {
        let fixture = Fixture::new(false);
        let cancel = Cancellation::default();
        let resources = Arc::new(CommandResources::default());
        let sink = Arc::new(Sink::default());
        sink.block.store(true, Ordering::SeqCst);
        let running = start(&fixture, cancel.clone(), resources.clone(), sink.clone());
        let (pids, _fixture_cleanup) = fixture.observe().await;
        tokio::time::timeout(Duration::from_secs(1), sink.ready.notified())
            .await
            .unwrap();
        assert!(!resources.is_confirmed());
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), running)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancel"));
        assert!(fixture.root.path().join("cleanup").exists());
        assert!(pids.iter().all(|pid| !alive(*pid)));
        assert!(resources.is_confirmed());
    }
}

#[cfg(test)]
mod command_output_unit_tests {
    use super::Utf8Chunks;
    #[test]
    fn progress_decoder_preserves_split_unicode_and_matches_lossy_invalid_bytes() {
        for bytes in [
            "first: € ✓ 💡\n".as_bytes().to_vec(),
            vec![b'a', 0xf0, 0x9f, b'b', 0xff, 0xe2, 0x82],
        ] {
            for split in 0..=bytes.len() {
                let mut decoder = Utf8Chunks::default();
                let mut actual = decoder.push(&bytes[..split], false);
                assert!(decoder.pending.len() <= 3);
                actual.push_str(&decoder.push(&bytes[split..], false));
                assert!(decoder.pending.len() <= 3);
                actual.push_str(&decoder.push(&[], true));
                assert_eq!(actual, String::from_utf8_lossy(&bytes));
                assert!(decoder.pending.is_empty());
            }
        }
    }
}

#[cfg(all(test, unix))]
mod nonregular_read_tests {
    use super::*;
    use std::os::unix::fs::OpenOptionsExt;
    #[tokio::test]
    async fn workspace_fifo_read_rejects_before_any_writer_opens_it() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let pipe = root.join("AGENTS.md");
        let name = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut worker = tokio::task::spawn_blocking(move || {
            let _ = tx.send(());
            file_tool(&root, "read_file", &json!({"path":"AGENTS.md"}))
        });
        rx.await.unwrap();
        let first = tokio::time::timeout(std::time::Duration::from_millis(300), &mut worker).await;
        let rejected_before_writer = matches!(&first, Ok(Ok(Err(_))));
        let needs_cleanup = first.is_err();
        if needs_cleanup {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
            while !worker.is_finished() && tokio::time::Instant::now() < deadline {
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(&pipe);
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), worker)
                .await
                .unwrap()
                .unwrap();
        }
        assert!(
            rejected_before_writer,
            "FIFO read required an external writer before it could reject the non-regular file"
        );
    }
}
