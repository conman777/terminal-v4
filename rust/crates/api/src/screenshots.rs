use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::process::Command;
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
