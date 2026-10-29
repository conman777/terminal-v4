use super::{compaction::Receipt, Message, Session};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub(super) const HEAD_BYTES: usize = 2_000_000;
const TAIL_BYTES: usize = 128_000;
const OBJECT_BYTES: usize = 24_000_000;
const TRANSCRIPT_BYTES: usize = 64_000_000;
const ARCHIVE_BYTES: u64 = 256_000_000;
const PARTS: usize = 1_024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub(super) struct Metadata {
    pub version: u8,
    pub revision: u64,
    pub archived_messages: usize,
    pub transcript: Vec<TranscriptPart>,
    pub archive_bytes: u64,
    pub last_compaction: Option<String>,
    pub continuation: Option<ContinuationPart>,
    pub usage: Option<super::compaction::UsageSnapshot>,
    pub recovery_marker: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TranscriptPart {
    pub id: String,
    pub count: usize,
    pub bytes: usize,
}
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct ContinuationPart {
    pub id: String,
    pub bytes: usize,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryArchive {
    pub receipt: Receipt,
    pub history: Vec<serde_json::Value>,
    pub after_history_hash: String,
    pub after_history_len: usize,
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 180
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        && value != "."
        && value != ".."
}
fn failure() -> String {
    "V4 session storage is unavailable or contains an unsafe path".into()
}

struct Directory {
    #[cfg(unix)]
    file: File,
    #[cfg(not(unix))]
    path: std::path::PathBuf,
}
impl Directory {
    fn open(data: &Path, parts: &[String], create: bool) -> Result<Self, String> {
        if !data.is_absolute() {
            return Err(failure());
        }
        let metadata = std::fs::symlink_metadata(data).map_err(|_| failure())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
            return Err(failure());
        }
        let root = data.canonicalize().map_err(|_| failure())?;
        #[cfg(unix)]
        {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::OpenOptionsExt,
            };
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(root)
                .map_err(|_| failure())?;
            for part in parts {
                if !valid_name(part) {
                    return Err(failure());
                }
                let name = std::ffi::CString::new(part.as_str()).map_err(|_| failure())?;
                if create
                    && unsafe { libc::mkdirat(file.as_raw_fd(), name.as_ptr(), 0o700) } != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(failure());
                }
                let fd = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(failure());
                }
                file = unsafe { File::from_raw_fd(fd) };
                if create {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(std::fs::Permissions::from_mode(0o700))
                        .map_err(|_| failure())?;
                }
            }
            Ok(Self { file })
        }
        #[cfg(not(unix))]
        {
            let mut path = root;
            for part in parts {
                if !valid_name(part) {
                    return Err(failure());
                }
                path.push(part);
                if create {
                    match std::fs::create_dir(&path) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(_) => return Err(failure()),
                    }
                }
                let metadata = std::fs::symlink_metadata(&path).map_err(|_| failure())?;
                if !metadata.is_dir() || is_reparse(&metadata) {
                    return Err(failure());
                }
            }
            Ok(Self { path })
        }
    }
    fn file(&self, name: &str, create: bool, exclusive: bool) -> std::io::Result<File> {
        if !valid_name(name) {
            return Err(std::io::Error::other("Invalid session object name"));
        }
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(name).map_err(std::io::Error::other)?;
            let flags = if create {
                libc::O_RDWR | libc::O_CREAT
            } else {
                libc::O_RDONLY
            };
            let fd = unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    flags
                        | if exclusive { libc::O_EXCL } else { 0 }
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC
                        | libc::O_NONBLOCK,
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
            if std::fs::symlink_metadata(&path).is_ok_and(|m| is_reparse(&m)) {
                return Err(std::io::Error::other("Unsafe session file"));
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
            }
            let file = options.open(path)?;
            if is_reparse(&file.metadata()?) {
                return Err(std::io::Error::other("Unsafe session file"));
            }
            Ok(file)
        }
    }
    fn read(&self, name: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        let file = match self.file(name, false, false) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(failure()),
        };
        let metadata = file.metadata().map_err(|_| failure())?;
        if !metadata.is_file() || metadata.len() > limit as u64 || is_reparse(&metadata) {
            return Err(failure());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                return Err(failure());
            }
        }
        let mut content = Vec::with_capacity(metadata.len() as usize);
        file.take(limit as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|_| failure())?;
        if content.len() > limit {
            return Err("V4 session object exceeds its read limit".into());
        }
        Ok(Some(content))
    }
    fn lock(&self, name: &str) -> Result<File, String> {
        let file = self.file(name, true, false).map_err(|_| failure())?;
        let metadata = file.metadata().map_err(|_| failure())?;
        if !metadata.is_file() || metadata.len() != 0 || is_reparse(&metadata) {
            return Err(failure());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.nlink() != 1 {
                return Err(failure());
            }
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| failure())?;
        }
        file.try_lock()
            .map_err(|_| "V4 session is busy; retry after its current write".to_string())?;
        Ok(file)
    }
    fn image_lease(&self, shared: bool) -> Result<Option<File>, String> {
        let file = self
            .file(".image-lifetime.lock", true, false)
            .map_err(|_| failure())?;
        let metadata = file.metadata().map_err(|_| failure())?;
        if !metadata.is_file() || metadata.len() != 0 || is_reparse(&metadata) {
            return Err(failure());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.nlink() != 1 {
                return Err(failure());
            }
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| failure())?;
        }
        let result = if shared {
            file.try_lock_shared()
        } else {
            file.try_lock()
        };
        match result {
            Ok(()) => Ok(Some(file)),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(_)) => Err(failure()),
        }
    }
    fn remove(&self, name: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let name = std::ffi::CString::new(name).map_err(|_| failure())?;
            if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } == 0
                || std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
            {
                Ok(())
            } else {
                Err(failure())
            }
        }
        #[cfg(not(unix))]
        {
            match std::fs::remove_file(self.path.join(name)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(failure()),
            }
        }
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let from = std::ffi::CString::new(from).map_err(|_| failure())?;
            let to = std::ffi::CString::new(to).map_err(|_| failure())?;
            if unsafe {
                libc::renameat(
                    self.file.as_raw_fd(),
                    from.as_ptr(),
                    self.file.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(failure());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            std::fs::rename(self.path.join(from), self.path.join(to)).map_err(|_| failure())
        }
    }
    fn sync(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            self.file.sync_all().map_err(|_| failure())?;
        }
        Ok(())
    }
    fn create(&self, name: &str, content: &[u8]) -> Result<(), String> {
        let mut file = self.file(name, true, true).map_err(|_| failure())?;
        if file
            .write_all(content)
            .and_then(|_| file.sync_all())
            .is_err()
        {
            let _ = self.remove(name);
            return Err(failure());
        }
        Ok(())
    }
    fn names(&self) -> Result<Vec<String>, String> {
        #[cfg(unix)]
        {
            use std::{ffi::CStr, os::fd::AsRawFd};
            let fd = unsafe { libc::dup(self.file.as_raw_fd()) };
            if fd < 0 {
                return Err(failure());
            }
            let stream = unsafe { libc::fdopendir(fd) };
            if stream.is_null() {
                unsafe { libc::close(fd) };
                return Err(failure());
            }
            unsafe { libc::rewinddir(stream) };
            let result = (|| {
                let mut names = Vec::new();
                loop {
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
                    }
                    let item = unsafe { libc::readdir(stream) };
                    if item.is_null() {
                        #[cfg(any(
                            target_os = "linux",
                            target_os = "android",
                            target_os = "macos",
                            target_os = "ios"
                        ))]
                        if unsafe { *errno } != 0 {
                            return Err(failure());
                        }
                        break;
                    }
                    let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }
                        .to_str()
                        .map_err(|_| failure())?;
                    if name == "." || name == ".." {
                        continue;
                    }
                    if names.len() >= 4_096 {
                        return Err("V4 archive reached its physical object limit".into());
                    }
                    names.push(name.to_owned());
                }
                Ok(names)
            })();
            unsafe { libc::closedir(stream) };
            result
        }
        #[cfg(not(unix))]
        {
            let mut names = Vec::new();
            for entry in std::fs::read_dir(&self.path).map_err(|_| failure())? {
                if names.len() >= 4_096 {
                    return Err("V4 archive reached its physical object limit".into());
                }
                names.push(
                    entry
                        .map_err(|_| failure())?
                        .file_name()
                        .into_string()
                        .map_err(|_| failure())?,
                );
            }
            Ok(names)
        }
    }
    fn reserve(&self, additional: usize) -> Result<(), String> {
        let mut bytes = 0u64;
        for name in self.names()? {
            let file = self.file(&name, false, false).map_err(|_| failure())?;
            let metadata = file.metadata().map_err(|_| failure())?;
            if !metadata.is_file() || is_reparse(&metadata) {
                return Err(failure());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(failure());
                }
            }
            bytes = bytes
                .checked_add(metadata.len())
                .ok_or("V4 physical archive quota exceeded")?;
            if bytes > ARCHIVE_BYTES {
                return Err("V4 physical archive quota exceeded".into());
            }
        }
        if bytes
            .checked_add(additional as u64)
            .is_none_or(|bytes| bytes > ARCHIVE_BYTES)
        {
            return Err("V4 physical archive quota exceeded; existing history was retained".into());
        }
        Ok(())
    }
    fn object(&self, content: &[u8], created: &mut Vec<String>) -> Result<String, String> {
        if content.len() > OBJECT_BYTES {
            return Err("V4 archive object exceeds24 MB".into());
        }
        let id = digest(content);
        let name = format!("{id}.json");
        match self.read(&name, OBJECT_BYTES)? {
            Some(existing) if existing == content => return Ok(id),
            Some(_) => return Err("V4 archive failed its integrity check".into()),
            None => {}
        }
        self.reserve(content.len())?;
        let temp = format!(".{}.object.tmp", uuid::Uuid::new_v4());
        self.create(&temp, content)?;
        if let Err(error) = self.rename(&temp, &name) {
            let _ = self.remove(&temp);
            return Err(error);
        }
        created.push(name);
        self.sync()?;
        Ok(id)
    }
    fn replace(&self, name: &str, content: &[u8]) -> Result<(), String> {
        let temp = format!(".{}.tmp", uuid::Uuid::new_v4());
        let backup = format!(".{}.backup", uuid::Uuid::new_v4());
        let original = self.read(name, HEAD_BYTES)?;
        if let Some(original) = &original {
            self.create(&backup, original)?;
        }
        let result = (|| {
            self.create(&temp, content)?;
            self.sync()?;
            self.rename(&temp, name)?;
            if let Err(error) = self.sync() {
                let rollback = if original.is_some() {
                    self.rename(&backup, name)
                } else {
                    self.remove(name)
                };
                if rollback.is_err() {
                    return Err(
                        "V4 history commit durability is uncertain; reload the session".into(),
                    );
                }
                if self.sync().is_err() {
                    return Err(
                        "V4 history rollback durability is uncertain; reload the session".into(),
                    );
                }
                return Err(error);
            }
            Ok(())
        })();
        let _ = self.remove(&temp);
        let _ = self.remove(&backup);
        result
    }
}
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
fn scope(owner: &str, workspace: &Path, id: &str) -> Result<Vec<String>, String> {
    if owner.is_empty()
        || owner.len() > 512
        || owner.chars().any(char::is_control)
        || !workspace.is_absolute()
        || workspace.to_str().is_none()
    {
        return Err("Invalid V4 history scope".into());
    }
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| "Invalid V4 session ID")?
        .to_string();
    let normalized = crate::session_search::normalize_workspace_path(&workspace.to_string_lossy());
    Ok(vec![
        "v4-agent-history".into(),
        digest(owner),
        digest(normalized),
        id,
    ])
}
fn directories(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
    create: bool,
) -> Result<(Directory, Option<Directory>), String> {
    let mut parts = scope(owner, workspace, id)?;
    let session = parts.pop().unwrap();
    let head = Directory::open(data, &parts, create)?;
    parts.push(format!("{session}.objects"));
    let objects = if create {
        Some(Directory::open(data, &parts, true)?)
    } else {
        Directory::open(data, &parts, false).ok()
    };
    Ok((head, objects))
}
fn decode(content: &[u8], id: &str, workspace: &Path) -> Result<Session, String> {
    let session: Session = serde_json::from_slice(content).map_err(|_| "V4 history is invalid")?;
    if session.id != id
        || Path::new(&session.workspace) != workspace
        || !super::supports(&session.provider)
        || session.store.version > 1
        || session.store.transcript.len() > PARTS
    {
        return Err("V4 history scope or version is invalid".into());
    }
    Ok(session)
}
fn object(objects: &Directory, id: &str, limit: usize) -> Result<Vec<u8>, String> {
    if !valid_hash(id) {
        return Err("Invalid V4 archive reference".into());
    }
    let content = objects
        .read(&format!("{id}.json"), limit.min(OBJECT_BYTES))?
        .ok_or("V4 history archive is unavailable")?;
    if digest(&content) != id {
        return Err("V4 history archive failed its integrity check".into());
    }
    Ok(content)
}
fn materialize(mut session: Session, objects: Option<&Directory>) -> Result<Session, String> {
    if let Some(part) = &session.store.continuation {
        if !session.history.is_empty() {
            return Err("V4 continuation manifest is invalid".into());
        }
        let bytes = object(
            objects.ok_or("V4 continuation archive is unavailable")?,
            &part.id,
            part.bytes,
        )?;
        if bytes.len() != part.bytes {
            return Err("V4 continuation manifest is invalid".into());
        }
        session.history =
            serde_json::from_slice(&bytes).map_err(|_| "V4 continuation archive is invalid")?;
    }
    if session.store.transcript.is_empty() {
        if session.store.archived_messages != 0 {
            return Err("V4 transcript manifest is invalid".into());
        }
        return Ok(session);
    }
    let objects = objects.ok_or("V4 transcript archive is unavailable")?;
    let mut messages = Vec::new();
    let mut bytes = 0usize;
    for part in &session.store.transcript {
        bytes = bytes
            .checked_add(part.bytes)
            .ok_or("V4 transcript byte limit exceeded")?;
        if bytes > TRANSCRIPT_BYTES
            || part.count == 0
            || part.count > 100_000
            || messages.len() + part.count > 100_000
        {
            return Err("V4 transcript exceeds its retained limit".into());
        }
        let content = object(objects, &part.id, part.bytes)?;
        if content.len() != part.bytes {
            return Err("V4 transcript manifest is invalid".into());
        }
        let chunk: Vec<Message> =
            serde_json::from_slice(&content).map_err(|_| "V4 transcript archive is invalid")?;
        if chunk.len() != part.count {
            return Err("V4 transcript manifest is invalid".into());
        }
        messages.extend(chunk);
    }
    if messages.len() != session.store.archived_messages {
        return Err("V4 transcript manifest count is invalid".into());
    }
    messages.append(&mut session.messages);
    session.messages = messages;
    Ok(session)
}
pub(super) fn load(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
) -> Result<Session, String> {
    let (head, objects) = directories(data, owner, workspace, id, false)?;
    ensure_live(&head, id)?;
    let content = head
        .read(&format!("{id}.json"), HEAD_BYTES)?
        .ok_or("V4 session is unavailable for this account and workspace")?;
    materialize(decode(&content, id, workspace)?, objects.as_ref())
}
fn ensure_live(head: &Directory, id: &str) -> Result<(), String> {
    if head.read(&format!("{id}.deleted"), 4_096)?.is_some() {
        return Err("V4 conversation was deleted".into());
    }
    Ok(())
}
pub(super) fn visible_from_path(
    data: &Path,
    path: &Path,
    budget: usize,
) -> Result<(Session, usize, String), String> {
    let relative = path
        .strip_prefix(data)
        .map_err(|_| "Invalid V4 history location")?;
    let parts = relative
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .map(str::to_owned)
                .ok_or("Invalid V4 history path")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parts.len() != 4
        || parts[0] != "v4-agent-history"
        || !valid_hash(&parts[1])
        || !valid_hash(&parts[2])
    {
        return Err("Invalid V4 history location".into());
    }
    let id = parts[3]
        .strip_suffix(".json")
        .ok_or("Invalid V4 history filename")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid V4 session ID")?;
    let head = Directory::open(data, &parts[..3], false)?;
    ensure_live(&head, id)?;
    let content = head
        .read(&parts[3], HEAD_BYTES)?
        .ok_or("V4 conversation is unavailable")?;
    let value: serde_json::Value =
        serde_json::from_slice(&content).map_err(|_| "V4 history is invalid")?;
    let workspace = value["workspace"]
        .as_str()
        .filter(|value| value.len() <= 32_768 && !value.chars().any(char::is_control))
        .ok_or("V4 workspace is invalid")?;
    if !Path::new(workspace).is_absolute()
        || digest(crate::session_search::normalize_workspace_path(workspace)) != parts[2]
    {
        return Err("V4 history workspace scope is invalid".into());
    }
    let mut session = decode(&content, id, Path::new(workspace))?;
    let total = session
        .store
        .transcript
        .iter()
        .try_fold(content.len(), |total, part| {
            total
                .checked_add(part.bytes)
                .ok_or("V4 transcript byte limit exceeded")
        })?;
    if total > budget {
        return Err("App conversation exceeds remaining scan budget".into());
    }
    let mut object_parts = parts[..3].to_vec();
    object_parts.push(format!("{id}.objects"));
    let objects = Directory::open(data, &object_parts, false).ok();
    session.store.continuation = None;
    materialize(session, objects.as_ref()).map(|session| (session, total, digest(content)))
}
// This inode is never replaced/unlinked during scoped retirement. Artifact
// publication and history commit share one cooperative writer lifetime.
pub(super) fn image_writer_lease(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
) -> Result<File, String> {
    let (head, objects) = directories(data, owner, workspace, id, true)?;
    let lease = objects
        .ok_or_else(failure)?
        .image_lease(true)?
        .ok_or("V4 image history is busy; retry after collection or retirement")?;
    ensure_live(&head, id)?;
    Ok(lease)
}
pub(super) fn image_collection_lease(
    data: &Path,
    owner: &str,
    workspace: &Path,
    id: &str,
) -> Result<Option<File>, String> {
    let (_, objects) = directories(data, owner, workspace, id, true)?;
    objects.ok_or_else(failure)?.image_lease(false)
}
pub(super) fn delete(data: &Path, owner: &str, workspace: &Path, id: &str) -> Result<(), String> {
    let (head, objects) = directories(data, owner, workspace, id, true)?;
    let objects = objects.unwrap();
    let _lock = objects.lock(".write.lock")?;
    let name = format!("{id}.deleted");
    if head.read(&name, 4_096)?.is_none() {
        let tombstone = serde_json::to_vec(
            &serde_json::json!({"version":1,"sessionId":id,"deletedAt":crate::iso_timestamp()}),
        )
        .map_err(|_| "Cannot encode V4 deletion receipt")?;
        head.replace(&name, &tombstone)?;
    }
    head.remove(&format!("{id}.json"))?;
    head.sync()?;
    Ok(())
}

fn current(
    head: &Directory,
    objects: &Directory,
    session: &Session,
) -> Result<Option<Session>, String> {
    let Some(content) = head.read(&format!("{}.json", session.id), HEAD_BYTES)? else {
        return if session.store.revision == 0 {
            Ok(None)
        } else {
            Err("V4 conversation changed; reload before writing".into())
        };
    };
    let stored = decode(&content, &session.id, Path::new(&session.workspace))?;
    if stored.store.revision != session.store.revision {
        return Err("V4 conversation changed; reload before writing".into());
    }
    materialize(stored, Some(objects)).map(Some)
}
fn spill(
    candidate: &mut Session,
    objects: &Directory,
    created: &mut Vec<String>,
) -> Result<(), String> {
    let visible_bytes = serde_json::to_vec(&candidate.messages)
        .map_err(|_| "Cannot encode V4 transcript")?
        .len();
    if visible_bytes > TRANSCRIPT_BYTES || candidate.messages.len() > 100_000 {
        return Err(
            "V4 visible history reached its retained quota; start a new session; existing history remains available".into(),
        );
    }
    let start = candidate.store.archived_messages;
    if start > candidate.messages.len() {
        return Err("V4 transcript manifest is invalid".into());
    }
    if serde_json::to_vec(&candidate.messages[start..])
        .map_err(|_| "Cannot encode V4 transcript")?
        .len()
        <= TAIL_BYTES
    {
        return Ok(());
    }
    let mut end = candidate.messages.len();
    if let Some(last) = candidate.messages.last() {
        if serde_json::to_vec(last)
            .map_err(|_| "Cannot encode V4 message")?
            .len()
            < TAIL_BYTES / 2
        {
            end -= 1;
        }
    }
    let mut from = start;
    while from < end {
        let mut to = from + 1;
        let mut size = serde_json::to_vec(&candidate.messages[from])
            .map_err(|_| "Cannot encode V4 message")?
            .len();
        while to < end {
            let next = serde_json::to_vec(&candidate.messages[to])
                .map_err(|_| "Cannot encode V4 message")?
                .len();
            if size + next > TAIL_BYTES {
                break;
            }
            size += next;
            to += 1;
        }
        let content = serde_json::to_vec(&candidate.messages[from..to])
            .map_err(|_| "Cannot encode V4 transcript")?;
        let id = objects.object(&content, created)?;
        candidate.store.archive_bytes = candidate
            .store
            .archive_bytes
            .checked_add(content.len() as u64)
            .ok_or("V4 archive quota exceeded")?;
        candidate.store.transcript.push(TranscriptPart {
            id,
            count: to - from,
            bytes: content.len(),
        });
        from = to;
    }
    candidate.store.archived_messages = end;
    if candidate.store.transcript.len() > PARTS {
        return Err("V4 transcript reached its segment limit".into());
    }
    Ok(())
}
fn write_locked(
    head: &Directory,
    objects: &Directory,
    session: &Session,
    archive: Option<(&Session, &Receipt)>,
) -> Result<Session, String> {
    ensure_live(head, &session.id)?;
    let stored = current(head, objects, session)?;
    if let Some(stored) = &stored {
        let mut claimed = session.store.clone();
        claimed.usage = stored.store.usage.clone();
        claimed.recovery_marker = stored.store.recovery_marker.clone();
        if serde_json::to_value(&stored.store).map_err(|_| failure())?
            != serde_json::to_value(&claimed).map_err(|_| failure())?
        {
            return Err("V4 conversation storage lineage changed; reload before writing".into());
        }
        let archived = stored.store.archived_messages;
        if session.messages.len() < archived
            || stored.messages[..archived]
                .iter()
                .zip(&session.messages[..archived])
                .any(|(a, b)| a.role != b.role || a.text != b.text)
        {
            return Err("Archived V4 visible history cannot be overwritten".into());
        }
    }
    let mut candidate = session.clone();
    let mut created = Vec::new();
    let result = (|| {
        if let Some((before, receipt)) = archive {
            if stored.as_ref().is_none_or(|stored| {
                super::session_fingerprint(stored) != super::session_fingerprint(before)
            }) {
                return Err("V4 conversation changed during compaction; reload and retry".into());
            }
            let record = HistoryArchive {
                receipt: receipt.clone(),
                history: before.history.clone(),
                after_history_hash: digest(
                    serde_json::to_vec(&candidate.history).map_err(|_| failure())?,
                ),
                after_history_len: candidate.history.len(),
            };
            let content =
                serde_json::to_vec(&record).map_err(|_| "Cannot encode V4 compaction archive")?;
            let id = objects.object(&content, &mut created)?;
            candidate.store.archive_bytes = candidate
                .store
                .archive_bytes
                .checked_add(content.len() as u64)
                .ok_or("V4 archive quota exceeded")?;
            candidate.store.last_compaction = Some(id);
        }
        spill(&mut candidate, objects, &mut created)?;
        if candidate.store.archive_bytes > ARCHIVE_BYTES {
            return Err("V4 transcript and compaction archives reached their256 MB quota; start a new session; existing history remains available".into());
        }
        let history =
            serde_json::to_vec(&candidate.history).map_err(|_| "Cannot encode V4 continuation")?;
        candidate.store.continuation = if history.len() > HEAD_BYTES / 2 {
            let id = objects.object(&history, &mut created)?;
            if candidate
                .store
                .continuation
                .as_ref()
                .is_none_or(|part| part.id != id)
            {
                candidate.store.archive_bytes = candidate
                    .store
                    .archive_bytes
                    .checked_add(history.len() as u64)
                    .ok_or("V4 archive quota exceeded")?;
            }
            Some(ContinuationPart {
                id,
                bytes: history.len(),
            })
        } else {
            None
        };
        if candidate.store.archive_bytes > ARCHIVE_BYTES {
            return Err("V4 archive quota exceeded".into());
        }
        candidate.store.version = 1;
        candidate.store.revision = candidate
            .store
            .revision
            .checked_add(1)
            .ok_or("V4 session revision limit reached")?;
        let mut head_session = candidate.clone();
        head_session.messages = head_session
            .messages
            .split_off(head_session.store.archived_messages);
        if head_session.store.continuation.is_some() {
            head_session.history.clear();
        }
        let content = serde_json::to_vec(&head_session).map_err(|_| "Cannot encode V4 history")?;
        if content.len() > HEAD_BYTES {
            return Err(
                "V4 active continuation exceeds its2 MB head limit; compact it before continuing"
                    .into(),
            );
        }
        #[cfg(test)]
        if FAIL_BEFORE_HEAD.with(|fault| fault.replace(false)) {
            return Err("Injected pre-publication storage failure".into());
        }
        head.replace(&format!("{}.json", candidate.id), &content)?;
        Ok(candidate)
    })();
    if result
        .as_ref()
        .is_err_and(|error: &String| !error.contains("uncertain"))
    {
        for name in created {
            let _ = objects.remove(&name);
        }
    }
    result
}
pub(super) fn save(data: &Path, owner: &str, session: &mut Session) -> Result<(), String> {
    let (head, objects) = directories(
        data,
        owner,
        Path::new(&session.workspace),
        &session.id,
        true,
    )?;
    let objects = objects.unwrap();
    let _lock = objects.lock(".write.lock")?;
    let candidate = write_locked(&head, &objects, session, None)?;
    *session = candidate;
    Ok(())
}
pub(super) fn commit_compaction(
    data: &Path,
    owner: &str,
    before: &Session,
    candidate: Session,
    receipt: &Receipt,
) -> Result<Session, String> {
    if candidate.id != before.id
        || candidate.workspace != before.workspace
        || candidate.provider != before.provider
        || candidate.model != before.model
        || receipt.session_id != before.id
        || receipt.source_revision != super::session_fingerprint(before)
        || serde_json::to_value(&candidate.messages).map_err(|_| failure())?
            != serde_json::to_value(&before.messages).map_err(|_| failure())?
    {
        return Err("V4 compaction scope or visible history changed".into());
    }
    let (head, objects) = directories(data, owner, Path::new(&before.workspace), &before.id, true)?;
    let objects = objects.unwrap();
    let _lock = objects.lock(".write.lock")?;
    write_locked(&head, &objects, &candidate, Some((before, receipt)))
}
pub(super) fn latest_archive(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
) -> Result<Option<String>, String> {
    let (head, _) = directories(data, owner, workspace, session, false)?;
    ensure_live(&head, session)?;
    let content = head
        .read(&format!("{session}.json"), HEAD_BYTES)?
        .ok_or("V4 conversation is unavailable")?;
    Ok(decode(&content, session, workspace)?.store.last_compaction)
}
pub(super) fn archive(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &str,
    id: &str,
) -> Result<HistoryArchive, String> {
    let (head, objects) = directories(data, owner, workspace, session, false)?;
    ensure_live(&head, session)?;
    let objects = objects.ok_or("V4 compaction archive is unavailable")?;
    let archive: HistoryArchive = serde_json::from_slice(&object(&objects, id, OBJECT_BYTES)?)
        .map_err(|_| "V4 compaction archive is invalid")?;
    if archive.receipt.session_id != session {
        return Err("V4 compaction archive scope is invalid".into());
    }
    Ok(archive)
}
pub(super) fn complete_history(
    data: &Path,
    owner: &str,
    session: &Session,
) -> Result<Vec<serde_json::Value>, String> {
    let (head, _) = directories(
        data,
        owner,
        Path::new(&session.workspace),
        &session.id,
        false,
    )?;
    ensure_live(&head, &session.id)?;
    let mut history = session.history.clone();
    let mut id = session.store.last_compaction.clone();
    let mut tails = Vec::new();
    let mut total = 0usize;
    while let Some(reference) = id {
        if tails.len() >= 1_024 {
            return Err("V4 compaction lineage exceeds its read limit".into());
        }
        let saved = archive(
            data,
            owner,
            Path::new(&session.workspace),
            &session.id,
            &reference,
        )?;
        if saved.after_history_len > history.len()
            || digest(
                serde_json::to_vec(&history[..saved.after_history_len]).map_err(|_| failure())?,
            ) != saved.after_history_hash
        {
            return Err("V4 compaction continuation changed outside its lineage".into());
        }
        total = total
            .checked_add(
                serde_json::to_vec(&saved.history)
                    .map_err(|_| failure())?
                    .len(),
            )
            .ok_or("V4 continuation read limit exceeded")?;
        if total > ARCHIVE_BYTES as usize {
            return Err("V4 continuation read limit exceeded".into());
        }
        tails.push(history.split_off(saved.after_history_len));
        history = saved.history;
        id = saved.receipt.previous_receipt;
    }
    for tail in tails.into_iter().rev() {
        history.extend(tail);
    }
    Ok(history)
}
#[cfg(test)]
thread_local! {static FAIL_BEFORE_HEAD:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}

#[cfg(test)]
mod tests {
    use super::super::{directory, new_session, Message};
    use super::*;
    use serde_json::json;

    #[test]
    fn visible_history_beyond_two_megabytes_round_trips_through_a_bounded_head() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "fixture", &workspace);
        for index in 0..30 {
            session.messages.push(Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: format!("turn{index}:{}", "x".repeat(100_000)),
            });
        }
        session.history = vec![json!({"role":"user","content":"latest bounded continuation"})];
        save(data.path(), "owner", &mut session).unwrap();
        let path = directory(data.path(), "owner", &workspace).join(format!("{}.json", session.id));
        assert!(std::fs::metadata(path).unwrap().len() < HEAD_BYTES as u64);
        let restored = load(data.path(), "owner", &workspace, &session.id).unwrap();
        assert_eq!(
            serde_json::to_value(restored.messages).unwrap(),
            serde_json::to_value(session.messages).unwrap()
        );
    }

    #[test]
    fn legacy_session_migrates_and_stale_writers_cannot_overwrite_it() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut original = new_session("deepseek", "fixture", &workspace);
        original.messages.push(Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "legacy".into(),
        });
        let directory = directory(data.path(), "owner", &workspace);
        std::fs::create_dir_all(&directory).unwrap();
        let mut legacy = serde_json::to_value(&original).unwrap();
        legacy.as_object_mut().unwrap().remove("store");
        legacy.as_object_mut().unwrap().remove("transport");
        std::fs::write(
            directory.join(format!("{}.json", original.id)),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let mut first = load(data.path(), "owner", &workspace, &original.id).unwrap();
        let mut stale = first.clone();
        first.messages.push(Message {
            attachments: Vec::new(),
            role: "assistant".into(),
            text: "newer".into(),
        });
        save(data.path(), "owner", &mut first).unwrap();
        stale.model = "stale".into();
        assert!(save(data.path(), "owner", &mut stale)
            .unwrap_err()
            .contains("changed"));
        assert_eq!(
            load(data.path(), "owner", &workspace, &original.id)
                .unwrap()
                .messages
                .len(),
            2
        );
        assert!(load(data.path(), "other", &workspace, &original.id).is_err());
        let another = tempfile::tempdir().unwrap();
        assert!(load(data.path(), "owner", another.path(), &original.id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn scoped_session_store_rejects_symlinked_owner_directories() {
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "fixture", &workspace);
        let directory = directory(data.path(), "owner", &workspace);
        std::fs::create_dir_all(directory.parent().unwrap().parent().unwrap()).unwrap();
        symlink(outside.path(), directory.parent().unwrap()).unwrap();
        assert!(save(data.path(), "owner", &mut session).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    #[test]
    fn large_native_continuation_is_spilled_without_losing_private_records() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "fixture", &workspace);
        session.history = vec![
            json!({"role":"assistant","content":"large","reasoning_content":"opaque".repeat(400_000)}),
        ];
        save(data.path(), "owner", &mut session).unwrap();
        let path = directory(data.path(), "owner", &workspace).join(format!("{}.json", session.id));
        assert!(std::fs::metadata(path).unwrap().len() < HEAD_BYTES as u64);
        assert_eq!(
            load(data.path(), "owner", &workspace, &session.id)
                .unwrap()
                .history,
            session.history
        );
    }
    #[test]
    fn failed_head_publication_rolls_back_new_objects_and_preserves_the_exact_prior_revision() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "fixture", &workspace);
        session.messages.push(Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "original".into(),
        });
        save(data.path(), "owner", &mut session).unwrap();
        let original = super::super::session_fingerprint(&session);
        let mut candidate = session.clone();
        candidate.messages.push(Message {
            attachments: Vec::new(),
            role: "assistant".into(),
            text: "x".repeat(300_000),
        });
        let unchanged = super::super::session_fingerprint(&candidate);
        FAIL_BEFORE_HEAD.with(|fault| fault.set(true));
        assert!(save(data.path(), "owner", &mut candidate).is_err());
        assert_eq!(super::super::session_fingerprint(&candidate), unchanged);
        assert_eq!(
            super::super::session_fingerprint(
                &load(data.path(), "owner", &workspace, &session.id).unwrap()
            ),
            original
        );
        let objects =
            directory(data.path(), "owner", &workspace).join(format!("{}.objects", session.id));
        assert_eq!(std::fs::read_dir(objects).unwrap().count(), 1);
    }
    #[test]
    fn deletion_tombstone_hides_all_readers_and_prevents_stale_head_resurrection() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "fixture", &workspace);
        session.messages.push(Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "private deleted fixture".into(),
        });
        session.history = vec![json!({"role":"user","content":"private deleted fixture"})];
        save(data.path(), "owner", &mut session).unwrap();
        let path = directory(data.path(), "owner", &workspace).join(format!("{}.json", session.id));
        let original = std::fs::read(&path).unwrap();
        delete(data.path(), "owner", &workspace, &session.id).unwrap();
        delete(data.path(), "owner", &workspace, &session.id).unwrap();
        assert!(load(data.path(), "owner", &workspace, &session.id).is_err());
        assert!(save(data.path(), "owner", &mut session).is_err());
        assert!(latest_archive(data.path(), "owner", &workspace, &session.id).is_err());
        std::fs::write(&path, original).unwrap();
        assert!(visible_from_path(data.path(), &path, 80_000_000).is_err());
        assert!(load(data.path(), "owner", &workspace, &session.id).is_err());
    }
    #[test]
    fn deleting_one_session_preserves_an_independent_fork_and_another_owner() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut original = new_session("deepseek", "fixture", &workspace);
        original.messages = vec![
            Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: "first".into(),
            },
            Message {
                attachments: Vec::new(),
                role: "assistant".into(),
                text: "answer".into(),
            },
            Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: "second".into(),
            },
        ];
        original.history = original
            .messages
            .iter()
            .map(|m| json!({"role":m.role,"content":m.text}))
            .collect();
        save(data.path(), "owner", &mut original).unwrap();
        let fork = super::super::fork(
            data.path(),
            "owner",
            &workspace,
            &original.id,
            1,
            &super::super::session_fingerprint(&original),
        )
        .unwrap();
        let mut other = new_session("deepseek", "fixture", &workspace);
        other.id = original.id.clone();
        other.messages.push(Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "other account".into(),
        });
        save(data.path(), "other", &mut other).unwrap();
        delete(data.path(), "owner", &workspace, &original.id).unwrap();
        assert_eq!(
            load(data.path(), "owner", &workspace, &fork.id)
                .unwrap()
                .messages
                .len(),
            2
        );
        assert_eq!(
            load(data.path(), "other", &workspace, &other.id)
                .unwrap()
                .messages[0]
                .text,
            "other account"
        );
    }
    #[test]
    fn malformed_archive_manifest_is_rejected_before_reading_an_oversized_part() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let mut session = new_session("deepseek", "fixture", &workspace);
        session.messages.push(Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "x".repeat(300_000),
        });
        save(data.path(), "owner", &mut session).unwrap();
        let path = directory(data.path(), "owner", &workspace).join(format!("{}.json", session.id));
        let mut head: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        head["store"]["transcript"][0]["bytes"] = json!(1);
        std::fs::write(&path, head.to_string()).unwrap();
        assert!(visible_from_path(data.path(), &path, 80_000_000).is_err());
        assert!(load(data.path(), "owner", &workspace, &session.id).is_err());
    }
}

#[cfg(test)]
mod image_lifetime_tests {
    use super::super::{directory, new_session};
    use super::*;
    fn fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        String,
        std::path::PathBuf,
    ) {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = directory(data.path(), "owner", workspace.path())
            .join(format!("{id}.objects"))
            .join(".image-lifetime.lock");
        (data, workspace, id, path)
    }
    #[test]
    fn image_lifetime_shared_writers_exclude_collection_until_release_and_preserve_scope_isolation()
    {
        let (data, workspace, id, _) = fixture();
        let other = tempfile::tempdir().unwrap();
        let first = image_writer_lease(data.path(), "owner", workspace.path(), &id).unwrap();
        let second = image_writer_lease(data.path(), "owner", workspace.path(), &id).unwrap();
        assert!(
            image_collection_lease(data.path(), "owner", workspace.path(), &id)
                .unwrap()
                .is_none()
        );
        assert!(
            image_collection_lease(data.path(), "other", workspace.path(), &id)
                .unwrap()
                .is_some()
        );
        assert!(
            image_collection_lease(data.path(), "owner", other.path(), &id)
                .unwrap()
                .is_some()
        );
        assert!(image_collection_lease(
            data.path(),
            "owner",
            workspace.path(),
            &uuid::Uuid::new_v4().to_string()
        )
        .unwrap()
        .is_some());
        drop(first);
        assert!(
            image_collection_lease(data.path(), "owner", workspace.path(), &id)
                .unwrap()
                .is_none()
        );
        drop(second);
        let collection = image_collection_lease(data.path(), "owner", workspace.path(), &id)
            .unwrap()
            .unwrap();
        assert!(image_writer_lease(data.path(), "owner", workspace.path(), &id).is_err());
        drop(collection);
        assert!(image_writer_lease(data.path(), "owner", workspace.path(), &id).is_ok());
    }
    #[test]
    fn image_lifetime_collection_contention_returns_without_blocking_the_calling_thread() {
        let (data, workspace, id, _) = fixture();
        let writer = image_writer_lease(data.path(), "owner", workspace.path(), &id).unwrap();
        let data_path = data.path().to_path_buf();
        let workspace_path = workspace.path().to_path_buf();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = image_collection_lease(&data_path, "owner", &workspace_path, &id)
                .map(|lease| lease.is_none());
            let _ = send.send(result);
        });
        let result = receive.recv_timeout(std::time::Duration::from_secs(3));
        // Release before assertion/join even if an accidental blocking lock is introduced.
        drop(writer);
        worker.join().unwrap();
        assert!(result.unwrap().unwrap());
    }
    #[test]
    fn image_lifetime_nonempty_and_nonregular_control_files_are_errors_not_contention() {
        for directory in [false, true] {
            let (data, workspace, id, path) = fixture();
            drop(image_writer_lease(data.path(), "owner", workspace.path(), &id).unwrap());
            if directory {
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
            } else {
                std::fs::write(&path, b"invalid control data").unwrap();
            }
            assert!(image_writer_lease(data.path(), "owner", workspace.path(), &id).is_err());
            assert!(image_collection_lease(data.path(), "owner", workspace.path(), &id).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn image_lifetime_symlink_hardlink_and_fifo_control_files_fail_closed_without_following_or_waiting(
    ) {
        use std::os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        };
        for kind in ["symlink", "hardlink", "fifo"] {
            let (data, workspace, id, path) = fixture();
            drop(image_writer_lease(data.path(), "owner", workspace.path(), &id).unwrap());
            std::fs::remove_file(&path).unwrap();
            let outside = data.path().join("fixture-control-sentinel");
            std::fs::write(&outside, b"").unwrap();
            let original_mode = std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777;
            match kind {
                "symlink" => symlink(&outside, &path).unwrap(),
                "hardlink" => std::fs::hard_link(&outside, &path).unwrap(),
                _ => {
                    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                }
            }
            assert!(image_writer_lease(data.path(), "owner", workspace.path(), &id).is_err());
            assert!(image_collection_lease(data.path(), "owner", workspace.path(), &id).is_err());
            assert_eq!(std::fs::read(&outside).unwrap(), b"");
            assert_eq!(
                std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
                original_mode
            );
        }
    }
    #[test]
    fn image_lifetime_acceptance_publication_guard_holds_shared_lease_until_commit_or_rollback() {
        const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
        for rollback in [false, true] {
            let (data, workspace, id, _) = fixture();
            let publication = super::super::artifacts::ImagePublication::begin(
                data.path(),
                "owner",
                workspace.path(),
                &id,
                &[("image/png".into(), PNG.into())],
            )
            .unwrap();
            assert!(
                image_collection_lease(data.path(), "owner", workspace.path(), &id)
                    .unwrap()
                    .is_none()
            );
            if rollback {
                publication.rollback().unwrap();
            } else {
                publication.commit();
            }
            assert!(
                image_collection_lease(data.path(), "owner", workspace.path(), &id)
                    .unwrap()
                    .is_some()
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn image_lifetime_scoped_retirement_keeps_control_inode_and_rejects_late_native_writers() {
        use std::os::unix::fs::MetadataExt;
        let (data, workspace, id, path) = fixture();
        let mut saved = new_session("deepseek", "deepseek-v4-flash", workspace.path());
        saved.id = id.clone();
        save(data.path(), "owner", &mut saved).unwrap();
        drop(image_writer_lease(data.path(), "owner", workspace.path(), &id).unwrap());
        let before = std::fs::metadata(&path).unwrap();
        super::super::delete_conversation(data.path(), "owner", workspace.path(), &id).unwrap();
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(after.len(), 0);
        assert_eq!(after.nlink(), 1);
        assert!(image_writer_lease(data.path(), "owner", workspace.path(), &id).is_err());
        assert!(
            image_collection_lease(data.path(), "owner", workspace.path(), &id)
                .unwrap()
                .is_some()
        );
    }
}
