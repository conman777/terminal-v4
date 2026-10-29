use std::collections::HashSet;
use std::io::{Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tokio::fs;

const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_ARCHIVE_DEPTH: usize = 128;

const ALLOWED_FILE_ROOTS_ENV: &str = "TERMINAL_V4_ALLOWED_FILE_ROOTS";
const OUTSIDE_ROOTS: &str = "Access denied: path is outside allowed roots. Files can open your home folder, the server folder, and folders listed in TERMINAL_V4_ALLOWED_FILE_ROOTS.";

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
    let resolved = resolve_existing_contained_path(path)?;
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
    let resolved = resolve_contained_path_for_write(path)?;
    fs::create_dir_all(&resolved)
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))
}

/// Delete a file or directory recursively.
pub async fn delete_path(path: &str) -> Result<(), String> {
    let requested = resolve_safe_path(path)?;
    let name = requested
        .file_name()
        .ok_or("Cannot delete a filesystem root")?;
    let parent = requested
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = resolve_existing_contained_path(parent.to_str().ok_or("Invalid parent path")?)?;
    let resolved = parent.join(name);
    let metadata = fs::symlink_metadata(&resolved)
        .await
        .map_err(|e| format!("Path not found: {e}"))?;

    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if metadata.file_type().is_symlink_dir() {
            return fs::remove_dir(&resolved)
                .await
                .map_err(|e| format!("Failed to delete link: {e}"));
        }
    }

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

/// Rename an entry without following its final symlink or replacing a destination.
pub async fn rename_path(from: &str, to: &str) -> Result<(), String> {
    let from = from.to_owned();
    let to = to.to_owned();
    tokio::task::spawn_blocking(move || {
        let from = rename_entry_path(&from)?;
        let to = rename_entry_path(&to)?;
        std::fs::symlink_metadata(&from).map_err(|error| format!("Path not found: {error}"))?;
        rename_no_replace(&from, &to).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists
                || std::fs::symlink_metadata(&to).is_ok()
            {
                "Destination exists: choose a different name".to_string()
            } else {
                format!("Failed to rename: {error}")
            }
        })
    })
    .await
    .map_err(|error| format!("Rename task failed: {error}"))?
}

fn rename_entry_path(path: &str) -> Result<PathBuf, String> {
    let requested = resolve_safe_path(path)?;
    let name = requested
        .file_name()
        .ok_or("Access denied: cannot rename a filesystem root")?;
    let parent = requested
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = resolve_existing_contained_path(parent.to_str().ok_or("Invalid parent path")?)?;
    Ok(parent.join(name))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    // Only the kernel decides whether the destination exists; unsupported filesystems fail closed.
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let from: Vec<u16> = from.as_os_str().encode_wide().collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().collect();
    if from.contains(&0) || to.contains(&0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Path contains a NUL",
        ));
    }
    let from: Vec<u16> = from.into_iter().chain(Some(0)).collect();
    let to: Vec<u16> = to.into_iter().chain(Some(0)).collect();
    // Neither replacement nor copy/delete across volumes is enabled.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_no_replace(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Atomic no-replace rename is unavailable on this platform",
    ))
}

/// Write uploaded bytes to a file.
pub async fn write_file(path: &str, data: &[u8]) -> Result<(), String> {
    let resolved = resolve_contained_path_for_write(path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }
    fs::write(&resolved, data)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
}

/// Read a file for download after canonical containment validation.
pub async fn read_download_file(path: &str) -> Result<Vec<u8>, String> {
    let resolved = resolve_existing_contained_path(path)?;
    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Path not found: {e}"))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

/// Create a ZIP archive of a directory and return the bytes.
pub fn create_zip_archive(dir_path: &str) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let resolved = resolve_existing_contained_path(dir_path)?;
    ensure_directory(&resolved)?;
    let buffer = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buffer);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(5));

    let mut remaining_entries = MAX_ARCHIVE_ENTRIES;
    add_directory_to_zip(
        &mut zip,
        &resolved,
        &resolved,
        options,
        &mut HashSet::new(),
        &mut remaining_entries,
        0,
    )?;

    let buffer = zip
        .finish()
        .map_err(|e| format!("Failed to finish ZIP: {e}"))?;
    Ok(buffer.into_inner())
}

pub fn create_zip_archive_file(dir_path: &str) -> Result<std::fs::File, String> {
    let resolved = resolve_existing_contained_path(dir_path)?;
    ensure_directory(&resolved)?;
    let temp_file = tempfile::tempfile().map_err(|e| format!("Failed to create temp ZIP: {e}"))?;
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(5));

    let mut zip = zip::ZipWriter::new(temp_file);
    let mut remaining_entries = MAX_ARCHIVE_ENTRIES;
    add_directory_to_zip(
        &mut zip,
        &resolved,
        &resolved,
        options,
        &mut HashSet::new(),
        &mut remaining_entries,
        0,
    )?;

    let mut file = zip
        .finish()
        .map_err(|e| format!("Failed to finish ZIP: {e}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed to rewind ZIP: {e}"))?;
    Ok(file)
}

#[allow(clippy::write_with_newline)]
fn add_directory_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    base: &Path,
    current: &Path,
    options: zip::write::SimpleFileOptions,
    visited: &mut HashSet<PathBuf>,
    remaining_entries: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if !visited.insert(current.to_path_buf()) {
        return Ok(());
    }
    let relative = current
        .strip_prefix(base)
        .map_err(|e| format!("Path prefix error: {e}"))?;
    if depth > MAX_ARCHIVE_DEPTH || relative.components().count() > MAX_ARCHIVE_DEPTH {
        return Err(format!(
            "Archive directory depth exceeds {MAX_ARCHIVE_DEPTH}"
        ));
    }
    if current != base {
        let name = relative
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        zip.add_directory(name, options)
            .map_err(|e| format!("Failed to add directory to ZIP: {e}"))?;
    }
    let entries =
        std::fs::read_dir(current).map_err(|e| format!("Failed to read directory: {e}"))?;

    for entry in entries {
        *remaining_entries = remaining_entries
            .checked_sub(1)
            .ok_or_else(|| "Archive entry limit exceeded".to_string())?;
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common large directories
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }

        let canonical_path = std::fs::canonicalize(&path)
            .map_err(|e| format!("Failed to resolve path {}: {e}", path.display()))?;
        if !canonical_path.starts_with(base) {
            return Err(format!(
                "Access denied: {} escapes archive root",
                path.display()
            ));
        }

        let relative = canonical_path
            .strip_prefix(base)
            .map_err(|e| format!("Path prefix error: {e}"))?
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");

        if canonical_path.is_dir() {
            add_directory_to_zip(
                zip,
                base,
                &canonical_path,
                options,
                visited,
                remaining_entries,
                depth + 1,
            )?;
        } else {
            let data = std::fs::read(&canonical_path)
                .map_err(|e| format!("Failed to read file {relative}: {e}"))?;
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
    let zip_resolved = resolve_existing_contained_path(zip_path)?;
    let target_resolved = resolve_contained_path_for_write(target_dir)?;

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
                safe_zip_output_path(&target_resolved, &name)?;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW);
                }
                let mut outfile = options
                    .open(&out_path)
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

    let mut output = target_dir.to_path_buf();
    for component in relative_path.components() {
        output.push(component);
        match std::fs::symlink_metadata(&output) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "ZIP extraction refuses symbolic link: {}",
                    output.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to inspect extraction path: {error}")),
        }
    }
    Ok(output)
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
pub(crate) fn resolve_safe_path(path: &str) -> Result<PathBuf, String> {
    let expanded = if path.starts_with('~') {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "Cannot resolve home directory".to_string())?;
        PathBuf::from(home).join(path.strip_prefix("~/").unwrap_or(&path[1..]))
    } else {
        PathBuf::from(path)
    };

    // Check for path traversal
    if expanded
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err("Path traversal not allowed".to_string());
    }

    Ok(expanded)
}

pub(crate) fn resolve_existing_contained_path(path: &str) -> Result<PathBuf, String> {
    resolve_existing_contained_path_with_roots(path, allowed_file_roots()?)
}

fn resolve_contained_path_for_write(path: &str) -> Result<PathBuf, String> {
    resolve_contained_path_for_write_with_roots(path, allowed_file_roots()?)
}

fn resolve_existing_contained_path_with_roots(
    path: &str,
    allowed_roots: Vec<PathBuf>,
) -> Result<PathBuf, String> {
    let expanded = resolve_safe_path(path)?;
    let requested = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Cannot resolve current directory: {e}"))?
            .join(expanded)
    };

    let canonical_target =
        std::fs::canonicalize(&requested).map_err(|e| format!("Path not found: {e}"))?;

    if !allowed_roots
        .iter()
        .any(|allowed_root| canonical_target.starts_with(allowed_root))
    {
        return Err(OUTSIDE_ROOTS.to_string());
    }

    Ok(canonical_target)
}

fn resolve_contained_path_for_write_with_roots(
    path: &str,
    allowed_roots: Vec<PathBuf>,
) -> Result<PathBuf, String> {
    let expanded = resolve_safe_path(path)?;
    let requested = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Cannot resolve current directory: {e}"))?
            .join(expanded)
    };

    let mut existing_ancestor = requested.as_path();
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| "Cannot resolve path ancestor".to_string())?;
    }

    let canonical_ancestor =
        std::fs::canonicalize(existing_ancestor).map_err(|e| format!("Path not found: {e}"))?;

    if !allowed_roots
        .iter()
        .any(|allowed_root| canonical_ancestor.starts_with(allowed_root))
    {
        return Err(OUTSIDE_ROOTS.to_string());
    }

    if let Ok(canonical_target) = std::fs::canonicalize(&requested) {
        if !allowed_roots
            .iter()
            .any(|allowed_root| canonical_target.starts_with(allowed_root))
        {
            return Err(OUTSIDE_ROOTS.to_string());
        }
        return Ok(canonical_target);
    }

    Ok(requested)
}

pub(crate) fn allowed_file_roots() -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();

    if let Some(configured_roots) = std::env::var_os(ALLOWED_FILE_ROOTS_ENV) {
        roots.extend(std::env::split_paths(&configured_roots));
    }

    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        roots.push(PathBuf::from(home));
    }

    roots.push(
        std::env::current_dir().map_err(|e| format!("Cannot resolve current directory: {e}"))?,
    );

    let mut canonical_roots = Vec::new();
    for root in roots {
        if let Ok(canonical_root) = std::fs::canonicalize(root) {
            if !canonical_roots
                .iter()
                .any(|existing: &PathBuf| existing == &canonical_root)
            {
                canonical_roots.push(canonical_root);
            }
        }
    }

    if canonical_roots.is_empty() {
        return Err("No allowed file roots are available".to_string());
    }

    Ok(canonical_roots)
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("Path not found: {e}"))?;
    if !metadata.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[test]
    fn resolve_safe_path_allows_two_dots_inside_an_ordinary_filename() {
        assert_eq!(
            resolve_safe_path("/synthetic/release..txt").unwrap(),
            PathBuf::from("/synthetic/release..txt")
        );
    }

    #[tokio::test]
    async fn archive_round_trip_preserves_empty_directories_and_file_contents() {
        const FIXTURE_ENV: &str = "TERMINAL_V4_ZIP_ROUND_TRIP_FIXTURE";
        if let Some(root) = std::env::var_os(FIXTURE_ENV) {
            let root = PathBuf::from(root);
            let source = root.join("source");
            let memory = create_zip_archive(source.to_str().unwrap()).unwrap();
            let mut disk = create_zip_archive_file(source.to_str().unwrap()).unwrap();
            let mut disk_bytes = Vec::new();
            std::io::Read::read_to_end(&mut disk, &mut disk_bytes).unwrap();
            for (index, bytes) in [memory, disk_bytes].into_iter().enumerate() {
                let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
                let mut contents = Vec::new();
                for entry_index in 0..archive.len() {
                    let mut entry = archive.by_index(entry_index).unwrap();
                    let mut data = Vec::new();
                    std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
                    contents.push((entry.name().to_owned(), data));
                }
                contents.sort();
                assert_eq!(
                    contents,
                    vec![
                        ("empty/".into(), vec![]),
                        ("nested/".into(), vec![]),
                        ("nested/deep-empty/".into(), vec![]),
                        ("nested/text.txt".into(), b"hello fixture".to_vec())
                    ]
                );
                let archive_path = root.join(format!("download-{index}.zip"));
                std::fs::write(&archive_path, bytes).unwrap();
                let target = root.join(format!("extracted-{index}"));
                assert_eq!(
                    extract_zip(archive_path.to_str().unwrap(), target.to_str().unwrap())
                        .await
                        .unwrap(),
                    1
                );
                assert!(target.join("empty").is_dir());
                assert!(target.join("nested/deep-empty").is_dir());
                assert_eq!(
                    std::fs::read(target.join("nested/text.txt")).unwrap(),
                    b"hello fixture"
                );
            }
            return;
        }
        let fixture = tempdir().unwrap();
        let source = fixture.path().join("source");
        std::fs::create_dir_all(source.join("empty")).unwrap();
        std::fs::create_dir_all(source.join("nested/deep-empty")).unwrap();
        std::fs::write(source.join("nested/text.txt"), b"hello fixture").unwrap();
        std::fs::create_dir_all(source.join(".hidden")).unwrap();
        std::fs::create_dir_all(source.join("node_modules")).unwrap();
        std::fs::create_dir_all(source.join("target")).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "files::tests::archive_round_trip_preserves_empty_directories_and_file_contents",
                "--nocapture",
            ])
            .current_dir(fixture.path())
            .env(FIXTURE_ENV, fixture.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "Archive subprocess failed: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn archive_rejects_excessive_directory_depth() {
        let fixture = tempdir().unwrap();
        let root = std::fs::canonicalize(fixture.path()).unwrap();
        let mut nested = root.clone();
        for _ in 0..130 {
            nested.push("d");
        }
        std::fs::create_dir_all(&nested).unwrap();
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let mut remaining_entries = MAX_ARCHIVE_ENTRIES;
        let result = add_directory_to_zip(
            &mut writer,
            &root,
            &root,
            zip::write::SimpleFileOptions::default(),
            &mut HashSet::new(),
            &mut remaining_entries,
            0,
        );
        assert_eq!(result, Err("Archive directory depth exceeds 128".into()));
    }

    #[cfg(unix)]
    #[test]
    fn archive_depth_bounds_chains_of_shallow_directory_symlinks() {
        let fixture = tempdir().unwrap();
        let root = std::fs::canonicalize(fixture.path()).unwrap();
        for index in 0..130 {
            std::fs::create_dir(root.join(format!("d{index}"))).unwrap();
        }
        for index in 0..129 {
            symlink(
                format!("../d{}", index + 1),
                root.join(format!("d{index}/next")),
            )
            .unwrap();
        }
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let mut remaining_entries = MAX_ARCHIVE_ENTRIES;
        assert_eq!(
            add_directory_to_zip(
                &mut writer,
                &root,
                &root.join("d0"),
                zip::write::SimpleFileOptions::default(),
                &mut HashSet::new(),
                &mut remaining_entries,
                0
            ),
            Err("Archive directory depth exceeds 128".into())
        );
    }

    #[test]
    fn archive_entry_budget_bounds_files_and_directories() {
        let fixture = tempdir().unwrap();
        let root = std::fs::canonicalize(fixture.path()).unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/file.txt"), b"fixture").unwrap();
        for (budget, expected) in [(1, Err("Archive entry limit exceeded".into())), (2, Ok(()))] {
            let mut remaining_entries = budget;
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            assert_eq!(
                add_directory_to_zip(
                    &mut writer,
                    &root,
                    &root,
                    zip::write::SimpleFileOptions::default(),
                    &mut HashSet::new(),
                    &mut remaining_entries,
                    0
                ),
                expected
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn archives_handle_directory_symlink_cycles() {
        const FIXTURE_ENV: &str = "TERMINAL_V4_ZIP_CYCLE_FIXTURE";
        if let Some(root) = std::env::var_os(FIXTURE_ENV) {
            let root = PathBuf::from(root);
            let memory_zip = create_zip_archive(root.to_str().unwrap()).unwrap();
            let file_zip = create_zip_archive_file(root.to_str().unwrap()).unwrap();
            let mut archives = [
                zip::ZipArchive::new(std::io::Cursor::new(memory_zip)).unwrap(),
                zip::ZipArchive::new(std::io::Cursor::new({
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    (&file_zip).read_to_end(&mut bytes).unwrap();
                    bytes
                }))
                .unwrap(),
            ];
            for archive in &mut archives {
                let mut contents = Vec::new();
                for index in 0..archive.len() {
                    let mut entry = archive.by_index(index).unwrap();
                    let mut data = Vec::new();
                    std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
                    contents.push((entry.name().to_string(), data));
                }
                assert_eq!(
                    contents,
                    vec![
                        ("nested/".to_string(), vec![]),
                        ("nested/file.txt".to_string(), b"fixture".to_vec())
                    ]
                );
            }
            return;
        }

        let fixture = tempdir().unwrap();
        std::fs::create_dir(fixture.path().join("nested")).unwrap();
        std::fs::write(fixture.path().join("nested/file.txt"), b"fixture").unwrap();
        symlink(".", fixture.path().join("loop")).unwrap();
        symlink("..", fixture.path().join("nested/back")).unwrap();
        symlink("nested", fixture.path().join("alias")).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "files::tests::archives_handle_directory_symlink_cycles",
                "--nocapture",
            ])
            .current_dir(fixture.path())
            .env(FIXTURE_ENV, fixture.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "Archive subprocess failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn archives_still_reject_symlinks_outside_the_archive_root() {
        let fixture = tempdir().unwrap();
        let root = fixture.path().join("archive");
        std::fs::create_dir(&root).unwrap();
        let outside_file = fixture.path().join("private.txt");
        std::fs::write(&outside_file, b"private").unwrap();
        symlink(&outside_file, root.join("link.txt")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let mut remaining_entries = MAX_ARCHIVE_ENTRIES;
        let result = add_directory_to_zip(
            &mut zip,
            &root,
            &root,
            zip::write::SimpleFileOptions::default(),
            &mut HashSet::new(),
            &mut remaining_entries,
            0,
        );
        assert_eq!(
            result,
            Err(format!(
                "Access denied: {} escapes archive root",
                root.join("link.txt").display()
            ))
        );
    }

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

    #[cfg(unix)]
    #[test]
    fn resolve_existing_contained_path_rejects_symlink_escape() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let base_dir = temp_dir.path().join("base");
        let outside_dir = temp_dir.path().join("outside");
        std::fs::create_dir_all(&base_dir).expect("base dir should create");
        std::fs::create_dir_all(&outside_dir).expect("outside dir should create");
        let outside_file = outside_dir.join("secret.txt");
        std::fs::write(&outside_file, "secret").expect("outside file should write");
        symlink(&outside_file, base_dir.join("link.txt")).expect("symlink should create");

        let result = resolve_existing_contained_path_with_roots(
            base_dir
                .join("link.txt")
                .to_str()
                .expect("symlink path should be utf-8"),
            vec![std::fs::canonicalize(&base_dir).expect("base should canonicalize")],
        );

        assert!(result.is_err());
    }

    #[test]
    fn resolve_existing_contained_path_rejects_files_outside_allowed_roots() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let allowed_dir = temp_dir.path().join("allowed");
        let outside_dir = temp_dir.path().join("outside");
        std::fs::create_dir_all(&allowed_dir).expect("allowed dir should create");
        std::fs::create_dir_all(&outside_dir).expect("outside dir should create");
        let outside_file = outside_dir.join("secret.txt");
        std::fs::write(&outside_file, "secret").expect("outside file should write");

        let result = resolve_existing_contained_path_with_roots(
            outside_file.to_str().expect("outside path should be utf-8"),
            vec![std::fs::canonicalize(&allowed_dir).expect("allowed should canonicalize")],
        );

        assert!(result.is_err());
    }

    #[test]
    fn resolve_contained_path_for_write_allows_new_paths_under_allowed_roots() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let allowed_dir = temp_dir.path().join("allowed");
        std::fs::create_dir_all(&allowed_dir).expect("allowed dir should create");

        let result = resolve_contained_path_for_write_with_roots(
            allowed_dir
                .join("nested")
                .join("new.txt")
                .to_str()
                .expect("new path should be utf-8"),
            vec![std::fs::canonicalize(&allowed_dir).expect("allowed should canonicalize")],
        )
        .expect("new contained path should resolve");

        assert_eq!(result, allowed_dir.join("nested").join("new.txt"));
    }

    #[test]
    fn resolve_contained_path_for_write_rejects_new_paths_outside_allowed_roots() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let allowed_dir = temp_dir.path().join("allowed");
        let outside_dir = temp_dir.path().join("outside");
        std::fs::create_dir_all(&allowed_dir).expect("allowed dir should create");
        std::fs::create_dir_all(&outside_dir).expect("outside dir should create");

        let result = resolve_contained_path_for_write_with_roots(
            outside_dir
                .join("new.txt")
                .to_str()
                .expect("outside path should be utf-8"),
            vec![std::fs::canonicalize(&allowed_dir).expect("allowed should canonicalize")],
        );

        assert!(result.is_err());
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

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_selected_symlinks_preserves_targets_and_removes_dangling_links() {
        let fixture = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let root = fixture.path();
        std::fs::create_dir(root.join("real-directory")).unwrap();
        std::fs::write(root.join("real-directory/keep.txt"), b"keep").unwrap();
        std::fs::write(root.join("real-file"), b"keep-file").unwrap();
        for (name, target) in [
            ("directory-link", "real-directory"),
            ("file-link", "real-file"),
            ("dangling-link", "missing"),
        ] {
            symlink(root.join(target), root.join(name)).unwrap();
            delete_path(root.join(name).to_str().unwrap())
                .await
                .unwrap();
            assert!(std::fs::symlink_metadata(root.join(name)).is_err());
        }
        assert_eq!(
            std::fs::read(root.join("real-directory/keep.txt")).unwrap(),
            b"keep"
        );
        assert_eq!(std::fs::read(root.join("real-file")).unwrap(), b"keep-file");
        delete_path(root.join("real-directory").to_str().unwrap())
            .await
            .unwrap();
        assert!(!root.join("real-directory").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn extraction_rejects_existing_directory_file_and_dangling_symlinks() {
        let fixture = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let root = fixture.path();
        std::fs::create_dir(root.join("outside")).unwrap();
        std::fs::write(root.join("outside/marker.txt"), b"before").unwrap();
        for (case, member, target) in [
            ("ancestor", "link/marker.txt", "outside"),
            ("final-file", "link", "outside/marker.txt"),
            ("dangling", "link", "outside/missing.txt"),
        ] {
            let destination = root.join(case);
            std::fs::create_dir(&destination).unwrap();
            symlink(root.join(target), destination.join("link")).unwrap();
            let archive = root.join(format!("{case}.zip"));
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            writer
                .start_file(member, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"after").unwrap();
            writer.finish().unwrap();
            assert!(
                extract_zip(archive.to_str().unwrap(), destination.to_str().unwrap())
                    .await
                    .is_err(),
                "{case} must be rejected"
            );
            assert_eq!(
                std::fs::read(root.join("outside/marker.txt")).unwrap(),
                b"before"
            );
            assert!(!root.join("outside/missing.txt").exists());
            assert!(std::fs::symlink_metadata(destination.join("link"))
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }
}
