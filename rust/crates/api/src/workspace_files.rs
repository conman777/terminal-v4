//! File suggestions for `@` mentions in the composer: project files matching what the user typed.
use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

const MAX_RESULTS: usize = 30;
const MAX_WALK: usize = 20_000;
const MAX_CONTENT_RESULTS: usize = 100;
const MAX_CONTENT_FILE_BYTES: u64 = 256 * 1024;
const MAX_CONTENT_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const SKIPPED_DIRS: [&str; 6] = [".git", "node_modules", "target", "dist", ".next", ".venv"];
static CONTENT_SEARCH_SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

#[derive(Deserialize)]
struct FilesQuery {
    path: String,
    #[serde(default)]
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentQuery {
    session_id: String,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinePreviewQuery {
    session_id: String,
    root: String,
    path: String,
    line: usize,
    #[serde(default)]
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopedDirectoryQuery {
    session_id: String,
    root: String,
    #[serde(default)]
    path: String,
}

#[derive(Debug, Serialize)]
struct ScopedDirectoryEntry {
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
}

#[derive(Debug, Serialize)]
struct ScopedDirectory {
    items: Vec<ScopedDirectoryEntry>,
    truncated: bool,
}

#[derive(Debug, PartialEq, Serialize)]
struct ContentMatch {
    path: String,
    line: usize,
    text: String,
}

#[derive(Serialize)]
struct ContentResults {
    matches: Vec<ContentMatch>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinePreview {
    path: String,
    line: usize,
    total_lines: usize,
    lines: Vec<PreviewLine>,
}

#[derive(Serialize)]
struct PreviewLine {
    line: usize,
    text: String,
    truncated: bool,
}

struct SearchCancellation(Arc<AtomicBool>);
impl Drop for SearchCancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

#[cfg(unix)]
fn open_child(parent: &std::fs::File, name: &std::ffi::CStr) -> Option<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        None
    } else {
        Some(unsafe { std::fs::File::from_raw_fd(fd) })
    }
}

#[cfg(unix)]
pub(crate) fn open_workspace_root(root: &Path) -> Result<std::fs::File, String> {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    if !root.is_absolute() {
        return Err("Invalid workspace path".into());
    }
    let mut current = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|_| "Workspace is unavailable")?;
    for component in root.components() {
        match component {
            std::path::Component::RootDir => (),
            std::path::Component::Normal(name) => {
                let name = CString::new(name.as_bytes()).map_err(|_| "Invalid workspace path")?;
                current = open_child(&current, &name).ok_or("Workspace is unavailable")?;
                if !current
                    .metadata()
                    .map_err(|_| "Workspace is unavailable")?
                    .is_dir()
                {
                    return Err("Workspace is unavailable".into());
                }
            }
            _ => return Err("Invalid workspace path".into()),
        }
    }
    Ok(current)
}

#[cfg(unix)]
pub(crate) fn open_workspace_file(
    root: &std::fs::File,
    relative: &str,
) -> Result<std::fs::File, String> {
    use std::{
        ffi::CString,
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
    };
    if relative.is_empty()
        || relative.len() > 2_048
        || relative.contains('\\')
        || relative.chars().any(char::is_control)
    {
        return Err("Invalid project file path".into());
    }
    let parts: Vec<_> = relative.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err("Invalid project file path".into());
    }
    let mut parent = root.try_clone().map_err(|_| "Workspace is unavailable")?;
    for (index, part) in parts.iter().enumerate() {
        let name = CString::new(std::ffi::OsStr::new(part).as_bytes())
            .map_err(|_| "Invalid project file path")?;
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err("Project file is unavailable".into());
        }
        let metadata = unsafe { metadata.assume_init() };
        let expected = if index + 1 == parts.len() {
            libc::S_IFREG
        } else {
            libc::S_IFDIR
        };
        if metadata.st_mode & libc::S_IFMT != expected {
            return Err("Project file is unavailable".into());
        }
        let file = open_child(&parent, &name).ok_or("Project file is unavailable")?;
        let opened = file.metadata().map_err(|_| "Project file is unavailable")?;
        if (index + 1 == parts.len() && !opened.is_file())
            || (index + 1 != parts.len() && !opened.is_dir())
        {
            return Err("Project file is unavailable".into());
        }
        parent = file;
    }
    Ok(parent)
}

#[cfg(unix)]
fn open_workspace_directory(root: &std::fs::File, relative: &str) -> Result<std::fs::File, String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    if relative.len() > 2_048 || relative.contains('\\') || relative.chars().any(char::is_control) {
        return Err("Invalid project directory".into());
    }
    let mut directory = root.try_clone().map_err(|_| "Workspace is unavailable")?;
    if relative.is_empty() {
        return Ok(directory);
    }
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err("Invalid project directory".into());
        }
        let name = CString::new(std::ffi::OsStr::new(part).as_bytes())
            .map_err(|_| "Invalid project directory")?;
        directory = open_child(&directory, &name).ok_or("Project directory is unavailable")?;
        if !directory
            .metadata()
            .map_err(|_| "Project directory is unavailable")?
            .is_dir()
        {
            return Err("Project directory is unavailable".into());
        }
    }
    Ok(directory)
}

#[cfg(unix)]
fn list_scoped_directory(root: &Path, relative: &str) -> Result<ScopedDirectory, String> {
    use std::{
        ffi::CStr,
        os::{
            fd::{AsRawFd, IntoRawFd},
            unix::fs::MetadataExt,
        },
        time::Instant,
    };
    let root_fd = open_workspace_root(root)?;
    let root_meta = root_fd.metadata().map_err(|_| "Workspace is unavailable")?;
    let directory = open_workspace_directory(&root_fd, relative)?;
    let before = directory
        .metadata()
        .map_err(|_| "Project directory is unavailable")?;
    let duplicate = directory
        .try_clone()
        .map_err(|_| "Project directory is unavailable")?
        .into_raw_fd();
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        unsafe {
            libc::close(duplicate);
        }
        return Err("Project directory is unavailable".into());
    }
    let mut items = Vec::new();
    let mut truncated = false;
    let started = Instant::now();
    loop {
        if items.len() >= 2_000 || started.elapsed() >= Duration::from_secs(2) {
            truncated = true;
            break;
        }
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let Ok(name_str) = name.to_str() else {
            continue;
        };
        if name_str == "." || name_str == ".." || name_str.chars().any(char::is_control) {
            continue;
        }
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            continue;
        }
        let metadata = unsafe { metadata.assume_init() };
        let kind = match metadata.st_mode & libc::S_IFMT {
            libc::S_IFDIR => "directory",
            libc::S_IFREG => "file",
            _ => continue,
        };
        items.push(ScopedDirectoryEntry {
            name: name_str.into(),
            kind,
            size: metadata.st_size.max(0) as u64,
        });
    }
    unsafe {
        libc::closedir(stream);
    }
    let current_root = open_workspace_root(root)?;
    let current_root_meta = current_root
        .metadata()
        .map_err(|_| "Workspace is unavailable")?;
    let current = open_workspace_directory(&current_root, relative)?
        .metadata()
        .map_err(|_| "Project directory is unavailable")?;
    if (root_meta.dev(), root_meta.ino()) != (current_root_meta.dev(), current_root_meta.ino())
        || (before.dev(), before.ino()) != (current.dev(), current.ino())
    {
        return Err("Project directory changed; try again".into());
    }
    items.sort_by(|a, b| {
        (b.kind == "directory")
            .cmp(&(a.kind == "directory"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(ScopedDirectory { items, truncated })
}

#[cfg(not(unix))]
fn list_scoped_directory(_root: &Path, _relative: &str) -> Result<ScopedDirectory, String> {
    Err("Project directory listing is unavailable on this platform".into())
}

#[cfg(unix)]
fn read_line_context(
    root: &Path,
    relative: &str,
    line: usize,
    query: &str,
) -> Result<LinePreview, String> {
    use std::{io::Read, os::unix::fs::MetadataExt};
    if line == 0 || line > 1_000_000 || query.len() > 200 {
        return Err("Invalid preview request".into());
    }
    let root_fd = open_workspace_root(root)?;
    let root_metadata = root_fd.metadata().map_err(|_| "Workspace is unavailable")?;
    let mut file = open_workspace_file(&root_fd, relative)?;
    let before = file.metadata().map_err(|_| "Project file is unavailable")?;
    if before.len() > MAX_CONTENT_FILE_BYTES {
        return Err("File is too large to preview".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_CONTENT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read project file")?;
    if bytes.len() as u64 > MAX_CONTENT_FILE_BYTES || bytes.contains(&0) {
        return Err("File is not a supported text file".into());
    }
    let after = file.metadata().map_err(|_| "Project file is unavailable")?;
    let current_root = open_workspace_root(root)?;
    let current_root_metadata = current_root
        .metadata()
        .map_err(|_| "Workspace is unavailable")?;
    let current_file = open_workspace_file(&current_root, relative)?;
    let current = current_file
        .metadata()
        .map_err(|_| "Project file is unavailable")?;
    if (root_metadata.dev(), root_metadata.ino())
        != (current_root_metadata.dev(), current_root_metadata.ino())
        || (before.dev(), before.ino()) != (current.dev(), current.ino())
        || (
            before.len(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        )
        || (
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ) != (
            current.len(),
            current.mtime(),
            current.mtime_nsec(),
            current.ctime(),
            current.ctime_nsec(),
        )
    {
        return Err("File changed during preview; search again".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "File is not a supported text file")?;
    let all: Vec<_> = text.lines().collect();
    if all.is_empty() && line == 1 {
        return Ok(LinePreview {
            path: relative.into(),
            line,
            total_lines: 0,
            lines: Vec::new(),
        });
    }
    if line > all.len() {
        return Err("That line no longer exists; search again".into());
    }
    let start = line.saturating_sub(8);
    let end = (line + 7).min(all.len());
    let needle = query.to_lowercase();
    let lines = all[start..end]
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let number = start + index + 1;
            let count = value.chars().count();
            let offset = if number == line && !needle.is_empty() {
                let folded = value.to_lowercase();
                folded
                    .find(&needle)
                    .map(|position| {
                        let wanted = folded[..position].chars().count();
                        let mut folded_chars = 0;
                        let mut source_chars = 0usize;
                        for character in value.chars() {
                            if folded_chars >= wanted {
                                break;
                            }
                            folded_chars += character.to_lowercase().count();
                            source_chars += 1;
                        }
                        source_chars.saturating_sub(80)
                    })
                    .unwrap_or(0)
            } else {
                0
            };
            PreviewLine {
                line: number,
                text: value.chars().skip(offset).take(500).collect(),
                truncated: offset > 0 || count > 500,
            }
        })
        .collect();
    Ok(LinePreview {
        path: relative.into(),
        line,
        total_lines: all.len(),
        lines,
    })
}

#[cfg(not(unix))]
fn read_line_context(
    _root: &Path,
    _relative: &str,
    _line: usize,
    _query: &str,
) -> Result<LinePreview, String> {
    Err("Project file preview is unavailable on this platform".into())
}

// Open each directory relative to an already-open parent, without following links.
// This keeps concurrent symlink replacements from redirecting a scan outside the root.
#[cfg(unix)]
fn search_contents(
    root: &Path,
    query: &str,
    cancelled: &AtomicBool,
) -> Result<ContentResults, String> {
    use std::{ffi::CStr, io::Read, os::fd::AsRawFd, time::Instant};
    let root_fd = open_workspace_root(root)?;
    let mut pending = vec![(root_fd, String::new())];
    let mut result = ContentResults {
        matches: Vec::new(),
        truncated: false,
    };
    let needle = query.to_lowercase();
    let start = Instant::now();
    let mut visited = 0usize;
    let mut bytes_read = 0u64;
    while let Some((directory, relative)) = pending.pop() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let dup = unsafe { libc::dup(directory.as_raw_fd()) };
        if dup < 0 {
            result.truncated = true;
            continue;
        }
        let stream = unsafe { libc::fdopendir(dup) };
        if stream.is_null() {
            unsafe {
                libc::close(dup);
            }
            result.truncated = true;
            continue;
        }
        loop {
            if cancelled.load(Ordering::Relaxed)
                || visited >= MAX_WALK
                || bytes_read >= MAX_CONTENT_TOTAL_BYTES
                || start.elapsed() >= Duration::from_secs(2)
                || result.matches.len() >= MAX_CONTENT_RESULTS
            {
                result.truncated = !cancelled.load(Ordering::Relaxed);
                break;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let Ok(name_str) = name.to_str() else {
                continue;
            };
            if name_str == "." || name_str == ".." {
                continue;
            }
            visited += 1;
            let Some(file) = open_child(&directory, name) else {
                continue;
            };
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            let path = if relative.is_empty() {
                name_str.to_owned()
            } else {
                format!("{relative}/{name_str}")
            };
            if metadata.is_dir() {
                if !SKIPPED_DIRS.contains(&name_str) {
                    if pending.len() < 256 {
                        pending.push((file, path));
                    } else {
                        result.truncated = true;
                    }
                }
                continue;
            }
            if !metadata.is_file() || metadata.len() > MAX_CONTENT_FILE_BYTES {
                continue;
            }
            let mut bytes = Vec::new();
            if file
                .take(MAX_CONTENT_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_CONTENT_FILE_BYTES
                || bytes.contains(&0)
            {
                continue;
            }
            bytes_read += bytes.len() as u64;
            let Ok(text) = std::str::from_utf8(&bytes) else {
                continue;
            };
            for (index, line) in text.lines().enumerate() {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }
                let lower = line.to_lowercase();
                let Some(position) = lower.find(&needle) else {
                    continue;
                };
                let char_pos = lower[..position].chars().count();
                let start = char_pos.saturating_sub(80);
                let excerpt: String = line.chars().skip(start).take(240).collect();
                result.matches.push(ContentMatch {
                    path: path.clone(),
                    line: index + 1,
                    text: excerpt,
                });
                if result.matches.len() >= MAX_CONTENT_RESULTS {
                    result.truncated = true;
                    break;
                }
            }
        }
        unsafe {
            libc::closedir(stream);
        }
        if result.truncated {
            break;
        }
    }
    Ok(result)
}

#[cfg(not(unix))]
fn search_contents(
    _root: &Path,
    _query: &str,
    _cancelled: &AtomicBool,
) -> Result<ContentResults, String> {
    Err("Project content search is unavailable on this platform".into())
}

async fn git_files(root: &Path) -> Option<Vec<String>> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("git")
            .current_dir(root)
            .args([
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output.status.success().then(|| {
        output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .take(MAX_WALK)
            .map(|entry| String::from_utf8_lossy(entry).into_owned())
            .collect()
    })
}

fn walked_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&relative)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = relative.join(&name);
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => {
                    if !SKIPPED_DIRS.contains(&name.as_str()) && pending.len() < MAX_WALK {
                        pending.push(path);
                    }
                }
                Ok(kind) if kind.is_file() => files.push(path.to_string_lossy().into_owned()),
                _ => {}
            }
            if files.len() >= MAX_WALK {
                return files;
            }
        }
    }
    files
}

/// Best matches first: file name starts with the query, then contains it, then the path contains it.
pub(crate) fn rank_files(files: Vec<String>, query: &str) -> Vec<String> {
    let needle = query.trim().to_lowercase();
    let mut ranked: Vec<(u8, usize, String)> = files
        .into_iter()
        .filter_map(|file| {
            let lower = file.to_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower);
            let rank = if needle.is_empty() {
                2
            } else if name.starts_with(&needle) {
                0
            } else if name.contains(&needle) {
                1
            } else if lower.contains(&needle) {
                2
            } else {
                return None;
            };
            Some((rank, file.len(), file))
        })
        .collect();
    ranked.sort();
    ranked
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(_, _, file)| file)
        .collect()
}

async fn files_route(
    Extension(_user): Extension<AuthenticatedUser>,
    Query(input): Query<FilesQuery>,
) -> Result<Json<Value>, ApiError> {
    let root = crate::files::resolve_existing_contained_path(&input.path)
        .map_err(ApiError::bad_request)?;
    if !root.is_dir() || input.query.len() > 200 {
        return Err(ApiError::bad_request("A project folder is required"));
    }
    let files = match git_files(&root).await {
        Some(files) => files,
        None => tokio::task::spawn_blocking({
            let root = root.clone();
            move || walked_files(&root)
        })
        .await
        .map_err(|_| ApiError::internal("File listing failed"))?,
    };
    Ok(Json(json!({ "files": rank_files(files, &input.query) })))
}

async fn content_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(input): Query<ContentQuery>,
) -> Result<Json<Value>, ApiError> {
    let query = input.query.trim();
    if query.is_empty()
        || query.len() > 200
        || input.session_id.is_empty()
        || input.session_id.len() > 200
    {
        return Err(ApiError::bad_request(
            "Enter a search of up to 200 bytes and select a session",
        ));
    }
    let root = session_workspace(&state, &user.user_id, &input.session_id).await?;
    let permit = CONTENT_SEARCH_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            status: axum::http::StatusCode::TOO_MANY_REQUESTS,
            message: "Project search is busy. Try again.".into(),
        })?;
    let guard = SearchCancellation(Arc::new(AtomicBool::new(false)));
    let cancelled = guard.0.clone();
    let search_root = root.clone();
    let needle = query.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        search_contents(&search_root, &needle, &cancelled)
    })
    .await
    .map_err(|_| ApiError::internal("Project search failed"))?
    .map_err(ApiError::bad_request)?;
    Ok(Json(
        json!({ "root": root, "matches": result.matches, "truncated": result.truncated }),
    ))
}

async fn session_workspace(
    state: &AppState,
    owner: &str,
    session_id: &str,
) -> Result<PathBuf, ApiError> {
    if session_id.is_empty() || session_id.len() > 200 {
        return Err(ApiError::bad_request("Select a session"));
    }
    let cwd = if session_id.starts_with("ss-") {
        state
            .structured_session_manager()
            .get_session(owner, session_id)
            .await
            .map_err(|_| ApiError::internal("Unable to find session"))?
            .map(|session| session.cwd)
    } else {
        state
            .terminal_manager()
            .get_project_info(owner, session_id)
            .await
            .map_err(|_| ApiError::internal("Unable to find session"))?
            .map(|session| session.cwd)
    }
    .ok_or_else(|| ApiError::not_found("Session not found"))?;
    let root =
        crate::files::resolve_existing_contained_path(&cwd).map_err(ApiError::bad_request)?;
    if !root.is_dir() {
        return Err(ApiError::bad_request("A project folder is required"));
    }
    Ok(root)
}

async fn line_preview_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(input): Query<LinePreviewQuery>,
) -> Result<Response, ApiError> {
    if input.root.len() > 2_048
        || input.path.len() > 2_048
        || input.query.len() > 200
        || input.line == 0
        || input.line > 1_000_000
    {
        return Err(ApiError::bad_request("Invalid preview request"));
    }
    let root = session_workspace(&state, &user.user_id, &input.session_id).await?;
    if !Path::new(&input.root).is_absolute()
        || crate::files::resolve_existing_contained_path(&input.root)
            .ok()
            .as_deref()
            != Some(root.as_path())
    {
        return Err(ApiError::bad_request("Workspace changed; search again"));
    }
    let permit = CONTENT_SEARCH_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            status: axum::http::StatusCode::TOO_MANY_REQUESTS,
            message: "File preview is busy. Try again.".into(),
        })?;
    let read_root = root.clone();
    let requested_root = input.root;
    let path = input.path;
    let query = input.query;
    let line = input.line;
    let preview = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read_line_context(&read_root, &path, line, &query)
    })
    .await
    .map_err(|_| ApiError::internal("File preview failed"))?
    .map_err(ApiError::bad_request)?;
    if session_workspace(&state, &user.user_id, &input.session_id).await? != root
        || crate::files::resolve_existing_contained_path(&requested_root)
            .ok()
            .as_deref()
            != Some(root.as_path())
    {
        return Err(ApiError::bad_request("Workspace changed; search again"));
    }
    let mut payload =
        serde_json::to_value(preview).map_err(|_| ApiError::internal("File preview failed"))?;
    payload["root"] = json!(requested_root);
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

async fn scoped_directory_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(input): Query<ScopedDirectoryQuery>,
) -> Result<Response, ApiError> {
    if input.root.len() > 2_048 || input.path.len() > 2_048 || !Path::new(&input.root).is_absolute()
    {
        return Err(ApiError::bad_request("Invalid project directory request"));
    }
    let root = session_workspace(&state, &user.user_id, &input.session_id).await?;
    if crate::files::resolve_existing_contained_path(&input.root)
        .ok()
        .as_deref()
        != Some(root.as_path())
    {
        return Err(ApiError::bad_request("Workspace changed; try again"));
    }
    let permit = CONTENT_SEARCH_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            status: axum::http::StatusCode::TOO_MANY_REQUESTS,
            message: "Project directory is busy. Try again.".into(),
        })?;
    let read_root = root.clone();
    let relative = input.path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        list_scoped_directory(&read_root, &relative)
    })
    .await
    .map_err(|_| ApiError::internal("Project directory failed"))?
    .map_err(ApiError::bad_request)?;
    if session_workspace(&state, &user.user_id, &input.session_id).await? != root
        || crate::files::resolve_existing_contained_path(&input.root)
            .ok()
            .as_deref()
            != Some(root.as_path())
    {
        return Err(ApiError::bad_request("Workspace changed; try again"));
    }
    let mut response = Json(json!({ "root": input.root, "path": input.path, "items": result.items, "truncated": result.truncated })).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace/files", get(files_route))
        .route("/api/workspace/files/search-content", get(content_route))
        .route("/api/workspace/files/read-content", get(line_preview_route))
        .route(
            "/api/workspace/files/list-directory",
            get(scoped_directory_route),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn line_preview_reads_bounded_context_and_rejects_unsafe_paths() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(
            root.path().join("src/file.txt"),
            "first\nNeedle here\nthird\n",
        )
        .unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("linked.txt"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("linked-dir")).unwrap();
        let canonical = root.path().canonicalize().unwrap();
        let preview = read_line_context(&canonical, "src/file.txt", 2, "needle").unwrap();
        assert_eq!(
            serde_json::to_value(preview).unwrap(),
            json!({"path":"src/file.txt","line":2,"totalLines":3,"lines":[{"line":1,"text":"first","truncated":false},{"line":2,"text":"Needle here","truncated":false},{"line":3,"text":"third","truncated":false}]})
        );
        for path in [
            "../secret.txt",
            "/etc/passwd",
            "linked.txt",
            "linked-dir/secret.txt",
            "src/../src/file.txt",
        ] {
            assert!(
                read_line_context(&canonical, path, 1, "needle").is_err(),
                "{path}"
            );
        }
        assert!(read_line_context(&canonical, "src/file.txt", 0, "needle").is_err());
        assert!(read_line_context(&canonical, "src/file.txt", 4, "needle").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn line_preview_recognizes_an_empty_file_without_inventing_lines() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("empty.txt"), b"").unwrap();
        let canonical = root.path().canonicalize().unwrap();
        let preview = read_line_context(&canonical, "empty.txt", 1, "").unwrap();
        assert_eq!(
            serde_json::to_value(preview).unwrap(),
            json!({"path":"empty.txt","line":1,"totalLines":0,"lines":[]})
        );
        assert!(read_line_context(&canonical, "empty.txt", 2, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn line_preview_rejects_binary_or_large_files_and_marks_long_lines() {
        let root = tempfile::tempdir().unwrap();
        let canonical = root.path().canonicalize().unwrap();
        std::fs::write(root.path().join("binary"), b"\0needle").unwrap();
        std::fs::write(
            root.path().join("large"),
            vec![b'x'; MAX_CONTENT_FILE_BYTES as usize + 1],
        )
        .unwrap();
        std::fs::write(
            root.path().join("long"),
            format!("{} needle", "x".repeat(2_000)),
        )
        .unwrap();
        std::fs::write(
            root.path().join("unicode"),
            format!("{} needle", "İ".repeat(1_000)),
        )
        .unwrap();
        assert!(read_line_context(&canonical, "binary", 1, "needle").is_err());
        assert!(read_line_context(&canonical, "large", 1, "needle").is_err());
        let preview = read_line_context(&canonical, "long", 1, "needle").unwrap();
        assert!(preview.lines[0].text.contains("needle"));
        assert!(preview.lines[0].truncated);
        assert!(preview.lines[0].text.chars().count() <= 500);
        assert!(read_line_context(&canonical, "unicode", 1, "needle")
            .unwrap()
            .lines[0]
            .text
            .contains("needle"));
    }

    #[test]
    fn ranks_name_matches_before_path_matches() {
        let files = [
            "src/app/login.rs",
            "docs/login-guide.md",
            "login/readme.md",
            "src/other.rs",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            rank_files(files, "login"),
            ["src/app/login.rs", "docs/login-guide.md", "login/readme.md"]
        );
    }

    #[test]
    fn walks_folders_without_git_and_skips_dependency_folders() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(dir.path().join("src/main.js"), "").unwrap();
        std::fs::write(dir.path().join("node_modules/pkg/index.js"), "").unwrap();
        assert_eq!(walked_files(dir.path()), ["src/main.js"]);
    }

    #[cfg(unix)]
    #[test]
    fn content_search_respects_workspace_links_binary_and_size_limits() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(
            root.path().join("src/app.rs"),
            "first\nNeedle in code\nthird",
        )
        .unwrap();
        std::fs::write(root.path().join("image.bin"), b"\0needle\0").unwrap();
        std::fs::write(
            root.path().join("large.txt"),
            format!("needle{}", "x".repeat(300_000)),
        )
        .unwrap();
        std::fs::write(outside.path().join("secret.txt"), "needle outside").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("link.txt"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("linked-dir")).unwrap();
        let result = search_contents(
            &root.path().canonicalize().unwrap(),
            "needle",
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            result.matches,
            vec![ContentMatch {
                path: "src/app.rs".into(),
                line: 2,
                text: "Needle in code".into()
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn content_search_bounds_results_and_honours_cancellation() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("matches.txt"), "match\n".repeat(150)).unwrap();
        let result = search_contents(
            &root.path().canonicalize().unwrap(),
            "match",
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((result.matches.len(), result.truncated), (100, true));
        let result = search_contents(
            &root.path().canonicalize().unwrap(),
            "match",
            &std::sync::atomic::AtomicBool::new(true),
        )
        .unwrap();
        assert!(result.matches.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn content_route_requires_auth_and_uses_only_the_owned_session_workspace() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        std::fs::write(
            workspace.path().join("owned.txt"),
            "needle in owned project",
        )
        .unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "content-search-test".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let session = state
            .structured_session_manager()
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("codex"),
                None,
                None,
            )
            .await
            .unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let uri = format!(
            "/api/workspace/files/search-content?sessionId={}&query=needle",
            session.id
        );
        for (owner, expected) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("other"), StatusCode::NOT_FOUND),
            (Some("owner"), StatusCode::OK),
        ] {
            let mut builder = Request::builder().uri(&uri);
            if let Some(owner) = owner {
                builder = builder.header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token("content-search-test", owner, owner)
                    ),
                );
            }
            let response = app
                .clone()
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if owner == Some("owner") {
                let body = axum::body::to_bytes(response.into_body(), 8192)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(
                    body["matches"],
                    json!([{"path":"owned.txt", "line":1, "text":"needle in owned project"}])
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn line_preview_route_requires_owned_session_and_matching_workspace() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        std::fs::write(workspace.path().join("owned.txt"), "first\nneedle\nlast").unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let alias = workspace.path().join("workspace-alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let other = workspace.path().join("other-workspace");
        std::fs::create_dir(&other).unwrap();
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                jwt_secret: "line-preview-test".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let session = state
            .structured_session_manager()
            .create_session("owner", root.to_str().unwrap(), Some("codex"), None, None)
            .await
            .unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        for (owner, root_arg, path, expected) in [
            (
                None,
                root.to_str().unwrap(),
                "owned.txt",
                StatusCode::UNAUTHORIZED,
            ),
            (
                Some("other"),
                root.to_str().unwrap(),
                "owned.txt",
                StatusCode::NOT_FOUND,
            ),
            (
                Some("owner"),
                "/wrong-workspace",
                "owned.txt",
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("owner"),
                other.to_str().unwrap(),
                "owned.txt",
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("owner"),
                root.to_str().unwrap(),
                "../owned.txt",
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("owner"),
                root.to_str().unwrap(),
                "owned.txt",
                StatusCode::OK,
            ),
            (
                Some("owner"),
                alias.to_str().unwrap(),
                "owned.txt",
                StatusCode::OK,
            ),
        ] {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("sessionId", &session.id)
                .append_pair("root", root_arg)
                .append_pair("path", path)
                .append_pair("line", "2")
                .append_pair("query", "needle")
                .finish();
            let mut builder =
                Request::builder().uri(format!("/api/workspace/files/read-content?{query}"));
            if let Some(owner) = owner {
                builder = builder.header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token("line-preview-test", owner, owner)
                    ),
                );
            }
            let response = app
                .clone()
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::OK {
                assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
                let body: Value = serde_json::from_slice(
                    &axum::body::to_bytes(response.into_body(), 8192)
                        .await
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(body["root"], root_arg);
                assert_eq!(body["line"], 2);
                assert_eq!(body["lines"][1]["text"], "needle");
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn scoped_directory_listing_does_not_follow_links_or_escape_the_project() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/app.js"), "fixture").unwrap();
        std::fs::write(workspace.path().join("src/.hidden"), "hidden").unwrap();
        std::fs::write(outside.path().join("secret"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("src/escape")).unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let result = list_scoped_directory(&root, "src").unwrap();
        assert_eq!(
            result
                .items
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec![".hidden", "app.js"]
        );
        assert!(!result.truncated);
        for invalid in [
            "../",
            "src/../",
            "src/escape",
            "/etc",
            "src//other",
            "src\\other",
        ] {
            assert!(list_scoped_directory(&root, invalid).is_err(), "{invalid}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scoped_directory_route_requires_owner_and_matching_workspace() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        std::fs::create_dir(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/app.js"), "fixture").unwrap();
        let root = workspace.path().canonicalize().unwrap();
        std::os::unix::fs::symlink("/", root.join("src/escape")).unwrap();
        let state = AppState::new_with_external_auth(
            terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                jwt_secret: "scoped-directory-test".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let session = state
            .structured_session_manager()
            .create_session("owner", root.to_str().unwrap(), Some("codex"), None, None)
            .await
            .unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        for (owner, root_arg, path, expected) in [
            (
                None,
                root.to_str().unwrap(),
                "src",
                StatusCode::UNAUTHORIZED,
            ),
            (
                Some("other"),
                root.to_str().unwrap(),
                "src",
                StatusCode::NOT_FOUND,
            ),
            (
                Some("owner"),
                "/wrong-workspace",
                "src",
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("owner"),
                root.to_str().unwrap(),
                "../",
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("owner"),
                root.to_str().unwrap(),
                "src/escape",
                StatusCode::BAD_REQUEST,
            ),
            (Some("owner"), root.to_str().unwrap(), "src", StatusCode::OK),
        ] {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("sessionId", &session.id)
                .append_pair("root", root_arg)
                .append_pair("path", path)
                .finish();
            let mut request =
                Request::builder().uri(format!("/api/workspace/files/list-directory?{query}"));
            if let Some(owner) = owner {
                request = request.header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token("scoped-directory-test", owner, owner)
                    ),
                );
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::OK {
                assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
                let body: Value = serde_json::from_slice(
                    &axum::body::to_bytes(response.into_body(), 8192)
                        .await
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(
                    body,
                    json!({"root": root_arg, "path":"src", "items":[{"name":"app.js", "type":"file", "size":7}], "truncated":false})
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "Requires the bundled browser runtime and frontend dependencies"]
    async fn project_file_reveal_browser_fixture() {
        use std::process::Stdio;
        use tokio::process::Command;
        use tokio::time::{sleep, timeout, Duration};

        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut contents =
            String::from("const first = true;\nconst target = true;\nconst last = true;\n");
        for line in 4..=35 {
            contents.push_str(&format!("// fixture line {line}\n"));
        }
        std::fs::write(workspace.join("sample.js"), contents).unwrap();
        std::fs::write(workspace.join("empty.txt"), b"").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            port,
            local_testing_login: true,
            ..Default::default()
        };
        let state = crate::state::AppState::new(config).unwrap();
        let server =
            tokio::spawn(async move { axum::serve(listener, crate::app(state)).await.unwrap() });
        let runtime = crate::browser_runtime::resolve().unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let vite_port = probe.local_addr().unwrap().port();
        drop(probe);
        let mut vite = Command::new(&runtime.node)
            .arg(root.join("frontend/node_modules/vite/bin/vite.js"))
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &vite_port.to_string(),
                "--strictPort",
            ])
            .current_dir(root.join("frontend"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("TMPDIR", data.path())
            .env(
                "TERMINAL_V4_API_PROXY_TARGET",
                format!("http://127.0.0.1:{port}"),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        timeout(Duration::from_secs(30), async {
            while tokio::net::TcpStream::connect(("127.0.0.1", vite_port))
                .await
                .is_err()
            {
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("Vite fixture did not start");
        let output = timeout(
            Duration::from_secs(120),
            Command::new(&runtime.node)
                .arg(root.join("frontend/node_modules/@playwright/test/cli.js"))
                .args([
                    "test",
                    "e2e/project-file-preview.spec.ts",
                    "e2e/project-content-search.spec.ts",
                    "--reporter=line",
                    "--workers=1",
                ])
                .arg(format!(
                    "--output={}",
                    data.path().join("playwright").display()
                ))
                .current_dir(root.join("frontend"))
                .env_clear()
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .env("TMPDIR", data.path())
                .env("BASE_URL", format!("http://127.0.0.1:{vite_port}"))
                .env("E2E_LOCAL_TESTING", "1")
                .env("E2E_PROJECT_ROOT", &workspace)
                .env("E2E_SEARCH_ROOT", &workspace)
                .env("E2E_LOCAL_BROWSER", &runtime.chromium)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("Browser fixture timed out")
        .unwrap();
        let _ = vite.kill().await;
        server.abort();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
