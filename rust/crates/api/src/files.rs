use std::path::{Component, Path, PathBuf};
use tokio::fs;

/// A file/directory entry returned by the list endpoint.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: Option<String>,
}

/// List directory contents, returning files and directories sorted
/// (directories first, then alphabetically).
pub async fn list_directory(path: &str) -> Result<Vec<FileEntry>, String> {
    let resolved = resolve_safe_path(path)?;
    let mut entries = Vec::new();

    let mut reader = fs::read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;

    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry: {e}"))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }

        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified = metadata.modified().ok().and_then(|t| {
            let datetime: time::OffsetDateTime = t.into();
            datetime
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        });

        entries.push(FileEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_directory: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Create a directory recursively.
pub async fn create_directory(path: &str) -> Result<(), String> {
    let resolved = resolve_safe_path(path)?;
    fs::create_dir_all(&resolved)
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))
}

/// Delete a file or directory recursively.
pub async fn delete_path(path: &str) -> Result<(), String> {
    let resolved = resolve_safe_path(path)?;
    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Path not found: {e}"))?;

    if metadata.is_dir() {
        fs::remove_dir_all(&resolved)
            .await
            .map_err(|e| format!("Failed to delete directory: {e}"))
    } else {
        fs::remove_file(&resolved)
            .await
            .map_err(|e| format!("Failed to delete file: {e}"))
    }
}

/// Rename/move a file or directory.
pub async fn rename_path(from: &str, to: &str) -> Result<(), String> {
    let from_resolved = resolve_safe_path(from)?;
    let to_resolved = resolve_safe_path(to)?;
    fs::rename(&from_resolved, &to_resolved)
        .await
        .map_err(|e| format!("Failed to rename: {e}"))
}

/// Write uploaded bytes to a file.
pub async fn write_file(path: &str, data: &[u8]) -> Result<(), String> {
    let resolved = resolve_safe_path(path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }
    fs::write(&resolved, data)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
}

/// Create a ZIP archive of a directory and return the bytes.
pub fn create_zip_archive(dir_path: &str) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let resolved = resolve_safe_path(dir_path)?;
    let buffer = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buffer);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(5));

    add_directory_to_zip(&mut zip, &resolved, &resolved, options)?;

    let buffer = zip
        .finish()
        .map_err(|e| format!("Failed to finish ZIP: {e}"))?;
    Ok(buffer.into_inner())
}

#[allow(clippy::write_with_newline)]
fn add_directory_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    base: &Path,
    current: &Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(current).map_err(|e| format!("Failed to read directory: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common large directories
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }

        let relative = path
            .strip_prefix(base)
            .map_err(|e| format!("Path prefix error: {e}"))?
            .to_string_lossy()
            .to_string();

        if path.is_dir() {
            add_directory_to_zip(zip, base, &path, options)?;
        } else {
            let data =
                std::fs::read(&path).map_err(|e| format!("Failed to read file {relative}: {e}"))?;
            zip.start_file(&relative, options)
                .map_err(|e| format!("Failed to add {relative} to ZIP: {e}"))?;
            use std::io::Write;
            zip.write_all(&data)
                .map_err(|e| format!("Failed to write {relative} to ZIP: {e}"))?;
        }
    }
    Ok(())
}

/// Extract a ZIP archive to a target directory with Zip Slip validation.
pub async fn extract_zip(zip_path: &str, target_dir: &str) -> Result<usize, String> {
    let zip_resolved = resolve_safe_path(zip_path)?;
    let target_resolved = resolve_safe_path(target_dir)?;

    // Run ZIP extraction in blocking task since zip crate is sync
    let count = tokio::task::spawn_blocking(move || {
        let file =
            std::fs::File::open(&zip_resolved).map_err(|e| format!("Failed to open ZIP: {e}"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP: {e}"))?;

        let mut count = 0usize;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read ZIP entry: {e}"))?;

            let name = entry.name().to_string();
            let out_path = safe_zip_output_path(&target_resolved, &name)?;

            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Failed to create directory: {e}"))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent: {e}"))?;
                }
                let mut outfile = std::fs::File::create(&out_path)
                    .map_err(|e| format!("Failed to create file: {e}"))?;
                std::io::copy(&mut entry, &mut outfile)
                    .map_err(|e| format!("Failed to extract file: {e}"))?;
                count += 1;
            }
        }

        Ok::<usize, String>(count)
    })
    .await
    .map_err(|e| format!("ZIP extraction task failed: {e}"))??;

    Ok(count)
}

fn safe_zip_output_path(target_dir: &Path, entry_name: &str) -> Result<PathBuf, String> {
    let mut relative_path = PathBuf::new();

    for component in Path::new(entry_name).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative_path.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Zip Slip detected: {entry_name} escapes target directory"
                ));
            }
        }
    }

    if relative_path.as_os_str().is_empty() {
        return Err(format!("Invalid ZIP entry path: {entry_name}"));
    }

    Ok(target_dir.join(relative_path))
}

/// Detect image MIME type from file magic bytes.
pub fn detect_image_mime(data: &[u8]) -> Option<&'static str> {
    if data.len() < 4 {
        return None;
    }

    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF8") {
        Some("image/gif")
    } else if data.starts_with(b"RIFF") && data.len() >= 12 && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.len() >= 12 && &data[4..8] == b"ftyp" {
        // HEIC/HEIF/AVIF
        let subtype = &data[8..12];
        if subtype == b"heic" || subtype == b"heix" {
            Some("image/heic")
        } else if subtype == b"avif" || subtype == b"avis" {
            Some("image/avif")
        } else {
            Some("image/heif")
        }
    } else if data.starts_with(&[0x42, 0x4D]) {
        Some("image/bmp")
    } else {
        None
    }
}

/// Resolve and validate a path, preventing directory traversal.
fn resolve_safe_path(path: &str) -> Result<PathBuf, String> {
    let expanded = if path.starts_with('~') {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "Cannot resolve home directory".to_string())?;
        PathBuf::from(home).join(path.strip_prefix("~/").unwrap_or(&path[1..]))
    } else {
        PathBuf::from(path)
    };

    // Check for path traversal
    let path_str = expanded.to_string_lossy();
    if path_str.contains("..") {
        return Err("Path traversal not allowed".to_string());
    }

    Ok(expanded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn resolve_safe_path_rejects_traversal() {
        assert!(resolve_safe_path("/etc/../passwd").is_err());
        assert!(resolve_safe_path("../../../etc/passwd").is_err());
    }

    #[test]
    fn resolve_safe_path_allows_normal_paths() {
        assert!(resolve_safe_path("/tmp/test").is_ok());
        assert!(resolve_safe_path("C:\\Users\\test").is_ok());
    }

    #[test]
    fn detect_png() {
        let data = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(detect_image_mime(&data), Some("image/png"));
    }

    #[test]
    fn detect_jpeg() {
        let data = [0xFF, 0xD8, 0xFF, 0xE0];
        assert_eq!(detect_image_mime(&data), Some("image/jpeg"));
    }

    #[test]
    fn detect_unknown() {
        let data = [0x00, 0x01, 0x02, 0x03];
        assert_eq!(detect_image_mime(&data), None);
    }

    #[test]
    fn mask_detects_webp() {
        let mut data = vec![0u8; 12];
        data[..4].copy_from_slice(b"RIFF");
        data[8..12].copy_from_slice(b"WEBP");
        assert_eq!(detect_image_mime(&data), Some("image/webp"));
    }

    #[test]
    fn safe_zip_output_path_rejects_escape_paths() {
        let target = Path::new("/tmp/target");

        assert!(safe_zip_output_path(target, "../escape.txt").is_err());
        assert!(safe_zip_output_path(target, "/escape.txt").is_err());
    }

    #[test]
    fn safe_zip_output_path_allows_nested_relative_paths() {
        let target = Path::new("/tmp/target");
        let out_path =
            safe_zip_output_path(target, "nested/file.txt").expect("path should be valid");

        assert_eq!(out_path, target.join("nested").join("file.txt"));
    }

    #[tokio::test]
    async fn extract_zip_rejects_escape_entries_without_side_effects() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let zip_path = temp_dir.path().join("archive.zip");
        let target_dir = temp_dir.path().join("target");
        std::fs::create_dir_all(&target_dir).expect("target dir should exist");

        let zip_file = std::fs::File::create(&zip_path).expect("zip should create");
        let mut writer = zip::ZipWriter::new(zip_file);
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("../outside/escape.txt", options)
            .expect("zip entry should create");
        writer.write_all(b"bad").expect("zip entry should write");
        writer.finish().expect("zip should finish");

        let result = extract_zip(
            zip_path.to_str().expect("zip path should be utf-8"),
            target_dir.to_str().expect("target path should be utf-8"),
        )
        .await;

        assert!(result.is_err());
        assert!(!temp_dir.path().join("outside").exists());
    }
}
