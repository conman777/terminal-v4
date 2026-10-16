use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tokio::sync::Notify;
#[derive(Default)]
struct Active {
    readers: usize,
    writer: bool,
}
#[derive(Default)]
struct Registry {
    active: Mutex<HashMap<PathBuf, Active>>,
    changed: Notify,
}
static REGISTRY: OnceLock<Registry> = OnceLock::new();
fn registry() -> &'static Registry {
    REGISTRY.get_or_init(Default::default)
}
pub(crate) fn workspace_key(path: &Path) -> Result<PathBuf, String> {
    let mut existing = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "Workspace unavailable")?
            .join(path)
    };
    while !existing.exists() {
        if !existing.pop() {
            return Err("Workspace unavailable".into());
        }
    }
    let canonical = std::fs::canonicalize(existing).map_err(|_| "Workspace unavailable")?;
    let mut key = canonical
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
        .unwrap_or(&canonical)
        .to_path_buf();
    if cfg!(windows) {
        key = PathBuf::from(key.to_string_lossy().to_lowercase());
    }
    Ok(key)
}
pub(crate) struct WorkspaceActivity {
    key: PathBuf,
    exclusive: bool,
}
impl Drop for WorkspaceActivity {
    fn drop(&mut self) {
        if let Ok(mut active) = registry().active.lock() {
            if let Some(value) = active.get_mut(&self.key) {
                if self.exclusive {
                    value.writer = false;
                } else {
                    value.readers = value.readers.saturating_sub(1);
                }
                if value.readers == 0 && !value.writer {
                    active.remove(&self.key);
                }
            }
        }
        registry().changed.notify_waiters();
    }
}
fn acquire(key: PathBuf, exclusive: bool) -> Result<WorkspaceActivity, String> {
    let mut active = registry()
        .active
        .lock()
        .map_err(|_| "Workspace coordination unavailable")?;
    if active.iter().any(|(path, value)| {
        (key.starts_with(path) || path.starts_with(&key))
            && (value.writer || (exclusive && value.readers > 0))
    }) {
        return Err("Workspace has active work or rewind in progress".into());
    }
    let value = active.entry(key.clone()).or_default();
    if exclusive {
        value.writer = true;
    } else {
        value.readers += 1;
    }
    Ok(WorkspaceActivity { key, exclusive })
}
pub(crate) fn enter(path: &Path) -> Result<WorkspaceActivity, String> {
    acquire(workspace_key(path)?, false)
}
pub(crate) fn exclusive(path: &Path) -> Result<WorkspaceActivity, String> {
    acquire(workspace_key(path)?, true)
}
pub(crate) async fn enter_wait(path: &Path) -> Result<WorkspaceActivity, String> {
    let key = workspace_key(path)?;
    loop {
        let changed = registry().changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if let Ok(guard) = acquire(key.clone(), false) {
            return Ok(guard);
        }
        changed.await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ancestor_mutations_conflict_with_a_rewinding_nested_checkout() {
        let parent = tempfile::tempdir().unwrap();
        let child = parent.path().join("checkout");
        std::fs::create_dir_all(child.join(".git")).unwrap();
        let guard = exclusive(&child).unwrap();
        assert!(enter(parent.path()).is_err());
        drop(guard);
        let mutation = enter(parent.path()).unwrap();
        assert!(exclusive(&child).is_err());
        drop(mutation);
    }
    #[test]
    fn relative_new_paths_resolve_to_the_current_checkout() {
        assert_eq!(
            workspace_key(Path::new("new-relative-file-does-not-exist.txt")).unwrap(),
            workspace_key(Path::new(".")).unwrap()
        );
    }
    #[test]
    fn checkout_children_and_new_files_share_the_rewind_guard() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join(".git")).unwrap();
        std::fs::create_dir(directory.path().join("src")).unwrap();
        let active = enter(&directory.path().join("src/new.txt")).unwrap();
        assert!(exclusive(directory.path()).is_err());
        drop(active);
        let guard = exclusive(directory.path()).unwrap();
        assert!(enter(&directory.path().join("src")).is_err());
        drop(guard);
    }
    #[test]
    fn active_work_excludes_rewind_and_aliases_share_a_guard() {
        let directory = tempfile::tempdir().unwrap();
        let active = enter(directory.path()).unwrap();
        assert!(exclusive(&directory.path().join(".")).is_err());
        drop(active);
        let rewind = exclusive(directory.path()).unwrap();
        assert!(enter(directory.path()).is_err());
        drop(rewind);
        assert!(enter(directory.path()).is_ok());
    }
}
