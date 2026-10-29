//! Experimental start reservations; not connected to production routes.
//!
//! A pending record never authorizes another creation. Completion requires a
//! caller-supplied verifier while the caller still owns the session lifecycle
//! fence. The data directory must be a stable private local filesystem with
//! reliable locks, atomic file publication and sync. Old binaries do not use
//! this lock. Missing or rolled-back storage has no trusted bootstrap identity,
//! so absence alone cannot safely authorize a retry of a previously sent request.
//! A committed record does not by itself prove that its session still exists.

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartInput {
    pub cwd: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub service_tier: Option<String>,
    pub title: Option<String>,
    pub prompt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reservation {
    version: u8,
    pub owner: String,
    pub operation_id: Uuid,
    pub input: StartInput,
    pub session_id: String,
    pub incarnation: Uuid,
    pub completed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReserveResult {
    New(Reservation),
    Pending(Reservation),
    Completed(Reservation),
}

pub(super) fn reserve(
    data: &Path,
    owner: &str,
    operation_id: Uuid,
    input: &StartInput,
) -> Result<ReserveResult, String> {
    validate(owner, operation_id, input)?;
    let _guard = lock_root(data)?;
    let directory = owner_dir(data, owner)?;
    let path = directory.join(format!("{operation_id}.json"));
    if path.exists() {
        let stored = read_record(&path)?;
        if stored.owner != owner || stored.operation_id != operation_id || stored.input != *input {
            return Err("This start request belongs to different inputs".into());
        }
        return Ok(if stored.completed {
            ReserveResult::Completed(stored)
        } else {
            ReserveResult::Pending(stored)
        });
    }
    let count = fs::read_dir(&directory)
        .map_err(|_| "Cannot inspect start storage")?
        .take(4096)
        .try_fold(0usize, |count, entry| entry.map(|_| count + 1))
        .map_err(|_| "Cannot inspect start storage")?;
    if count >= 4096 {
        return Err("Start storage capacity reached; review existing requests".into());
    }
    let record = Reservation {
        version: 1,
        owner: owner.into(),
        operation_id,
        input: input.clone(),
        session_id: format!("ss-{}", Uuid::new_v4().simple()),
        incarnation: Uuid::new_v4(),
        completed: false,
    };
    write_record(data, &directory, &path, &record, true)?;
    Ok(ReserveResult::New(record))
}

pub(super) fn complete(
    data: &Path,
    claim: &Reservation,
    verify: impl FnOnce(&Reservation) -> Result<(), String>,
) -> Result<(), String> {
    validate(&claim.owner, claim.operation_id, &claim.input)?;
    if claim.completed {
        return Err("Invalid start reservation".into());
    }
    let _guard = lock_root(data)?;
    let directory = owner_dir(data, &claim.owner)?;
    let path = directory.join(format!("{}.json", claim.operation_id));
    let stored = read_record(&path)?;
    if stored != *claim {
        return Err("Start reservation changed".into());
    }
    verify(&stored)?;
    let mut completed = stored;
    completed.completed = true;
    write_record(data, &directory, &path, &completed, false)
}

fn validate(owner: &str, operation_id: Uuid, input: &StartInput) -> Result<(), String> {
    let text = |value: &str, max: usize| {
        !value.is_empty() && value.len() <= max && !value.chars().any(|c| c == '\0')
    };
    if !text(owner, 1024)
        || operation_id.is_nil()
        || !text(&input.cwd, 4096)
        || !text(&input.prompt, 200_000)
        || input.provider.as_deref().is_some_and(|v| !text(v, 1024))
        || input.model.as_deref().is_some_and(|v| !text(v, 200))
        || input.reasoning.as_deref().is_some_and(|v| !text(v, 40))
        || input.service_tier.as_deref().is_some_and(|v| !text(v, 40))
        || input.title.as_deref().is_some_and(|v| !text(v, 80))
    {
        return Err("Invalid start request".into());
    }
    Ok(())
}

struct RootGuard {
    file: fs::File,
    #[cfg(unix)]
    owner_pid: libc::pid_t,
}

#[cfg(unix)]
impl RootGuard {
    fn unlock_owned(&self) {
        use std::os::fd::AsRawFd;
        if unsafe { libc::getpid() } == self.owner_pid {
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for RootGuard {
    fn drop(&mut self) {
        self.unlock_owned();
    }
}

#[cfg(unix)]
fn lock_root(data: &Path) -> Result<RootGuard, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let before = fs::symlink_metadata(data).map_err(|_| "Start storage is unavailable")?;
    if !before.is_dir()
        || before.file_type().is_symlink()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o022 != 0
    {
        return Err("Start storage is unsafe".into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(data)
        .map_err(|_| "Cannot open start storage")?;
    file.try_lock().map_err(|_| "Start storage is busy")?;
    let guard = RootGuard {
        file,
        owner_pid: unsafe { libc::getpid() },
    };
    let opened = guard
        .file
        .metadata()
        .map_err(|_| "Cannot inspect start storage")?;
    let current = fs::symlink_metadata(data).map_err(|_| "Start storage is unavailable")?;
    if current.file_type().is_symlink()
        || !current.is_dir()
        || (before.dev(), before.ino()) != (opened.dev(), opened.ino())
        || (current.dev(), current.ino()) != (opened.dev(), opened.ino())
    {
        return Err("Start storage changed".into());
    }
    Ok(guard)
}

#[cfg(not(unix))]
fn lock_root(_data: &Path) -> Result<RootGuard, String> {
    Err("Durable start requests are unavailable on this platform".into())
}

#[cfg(unix)]
fn owner_dir(data: &Path, owner: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let base = data.join("structured-start-intents");
    let owner_dir = base.join(hex::encode(Sha256::digest(owner.as_bytes())));
    for path in [&base, &owner_dir] {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Cannot create start storage".into()),
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "Cannot inspect start storage")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err("Start storage is unsafe".into());
        }
    }
    Ok(owner_dir)
}

#[cfg(not(unix))]
fn owner_dir(_data: &Path, _owner: &str) -> Result<PathBuf, String> {
    Err("Durable start requests are unavailable on this platform".into())
}

#[cfg(unix)]
fn read_record(path: &Path) -> Result<Reservation, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "Start request is unavailable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect start request")?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() > 256_000
    {
        return Err("Start request is unsafe".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(256_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read start request")?;
    if bytes.len() > 256_000 {
        return Err("Start request is too large".into());
    }
    let after = file
        .metadata()
        .map_err(|_| "Cannot inspect start request")?;
    if (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.modified().ok(),
    ) != (after.dev(), after.ino(), after.len(), after.modified().ok())
    {
        return Err("Start request changed during read".into());
    }
    let record: Reservation =
        serde_json::from_slice(&bytes).map_err(|_| "Start request is invalid")?;
    validate(&record.owner, record.operation_id, &record.input)?;
    let session = Uuid::parse_str(record.session_id.strip_prefix("ss-").unwrap_or(""))
        .map_err(|_| "Invalid start session")?;
    if record.version != 1
        || record.incarnation.is_nil()
        || session.is_nil()
        || record.session_id != format!("ss-{}", session.simple())
    {
        return Err("Start session identity is invalid".into());
    }
    Ok(record)
}

#[cfg(not(unix))]
fn read_record(_path: &Path) -> Result<Reservation, String> {
    Err("Durable start requests are unavailable on this platform".into())
}

fn write_record(
    data: &Path,
    directory: &Path,
    path: &Path,
    record: &Reservation,
    create_only: bool,
) -> Result<(), String> {
    let payload = serde_json::to_vec(record).map_err(|_| "Cannot encode start request")?;
    if payload.len() > 256_000 {
        return Err("Start request is too large".into());
    }
    let mut file =
        tempfile::NamedTempFile::new_in(directory).map_err(|_| "Cannot create start request")?;
    file.write_all(&payload)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot save start request")?;
    if create_only {
        file.persist_noclobber(path)
            .map_err(|_| "Cannot commit start request")?;
    } else {
        file.persist(path)
            .map_err(|_| "Cannot commit start request")?;
    }
    for path in [directory, &data.join("structured-start-intents"), data] {
        fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Start request is unconfirmed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> StartInput {
        StartInput {
            cwd: "/synthetic/project".into(),
            provider: Some("codex".into()),
            model: Some("fixture-model".into()),
            reasoning: None,
            service_tier: None,
            title: Some("Synthetic task".into()),
            prompt: "Review this project".into(),
        }
    }

    #[test]
    fn reservation_binds_exact_inputs_and_owner_across_reopen() {
        let root = tempfile::tempdir().unwrap();
        let operation = Uuid::new_v4();
        let request = input();
        let ReserveResult::New(claim) = reserve(root.path(), "owner", operation, &request).unwrap()
        else {
            panic!("expected new claim")
        };
        assert_eq!(
            reserve(root.path(), "owner", operation, &request).unwrap(),
            ReserveResult::Pending(claim.clone())
        );
        let mut changed = request.clone();
        changed.prompt.push('!');
        assert!(reserve(root.path(), "owner", operation, &changed).is_err());
        let ReserveResult::New(other) =
            reserve(root.path(), "other-owner", operation, &request).unwrap()
        else {
            panic!("expected separate owner")
        };
        assert_ne!(claim.session_id, other.session_id);
        assert!(complete(root.path(), &claim, |_| Err("unconfirmed".into())).is_err());
        assert_eq!(
            reserve(root.path(), "owner", operation, &request).unwrap(),
            ReserveResult::Pending(claim.clone())
        );
        complete(root.path(), &claim, |_| Ok(())).unwrap();
        let mut committed = claim.clone();
        committed.completed = true;
        assert_eq!(
            reserve(root.path(), "owner", operation, &request).unwrap(),
            ReserveResult::Completed(committed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn reservation_lock_is_released_when_a_forked_child_inherits_the_descriptor() {
        let root = tempfile::tempdir().unwrap();
        let guard = lock_root(root.path()).unwrap();
        let mut ready = [-1; 2];
        let mut release = [-1; 2];
        unsafe {
            assert_eq!(libc::pipe(ready.as_mut_ptr()), 0);
            assert_eq!(libc::pipe(release.as_mut_ptr()), 0);
            let pid = libc::fork();
            assert!(pid >= 0);
            if pid == 0 {
                libc::close(ready[0]);
                libc::close(release[1]);
                guard.unlock_owned();
                let signal = [1_u8];
                libc::write(ready[1], signal.as_ptr().cast(), 1);
                let mut signal = [0_u8];
                libc::read(release[0], signal.as_mut_ptr().cast(), 1);
                libc::_exit(0);
            }
            libc::close(ready[1]);
            libc::close(release[0]);
            let mut signal = [0_u8];
            assert_eq!(libc::read(ready[0], signal.as_mut_ptr().cast(), 1), 1);
            let premature = lock_root(root.path());
            drop(guard);
            let reopened = lock_root(root.path());
            let signal = [1_u8];
            libc::write(release[1], signal.as_ptr().cast(), 1);
            libc::close(ready[0]);
            libc::close(release[1]);
            let mut status = 0;
            assert_eq!(libc::waitpid(pid, &mut status, 0), pid);
            assert!(
                premature.is_err(),
                "a forked child released the parent's reservation lock"
            );
            assert!(
                reopened.is_ok(),
                "a forked child retained the reservation lock"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "invoked by start-reservation process tests"]
    fn reservation_process_fixture() {
        use std::time::{Duration, Instant};
        let root = PathBuf::from(std::env::var_os("V4_START_RESERVATION_ROOT").unwrap());
        let operation =
            Uuid::parse_str(&std::env::var("V4_START_RESERVATION_ID").unwrap()).unwrap();
        let worker = std::env::var("V4_START_RESERVATION_WORKER").unwrap();
        let mode = std::env::var("V4_START_RESERVATION_MODE").unwrap();
        fs::write(root.join(format!("ready-{worker}")), b"ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join("start").exists() {
            assert!(Instant::now() < deadline, "reservation race did not start");
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = loop {
            match reserve(&root, "owner", operation, &input()) {
                Ok(result) => break result,
                Err(error) if error == "Start storage is busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("reservation failed: {error}"),
            }
        };
        if mode == "crash" {
            std::process::exit(89);
        }
        let (state, record) = match result {
            ReserveResult::New(record) => ("new", record),
            ReserveResult::Pending(record) => ("pending", record),
            ReserveResult::Completed(_) => panic!("unexpected completed reservation"),
        };
        fs::write(
            root.join(format!("result-{worker}")),
            format!("{state}:{}", record.session_id),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn same_request_has_one_cross_process_reservation() {
        use std::time::{Duration, Instant};
        let root = tempfile::tempdir().unwrap();
        let operation = Uuid::new_v4();
        let executable = std::env::current_exe().unwrap();
        let mut children: Vec<_> = (1..=4)
            .map(|worker| {
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "structured::start::tests::reservation_process_fixture",
                        "--ignored",
                    ])
                    .env("V4_START_RESERVATION_ROOT", root.path())
                    .env("V4_START_RESERVATION_ID", operation.to_string())
                    .env("V4_START_RESERVATION_WORKER", worker.to_string())
                    .env("V4_START_RESERVATION_MODE", "race")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !(1..=4).all(|worker| root.path().join(format!("ready-{worker}")).exists()) {
            if Instant::now() >= deadline {
                for child in &mut children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                panic!("reservation writers did not start");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(root.path().join("start"), b"start").unwrap();
        for child in &mut children {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("reservation writer did not finish");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let outcomes: Vec<_> = (1..=4)
            .map(|worker| fs::read_to_string(root.path().join(format!("result-{worker}"))).unwrap())
            .collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|value| value.starts_with("new:"))
                .count(),
            1
        );
        let ids: Vec<_> = outcomes
            .iter()
            .map(|value| value.split_once(':').unwrap().1)
            .collect();
        assert!(ids.iter().all(|id| *id == ids[0]));
        assert!(matches!(
            reserve(root.path(), "owner", operation, &input()).unwrap(),
            ReserveResult::Pending(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn process_exit_after_reservation_keeps_it_held() {
        use std::time::{Duration, Instant};
        let root = tempfile::tempdir().unwrap();
        let operation = Uuid::new_v4();
        fs::write(root.path().join("start"), b"start").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::start::tests::reservation_process_fixture",
                "--ignored",
            ])
            .env("V4_START_RESERVATION_ROOT", root.path())
            .env("V4_START_RESERVATION_ID", operation.to_string())
            .env("V4_START_RESERVATION_WORKER", "1")
            .env("V4_START_RESERVATION_MODE", "crash")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("reservation fixture did not exit");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(status.code(), Some(89));
        let ReserveResult::Pending(record) =
            reserve(root.path(), "owner", operation, &input()).unwrap()
        else {
            panic!("reservation should remain held")
        };
        assert!(!record.completed);
    }

    #[cfg(unix)]
    #[test]
    fn corrupt_or_symlinked_reservation_is_not_recreated_or_overwritten() {
        use std::os::unix::fs::symlink;
        for replace_with_link in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let operation = Uuid::new_v4();
            let request = input();
            assert!(matches!(
                reserve(root.path(), "owner", operation, &request).unwrap(),
                ReserveResult::New(_)
            ));
            let record = root
                .path()
                .join("structured-start-intents")
                .join(hex::encode(Sha256::digest(b"owner")))
                .join(format!("{operation}.json"));
            let target = root.path().join("unrelated");
            fs::write(&target, b"unchanged synthetic file").unwrap();
            if replace_with_link {
                fs::remove_file(&record).unwrap();
                symlink(&target, &record).unwrap();
            } else {
                fs::write(&record, b"invalid reservation").unwrap();
            }
            assert!(reserve(root.path(), "owner", operation, &request).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"unchanged synthetic file");
            if !replace_with_link {
                assert_eq!(fs::read(record).unwrap(), b"invalid reservation");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_data_root_or_owner_directory_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let outside = root.path().join("outside");
        fs::create_dir(&data).unwrap();
        fs::create_dir(&outside).unwrap();
        let alias = root.path().join("alias");
        symlink(&data, &alias).unwrap();
        assert!(reserve(&alias, "owner", Uuid::new_v4(), &input()).is_err());
        assert!(!data.join("structured-start-intents").exists());

        let base = data.join("structured-start-intents");
        fs::create_dir(&base).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let owner = base.join(hex::encode(Sha256::digest(b"owner")));
        symlink(&outside, &owner).unwrap();
        assert!(reserve(&data, "owner", Uuid::new_v4(), &input()).is_err());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn completed_reservation_survives_checkpoint_deletion_without_allocating_a_new_session() {
        use crate::structured::{storage, SessionIncarnation, StructuredSessionManager};
        use terminal_v4_core::{AppConfig, StructuredSessionSnapshot};

        let root = tempfile::tempdir().unwrap();
        let operation = Uuid::new_v4();
        let request = input();
        let ReserveResult::New(claim) = reserve(root.path(), "owner", operation, &request).unwrap()
        else {
            panic!("expected new claim")
        };
        let config = AppConfig {
            data_dir: root.path().into(),
            ..Default::default()
        };
        let manager = StructuredSessionManager::new(config.clone());
        let snapshot = StructuredSessionSnapshot {
            id: claim.session_id.clone(),
            title: "Synthetic task".into(),
            cwd: request.cwd.clone(),
            provider: "codex".into(),
            runtime: Some("codex".into()),
            model: request.model.clone(),
            reasoning: None,
            service_tier: None,
            access_mode: None,
            status: Some("idle".into()),
            created_at: "2026-10-27T00:00:00Z".into(),
            updated_at: "2026-10-27T00:00:00Z".into(),
            thread: None,
            events: vec![],
        };
        manager
            .persist_new_snapshot(
                "owner",
                &snapshot,
                Some(SessionIncarnation(claim.incarnation)),
            )
            .unwrap();
        let path = crate::structured::structured_session_path(&config, "owner", &claim.session_id);
        complete(root.path(), &claim, |value| {
            let stored = storage::read_for_recovery(&config, &value.owner, &value.session_id)?;
            if stored.owner_id != value.owner
                || stored.session_incarnation != Some(SessionIncarnation(value.incarnation))
                || stored.snapshot.id != value.session_id
            {
                return Err("Checkpoint identity changed".into());
            }
            fs::File::open(&path)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
            for directory in [
                path.parent().unwrap(),
                &root.path().join("structured-sessions"),
                root.path(),
            ] {
                fs::File::open(directory)
                    .and_then(|file| file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .unwrap();
        fs::remove_file(&path).unwrap();
        fs::File::open(path.parent().unwrap())
            .unwrap()
            .sync_all()
            .unwrap();
        let ReserveResult::Completed(prior) =
            reserve(root.path(), "owner", operation, &request).unwrap()
        else {
            panic!("deleted session must stay bound to its reservation")
        };
        assert_eq!(prior.session_id, claim.session_id);
        assert!(!path.exists());
    }
}
