//! Read-only preparation for an offline enrollment of an existing owner.

mod intent;

use super::Store;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub(super) session: String,
    pub(super) incarnation: Option<[u8; 16]>,
    pub(super) device: u64,
    pub(super) inode: u64,
    pub(super) digest: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ExistingInventory {
    root: PathBuf,
    owner: String,
    directories: Vec<(u64, u64)>,
    pub(super) records: Vec<Record>,
}

impl ExistingInventory {
    pub(super) fn scan(root: &Path, owner: &str) -> Result<Self, String> {
        if !root.is_absolute()
            || owner.trim().is_empty()
            || owner.len() > 256
            || owner.chars().any(char::is_control)
        {
            return Err("Invalid migration inventory scope".into());
        }
        let root = root.canonicalize().map_err(|_| "Data root unavailable")?;
        let root_file = Store::open_directory(&root)?;
        Store::check_directory(&root, &root_file, false)?;
        Self::check_legacy_absent(&root, owner)?;
        let mut directories = vec![Self::identity(&root_file)?];
        let mut records = Vec::new();
        if let Some(sessions) =
            Self::open_optional_directory(&root_file, &root, "structured-sessions", false)?
        {
            let sessions_path = root.join("structured-sessions");
            directories.push(Self::identity(&sessions)?);
            let owner_name = hex::encode(Sha256::digest(owner.as_bytes()));
            if let Some(owner_dir) =
                Self::open_optional_directory(&sessions, &sessions_path, &owner_name, true)?
            {
                let owner_path = sessions_path.join(&owner_name);
                directories.push(Self::identity(&owner_dir)?);
                let before = owner_dir
                    .metadata()
                    .map_err(|_| "Cannot inspect session directory")?;
                for (index, entry) in fs::read_dir(&owner_path)
                    .map_err(|_| "Cannot read session directory")?
                    .enumerate()
                {
                    if index >= 2001 {
                        return Err("Session inventory exceeds its bound".into());
                    }
                    let entry = entry.map_err(|_| "Cannot read session directory")?;
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "Invalid session file name")?;
                    if !name.ends_with(".json") {
                        continue;
                    }
                    if records.len() >= 2000 {
                        return Err("Session inventory exceeds its bound".into());
                    }
                    records.push(Self::read_record(&owner_dir, &owner_path, &name, owner)?);
                }
                let after = owner_dir
                    .metadata()
                    .map_err(|_| "Cannot inspect session directory")?;
                if Self::change_stamp(&before) != Self::change_stamp(&after) {
                    return Err("Session directory changed during inventory".into());
                }
                Store::check_directory(&owner_path, &owner_dir, true)?;
            }
            Store::check_directory(&sessions_path, &sessions, false)?;
        }
        Store::check_directory(&root, &root_file, false)?;
        Self::check_legacy_absent(&root, owner)?;
        records.sort_by(|left, right| left.session.cmp(&right.session));
        Ok(Self {
            root,
            owner: owner.to_owned(),
            directories,
            records,
        })
    }

    pub(super) fn revalidate(&self) -> Result<(), String> {
        if &Self::scan(&self.root, &self.owner)? != self {
            return Err("Session inventory changed".into());
        }
        Ok(())
    }

    fn identity(file: &File) -> Result<(u64, u64), String> {
        let metadata = file.metadata().map_err(|_| "Cannot inspect directory")?;
        Ok((metadata.dev(), metadata.ino()))
    }

    fn change_stamp(metadata: &Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
        (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        )
    }

    fn open_optional_directory(
        parent: &File,
        parent_path: &Path,
        name: &str,
        private: bool,
    ) -> Result<Option<File>, String> {
        let path = parent_path.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot inspect session directory".into()),
            Ok(_) => {}
        }
        let directory = Store::open_child(parent, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        Store::check_directory(&path, &directory, private)?;
        Ok(Some(directory))
    }

    fn check_legacy_absent(root: &Path, owner: &str) -> Result<(), String> {
        let name = crate::structured::sanitize_identifier(owner);
        if name.is_empty() {
            return Err("Legacy account identity requires manual review".into());
        }
        let root_file = Store::open_directory(root)?;
        let Some(users) = Self::open_optional_directory(&root_file, root, "users", false)? else {
            return Ok(());
        };
        let users_path = root.join("users");
        let Some(account) = Self::open_optional_directory(&users, &users_path, &name, false)?
        else {
            return Ok(());
        };
        let legacy = users_path.join(&name).join("structured");
        match fs::symlink_metadata(&legacy) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("Legacy session history requires manual migration".into()),
        }
        Store::check_directory(&users_path.join(name), &account, false)?;
        Store::check_directory(&users_path, &users, false)
    }

    fn read_record(
        directory: &File,
        owner_path: &Path,
        name: &str,
        owner: &str,
    ) -> Result<Record, String> {
        let session = name.strip_suffix(".json").ok_or("Invalid session name")?;
        crate::structured::engine_session_id(session)?;
        let file = Store::open_child(directory, name, libc::O_RDONLY, 0)?;
        let path = owner_path.join(name);
        let before = file
            .metadata()
            .map_err(|_| "Cannot inspect session history")?;
        let check_file = || -> Result<(), String> {
            let current = fs::symlink_metadata(&path).map_err(|_| "Session history unavailable")?;
            if !before.is_file()
                || !current.is_file()
                || current.file_type().is_symlink()
                || before.uid() != unsafe { libc::geteuid() }
                || current.uid() != unsafe { libc::geteuid() }
                || before.mode() & 0o077 != 0
                || current.mode() & 0o077 != 0
                || before.nlink() != 1
                || current.nlink() != 1
                || (before.dev(), before.ino()) != (current.dev(), current.ino())
                || Self::change_stamp(&before) != Self::change_stamp(&current)
            {
                return Err("Session history identity is unsafe".into());
            }
            Ok(())
        };
        check_file()?;
        if before.len() > crate::structured::MAX_STRUCTURED_FILE_BYTES as u64 {
            return Err("Session history exceeds its limit".into());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(crate::structured::MAX_STRUCTURED_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read session history")?;
        let stored = crate::structured::storage::decode(&bytes)?;
        if stored.version == 2 && bytes.last() != Some(&b'\n') {
            return Err("Session history has an incomplete final record".into());
        }
        if stored.owner_id != owner || stored.snapshot.id != session {
            return Err("Session history binding mismatch".into());
        }
        let after = file
            .metadata()
            .map_err(|_| "Cannot inspect session history")?;
        if Self::change_stamp(&before) != Self::change_stamp(&after) {
            return Err("Session history changed during inventory".into());
        }
        check_file()?;
        Ok(Record {
            session: session.to_owned(),
            incarnation: stored.session_incarnation.map(|value| *value.0.as_bytes()),
            device: before.dev(),
            inode: before.ino(),
            digest: Sha256::digest(&bytes).into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structured::{storage, StructuredSessionManager};
    use std::{fs, os::unix::fs::symlink};

    const OWNER: &str = "inventory-owner";

    fn manager(root: &Path) -> StructuredSessionManager {
        StructuredSessionManager::new(terminal_v4_core::AppConfig {
            data_dir: root.into(),
            ..Default::default()
        })
    }

    async fn session(manager: &StructuredSessionManager, root: &Path, owner: &str) -> String {
        manager
            .create_session(owner, root.to_str().unwrap(), Some("claude"), None, None)
            .await
            .unwrap()
            .id
    }

    fn path(manager: &StructuredSessionManager, owner: &str, id: &str) -> std::path::PathBuf {
        crate::structured::structured_session_path(&manager.inner.config, owner, id)
    }

    #[tokio::test]
    async fn inventory_captures_owner_bound_history_without_mutation_and_detects_same_inode_change()
    {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path());
        let first = session(&manager, root.path(), OWNER).await;
        let second = session(&manager, root.path(), OWNER).await;
        let first_path = path(&manager, OWNER, &first);
        let second_path = path(&manager, OWNER, &second);
        let first_bytes = fs::read(&first_path).unwrap();
        let stored = storage::decode(&fs::read(&second_path).unwrap()).unwrap();
        let legacy_bytes = storage::encode_checkpoint(OWNER, &stored.snapshot, None).unwrap();
        fs::write(&second_path, &legacy_bytes).unwrap();

        let inventory = ExistingInventory::scan(root.path(), OWNER).unwrap();
        assert_eq!(inventory.records.len(), 2);
        let first_record = inventory
            .records
            .iter()
            .find(|record| record.session == first)
            .unwrap();
        let second_record = inventory
            .records
            .iter()
            .find(|record| record.session == second)
            .unwrap();
        assert!(first_record.incarnation.is_some());
        assert_eq!(second_record.incarnation, None);
        assert_eq!(fs::read(&first_path).unwrap(), first_bytes);
        assert_eq!(fs::read(&second_path).unwrap(), legacy_bytes);
        inventory.revalidate().unwrap();

        let mut changed = storage::decode(&first_bytes).unwrap();
        changed.snapshot.title = "Changed while preparing migration".into();
        fs::write(
            &first_path,
            storage::encode_checkpoint(OWNER, &changed.snapshot, changed.session_incarnation)
                .unwrap(),
        )
        .unwrap();
        assert!(inventory.revalidate().is_err());
    }

    #[tokio::test]
    async fn inventory_detects_added_removed_and_foreign_history() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path());
        let first = session(&manager, root.path(), OWNER).await;
        let inventory = ExistingInventory::scan(root.path(), OWNER).unwrap();
        let second = session(&manager, root.path(), OWNER).await;
        assert!(inventory.revalidate().is_err());
        let inventory = ExistingInventory::scan(root.path(), OWNER).unwrap();
        fs::remove_file(path(&manager, OWNER, &second)).unwrap();
        assert!(inventory.revalidate().is_err());

        let foreign = session(&manager, root.path(), "different-owner").await;
        let own_path = path(&manager, OWNER, &first);
        fs::copy(path(&manager, "different-owner", &foreign), &own_path).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
    }

    #[tokio::test]
    async fn inventory_rejects_symlinks_and_unmigrated_legacy_history() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path());
        let id = session(&manager, root.path(), OWNER).await;
        let checkpoint = path(&manager, OWNER, &id);
        let relocated = root.path().join("relocated");
        fs::rename(&checkpoint, &relocated).unwrap();
        symlink(&relocated, &checkpoint).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
        fs::remove_file(&checkpoint).unwrap();
        fs::rename(&relocated, &checkpoint).unwrap();
        fs::set_permissions(&checkpoint, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
        fs::set_permissions(&checkpoint, fs::Permissions::from_mode(0o600)).unwrap();
        let owner_dir = checkpoint.parent().unwrap();
        fs::set_permissions(owner_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
        fs::set_permissions(owner_dir, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(root.path().join("users").join(OWNER).join("structured")).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
    }

    #[tokio::test]
    async fn inventory_accepts_version_one_but_rejects_torn_version_two_and_filename_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path());
        let id = session(&manager, root.path(), OWNER).await;
        let checkpoint = path(&manager, OWNER, &id);
        let original = fs::read(&checkpoint).unwrap();
        let mut legacy: serde_json::Value = serde_json::from_slice(&original).unwrap();
        legacy["version"] = 1.into();
        legacy.as_object_mut().unwrap().remove("sessionIncarnation");
        fs::write(&checkpoint, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(
            ExistingInventory::scan(root.path(), OWNER).unwrap().records[0].incarnation,
            None
        );

        let mut torn = original.clone();
        torn.extend_from_slice(b"{\"event\":");
        fs::write(&checkpoint, torn).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
        fs::write(&checkpoint, original).unwrap();
        let wrong = path(&manager, OWNER, "ss-ffffffffffffffffffffffffffffffff");
        fs::rename(&checkpoint, &wrong).unwrap();
        assert!(ExistingInventory::scan(root.path(), OWNER).is_err());
    }

    #[tokio::test]
    async fn inventory_rejects_replaced_owner_directory_but_ignores_other_owners() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path());
        let id = session(&manager, root.path(), OWNER).await;
        let checkpoint = path(&manager, OWNER, &id);
        let inventory = ExistingInventory::scan(root.path(), OWNER).unwrap();
        session(&manager, root.path(), "different-owner").await;
        inventory.revalidate().unwrap();

        let owner_dir = checkpoint.parent().unwrap();
        let moved = root.path().join("old-owner-directory");
        fs::rename(owner_dir, &moved).unwrap();
        fs::create_dir(owner_dir).unwrap();
        fs::set_permissions(owner_dir, fs::Permissions::from_mode(0o700)).unwrap();
        fs::copy(moved.join(checkpoint.file_name().unwrap()), &checkpoint).unwrap();
        assert!(inventory.revalidate().is_err());
    }

    #[tokio::test]
    async fn inventory_revalidates_after_another_process_updates_history() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path());
        let id = session(&manager, root.path(), OWNER).await;
        let inventory = ExistingInventory::scan(root.path(), OWNER).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::ownership::provision::enrollment::existing::tests::modify_history_fixture",
                "--nocapture",
            ])
            .env("V4_INVENTORY_HISTORY_PATH", path(&manager, OWNER, &id))
            .status()
            .unwrap();
        assert!(status.success());
        assert!(inventory.revalidate().is_err());
    }

    #[test]
    fn modify_history_fixture() {
        let Some(path) = std::env::var_os("V4_INVENTORY_HISTORY_PATH") else {
            return;
        };
        let mut stored = storage::decode(&fs::read(&path).unwrap()).unwrap();
        stored.snapshot.title = "Edited by another process".into();
        fs::write(
            path,
            storage::encode_checkpoint(OWNER, &stored.snapshot, stored.session_incarnation)
                .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn empty_inventory_is_read_only_and_detects_later_creation() {
        let root = tempfile::tempdir().unwrap();
        let inventory = ExistingInventory::scan(root.path(), OWNER).unwrap();
        assert!(inventory.records.is_empty());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        fs::create_dir(root.path().join("structured-sessions")).unwrap();
        assert!(inventory.revalidate().is_err());
    }
}
