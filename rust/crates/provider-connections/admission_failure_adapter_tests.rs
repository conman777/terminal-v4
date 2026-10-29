//! UNAPPLIED crate-root sibling-module test preview. Not a child of `leases`.
use crate::{fixtures::*, leases::*, *};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

const CREATE: &str = "60000000-0000-4000-8000-000000000009";

fn open(root: &std::path::Path) -> Coordinator {
    Coordinator::open(
        root,
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap()
}
fn private_root() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
fn configured(root: &std::path::Path) -> (Coordinator, EffectiveConnection) {
    let mut coordinator = open(root);
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.operation_id = CREATE.into();
    let mut save = ids();
    save.revision = REVISION.into();
    save.credential_id = CREDENTIAL.into();
    save.credential_generation = GENERATION.into();
    let saved = coordinator
        .configure(ConfigMutation::Put(request), save)
        .unwrap();
    assert!(saved.settings_saved && saved.cleanup_confirmed);
    let profile = coordinator.profile(PROFILE).unwrap().unwrap();
    let effective = runtime::resolve(&scope(), &profile, &reference_for(&profile), None).unwrap();
    (coordinator, effective)
}
fn replace(coordinator: &mut Coordinator) -> ConfigReceipt {
    let mut update = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    update.expected_revision = Some(REVISION.into());
    coordinator
        .configure(ConfigMutation::Put(update), ids())
        .unwrap()
}
struct ExitRelease(Option<mpsc::Sender<()>>);
impl ExitRelease {
    fn release(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}
impl Drop for ExitRelease {
    fn drop(&mut self) {
        self.release();
    }
}
struct StartWorker {
    failed_owned: bool,
    starts: Arc<AtomicUsize>,
    joined: Arc<AtomicBool>,
    ready: mpsc::Sender<()>,
    stop_seen: mpsc::Sender<()>,
    exit: mpsc::Receiver<()>,
}
struct RunningWorker {
    worker: Option<std::thread::JoinHandle<()>>,
    cancel: Option<mpsc::Sender<()>>,
    joined: Arc<AtomicBool>,
}
impl StartOwnedResource for StartWorker {
    fn start(self: Box<Self>) -> StartOutcome {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (cancel, cancelled) = mpsc::channel();
        let ready = self.ready;
        let seen = self.stop_seen;
        let exit = self.exit;
        let worker = std::thread::spawn(move || {
            let _ = ready.send(());
            let _ = cancelled.recv();
            let _ = seen.send(());
            let _ = exit.recv();
        });
        // Immediate ownership transfer. No blocked handshake under the OS fence.
        let owner = Box::new(RunningWorker {
            worker: Some(worker),
            cancel: Some(cancel),
            joined: self.joined,
        });
        if self.failed_owned {
            StartOutcome::FailedOwned {
                error: LeaseError::HandoffFailed,
                owner,
            }
        } else {
            StartOutcome::Started(owner)
        }
    }
}
impl OwnedRunningResource for RunningWorker {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| LeaseError::ResourceStopPending)?;
        }
        self.joined.store(true, Ordering::SeqCst);
        Ok(())
    }
}
impl Drop for RunningWorker {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        // Drop cannot mint joined evidence. Test owns a bounded-release exit gate.
    }
}

#[test]
fn sibling_adapter_extracts_original_failed_owned_and_sql_error_handles_then_joins_before_ack() {
    for failed_owned in [true, false] {
        let root = private_root();
        let (mut coordinator, effective) = configured(root.path());
        let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
        if !failed_owned {
            db.execute_batch(
                "CREATE TRIGGER sibling_test_abort_started_status BEFORE UPDATE OF started ON provider_connection_actors WHEN NEW.started=1 BEGIN SELECT RAISE(ABORT,'synthetic status failure'); END;",
            ).unwrap();
        }
        let starts = Arc::new(AtomicUsize::new(0));
        let joined = Arc::new(AtomicBool::new(false));
        let (ready, ready_rx) = mpsc::channel();
        let (seen, seen_rx) = mpsc::channel();
        let (exit, exit_rx) = mpsc::channel();
        let mut exit_release = ExitRelease(Some(exit));
        let failure = coordinator
            .admit(
                REQUEST,
                &effective,
                ConsumerKind::Discovery,
                Box::new(StartWorker {
                    failed_owned,
                    starts: starts.clone(),
                    joined: joined.clone(),
                    ready,
                    stop_seen: seen,
                    exit: exit_rx,
                }),
            )
            .err()
            .expect("both begun failures retain their original private owner");
        // Required crate-internal consuming adapter port. It does not exist in
        // the frozen implementation, so the first gate must fail to compile here.
        let (error, owned_handle) = failure.into_parts();
        assert_eq!(
            error,
            if failed_owned {
                LeaseError::HandoffFailed
            } else {
                LeaseError::PersistenceFailed
            }
        );
        let handle = owned_handle.expect("sibling adapter must receive original live handle");
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        if !failed_owned {
            db.execute_batch("DROP TRIGGER sibling_test_abort_started_status")
                .unwrap();
        }
        let view = coordinator.lease_view(&handle).unwrap();
        assert_eq!(view.reference, effective.reference);
        assert_eq!(view.status, LeaseStatus::HandoffUncertain);
        assert_eq!(
            coordinator.admission_status(REQUEST).unwrap().unwrap(),
            view
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert!(!joined.load(Ordering::SeqCst));
        let saved = replace(&mut coordinator);
        assert!(saved.settings_saved && !saved.cleanup_confirmed);
        let targets: String = db
            .query_row(
                "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
                [OPERATION],
                |r| r.get(0),
            )
            .unwrap();
        let (done, done_rx) = mpsc::channel();
        let observer = std::thread::spawn(move || {
            let proof = coordinator.observe_stop(&handle).unwrap();
            assert!(done.send((coordinator, handle, proof)).is_ok());
        });
        seen_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let premature = done_rx.try_recv();
        let mut inspector = open(root.path());
        assert!(
            !inspector
                .retry_cleanup(PROFILE, OPERATION)
                .unwrap()
                .cleanup_confirmed
        );
        assert!(!joined.load(Ordering::SeqCst));
        exit_release.release();
        let (mut coordinator, handle, proof) =
            done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        observer.join().unwrap();
        assert!(matches!(premature, Err(mpsc::TryRecvError::Empty)));
        assert!(joined.load(Ordering::SeqCst));
        let confirmed = if failed_owned {
            coordinator.acknowledge(&handle, OPERATION, &proof).unwrap()
        } else {
            coordinator.release_completed(&handle, &proof).unwrap();
            coordinator.retry_cleanup(PROFILE, OPERATION).unwrap()
        };
        assert!(confirmed.settings_saved && confirmed.cleanup_confirmed);
        assert_eq!(
            coordinator.lease_view(&handle).unwrap().status,
            LeaseStatus::Quiescent
        );
        assert_eq!(
            coordinator.observe_stop(&handle).err(),
            Some(LeaseError::StaleHandle)
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(
            db.query_row(
                "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
                [OPERATION],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            targets
        );
    }
}

#[test]
fn sibling_adapter_consumes_pre_admission_failure_without_a_handle_or_start() {
    let root = private_root();
    let (mut coordinator, mut effective) = configured(root.path());
    effective.reference.scope.owner_id = "another-synthetic-owner".into();
    let starts = Arc::new(AtomicUsize::new(0));
    let (ready, _ready_rx) = mpsc::channel();
    let (seen, _seen_rx) = mpsc::channel();
    let (_exit, exit_rx) = mpsc::channel();
    let failure = coordinator
        .admit(
            REQUEST,
            &effective,
            ConsumerKind::Discovery,
            Box::new(StartWorker {
                failed_owned: true,
                starts: starts.clone(),
                joined: Arc::new(AtomicBool::new(false)),
                ready,
                stop_seen: seen,
                exit: exit_rx,
            }),
        )
        .err()
        .unwrap();
    let (error, owned_handle) = failure.into_parts();
    assert_eq!(error, LeaseError::InvalidScope);
    assert!(owned_handle.is_none());
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert!(coordinator.admission_status(REQUEST).unwrap().is_none());
}
