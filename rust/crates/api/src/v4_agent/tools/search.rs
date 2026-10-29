use super::{protected, text, FILE_BYTES};
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    fs::{File, OpenOptions},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    },
    path::{Component, Path},
    time::{Duration, Instant},
};

const ENTRY_LIMIT: usize = 2_000;
const MATCH_LIMIT: usize = 100;
const DEPTH_LIMIT: usize = 8;
const TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const REGEX_LINE_BYTES: usize = 16 * 1024;

enum Pattern {
    Literal(String),
    Folded(String),
    Regex(regex_lite::Regex),
}
impl Pattern {
    fn position(&self, value: &str) -> Option<usize> {
        match self {
            Self::Literal(needle) => value.find(needle),
            Self::Folded(needle) => {
                let folded = value.to_lowercase();
                let index = folded.find(needle)?;
                let wanted = folded[..index].chars().count();
                let mut count = 0;
                for (offset, character) in value.char_indices() {
                    if count >= wanted {
                        return Some(offset);
                    }
                    count += character.to_lowercase().count();
                }
                Some(value.len())
            }
            Self::Regex(regex) => regex.find(value).map(|found| found.start()),
        }
    }
}

fn optional_bool(input: &Value, key: &str, default: bool) -> Result<bool, String> {
    input.get(key).map_or(Ok(default), |value| {
        value.as_bool().ok_or_else(|| format!("Invalid {key}"))
    })
}

fn open_child(parent: &File, name: &CStr) -> Result<File, String> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("Workspace path is unavailable".into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

struct Directory(*mut libc::DIR);
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn open_directory(file: &File) -> Result<Directory, String> {
    let fd = unsafe { libc::dup(file.as_raw_fd()) };
    if fd < 0 {
        return Err("Cannot read workspace directory".into());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err("Cannot read workspace directory".into());
    }
    Ok(Directory(stream))
}

fn clear_directory_error() -> bool {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe {
        *libc::__errno_location() = 0;
        return true;
    }
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    unsafe {
        *libc::__error() = 0;
        return true;
    }
    #[allow(unreachable_code)]
    false
}

struct Search<'a> {
    pattern: &'a Pattern,
    files: bool,
    started: Instant,
    visited: usize,
    bytes_read: u64,
    rows: Vec<Value>,
    truncated: bool,
}

impl Search<'_> {
    fn exhausted(&mut self) -> bool {
        let exhausted = self.visited >= ENTRY_LIMIT
            || self.rows.len() >= MATCH_LIMIT
            || self.bytes_read >= TOTAL_BYTES
            || self.started.elapsed() >= Duration::from_secs(2);
        self.truncated |= exhausted;
        exhausted
    }

    fn walk(&mut self, file: File, path: &str, depth: usize) {
        if self.exhausted() {
            return;
        }
        self.visited += 1;
        let Ok(metadata) = file.metadata() else {
            self.truncated = true;
            return;
        };
        if metadata.is_file() {
            if self.files {
                if self.pattern.position(path).is_some() {
                    self.rows.push(json!({"path":path}));
                }
                return;
            }
            if metadata.len() > FILE_BYTES {
                self.truncated = true;
                return;
            }
            let remaining = TOTAL_BYTES.saturating_sub(self.bytes_read);
            if metadata.len() > remaining {
                self.truncated = true;
                return;
            }
            let mut bytes = Vec::new();
            if file
                .take(FILE_BYTES.min(remaining) + 1)
                .read_to_end(&mut bytes)
                .is_err()
            {
                self.truncated = true;
                return;
            }
            if bytes.len() as u64 > FILE_BYTES || bytes.len() as u64 > remaining {
                self.truncated = true;
                return;
            }
            self.bytes_read += bytes.len() as u64;
            let Ok(content) = std::str::from_utf8(&bytes) else {
                return;
            };
            for (line, value) in content.lines().enumerate() {
                if self.exhausted() {
                    break;
                }
                if matches!(self.pattern, Pattern::Regex(_)) && value.len() > REGEX_LINE_BYTES {
                    self.truncated = true;
                    continue;
                }
                if let Some(position) = self.pattern.position(value) {
                    let before = value[..position].chars().count().saturating_sub(80);
                    let excerpt: String = value.chars().skip(before).take(500).collect();
                    self.rows
                        .push(json!({"path":path,"line":line + 1,"text":excerpt}));
                }
            }
        } else if metadata.is_dir() {
            if depth >= DEPTH_LIMIT {
                self.truncated = true;
                return;
            }
            let stream = match open_directory(&file) {
                Ok(stream) => stream,
                Err(_) => {
                    self.truncated = true;
                    return;
                }
            };
            loop {
                if self.exhausted() {
                    break;
                }
                let can_check_error = clear_directory_error();
                let entry = unsafe { libc::readdir(stream.0) };
                if entry.is_null() {
                    if !can_check_error || std::io::Error::last_os_error().raw_os_error() != Some(0)
                    {
                        self.truncated = true;
                    }
                    break;
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                let Ok(name_str) = name.to_str() else {
                    self.truncated = true;
                    continue;
                };
                if name_str == "."
                    || name_str == ".."
                    || protected(name_str)
                    || ["node_modules", "target", "dist"].contains(&name_str)
                {
                    continue;
                }
                let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
                if unsafe {
                    libc::fstatat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        info.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } != 0
                {
                    self.truncated = true;
                    continue;
                }
                let info = unsafe { info.assume_init() };
                if !matches!(info.st_mode & libc::S_IFMT, libc::S_IFDIR | libc::S_IFREG) {
                    continue;
                }
                let Ok(child) = open_child(&file, name) else {
                    self.truncated = true;
                    continue;
                };
                let child_path = if path.is_empty() {
                    name_str.to_owned()
                } else {
                    format!("{path}/{name_str}")
                };
                self.walk(child, &child_path, depth + 1);
            }
        }
    }
}

pub(super) fn run(root: &Path, relative: &str, input: &Value) -> Result<String, String> {
    let query = text(input, "text")?;
    if query.is_empty() || query.len() > 1_000 {
        return Err("Search text must be 1-1000 bytes".into());
    }
    let regex = optional_bool(input, "regex", false)?;
    let case_sensitive = optional_bool(input, "case_sensitive", true)?;
    if regex && query.len() > 256 {
        return Err("Search expression exceeds 256 bytes".into());
    }
    let files = match input.get("mode") {
        None => false,
        Some(Value::String(mode)) if mode == "content" => false,
        Some(Value::String(mode)) if mode == "files" => true,
        _ => return Err("Invalid search mode".into()),
    };
    let pattern = if regex {
        let compiled = regex_lite::RegexBuilder::new(query)
            .case_insensitive(!case_sensitive)
            .size_limit(8 * 1024)
            .build()
            .map_err(|_| "Invalid or too complex search expression")?;
        Pattern::Regex(compiled)
    } else if case_sensitive {
        Pattern::Literal(query.into())
    } else {
        Pattern::Folded(query.to_lowercase())
    };

    if relative.len() > 2_048 || relative.chars().any(char::is_control) {
        return Err("Invalid workspace path".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "Workspace is unavailable")?;
    let mut current = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|_| "Workspace is unavailable")?;
    for component in root.components() {
        match component {
            Component::RootDir => (),
            Component::Normal(name) => {
                if protected(&name.to_string_lossy()) {
                    return Err("Workspace path is protected".into());
                }
                let name = CString::new(name.as_bytes()).map_err(|_| "Invalid workspace path")?;
                current = open_child(&current, &name)?;
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
    let mut prefix = String::new();
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => (),
            Component::Normal(name) if !protected(&name.to_string_lossy()) => {
                let text = name.to_str().ok_or("Invalid workspace path")?;
                let name = CString::new(name.as_bytes()).map_err(|_| "Invalid workspace path")?;
                current = open_child(&current, &name)?;
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(text);
            }
            _ => return Err("Path is outside the workspace or protected".into()),
        }
    }

    let mut search = Search {
        pattern: &pattern,
        files,
        started: Instant::now(),
        visited: 0,
        bytes_read: 0,
        rows: Vec::new(),
        truncated: false,
    };
    search.walk(current, &prefix, 0);
    Ok(json!({"matches":search.rows,"visited":search.visited,"truncated":search.truncated,"limits":{"entries":ENTRY_LIMIT,"matches":MATCH_LIMIT,"depth":DEPTH_LIMIT,"bytes":TOTAL_BYTES,"regexLineBytes":REGEX_LINE_BYTES}}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn opened_directory_stays_bound_when_its_path_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let original = root.path().join("source");
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("inside.txt"), "needle in workspace").unwrap();
        std::fs::write(
            outside.path().join("secret.txt"),
            "needle outside workspace",
        )
        .unwrap();
        let directory = File::open(&original).unwrap();
        std::fs::rename(&original, root.path().join("moved")).unwrap();
        symlink(outside.path(), &original).unwrap();
        let pattern = Pattern::Literal("needle".into());
        let mut search = Search {
            pattern: &pattern,
            files: false,
            started: Instant::now(),
            visited: 0,
            bytes_read: 0,
            rows: Vec::new(),
            truncated: false,
        };
        search.walk(directory, "source", 0);
        assert_eq!(
            search.rows,
            vec![json!({"path":"source/inside.txt","line":1,"text":"needle in workspace"})]
        );
        assert!(!search.truncated);
    }

    #[test]
    fn replacement_with_symlink_cannot_be_opened() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("target"),
        )
        .unwrap();
        let parent = File::open(root.path()).unwrap();
        assert!(open_child(&parent, c"target").is_err());
    }
}
