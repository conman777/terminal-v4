use super::*;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScheduleChange {
    Pause,
    Resume,
    Run,
    Remove,
    Edit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleEdit {
    pub prompt: Option<String>,
    pub timing: Option<ScheduleTiming>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ScheduleTiming {
    Interval {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u64,
    },
    Once {
        #[serde(rename = "runOnceAt")]
        run_once_at: u64,
    },
    Calendar {
        at: CalendarTime,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewedScheduleChange {
    #[serde(skip)]
    data_dir: PathBuf,
    owner: String,
    session_id: String,
    turn_id: String,
    workspace: String,
    action: ScheduleChange,
    schedule: ScheduleRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    proposed: Option<ScheduleRecord>,
    #[serde(skip)]
    timing_edited: bool,
}

fn proposed_edit(
    schedule: &ScheduleRecord,
    changes: ScheduleEdit,
    now: u64,
) -> Result<ScheduleRecord, String> {
    if changes.prompt.is_none() && changes.timing.is_none() {
        return Err("Provide a prompt or a timing change".into());
    }
    let mut proposed = schedule.clone();
    if let Some(prompt) = changes.prompt {
        proposed.input.prompt = prompt;
        validate_task(&proposed.input).map_err(|error| error.message)?;
    }
    if let Some(timing) = changes.timing {
        if schedule.run_once_at.is_some() && schedule.last_task_id.is_some() {
            return Err("This one-shot has already run; create a new schedule".into());
        }
        let first_run = match timing {
            ScheduleTiming::Interval { interval_seconds } => {
                validate_interval(interval_seconds).map_err(|error| error.message)?;
                proposed.interval_seconds = interval_seconds;
                proposed.at = None;
                proposed.run_once_at = None;
                now.saturating_add(interval_seconds.saturating_mul(1000))
            }
            ScheduleTiming::Once { run_once_at } => {
                if run_once_at <= now || run_once_at > 8_640_000_000_000_000 {
                    return Err("Choose a future one-shot time".into());
                }
                if schedule.last_task_id.is_some() {
                    return Err(
                        "This schedule already has a run; create a new one-shot schedule".into(),
                    );
                }
                proposed.interval_seconds = 0;
                proposed.at = None;
                proposed.run_once_at = Some(run_once_at);
                run_once_at
            }
            ScheduleTiming::Calendar { at } => {
                validate_calendar(&at).map_err(|error| error.message)?;
                let next = next_calendar_run(now, &at);
                if next == u64::MAX {
                    return Err("The calendar has no valid next run".into());
                }
                proposed.interval_seconds = 0;
                proposed.at = Some(at);
                proposed.run_once_at = None;
                next
            }
        };
        proposed.next_run_at = proposed.enabled.then_some(first_run);
    }
    Ok(proposed)
}

fn check_action(schedule: &ScheduleRecord, action: ScheduleChange, now: u64) -> Result<(), String> {
    if matches!(action, ScheduleChange::Resume | ScheduleChange::Run) {
        if schedule.at.is_some() && schedule.run_once_at.is_some() {
            return Err("Saved schedule has conflicting timing; remove or repair it first".into());
        }
        if let Some(at) = &schedule.at {
            validate_calendar(at)
                .map_err(|_| "Saved schedule has invalid timing; remove or repair it first")?;
            if next_calendar_run(now, at) == u64::MAX {
                return Err("Saved schedule has no valid next run".into());
            }
        } else if schedule.run_once_at.is_none()
            && !(60..=2_592_000).contains(&schedule.interval_seconds)
        {
            return Err("Saved schedule has invalid timing; remove or repair it first".into());
        }
    }
    match action {
        ScheduleChange::Pause if !schedule.enabled => Err("This schedule is already paused".into()),
        ScheduleChange::Resume if schedule.enabled => {
            Err("This schedule is already enabled".into())
        }
        ScheduleChange::Resume
            if schedule.run_once_at.is_some() && schedule.last_task_id.is_some() =>
        {
            Err("This one-shot schedule has already run".into())
        }
        ScheduleChange::Resume if schedule.run_once_at.is_some_and(|when| when <= now) => {
            Err("This one-shot time has passed; run it now or create a new schedule".into())
        }
        ScheduleChange::Run
            if schedule.run_once_at.is_some() && schedule.last_task_id.is_some() =>
        {
            Err("This one-shot schedule has already run".into())
        }
        _ => Ok(()),
    }
}

pub(crate) async fn prepare_reviewed_schedule_change(
    data_dir: PathBuf,
    owner: String,
    session_id: String,
    turn_id: String,
    workspace: String,
    id: Uuid,
    action: ScheduleChange,
) -> Result<ReviewedScheduleChange, String> {
    if action == ScheduleChange::Edit {
        return Err("Schedule edit requires changes".into());
    }
    prepare(
        data_dir, owner, session_id, turn_id, workspace, id, action, None,
    )
    .await
}

pub(crate) async fn prepare_reviewed_schedule_edit(
    data_dir: PathBuf,
    owner: String,
    session_id: String,
    turn_id: String,
    workspace: String,
    id: Uuid,
    changes: ScheduleEdit,
) -> Result<ReviewedScheduleChange, String> {
    prepare(
        data_dir,
        owner,
        session_id,
        turn_id,
        workspace,
        id,
        ScheduleChange::Edit,
        Some(changes),
    )
    .await
}

async fn prepare(
    data_dir: PathBuf,
    owner: String,
    session_id: String,
    turn_id: String,
    workspace: String,
    id: Uuid,
    action: ScheduleChange,
    changes: Option<ScheduleEdit>,
) -> Result<ReviewedScheduleChange, String> {
    if owner.is_empty()
        || session_id.is_empty()
        || turn_id.is_empty()
        || !FsPath::new(&workspace).is_absolute()
    {
        return Err("Invalid schedule scope".into());
    }
    let workspace_path = workspace.clone();
    let canonical = tokio::task::spawn_blocking(move || std::fs::canonicalize(workspace_path))
        .await
        .map_err(|_| "Workspace is unavailable")?
        .map_err(|_| "Workspace is unavailable")?;
    if !canonical.is_dir() || canonical != FsPath::new(&workspace) {
        return Err("Workspace changed; review the schedule again".into());
    }
    let schedules = read_owner_schedules(data_dir.clone(), owner.clone()).await?;
    let schedule = schedules
        .into_iter()
        .find(|schedule| {
            schedule.id == id
                && schedule.input.parent_session_id.as_deref() == Some(session_id.as_str())
                && schedule.input.workspace_path == workspace
        })
        .ok_or("Schedule is unavailable in this conversation")?;
    check_action(&schedule, action, now_ms())?;
    let timing_edited = changes
        .as_ref()
        .is_some_and(|changes| changes.timing.is_some());
    let proposed = changes
        .map(|changes| proposed_edit(&schedule, changes, now_ms()))
        .transpose()?;
    Ok(ReviewedScheduleChange {
        data_dir,
        owner,
        session_id,
        turn_id,
        workspace,
        action,
        schedule,
        proposed,
        timing_edited,
    })
}

/// The store lock and final approval checks are the commit boundary. The
/// caller must await this operation after it starts, even when cancelled.
pub(crate) async fn commit_reviewed_schedule_change(
    reviewed: ReviewedScheduleChange,
    expires_at: i64,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || commit_locked(reviewed, expires_at, cancelled))
        .await
        .map_err(|_| "Schedule outcome is uncertain; inspect it before retrying".to_string())?
}

#[cfg(not(unix))]
fn commit_locked(
    _reviewed: ReviewedScheduleChange,
    _expires_at: i64,
    _cancelled: impl Fn() -> bool,
) -> Result<serde_json::Value, String> {
    Err("Schedule management is unavailable on this platform".into())
}

#[cfg(unix)]
fn commit_locked(
    reviewed: ReviewedScheduleChange,
    expires_at: i64,
    cancelled: impl Fn() -> bool,
) -> Result<serde_json::Value, String> {
    use std::{
        ffi::CString,
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt},
            },
        },
    };
    let unavailable = || "Schedule storage is unavailable or busy".to_string();
    let _local = STORE_LOCK.try_lock().map_err(|_| unavailable())?;
    if cancelled() || expires_at <= now_ms() as i64 {
        return Err("Schedule approval expired or was cancelled".into());
    }
    let root = reviewed
        .data_dir
        .canonicalize()
        .map_err(|_| unavailable())?;
    let root_file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&root)
        .map_err(|_| unavailable())?;
    let safe = |metadata: &std::fs::Metadata| {
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o022 == 0
    };
    let child = |parent: &std::fs::File,
                 name: &std::ffi::CStr,
                 flags: i32|
     -> Result<std::fs::File, String> {
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(unavailable());
        }
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    };
    let directory_file = child(
        &root_file,
        c"workspace-tasks",
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let lock_file = child(&directory_file, c"store.lock", libc::O_RDWR)?;
    let lock_meta = lock_file.metadata().map_err(|_| unavailable())?;
    if !lock_meta.is_file() || !safe(&lock_meta) || lock_meta.nlink() != 1 {
        return Err(unavailable());
    }
    lock_file.try_lock().map_err(|_| unavailable())?;
    let path = store_path(&root, &reviewed.owner);
    let name = CString::new(path.file_name().ok_or_else(unavailable)?.as_bytes())
        .map_err(|_| unavailable())?;
    let mut store_file = child(&directory_file, &name, libc::O_RDONLY)?;
    let opened = store_file.metadata().map_err(|_| unavailable())?;
    if !opened.is_file() || !safe(&opened) || opened.nlink() != 1 || opened.len() > 32 * 1024 * 1024
    {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    (&mut store_file)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(unavailable());
    }
    let validate = || -> Result<(), String> {
        let root_current = std::fs::symlink_metadata(&root).map_err(|_| unavailable())?;
        let root_open = root_file.metadata().map_err(|_| unavailable())?;
        let directory_current =
            std::fs::symlink_metadata(root.join("workspace-tasks")).map_err(|_| unavailable())?;
        let directory_open = directory_file.metadata().map_err(|_| unavailable())?;
        let lock_current = std::fs::symlink_metadata(root.join("workspace-tasks/store.lock"))
            .map_err(|_| unavailable())?;
        let lock_open = lock_file.metadata().map_err(|_| unavailable())?;
        let store_current = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
        let store_open = store_file.metadata().map_err(|_| unavailable())?;
        let same =
            |a: &std::fs::Metadata, b: &std::fs::Metadata| (a.dev(), a.ino()) == (b.dev(), b.ino());
        if reviewed.data_dir.canonicalize().ok().as_ref() != Some(&root)
            || !root_current.is_dir()
            || !directory_current.is_dir()
            || !lock_current.is_file()
            || !store_current.is_file()
            || root_current.file_type().is_symlink()
            || directory_current.file_type().is_symlink()
            || lock_current.file_type().is_symlink()
            || store_current.file_type().is_symlink()
            || ![
                &root_current,
                &root_open,
                &directory_current,
                &directory_open,
                &lock_current,
                &lock_open,
                &store_current,
                &store_open,
            ]
            .iter()
            .all(|meta| safe(meta))
            || !same(&root_current, &root_open)
            || !same(&directory_current, &directory_open)
            || !same(&lock_current, &lock_open)
            || !same(&store_current, &store_open)
            || lock_open.nlink() != 1
            || store_open.nlink() != 1
            || (
                store_open.len(),
                store_open.mtime(),
                store_open.mtime_nsec(),
                store_open.ctime(),
                store_open.ctime_nsec(),
            ) != (
                opened.len(),
                opened.mtime(),
                opened.mtime_nsec(),
                opened.ctime(),
                opened.ctime_nsec(),
            )
        {
            return Err(unavailable());
        }
        Ok(())
    };
    validate()?;
    let (mut store, _) = decode_store(&bytes, &reviewed.owner).map_err(|_| unavailable())?;
    for receipt in completion_records(&root, &reviewed.owner) {
        if let Some(task) = store.tasks.iter_mut().find(|task| task.id == receipt.id) {
            merge_completion(task, receipt);
        }
    }
    let index = store
        .schedules
        .iter()
        .position(|schedule| {
            schedule.id == reviewed.schedule.id
                && schedule.input.parent_session_id.as_deref() == Some(reviewed.session_id.as_str())
                && schedule.input.workspace_path == reviewed.workspace
        })
        .ok_or("Schedule is unavailable in this conversation")?;
    if serde_json::to_value(&store.schedules[index]).map_err(|_| unavailable())?
        != serde_json::to_value(&reviewed.schedule).map_err(|_| unavailable())?
    {
        return Err("Schedule changed during review; inspect it and ask again".into());
    }
    let workspace = std::fs::canonicalize(&reviewed.workspace)
        .map_err(|_| "Reviewed workspace is unavailable")?;
    if !workspace.is_dir() || workspace != FsPath::new(&reviewed.workspace) {
        return Err("Reviewed workspace changed".into());
    }
    check_action(&store.schedules[index], reviewed.action, now_ms())?;
    let _activity = if reviewed.action == ScheduleChange::Run {
        Some(crate::workspace_activity::enter(&workspace)?)
    } else {
        None
    };
    let now = now_ms();
    let output = match reviewed.action {
        ScheduleChange::Pause => {
            let schedule = &mut store.schedules[index];
            schedule.enabled = false;
            schedule.next_run_at = None;
            serde_json::json!({"schedule":schedule})
        }
        ScheduleChange::Resume => {
            let schedule = &mut store.schedules[index];
            schedule.enabled = true;
            schedule.next_run_at = Some(
                schedule
                    .run_once_at
                    .unwrap_or_else(|| schedule.next_after(now)),
            );
            serde_json::json!({"schedule":schedule})
        }
        ScheduleChange::Run => {
            let id = reviewed.schedule.id;
            if store
                .tasks
                .iter()
                .any(|task| task.schedule_id == Some(id) && !task.status.terminal())
            {
                return Err("This schedule already has a pending task".into());
            }
            let task = enqueue(&mut store, reviewed.schedule.input.clone(), Some(id), now)
                .map_err(|e| e.message)?;
            let schedule = &mut store.schedules[index];
            schedule.last_run_at = Some(now);
            schedule.last_task_id = Some(task.id);
            if schedule.run_once_at.is_some() {
                schedule.enabled = false;
                schedule.next_run_at = None;
            } else {
                schedule.next_run_at = schedule.enabled.then(|| schedule.next_after(now));
            }
            serde_json::json!({"task":task,"schedule":schedule})
        }
        ScheduleChange::Remove => {
            store.schedules.remove(index);
            serde_json::json!({"removed":true,"id":reviewed.schedule.id})
        }
        ScheduleChange::Edit => {
            let proposed = reviewed
                .proposed
                .as_ref()
                .ok_or("Schedule edit is missing")?;
            if reviewed.timing_edited && proposed.run_once_at.is_some_and(|when| when <= now) {
                return Err("The reviewed one-shot time has passed; review it again".into());
            }
            if reviewed.timing_edited && proposed.next_run_at.is_some_and(|when| when <= now) {
                return Err("The reviewed first run has passed; review it again".into());
            }
            validate_task(&proposed.input).map_err(|error| error.message)?;
            store.schedules[index] = proposed.clone();
            serde_json::json!({"schedule":proposed})
        }
    };
    validate()?;
    if cancelled() || expires_at <= now_ms() as i64 {
        return Err("Schedule approval expired or was cancelled".into());
    }
    write_store(&root, &store)
        .map_err(|_| "Schedule outcome is uncertain; inspect it before retrying".to_string())?;
    Ok(output)
}

#[cfg(all(test, unix))]
mod edit_tests {
    use super::*;
    static EDIT_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn schedules_when_available(data: &FsPath) -> Vec<ScheduleRecord> {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match read_owner_schedules(data.into(), "owner".into()).await {
                    Ok(schedules) => break schedules,
                    Err(error) if error == "Schedule storage is unavailable or busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    Err(error) => panic!("Schedule read failed: {error}"),
                }
            }
        })
        .await
        .expect("schedule storage remained busy")
    }

    async fn fixture(data: &FsPath, workspace: &FsPath) -> ScheduleRecord {
        create_owner_schedule(
            data.into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Old prompt".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some("ss-parent".into()),
                    parent_task_id: None,
                },
                name: "Review".into(),
                interval_seconds: 60,
                enabled: true,
                at: None,
                run_once_at: None,
            },
        )
        .await
        .unwrap()
    }

    async fn edit(
        data: &FsPath,
        workspace: &FsPath,
        id: Uuid,
        changes: ScheduleEdit,
    ) -> Result<ReviewedScheduleChange, String> {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let result = prepare_reviewed_schedule_edit(
                    data.into(),
                    "owner".into(),
                    "ss-parent".into(),
                    "turn".into(),
                    workspace.to_string_lossy().into_owned(),
                    id,
                    changes.clone(),
                )
                .await;
                match result {
                    Err(error) if error == "Schedule storage is unavailable or busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    other => break other,
                }
            }
        })
        .await
        .expect("schedule storage remained busy")
    }

    async fn commit_when_available(
        reviewed: ReviewedScheduleChange,
    ) -> Result<serde_json::Value, String> {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match commit_reviewed_schedule_change(
                    reviewed.clone(),
                    now_ms() as i64 + 60_000,
                    || false,
                )
                .await
                {
                    Err(error) if error == "Schedule storage is unavailable or busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    other => break other,
                }
            }
        })
        .await
        .expect("schedule storage remained busy")
    }

    #[tokio::test]
    async fn rejected_cancelled_expired_and_stale_edits_do_not_replace_the_schedule() {
        let _test = EDIT_TESTS.lock().await;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let saved = fixture(data.path(), &workspace).await;
        assert!(prepare_reviewed_schedule_edit(
            data.path().into(),
            "owner".into(),
            "ss-other".into(),
            "turn".into(),
            workspace.to_string_lossy().into_owned(),
            saved.id,
            ScheduleEdit {
                prompt: Some("forged".into()),
                timing: None
            },
        )
        .await
        .is_err());
        assert!(prepare_reviewed_schedule_edit(
            data.path().into(),
            "other".into(),
            "ss-parent".into(),
            "turn".into(),
            workspace.to_string_lossy().into_owned(),
            saved.id,
            ScheduleEdit {
                prompt: Some("forged".into()),
                timing: None
            },
        )
        .await
        .is_err());
        let invalid = [
            ScheduleEdit {
                prompt: None,
                timing: None,
            },
            ScheduleEdit {
                prompt: Some(" ".into()),
                timing: None,
            },
            ScheduleEdit {
                prompt: None,
                timing: Some(ScheduleTiming::Interval {
                    interval_seconds: 59,
                }),
            },
            ScheduleEdit {
                prompt: None,
                timing: Some(ScheduleTiming::Once {
                    run_once_at: now_ms(),
                }),
            },
        ];
        for changes in invalid {
            assert!(edit(data.path(), &workspace, saved.id, changes)
                .await
                .is_err());
        }
        let changes = || ScheduleEdit {
            prompt: Some("New prompt".into()),
            timing: None,
        };
        let cancelled = edit(data.path(), &workspace, saved.id, changes())
            .await
            .unwrap();
        assert!(
            commit_reviewed_schedule_change(cancelled, now_ms() as i64 + 60_000, || true)
                .await
                .is_err()
        );
        let expired = edit(data.path(), &workspace, saved.id, changes())
            .await
            .unwrap();
        assert!(
            commit_reviewed_schedule_change(expired, now_ms() as i64 - 1, || false)
                .await
                .is_err()
        );
        let stale = edit(data.path(), &workspace, saved.id, changes())
            .await
            .unwrap();
        let pause = prepare_reviewed_schedule_change(
            data.path().into(),
            "owner".into(),
            "ss-parent".into(),
            "turn".into(),
            workspace.to_string_lossy().into_owned(),
            saved.id,
            ScheduleChange::Pause,
        )
        .await
        .unwrap();
        commit_reviewed_schedule_change(pause, now_ms() as i64 + 60_000, || false)
            .await
            .unwrap();
        assert!(
            commit_reviewed_schedule_change(stale, now_ms() as i64 + 60_000, || false)
                .await
                .is_err()
        );
        let final_schedule = schedules_when_available(data.path()).await;
        assert_eq!(final_schedule[0].input.prompt, "Old prompt");
        assert!(!final_schedule[0].enabled);
    }

    #[tokio::test]
    async fn one_shot_time_expiring_during_review_is_not_committed() {
        let _test = EDIT_TESTS.lock().await;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let saved = fixture(data.path(), &workspace).await;
        let when = now_ms() + 2_000;
        let reviewed = edit(
            data.path(),
            &workspace,
            saved.id,
            ScheduleEdit {
                prompt: None,
                timing: Some(ScheduleTiming::Once { run_once_at: when }),
            },
        )
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(
            when.saturating_sub(now_ms()) + 5,
        ))
        .await;
        assert_eq!(
            commit_when_available(reviewed).await.unwrap_err(),
            "The reviewed one-shot time has passed; review it again"
        );
        let after = schedules_when_available(data.path()).await;
        assert_eq!(
            serde_json::to_value(&after[0]).unwrap(),
            serde_json::to_value(saved).unwrap()
        );
    }

    #[tokio::test]
    async fn unchanged_one_shot_time_still_must_be_future_at_commit() {
        let _test = EDIT_TESTS.lock().await;
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().canonicalize().unwrap();
        let when = now_ms() + 2_000;
        let saved = create_owner_schedule(
            data.path().into(),
            "owner".into(),
            ScheduleInput {
                task: TaskInput {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    provider: "openai-api".into(),
                    prompt: "Old prompt".into(),
                    model: Some("fixture".into()),
                    parent_session_id: Some("ss-parent".into()),
                    parent_task_id: None,
                },
                name: "Review".into(),
                interval_seconds: 0,
                enabled: false,
                at: None,
                run_once_at: Some(when),
            },
        )
        .await
        .unwrap();
        let reviewed = edit(
            data.path(),
            &workspace,
            saved.id,
            ScheduleEdit {
                prompt: Some("New prompt".into()),
                timing: Some(ScheduleTiming::Once { run_once_at: when }),
            },
        )
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(
            when.saturating_sub(now_ms()) + 5,
        ))
        .await;
        assert_eq!(
            commit_when_available(reviewed).await.unwrap_err(),
            "The reviewed one-shot time has passed; review it again"
        );
        let after = schedules_when_available(data.path()).await;
        assert_eq!(
            serde_json::to_value(&after[0]).unwrap(),
            serde_json::to_value(saved).unwrap()
        );
    }

    #[test]
    fn timing_edits_use_existing_dst_policy_and_keep_other_fields() {
        let now = 1_772_949_600_000; // 2026-03-08 06:00 UTC, before the US spring transition
        let schedule = ScheduleRecord {
            id: Uuid::new_v4(),
            name: "Fixture".into(),
            input: TaskInput {
                workspace_path: "/tmp".into(),
                provider: "openai-api".into(),
                prompt: "Keep".into(),
                model: None,
                parent_session_id: None,
                parent_task_id: None,
            },
            interval_seconds: 60,
            at: None,
            run_once_at: None,
            enabled: true,
            next_run_at: Some(now + 60_000),
            last_run_at: None,
            last_task_id: None,
            created_at: now,
            missed_runs: 0,
            last_missed_at: None,
        };
        let at = CalendarTime {
            hour: 2,
            minute: 30,
            weekdays: vec![0, 1, 2, 3, 4, 5, 6],
            utc_offset_minutes: 0,
            time_zone: Some("America/New_York".into()),
        };
        let candidate = proposed_edit(
            &schedule,
            ScheduleEdit {
                prompt: None,
                timing: Some(ScheduleTiming::Calendar { at: at.clone() }),
            },
            now,
        )
        .unwrap();
        assert_eq!(candidate.next_run_at, Some(1_773_037_800_000)); // Monday 06:30 UTC; Sunday 02:30 does not exist
        assert_eq!(candidate.input.prompt, "Keep");
        assert_eq!(candidate.interval_seconds, 0);
        assert_eq!(candidate.at, Some(at));
        assert_eq!(candidate.id, schedule.id);
        let mut prior = schedule.clone();
        prior.last_task_id = Some(Uuid::new_v4());
        assert!(proposed_edit(
            &prior,
            ScheduleEdit {
                prompt: None,
                timing: Some(ScheduleTiming::Once {
                    run_once_at: now + 120_000
                })
            },
            now
        )
        .is_err());
    }
}
