use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

fn screenshots_dir() -> PathBuf {
    let dir = std::env::var("SCREENSHOT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".terminal-v4-screenshots"))
                .unwrap_or_else(|_| PathBuf::from(".terminal-v4-screenshots"))
        });
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn recordings_dir() -> PathBuf {
    let dir = std::env::var("RECORDING_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".terminal-v4-recordings"))
                .unwrap_or_else(|_| PathBuf::from(".terminal-v4-recordings"))
        });
    let _ = std::fs::create_dir_all(&dir);
    dir
}

static ACTIVE_RECORDINGS: LazyLock<Mutex<HashMap<String, RecordingSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct RecordingSession {
    child: tokio::process::Child,
    output_dir: PathBuf,
    started_at: i64,
}

/// Take a screenshot of a preview URL using Playwright CLI.
pub async fn take_screenshot(
    url: &str,
    selector: Option<&str>,
    full_page: bool,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<ScreenshotResult, String> {
    let filename = format!("{}.png", Uuid::new_v4());
    let output_path = screenshots_dir().join(&filename);
    let viewport_width = width.unwrap_or(1280);
    let viewport_height = height.unwrap_or(720);

    validate_viewport(viewport_width, viewport_height)?;

    // Use Playwright CLI to take screenshot
    let mut args = vec![
        "screenshot".to_string(),
        url.to_string(),
        output_path.to_string_lossy().to_string(),
        format!("--viewport-size={viewport_width},{viewport_height}"),
    ];

    if full_page {
        args.push("--full-page".to_string());
    }

    if let Some(sel) = selector {
        args.push(format!("--selector={sel}"));
    }

    let output = Command::new("npx")
        .args(["playwright", "--"])
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to run playwright: {e}"))?;

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
    url: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<RecordingStartResult, String> {
    let viewport_width = width.unwrap_or(1280);
    let viewport_height = height.unwrap_or(720);
    validate_viewport(viewport_width, viewport_height)?;

    let recording_id = format!("recording-{}", now_millis());
    let output_dir = recordings_dir().join(&recording_id);
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start recording helper: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Recording helper stdout unavailable".to_string())?;
    let mut ready_reader = BufReader::new(stdout).lines();

    let ready = tokio::time::timeout(std::time::Duration::from_secs(35), ready_reader.next_line())
        .await
        .map_err(|_| "Recording helper timed out before becoming ready".to_string())?
        .map_err(|e| format!("Failed to read recording helper output: {e}"))?;

    if ready.as_deref() != Some("READY") {
        let status = child
            .wait()
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
        recording_id.clone(),
        RecordingSession {
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

pub async fn stop_recording(recording_id: &str) -> Result<Option<RecordingStopResult>, String> {
    let Some(mut session) = ACTIVE_RECORDINGS.lock().await.remove(recording_id) else {
        return Ok(None);
    };

    if cfg!(windows) {
        let _ = session.child.start_kill();
    } else if let Some(child_id) = session.child.id() {
        let _ = Command::new("kill")
            .args(["-TERM", &child_id.to_string()])
            .output()
            .await;
    } else {
        let _ = session.child.start_kill();
    }

    let status = session
        .child
        .wait()
        .await
        .map_err(|e| format!("Failed to stop recording helper: {e}"))?;
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
pub async fn list_screenshots() -> Result<Vec<ScreenshotInfo>, String> {
    let dir = screenshots_dir();
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
pub async fn get_screenshot(filename: &str) -> Result<Vec<u8>, String> {
    let sanitized = Path::new(filename)
        .file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy()
        .to_string();

    if sanitized.contains("..") {
        return Err("Invalid filename".to_string());
    }

    let path = screenshots_dir().join(&sanitized);
    fs::read(&path)
        .await
        .map_err(|e| format!("Screenshot not found: {e}"))
}

/// Delete a screenshot.
pub async fn delete_screenshot(filename: &str) -> Result<bool, String> {
    let sanitized = Path::new(filename)
        .file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy()
        .to_string();

    let path = screenshots_dir().join(&sanitized);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path)
        .await
        .map_err(|e| format!("Failed to delete: {e}"))?;
    Ok(true)
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("api crate should be nested under rust/crates/api")
        .join("backend")
}

fn recording_node_script() -> &'static str {
    r#"
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;

    static ENV_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

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
trap 'touch "$TERMINAL_V4_RECORDING_OUTPUT_DIR/fake.webm"; exit 0' TERM INT HUP
echo READY
while true; do
  sleep 1
done
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

        let recording = start_recording("http://localhost:5173", Some(800), Some(600))
            .await
            .expect("recording should start");
        assert!(recording.recording_id.starts_with("recording-"));

        let stopped = stop_recording(&recording.recording_id)
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
}
