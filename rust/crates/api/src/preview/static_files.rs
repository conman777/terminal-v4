use std::path::{Component, Path, PathBuf};

use tokio::fs;

const MIME_TYPES: &[(&str, &str)] = &[
    (".html", "text/html"),
    (".htm", "text/html"),
    (".css", "text/css"),
    (".js", "application/javascript"),
    (".mjs", "application/javascript"),
    (".json", "application/json"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".svg", "image/svg+xml"),
    (".ico", "image/x-icon"),
    (".webp", "image/webp"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
    (".eot", "application/vnd.ms-fontobject"),
    (".otf", "font/otf"),
    (".mp3", "audio/mpeg"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".ogg", "audio/ogg"),
    (".wav", "audio/wav"),
    (".pdf", "application/pdf"),
    (".zip", "application/zip"),
    (".txt", "text/plain"),
    (".xml", "application/xml"),
    (".wasm", "application/wasm"),
    (".map", "application/json"),
];

#[derive(Debug)]
pub struct StaticPreviewFile {
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

pub async fn load_preview_file(
    base_path: &str,
    file: Option<&str>,
) -> Result<StaticPreviewFile, String> {
    let base_path = resolve_project_path(base_path).await?;
    let relative = file.unwrap_or("index.html");
    let requested_path = sanitize_relative_path(relative)?;
    let full_path = resolve_descendant_path(&base_path, &requested_path).await?;

    let metadata = fs::metadata(&full_path)
        .await
        .map_err(|_| "File not found".to_string())?;

    let resolved_file = if metadata.is_dir() {
        full_path.join("index.html")
    } else {
        full_path
    };

    let bytes = fs::read(&resolved_file)
        .await
        .map_err(|_| "File not found".to_string())?;
    Ok(StaticPreviewFile {
        content_type: content_type_for_path(&resolved_file),
        bytes,
    })
}

fn content_type_for_path(path: &Path) -> &'static str {
    let path = path.to_string_lossy().to_ascii_lowercase();
    MIME_TYPES
        .iter()
        .find_map(|(ext, content_type)| path.ends_with(ext).then_some(*content_type))
        .unwrap_or("application/octet-stream")
}

async fn resolve_project_path(path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    let resolved = canonicalize_if_exists(&requested).await?;
    let project_root = project_root();
    let project_root = canonicalize_if_exists(&project_root).await?;
    if is_within_base(&project_root, &resolved) {
        Ok(resolved)
    } else {
        Err("Access denied: base path is outside project root".to_string())
    }
}

async fn resolve_descendant_path(base: &Path, relative: &Path) -> Result<PathBuf, String> {
    let joined = base.join(relative);
    let resolved = canonicalize_if_exists(&joined).await?;
    if is_within_base(base, &resolved) {
        Ok(resolved)
    } else {
        Err("Access denied: resolved path is outside project root".to_string())
    }
}

fn sanitize_relative_path(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err("Access denied: file path must be relative".to_string());
    }

    for component in candidate.components() {
        if matches!(component, Component::ParentDir | Component::Prefix(_)) {
            return Err("Access denied: path traversal detected".to_string());
        }
    }

    Ok(candidate.to_path_buf())
}

async fn canonicalize_if_exists(path: &Path) -> Result<PathBuf, String> {
    match fs::canonicalize(path).await {
        Ok(path) => Ok(path),
        Err(_) => Ok(path.to_path_buf()),
    }
}

fn is_within_base(base: &Path, candidate: &Path) -> bool {
    let base = normalize_for_platform(base);
    let candidate = normalize_for_platform(candidate);

    candidate == base || candidate.starts_with(&base)
}

fn normalize_for_platform(path: &Path) -> PathBuf {
    let path = if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_ascii_lowercase())
    } else {
        path.to_path_buf()
    };

    if path.ends_with("") {
        path
    } else {
        path
    }
}

fn project_root() -> PathBuf {
    std::env::var("PREVIEW_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .expect("api crate should be nested under rust/crates/api")
                .to_path_buf()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_relative_path_rejects_parent_segments() {
        assert!(sanitize_relative_path("../secret.txt").is_err());
        assert!(sanitize_relative_path("nested/../../secret.txt").is_err());
    }

    #[test]
    fn sanitize_relative_path_allows_normal_paths() {
        assert_eq!(
            sanitize_relative_path("nested/index.html").expect("path should be valid"),
            PathBuf::from("nested/index.html")
        );
    }
}
