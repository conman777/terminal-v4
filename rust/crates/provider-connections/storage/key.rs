use super::{crypto, KEY_FILE, KEY_PREFIX, LOCK_FILE};
use crate::*;
use rand::TryRngCore;
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub(super) struct PrivateKey(pub(super) Zeroizing<[u8; 32]>);
pub(super) struct InitializationLock {
    root: PathBuf,
    directory: File,
    lock: File,
}
fn private_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.mode() & 0o7777 == 0o700
}
fn private_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.nlink() == 1
        && metadata.mode() & 0o7777 == 0o600
}
fn same_inode(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn checked_file(root: &Path, name: &str, create: bool) -> Result<File> {
    let path = root.join(name);
    let before = match fs::symlink_metadata(&path) {
        Ok(metadata) if private_file(&metadata) => Some(metadata),
        Ok(_) => return Err(Error::KeyUnavailable),
        Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(Error::KeyUnavailable),
    };
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|_| Error::KeyUnavailable)?;
    let opened = file.metadata().map_err(|_| Error::KeyUnavailable)?;
    let linked = fs::symlink_metadata(&path).map_err(|_| Error::KeyUnavailable)?;
    if !private_file(&opened)
        || !private_file(&linked)
        || !same_inode(&opened, &linked)
        || before
            .as_ref()
            .is_some_and(|metadata| !same_inode(metadata, &opened))
    {
        return Err(Error::KeyUnavailable);
    }
    Ok(file)
}
impl InitializationLock {
    pub(super) fn acquire(root: &Path) -> Result<Self> {
        if !root.is_absolute() {
            return Err(Error::KeyUnavailable);
        }
        match fs::symlink_metadata(root) {
            Ok(metadata) if !private_directory(&metadata) => return Err(Error::KeyUnavailable),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match DirBuilder::new().mode(0o700).create(root) {
                    Ok(()) => {
                        let parent = root.parent().ok_or(Error::KeyUnavailable)?;
                        OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
                            .open(parent)
                            .and_then(|directory| directory.sync_all())
                            .map_err(|_| Error::KeyUnavailable)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(Error::KeyUnavailable),
                }
            }
            Err(_) => return Err(Error::KeyUnavailable),
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .map_err(|_| Error::KeyUnavailable)?;
        let opened = directory.metadata().map_err(|_| Error::KeyUnavailable)?;
        let linked = fs::symlink_metadata(root).map_err(|_| Error::KeyUnavailable)?;
        if !private_directory(&opened)
            || !private_directory(&linked)
            || !same_inode(&opened, &linked)
        {
            return Err(Error::KeyUnavailable);
        }
        let lock = checked_file(root, LOCK_FILE, true)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::EWOULDBLOCK) | Some(libc::EINTR)
            ) || Instant::now() >= deadline
            {
                return Err(Error::KeyUnavailable);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = Self {
            root: root.to_path_buf(),
            directory,
            lock,
        };
        result.check_root()?;
        let opened = result.lock.metadata().map_err(|_| Error::KeyUnavailable)?;
        let linked =
            fs::symlink_metadata(root.join(LOCK_FILE)).map_err(|_| Error::KeyUnavailable)?;
        if !private_file(&opened) || !private_file(&linked) || !same_inode(&opened, &linked) {
            return Err(Error::KeyUnavailable);
        }
        Ok(result)
    }
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn check_root(&self) -> Result<()> {
        let opened = self
            .directory
            .metadata()
            .map_err(|_| Error::KeyUnavailable)?;
        let linked = fs::symlink_metadata(&self.root).map_err(|_| Error::KeyUnavailable)?;
        if !private_directory(&linked) || !same_inode(&opened, &linked) {
            return Err(Error::KeyUnavailable);
        }
        Ok(())
    }
    pub(super) fn database_file(&self, name: &str) -> Result<File> {
        self.check_root()?;
        checked_file(&self.root, name, true).map_err(|_| Error::PersistenceFailed)
    }
    pub(super) fn check_database(&self, name: &str, held: &File) -> Result<()> {
        self.check_root()?;
        let linked =
            fs::symlink_metadata(self.root.join(name)).map_err(|_| Error::PersistenceFailed)?;
        let opened = held.metadata().map_err(|_| Error::PersistenceFailed)?;
        if !private_file(&opened) || !private_file(&linked) || !same_inode(&opened, &linked) {
            return Err(Error::PersistenceFailed);
        }
        Ok(())
    }
    pub(super) fn check_auxiliary(&self, name: &str) -> Result<()> {
        for suffix in ["-journal", "-wal", "-shm"] {
            let name = format!("{name}{suffix}");
            match fs::symlink_metadata(self.root.join(&name)) {
                Ok(_) => {
                    checked_file(&self.root, &name, false).map_err(|_| Error::PersistenceFailed)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(Error::PersistenceFailed),
            }
        }
        Ok(())
    }
}
impl Drop for InitializationLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
struct TemporaryKey {
    path: PathBuf,
}
impl Drop for TemporaryKey {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
fn read_key(lock: &InitializationLock) -> Result<PrivateKey> {
    lock.check_root()?;
    let mut file = checked_file(lock.root(), KEY_FILE, false)?;
    let mut raw = Zeroizing::new(Vec::new());
    (&mut file)
        .take((KEY_PREFIX.len() + 65) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| Error::KeyUnavailable)?;
    let text = std::str::from_utf8(&raw).map_err(|_| Error::KeyUnavailable)?;
    let hex = text.strip_prefix(KEY_PREFIX).ok_or(Error::KeyUnavailable)?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Error::KeyUnavailable);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(hex, &mut *key).map_err(|_| Error::KeyUnavailable)?;
    Ok(PrivateKey(key))
}
fn create_key(lock: &InitializationLock) -> Result<PrivateKey> {
    lock.check_root()?;
    let mut bytes = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng
        .try_fill_bytes(&mut *bytes)
        .map_err(|_| Error::KeyUnavailable)?;
    let mut identifier = [0u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut identifier)
        .map_err(|_| Error::KeyUnavailable)?;
    let path = lock
        .root()
        .join(format!("feature-key-{}.tmp", hex::encode(identifier)));
    let temporary = TemporaryKey { path };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary.path)
        .map_err(|_| Error::KeyUnavailable)?;
    if !private_file(&file.metadata().map_err(|_| Error::KeyUnavailable)?) {
        return Err(Error::KeyUnavailable);
    }
    let mut encoded = Zeroizing::new([0u8; 64]);
    hex::encode_to_slice(&bytes[..], &mut *encoded).map_err(|_| Error::KeyUnavailable)?;
    file.write_all(KEY_PREFIX.as_bytes())
        .and_then(|_| file.write_all(&*encoded))
        .and_then(|_| file.sync_all())
        .map_err(|_| Error::KeyUnavailable)?;
    lock.check_root()?;
    // link is atomic and never overwrites a concurrently appeared destination.
    // A crash before temporary unlink fails closed on nlink, never rotates a key.
    fs::hard_link(&temporary.path, lock.root().join(KEY_FILE))
        .map_err(|_| Error::KeyUnavailable)?;
    fs::remove_file(&temporary.path).map_err(|_| Error::KeyUnavailable)?;
    lock.directory
        .sync_all()
        .map_err(|_| Error::KeyUnavailable)?;
    read_key(lock)
}
pub(super) fn open_feature_key_locked(
    lock: &InitializationLock,
    evidence: &FeatureStoreEvidence,
    expected_verifier: Option<&[u8]>,
) -> Result<PrivateKey> {
    lock.check_root()?;
    let key = match fs::symlink_metadata(lock.root().join(KEY_FILE)) {
        Ok(_) => read_key(lock)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected_verifier.is_some()
                || profiles::feature_key_policy(KeyState::Absent, evidence)?
                    != KeyDecision::GenerateFreshPrivateKey
            {
                return Err(Error::KeyUnavailable);
            }
            create_key(lock)?
        }
        Err(_) => return Err(Error::KeyUnavailable),
    };
    match expected_verifier {
        Some(expected) => crypto::verify_master(&key, expected)?,
        None if !evidence.is_empty() => return Err(Error::KeyUnavailable),
        None => {}
    }
    Ok(key)
}
#[cfg(test)]
pub(super) fn open_feature_key(
    root: &Path,
    evidence: &FeatureStoreEvidence,
    expected_verifier: Option<&[u8]>,
) -> Result<PrivateKey> {
    let lock = InitializationLock::acquire(root)?;
    open_feature_key_locked(&lock, evidence, expected_verifier)
}

#[cfg(test)]
mod tests;

// v2 rejection preflight: no lock creation, SQLite open or recovery occurs here.
pub(super) fn inspect_version(root: &Path) -> Result<Option<u32>> {
    if !root.is_absolute() {
        return Err(Error::KeyUnavailable);
    }
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = root.parent().ok_or(Error::KeyUnavailable)?;
            if parent.canonicalize().map_err(|_| Error::KeyUnavailable)? != parent {
                return Err(Error::KeyUnavailable);
            }
            return Ok(None);
        }
        Ok(metadata) if private_directory(&metadata) => {}
        _ => return Err(Error::KeyUnavailable),
    }
    if root.canonicalize().map_err(|_| Error::KeyUnavailable)? != root {
        return Err(Error::PersistenceFailed);
    }
    match fs::symlink_metadata(root.join(super::DATABASE_FILE)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::PersistenceFailed),
        Ok(_) => {}
    }
    let mut file =
        checked_file(root, super::DATABASE_FILE, false).map_err(|_| Error::PersistenceFailed)?;
    if file.metadata().map_err(|_| Error::PersistenceFailed)?.len() == 0 {
        return Ok(Some(0));
    }
    let mut header = [0u8; 100];
    file.read_exact(&mut header)
        .map_err(|_| Error::PersistenceFailed)?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err(Error::PersistenceFailed);
    }
    Ok(Some(u32::from_be_bytes(
        header[60..64]
            .try_into()
            .map_err(|_| Error::PersistenceFailed)?,
    )))
}
pub(super) fn admission_files(root: &Path) -> Result<(File, File)> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|_| Error::KeyUnavailable)?;
    let opened = directory.metadata().map_err(|_| Error::KeyUnavailable)?;
    let linked = fs::symlink_metadata(root).map_err(|_| Error::KeyUnavailable)?;
    if !private_directory(&opened) || !private_directory(&linked) || !same_inode(&opened, &linked) {
        return Err(Error::KeyUnavailable);
    }
    let file = checked_file(root, crate::leases::ADMISSION_LOCK_FILE, true)?;
    Ok((directory, file))
}
pub(super) fn check_admission_files(root: &Path, directory: &File, file: &File) -> Result<()> {
    let opened = directory.metadata().map_err(|_| Error::KeyUnavailable)?;
    let linked = fs::symlink_metadata(root).map_err(|_| Error::KeyUnavailable)?;
    let lock_open = file.metadata().map_err(|_| Error::KeyUnavailable)?;
    let lock_link = fs::symlink_metadata(root.join(crate::leases::ADMISSION_LOCK_FILE))
        .map_err(|_| Error::KeyUnavailable)?;
    if !private_directory(&opened)
        || !private_directory(&linked)
        || !same_inode(&opened, &linked)
        || !private_file(&lock_open)
        || !private_file(&lock_link)
        || !same_inode(&lock_open, &lock_link)
    {
        return Err(Error::KeyUnavailable);
    }
    Ok(())
}
