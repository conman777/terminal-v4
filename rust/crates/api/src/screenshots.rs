use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

fn screenshots_dir(owner: &str) -> PathBuf {
    let dir = std::env::var("SCREENSHOT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".terminal-v4-screenshots"))
                .unwrap_or_else(|_| PathBuf::from(".terminal-v4-screenshots"))
        });
    let dir = dir
        .join("owners")
        .join(hex::encode(Sha256::digest(owner.as_bytes())));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn recordings_dir(owner: &str) -> PathBuf {
    let dir = std::env::var("RECORDING_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".terminal-v4-recordings"))
                .unwrap_or_else(|_| PathBuf::from(".terminal-v4-recordings"))
        });
    let dir = dir
        .join("owners")
        .join(hex::encode(Sha256::digest(owner.as_bytes())));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

static ACTIVE_RECORDINGS: LazyLock<Mutex<HashMap<(String, String), RecordingSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct RecordingSession {
    tree: crate::process_tree::ProcessTree,
    child: tokio::process::Child,
    output_dir: PathBuf,
    started_at: i64,
}

/// Take a screenshot of a preview URL using the Playwright browser API.
pub async fn take_screenshot(
    owner: &str,
    url: &str,
    selector: Option<&str>,
    full_page: bool,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<ScreenshotResult, String> {
    let filename = format!("{}.png", Uuid::new_v4());
    let output_path = screenshots_dir(owner).join(&filename);
    let viewport_width = width.unwrap_or(1280);
    let viewport_height = height.unwrap_or(720);

    validate_viewport(viewport_width, viewport_height)?;

    let mut command = Command::new(recording_node_binary());
    command
        .arg("-e")
        .arg(include_str!("preview/screenshot.js"))
        .env("TERMINAL_V4_SCREENSHOT_URL", url)
        .env("TERMINAL_V4_SCREENSHOT_OUTPUT", &output_path)
        .env("TERMINAL_V4_SCREENSHOT_SELECTOR", selector.unwrap_or(""))
        .env("TERMINAL_V4_SCREENSHOT_FULL_PAGE", full_page.to_string())
        .env("TERMINAL_V4_SCREENSHOT_WIDTH", viewport_width.to_string())
        .env("TERMINAL_V4_SCREENSHOT_HEIGHT", viewport_height.to_string())
        .current_dir(playwright_workdir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (child, tree) = spawn_capture_helper(&mut command)?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to run playwright: {e}"))?;
    drop(tree);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Screenshot failed: {stderr}"));
    }

    Ok(ScreenshotResult {
        filename,
        path: output_path.to_string_lossy().to_string(),
    })
}

pub async fn start_recording(
    owner: &str,
    url: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<RecordingStartResult, String> {
    start_recording_with_timeout(
        owner,
        url,
        width,
        height,
        std::time::Duration::from_secs(35),
    )
    .await
}

async fn start_recording_with_timeout(
    owner: &str,
    url: &str,
    width: Option<u32>,
    height: Option<u32>,
    ready_timeout: std::time::Duration,
) -> Result<RecordingStartResult, String> {
    let viewport_width = width.unwrap_or(1280);
    let viewport_height = height.unwrap_or(720);
    validate_viewport(viewport_width, viewport_height)?;

    let recording_id = format!("recording-{}", Uuid::new_v4());
    let output_dir = recordings_dir(owner).join(&recording_id);
    fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| format!("Failed to create recording directory: {e}"))?;

    let mut command = Command::new(recording_node_binary());
    command
        .arg("-e")
        .arg(recording_node_script())
        .env("TERMINAL_V4_RECORDING_URL", url)
        .env(
            "TERMINAL_V4_RECORDING_OUTPUT_DIR",
            output_dir.to_string_lossy().to_string(),
        )
        .env("TERMINAL_V4_RECORDING_WIDTH", viewport_width.to_string())
        .env("TERMINAL_V4_RECORDING_HEIGHT", viewport_height.to_string())
        .current_dir(playwright_workdir())
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (mut child, tree) = spawn_capture_helper(&mut command)?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Recording helper stdout unavailable".to_string())?;
    let mut ready_reader = BufReader::new(stdout).lines();

    let ready = match tokio::time::timeout(ready_timeout, ready_reader.next_line()).await {
        Ok(Ok(line)) => line,
        result => {
            let _ = tree.stop(std::time::Duration::from_millis(150)).await;
            let _ = tree.wait(&mut child).await;
            return Err(match result {
                Err(_) => "Recording helper timed out before becoming ready".to_string(),
                Ok(Err(error)) => format!("Failed to read recording helper output: {error}"),
                _ => unreachable!(),
            });
        }
    };

    if ready.as_deref() != Some("READY") {
        let _ = tree.stop(std::time::Duration::from_millis(150)).await;
        let status = tree
            .wait(&mut child)
            .await
            .map_err(|e| format!("Recording helper exited unexpectedly: {e}"))?;
        let stderr = read_child_stderr(&mut child).await;
        return Err(format!(
            "Recording helper failed to start (status: {status}){}",
            stderr
                .map(|value| format!(", stderr: {value}"))
                .unwrap_or_default()
        ));
    }

    let started = now_millis();
    ACTIVE_RECORDINGS.lock().await.insert(
        (owner.into(), recording_id.clone()),
        RecordingSession {
            tree,
            child,
            output_dir,
            started_at: started,
        },
    );

    Ok(RecordingStartResult {
        recording_id,
        started,
    })
}

pub async fn stop_recording(
    owner: &str,
    recording_id: &str,
) -> Result<Option<RecordingStopResult>, String> {
    let Some(mut session) = ACTIVE_RECORDINGS
        .lock()
        .await
        .remove(&(owner.into(), recording_id.into()))
    else {
        return Ok(None);
    };
    let mut stdin = session
        .child
        .stdin
        .take()
        .ok_or("Recording helper control pipe unavailable")?;
    stdin
        .write_all(b"STOP\n")
        .await
        .map_err(|error| format!("Failed to request recording shutdown: {error}"))?;
    drop(stdin);
    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        session.tree.wait(&mut session.child),
    )
    .await
    {
        Ok(status) => {
            status.map_err(|error| format!("Failed to stop recording helper: {error}"))?
        }
        Err(_) => {
            let _ = session
                .tree
                .stop(std::time::Duration::from_millis(150))
                .await;
            let _ = session.tree.wait(&mut session.child).await;
            return Err("Recording helper timed out during shutdown".into());
        }
    };
    if !status.success() {
        let stderr = read_child_stderr(&mut session.child).await;
        return Err(format!(
            "Recording helper exited unsuccessfully{}",
            stderr.map(|value| format!(": {value}")).unwrap_or_default()
        ));
    }

    let path = find_recording_file(&session.output_dir).await?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Recording filename missing".to_string())?
        .to_string();

    Ok(Some(RecordingStopResult {
        filename,
        path: path.to_string_lossy().to_string(),
        duration: now_millis().saturating_sub(session.started_at),
    }))
}

/// List all saved screenshots.
pub async fn list_screenshots(owner: &str) -> Result<Vec<ScreenshotInfo>, String> {
    let dir = screenshots_dir(owner);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut screenshots = Vec::new();
    let mut reader = fs::read_dir(&dir).await.map_err(|e| e.to_string())?;

    while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".png") {
            continue;
        }
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        screenshots.push(ScreenshotInfo {
            filename: name,
            size: metadata.len(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| {
                    let dt: time::OffsetDateTime = t.into();
                    dt.format(&time::format_description::well_known::Rfc3339)
                        .unwrap_or_default()
                })
                .unwrap_or_default(),
        });
    }

    screenshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(screenshots)
}

/// Get a screenshot file's bytes.
pub async fn get_screenshot(owner: &str, filename: &str) -> Result<Vec<u8>, String> {
    validate_capture_filename(filename)?;
    let path = screenshots_dir(owner).join(filename);
    fs::read(&path)
        .await
        .map_err(|e| format!("Screenshot not found: {e}"))
}

/// Delete a screenshot.
pub async fn delete_screenshot(owner: &str, filename: &str) -> Result<bool, String> {
    validate_capture_filename(filename)?;
    let path = screenshots_dir(owner).join(filename);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path)
        .await
        .map_err(|e| format!("Failed to delete: {e}"))?;
    Ok(true)
}

fn spawn_capture_helper(
    command: &mut Command,
) -> Result<(tokio::process::Child, crate::process_tree::ProcessTree), String> {
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start capture helper: {error}"))?;
    #[cfg(unix)]
    let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child);
    #[cfg(not(unix))]
    let tree = crate::process_tree::ProcessTree::attach(&child);
    Ok((
        child,
        tree.map_err(|error| format!("Failed to track capture helper: {error}"))?,
    ))
}

fn validate_capture_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains(['/', '\\'])
        || !filename.ends_with(".png")
        || filename == ".png"
    {
        return Err("Invalid screenshot filename".into());
    }
    Ok(())
}

fn validate_viewport(width: u32, height: u32) -> Result<(), String> {
    if width < 320 || width > 3840 {
        return Err(format!("Width {width} out of range 320-3840"));
    }
    if height < 240 || height > 2160 {
        return Err(format!("Height {height} out of range 240-2160"));
    }
    Ok(())
}

fn recording_node_binary() -> String {
    std::env::var("PLAYWRIGHT_NODE_BIN").unwrap_or_else(|_| "node".to_string())
}

fn playwright_workdir() -> PathBuf {
    let root = std::env::var_os("TERMINAL_V4_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .expect("api crate should be nested under rust/crates/api")
                .to_path_buf()
        });
    playwright_workdir_from_root(&root)
}

fn playwright_workdir_from_root(root: &Path) -> PathBuf {
    if root.join("node_modules/playwright/package.json").is_file() {
        root.to_path_buf()
    } else if root
        .join("backend/node_modules/playwright/package.json")
        .is_file()
    {
        root.join("backend")
    } else {
        root.to_path_buf()
    }
}

fn recording_node_script() -> &'static str {
    r#"
const fs = require('fs');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  throw new Error('Playwright runtime unavailable. Run npm install in the Terminal V4 runtime directory.');
}

async function main() {
  const url = process.env.TERMINAL_V4_RECORDING_URL;
  const outputDir = process.env.TERMINAL_V4_RECORDING_OUTPUT_DIR;
  const width = Number.parseInt(process.env.TERMINAL_V4_RECORDING_WIDTH || '1280', 10);
  const height = Number.parseInt(process.env.TERMINAL_V4_RECORDING_HEIGHT || '720', 10);

  if (!url || !outputDir) {
    throw new Error('Missing recording configuration');
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: {
      dir: outputDir,
      size: { width, height },
    },
    deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await page.close();
    } catch {}
    try {
      await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
    process.exit(0);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { if (chunk.includes('STOP')) shutdown(); });
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  if (String(error).includes("Executable doesn't exist")) console.error('Install Chromium with npx playwright install chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium browser.');
  process.exit(1);
});
"#
}

async fn find_recording_file(output_dir: &Path) -> Result<PathBuf, String> {
    let mut reader = fs::read_dir(output_dir)
        .await
        .map_err(|e| format!("Failed to read recording directory: {e}"))?;
    let mut candidate = None;

    while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        let is_webm = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("webm"))
            .unwrap_or(false);
        if is_webm {
            candidate = Some(path);
            break;
        }
    }

    candidate.ok_or_else(|| "Recording output file not found".to_string())
}

async fn read_child_stderr(child: &mut tokio::process::Child) -> Option<String> {
    let stderr = child.stderr.take()?;
    let mut reader = BufReader::new(stderr);
    let mut output = String::new();
    if reader.read_line(&mut output).await.ok()? > 0 {
        Some(output.trim().to_string())
    } else {
        None
    }
}

fn now_millis() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .expect("timestamp should fit in i64")
}

#[derive(Debug, serde::Serialize)]
pub struct ScreenshotResult {
    pub filename: String,
    pub path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo {
    pub filename: String,
    pub size: u64,
    pub created_at: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartResult {
    pub recording_id: String,
    pub started: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStopResult {
    pub filename: String,
    pub path: String,
    pub duration: i64,
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;

    static ENV_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

    #[test]
    fn playwright_runtime_uses_packaged_root_or_legacy_backend_without_source_checkout() {
        let runtime = tempdir().unwrap();
        let backend = runtime.path().join("backend");
        std::fs::create_dir_all(backend.join("node_modules/playwright")).unwrap();
        std::fs::write(backend.join("node_modules/playwright/package.json"), "{}").unwrap();
        assert_eq!(playwright_workdir_from_root(runtime.path()), backend);
        std::fs::create_dir_all(runtime.path().join("node_modules/playwright")).unwrap();
        std::fs::write(
            runtime.path().join("node_modules/playwright/package.json"),
            "{}",
        )
        .unwrap();
        assert_eq!(playwright_workdir_from_root(runtime.path()), runtime.path());
    }

    #[tokio::test]
    async fn start_and_stop_recording_uses_configured_node_binary() {
        let _env_guard = ENV_LOCK.lock().expect("env lock should acquire");
        let temp = tempdir().expect("temp dir should create");
        let bin_path = temp.path().join("fake-node");
        let recordings_path = temp.path().join("recordings");

        std::fs::write(
            &bin_path,
            r#"#!/bin/sh
mkdir -p "$TERMINAL_V4_RECORDING_OUTPUT_DIR"
echo READY
read command
touch "$TERMINAL_V4_RECORDING_OUTPUT_DIR/fake.webm"
exit 0
"#,
        )
        .expect("fake node script should write");
        let mut permissions = std::fs::metadata(&bin_path)
            .expect("script metadata should read")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&bin_path, permissions).expect("script permissions should update");

        let previous_node_bin = std::env::var("PLAYWRIGHT_NODE_BIN").ok();
        let previous_recording_dir = std::env::var("RECORDING_DIR").ok();

        unsafe {
            std::env::set_var("PLAYWRIGHT_NODE_BIN", &bin_path);
            std::env::set_var("RECORDING_DIR", &recordings_path);
        }

        let recording = start_recording("owner-a", "http://localhost:5173", Some(800), Some(600))
            .await
            .expect("recording should start");
        assert!(recording.recording_id.starts_with("recording-"));

        assert!(stop_recording("owner-b", &recording.recording_id)
            .await
            .unwrap()
            .is_none());
        let stopped = stop_recording("owner-a", &recording.recording_id)
            .await
            .expect("recording should stop")
            .expect("recording should exist");
        assert_eq!(stopped.filename, "fake.webm");
        assert!(Path::new(&stopped.path).exists());
        assert!(stopped.duration >= 0);

        match previous_node_bin {
            Some(value) => unsafe { std::env::set_var("PLAYWRIGHT_NODE_BIN", value) },
            None => unsafe { std::env::remove_var("PLAYWRIGHT_NODE_BIN") },
        }
        match previous_recording_dir {
            Some(value) => unsafe { std::env::set_var("RECORDING_DIR", value) },
            None => unsafe { std::env::remove_var("RECORDING_DIR") },
        }
    }

    #[tokio::test]
    async fn captures_are_scoped_and_filename_is_exact() {
        let _guard = ENV_LOCK.lock().unwrap();
        let temp = tempdir().unwrap();
        let previous = std::env::var_os("SCREENSHOT_DIR");
        unsafe {
            std::env::set_var("SCREENSHOT_DIR", temp.path());
        }
        let file = "capture.png";
        std::fs::write(screenshots_dir("a").join(file), b"synthetic-image").unwrap();
        let owner_list = list_screenshots("a").await.unwrap();
        let other_list = list_screenshots("b").await.unwrap();
        let other_read = get_screenshot("b", file).await;
        let other_delete = delete_screenshot("b", file).await.unwrap();
        let owner_read = get_screenshot("a", file).await.unwrap();
        let alias = get_screenshot("a", "folder/capture.png").await;
        let owner_delete = delete_screenshot("a", file).await.unwrap();
        unsafe {
            match previous {
                Some(value) => std::env::set_var("SCREENSHOT_DIR", value),
                None => std::env::remove_var("SCREENSHOT_DIR"),
            }
        }
        assert_eq!(
            owner_list
                .iter()
                .map(|entry| entry.filename.as_str())
                .collect::<Vec<_>>(),
            vec![file]
        );
        assert!(other_list.is_empty() && other_read.is_err() && !other_delete);
        assert_eq!(owner_read, b"synthetic-image");
        assert!(alias.is_err() && owner_delete);
    }

    #[tokio::test]
    async fn startup_timeout_and_cancellation_reap_helper() {
        let _guard = ENV_LOCK.lock().unwrap();
        let temp = tempdir().unwrap();
        let helper = temp.path().join("never-ready");
        let pid_file = temp.path().join("helper.pid");
        std::fs::write(&helper,format!("#!/usr/bin/env python3\nimport os,sys,time,subprocess,pathlib\nchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)'])\npidfile=pathlib.Path({:?})\ntmp=pidfile.with_suffix('.tmp')\ntmp.write_text(str(os.getpid())+' '+str(child.pid))\ntmp.replace(pidfile)\ntime.sleep(90)\n",pid_file.to_str().unwrap())).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let previous_node = std::env::var_os("PLAYWRIGHT_NODE_BIN");
        let previous_recordings = std::env::var_os("RECORDING_DIR");
        unsafe {
            std::env::set_var("PLAYWRIGHT_NODE_BIN", helper);
            std::env::set_var("RECORDING_DIR", temp.path().join("recordings"));
        }
        let result = start_recording_with_timeout(
            "a",
            "http://127.0.0.1:1",
            None,
            None,
            std::time::Duration::from_secs(3),
        )
        .await;
        let timeout_pids: Vec<i32> = std::fs::read_to_string(&pid_file)
            .unwrap()
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect();
        for _ in 0..100 {
            if timeout_pids
                .iter()
                .all(|pid| unsafe { libc::kill(*pid, 0) } != 0)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let timed_out_dead = timeout_pids
            .iter()
            .all(|pid| unsafe { libc::kill(*pid, 0) } != 0);
        std::fs::remove_file(&pid_file).unwrap();
        let task =
            tokio::spawn(async { start_recording("a", "http://127.0.0.1:1", None, None).await });
        for _ in 0..100 {
            if pid_file.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let cancelled_pids: Vec<i32> = std::fs::read_to_string(&pid_file)
            .unwrap()
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect();
        task.abort();
        let _ = task.await;
        for _ in 0..100 {
            if cancelled_pids
                .iter()
                .all(|pid| unsafe { libc::kill(*pid, 0) } != 0)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let cancelled_dead = cancelled_pids
            .iter()
            .all(|pid| unsafe { libc::kill(*pid, 0) } != 0);
        unsafe {
            match previous_node {
                Some(value) => std::env::set_var("PLAYWRIGHT_NODE_BIN", value),
                None => std::env::remove_var("PLAYWRIGHT_NODE_BIN"),
            }
            match previous_recordings {
                Some(value) => std::env::set_var("RECORDING_DIR", value),
                None => std::env::remove_var("RECORDING_DIR"),
            }
        }
        assert!(result.unwrap_err().contains("timed out"));
        assert!(
            timed_out_dead && cancelled_dead,
            "helper must exit after timeout and cancellation"
        );
    }
}
