//! Durable cross-process fence between background launches and session
//! deletion. A launch lease holds a hashed stripe lock; retirement needs the
//! same lock and then writes a tombstone that every later lease checks, so a
//! stale actor in any process cannot launch for a deleted session.
//! Assumes a private, stable data directory; older binaries ignore it.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

const DIRECTORY: &str = ".background-session-fence";
pub(crate) const MAX_TOMBSTONES: usize = 4096;
const BUSY: &str = "Background session launch or deletion is in progress; retry";

pub(crate) struct LaunchLease {
    file: File,
    pid: u32,
}

impl Drop for LaunchLease {
    fn drop(&mut self) {
        if self.pid == std::process::id() {
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

fn digest(owner: &str, session: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [owner, session] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

fn validate(owner: &str, session: &str) -> Result<(), String> {
    if owner.is_empty()
        || session.is_empty()
        || owner.len() > 256
        || session.len() > 256
        || owner.chars().any(char::is_control)
        || session.chars().any(char::is_control)
    {
        return Err("Invalid background session fence".into());
    }
    Ok(())
}

fn directory(data: &Path) -> Result<PathBuf, String> {
    let root = std::fs::symlink_metadata(data).map_err(|_| "Background fence is unavailable")?;
    if !root.is_dir()
        || root.file_type().is_symlink()
        || root.uid() != unsafe { libc::geteuid() }
        || root.mode() & 0o022 != 0
    {
        return Err("Background fence root is unsafe".into());
    }
    let path = data
        .canonicalize()
        .map_err(|_| "Background fence is unavailable")?
        .join(DIRECTORY);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            if let Err(error) = builder.create(&path) {
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err("Background fence is unavailable".into());
                }
            }
        }
        Err(_) => return Err("Background fence is unavailable".into()),
    }
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "Background fence is unavailable")?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err("Background fence directory is unsafe".into());
    }
    Ok(path)
}

fn tombstone(dir: &Path, owner: &str, session: &str) -> PathBuf {
    dir.join(format!("retired-{}", hex(&digest(owner, session))))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn lock(dir: &Path, owner: &str, session: &str) -> Result<File, String> {
    let digest = digest(owner, session);
    let path = dir.join(format!(
        "lock-{:04x}",
        u16::from_be_bytes([digest[0], digest[1]])
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| "Background fence is unavailable")?;
    let retained = file
        .metadata()
        .map_err(|_| "Background fence is unavailable")?;
    if !retained.is_file() || retained.uid() != unsafe { libc::geteuid() } || retained.nlink() != 1
    {
        return Err("Background fence lock is unsafe".into());
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(BUSY.into());
    }
    let current =
        std::fs::symlink_metadata(&path).map_err(|_| "Background fence is unavailable")?;
    if current.file_type().is_symlink()
        || (current.dev(), current.ino()) != (retained.dev(), retained.ino())
    {
        return Err("Background fence changed".into());
    }
    Ok(file)
}

fn retired(dir: &Path, owner: &str, session: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(tombstone(dir, owner, session)) {
        Ok(meta) if meta.is_file() => Ok(true),
        Ok(_) => Err("Background fence tombstone is unsafe".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Background fence is unavailable".into()),
    }
}

pub(crate) fn acquire_launch(
    data: &Path,
    owner: &str,
    session: &str,
) -> Result<LaunchLease, String> {
    validate(owner, session)?;
    let dir = directory(data)?;
    let file = lock(&dir, owner, session)?;
    let lease = LaunchLease {
        file,
        pid: std::process::id(),
    };
    if retired(&dir, owner, session)? {
        return Err("Background session is retired".into());
    }
    Ok(lease)
}

fn tombstone_count(dir: &Path) -> Result<usize, String> {
    Ok(std::fs::read_dir(dir)
        .map_err(|_| "Background fence is unavailable")?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("retired-"))
        .count())
}

pub(crate) fn can_retire(
    data: &Path,
    owner: &str,
    session: &str,
    reserved: usize,
) -> Result<(), String> {
    validate(owner, session)?;
    let dir = directory(data)?;
    if retired(&dir, owner, session)? {
        return Ok(());
    }
    if tombstone_count(&dir)?.saturating_add(reserved) >= MAX_TOMBSTONES {
        return Err("Background fence capacity exhausted: the conversation was not changed; an operator must free capacity (see docs/development/BACKGROUND_PROCESS_LIFECYCLE.md) before deleting more conversations".into());
    }
    Ok(())
}

pub(crate) fn retire(data: &Path, owner: &str, session: &str) -> Result<(), String> {
    validate(owner, session)?;
    let dir = directory(data)?;
    let _lease = LaunchLease {
        file: lock(&dir, owner, session)?,
        pid: std::process::id(),
    };
    if retired(&dir, owner, session)? {
        return Ok(());
    }
    if tombstone_count(&dir)? >= MAX_TOMBSTONES {
        return Err("Background fence capacity exhausted".into());
    }
    let path = tombstone(&dir, owner, session);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| "Cannot persist background fence")?;
    file.sync_all()
        .and_then(|_| File::open(&dir)?.sync_all())
        .map_err(|_| "Cannot persist background fence".into())
}

#[cfg(test)]
pub(crate) fn is_retired(data: &Path, owner: &str, session: &str) -> Result<bool, String> {
    retired(&directory(data)?, owner, session)
}
