use serde_json::{json, Value};
use std::path::Path;
use tokio::fs;

const MAX_FILE_SIZE: u64 = 1_024 * 1_024; // 1MB
const MAX_TOTAL_SIZE: u64 = 50 * 1_024 * 1_024; // 50MB

const EXCLUDE_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".nuxt",
    ".output", "coverage", ".cache", ".parcel-cache", ".turbo", "__pycache__",
    ".pytest_cache", ".venv", "venv", "target",
];

const EXCLUDE_FILES: &[&str] = &[
    ".env.local", ".DS_Store", "Thumbs.db",
];

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "woff", "woff2", "ttf", "eot",
    "mp3", "mp4", "wav", "ogg", "zip", "tar", "gz", "pdf", "exe", "dll",
    "so", "dylib", "ico", "svg",
];

/// Build a WebContainer-compatible file tree for a project directory.
pub async fn get_file_tree(path: &str) -> Result<Value, String> {
    let root = Path::new(path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    // Require package.json
    if !root.join("package.json").exists() {
        return Err("Not a Node.js project (no package.json)".to_string());
    }

    let mut total_size: u64 = 0;
    let files = build_tree(root, root, &mut total_size).await?;

    Ok(json!({
        "files": files,
        "stats": {
            "totalSize": total_size,
        }
    }))
}

async fn build_tree(
    base: &Path,
    current: &Path,
    total_size: &mut u64,
) -> Result<Value, String> {
    let mut entries = serde_json::Map::new();
    let mut reader = fs::read_dir(current)
        .await
        .map_err(|e| format!("Failed to read {}: {e}", current.display()))?;

    while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            if EXCLUDE_DIRS.contains(&name.as_str()) {
                continue;
            }
            // Skip hidden dirs except a few
            if name.starts_with('.') && name != ".env" && name != ".gitignore" && name != ".npmrc" {
                continue;
            }
            let subtree = Box::pin(build_tree(base, &path, total_size)).await?;
            entries.insert(name, json!({ "directory": subtree }));
        } else {
            // Skip excluded files
            if EXCLUDE_FILES.contains(&name.as_str()) {
                continue;
            }
            if name.starts_with('.') && name != ".env" && name != ".gitignore" && name != ".npmrc" {
                continue;
            }
            // Skip files matching exclusion patterns
            if name.ends_with(".log") || name.ends_with(".lock") {
                continue;
            }
            if name.ends_with(".env.local") || name.contains(".env.") && name.ends_with(".local") {
                continue;
            }

            // Skip binary files
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if BINARY_EXTENSIONS.contains(&ext) {
                continue;
            }

            // Skip large files
            if metadata.len() > MAX_FILE_SIZE {
                continue;
            }

            *total_size += metadata.len();
            if *total_size > MAX_TOTAL_SIZE {
                return Err("Project exceeds 50MB limit".to_string());
            }

            match fs::read_to_string(&path).await {
                Ok(contents) => {
                    entries.insert(name, json!({ "file": { "contents": contents } }));
                }
                Err(_) => continue, // Skip unreadable files
            }
        }
    }

    Ok(Value::Object(entries))
}
