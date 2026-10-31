use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::Duration,
};

pub(crate) const BUSY: &str = "Credential storage is busy; retry shortly";

pub(crate) fn database_error(error: rusqlite::Error) -> String {
    match &error {
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            BUSY.into()
        }
        _ => error.to_string(),
    }
}

pub(crate) fn api_error(error: String) -> crate::ApiError {
    if error == BUSY {
        crate::ApiError {
            status: axum::http::StatusCode::CONFLICT,
            message: error,
        }
    } else {
        crate::ApiError::internal(error)
    }
}

pub(crate) struct Lease(File);

pub(crate) fn shared(data: &Path, owner: &str) -> Result<Lease, String> {
    acquire(data, owner, libc::LOCK_SH)
}

pub(crate) fn exclusive(data: &Path, owner: &str) -> Result<Lease, String> {
    acquire(data, owner, libc::LOCK_EX)
}

pub(crate) fn notes_exclusive(data: &Path, storage_id: &str) -> Result<Lease, String> {
    let key = format!(
        "notes-{}",
        hex::encode(Sha256::digest(storage_id.as_bytes()))
    );
    acquire_by_key(data, &key, libc::LOCK_EX).map_err(|error| {
        if error == BUSY {
            "Notes storage is busy or unavailable".into()
        } else {
            error
        }
    })
}

fn acquire(data: &Path, owner: &str, mode: libc::c_int) -> Result<Lease, String> {
    let owner_hash = hex::encode(Sha256::digest(owner.as_bytes()));
    acquire_by_key(data, &owner_hash, mode)
}

fn acquire_by_key(data: &Path, owner_hash: &str, mode: libc::c_int) -> Result<Lease, String> {
    let unavailable = || "Credential admission is unavailable".to_string();
    let root = std::fs::symlink_metadata(data).map_err(|_| unavailable())?;
    if !root.is_dir()
        || root.file_type().is_symlink()
        || root.uid() != unsafe { libc::geteuid() }
        || root.mode() & 0o022 != 0
    {
        return Err(unavailable());
    }
    let canonical = data.canonicalize().map_err(|_| unavailable())?;
    let data = canonical.as_path();
    let path = data.join(format!("vault-admission-{owner_hash}.lock"));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|_| unavailable())?;
    if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), mode | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
            BUSY.into()
        } else {
            unavailable()
        });
    }
    let lease = Lease(file);
    let opened = lease.0.metadata().map_err(|_| unavailable())?;
    let current = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    if !opened.is_file()
        || current.file_type().is_symlink()
        || opened.nlink() != 1
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.mode() & 0o077 != 0
        || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
    {
        return Err(unavailable());
    }
    let database_path = data.join("terminal.db");
    let before = std::fs::symlink_metadata(&database_path).map_err(|_| unavailable())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(unavailable());
    }
    let mut db = rusqlite::Connection::open_with_flags(
        &database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(database_error)?;
    db.busy_timeout(Duration::from_millis(200))
        .map_err(database_error)?;
    let device = opened.dev().to_string();
    let inode = opened.ino().to_string();
    let registered: Option<bool> = db
        .query_row(
            "SELECT device = ?2 AND inode = ?3 FROM vault_owner_fences WHERE owner_hash = ?1",
            rusqlite::params![owner_hash, device, inode],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?;
    if registered == Some(false) {
        return Err(unavailable());
    }
    if registered.is_none() {
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(database_error)?;
        transaction.execute("INSERT OR IGNORE INTO vault_owner_fences(owner_hash, device, inode) VALUES (?1, ?2, ?3)", rusqlite::params![owner_hash, device, inode]).map_err(database_error)?;
        let matches: bool = transaction
            .query_row(
                "SELECT device = ?2 AND inode = ?3 FROM vault_owner_fences WHERE owner_hash = ?1",
                rusqlite::params![owner_hash, device, inode],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if !matches {
            return Err(unavailable());
        }
        transaction.commit().map_err(database_error)?;
    }
    let after = std::fs::symlink_metadata(&database_path).map_err(|_| unavailable())?;
    let current = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    let root_after = std::fs::symlink_metadata(data).map_err(|_| unavailable())?;
    if (before.dev(), before.ino()) != (after.dev(), after.ino())
        || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
        || (root.dev(), root.ino()) != (root_after.dev(), root_after.ino())
    {
        return Err(unavailable());
    }
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(path: &Path) {
        let db = rusqlite::Connection::open(path.join("terminal.db")).unwrap();
        db.execute_batch("CREATE TABLE vault_owner_fences(owner_hash TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL)").unwrap();
    }

    #[test]
    fn same_owner_mutation_is_busy_until_shared_request_ends() {
        let root = tempfile::tempdir().unwrap();
        database(root.path());
        let request = shared(root.path(), "alice").unwrap();
        assert!(matches!(exclusive(root.path(), "alice"), Err(error) if error == BUSY));
        assert!(exclusive(root.path(), "bob").is_ok());
        drop(request);
        assert!(exclusive(root.path(), "alice").is_ok());
    }

    #[test]
    fn unrelated_database_writer_does_not_block_established_owner_and_new_owner_is_busy() {
        let root = tempfile::tempdir().unwrap();
        database(root.path());
        drop(exclusive(root.path(), "alice").unwrap());
        let db = rusqlite::Connection::open(root.path().join("terminal.db")).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(exclusive(root.path(), "alice").is_ok());
        assert!(matches!(exclusive(root.path(), "bob"), Err(error) if error == BUSY));
        db.execute_batch("ROLLBACK").unwrap();
        assert!(exclusive(root.path(), "bob").is_ok());
    }

    #[test]
    fn replaced_lock_file_never_creates_a_second_admission_domain() {
        let root = tempfile::tempdir().unwrap();
        database(root.path());
        let request = shared(root.path(), "alice").unwrap();
        let path = root.path().join(format!(
            "vault-admission-{}.lock",
            hex::encode(Sha256::digest(b"alice"))
        ));
        std::fs::remove_file(path).unwrap();
        assert!(exclusive(root.path(), "alice").is_err());
        drop(request);
        assert!(exclusive(root.path(), "alice").is_err());
    }

    #[test]
    fn restored_database_requires_explicit_offline_identity_reset() {
        let original = tempfile::tempdir().unwrap();
        database(original.path());
        drop(shared(original.path(), "alice").unwrap());
        let restored = tempfile::tempdir().unwrap();
        std::fs::copy(
            original.path().join("terminal.db"),
            restored.path().join("terminal.db"),
        )
        .unwrap();
        assert!(exclusive(restored.path(), "alice").is_err());
        let hash = hex::encode(Sha256::digest(b"alice"));
        let db = rusqlite::Connection::open(restored.path().join("terminal.db")).unwrap();
        assert_eq!(
            db.execute(
                "DELETE FROM vault_owner_fences WHERE owner_hash=?1",
                [&hash]
            )
            .unwrap(),
            1
        );
        drop(db);
        std::fs::remove_file(restored.path().join(format!("vault-admission-{hash}.lock"))).unwrap();
        assert!(exclusive(restored.path(), "alice").is_ok());
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn child_attempts_mutation() {
        let path = std::env::var_os("V4_VAULT_TEST_ROOT").unwrap();
        assert!(matches!(exclusive(Path::new(&path), "alice"), Err(error) if error == BUSY));
        assert!(exclusive(Path::new(&path), "bob").is_ok());
    }

    #[test]
    fn another_process_observes_the_owner_request_lease() {
        let root = tempfile::tempdir().unwrap();
        database(root.path());
        let _request = shared(root.path(), "alice").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "vault_admission::tests::child_attempts_mutation",
                "--ignored",
            ])
            .env("V4_VAULT_TEST_ROOT", root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn child_attempts_notes_mutation() {
        let path = std::env::var_os("V4_NOTE_LOCK_TEST_ROOT").unwrap();
        assert!(
            matches!(notes_exclusive(Path::new(&path), "alice"), Err(error) if error == "Notes storage is busy or unavailable")
        );
        assert!(notes_exclusive(Path::new(&path), "bob").is_ok());
    }

    #[test]
    fn another_process_observes_the_notes_lease() {
        let root = tempfile::tempdir().unwrap();
        database(root.path());
        let _request = notes_exclusive(root.path(), "alice").unwrap();
        assert!(exclusive(root.path(), "alice").is_ok());
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "vault_admission::tests::child_attempts_notes_mutation",
                "--ignored",
            ])
            .env("V4_NOTE_LOCK_TEST_ROOT", root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
