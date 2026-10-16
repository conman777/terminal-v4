use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use uuid::Uuid;

const PATCH_LIMIT: usize = 200_000;
const LIST_LIMIT: usize = 2_000_000;
static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedWorktree {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base_ref: String,
    pub available: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub archive_checkpoint_id: Option<Uuid>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCheckpoint {
    pub id: Uuid,
    pub label: String,
    pub created_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointRecord {
    checkpoint: WorkspaceCheckpoint,
    tree: String,
    index_tree: String,
    head: String,
    captured_at: u128,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitQuery {
    path: String,
    #[serde(default = "unstaged_mode")]
    mode: String,
    #[serde(default = "head_ref")]
    base: String,
    file: Option<String>,
    checkpoint_id: Option<Uuid>,
}
fn unstaged_mode() -> String {
    "unstaged".into()
}
fn head_ref() -> String {
    "HEAD".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeInput {
    path: String,
    name: String,
    #[serde(default = "head_ref")]
    base_ref: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointInput {
    path: String,
    label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreInput {
    path: String,
    checkpoint_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeLifecycleInput {
    path: String,
    worktree_id: Uuid,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/git/status",
            axum::routing::get(status_route),
        )
        .route("/api/workspace/git/diff", axum::routing::get(diff_route))
        .route(
            "/api/workspace/git/worktrees",
            axum::routing::get(worktrees_route).post(create_worktree_route),
        )
        .route(
            "/api/workspace/git/worktrees/archive",
            axum::routing::post(archive_worktree_route),
        )
        .route(
            "/api/workspace/git/worktrees/reactivate",
            axum::routing::post(reactivate_worktree_route),
        )
        .route(
            "/api/workspace/git/checkpoints",
            axum::routing::get(checkpoints_route).post(capture_route),
        )
        .route(
            "/api/workspace/git/checkpoints/restore",
            axum::routing::post(restore_route),
        )
}

struct GitOutput {
    bytes: Vec<u8>,
    truncated: bool,
}
async fn bounded_read(
    mut stream: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<GitOutput, std::io::Error> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok(GitOutput { bytes, truncated })
}
fn git_command(repo: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("git");
    command
        .current_dir(repo)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.longpaths=true",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}
async fn git_run(
    repo: &Path,
    args: &[&str],
    index: Option<&Path>,
    limit: usize,
) -> Result<GitOutput, ApiError> {
    let mut command = git_command(repo);
    // Repository-defined filters execute programs during index reads and checkout.
    let filter_output = tokio::time::timeout(
        Duration::from_secs(10),
        git_command(repo)
            .args([
                "config",
                "--name-only",
                "--get-regexp",
                r"^filter\..*\.(clean|smudge|process|required)$",
            ])
            .output(),
    )
    .await
    .map_err(|_| ApiError::bad_request("Git filter inspection timed out"))?
    .map_err(|_| ApiError::internal("Git is unavailable on this host"))?;
    if !filter_output.status.success() && filter_output.status.code() != Some(1) {
        return Err(ApiError::bad_request(
            "Unable to inspect Git filter configuration",
        ));
    }
    for key in String::from_utf8_lossy(&filter_output.stdout).lines() {
        if key.starts_with("filter.") && !key.chars().any(char::is_control) {
            command.arg("-c").arg(format!(
                "{key}={}",
                if key.ends_with(".required") {
                    "false"
                } else {
                    ""
                }
            ));
        }
    }
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ApiError::internal("Git is unavailable on this host"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ApiError::internal("Git stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ApiError::internal("Git stderr unavailable"))?;
    let (output, errors, status) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(
            bounded_read(stdout, limit),
            bounded_read(stderr, 4096),
            child.wait()
        )
    })
    .await
    .map_err(|_| ApiError::bad_request("Git operation timed out"))?;
    let output = output.map_err(|_| ApiError::internal("Unable to read Git output"))?;
    let errors = errors.map_err(|_| ApiError::internal("Unable to read Git errors"))?;
    if !status
        .map_err(|_| ApiError::internal("Unable to wait for Git"))?
        .success()
    {
        return Err(ApiError::bad_request(format!(
            "Git operation failed: {}",
            String::from_utf8_lossy(&errors.bytes).trim()
        )));
    }
    Ok(output)
}
async fn git_text(repo: &Path, args: &[&str], index: Option<&Path>) -> Result<String, ApiError> {
    let output = git_run(repo, args, index, LIST_LIMIT).await?;
    if output.truncated {
        return Err(ApiError::bad_request(
            "Git metadata exceeds the workspace limit",
        ));
    }
    Ok(String::from_utf8_lossy(&output.bytes).trim().to_string())
}
async fn repository(path: &str) -> Result<PathBuf, ApiError> {
    if path.is_empty() || path.len() > 4096 || !Path::new(path).is_absolute() {
        return Err(ApiError::bad_request(
            "An absolute workspace directory is required",
        ));
    }
    let cwd = std::fs::canonicalize(path)
        .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
    if !cwd.is_dir() {
        return Err(ApiError::bad_request("Workspace must be a directory"));
    }
    let root = git_text(&cwd, &["rev-parse", "--show-toplevel"], None).await?;
    std::fs::canonicalize(root)
        .map_err(|_| ApiError::bad_request("Workspace is not an available Git repository"))
}
fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy();
    digest(&if cfg!(windows) {
        key.to_lowercase()
    } else {
        key.into_owned()
    })[..32]
        .to_string()
}
async fn storage_root(data_dir: &Path, user_id: &str, repo: &Path) -> Result<PathBuf, ApiError> {
    let common = git_text(repo, &["rev-parse", "--git-common-dir"], None).await?;
    let common = std::fs::canonicalize(repo.join(common))
        .map_err(|_| ApiError::bad_request("Git common directory unavailable"))?;
    Ok(data_dir
        .join("workspace-git")
        .join(&digest(user_id)[..32])
        .join(path_key(&common)))
}
fn read_record<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, ApiError> {
    let file = std::fs::File::open(path)
        .map_err(|_| ApiError::bad_request("Workspace record is unavailable"))?;
    let mut bytes = Vec::new();
    file.take(256_001)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::internal("Unable to read workspace record"))?;
    if bytes.len() > 256_000 {
        return Err(ApiError::internal(
            "Workspace record exceeds the storage limit",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::internal("Workspace record is invalid"))
}
fn write_record<T: Serialize>(path: &Path, value: &T) -> Result<(), ApiError> {
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("Invalid workspace record path"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| ApiError::internal("Unable to create workspace storage"))?;
    let file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| ApiError::internal("Unable to create workspace record"))?;
    serde_json::to_writer(file.as_file(), value)
        .map_err(|_| ApiError::internal("Unable to write workspace record"))?;
    file.as_file()
        .sync_all()
        .map_err(|_| ApiError::internal("Unable to flush workspace record"))?;
    file.persist(path)
        .map_err(|_| ApiError::internal("Unable to save workspace record"))?;
    Ok(())
}
fn record_files(directory: &Path, limit: usize) -> Result<Vec<PathBuf>, ApiError> {
    if !directory.exists() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(directory)
        .map_err(|_| ApiError::internal("Unable to list workspace records"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| ApiError::internal("Unable to list workspace records"))?;
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            files.push(path);
            if files.len() > limit {
                return Err(ApiError::bad_request("Workspace record limit reached"));
            }
        }
    }
    Ok(files)
}
fn validate_ref(value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > 200
        || value.starts_with('-')
        || value.contains("..")
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/._-~^".contains(&c))
    {
        return Err(ApiError::bad_request("Invalid Git reference"));
    }
    Ok(())
}
async fn resolve_ref(repo: &Path, value: &str) -> Result<String, ApiError> {
    validate_ref(value)?;
    git_text(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{value}^{{commit}}"),
        ],
        None,
    )
    .await
}
fn validate_file(file: &str) -> Result<(), ApiError> {
    if file.is_empty()
        || file.len() > 4096
        || Path::new(file).is_absolute()
        || file.contains('\\')
        || file.chars().any(char::is_control)
        || file
            .split('/')
            .any(|part| part == "." || part == ".." || part.is_empty())
    {
        return Err(ApiError::bad_request(
            "A relative changed-file path is required",
        ));
    }
    Ok(())
}
async fn review_args(repo: &Path, mode: &str, base: &str) -> Result<Vec<String>, ApiError> {
    let mut args = vec![
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--no-renames".into(),
    ];
    match mode {
        "unstaged" => {}
        "staged" => args.push("--cached".into()),
        "base" => {
            let base = resolve_ref(repo, base).await?;
            let head = resolve_ref(repo, "HEAD").await?;
            let common = git_text(repo, &["merge-base", &base, &head], None).await?;
            args.extend([common, head]);
        }
        _ => return Err(ApiError::bad_request("Unsupported Git review mode")),
    }
    Ok(args)
}
async fn changed_files(
    repo: &Path,
    args: &[String],
    include_untracked: bool,
) -> Result<(Vec<Value>, bool), ApiError> {
    let mut command: Vec<&str> = args.iter().map(String::as_str).collect();
    command.extend(["--numstat", "-z", "--"]);
    let output = git_run(repo, &command, None, LIST_LIMIT).await?;
    let mut files = Vec::new();
    for entry in output.bytes.split(|&c| c == 0) {
        if entry.is_empty() {
            continue;
        }
        let mut fields = entry.splitn(3, |&c| c == b'\t');
        if let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        {
            let binary = added == b"-" || removed == b"-";
            files.push(json!({"path":String::from_utf8_lossy(path),"status":"M","binary":binary,
                "added":String::from_utf8_lossy(added).parse::<u64>().ok(),"removed":String::from_utf8_lossy(removed).parse::<u64>().ok()}));
        }
    }
    let mut types: Vec<&str> = args.iter().map(String::as_str).collect();
    types.extend(["--name-status", "-z", "--"]);
    let types = git_run(repo, &types, None, LIST_LIMIT).await?;
    let fields: Vec<&[u8]> = types.bytes.split(|&byte| byte == 0).collect();
    for pair in fields.chunks_exact(2) {
        let path = String::from_utf8_lossy(pair[1]);
        if let Some(file) = files
            .iter_mut()
            .find(|file| file["path"].as_str() == Some(path.as_ref()))
        {
            file["status"] = json!(String::from_utf8_lossy(pair[0]));
        }
    }
    let mut truncated = output.truncated || types.truncated;
    if include_untracked {
        let others = git_run(
            repo,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
            LIST_LIMIT,
        )
        .await?;
        truncated |= others.truncated;
        for path in others
            .bytes
            .split(|&c| c == 0)
            .filter(|entry| !entry.is_empty())
        {
            files.push(json!({"path":String::from_utf8_lossy(path),"status":"?","added":null,"removed":0,"binary":false}));
        }
    }
    truncated |= files.len() > 2000;
    files.truncate(2000);
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok((files, truncated))
}
async fn review_status(path: &str, mode: &str, base: &str) -> Result<Value, ApiError> {
    let repo = repository(path).await?;
    let args = review_args(&repo, mode, base).await?;
    let (files, truncated) = changed_files(&repo, &args, mode == "unstaged").await?;
    let branch = git_text(&repo, &["branch", "--show-current"], None).await?;
    Ok(json!({"branch":branch,"files":files,"truncated":truncated}))
}
async fn file_patch(
    repo: &Path,
    args: &[String],
    file: &str,
    untracked: bool,
) -> Result<Value, ApiError> {
    validate_file(file)?;
    if untracked {
        let target = std::fs::canonicalize(repo.join(file))
            .map_err(|_| ApiError::bad_request("New file is unavailable"))?;
        if !target.starts_with(repo) || !target.is_file() {
            return Err(ApiError::bad_request(
                "New file must stay inside the workspace",
            ));
        }
        let input = std::fs::File::open(target)
            .map_err(|_| ApiError::bad_request("New file is unavailable"))?;
        let mut bytes = Vec::new();
        input
            .take((PATCH_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ApiError::internal("Unable to read new file"))?;
        let mut truncated = bytes.len() > PATCH_LIMIT;
        bytes.truncate(PATCH_LIMIT);
        let binary = bytes.contains(&0)
            || std::str::from_utf8(&bytes)
                .err()
                .is_some_and(|error| error.error_len().is_some() || !truncated);
        let mut patch = String::new();
        if !binary {
            patch.push_str(&format!("--- /dev/null\n+++ b/{file}\n"));
            for line in String::from_utf8_lossy(&bytes).split_inclusive('\n') {
                patch.push('+');
                patch.push_str(line);
            }
            if patch.len() > PATCH_LIMIT {
                let mut end = PATCH_LIMIT;
                while !patch.is_char_boundary(end) {
                    end -= 1;
                }
                patch.truncate(end);
                truncated = true;
            }
        }
        return Ok(json!({"patch":patch,"binary":binary,"truncated":truncated}));
    }
    let literal = format!(":(top,literal){file}");
    let mut command: Vec<&str> = args.iter().map(String::as_str).collect();
    command.extend(["--no-color", "--", &literal]);
    let output = git_run(repo, &command, None, PATCH_LIMIT).await?;
    let patch = String::from_utf8_lossy(&output.bytes);
    let binary = patch.contains("Binary files ") && patch.contains(" differ");
    Ok(json!({"patch":patch,"binary":binary,"truncated":output.truncated}))
}
async fn review_diff(path: &str, mode: &str, base: &str, file: &str) -> Result<Value, ApiError> {
    validate_file(file)?;
    let repo = repository(path).await?;
    let args = review_args(&repo, mode, base).await?;
    let (files, _) = changed_files(&repo, &args, mode == "unstaged").await?;
    let entry = files
        .iter()
        .find(|entry| entry["path"].as_str() == Some(file))
        .ok_or_else(|| ApiError::bad_request("File is not changed in this review scope"))?;
    file_patch(&repo, &args, file, entry["status"] == "?").await
}

pub(crate) async fn create_managed_worktree(
    data_dir: &Path,
    user_id: &str,
    path: &str,
    name: &str,
    base_ref: &str,
) -> Result<ManagedWorktree, ApiError> {
    let _guard = MUTATIONS.lock().await;
    if name.trim().is_empty()
        || name.chars().count() > 80
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || " -_".contains(c))
    {
        return Err(ApiError::bad_request(
            "Task name requires letters, digits, spaces, hyphens or underscores",
        ));
    }
    let repo = repository(path).await?;
    let commit = resolve_ref(&repo, base_ref).await?;
    let root = storage_root(data_dir, user_id, &repo).await?;
    if record_files(&root.join("worktrees"), 64)?.len() >= 64 {
        return Err(ApiError::bad_request("Managed worktree limit reached"));
    }
    std::fs::create_dir_all(root.join("checkouts"))
        .map_err(|_| ApiError::internal("Unable to create checkout storage"))?;
    let id = Uuid::new_v4();
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(40)
        .collect();
    let branch = format!("codex/{}-{}", slug.trim_matches('-'), id.simple());
    let target = std::fs::canonicalize(root.join("checkouts"))
        .map_err(|_| ApiError::internal("Checkout storage unavailable"))?
        .join(id.to_string());
    let target_text = target.to_string_lossy().into_owned();
    #[cfg(windows)]
    let target_text = target_text
        .strip_prefix(r"\\?\")
        .unwrap_or(&target_text)
        .to_string();
    git_text(
        &repo,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            &branch,
            &target_text,
            &commit,
        ],
        None,
    )
    .await?;
    let result = ManagedWorktree {
        id,
        name: name.trim().into(),
        path: target_text,
        branch,
        base_ref: base_ref.into(),
        available: true,
        archived: false,
        archive_checkpoint_id: None,
    };
    write_record(&root.join("worktrees").join(format!("{id}.json")), &result).map_err(|_| {
        ApiError::internal(format!(
            "Checkout created at {} but its task record could not be saved",
            result.path
        ))
    })?;
    Ok(result)
}
async fn list_managed_worktrees(
    data_dir: &Path,
    user_id: &str,
    path: &str,
) -> Result<Vec<ManagedWorktree>, ApiError> {
    let repo = repository(path).await?;
    let root = storage_root(data_dir, user_id, &repo).await?;
    let expected = std::fs::canonicalize(root.join("checkouts")).ok();
    let mut trees = Vec::new();
    for file in record_files(&root.join("worktrees"), 64)? {
        let mut tree: ManagedWorktree = read_record(&file)?;
        tree.available = match (&expected, std::fs::canonicalize(&tree.path)) {
            (Some(parent), Ok(target))
                if target.parent() == Some(parent.as_path())
                    && target
                        .file_name()
                        .is_some_and(|name| name.to_str() == Some(&tree.id.to_string())) =>
            {
                match repository(&tree.path).await {
                    Ok(target_repo) => storage_root(data_dir, user_id, &target_repo).await? == root,
                    Err(_) => false,
                }
            }
            _ => false,
        };
        trees.push(tree);
    }
    trees.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(trees)
}
async fn set_worktree_archived(
    data_dir: &Path,
    user_id: &str,
    path: &str,
    id: Uuid,
    archived: bool,
) -> Result<ManagedWorktree, ApiError> {
    let _guard = MUTATIONS.lock().await;
    let repo = repository(path).await?;
    let root = storage_root(data_dir, user_id, &repo).await?;
    let mut tree = list_managed_worktrees(data_dir, user_id, path)
        .await?
        .into_iter()
        .find(|tree| tree.id == id)
        .ok_or_else(|| ApiError::bad_request("Managed worktree is unavailable for this owner"))?;
    if !tree.available {
        return Err(ApiError::bad_request(
            "Managed checkout is unavailable; recover its directory before reactivating",
        ));
    }
    if tree.archived == archived {
        return Ok(tree);
    }
    if archived {
        let checkout = repository(&tree.path).await?;
        let checkpoint = capture_inner(
            data_dir,
            user_id,
            &checkout,
            &format!("Archived {}", tree.name),
        )
        .await?;
        tree.archive_checkpoint_id = Some(checkpoint.id);
    }
    tree.archived = archived;
    write_record(&root.join("worktrees").join(format!("{id}.json")), &tree)?;
    Ok(tree)
}
async fn managed_checkout(data_dir: &Path, user_id: &str, path: &str) -> Result<bool, ApiError> {
    let repo = repository(path).await?;
    Ok(list_managed_worktrees(data_dir, user_id, path)
        .await?
        .iter()
        .any(|tree| {
            tree.available && std::fs::canonicalize(&tree.path).ok().as_ref() == Some(&repo)
        }))
}
async fn checkpoints_directory(
    data_dir: &Path,
    user_id: &str,
    repo: &Path,
) -> Result<PathBuf, ApiError> {
    Ok(storage_root(data_dir, user_id, repo)
        .await?
        .join("checkpoints")
        .join(path_key(repo)))
}
async fn checkpoint_records(
    data_dir: &Path,
    user_id: &str,
    repo: &Path,
) -> Result<Vec<CheckpointRecord>, ApiError> {
    let directory = checkpoints_directory(data_dir, user_id, repo).await?;
    let mut checkpoints: Vec<CheckpointRecord> = record_files(&directory, 100)?
        .iter()
        .map(|path| read_record(path))
        .collect::<Result<_, _>>()?;
    checkpoints.sort_by_key(|record| (record.captured_at, record.checkpoint.id));
    Ok(checkpoints)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewindFiles {
    pub managed: bool,
    pub checkpoints: Vec<WorkspaceCheckpoint>,
    pub fingerprint: String,
}
pub(crate) async fn rewind_files(
    data_dir: &Path,
    owner: &str,
    path: &str,
) -> Result<RewindFiles, ApiError> {
    let _guard = MUTATIONS.lock().await;
    let repo = repository(path).await?;
    let records = checkpoint_records(data_dir, owner, &repo).await?;
    let current = snapshot(&repo).await?;
    Ok(RewindFiles {
        managed: managed_checkout(data_dir, owner, path).await?,
        checkpoints: records
            .into_iter()
            .map(|record| record.checkpoint)
            .collect(),
        fingerprint: digest(&format!(
            "{}:{}:{}",
            current.tree, current.index_tree, current.head
        )),
    })
}
pub(crate) async fn checkpoint_matches(
    data: &Path,
    owner: &str,
    path: &str,
    id: Uuid,
) -> Result<bool, ApiError> {
    let _guard = MUTATIONS.lock().await;
    let repo = repository(path).await?;
    if !managed_checkout(data, owner, path).await? {
        return Err(ApiError::bad_request(
            "Recovery requires your managed worktree",
        ));
    }
    let records = checkpoint_records(data, owner, &repo).await?;
    let target = records
        .iter()
        .find(|record| record.checkpoint.id == id)
        .ok_or_else(|| ApiError::not_found("Recovery checkpoint unavailable"))?;
    let current = snapshot(&repo).await?;
    Ok(current.tree == target.tree && current.index_tree == target.index_tree)
}
struct Snapshot {
    tree: String,
    index_tree: String,
    head: String,
    index: tempfile::TempDir,
}
async fn snapshot(repo: &Path) -> Result<Snapshot, ApiError> {
    let files = git_run(
        repo,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        None,
        LIST_LIMIT,
    )
    .await?;
    if files.truncated {
        return Err(ApiError::bad_request(
            "Workspace file list exceeds the checkpoint limit",
        ));
    }
    let mut total = 0u64;
    let mut count = 0;
    for file in files
        .bytes
        .split(|&c| c == 0)
        .filter(|file| !file.is_empty())
    {
        count += 1;
        let file = String::from_utf8_lossy(file);
        if let Ok(metadata) = std::fs::symlink_metadata(repo.join(file.as_ref())) {
            if metadata.is_file() {
                if metadata.len() > 10_000_000 {
                    return Err(ApiError::bad_request(
                        "Checkpoint files are limited to 10 MB each",
                    ));
                }
                total = total.saturating_add(metadata.len());
            }
        }
    }
    if count > 5000 || total > 100_000_000 {
        return Err(ApiError::bad_request(
            "Checkpoints are limited to 5000 files and 100 MB",
        ));
    }
    let head = resolve_ref(repo, "HEAD").await?;
    let index_tree = git_text(repo, &["write-tree"], None).await?;
    let index = tempfile::tempdir()
        .map_err(|_| ApiError::internal("Unable to create private checkpoint index"))?;
    let index_path = index.path().join("index");
    git_text(repo, &["read-tree", "HEAD"], Some(&index_path)).await?;
    git_text(repo, &["add", "-A", "--", "."], Some(&index_path)).await?;
    let tree = git_text(repo, &["write-tree"], Some(&index_path)).await?;
    Ok(Snapshot {
        tree,
        index_tree,
        head,
        index,
    })
}
async fn capture_inner(
    data_dir: &Path,
    user_id: &str,
    repo: &Path,
    label: &str,
) -> Result<WorkspaceCheckpoint, ApiError> {
    if label.trim().is_empty() || label.chars().count() > 120 || label.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "Checkpoint label requires 1 to 120 characters",
        ));
    }
    let directory = checkpoints_directory(data_dir, user_id, repo).await?;
    if record_files(&directory, 100)?.len() >= 100 {
        return Err(ApiError::bad_request("Checkpoint limit reached"));
    }
    let current = snapshot(repo).await?;
    let id = Uuid::new_v4();
    let captured_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let created_at = captured_time.as_secs();
    let captured_at = captured_time.as_nanos();
    let checkpoint = WorkspaceCheckpoint {
        id,
        label: label.trim().into(),
        created_at,
    };
    let reference = format!(
        "refs/terminal-workspace-checkpoints/{}/{}/{id}",
        digest(user_id),
        path_key(repo)
    );
    git_text(repo, &["update-ref", &reference, &current.tree], None).await?;
    let index_ref = format!("{reference}-index");
    git_text(repo, &["update-ref", &index_ref, &current.index_tree], None).await?;
    write_record(
        &directory.join(format!("{id}.json")),
        &CheckpointRecord {
            checkpoint: checkpoint.clone(),
            tree: current.tree,
            index_tree: current.index_tree,
            head: current.head,
            captured_at,
        },
    )?;
    Ok(checkpoint)
}
pub(crate) async fn capture_checkpoint(
    data_dir: &Path,
    user_id: &str,
    workspace_path: &str,
    label: &str,
) -> Result<WorkspaceCheckpoint, ApiError> {
    let _guard = MUTATIONS.lock().await;
    let repo = repository(workspace_path).await?;
    capture_inner(data_dir, user_id, &repo, label).await
}
pub(crate) async fn restore_checkpoint(
    data_dir: &Path,
    user_id: &str,
    path: &str,
    id: Uuid,
) -> Result<(), ApiError> {
    let _guard = MUTATIONS.lock().await;
    let repo = repository(path).await?;
    if !managed_checkout(data_dir, user_id, path).await? {
        return Err(ApiError::bad_request(
            "File restore requires your managed isolated worktree",
        ));
    }
    let records = checkpoint_records(data_dir, user_id, &repo).await?;
    let target = records
        .iter()
        .find(|record| record.checkpoint.id == id)
        .ok_or_else(|| ApiError::bad_request("Checkpoint is unavailable for this workspace"))?;
    let latest = records
        .last()
        .ok_or_else(|| ApiError::bad_request("No checkpoint is available"))?;
    let current = snapshot(&repo).await?;
    if current.tree != latest.tree
        || current.index_tree != latest.index_tree
        || current.head != latest.head
    {
        return Err(ApiError::bad_request("Files, staged changes, or HEAD changed since the latest checkpoint. Save and review those changes before restoring."));
    }
    if records.len() >= 100 {
        return Err(ApiError::bad_request(
            "Checkpoint limit reached; restore cannot record its result",
        ));
    }
    let additions = git_run(
        &repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "--diff-filter=A",
            "-z",
            &current.tree,
            &target.tree,
            "--",
        ],
        None,
        LIST_LIMIT,
    )
    .await?;
    if additions.truncated {
        return Err(ApiError::bad_request(
            "Restore file list exceeds the workspace limit",
        ));
    }
    for entry in additions
        .bytes
        .split(|&byte| byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let relative = String::from_utf8_lossy(entry);
        validate_file(&relative)?;
        if std::fs::symlink_metadata(repo.join(relative.as_ref())).is_ok() {
            return Err(ApiError::bad_request(
                "An ignored or untracked file would be overwritten by this restore",
            ));
        }
        let mut parent = repo.clone();
        let components: Vec<_> = Path::new(relative.as_ref()).components().collect();
        for component in components.iter().take(components.len().saturating_sub(1)) {
            parent.push(component);
            if std::fs::symlink_metadata(&parent)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(ApiError::bad_request(
                    "A symbolic-link directory conflicts with this restore",
                ));
            }
        }
    }
    let private_index = current.index.path().join("index");
    // Two-tree checkout refuses edits that race the drift check; the user's index stays separate.
    git_text(
        &repo,
        &["read-tree", "-m", "-u", &current.tree, &target.tree],
        Some(&private_index),
    )
    .await?;
    git_text(&repo, &["read-tree", &target.index_tree], None).await?;
    capture_inner(
        data_dir,
        user_id,
        &repo,
        &format!(
            "Restored {}",
            target
                .checkpoint
                .label
                .chars()
                .take(100)
                .collect::<String>()
        ),
    )
    .await
    .map_err(|_| {
        ApiError::internal("Files restored, but the resulting checkpoint could not be saved")
    })?;
    Ok(())
}
async fn checkpoint_review_args(
    data_dir: &Path,
    user_id: &str,
    path: &str,
    id: Uuid,
) -> Result<(PathBuf, Vec<String>), ApiError> {
    let repo = repository(path).await?;
    let records = checkpoint_records(data_dir, user_id, &repo).await?;
    let target = records
        .iter()
        .find(|record| record.checkpoint.id == id)
        .ok_or_else(|| ApiError::bad_request("Checkpoint is unavailable for this workspace"))?;
    let current = snapshot(&repo).await?;
    Ok((
        repo,
        vec![
            "diff".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--no-renames".into(),
            target.tree.clone(),
            current.tree,
        ],
    ))
}
async fn status_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<GitQuery>,
) -> Result<
    (
        [(axum::http::header::HeaderName, &'static str); 1],
        Json<Value>,
    ),
    ApiError,
> {
    let mut value = if query.mode == "checkpoint" {
        let id = query
            .checkpoint_id
            .ok_or_else(|| ApiError::bad_request("Checkpoint ID is required"))?;
        let (repo, args) =
            checkpoint_review_args(&state.config().data_dir, &user.user_id, &query.path, id)
                .await?;
        let (files, truncated) = changed_files(&repo, &args, false).await?;
        json!({"branch":git_text(&repo,&["branch","--show-current"],None).await?,"files":files,"truncated":truncated})
    } else {
        review_status(&query.path, &query.mode, &query.base).await?
    };
    value["managed"] =
        json!(managed_checkout(&state.config().data_dir, &user.user_id, &query.path).await?);
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    ))
}
async fn diff_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<GitQuery>,
) -> Result<
    (
        [(axum::http::header::HeaderName, &'static str); 1],
        Json<Value>,
    ),
    ApiError,
> {
    let file = query
        .file
        .ok_or_else(|| ApiError::bad_request("Changed file is required"))?;
    let value = if query.mode == "checkpoint" {
        let id = query
            .checkpoint_id
            .ok_or_else(|| ApiError::bad_request("Checkpoint ID is required"))?;
        let (repo, args) =
            checkpoint_review_args(&state.config().data_dir, &user.user_id, &query.path, id)
                .await?;
        let (files, _) = changed_files(&repo, &args, false).await?;
        if !files
            .iter()
            .any(|entry| entry["path"].as_str() == Some(&file))
        {
            return Err(ApiError::bad_request(
                "File is not changed since this checkpoint",
            ));
        }
        file_patch(&repo, &args, &file, false).await?
    } else {
        review_diff(&query.path, &query.mode, &query.base, &file).await?
    };
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    ))
}
async fn worktrees_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<GitQuery>,
) -> Result<Json<Vec<ManagedWorktree>>, ApiError> {
    Ok(Json(
        list_managed_worktrees(&state.config().data_dir, &user.user_id, &query.path).await?,
    ))
}
async fn create_worktree_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<WorktreeInput>,
) -> Result<Json<ManagedWorktree>, ApiError> {
    let _activity =
        crate::workspace_activity::enter(Path::new(&input.path)).map_err(ApiError::bad_request)?;
    Ok(Json(
        create_managed_worktree(
            &state.config().data_dir,
            &user.user_id,
            &input.path,
            &input.name,
            &input.base_ref,
        )
        .await?,
    ))
}
async fn archive_worktree_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<WorktreeLifecycleInput>,
) -> Result<Json<ManagedWorktree>, ApiError> {
    let _activity =
        crate::workspace_activity::enter(Path::new(&input.path)).map_err(ApiError::bad_request)?;
    Ok(Json(
        set_worktree_archived(
            &state.config().data_dir,
            &user.user_id,
            &input.path,
            input.worktree_id,
            true,
        )
        .await?,
    ))
}
async fn reactivate_worktree_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<WorktreeLifecycleInput>,
) -> Result<Json<ManagedWorktree>, ApiError> {
    let _activity =
        crate::workspace_activity::enter(Path::new(&input.path)).map_err(ApiError::bad_request)?;
    Ok(Json(
        set_worktree_archived(
            &state.config().data_dir,
            &user.user_id,
            &input.path,
            input.worktree_id,
            false,
        )
        .await?,
    ))
}
async fn checkpoints_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<GitQuery>,
) -> Result<Json<Vec<WorkspaceCheckpoint>>, ApiError> {
    let repo = repository(&query.path).await?;
    let records = checkpoint_records(&state.config().data_dir, &user.user_id, &repo).await?;
    Ok(Json(
        records
            .into_iter()
            .map(|record| record.checkpoint)
            .collect(),
    ))
}
async fn capture_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<CheckpointInput>,
) -> Result<Json<WorkspaceCheckpoint>, ApiError> {
    let _activity =
        crate::workspace_activity::enter(Path::new(&input.path)).map_err(ApiError::bad_request)?;
    let checkpoint = capture_checkpoint(
        &state.config().data_dir,
        &user.user_id,
        &input.path,
        &input.label,
    )
    .await?;

    Ok(Json(checkpoint))
}
async fn restore_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<RestoreInput>,
) -> Result<Json<Value>, ApiError> {
    let _activity =
        crate::workspace_activity::enter(Path::new(&input.path)).map_err(ApiError::bad_request)?;
    restore_checkpoint(
        &state.config().data_dir,
        &user.user_id,
        &input.path,
        input.checkpoint_id,
    )
    .await?;
    Ok(Json(json!({"restored":true,"conversationRewound":false})))
}
#[cfg(test)]
mod integration_tests {
    use super::*;
    pub(super) fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
    pub(super) fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]);
        git(dir.path(), &["config", "core.autocrlf", "false"]);
        git(dir.path(), &["config", "user.name", "Workspace tests"]);
        git(
            dir.path(),
            &["config", "user.email", "workspace@example.test"],
        );
        std::fs::write(dir.path().join("note.txt"), "initial\n").unwrap();
        git(dir.path(), &["add", "note.txt"]);
        git(dir.path(), &["commit", "-m", "initial"]);
        dir
    }
    #[tokio::test]
    async fn review_separates_staged_unstaged_and_branch_changes_and_binary_files() {
        let repo = repository();
        let path = repo.path().to_str().unwrap();
        std::fs::write(repo.path().join("note.txt"), "staged\n").unwrap();
        git(repo.path(), &["add", "note.txt"]);
        std::fs::write(repo.path().join("note.txt"), "unstaged\n").unwrap();
        std::fs::write(repo.path().join("binary.bin"), [0, 1, 2]).unwrap();
        let staged = review_diff(path, "staged", "HEAD", "note.txt")
            .await
            .unwrap();
        let unstaged = review_diff(path, "unstaged", "HEAD", "note.txt")
            .await
            .unwrap();
        assert!(staged["patch"].as_str().unwrap().contains("+staged"));
        assert!(unstaged["patch"].as_str().unwrap().contains("+unstaged"));
        assert_eq!(
            review_diff(path, "unstaged", "HEAD", "binary.bin")
                .await
                .unwrap()["binary"],
            true
        );
        assert!(review_diff(path, "unstaged", "HEAD", "../outside.txt")
            .await
            .is_err());
        assert!(review_status(path, "base", "--output=unsafe")
            .await
            .is_err());
        git(repo.path(), &["add", "note.txt"]);
        git(repo.path(), &["commit", "-m", "changed"]);
        assert!(review_diff(path, "base", "HEAD~1", "note.txt")
            .await
            .unwrap()["patch"]
            .as_str()
            .unwrap()
            .contains("+unstaged"));
    }
    #[tokio::test]
    async fn managed_worktrees_keep_parent_edits_and_are_scoped_to_the_owner() {
        let repo = repository();
        let data = tempfile::tempdir().unwrap();
        let path = repo.path().to_str().unwrap();
        std::fs::write(repo.path().join("note.txt"), "parent edits\n").unwrap();
        let tree = create_managed_worktree(data.path(), "owner", path, "Fix note", "HEAD")
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&tree.path).join("note.txt")).unwrap(),
            "initial\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("note.txt")).unwrap(),
            "parent edits\n"
        );
        assert_eq!(
            list_managed_worktrees(data.path(), "owner", path)
                .await
                .unwrap(),
            vec![tree]
        );
        assert!(list_managed_worktrees(data.path(), "another", path)
            .await
            .unwrap()
            .is_empty());
        assert!(
            create_managed_worktree(data.path(), "owner", path, "../../bad", "HEAD")
                .await
                .is_err()
        );
        assert!(
            create_managed_worktree(data.path(), "owner", path, "Good", "--detach")
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn checkpoints_restore_isolated_files_and_reject_user_drift_and_shared_roots() {
        let repo = repository();
        let data = tempfile::tempdir().unwrap();
        let path = repo.path().to_str().unwrap();
        let root = capture_checkpoint(data.path(), "owner", path, "Root")
            .await
            .unwrap();
        assert!(restore_checkpoint(data.path(), "owner", path, root.id)
            .await
            .is_err());
        let tree = create_managed_worktree(data.path(), "owner", path, "Checkpoint test", "HEAD")
            .await
            .unwrap();
        let first = capture_checkpoint(data.path(), "owner", &tree.path, "Before")
            .await
            .unwrap();
        std::fs::write(Path::new(&tree.path).join("note.txt"), "agent edits\n").unwrap();
        std::fs::write(Path::new(&tree.path).join("new.txt"), "new file\n").unwrap();
        capture_checkpoint(data.path(), "owner", &tree.path, "After")
            .await
            .unwrap();
        std::fs::write(Path::new(&tree.path).join("note.txt"), "user edits\n").unwrap();
        assert!(
            restore_checkpoint(data.path(), "owner", &tree.path, first.id)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&tree.path).join("note.txt")).unwrap(),
            "user edits\n"
        );
        std::fs::write(Path::new(&tree.path).join("note.txt"), "agent edits\n").unwrap();
        restore_checkpoint(data.path(), "owner", &tree.path, first.id)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&tree.path).join("note.txt")).unwrap(),
            "initial\n"
        );
        assert!(!Path::new(&tree.path).join("new.txt").exists());
        assert_eq!(git(Path::new(&tree.path), &["status", "--porcelain"]), "");
        assert!(
            restore_checkpoint(data.path(), "another", &tree.path, first.id)
                .await
                .is_err()
        );
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    #[tokio::test]
    async fn git_routes_require_authentication_and_isolate_worktree_records() {
        let data = tempfile::tempdir().unwrap();
        let repo = super::integration_tests::repository();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().to_path_buf(),
            jwt_secret: "git-route-secret".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let path = repo.path().to_str().unwrap();
        let query = url::form_urlencoded::byte_serialize(path.as_bytes()).collect::<String>();
        let uri = format!("/api/workspace/git/status?path={query}");
        let no_auth = app
            .clone()
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        let token = crate::auth::issue_access_token("git-route-secret", "owner", "owner");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            (
                response.status(),
                response.headers()["cache-control"].to_str().unwrap()
            ),
            (StatusCode::OK, "private, no-store")
        );
        let body = json!({"path":path,"name":"API task","baseRef":"HEAD"});
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/workspace/git/worktrees")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let tree: ManagedWorktree =
            serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert!(Path::new(&tree.path).join("note.txt").is_file());
        let other = crate::auth::issue_access_token("git-route-secret", "another", "another");
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/workspace/git/worktrees?path={query}"))
                    .header("Authorization", format!("Bearer {other}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &response.into_body().collect().await.unwrap().to_bytes()
            )
            .unwrap(),
            json!([])
        );
    }
    #[tokio::test]
    async fn lifecycle_routes_require_authentication_and_reject_other_owners() {
        let data = tempfile::tempdir().unwrap();
        let repo = super::integration_tests::repository();
        let path = repo.path().to_str().unwrap();
        let tree = create_managed_worktree(data.path(), "owner", path, "API lifecycle", "HEAD")
            .await
            .unwrap();
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: data.path().to_path_buf(),
                jwt_secret: "lifecycle-secret".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let input = json!({"path":path,"worktreeId":tree.id});
        let request = |action: &str, token: Option<String>| {
            let mut builder = Request::builder()
                .method("POST")
                .uri(format!("/api/workspace/git/worktrees/{action}"))
                .header("Content-Type", "application/json");
            if let Some(token) = token {
                builder = builder.header("Authorization", format!("Bearer {token}"));
            }
            builder.body(Body::from(input.to_string())).unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(request("archive", None))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let other = crate::auth::issue_access_token("lifecycle-secret", "other", "other");
        assert_eq!(
            app.clone()
                .oneshot(request("archive", Some(other)))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let owner = crate::auth::issue_access_token("lifecycle-secret", "owner", "owner");
        let archived = app
            .clone()
            .oneshot(request("archive", Some(owner.clone())))
            .await
            .unwrap();
        assert_eq!(archived.status(), StatusCode::OK);
        let body: ManagedWorktree =
            serde_json::from_slice(&archived.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!((body.archived, body.available), (true, true));
        let active = app
            .oneshot(request("reactivate", Some(owner)))
            .await
            .unwrap();
        assert_eq!(active.status(), StatusCode::OK);
        let body: ManagedWorktree =
            serde_json::from_slice(&active.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            (body.archived, body.available, body.path),
            (false, true, tree.path)
        );
    }
    #[tokio::test]
    async fn diff_preview_reports_deleted_files_and_large_patch_limits() {
        let repo = super::integration_tests::repository();
        let path = repo.path().to_str().unwrap();
        std::fs::remove_file(repo.path().join("note.txt")).unwrap();
        let status = review_status(path, "unstaged", "HEAD").await.unwrap();
        assert_eq!(
            status["files"],
            json!([{"path":"note.txt","status":"D","binary":false,"added":0,"removed":1}])
        );
        std::fs::write(repo.path().join("large.txt"), "x\n".repeat(PATCH_LIMIT)).unwrap();
        let diff = review_diff(path, "unstaged", "HEAD", "large.txt")
            .await
            .unwrap();
        assert_eq!(
            (
                diff["truncated"].as_bool().unwrap(),
                diff["patch"].as_str().unwrap().len()
            ),
            (true, PATCH_LIMIT)
        );
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    #[test]
    fn references_and_files_reject_options_ranges_and_path_traversal() {
        assert_eq!(
            [
                "HEAD",
                "HEAD~1",
                "origin/main",
                "--detach",
                "main..HEAD",
                "HEAD:path"
            ]
            .map(|value| validate_ref(value).is_ok()),
            [true, true, true, false, false, false]
        );
        assert_eq!(
            ["src/a.js", "../a.js", "/absolute", "a/../b", "a\\b"]
                .map(|value| validate_file(value).is_ok()),
            [true, false, false, false, false]
        );
    }
}

#[cfg(test)]
mod checkpoint_integration_tests {
    use super::*;
    #[tokio::test]
    async fn restore_preserves_saved_staging_and_binary_file_contents() {
        let repo = super::integration_tests::repository();
        let data = tempfile::tempdir().unwrap();
        let tree = create_managed_worktree(
            data.path(),
            "owner",
            repo.path().to_str().unwrap(),
            "Staging test",
            "HEAD",
        )
        .await
        .unwrap();
        let path = Path::new(&tree.path);
        std::fs::write(path.join("note.txt"), "before-staged\n").unwrap();
        super::integration_tests::git(path, &["add", "note.txt"]);
        std::fs::write(path.join("binary.bin"), [0, 1, 2]).unwrap();
        let before = capture_checkpoint(data.path(), "owner", &tree.path, "Before staged edits")
            .await
            .unwrap();
        std::fs::write(path.join("note.txt"), "after-staged\n").unwrap();
        super::integration_tests::git(path, &["add", "note.txt"]);
        std::fs::write(path.join("binary.bin"), [0, 5, 6]).unwrap();
        capture_checkpoint(data.path(), "owner", &tree.path, "After staged edits")
            .await
            .unwrap();
        restore_checkpoint(data.path(), "owner", &tree.path, before.id)
            .await
            .unwrap();
        assert_eq!(
            (
                std::fs::read_to_string(path.join("note.txt")).unwrap(),
                std::fs::read(path.join("binary.bin")).unwrap(),
                super::integration_tests::git(path, &["show", ":note.txt"])
            ),
            (
                "before-staged\n".into(),
                vec![0, 1, 2],
                "before-staged".into()
            )
        );
    }
    #[tokio::test]
    async fn worktree_checkout_disables_repository_hooks_and_filter_commands() {
        let repo = super::integration_tests::repository();
        let data = tempfile::tempdir().unwrap();
        super::integration_tests::git(
            repo.path(),
            &[
                "config",
                "filter.danger.smudge",
                "echo ran > filter-ran.txt",
            ],
        );
        super::integration_tests::git(repo.path(), &["config", "filter.danger.required", "false"]);
        std::fs::write(repo.path().join(".gitattributes"), "*.txt filter=danger\n").unwrap();
        super::integration_tests::git(repo.path(), &["add", ".gitattributes"]);
        super::integration_tests::git(repo.path(), &["commit", "-m", "attributes"]);
        super::integration_tests::git(repo.path(), &["config", "filter.danger.required", "true"]);
        let hooks = repo.path().join(".git/hooks");
        std::fs::write(
            hooks.join("post-checkout"),
            "#!/bin/sh\necho ran > hook-ran.txt\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                hooks.join("post-checkout"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let tree = create_managed_worktree(
            data.path(),
            "owner",
            repo.path().to_str().unwrap(),
            "Safe checkout",
            "HEAD",
        )
        .await
        .unwrap();
        assert_eq!(
            [
                Path::new(&tree.path).join("filter-ran.txt").exists(),
                Path::new(&tree.path).join("hook-ran.txt").exists(),
                repo.path().join("filter-ran.txt").exists(),
                repo.path().join("hook-ran.txt").exists()
            ],
            [false, false, false, false]
        );
    }
}

#[cfg(test)]
mod restore_conflict_tests {
    use super::*;
    #[tokio::test]
    async fn restore_rejects_ignored_files_that_collide_with_the_checkpoint() {
        let repo = super::integration_tests::repository();
        let data = tempfile::tempdir().unwrap();
        let tree = create_managed_worktree(
            data.path(),
            "owner",
            repo.path().to_str().unwrap(),
            "Ignored conflict",
            "HEAD",
        )
        .await
        .unwrap();
        let path = Path::new(&tree.path);
        std::fs::write(path.join("saved.txt"), "saved snapshot\n").unwrap();
        let before = capture_checkpoint(data.path(), "owner", &tree.path, "Before ignore")
            .await
            .unwrap();
        std::fs::remove_file(path.join("saved.txt")).unwrap();
        std::fs::write(path.join(".gitignore"), "saved.txt\n").unwrap();
        capture_checkpoint(data.path(), "owner", &tree.path, "After ignore")
            .await
            .unwrap();
        std::fs::write(path.join("saved.txt"), "user ignored file\n").unwrap();
        assert!(
            restore_checkpoint(data.path(), "owner", &tree.path, before.id)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(path.join("saved.txt")).unwrap(),
            "user ignored file\n"
        );
    }
}

#[cfg(test)]
mod worktree_lifecycle_tests {
    use super::*;
    #[tokio::test]
    async fn archive_retains_staging_untracked_and_ignored_files_and_reactivates() {
        let repo = super::integration_tests::repository();
        let data = tempfile::tempdir().unwrap();
        let root = repo.path().to_str().unwrap();
        let tree = create_managed_worktree(data.path(), "owner", root, "Retained task", "HEAD")
            .await
            .unwrap();
        let path = Path::new(&tree.path);
        std::fs::write(path.join("note.txt"), "staged changes\n").unwrap();
        super::integration_tests::git(path, &["add", "note.txt"]);
        std::fs::write(path.join("note.txt"), "unstaged changes\n").unwrap();
        std::fs::write(path.join("new.txt"), "untracked changes\n").unwrap();
        std::fs::write(path.join(".gitignore"), "ignored.bin\n").unwrap();
        std::fs::write(path.join("ignored.bin"), [1, 0, 3]).unwrap();
        let before_status = super::integration_tests::git(path, &["status", "--porcelain"]);
        assert!(
            set_worktree_archived(data.path(), "another", root, tree.id, true)
                .await
                .is_err()
        );
        let archived = set_worktree_archived(data.path(), "owner", root, tree.id, true)
            .await
            .unwrap();
        assert!(archived.archived && archived.available);
        assert!(archived.archive_checkpoint_id.is_some());
        let records =
            checkpoint_records(data.path(), "owner", &repository(&tree.path).await.unwrap())
                .await
                .unwrap();
        assert_eq!(records.len(), 1);
        let repeated = set_worktree_archived(data.path(), "owner", root, tree.id, true)
            .await
            .unwrap();
        assert_eq!(
            repeated.archive_checkpoint_id,
            archived.archive_checkpoint_id
        );
        let reopened = set_worktree_archived(data.path(), "owner", root, tree.id, false)
            .await
            .unwrap();
        assert_eq!(
            (reopened.archived, reopened.available, reopened.path),
            (false, true, tree.path.clone())
        );
        assert_eq!(
            (
                std::fs::read_to_string(path.join("note.txt")).unwrap(),
                std::fs::read_to_string(path.join("new.txt")).unwrap(),
                std::fs::read(path.join("ignored.bin")).unwrap(),
                super::integration_tests::git(path, &["show", ":note.txt"]),
                super::integration_tests::git(path, &["status", "--porcelain"]),
                std::fs::read_to_string(repo.path().join("note.txt")).unwrap(),
            ),
            (
                "unstaged changes\n".into(),
                "untracked changes\n".into(),
                vec![1, 0, 3],
                "staged changes".into(),
                before_status,
                "initial\n".into(),
            )
        );
    }
}
