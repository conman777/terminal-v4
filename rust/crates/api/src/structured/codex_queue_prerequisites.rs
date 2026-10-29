use super::*;
use crate::followup_queue::{Mutation, QueueOperation, QueueScope, QueueStore};
use std::sync::atomic::{AtomicUsize, Ordering};

struct FailingCodex {
    starts: Arc<AtomicUsize>,
}

#[cfg(unix)]
#[test]
fn ownership_cannot_bind_after_an_unfenced_operation_was_admitted() {
    let data = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let manager = manager(data.path(), Arc::new(AtomicUsize::new(0)));
    assert!(manager.external_admission().unwrap().is_none());
    assert!(manager.bind_live_ownership().is_err());
}

#[cfg(unix)]
#[test]
fn ownership_binding_and_first_admission_are_serialized() {
    for _ in 0..20 {
        let data = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = manager(data.path(), Arc::new(AtomicUsize::new(0)));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let result = std::thread::scope(|scope| {
            let other = manager.clone();
            let other_barrier = barrier.clone();
            let bind = scope.spawn(move || {
                other_barrier.wait();
                other.bind_live_ownership().is_ok()
            });
            barrier.wait();
            let admitted_with_fence = manager.external_admission().unwrap().is_some();
            (bind.join().unwrap(), admitted_with_fence)
        });
        assert!(matches!(result, (true, true) | (false, false)));
    }
}

impl StructuredProvider for FailingCodex {
    fn provider_id(&self) -> &'static str {
        "codex"
    }

    fn spawn(&self, _options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Err("synthetic provider start failure".into())
    }
}

fn manager(data: &Path, starts: Arc<AtomicUsize>) -> StructuredSessionManager {
    StructuredSessionManager::new_with_providers(
        AppConfig {
            data_dir: data.into(),
            ..Default::default()
        },
        vec![Arc::new(FailingCodex { starts })],
    )
}

#[tokio::test]
async fn codex_receipt_is_owner_scoped_and_deduplicates_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), starts.clone());
    let session = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let request = Uuid::new_v4().to_string();
    let initial = first
        .submit("owner", &session.id, "check the project", Some(&request))
        .await
        .unwrap();
    assert_eq!(initial.status, "failed");
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert!(!data.path().join("followup-queues").exists());

    let restored = manager(data.path(), starts.clone());
    let retry = restored
        .submit("owner", &session.id, "check the project", Some(&request))
        .await
        .unwrap();
    assert_eq!(retry, initial);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        restored
            .submit("owner", &session.id, "different input", Some(&request))
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        restored
            .request_receipt("other", &session.id, &request)
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
}

#[tokio::test]
async fn concurrent_codex_retries_have_one_durable_acceptance() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), starts.clone());
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let request = Uuid::new_v4().to_string();
    let (first, second) = tokio::join!(
        manager.submit("owner", &session.id, "same input", Some(&request)),
        manager.submit("owner", &session.id, "same input", Some(&request)),
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let state = manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        state
            .events
            .iter()
            .filter(|event| matches!(event,
        StructuredSessionEvent::UserMessageAccepted { request_id, .. } if request_id == &request))
            .count(),
        1
    );
}

#[tokio::test]
async fn two_managers_do_not_accept_the_same_codex_request_twice() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), starts.clone());
    let session = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let second = manager(data.path(), starts.clone());
    second
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap();
    let request = Uuid::new_v4().to_string();
    let original = first
        .submit("owner", &session.id, "same input", Some(&request))
        .await
        .unwrap();
    let retry = second
        .submit("owner", &session.id, "same input", Some(&request))
        .await
        .unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(retry, original);
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_managers_do_not_load_or_launch_the_same_owner_concurrently() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), starts.clone());
    let second = manager(data.path(), starts.clone());
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    let session = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        first.live_owner_status("owner").unwrap(),
        super::live_ownership::OwnerState::Owned
    );
    assert!(second
        .get_session("owner", &session.id)
        .await
        .unwrap_err()
        .contains("ownership"));
    let receipt = first
        .submit(
            "owner",
            &session.id,
            "same input",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    assert_eq!(receipt.status, "failed");
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert!(second.get_session("owner", &session.id).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_shutdown_waits_for_inflight_session_use_before_clean_release() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), starts.clone());
    let second = manager(data.path(), starts);
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let held = first
        .owned_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    let shutting_down = {
        let first = first.clone();
        tokio::spawn(async move { first.shutdown().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while first.external_admission().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(second.get_session("owner", &snapshot.id).await.is_err());
    assert!(!shutting_down.is_finished());
    drop(held);
    tokio::time::timeout(std::time::Duration::from_secs(2), shutting_down)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(first.get_session("owner", &snapshot.id).await.is_err());
    assert!(second
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .is_some());
    second.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_shutdown_retires_a_session_created_after_its_first_snapshot() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let first = manager(data.path(), starts.clone());
    let second = manager(data.path(), starts);
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    assert!(first.list_sessions("owner").await.unwrap().is_empty());
    let owners = first.inner.loaded_owners.lock().await;
    let creation = {
        let first = first.clone();
        let cwd = workspace.path().to_str().unwrap().to_owned();
        tokio::spawn(async move {
            first
                .create_session("owner", &cwd, Some("codex"), None, None)
                .await
        })
    };
    let gate = &first.inner.live_ownership.get().unwrap().admission;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while gate.inflight() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let shutdown = {
        let first = first.clone();
        tokio::spawn(async move { first.shutdown().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while first.external_admission().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(second.list_sessions("owner").await.is_err());
    drop(owners);
    let snapshot = creation.await.unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(second
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .is_some());
    second.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_shutdown_waits_for_native_event_pump_before_clean_release() {
    struct HoldingCodex(std::sync::Mutex<Option<mpsc::UnboundedSender<StructuredSessionEvent>>>);
    struct Controller;
    #[async_trait]
    impl StructuredProcessController for Controller {
        async fn send_input(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn send_approval(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), String> {
            Ok(())
        }
        async fn kill(&self) -> Result<(), String> {
            Ok(())
        }
    }
    impl StructuredProvider for HoldingCodex {
        fn provider_id(&self) -> &'static str {
            "codex"
        }
        fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
            let (sender, events) = mpsc::unbounded_channel();
            *self.0.lock().unwrap() = Some(sender);
            Ok(SpawnedStructuredProcess {
                controller: Arc::new(Controller),
                events,
            })
        }
    }
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let provider = Arc::new(HoldingCodex(std::sync::Mutex::new(None)));
    let first =
        StructuredSessionManager::new_with_providers(config.clone(), vec![provider.clone()]);
    let second = StructuredSessionManager::new_with_providers(config, vec![]);
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    first
        .submit(
            "owner",
            &snapshot.id,
            "investigate",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    let stopping = {
        let first = first.clone();
        tokio::spawn(async move { first.shutdown().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while first.external_admission().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(second.get_session("owner", &snapshot.id).await.is_err());
    assert!(!stopping.is_finished());
    provider.0.lock().unwrap().take();
    tokio::time::timeout(std::time::Duration::from_secs(2), stopping)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(second
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .is_some());
    second.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_shutdown_denies_pending_claude_permission_before_release() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let first = StructuredSessionManager::new(config.clone());
    let second = StructuredSessionManager::new(config);
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let pending = {
        let manager = first.clone();
        let id = snapshot.id.clone();
        tokio::spawn(async move {
            manager
                .request_claude_permission("owner", &id, "Read", serde_json::json!({}))
                .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if first
                .get_session("owner", &snapshot.id)
                .await
                .unwrap()
                .unwrap()
                .events
                .iter()
                .any(|event| matches!(event, StructuredSessionEvent::ApprovalRequired { .. }))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let shutdown = {
        let manager = first.clone();
        tokio::spawn(async move { manager.shutdown().await })
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!result);
    tokio::time::timeout(std::time::Duration::from_secs(2), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let restored = second
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    assert!(restored.events.iter().any(|event| matches!(
        event,
        StructuredSessionEvent::ApprovalResolved {
            approved: false,
            ..
        }
    )));
    second.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guarded_shutdown_denies_cached_permission_if_shutdown_begins_before_decision() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let first = StructuredSessionManager::new(config.clone());
    let second = StructuredSessionManager::new(config);
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let mut allows = first.inner.claude_session_allows.lock().unwrap();
    allows
        .entry(snapshot.id.clone())
        .or_default()
        .insert("Read".into());
    let pending = {
        let manager = first.clone();
        let id = snapshot.id.clone();
        tokio::spawn(async move {
            manager
                .request_claude_permission("owner", &id, "Read", serde_json::json!({}))
                .await
        })
    };
    let gate = &first.inner.live_ownership.get().unwrap().admission;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while gate.inflight() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let shutdown = {
        let manager = first.clone();
        tokio::spawn(async move { manager.shutdown().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while gate.is_open() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(second.get_session("owner", &snapshot.id).await.is_err());
    drop(allows);
    assert!(
        !tokio::time::timeout(std::time::Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(second
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .is_some());
    second.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_actor_rejects_writes_when_ownership_file_is_removed() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let first = manager(data.path(), Arc::new(AtomicUsize::new(0)));
    first.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let path = structured_session_path(&first.inner.config, "owner", &snapshot.id);
    let original = fs::read(&path).unwrap();
    let lock = fs::read_dir(data.path().join("structured-owner-live"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::remove_file(lock).unwrap();
    assert!(first
        .rename_session("owner", &snapshot.id, "not committed")
        .await
        .is_err());
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(first.shutdown().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_shutdown_keeps_lease_when_process_cleanup_fails() {
    struct FaultyCodex {
        fail: Arc<std::sync::atomic::AtomicBool>,
        sender: std::sync::Mutex<Option<mpsc::UnboundedSender<StructuredSessionEvent>>>,
    }
    struct Controller(Arc<std::sync::atomic::AtomicBool>);
    #[async_trait]
    impl StructuredProcessController for Controller {
        async fn send_input(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn send_approval(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), String> {
            self.kill().await
        }
        async fn kill(&self) -> Result<(), String> {
            if self.0.load(Ordering::SeqCst) {
                Err("synthetic cleanup failure".into())
            } else {
                Ok(())
            }
        }
    }
    impl StructuredProvider for FaultyCodex {
        fn provider_id(&self) -> &'static str {
            "codex"
        }
        fn spawn(&self, _: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
            let (sender, events) = mpsc::unbounded_channel();
            *self.sender.lock().unwrap() = Some(sender);
            Ok(SpawnedStructuredProcess {
                controller: Arc::new(Controller(self.fail.clone())),
                events,
            })
        }
    }
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let provider = Arc::new(FaultyCodex {
        fail: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        sender: std::sync::Mutex::new(None),
    });
    let first =
        StructuredSessionManager::new_with_providers(config.clone(), vec![provider.clone()]);
    let second = StructuredSessionManager::new_with_providers(config, vec![]);
    first.bind_live_ownership().unwrap();
    second.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    first
        .submit(
            "owner",
            &snapshot.id,
            "investigate",
            Some(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
    assert!(first
        .shutdown()
        .await
        .unwrap_err()
        .contains("synthetic cleanup failure"));
    assert!(second.get_session("owner", &snapshot.id).await.is_err());
    provider.fail.store(false, Ordering::SeqCst);
    provider.sender.lock().unwrap().take();
    first.shutdown().await.unwrap();
    assert!(second
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .is_some());
    second.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_manager_loads_existing_legacy_incarnation_without_prior_registry() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let legacy = manager(data.path(), starts.clone());
    let initial = legacy
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let path = structured_session_path(&legacy.inner.config, "owner", &initial.id);
    let mut stored = storage::decode(&fs::read(&path).unwrap()).unwrap();
    stored.session_incarnation = None;
    fs::write(
        &path,
        storage::encode_checkpoint("owner", &stored.snapshot, None).unwrap(),
    )
    .unwrap();
    drop(legacy);
    assert!(!data.path().join("structured-owner-live").exists());
    let guarded = manager(data.path(), starts);
    guarded.bind_live_ownership().unwrap();
    let restored = guarded
        .get_session("owner", &initial.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((restored.id, restored.title), (initial.id, initial.title));
    assert!(storage::decode(&fs::read(path).unwrap())
        .unwrap()
        .session_incarnation
        .is_none());
    guarded.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_manager_rejects_unsafe_data_directory_before_loading() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    fs::set_permissions(data.path(), fs::Permissions::from_mode(0o777)).unwrap();
    let guarded = manager(data.path(), Arc::new(AtomicUsize::new(0)));
    let result = guarded.bind_live_ownership();
    fs::set_permissions(data.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert!(!data.path().join("structured-owner-live").exists());
}

#[cfg(unix)]
#[test]
#[ignore = "invoked by the cross-process ownership regression"]
fn guarded_manager_process_fixture() {
    let Ok(directory) = std::env::var("V4_GUARDED_MANAGER_DATA") else {
        return;
    };
    let id = std::env::var("V4_GUARDED_MANAGER_SESSION").unwrap();
    let expected = std::env::var("V4_GUARDED_MANAGER_EXPECTED").unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let manager = manager(Path::new(&directory), Arc::new(AtomicUsize::new(0)));
        manager.bind_live_ownership().unwrap();
        let result = manager.get_session("owner", &id).await;
        match expected.as_str() {
            "blocked" => assert!(result.unwrap_err().contains("ownership")),
            "available" => {
                assert!(result.unwrap().is_some());
                manager.shutdown().await.unwrap();
            }
            "crash" => {
                assert!(result.unwrap().is_some());
                std::process::exit(37);
            }
            _ => panic!("invalid fixture expectation"),
        }
    });
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_managers_exclude_across_processes_until_clean_shutdown() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let first = manager(data.path(), Arc::new(AtomicUsize::new(0)));
    first.bind_live_ownership().unwrap();
    let snapshot = first
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let run = |expected: &str| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structured::codex_queue_prerequisites::guarded_manager_process_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("V4_GUARDED_MANAGER_DATA", data.path())
            .env("V4_GUARDED_MANAGER_SESSION", &snapshot.id)
            .env("V4_GUARDED_MANAGER_EXPECTED", expected)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run("blocked");
    first.shutdown().await.unwrap();
    run("available");
}

#[cfg(unix)]
#[tokio::test]
async fn guarded_manager_crash_requires_explicit_epoch_review_before_restore() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let legacy = manager(data.path(), starts.clone());
    let snapshot = legacy
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    drop(legacy);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "structured::codex_queue_prerequisites::guarded_manager_process_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("V4_GUARDED_MANAGER_DATA", data.path())
        .env("V4_GUARDED_MANAGER_SESSION", &snapshot.id)
        .env("V4_GUARDED_MANAGER_EXPECTED", "crash")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(37));
    let restarted = manager(data.path(), starts.clone());
    restarted.bind_live_ownership().unwrap();
    assert!(restarted
        .get_session("owner", &snapshot.id)
        .await
        .unwrap_err()
        .contains("unconfirmed"));
    let super::live_ownership::OwnerState::Unconfirmed { epoch } =
        restarted.live_owner_status("owner").unwrap()
    else {
        panic!("crash must be unconfirmed")
    };
    let reviews = super::live_ownership::ManagerLeases::new(data.path()).unwrap();
    assert!(reviews
        .reconcile_unknown("owner", epoch, Uuid::new_v4(), false)
        .is_err());
    reviews
        .reconcile_unknown("owner", epoch, Uuid::new_v4(), true)
        .unwrap();
    assert!(restarted
        .get_session("owner", &snapshot.id)
        .await
        .unwrap()
        .is_some());
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    restarted.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "Native Codex queue admission is not integrated yet"]
async fn existing_running_queue_fences_direct_codex_admission() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let starts = Arc::new(AtomicUsize::new(0));
    let manager = manager(data.path(), starts.clone());
    let session = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap();
    let scope = QueueScope::new("owner", workspace.path(), &session.id).unwrap();
    let store = QueueStore::new(data.path(), queue::boot_id());
    let revision = store.load(&scope).unwrap().revision;
    store
        .mutate(
            &scope,
            Mutation {
                operation_id: Uuid::new_v4(),
                expected_queue_revision: revision,
                operation: QueueOperation::Enqueue {
                    item_id: Uuid::new_v4(),
                    text: "queued first".into(),
                    run_when_idle: true,
                },
            },
        )
        .unwrap();

    let result = manager
        .submit(
            "owner",
            &session.id,
            "direct input",
            Some(&Uuid::new_v4().to_string()),
        )
        .await;
    assert_eq!(result.unwrap_err().code, "conflict");
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert!(manager
        .get_session("owner", &session.id)
        .await
        .unwrap()
        .unwrap()
        .events
        .is_empty());
}
