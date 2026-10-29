use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(any(not(unix), test))]
use std::path::PathBuf;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
};

const IMAGE_BYTES: usize = 8 * 1024 * 1024;
const BATCH_IMAGES: usize = 8;
const BATCH_BYTES: usize = 16 * 1024 * 1024;
const HYDRATED_BYTES: usize = 16 * 1024 * 1024;
const HYDRATED_IMAGES: usize = 32;
const SESSION_IMAGES: usize = 256;
const SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_DEPTH: usize = 64;

// Close alone can leave flock held by a descriptor inherited during fork until
// the child execs. Explicit unlock ends the writer lifetime at guard release.
pub(super) struct WriteLock(File);
impl Drop for WriteLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}
#[cfg(all(unix, test))]
impl std::os::fd::AsRawFd for WriteLock {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.0.as_raw_fd()
    }
}

pub(super) fn extension(mime: &str) -> Result<&'static str, String> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        _ => Err("Image MIME type must be PNG, JPEG, GIF or WebP".into()),
    }
}

fn dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > 32_768
        || height > 32_768
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("Image dimensions exceed the supported limit".into());
    }
    Ok(())
}

fn u32_be(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().unwrap())
}
fn u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap())
}
fn u16_le(bytes: &[u8]) -> u32 {
    u32::from(u16::from_le_bytes(bytes.try_into().unwrap()))
}

// This checks signatures, container framing and dimensions, not pixel/codec validity.
pub(super) fn validate_image(mime: &str, bytes: &[u8]) -> Result<(), String> {
    validate_image_policy(mime, bytes, false)
}
pub(super) fn validate_user_image(mime: &str, bytes: &[u8]) -> Result<(), String> {
    validate_image_policy(mime, bytes, true)
}
fn validate_image_policy(mime: &str, bytes: &[u8], still_only: bool) -> Result<(), String> {
    extension(mime)?;
    if bytes.is_empty() || bytes.len() > IMAGE_BYTES {
        return Err("An image must contain 1 byte–8 MiB of decoded data".into());
    }
    let invalid = || "Image signature or framing does not match its MIME type".to_string();
    match mime {
        "image/png" => {
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err(invalid());
            }
            let mut cursor = 8;
            let mut header = false;
            let mut pixels = false;
            while cursor + 12 <= bytes.len() {
                let size = u32_be(&bytes[cursor..cursor + 4]) as usize;
                let end = cursor
                    .checked_add(size)
                    .and_then(|end| end.checked_add(12))
                    .ok_or_else(invalid)?;
                if end > bytes.len() {
                    return Err(invalid());
                }
                let kind = &bytes[cursor + 4..cursor + 8];
                if still_only && matches!(kind, b"acTL" | b"fcTL" | b"fdAT") {
                    return Err("Animated PNG is not supported for user image input".into());
                }
                if !header {
                    if kind != b"IHDR" || size != 13 {
                        return Err(invalid());
                    }
                    dimensions(
                        u32_be(&bytes[cursor + 8..cursor + 12]),
                        u32_be(&bytes[cursor + 12..cursor + 16]),
                    )?;
                    header = true;
                } else if kind == b"IHDR" {
                    return Err(invalid());
                }
                if kind == b"IDAT" {
                    pixels = true;
                }
                if kind == b"IEND" {
                    return if size == 0 && pixels && end == bytes.len() {
                        Ok(())
                    } else {
                        Err(invalid())
                    };
                }
                cursor = end;
            }
            Err(invalid())
        }
        "image/jpeg" => {
            if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
                return Err(invalid());
            }
            let mut cursor = 2;
            let mut frame = false;
            while cursor + 4 <= bytes.len() {
                if bytes[cursor] != 0xff {
                    return Err(invalid());
                }
                while cursor < bytes.len() && bytes[cursor] == 0xff {
                    cursor += 1;
                }
                if cursor >= bytes.len() {
                    return Err(invalid());
                }
                let marker = bytes[cursor];
                cursor += 1;
                if marker == 0
                    || marker == 0xd8
                    || marker == 0xd9
                    || (0xd0..=0xd7).contains(&marker)
                {
                    return Err(invalid());
                }
                if cursor + 2 > bytes.len() {
                    return Err(invalid());
                }
                let size =
                    u16::from_be_bytes(bytes[cursor..cursor + 2].try_into().unwrap()) as usize;
                let end = cursor.checked_add(size).ok_or_else(invalid)?;
                if size < 2 || end > bytes.len() - 2 {
                    return Err(invalid());
                }
                let payload = &bytes[cursor + 2..end];
                if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                    if payload.len() < 6 {
                        return Err(invalid());
                    }
                    dimensions(
                        u16::from_be_bytes(payload[3..5].try_into().unwrap()).into(),
                        u16::from_be_bytes(payload[1..3].try_into().unwrap()).into(),
                    )?;
                    frame = true;
                }
                if marker == 0xda {
                    return if frame && !payload.is_empty() && end < bytes.len() - 2 {
                        Ok(())
                    } else {
                        Err(invalid())
                    };
                }
                cursor = end;
            }
            Err(invalid())
        }
        "image/gif" => {
            if bytes.len() < 14 || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
                return Err(invalid());
            }
            dimensions(u16_le(&bytes[6..8]), u16_le(&bytes[8..10]))?;
            let mut cursor = 13;
            if bytes[10] & 0x80 != 0 {
                cursor += 3 * (2 << (bytes[10] & 7));
            }
            let mut frames = 0;
            while cursor < bytes.len() {
                let marker = bytes[cursor];
                cursor += 1;
                match marker {
                    0x3b => {
                        return if frames > 0 && cursor == bytes.len() {
                            Ok(())
                        } else {
                            Err(invalid())
                        }
                    }
                    0x21 => {
                        cursor = cursor.checked_add(1).ok_or_else(invalid)?;
                    }
                    0x2c => {
                        if cursor + 9 > bytes.len() {
                            return Err(invalid());
                        }
                        dimensions(
                            u16_le(&bytes[cursor + 4..cursor + 6]),
                            u16_le(&bytes[cursor + 6..cursor + 8]),
                        )?;
                        let packed = bytes[cursor + 8];
                        cursor += 9;
                        if packed & 0x80 != 0 {
                            cursor += 3 * (2 << (packed & 7));
                        }
                        if cursor >= bytes.len() || !(2..=8).contains(&bytes[cursor]) {
                            return Err(invalid());
                        }
                        cursor += 1;
                        frames += 1;
                        if frames > if still_only { 1 } else { 256 } {
                            return Err("Animated image has too many frames".into());
                        }
                    }
                    _ => return Err(invalid()),
                }
                loop {
                    if cursor >= bytes.len() {
                        return Err(invalid());
                    }
                    let size = bytes[cursor] as usize;
                    cursor += 1;
                    if size == 0 {
                        break;
                    }
                    cursor = cursor.checked_add(size).ok_or_else(invalid)?;
                    if cursor > bytes.len() {
                        return Err(invalid());
                    }
                }
            }
            Err(invalid())
        }
        "image/webp" => {
            if bytes.len() < 20
                || !bytes.starts_with(b"RIFF")
                || &bytes[8..12] != b"WEBP"
                || u32_le(&bytes[4..8]) as usize != bytes.len() - 8
            {
                return Err(invalid());
            }
            if still_only {
                let mut cursor = 12;
                while cursor + 8 <= bytes.len() {
                    let kind = &bytes[cursor..cursor + 4];
                    let size = u32_le(&bytes[cursor + 4..cursor + 8]) as usize;
                    let end = cursor
                        .checked_add(8)
                        .and_then(|n| n.checked_add(size))
                        .ok_or_else(invalid)?;
                    if end > bytes.len() {
                        return Err(invalid());
                    }
                    if kind == b"ANIM"
                        || kind == b"ANMF"
                        || kind == b"VP8X" && size > 0 && bytes[cursor + 8] & 2 != 0
                    {
                        return Err("Animated WebP is not supported for user image input".into());
                    }
                    cursor = end + (size & 1);
                }
            }
            webp_chunks(&bytes[12..], false).and_then(|frames| {
                if frames > 0 {
                    Ok(())
                } else {
                    Err(invalid())
                }
            })
        }
        _ => unreachable!(),
    }
}

fn webp_chunks(bytes: &[u8], nested: bool) -> Result<usize, String> {
    let invalid = || "Invalid WebP image framing".to_string();
    let mut cursor = 0;
    let mut frames = 0;
    while cursor + 8 <= bytes.len() {
        let kind = &bytes[cursor..cursor + 4];
        let size = u32_le(&bytes[cursor + 4..cursor + 8]) as usize;
        let end = cursor
            .checked_add(size)
            .and_then(|end| end.checked_add(8))
            .ok_or_else(invalid)?;
        if end > bytes.len() {
            return Err(invalid());
        }
        let payload = &bytes[cursor + 8..end];
        match kind {
            b"VP8 " => {
                if payload.len() < 10 || payload[0] & 1 != 0 || payload[3..6] != [0x9d, 0x01, 0x2a]
                {
                    return Err(invalid());
                }
                dimensions(
                    u16_le(&payload[6..8]) & 0x3fff,
                    u16_le(&payload[8..10]) & 0x3fff,
                )?;
                frames += 1;
            }
            b"VP8L" => {
                if payload.len() < 5 || payload[0] != 0x2f {
                    return Err(invalid());
                }
                let bits = u32_le(&payload[1..5]);
                if bits >> 29 != 0 {
                    return Err(invalid());
                }
                dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)?;
                frames += 1;
            }
            b"VP8X" => {
                if nested || payload.len() != 10 {
                    return Err(invalid());
                }
                let width = 1 + u32::from_le_bytes([payload[4], payload[5], payload[6], 0]);
                let height = 1 + u32::from_le_bytes([payload[7], payload[8], payload[9], 0]);
                dimensions(width, height)?;
            }
            b"ANMF" => {
                if nested || payload.len() < 24 {
                    return Err(invalid());
                }
                let width = 1 + u32::from_le_bytes([payload[6], payload[7], payload[8], 0]);
                let height = 1 + u32::from_le_bytes([payload[9], payload[10], payload[11], 0]);
                dimensions(width, height)?;
                let child_frames = webp_chunks(&payload[16..], true)?;
                if child_frames != 1 {
                    return Err(invalid());
                }
                frames += child_frames;
            }
            _ => {}
        }
        if frames > 256 {
            return Err("Animated image has too many frames".into());
        }
        cursor = end + (size & 1);
        if cursor > bytes.len() {
            return Err(invalid());
        }
    }
    if cursor == bytes.len() {
        Ok(frames)
    } else {
        Err(invalid())
    }
}

pub(super) fn image_id(mime: &str, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"v4-image-v1\0");
    hash.update(mime.as_bytes());
    hash.update(b"\0");
    hash.update(bytes);
    hex::encode(hash.finalize())
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

pub(super) struct PreparedImage {
    pub(super) name: String,
    pub(super) marker: Value,
    pub(super) bytes: Vec<u8>,
}

fn prepare_images(images: &[(String, String)]) -> Result<Vec<PreparedImage>, String> {
    if images.len() > BATCH_IMAGES {
        return Err("An image batch may contain at most eight images".into());
    }
    let mut total = 0usize;
    let mut prepared = Vec::with_capacity(images.len());
    for (mime, encoded) in images {
        let extension = extension(mime)?;
        if encoded.len() > IMAGE_BYTES.div_ceil(3) * 4 {
            return Err("Encoded image exceeds its limit".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Image data must be canonical standard base64")?;
        validate_image(mime, &bytes)?;
        total = total
            .checked_add(bytes.len())
            .ok_or("Image batch byte limit exceeded")?;
        if total > BATCH_BYTES {
            return Err("Image batch exceeds its 16 MiB decoded byte limit".into());
        }
        let id = image_id(mime, &bytes);
        prepared.push(PreparedImage {
            name: format!("{id}.{extension}"),
            marker: json!({"type":"v4_image","artifactId":id,"mimeType":mime}),
            bytes,
        });
    }
    Ok(prepared)
}

pub(super) struct Directory {
    #[cfg(not(unix))]
    path: PathBuf,
    #[cfg(unix)]
    file: File,
}

pub(super) fn scope_parts(
    owner: &str,
    workspace: &Path,
    session: &str,
) -> Result<[String; 4], String> {
    if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
        return Err("Invalid image artifact account".into());
    }
    if !workspace.is_absolute()
        || workspace
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Image artifact workspace must be an absolute non-traversing path".into());
    }
    let workspace = workspace
        .to_str()
        .filter(|value| value.len() <= 32_768 && !value.chars().any(char::is_control))
        .ok_or("Invalid image artifact workspace")?;
    let normalized = crate::session_search::normalize_workspace_path(workspace);
    let session = uuid::Uuid::parse_str(session)
        .map_err(|_| "Invalid image artifact session")?
        .to_string();
    Ok([
        "v4-agent-artifacts".into(),
        hex::encode(Sha256::digest(owner.as_bytes())),
        hex::encode(Sha256::digest(normalized.as_bytes())),
        session,
    ])
}

#[cfg(unix)]
fn c_name(value: &str) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(value).map_err(|_| "Invalid image artifact path".into())
}

#[cfg(unix)]
fn directory_entry(stream: *mut libc::DIR) -> Result<*mut libc::dirent, String> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let errno = unsafe { libc::__errno_location() };
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let errno = unsafe { libc::__error() };
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))]
    unsafe {
        *errno = 0;
        let item = libc::readdir(stream);
        if item.is_null() && *errno != 0 {
            return Err("Cannot inspect image artifact quota".into());
        }
        Ok(item)
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    {
        let _ = stream;
        Err("Image artifact directory enumeration is unavailable on this platform".into())
    }
}

impl Directory {
    pub(super) fn open(data: &Path, parts: &[String; 4], create: bool) -> Result<Self, String> {
        if !data.is_absolute() {
            return Err("Image artifact data directory must be absolute".into());
        }
        let meta = std::fs::symlink_metadata(data)
            .map_err(|_| "Image artifact data directory is unavailable")?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Image artifact data directory must be a real directory".into());
        }
        #[cfg(not(unix))]
        if is_reparse(&meta) {
            return Err("Image artifact data directory must be a real directory".into());
        }
        let canonical = data
            .canonicalize()
            .map_err(|_| "Image artifact data directory is unavailable")?;
        #[cfg(unix)]
        {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::OpenOptionsExt,
            };
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(canonical)
                .map_err(|_| "Cannot open image artifact directory")?;
            for part in parts {
                let name = c_name(part)?;
                if create {
                    let result = unsafe { libc::mkdirat(file.as_raw_fd(), name.as_ptr(), 0o700) };
                    if result != 0
                        && std::io::Error::last_os_error().kind()
                            != std::io::ErrorKind::AlreadyExists
                    {
                        return Err("Cannot prepare image artifact directory".into());
                    }
                }
                let fd = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err("Image artifact directory is unavailable or symlinked".into());
                }
                file = unsafe { File::from_raw_fd(fd) };
                if create {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(std::fs::Permissions::from_mode(0o700))
                        .map_err(|_| "Cannot protect image artifact directory")?;
                }
            }
            Ok(Self { file })
        }
        #[cfg(not(unix))]
        {
            let mut path = canonical;
            for part in parts {
                path.push(part);
                if create {
                    match std::fs::create_dir(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(_) => return Err("Cannot prepare image artifact directory".into()),
                    }
                }
                let meta = std::fs::symlink_metadata(&path)
                    .map_err(|_| "Image artifact directory is unavailable")?;
                if is_reparse(&meta) || !meta.is_dir() {
                    return Err("Image artifact directory is unavailable or symlinked".into());
                }
            }
            Ok(Self { path })
        }
    }

    pub(super) fn read_file(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let file = match self.open_file(name, false, false) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Image artifact is unavailable or symlinked".into()),
        };
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect image artifact")?;
        if !metadata.is_file() || metadata.len() > IMAGE_BYTES as u64 {
            return Err("Invalid image artifact file or size".into());
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read image artifact")?;
        if bytes.len() > IMAGE_BYTES {
            return Err("Image artifact exceeds its limit".into());
        }
        Ok(Some(bytes))
    }

    fn open_file(&self, name: &str, create: bool, exclusive: bool) -> std::io::Result<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(name).map_err(std::io::Error::other)?;
            let flags = if create {
                libc::O_RDWR | libc::O_CREAT
            } else {
                libc::O_RDONLY
            };
            let flags = flags | if exclusive { libc::O_EXCL } else { 0 };
            let fd = unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    0o600,
                )
            };
            if fd < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(unsafe { File::from_raw_fd(fd) })
            }
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            if let Ok(metadata) = std::fs::symlink_metadata(&path) {
                if is_reparse(&metadata) {
                    return Err(std::io::Error::other("Symlinked image artifact"));
                }
            }
            let mut options = OpenOptions::new();
            options
                .read(true)
                .write(create)
                .create(create)
                .create_new(exclusive);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x0020_0000);
                if create && !exclusive {
                    options.share_mode(0);
                }
            }
            let file = options.open(path)?;
            if is_reparse(&file.metadata()?) {
                return Err(std::io::Error::other("Symlinked image artifact"));
            }
            Ok(file)
        }
    }

    pub(super) fn names(&self) -> Result<Vec<String>, String> {
        #[cfg(unix)]
        {
            use std::{ffi::CStr, os::fd::AsRawFd};
            let fd = unsafe { libc::dup(self.file.as_raw_fd()) };
            if fd < 0 {
                return Err("Cannot inspect image artifact quota".into());
            }
            let stream = unsafe { libc::fdopendir(fd) };
            if stream.is_null() {
                unsafe { libc::close(fd) };
                return Err("Cannot inspect image artifact quota".into());
            }
            unsafe { libc::rewinddir(stream) };
            let result = (|| {
                let mut names = Vec::new();
                loop {
                    let item = directory_entry(stream)?;
                    if item.is_null() {
                        break;
                    }
                    let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }
                        .to_str()
                        .map_err(|_| "Invalid image artifact directory entry")?;
                    if name == "." || name == ".." {
                        continue;
                    }
                    if names.len() >= SESSION_IMAGES + 16 {
                        return Err("Image artifact session directory is full".into());
                    }
                    names.push(name.to_string());
                }
                Ok(names)
            })();
            unsafe { libc::closedir(stream) };
            result
        }
        #[cfg(not(unix))]
        {
            let mut names = Vec::new();
            for item in
                std::fs::read_dir(&self.path).map_err(|_| "Cannot inspect image artifact quota")?
            {
                if names.len() >= SESSION_IMAGES + 16 {
                    return Err("Image artifact session directory is full".into());
                }
                names.push(
                    item.map_err(|_| "Cannot inspect image artifact quota")?
                        .file_name()
                        .into_string()
                        .map_err(|_| "Invalid image artifact directory entry")?,
                );
            }
            Ok(names)
        }
    }

    fn check_quota(&self, new_count: usize, new_bytes: usize) -> Result<(), String> {
        let mut count = 0usize;
        let mut bytes = 0u64;
        for name in self.names()? {
            if name == ".write.lock" {
                continue;
            }
            let file = self
                .open_file(&name, false, false)
                .map_err(|_| "Image artifact quota contains an unavailable file")?;
            let metadata = file
                .metadata()
                .map_err(|_| "Cannot inspect image artifact quota")?;
            if !metadata.is_file() {
                return Err("Image artifact quota contains an invalid entry".into());
            }
            count += 1;
            bytes = bytes
                .checked_add(metadata.len())
                .ok_or("Image artifact storage quota exceeded")?;
            if count > SESSION_IMAGES || bytes > SESSION_BYTES {
                return Err("Image artifact session storage is full".into());
            }
        }
        if count
            .checked_add(new_count)
            .is_none_or(|value| value > SESSION_IMAGES)
            || bytes
                .checked_add(new_bytes as u64)
                .is_none_or(|value| value > SESSION_BYTES)
        {
            return Err("Image artifact session storage is full".into());
        }
        Ok(())
    }

    pub(super) fn write_lock(&self) -> Result<WriteLock, String> {
        let lock = self
            .open_file(".write.lock", true, false)
            .map_err(|_| "Image artifact storage is busy or unavailable")?;
        let metadata = lock
            .metadata()
            .map_err(|_| "Cannot inspect image artifact lock")?;
        if !metadata.is_file() || metadata.len() != 0 {
            return Err("Invalid image artifact lock".into());
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("Image artifact storage is busy; retry the tool".into());
            }
        }
        Ok(WriteLock(lock))
    }

    pub(super) fn unlink(&self, name: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let name = c_name(name)?;
            for _ in 0..8 {
                if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } == 0 {
                    return Ok(());
                }
                match std::io::Error::last_os_error().kind() {
                    std::io::ErrorKind::NotFound => return Ok(()),
                    std::io::ErrorKind::Interrupted => continue,
                    _ => return Err("Cannot remove an uncommitted image artifact".into()),
                }
            }
            Err("Cannot remove an uncommitted image artifact".into())
        }
        #[cfg(not(unix))]
        {
            match std::fs::remove_file(self.path.join(name)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("Cannot remove an uncommitted image artifact".into()),
            }
        }
    }

    pub(super) fn remove_new_file(&self, image: &PreparedImage) -> Result<(), String> {
        match self.read_file(&image.name)? {
            None => Ok(()),
            Some(bytes) if bytes == image.bytes => self.unlink(&image.name),
            Some(_) => Err("Cannot roll back an image artifact changed by another writer".into()),
        }
    }

    fn publish_file(&self, image: &PreparedImage) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let temporary = format!(".{}.{}.tmp", image.name, uuid::Uuid::new_v4());
            let temp_name = c_name(&temporary)?;
            let final_name = c_name(&image.name)?;
            let mut published = false;
            let result: Result<(), String> = (|| {
                let mut file = self
                    .open_file(&temporary, true, true)
                    .map_err(|_| "Cannot prepare image artifact")?;
                file.write_all(&image.bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "Cannot save image artifact")?;
                if unsafe {
                    libc::linkat(
                        self.file.as_raw_fd(),
                        temp_name.as_ptr(),
                        self.file.as_raw_fd(),
                        final_name.as_ptr(),
                        0,
                    )
                } != 0
                {
                    return Err(
                        "Cannot publish image artifact without replacing existing content".into(),
                    );
                }
                published = true;
                Ok(())
            })();
            let cleanup = self.unlink(&temporary);
            let result = result.and(cleanup).and_then(|_| {
                self.file
                    .sync_all()
                    .map_err(|_| "Cannot persist image artifact directory".into())
            });
            if result.is_err() && published {
                self.remove_new_file(image).map_err(|error| {
                    format!("Image publication failed; rollback also failed: {error}")
                })?;
            }
            result
        }
        #[cfg(not(unix))]
        {
            let mut file = tempfile::NamedTempFile::new_in(&self.path)
                .map_err(|_| "Cannot prepare image artifact")?;
            file.write_all(&image.bytes)
                .and_then(|_| file.as_file().sync_all())
                .map_err(|_| "Cannot save image artifact")?;
            file.persist_noclobber(self.path.join(&image.name))
                .map_err(|_| "Cannot publish image artifact without replacing existing content")?;
            Ok(())
        }
    }

    fn publish_new_files(&self, images: &[&PreparedImage]) -> Result<(), String> {
        let mut created = Vec::new();
        for image in images {
            if let Err(error) = self.publish_file(image) {
                let mut cleanup_errors = Vec::new();
                for image in created.into_iter().rev() {
                    if let Err(error) = self.remove_new_file(image) {
                        cleanup_errors.push(error);
                    }
                }
                #[cfg(unix)]
                if let Err(error) = self.file.sync_all() {
                    cleanup_errors.push(error.to_string());
                }
                return if cleanup_errors.is_empty() {
                    Err(error)
                } else {
                    Err(format!(
                        "{error}; image batch rollback also failed: {}",
                        cleanup_errors.join("; ")
                    ))
                };
            }
            created.push(*image);
        }
        Ok(())
    }

    fn store_batch(&self, images: &[PreparedImage]) -> Result<(), String> {
        let _lock = self.write_lock()?;
        self.store_batch_locked(images)
    }

    pub(super) fn store_batch_locked(&self, images: &[PreparedImage]) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        let mut missing = Vec::new();
        let mut new_bytes = 0usize;
        for image in images {
            if !seen.insert(image.name.as_str()) {
                continue;
            }
            match self.read_file(&image.name)? {
                Some(existing) if existing == image.bytes => {}
                Some(_) => return Err("Stored image artifact failed its integrity check".into()),
                None => {
                    new_bytes = new_bytes
                        .checked_add(image.bytes.len())
                        .ok_or("Image batch byte limit exceeded")?;
                    missing.push(image);
                }
            }
        }
        if missing.is_empty() {
            return Ok(());
        }
        self.check_quota(missing.len(), new_bytes)?;
        self.publish_new_files(&missing)
    }
}

#[cfg(not(unix))]
fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(super) fn store_images(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
    images: &[(String, String)],
) -> Result<Vec<Value>, String> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    let parts = scope_parts(owner, workspace, session)?;
    let prepared = prepare_images(images)?;
    Directory::open(data, &parts, true)?.store_batch(&prepared)?;
    Ok(prepared.into_iter().map(|image| image.marker).collect())
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn store_image(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
    mime: &str,
    encoded: &str,
) -> Result<Value, String> {
    store_images(
        data,
        owner,
        workspace,
        session,
        &[(mime.into(), encoded.into())],
    )?
    .pop()
    .ok_or_else(|| "Image artifact was not published".into())
}

pub(super) fn hydrate_history(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
    history: &[Value],
) -> Result<Vec<Value>, String> {
    let parts = scope_parts(owner, workspace, session)?;
    let mut directory = None;
    let mut count = 0;
    let mut total = 0usize;
    fn hydrate(
        value: &Value,
        depth: usize,
        scope: (&Path, &[String; 4]),
        directory: &mut Option<Directory>,
        count: &mut usize,
        total: &mut usize,
    ) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err("Image artifact history is too deeply nested".into());
        }
        match value {
            Value::Object(object)
                if object.len() == 3
                    && object.get("type").and_then(Value::as_str) == Some("v4_image")
                    && object.contains_key("artifactId")
                    && object.contains_key("mimeType") =>
            {
                *count += 1;
                if *count > HYDRATED_IMAGES {
                    return Err(
                        "History contains too many image artifacts; compact the conversation"
                            .into(),
                    );
                }
                let id = object["artifactId"]
                    .as_str()
                    .filter(|id| valid_id(id))
                    .ok_or("Invalid image artifact ID")?;
                let mime = object["mimeType"]
                    .as_str()
                    .ok_or("Invalid image artifact MIME type")?;
                let ext = extension(mime)?;
                if directory.is_none() {
                    *directory = Some(Directory::open(scope.0, scope.1, false)?);
                }
                let bytes = directory
                    .as_ref()
                    .unwrap()
                    .read_file(&format!("{id}.{ext}"))?
                    .ok_or(
                        "Image artifact is unavailable for this account, workspace and session",
                    )?;
                if image_id(mime, &bytes) != id {
                    return Err("Stored image artifact failed its integrity check".into());
                }
                validate_image(mime, &bytes)?;
                *total = total
                    .checked_add(bytes.len())
                    .ok_or("Hydrated image byte limit exceeded")?;
                if *total > HYDRATED_BYTES {
                    return Err(
                        "Hydrated image byte limit exceeded; compact the conversation".into(),
                    );
                }
                Ok(json!({"type":"image","mimeType":mime,"data":STANDARD.encode(bytes)}))
            }
            Value::Object(object) => Ok(Value::Object(
                object
                    .iter()
                    .map(|(key, value)| {
                        Ok((
                            key.clone(),
                            hydrate(value, depth + 1, scope, directory, count, total)?,
                        ))
                    })
                    .collect::<Result<_, String>>()?,
            )),
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|value| hydrate(value, depth + 1, scope, directory, count, total))
                    .collect::<Result<_, String>>()?,
            )),
            other => Ok(other.clone()),
        }
    }
    history
        .iter()
        .map(|value| {
            hydrate(
                value,
                0,
                (data, &parts),
                &mut directory,
                &mut count,
                &mut total,
            )
        })
        .collect()
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    const JPEG:&str="/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDy6iiivWPMP//Z";
    const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
    const GIF: &str = "R0lGODdhAQABAIEAABE1WwAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==";
    const WEBP: &str =
        "UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoBAAEAAUAmJZACdLoAA5gA/vl9v/V2J8KEE/jdlnDdIAAA";
    #[test]
    fn signatures_framing_and_mime_agree() {
        for (mime, encoded) in [
            ("image/png", PNG),
            ("image/jpeg", JPEG),
            ("image/gif", GIF),
            ("image/webp", WEBP),
        ] {
            let bytes = STANDARD.decode(encoded).unwrap();
            assert!(validate_image(mime, &bytes).is_ok(), "{mime}");
            for other in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
                if other != mime {
                    assert!(validate_image(other, &bytes).is_err());
                }
            }
            assert!(validate_image(mime, &bytes[..bytes.len() - 1]).is_err());
        }
    }
    #[test]
    fn invalid_dimensions_and_framing_are_rejected_without_pixel_decoding() {
        let mut png = STANDARD.decode(PNG).unwrap();
        png[16..20].copy_from_slice(&32_768u32.to_be_bytes());
        png[20..24].copy_from_slice(&32_768u32.to_be_bytes());
        assert!(validate_image("image/png", &png).is_err());
        let mut webp = STANDARD.decode(WEBP).unwrap();
        webp[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_image("image/webp", &webp).is_err());
        let mut gif = STANDARD.decode(GIF).unwrap();
        gif[6..8].copy_from_slice(&0u16.to_le_bytes());
        assert!(validate_image("image/gif", &gif).is_err());
        assert!(validate_image("image/svg+xml", b"<svg/>").is_err());
    }
    #[test]
    fn truncated_and_arbitrary_containers_never_panic() {
        for (mime, encoded) in [
            ("image/png", PNG),
            ("image/jpeg", JPEG),
            ("image/gif", GIF),
            ("image/webp", WEBP),
        ] {
            let bytes = STANDARD.decode(encoded).unwrap();
            for length in 0..bytes.len() {
                let _ = validate_image(mime, &bytes[..length]);
            }
            let mut arbitrary = bytes.clone();
            for index in 0..arbitrary.len() {
                arbitrary[index] = 255;
                let _ = validate_image(mime, &arbitrary);
            }
        }
    }
    #[test]
    fn typed_ids_are_full_lowercase_content_hashes() {
        let bytes = STANDARD.decode(PNG).unwrap();
        let id = image_id("image/png", &bytes);
        assert!(valid_id(&id));
        assert_ne!(id, image_id("image/gif", &bytes));
        assert_ne!(id, image_id("image/png", b"other"));
        for invalid in ["../image", "ABCDEF", "", &"g".repeat(64)] {
            assert!(!valid_id(invalid));
        }
    }
}

#[cfg(test)]
mod filesystem_tests {
    use super::*;
    const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
    fn artifact_path(
        data: &Path,
        owner: &str,
        workspace: &Path,
        session: &str,
        marker: &Value,
    ) -> PathBuf {
        scope_parts(owner, workspace, session)
            .unwrap()
            .into_iter()
            .fold(data.to_path_buf(), |path, part| path.join(part))
            .join(format!("{}.png", marker["artifactId"].as_str().unwrap()))
    }
    #[test]
    fn stored_marker_hydrates_only_in_its_account_workspace_and_session() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let marker = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        assert_eq!(marker.as_object().unwrap().len(), 3);
        assert_eq!(
            hydrate_history(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                &[marker.clone()]
            )
            .unwrap(),
            vec![json!({"type":"image","mimeType":"image/png","data":PNG})]
        );
        assert!(hydrate_history(
            data.path(),
            "other",
            workspace.path(),
            &session,
            &[marker.clone()]
        )
        .is_err());
        assert!(hydrate_history(
            data.path(),
            "owner",
            &workspace.path().join("other"),
            &session,
            &[marker.clone()]
        )
        .is_err());
        assert!(hydrate_history(
            data.path(),
            "owner",
            workspace.path(),
            &uuid::Uuid::new_v4().to_string(),
            &[marker]
        )
        .is_err());
    }
    #[test]
    fn plain_history_does_not_create_or_read_storage_and_only_exact_markers_hydrate() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &[]).unwrap(),
            Vec::<Value>::new()
        );
        let plain = vec![
            json!({"type":"v4_image","artifactId":"../../private","mimeType":"image/png","extra":true}),
            json!({"type":"image","data":"literal","path":"/private/not-read"}),
        ];
        assert_eq!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &plain).unwrap(),
            plain
        );
        assert!(!data.path().join("v4-agent-artifacts").exists());
        for id in ["../../private", "g000", "/etc/passwd"] {
            assert!(hydrate_history(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                &[json!({"type":"v4_image","artifactId":id,"mimeType":"image/png"})]
            )
            .is_err());
        }
    }
    #[test]
    fn nested_markers_hydrate_and_tampering_or_mime_substitution_fails() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let marker = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        let path = artifact_path(data.path(), "owner", workspace.path(), &session, &marker);
        let history = vec![
            json!({"role":"tool","result":{"content":[{"type":"text","text":"Screenshot"},marker.clone()]}}),
        ];
        assert_eq!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &history).unwrap()[0]
                ["result"]["content"][1]["data"],
            PNG
        );
        let mut wrong = marker.clone();
        wrong["mimeType"] = json!("image/gif");
        assert!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &[wrong]).is_err()
        );
        let mut bytes = STANDARD.decode(PNG).unwrap();
        bytes[40] ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &[marker])
                .unwrap_err()
                .contains("integrity")
        );
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG
        )
        .is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn invalid_scope_encoding_and_image_sizes_create_no_artifacts() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        for owner in ["", "bad\nowner"] {
            assert!(store_image(
                data.path(),
                owner,
                workspace.path(),
                &session,
                "image/png",
                PNG
            )
            .is_err());
        }
        for path in [Path::new("relative"), Path::new("/safe/../private")] {
            assert!(store_image(data.path(), "owner", path, &session, "image/png", PNG).is_err());
        }
        for id in ["../../out", "", "not-a-uuid"] {
            assert!(
                store_image(data.path(), "owner", workspace.path(), id, "image/png", PNG).is_err()
            );
        }
        for encoded in ["not base64", "data:image/png;base64,AAAA", "AAAA\n", ""] {
            assert!(store_image(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                "image/png",
                encoded
            )
            .is_err());
        }
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            &"A".repeat(IMAGE_BYTES.div_ceil(3) * 4 + 1)
        )
        .is_err());
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            &STANDARD.encode(vec![0; IMAGE_BYTES + 1])
        )
        .is_err());
        assert!(!data.path().join("v4-agent-artifacts").exists());
    }
    #[test]
    fn repeated_store_is_deduplicated_and_atomic_with_private_files() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let first = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        let second = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        assert_eq!(first, second);
        let path = artifact_path(data.path(), "owner", workspace.path(), &session, &first);
        let entries: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries.len(), 2);
        assert!(entries.contains(&".write.lock".into()));
        assert!(!entries.iter().any(|name| name.ends_with(".tmp")));
        assert_eq!(std::fs::read(&path).unwrap(), STANDARD.decode(PNG).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let mut parent = path.parent().unwrap();
            for _ in 0..4 {
                assert_eq!(
                    std::fs::metadata(parent).unwrap().permissions().mode() & 0o777,
                    0o700
                );
                parent = parent.parent().unwrap();
            }
        }
    }
    #[test]
    fn hydration_enforces_count_and_recursion_bounds() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let marker = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        assert_eq!(
            hydrate_history(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                &vec![marker.clone(); HYDRATED_IMAGES]
            )
            .unwrap()
            .len(),
            HYDRATED_IMAGES
        );
        assert!(hydrate_history(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            &vec![marker; HYDRATED_IMAGES + 1]
        )
        .unwrap_err()
        .contains("too many"));
        let mut value = json!(null);
        for _ in 0..MAX_DEPTH + 2 {
            value = json!([value]);
        }
        assert!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &[value]).is_err()
        );
    }
    #[test]
    fn decoded_hydration_bytes_are_bounded_even_for_repeated_references() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let original = STANDARD.decode(PNG).unwrap();
        let split = original.len() - 12;
        let mut bytes = original[..split].to_vec();
        let filler = IMAGE_BYTES - original.len() - 12;
        bytes.extend_from_slice(&(filler as u32).to_be_bytes());
        bytes.extend_from_slice(b"tEXt");
        bytes.resize(bytes.len() + filler, b'a');
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&original[split..]);
        assert_eq!(bytes.len(), IMAGE_BYTES);
        let marker = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            &STANDARD.encode(bytes),
        )
        .unwrap();
        assert_eq!(
            hydrate_history(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                &[marker.clone(), marker.clone()]
            )
            .unwrap()
            .len(),
            2
        );
        assert!(hydrate_history(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            &[marker.clone(), marker.clone(), marker]
        )
        .unwrap_err()
        .contains("byte limit"));
    }
    #[test]
    fn disk_count_and_byte_quotas_prevent_another_publish() {
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        for byte_quota in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let parts = scope_parts("owner", workspace.path(), &session).unwrap();
            let directory = Directory::open(data.path(), &parts, true).unwrap();
            if byte_quota {
                directory
                    .open_file("existing.png", true, true)
                    .unwrap()
                    .set_len(SESSION_BYTES)
                    .unwrap();
            } else {
                for index in 0..SESSION_IMAGES {
                    directory
                        .open_file(&format!("existing-{index}.png"), true, true)
                        .unwrap();
                }
            }
            assert!(store_image(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                "image/png",
                PNG
            )
            .unwrap_err()
            .contains("full"));
            let id = image_id("image/png", &STANDARD.decode(PNG).unwrap());
            assert!(directory.read_file(&format!("{id}.png")).unwrap().is_none());
        }
    }
    #[cfg(unix)]
    #[test]
    fn writer_guard_releases_lock_even_when_a_descriptor_is_inherited() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let directory = Directory::open(
            data.path(),
            &scope_parts("owner", workspace.path(), &session).unwrap(),
            true,
        )
        .unwrap();
        let guard = directory.write_lock().unwrap();
        let file = directory.open_file(".write.lock", false, false).unwrap();
        // dup shares the open file description, just like fork before exec.
        let inherited_fd = unsafe { libc::dup(guard.as_raw_fd()) };
        assert!(inherited_fd >= 0);
        let inherited = unsafe { File::from_raw_fd(inherited_fd) };
        assert!(
            directory.write_lock().is_err(),
            "a live writer must exclude independent writers"
        );
        drop(guard);
        assert_eq!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0,
            "parent guard must release its lock while an inherited descriptor is still alive"
        );
        drop(inherited);
    }

    #[cfg(unix)]
    #[test]
    fn active_writer_lock_returns_a_retryable_error_without_partial_files() {
        use std::os::fd::AsRawFd;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let directory = Directory::open(
            data.path(),
            &scope_parts("owner", workspace.path(), &session).unwrap(),
            true,
        )
        .unwrap();
        let lock = directory.open_file(".write.lock", true, false).unwrap();
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG
        )
        .unwrap_err()
        .contains("busy"));
        assert_eq!(directory.names().unwrap(), vec![".write.lock"]);
        drop(lock);
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG
        )
        .is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_namespace_intermediate_leaf_and_lock_are_rejected() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let external = tempfile::tempdir().unwrap();
        let original = STANDARD.decode(PNG).unwrap();
        for index in 0..4 {
            let data = tempfile::tempdir().unwrap();
            let parts = scope_parts("owner", workspace.path(), &session).unwrap();
            let mut directory = data.path().to_path_buf();
            for part in &parts[..index] {
                directory.push(part);
                std::fs::create_dir(&directory).unwrap();
            }
            symlink(external.path(), directory.join(&parts[index])).unwrap();
            assert!(store_image(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                "image/png",
                PNG
            )
            .is_err());
            assert!(std::fs::read_dir(external.path()).unwrap().next().is_none());
        }
        let data = tempfile::tempdir().unwrap();
        let marker = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        let path = artifact_path(data.path(), "owner", workspace.path(), &session, &marker);
        std::fs::remove_file(&path).unwrap();
        let target = external.path().join("private.png");
        std::fs::write(&target, &original).unwrap();
        symlink(&target, &path).unwrap();
        assert!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &[marker]).is_err()
        );
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG
        )
        .is_err());
        assert_eq!(std::fs::read(&target).unwrap(), original);
        std::fs::remove_file(&path).unwrap();
        let lock = path.parent().unwrap().join(".write.lock");
        std::fs::remove_file(&lock).unwrap();
        symlink(&target, &lock).unwrap();
        assert!(store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG
        )
        .is_err());
    }
}

#[cfg(test)]
mod batch_filesystem_tests {
    use super::*;
    const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
    const GIF: &str = "R0lGODdhAQABAIEAABE1WwAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==";
    fn image(mime: &str, encoded: &str) -> (String, String) {
        (mime.into(), encoded.into())
    }
    fn artifact_names(directory: &Directory) -> Vec<String> {
        let mut names = directory.names().unwrap();
        names.retain(|name| name != ".write.lock");
        names.sort();
        names
    }
    #[test]
    fn empty_batch_does_not_touch_missing_storage() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            store_images(&missing, "owner", workspace.path(), &session, &[]).unwrap(),
            Vec::<Value>::new()
        );
        assert!(!missing.exists());
    }
    #[test]
    fn invalid_ninth_or_later_image_cannot_publish_an_earlier_image() {
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        for images in [
            vec![image("image/png", PNG), image("image/gif", "invalid")],
            vec![image("image/png", PNG); 9],
            vec![image("image/png", PNG), image("image/svg+xml", "PHN2Zy8+")],
        ] {
            let data = tempfile::tempdir().unwrap();
            assert!(
                store_images(data.path(), "owner", workspace.path(), &session, &images).is_err()
            );
            assert!(!data.path().join("v4-agent-artifacts").exists());
        }
    }
    #[test]
    fn successful_batch_preserves_order_and_publishes_duplicate_bytes_once() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let markers = store_images(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            &[
                image("image/png", PNG),
                image("image/gif", GIF),
                image("image/png", PNG),
            ],
        )
        .unwrap();
        assert_eq!(markers.len(), 3);
        assert_eq!(markers[0], markers[2]);
        assert_eq!(markers[1]["mimeType"], "image/gif");
        let directory = Directory::open(
            data.path(),
            &scope_parts("owner", workspace.path(), &session).unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(artifact_names(&directory).len(), 2);
        assert_eq!(
            hydrate_history(data.path(), "owner", workspace.path(), &session, &markers).unwrap()[1]
                ["data"],
            GIF
        );
    }
    #[test]
    fn real_publish_conflict_rolls_back_only_files_created_in_this_batch() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let directory = Directory::open(
            data.path(),
            &scope_parts("owner", workspace.path(), &session).unwrap(),
            true,
        )
        .unwrap();
        let prepared = prepare_images(&[image("image/png", PNG), image("image/gif", GIF)]).unwrap();
        let mut existing = directory.open_file(&prepared[1].name, true, true).unwrap();
        existing.write_all(b"unrelated existing content").unwrap();
        existing.sync_all().unwrap();
        drop(existing);
        let before = artifact_names(&directory);
        let _lock = directory.write_lock().unwrap();
        assert!(directory
            .publish_new_files(&prepared.iter().collect::<Vec<_>>())
            .unwrap_err()
            .contains("without replacing"));
        assert_eq!(artifact_names(&directory), before);
        assert_eq!(
            directory.read_file(&prepared[1].name).unwrap().unwrap(),
            b"unrelated existing content"
        );
        assert!(directory.read_file(&prepared[0].name).unwrap().is_none());
    }
    #[test]
    fn aggregate_decoded_budget_is_checked_before_creating_storage() {
        let original = STANDARD.decode(PNG).unwrap();
        let split = original.len() - 12;
        let mut bytes = original[..split].to_vec();
        let filler = IMAGE_BYTES - original.len() - 12;
        bytes.extend_from_slice(&(filler as u32).to_be_bytes());
        bytes.extend_from_slice(b"tEXt");
        bytes.resize(bytes.len() + filler, b'a');
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&original[split..]);
        let encoded = STANDARD.encode(bytes);
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert!(store_images(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            &vec![image("image/png", &encoded); 3]
        )
        .unwrap_err()
        .contains("16 MiB"));
        assert!(!data.path().join("v4-agent-artifacts").exists());
    }
    #[test]
    fn full_disk_count_still_allows_an_entirely_existing_deduplicated_batch() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let marker = store_image(
            data.path(),
            "owner",
            workspace.path(),
            &session,
            "image/png",
            PNG,
        )
        .unwrap();
        let directory = Directory::open(
            data.path(),
            &scope_parts("owner", workspace.path(), &session).unwrap(),
            false,
        )
        .unwrap();
        for index in 0..SESSION_IMAGES - 1 {
            directory
                .open_file(&format!("existing-{index}.png"), true, true)
                .unwrap();
        }
        let before = artifact_names(&directory);
        assert_eq!(
            store_images(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                &[image("image/png", PNG), image("image/png", PNG)]
            )
            .unwrap(),
            vec![marker.clone(), marker]
        );
        assert_eq!(artifact_names(&directory), before);
    }
    #[test]
    fn full_batch_quota_failure_leaves_no_additional_artifacts() {
        let workspace = tempfile::tempdir().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        for bytes_full in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let directory = Directory::open(
                data.path(),
                &scope_parts("owner", workspace.path(), &session).unwrap(),
                true,
            )
            .unwrap();
            if bytes_full {
                directory
                    .open_file("existing.png", true, true)
                    .unwrap()
                    .set_len(SESSION_BYTES - 70)
                    .unwrap();
            } else {
                for index in 0..SESSION_IMAGES - 1 {
                    directory
                        .open_file(&format!("existing-{index}.png"), true, true)
                        .unwrap();
                }
            }
            let before = artifact_names(&directory);
            assert!(store_images(
                data.path(),
                "owner",
                workspace.path(),
                &session,
                &[image("image/png", PNG), image("image/gif", GIF)]
            )
            .is_err());
            assert_eq!(artifact_names(&directory), before);
        }
    }
}

// A publication guard keeps new immutable files distinguishable from pre-existing
// deduplicated objects until the authoritative structured snapshot is committed.
pub(super) struct ImagePublication {
    directory: Directory,
    _lock: WriteLock,
    _lifetime: File,
    created: Vec<PreparedImage>,
    committed: bool,
}
impl ImagePublication {
    pub(super) fn begin(
        data: &Path,
        owner: &str,
        workspace: &Path,
        session: &str,
        images: &[(String, String)],
    ) -> Result<Self, String> {
        let prepared = prepare_images(images)?;
        let lifetime = super::session_store::image_writer_lease(data, owner, workspace, session)?;
        let directory = Directory::open(data, &scope_parts(owner, workspace, session)?, true)?;
        let lock = directory.write_lock()?;
        let mut seen = std::collections::HashSet::new();
        let mut created = Vec::new();
        for image in &prepared {
            if seen.insert(image.name.clone()) && directory.read_file(&image.name)?.is_none() {
                created.push(PreparedImage {
                    name: image.name.clone(),
                    marker: image.marker.clone(),
                    bytes: image.bytes.clone(),
                });
            }
        }
        directory.store_batch_locked(&prepared)?;
        Ok(Self {
            directory,
            _lock: lock,
            _lifetime: lifetime,
            created,
            committed: false,
        })
    }
    pub(super) fn commit(mut self) {
        self.committed = true;
    }
    pub(super) fn rollback(mut self) -> Result<(), String> {
        for image in self.created.iter().rev() {
            self.directory.remove_new_file(image)?;
        }
        self.directory.sync()?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for ImagePublication {
    fn drop(&mut self) {
        if !self.committed {
            for image in self.created.iter().rev() {
                let _ = self.directory.remove_new_file(image);
            }
            let _ = self.directory.sync();
        }
    }
}
impl Directory {
    pub(super) fn sync(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            self.file
                .sync_all()
                .map_err(|_| "Cannot persist private image directory".into())
        }
        #[cfg(not(unix))]
        {
            Ok(())
        }
    }
    pub(super) fn write_metadata(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if name != "registry.json" || bytes.len() > 1_048_576 {
            return Err("Invalid image registry publication".into());
        }
        // Existing targets must be regular, bounded files. Opening them never
        // follows a symlink, even before an atomic rename replaces the entry.
        self.read_file(name)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let temporary = format!(".registry.{}.tmp", uuid::Uuid::new_v4());
            let result = (|| {
                let mut file = self
                    .open_file(&temporary, true, true)
                    .map_err(|_| "Cannot prepare image registry")?;
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "Cannot persist image registry")?;
                let source = c_name(&temporary)?;
                let target = c_name(name)?;
                if unsafe {
                    libc::renameat(
                        self.file.as_raw_fd(),
                        source.as_ptr(),
                        self.file.as_raw_fd(),
                        target.as_ptr(),
                    )
                } != 0
                {
                    return Err("Cannot publish image registry".into());
                }
                #[cfg(test)]
                image_registry_test_after_rename(self, bytes)?;
                self.sync()
            })();
            let cleanup = self.unlink(&temporary);
            result.and(cleanup)
        }
        #[cfg(not(unix))]
        {
            let mut file = tempfile::NamedTempFile::new_in(&self.path)
                .map_err(|_| "Cannot prepare image registry")?;
            file.write_all(bytes)
                .and_then(|_| file.as_file().sync_all())
                .map_err(|_| "Cannot persist image registry")?;
            file.persist(self.path.join(name))
                .map_err(|_| "Cannot publish image registry")?;
            Ok(())
        }
    }
}

#[cfg(test)]
static IMAGE_REGISTRY_POST_RENAME_FAULTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::OnceLock::new();
#[cfg(test)]
pub(super) fn image_registry_fail_after_rename_once(session: &str) {
    IMAGE_REGISTRY_POST_RENAME_FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(session.into());
}
#[cfg(test)]
fn image_registry_test_after_rename(directory: &Directory, bytes: &[u8]) -> Result<(), String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid registry test fixture")?;
    let session = value["sessionId"]
        .as_str()
        .ok_or("Missing registry test scope")?;
    let first_fault = IMAGE_REGISTRY_POST_RENAME_FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(session);
    let (watched, nth_fault) = {
        let mut faults = IMAGE_REGISTRY_NTH_PUBLICATION_FAULTS
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        if let Some(remaining) = faults.get_mut(session) {
            *remaining -= 1;
            let hit = *remaining == 0;
            if hit {
                faults.remove(session);
            }
            (true, hit)
        } else {
            (false, false)
        }
    };
    if first_fault || watched {
        let mut entries = serde_json::Map::new();
        for (id, entry) in value["entries"]
            .as_object()
            .ok_or("Invalid test registry entries")?
        {
            let image = &entry["attachment"];
            let name = format!(
                "{}.{}",
                image["artifactId"]
                    .as_str()
                    .ok_or("Missing image test hash")?,
                extension(
                    image["mimeType"]
                        .as_str()
                        .ok_or("Missing image test MIME")?
                )?
            );
            entries.insert(id.clone(),json!({"state":entry["state"],"imagePresent":directory.open_file(&name,false,false).is_ok()}));
        }
        let observation = json!({"entries":entries});
        IMAGE_REGISTRY_POST_RENAME_OBSERVATIONS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(session.into(), observation.clone());
        IMAGE_REGISTRY_PUBLICATION_HISTORY
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entry(session.into())
            .or_default()
            .push(observation);
    }
    if first_fault || nth_fault {
        Err(
            "Synthetic failure after registry rename, before directory durability confirmation"
                .into(),
        )
    } else {
        Ok(())
    }
}
#[cfg(test)]
static IMAGE_REGISTRY_POST_RENAME_OBSERVATIONS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Value>>,
> = std::sync::OnceLock::new();
#[cfg(test)]
pub(super) fn image_registry_take_post_rename_observation(session: &str) -> Option<Value> {
    IMAGE_REGISTRY_POST_RENAME_OBSERVATIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(session)
}
#[cfg(test)]
static IMAGE_REGISTRY_NTH_PUBLICATION_FAULTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, usize>>,
> = std::sync::OnceLock::new();
#[cfg(test)]
static IMAGE_REGISTRY_PUBLICATION_HISTORY: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<Value>>>,
> = std::sync::OnceLock::new();
#[cfg(test)]
pub(super) fn image_registry_fail_after_rename_nth(session: &str, nth: usize) {
    assert!((1..=8).contains(&nth));
    IMAGE_REGISTRY_NTH_PUBLICATION_FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(session.into(), nth);
    IMAGE_REGISTRY_PUBLICATION_HISTORY
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(session.into(), Vec::new());
}
#[cfg(test)]
pub(super) fn image_registry_take_post_rename_observations(session: &str) -> Vec<Value> {
    IMAGE_REGISTRY_PUBLICATION_HISTORY
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(session)
        .unwrap_or_default()
}

impl Directory {
    pub(super) fn open_optional(data: &Path, parts: &[String; 4]) -> Result<Option<Self>, String> {
        if !data.is_absolute() {
            return Err("Image data root must be absolute".into());
        }
        let metadata =
            std::fs::symlink_metadata(data).map_err(|_| "Image data root is unavailable")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Image data root is unavailable or symlinked".into());
        }
        #[cfg(unix)]
        {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::OpenOptionsExt,
            };
            let canonical = data
                .canonicalize()
                .map_err(|_| "Image data root is unavailable")?;
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(canonical)
                .map_err(|_| "Image data root is unavailable")?;
            for part in parts {
                let name = c_name(part)?;
                let fd = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return match std::io::Error::last_os_error().kind() {
                        std::io::ErrorKind::NotFound => Ok(None),
                        _ => Err("Image scope is unavailable or symlinked".into()),
                    };
                }
                file = unsafe { File::from_raw_fd(fd) };
            }
            Ok(Some(Self { file }))
        }
        #[cfg(not(unix))]
        {
            if is_reparse(&metadata) {
                return Err("Image data root is unavailable or reparse-pointed".into());
            }
            let mut path = data.to_path_buf();
            for part in parts {
                path.push(part);
                match std::fs::symlink_metadata(&path) {
                    Ok(metadata) if !metadata.is_dir() || is_reparse(&metadata) => {
                        return Err("Image scope is unavailable or reparse-pointed".into())
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(_) => return Err("Cannot inspect private image scope".into()),
                }
            }
            Self::open(data, parts, false).map(Some)
        }
    }
}
pub(super) fn clear_image_scope(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
) -> Result<(), String> {
    let Some(directory) = Directory::open_optional(data, &scope_parts(owner, workspace, session)?)?
    else {
        return Ok(());
    };
    let _lock = directory.write_lock()?;
    let mut names = Vec::new();
    for name in directory.names()? {
        if name == ".write.lock" {
            continue;
        }
        let (id, ext) = name
            .rsplit_once('.')
            .ok_or("Unexpected immutable image directory entry")?;
        let mime = match ext {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => return Err("Unexpected immutable image directory entry".into()),
        };
        if !valid_id(id) {
            return Err("Unexpected immutable image directory entry".into());
        }
        let bytes = directory
            .read_file(&name)?
            .ok_or("Image disappeared during scoped retirement")?;
        if image_id(mime, &bytes) != id {
            return Err("Image integrity changed during scoped retirement".into());
        }
        names.push(name);
    }
    for name in names {
        directory.unlink(&name)?;
    }
    directory.sync()
}
